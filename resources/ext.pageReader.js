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

	// Validated once per buildSpeechModel() call (not once per text node --
	// see makeSkipPredicate()) so an invalid on-wiki-editable skip selector
	// (a sysop typo) logs once and is dropped, rather than spamming a
	// warning on every ancestor check.
	function validSkipSelectors() {
		var probe = document.createElement( 'div' );
		return getSkipSelectors().filter( function ( selector ) {
			try {
				probe.matches( selector );
				return true;
			} catch ( e ) {
				if ( window.console && console.warn ) {
					console.warn( 'PageReader: skipping invalid skip selector', selector, e );
				}
				return false;
			}
		} );
	}

	// Shared by buildSpeechModel() (deciding what text to speak) and
	// highlightChunk() (deciding what's eligible to highlight) so the two
	// can never drift out of alignment -- they must skip exactly the same
	// nodes in exactly the same order for onboundary's charIndex offsets
	// (computed against the spoken text) to still point at the right word
	// in the live DOM.
	function makeSkipPredicate( contentRoot ) {
		var skipSelectors = validSkipSelectors();
		var ownControlClasses = [
			'pagereader-button',
			'pagereader-voice-select',
			'pagereader-visually-hidden',
			'pagereader-pause-button'
		];
		return function ( textNode ) {
			var el = textNode.parentElement;
			while ( el ) {
				if ( el.classList ) {
					for ( var c = 0; c < ownControlClasses.length; c++ ) {
						if ( el.classList.contains( ownControlClasses[ c ] ) ) {
							return true;
						}
					}
				}
				for ( var i = 0; i < skipSelectors.length; i++ ) {
					try {
						if ( el.matches( skipSelectors[ i ] ) ) {
							return true;
						}
					} catch ( e ) {
						// Already logged in validSkipSelectors(); ignore repeats.
					}
				}
				if ( el === contentRoot ) {
					break;
				}
				el = el.parentElement;
			}
			return false;
		};
	}

	// Walks contentRoot's live text nodes in document order (not a clone) --
	// that's what makes highlighting possible later, since findTextNodeAt()
	// needs the same live nodes speech offsets point back into.
	function buildSpeechModel( contentRoot ) {
		var skipPredicate = makeSkipPredicate( contentRoot );
		var walker = document.createTreeWalker( contentRoot, NodeFilter.SHOW_TEXT, null );
		var text = '';
		var node;
		while ( ( node = walker.nextNode() ) ) {
			if ( !skipPredicate( node ) ) {
				text += node.nodeValue;
			}
		}
		return { text: text, skipPredicate: skipPredicate };
	}

	// Removes a previous highlight (if any) and merges its text back into
	// the surrounding node via normalize() -- always fully restoring the
	// DOM before the next highlightChunk() call, rather than keeping a
	// reference to a node that surroundContents() may have split, which
	// would otherwise go stale after exactly one highlight/clear cycle.
	function clearHighlight( mark ) {
		if ( !mark || !mark.parentNode ) {
			return null;
		}
		var text = document.createTextNode( mark.textContent );
		mark.parentNode.replaceChild( text, mark );
		if ( text.parentNode ) {
			text.parentNode.normalize();
		}
		return null;
	}

	function findTextNodeAt( contentRoot, skipPredicate, targetOffset ) {
		var walker = document.createTreeWalker( contentRoot, NodeFilter.SHOW_TEXT, null );
		var offset = 0;
		var node;
		while ( ( node = walker.nextNode() ) ) {
			if ( skipPredicate( node ) ) {
				continue;
			}
			var len = node.nodeValue.length;
			if ( targetOffset < offset + len ) {
				return { node: node, localOffset: targetOffset - offset };
			}
			offset += len;
		}
		return null;
	}

	// onboundary's charLength isn't provided by every browser (notably
	// Firefox, which also tends to report only sentence-level boundaries,
	// not word-level) -- when missing, estimate a reasonable chunk: to the
	// next whitespace for a word boundary, or to the next sentence-ending
	// punctuation (inclusive) for a sentence boundary. Both capped to bound
	// a worst-case scan on unusual input.
	function estimateChunkLength( text, startIndex, boundaryName ) {
		var isSentence = boundaryName === 'sentence';
		var maxLen = isSentence ? 300 : 40;
		var stopPattern = isSentence ? /[.!?]/ : /\s/;
		var i = startIndex;
		while ( i < text.length && i < startIndex + maxLen && !stopPattern.test( text.charAt( i ) ) ) {
			i++;
		}
		if ( isSentence && i < text.length && stopPattern.test( text.charAt( i ) ) ) {
			i++;
		}
		return Math.max( 1, i - startIndex );
	}

	// Highlights are always rebuilt from scratch against the live DOM (see
	// clearHighlight()) rather than reusing node references across calls --
	// a word occasionally spanning multiple text nodes (e.g. markup like
	// "can<b>not</b>") is simplified to highlighting only the portion
	// within the first matching node, a reasonable degrade for a rare case.
	function highlightChunk( contentRoot, skipPredicate, startOffset, length ) {
		var located = findTextNodeAt( contentRoot, skipPredicate, startOffset );
		if ( !located ) {
			return null;
		}
		var node = located.node;
		var localStart = located.localOffset;
		var localEnd = Math.min( node.nodeValue.length, localStart + Math.max( 1, length ) );
		if ( localEnd <= localStart ) {
			return null;
		}

		var range = document.createRange();
		range.setStart( node, localStart );
		range.setEnd( node, localEnd );

		var mark = document.createElement( 'mark' );
		mark.className = 'pagereader-highlight';
		range.surroundContents( mark );
		return mark;
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
	function pickVoice( gender ) {
		if ( gender !== 'female' && gender !== 'male' ) {
			return null;
		}
		if ( !window.speechSynthesis || typeof window.speechSynthesis.getVoices !== 'function' ) {
			return null;
		}
		var voices = window.speechSynthesis.getVoices() || [];
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

	var VOICE_GENDER_VALUES = [ 'auto', 'female', 'male' ];
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

	function findFollowingSibling( start, className, maxHops ) {
		var candidate = start.nextElementSibling;
		var hops = 0;
		while ( candidate && hops < maxHops ) {
			if ( candidate.classList && candidate.classList.contains( className ) ) {
				return candidate;
			}
			candidate = candidate.nextElementSibling;
			hops++;
		}
		return null;
	}

	function findVoiceSelect( button ) {
		return findFollowingSibling( button, 'pagereader-voice-select', 3 );
	}

	function findPauseButton( button ) {
		return findFollowingSibling( button, 'pagereader-pause-button', 3 );
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
		var currentHighlight = null;
		var speechModel = null;

		function stopSpeaking() {
			speaking = false;
			paused = false;
			currentHighlight = clearHighlight( currentHighlight );
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
				// buildSpeechModel() runs $wgPageReaderSkipSelectors (editable via
				// the on-wiki config overlay) through Element.matches(); an invalid
				// selector is validated out up front, but this stays guarded
				// regardless since it also builds the DOM walk highlighting reads.
				speechModel = buildSpeechModel( contentRoot );
				var utterance = new window.SpeechSynthesisUtterance( speechModel.text );
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
				// Read-along highlighting -- best-effort only. Browser support for
				// onboundary (and for charLength/event.name within it) varies a lot;
				// a failure here must never interrupt speech itself.
				utterance.onboundary = function ( event ) {
					try {
						currentHighlight = clearHighlight( currentHighlight );
						var length = event.charLength ||
							estimateChunkLength( speechModel.text, event.charIndex, event.name );
						currentHighlight = highlightChunk(
							contentRoot, speechModel.skipPredicate, event.charIndex, length
						);
					} catch ( e ) {
						if ( window.console && console.warn ) {
							console.warn( 'PageReader highlight failed', e );
						}
						currentHighlight = null;
					}
				};
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
	// insertButton() also places the voice select+label between the button
	// and content, so the button now sits a few hops further back. Walk back
	// a bounded number of siblings rather than hardcoding an exact hop count,
	// so this keeps working if the controls inserted after the button change.
	function findPrecedingButton( node, maxHops ) {
		var candidate = node.previousElementSibling;
		var hops = 0;
		while ( candidate && hops < maxHops ) {
			if ( candidate.classList && candidate.classList.contains( 'pagereader-button' ) ) {
				return candidate;
			}
			candidate = candidate.previousElementSibling;
			hops++;
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
			return findPrecedingButton( content, 4 );
		} else if ( placement === 'top-of-content' ) {
			var firstChild = content.firstElementChild;
			return ( firstChild && firstChild.classList &&
				firstChild.classList.contains( 'pagereader-button' ) ) ? firstChild : null;
		}
		return findPrecedingButton( content, 4 );
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
