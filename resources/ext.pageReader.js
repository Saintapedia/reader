/* PageReader: config-driven read-aloud button. Every entry point is
 * wrapped in try/catch — a failure here must never affect other page JS.
 * This is the entire reason this extension exists (see spec §1: the
 * 2026-09-08/09 outage where a broken shared Common.js module took down
 * unrelated site features).
 */
( function () {
	'use strict';

	function getSkipSelectors() {
		var configured = mw.config.get( 'wgPageReaderSkipSelectors' );
		return Array.isArray( configured ) ? configured : [];
	}

	function removeAll( clone, selector ) {
		var matches = clone.querySelectorAll( selector );
		for ( var i = 0; i < matches.length; i++ ) {
			if ( matches[ i ].parentNode ) {
				matches[ i ].parentNode.removeChild( matches[ i ] );
			}
		}
	}

	function buildSpeechText( contentRoot ) {
		var clone = contentRoot.cloneNode( true );
		// The button and its controls can end up inside contentRoot (the
		// 'top-of-content' placement inserts them as content's first children)
		// -- always strip them so their own labels/options are never read
		// aloud, regardless of $wgPageReaderSkipSelectors.
		removeAll( clone, '.pagereader-button' );
		removeAll( clone, '.pagereader-voice-select' );
		removeAll( clone, '.pagereader-visually-hidden' );
		removeAll( clone, '.pagereader-pause-button' );
		getSkipSelectors().forEach( function ( selector ) {
			try {
				removeAll( clone, selector );
			} catch ( e ) {
				// One invalid entry in the on-wiki-editable skip-selector list
				// (a sysop typo) must not abort speech entirely — skip just
				// that selector and keep applying the rest.
				if ( window.console && console.warn ) {
					console.warn( 'PageReader: skipping invalid skip selector', selector, e );
				}
			}
		} );
		return clone.textContent;
	}

	function clampNumber( value, min, max, fallback ) {
		var num = parseFloat( value );
		if ( isNaN( num ) ) {
			return fallback;
		}
		return Math.min( max, Math.max( min, num ) );
	}

	// The Web Speech API exposes no gender field on a voice, only a name
	// string (e.g. "Google UK English Female", "Microsoft David"). This is a
	// best-effort substring match, not a real gender lookup -- coverage
	// depends entirely on how the browser/OS happens to label its voices,
	// and a device with no matching voice just falls back to the default
	// voice (returns null), never an error.
	var cachedVoices = [];

	// Chrome (among other browsers) populates its voice list asynchronously
	// -- the very first getVoices() call right after page load frequently
	// returns []. Calling it eagerly here, and again on 'voiceschanged',
	// means the cache is usually already warm by the time a reader actually
	// clicks the button, without blocking or delaying anything.
	function refreshCachedVoices() {
		try {
			if ( window.speechSynthesis && typeof window.speechSynthesis.getVoices === 'function' ) {
				var voices = window.speechSynthesis.getVoices();
				if ( voices && voices.length ) {
					cachedVoices = voices;
				}
			}
		} catch ( e ) {
			// Ignored -- pickVoice() falls back to the browser default voice.
		}
	}

	refreshCachedVoices();
	try {
		if ( window.speechSynthesis && 'onvoiceschanged' in window.speechSynthesis ) {
			window.speechSynthesis.onvoiceschanged = refreshCachedVoices;
		}
	} catch ( e ) {
		// Ignored -- rare/nonstandard implementation; pickVoice() still
		// falls back correctly without this.
	}

	// Checked in order -- the first name fragment (from
	// $wgPageReaderPreferredVoices, sysop-curated) to match ANY available
	// voice wins, even if a later voice in the list would also match an
	// earlier fragment. Lets a sysop rank curated names by preference.
	function findPreferredVoice( voices, names ) {
		if ( !Array.isArray( names ) ) {
			return null;
		}
		for ( var n = 0; n < names.length; n++ ) {
			var fragment = ( names[ n ] || '' ).toLowerCase();
			if ( !fragment ) {
				continue;
			}
			for ( var i = 0; i < voices.length; i++ ) {
				var name = ( voices[ i ].name || '' ).toLowerCase();
				if ( name.indexOf( fragment ) !== -1 ) {
					return voices[ i ];
				}
			}
		}
		return null;
	}

	function pickVoice( gender ) {
		if ( gender !== 'female' && gender !== 'male' ) {
			return null;
		}
		refreshCachedVoices();
		var voices = cachedVoices;

		// Curated names (e.g. macOS "Samantha", Windows "Zira") take
		// priority over the generic name-contains-female/male match below,
		// since many good voices don't self-label gender in their name.
		var preferredConfig = mw.config.get( 'wgPageReaderPreferredVoices' );
		var preferredMatch = findPreferredVoice( voices, preferredConfig && preferredConfig[ gender ] );
		if ( preferredMatch ) {
			return preferredMatch;
		}

		for ( var i = 0; i < voices.length; i++ ) {
			var name = ( voices[ i ].name || '' ).toLowerCase();
			if ( gender === 'female' && name.indexOf( 'female' ) !== -1 ) {
				return voices[ i ];
			}
			if ( gender === 'male' && name.indexOf( 'male' ) !== -1 && name.indexOf( 'female' ) === -1 ) {
				return voices[ i ];
			}
		}
		return null;
	}

	// Order here drives both the select's option order and validation, but
	// not which one applies by default -- that's wgPageReaderVoiceGender
	// (extension.json default: 'female').
	var VOICE_GENDER_VALUES = [ 'female', 'male', 'auto' ];
	var VOICE_STORAGE_KEY = 'pagereader-voice-gender';

	function isValidGender( value ) {
		return VOICE_GENDER_VALUES.indexOf( value ) !== -1;
	}

	// localStorage can throw (private browsing, blocked storage) -- a reader's
	// preference just won't persist across visits in that case, same as every
	// other failure mode in this file: degrade, never break the page.
	function readStoredGender() {
		try {
			var stored = window.localStorage.getItem( VOICE_STORAGE_KEY );
			return isValidGender( stored ) ? stored : null;
		} catch ( e ) {
			return null;
		}
	}

	function writeStoredGender( value ) {
		try {
			window.localStorage.setItem( VOICE_STORAGE_KEY, value );
		} catch ( e ) {
			// Ignored -- see readStoredGender().
		}
	}

	function pauseSupported() {
		return !!( window.speechSynthesis &&
			typeof window.speechSynthesis.pause === 'function' &&
			typeof window.speechSynthesis.resume === 'function' );
	}

	// Hidden until speech actually starts (see bindButton) -- pausing only
	// makes sense while something is being read. Omitted entirely on a
	// browser without pause/resume support rather than shown and broken.
	function createPauseButton() {
		if ( !pauseSupported() ) {
			return null;
		}
		var pauseButton = document.createElement( 'button' );
		pauseButton.className = 'pagereader-pause-button';
		pauseButton.setAttribute( 'type', 'button' );
		pauseButton.setAttribute( 'aria-pressed', 'false' );
		pauseButton.hidden = true;
		pauseButton.textContent = mw.msg( 'pagereader-pause-label' );
		return pauseButton;
	}

	// Inserted as the button's next siblings (select, label, then the
	// optional pause button) so a later click handler can find each one via
	// a bounded walk from the button, without needing to track a separate
	// reference. Order relative to the button doesn't affect the
	// label/select association, which is done by id, not DOM position.
	function createControls() {
		var fragment = document.createDocumentFragment();

		var select = document.createElement( 'select' );
		select.className = 'pagereader-voice-select';
		var selectId = 'pagereader-voice-select-' + Math.random().toString( 36 ).slice( 2 );
		select.id = selectId;

		VOICE_GENDER_VALUES.forEach( function ( value ) {
			var option = document.createElement( 'option' );
			option.value = value;
			option.textContent = mw.msg( 'pagereader-voice-' + value );
			select.appendChild( option );
		} );

		var configuredDefault = mw.config.get( 'wgPageReaderVoiceGender' );
		select.value = readStoredGender() ||
			( isValidGender( configuredDefault ) ? configuredDefault : 'auto' );

		select.addEventListener( 'change', function () {
			writeStoredGender( select.value );
		} );

		var label = document.createElement( 'label' );
		label.className = 'pagereader-visually-hidden';
		label.setAttribute( 'for', selectId );
		label.textContent = mw.msg( 'pagereader-voice-label' );

		fragment.appendChild( select );
		fragment.appendChild( label );

		var pauseButton = createPauseButton();
		if ( pauseButton ) {
			fragment.appendChild( pauseButton );
		}

		return fragment;
	}

	// Unbounded rather than capped at a fixed hop count: a fixed cap that
	// happens to match today's exact sibling chain (select, label, pause
	// button) would silently break the moment one more sibling -- ours or
	// some other gadget's -- ends up between the button and its target.
	function findFollowingSibling( start, className ) {
		var candidate = start.nextElementSibling;
		while ( candidate ) {
			if ( candidate.classList && candidate.classList.contains( className ) ) {
				return candidate;
			}
			candidate = candidate.nextElementSibling;
		}
		return null;
	}

	function findVoiceSelect( button ) {
		return findFollowingSibling( button, 'pagereader-voice-select' );
	}

	function findPauseButton( button ) {
		return findFollowingSibling( button, 'pagereader-pause-button' );
	}

	function bindButton( button, contentRoot ) {
		if ( !button || button.getAttribute( 'data-pagereader-bound' ) === '1' ) {
			return;
		}
		button.setAttribute( 'data-pagereader-bound', '1' );
		button.setAttribute( 'type', 'button' );

		var labelIdle = mw.msg( 'pagereader-button-label' );
		var labelStop = mw.msg( 'pagereader-button-label-stop' );
		var labelPause = mw.msg( 'pagereader-pause-label' );
		var labelResume = mw.msg( 'pagereader-pause-label-resume' );
		button.textContent = labelIdle;

		var pauseButton = findPauseButton( button );
		var speaking = false;
		var paused = false;

		function stopSpeaking() {
			speaking = false;
			paused = false;
			button.textContent = labelIdle;
			button.classList.remove( 'pagereader-speaking' );
			button.setAttribute( 'aria-pressed', 'false' );
			if ( pauseButton ) {
				pauseButton.hidden = true;
				pauseButton.textContent = labelPause;
				pauseButton.setAttribute( 'aria-pressed', 'false' );
			}
		}

		button.addEventListener( 'click', function () {
			try {
				if ( speaking ) {
					window.speechSynthesis.cancel();
					stopSpeaking();
					return;
				}
				// buildSpeechText() runs $wgPageReaderSkipSelectors (editable via the
				// on-wiki config overlay) through querySelectorAll(); an invalid
				// selector throws synchronously here, so this must stay guarded.
				var utterance = new window.SpeechSynthesisUtterance( buildSpeechText( contentRoot ) );
				utterance.pitch = clampNumber( mw.config.get( 'wgPageReaderVoicePitch' ), 0, 2, 1 );
				utterance.rate = clampNumber( mw.config.get( 'wgPageReaderVoiceRate' ), 0.1, 10, 1 );
				var voiceSelect = findVoiceSelect( button );
				var genderPreference = voiceSelect ? voiceSelect.value : mw.config.get( 'wgPageReaderVoiceGender' );
				var voice = pickVoice( genderPreference );
				if ( voice ) {
					utterance.voice = voice;
				}
				utterance.onend = stopSpeaking;
				utterance.onerror = stopSpeaking;
				window.speechSynthesis.cancel();
				window.speechSynthesis.speak( utterance );
				speaking = true;
				button.textContent = labelStop;
				button.classList.add( 'pagereader-speaking' );
				button.setAttribute( 'aria-pressed', 'true' );
				if ( pauseButton ) {
					pauseButton.hidden = false;
				}
			} catch ( e ) {
				if ( window.console && console.warn ) {
					console.warn( 'PageReader failed', e );
				}
				stopSpeaking();
			}
		} );

		if ( pauseButton ) {
			pauseButton.addEventListener( 'click', function () {
				try {
					if ( !speaking ) {
						return;
					}
					if ( paused ) {
						window.speechSynthesis.resume();
						paused = false;
						pauseButton.textContent = labelPause;
						pauseButton.setAttribute( 'aria-pressed', 'false' );
					} else {
						window.speechSynthesis.pause();
						paused = true;
						pauseButton.textContent = labelResume;
						pauseButton.setAttribute( 'aria-pressed', 'true' );
					}
				} catch ( e ) {
					if ( window.console && console.warn ) {
						console.warn( 'PageReader failed', e );
					}
				}
			} );
		}
	}

	function findContentRoot( root ) {
		var contentClass = mw.config.get( 'wgPageReaderContentClass' );
		if ( contentClass ) {
			if ( root.classList && root.classList.contains( contentClass ) ) {
				return root;
			}
			if ( root.querySelector ) {
				// CSS.escape guards against a contentClass value (settable via the
				// on-wiki config overlay) containing characters that would change
				// selector semantics or throw when naively concatenated.
				var escaped = ( window.CSS && CSS.escape ) ? CSS.escape( contentClass ) : contentClass;
				var marked = root.querySelector( '.' + escaped );
				if ( marked ) {
					return marked;
				}
			}
		}

		var fallbackSelector = mw.config.get( 'wgPageReaderContentSelector' );
		if ( fallbackSelector && root.querySelector ) {
			return root.querySelector( fallbackSelector );
		}

		return null;
	}

	// content.previousElementSibling (used below for 'before-content' and the
	// 'after-heading' no-heading fallback) is no longer the button itself --
	// insertButton() also places the voice select/label/pause button between
	// the button and content, so the button now sits a few siblings further
	// back. Unbounded rather than capped at a fixed hop count: a cap that
	// happens to match today's exact sibling chain would silently break the
	// moment one more sibling -- ours or some other gadget's -- ends up
	// between the button and content.
	function findPrecedingButton( node ) {
		var candidate = node.previousElementSibling;
		while ( candidate ) {
			if ( candidate.classList && candidate.classList.contains( 'pagereader-button' ) ) {
				return candidate;
			}
			candidate = candidate.previousElementSibling;
		}
		return null;
	}

	// The duplicate-button guard in initPageReader() needs to look in the same
	// place insertButton() puts the button, for each placement mode — otherwise
	// a repeat wikipage.content firing (e.g. an AJAX content refresh) won't find
	// the existing button and will insert another one.
	function findExistingButton( content, placement ) {
		if ( placement === 'after-heading' ) {
			var heading = document.getElementById( 'firstHeading' );
			// Must mirror insertButton()'s own fallback exactly: when there is
			// no #firstHeading (or it has no parentNode), insertButton() falls
			// through to the 'before-content' behavior below, so the existing
			// button (if any) precedes content, not the heading.
			if ( heading && heading.parentNode ) {
				var afterHeading = heading.nextElementSibling;
				return ( afterHeading && afterHeading.classList &&
					afterHeading.classList.contains( 'pagereader-button' ) ) ? afterHeading : null;
			}
			return findPrecedingButton( content );
		} else if ( placement === 'top-of-content' ) {
			var firstChild = content.firstElementChild;
			return ( firstChild && firstChild.classList &&
				firstChild.classList.contains( 'pagereader-button' ) ) ? firstChild : null;
		}
		return findPrecedingButton( content );
	}

	function insertButton( content, placement ) {
		var button = document.createElement( 'button' );
		button.className = 'pagereader-button';
		button.setAttribute( 'aria-pressed', 'false' );

		if ( placement === 'after-heading' ) {
			var heading = document.getElementById( 'firstHeading' );
			if ( heading && heading.parentNode ) {
				heading.parentNode.insertBefore( button, heading.nextSibling );
			} else {
				// Fallback: mirrors the 'before-content' default below, for
				// when there is no #firstHeading to insert after.
				content.parentNode.insertBefore( button, content );
			}
		} else if ( placement === 'top-of-content' ) {
			content.insertBefore( button, content.firstChild );
		} else {
			// Default: 'before-content'.
			content.parentNode.insertBefore( button, content );
		}

		// Created here, not in bindButton(), so it's naturally created exactly
		// once per real button insertion -- a re-fired wikipage.content that
		// finds and reuses an existing button (see findExistingButton()) never
		// reaches this function again, so no separate duplicate-select guard
		// is needed.
		button.parentNode.insertBefore( createControls(), button.nextSibling );

		return button;
	}

	function initPageReader( $content ) {
		try {
			var root = document;
			if ( $content ) {
				if ( $content.nodeType === 1 ) {
					root = $content;
				} else if ( $content[ 0 ] && $content[ 0 ].nodeType === 1 ) {
					root = $content[ 0 ];
				}
			}

			var content = findContentRoot( root );
			if ( !content || !content.parentNode ) {
				return;
			}

			if ( !( 'speechSynthesis' in window ) ) {
				return;
			}

			var placement = mw.config.get( 'wgPageReaderButtonPlacement' ) || 'before-content';
			var button = findExistingButton( content, placement ) || insertButton( content, placement );

			bindButton( button, content );
		} catch ( e ) {
			if ( window.console && console.warn ) {
				console.warn( 'PageReader failed', e );
			}
		}
	}

	try {
		if ( typeof mw !== 'undefined' && mw.hook ) {
			mw.hook( 'wikipage.content' ).add( initPageReader );
		} else if ( document.readyState === 'loading' ) {
			document.addEventListener( 'DOMContentLoaded', function () {
				initPageReader();
			} );
		} else {
			initPageReader();
		}
	} catch ( e ) {
		if ( window.console && console.warn ) {
			console.warn( 'PageReader failed', e );
		}
	}
}() );
