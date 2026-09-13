/* PageReader: config-driven read-aloud button. Every entry point is
 * wrapped in try/catch — a failure here must never affect other page JS.
 * This is the entire reason this extension exists (see spec §1: the
 * 2026-09-08/09 outage where a broken shared Common.js module took down
 * unrelated site features).
 */
( function () {
	'use strict';

	// Firefox on Linux (via its speech-dispatcher/espeak-ng bridge) was
	// found to produce badly garbled audio -- described as "a mix of a
	// whisper and an alien/ghost" -- specifically when a non-default
	// pitch/rate is applied to an utterance; a plain default utterance on
	// the same machine/voice sounds normal (robotic, but intact). Chrome
	// and the same voice's own default settings are unaffected. There is
	// no feature-detection for this (the Web Speech API gives no signal
	// that pitch/rate scaling is broken), so this falls back to UA
	// sniffing -- narrowly scoped to skipping our pitch/rate tuning only,
	// not any other behavior.
	function isFirefox() {
		return typeof navigator !== 'undefined' && /Firefox\//.test( navigator.userAgent || '' );
	}

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

	// True if `node` lies strictly between `start` and `end` in document
	// order -- used only for skip ranges (see isInsideAnySkipRange()).
	function isBetween( node, start, end ) {
		var afterStart = !!( start.compareDocumentPosition( node ) & Node.DOCUMENT_POSITION_FOLLOWING );
		var beforeEnd = !!( end.compareDocumentPosition( node ) & Node.DOCUMENT_POSITION_PRECEDING );
		return afterStart && beforeEnd;
	}

	// <pagereader-readaloud-skip-start>/<pagereader-readaloud-skip-end>
	// marker elements exclude one specific stretch of a page from being
	// read -- with no markers on a page at all, the whole eligible content
	// area is read by default (see resolveContentRegion()), and this is
	// how an editor carves out the rare exception -- a navigation link, a
	// banner -- without having to wrap the entire rest of the article to
	// get there. Plain hidden <span> elements, not HTML comments: MediaWiki's
	// parser strips literal wikitext comments from the rendered output
	// entirely (confirmed against a live page render -- they never reach
	// the DOM at all), so a comment-based marker would silently do nothing
	// for every real reader, not just fail to work as intended. A single
	// self-closing span carries none of the "unbalanced tag" baggage that
	// broke {{ReadAloud/start}}/{{ReadAloud/end}} in VisualEditor (see
	// DEPLOY.md) -- the same reason {{ReadAloudButton}}'s own marker
	// (pagereader-button-anchor) already works fine there today.
	//
	// A page can have any number of skip regions (a template used many
	// times might each emit its own pair). Tracked by depth, not just a
	// single pending start, so a pair nested inside another (e.g. two
	// templates that each emit their own skip-start/skip-end, one call
	// ending up inside the other's output) collapses into one range
	// spanning the outermost start to the outermost end, rather than the
	// outer start/end leaking through as readable while only the inner
	// pair is actually excluded.
	function findSkipRanges( root ) {
		var markers = root.querySelectorAll(
			'.pagereader-readaloud-skip-start, .pagereader-readaloud-skip-end'
		);
		var ranges = [];
		var pendingStart = null;
		var depth = 0;
		for ( var i = 0; i < markers.length; i++ ) {
			var node = markers[ i ];
			if ( node.classList.contains( 'pagereader-readaloud-skip-start' ) ) {
				if ( depth === 0 ) {
					pendingStart = node;
				}
				depth++;
			} else if ( depth > 0 ) {
				depth--;
				if ( depth === 0 ) {
					ranges.push( { start: pendingStart, end: node } );
					pendingStart = null;
				}
			}
		}
		return ranges;
	}

	// True if `node` falls inside any of `skipRanges` (see
	// findSkipRanges()). Skip ranges don't need to share a parent with
	// each other or with whatever contentRoot ended up being, since
	// compareDocumentPosition() works across the whole document
	// regardless of ancestry.
	function isInsideAnySkipRange( node, skipRanges ) {
		for ( var i = 0; i < skipRanges.length; i++ ) {
			if ( isBetween( node, skipRanges[ i ].start, skipRanges[ i ].end ) ) {
				return true;
			}
		}
		return false;
	}

	// Shared by buildSpeechModel() (deciding what text to speak) and
	// highlightChunk() (deciding what's eligible to highlight) so the two
	// can never drift out of alignment -- they must skip exactly the same
	// nodes in exactly the same order for a sentence's recorded character
	// offsets to still point at the right text in the live DOM.
	function makeSkipPredicate( contentRoot, skipRanges ) {
		var skipSelectors = validSkipSelectors();
		var ownControlClasses = [
			'pagereader-button',
			'pagereader-voice-select',
			'pagereader-visually-hidden',
			'pagereader-pause-button'
		];
		return function ( textNode ) {
			if ( isInsideAnySkipRange( textNode, skipRanges ) ) {
				return true;
			}
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
	// that's what makes highlighting possible later, since highlightChunk()
	// needs the same live nodes a sentence's offsets point back into.
	function buildSpeechModel( contentRoot, skipRanges ) {
		var skipPredicate = makeSkipPredicate( contentRoot, skipRanges );
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

	// Simple regex splitter, not locale-aware Intl.Segmenter -- a mis-split
	// on an abbreviation ("Mr. Smith") just produces two slightly-too-short
	// highlighted chunks, not a functional break, and this works in every
	// browser with no feature detection. Returns {text, start, end} ranges
	// (character offsets into the original text) so each sentence can still
	// be mapped back to real DOM text nodes via highlightChunk().
	function splitIntoSentences( text ) {
		function skipWhitespace( from ) {
			while ( from < text.length && /\s/.test( text.charAt( from ) ) ) {
				from++;
			}
			return from;
		}

		var sentences = [];
		var re = /[.!?]+(?=\s|$)/g;
		var start = skipWhitespace( 0 );
		var match;
		while ( ( match = re.exec( text ) ) !== null ) {
			var end = match.index + match[ 0 ].length;
			if ( end > start ) {
				sentences.push( { text: text.slice( start, end ), start: start, end: end } );
			}
			start = skipWhitespace( end );
		}
		if ( start < text.length ) {
			sentences.push( { text: text.slice( start ), start: start, end: text.length } );
		}
		return sentences;
	}

	// Removes a previous highlight (if any) and merges each mark's text back
	// into its surrounding node via normalize() -- always fully restoring
	// the DOM before the next highlightChunk() call, rather than keeping a
	// reference to a node that surroundContents() may have split, which
	// would otherwise go stale after exactly one highlight/clear cycle.
	// Accepts the array highlightChunk() returns (or null).
	function clearHighlight( marks ) {
		if ( !marks ) {
			return null;
		}
		for ( var i = 0; i < marks.length; i++ ) {
			var mark = marks[ i ];
			if ( !mark || !mark.parentNode ) {
				continue;
			}
			var text = document.createTextNode( mark.textContent );
			mark.parentNode.replaceChild( text, mark );
			if ( text.parentNode ) {
				text.parentNode.normalize();
			}
		}
		return null;
	}

	// Rebuilt from scratch against the live DOM on every call (see
	// clearHighlight()) rather than reusing node references across calls.
	// Walks every non-skipped text node overlapping [startOffset, endOffset)
	// and wraps each overlapping slice in its own <mark> -- a sentence
	// spanning multiple text nodes (e.g. a wikilink or <b> in the middle,
	// which is common in real wiki markup, not a rare edge case) needs one
	// mark per node so the whole sentence is actually highlighted, not just
	// the portion inside whichever node happens to contain startOffset.
	function highlightChunk( contentRoot, skipPredicate, startOffset, length ) {
		var endOffset = startOffset + length;

		// Two passes, deliberately not interleaved: collect every
		// overlapping (node, localStart, localEnd) first with a read-only
		// walk, then mutate the DOM in a second loop. Wrapping a node in a
		// <mark> while the TreeWalker that found it is still mid-traversal
		// does not reliably continue to the correct next node afterwards.
		var walker = document.createTreeWalker( contentRoot, NodeFilter.SHOW_TEXT, null );
		var offset = 0;
		var node;
		var targets = [];

		while ( ( node = walker.nextNode() ) ) {
			if ( skipPredicate( node ) ) {
				continue;
			}
			var nodeStart = offset;
			var nodeEnd = offset + node.nodeValue.length;
			offset = nodeEnd;

			if ( nodeEnd <= startOffset ) {
				continue;
			}
			if ( nodeStart >= endOffset ) {
				break;
			}

			var localStart = Math.max( 0, startOffset - nodeStart );
			var localEnd = Math.min( node.nodeValue.length, endOffset - nodeStart );
			if ( localEnd > localStart ) {
				targets.push( { node: node, localStart: localStart, localEnd: localEnd } );
			}
		}

		var marks = [];
		for ( var i = 0; i < targets.length; i++ ) {
			var target = targets[ i ];
			var range = document.createRange();
			range.setStart( target.node, target.localStart );
			range.setEnd( target.node, target.localEnd );

			var mark = document.createElement( 'mark' );
			mark.className = 'pagereader-highlight';
			range.surroundContents( mark );
			marks.push( mark );
		}

		return marks.length ? marks : null;
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
			// $wgPageReaderPreferredVoices (LocalSettings) reaches here
			// unsanitized, unlike the overlay path -- a non-string entry
			// (e.g. a stray number) must be skipped, not thrown on, or the
			// whole click handler's try/catch aborts before speak() is ever
			// reached and the reader hears nothing at all.
			if ( typeof names[ n ] !== 'string' ) {
				continue;
			}
			var fragment = names[ n ].toLowerCase();
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

	function bindButton( button, contentRoot, skipRanges ) {
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
		// Chrome (among others) only weakly references the JS-side
		// SpeechSynthesisUtterance wrapper for whatever it's currently
		// speaking -- without a strong reference held somewhere, that
		// wrapper can be garbage collected mid-utterance (especially for a
		// remote/network voice, which takes longer), silently dropping
		// onend and stalling this hand-rolled queue after one sentence.
		// This is the same class of bug that likely broke the original
		// word-level highlighting attempt. Holds every utterance in the
		// current queue, not just the one currently speaking -- see
		// speakSentences() below, which queues the whole article up front
		// rather than one utterance at a time, so each queued-but-not-yet-
		// speaking utterance still needs its own strong reference. Cleared
		// in stopSpeaking().
		var queuedUtterances = null;
		// Bumped on every stop/restart; every utterance callback below
		// captures the generation it was created under and checks it's
		// still current before doing anything. Guards against a stray
		// onend/onerror firing (from speechSynthesis.cancel(), or from a
		// second click starting a new read) after the state it belongs to
		// has already been superseded -- without this, a cancelled
		// sentence's onend could still advance into speaking the next one.
		var speechGeneration = 0;

		function stopSpeaking() {
			speechGeneration++;
			speaking = false;
			paused = false;
			queuedUtterances = null;
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

				window.speechSynthesis.cancel();
				speechGeneration++;
				var myGeneration = speechGeneration;

				// See isFirefox() -- Firefox gets the browser's own default
				// pitch/rate (1/1) instead of the configured tuning.
				var pitch = isFirefox() ? 1 : clampNumber( mw.config.get( 'wgPageReaderVoicePitch' ), 0, 2, 1 );
				var rate = isFirefox() ? 1 : clampNumber( mw.config.get( 'wgPageReaderVoiceRate' ), 0.1, 10, 1 );
				var voiceSelect = findVoiceSelect( button );
				var genderPreference = voiceSelect ? voiceSelect.value : mw.config.get( 'wgPageReaderVoiceGender' );
				var voice = pickVoice( genderPreference );
				var highlightEnabled = mw.config.get( 'wgPageReaderHighlightEnabled' );

				// buildSpeechModel() runs $wgPageReaderSkipSelectors (editable
				// via the on-wiki config overlay) through Element.matches(); an
				// invalid selector is validated out up front, but this stays
				// guarded regardless since it also builds the DOM walk
				// highlighting reads.
				var model = buildSpeechModel( contentRoot, skipRanges );
				var sentences = highlightEnabled ? splitIntoSentences( model.text ) : [];

				function applyVoiceSettings( utterance ) {
					utterance.pitch = pitch;
					utterance.rate = rate;
					if ( voice ) {
						utterance.voice = voice;
					}
				}

				// Highlighting disabled (or nothing to split, e.g. empty
				// content): identical to this extension's pre-highlighting
				// behavior -- one utterance for the whole article, no
				// per-sentence chaining overhead or inter-sentence gaps.
				function speakWholeArticle() {
					var utterance = new window.SpeechSynthesisUtterance( model.text );
					applyVoiceSettings( utterance );
					queuedUtterances = [ utterance ];
					utterance.onend = function () {
						if ( myGeneration === speechGeneration ) {
							stopSpeaking();
						}
					};
					utterance.onerror = function () {
						if ( myGeneration === speechGeneration ) {
							stopSpeaking();
						}
					};
					window.speechSynthesis.speak( utterance );
				}

				// onstart is reliably supported everywhere, unlike
				// SpeechSynthesisUtterance's onboundary (Firefox in
				// particular only ever reports sentence-level boundaries,
				// if any at all -- Chrome's own network voices were measured
				// firing *no* boundary events at all for a whole-article
				// utterance). Per-sentence utterances sidestep onboundary
				// entirely, trading word-level granularity for actually
				// working consistently.
				//
				// All sentences are queued via speak() up front, in order,
				// rather than reactively from the previous utterance's onend:
				// speechSynthesis.speak() already plays queued utterances back
				// to back on its own, and calling it only after the previous
				// utterance fully ends forces Chrome to wait for a full network
				// round-trip to a remote voice before even starting the next
				// utterance's synthesis -- measured at ~1s of dead air at every
				// sentence boundary for a Chrome network voice. Queuing
				// everything up front lets Chrome synthesize a later sentence
				// while an earlier one is still playing, which measured under
				// 250ms. onstart (not the speak() call itself) still drives
				// highlighting, so each sentence still lights up exactly when
				// its audio actually starts.
				function speakSentences( sentenceList ) {
					queuedUtterances = sentenceList.map( function ( sentence ) {
						return new window.SpeechSynthesisUtterance( sentence.text );
					} );

					// A separate function per utterance (called from a plain
					// for-loop below, not forEach) so each iteration's
					// onstart/onend/onerror closures still get their own
					// private `sentence`/`utterance`/`index` the way forEach's
					// per-call callback scope used to provide -- var is
					// function-scoped, not block-scoped, so inlining this
					// directly in a for-loop body would have every closure
					// share the loop's final index instead.
					function queueSentenceUtterance( index ) {
						var utterance = queuedUtterances[ index ];
						var sentence = sentenceList[ index ];
						applyVoiceSettings( utterance );

						utterance.onstart = function () {
							if ( myGeneration !== speechGeneration ) {
								return;
							}
							try {
								currentHighlight = clearHighlight( currentHighlight );
								currentHighlight = highlightChunk(
									contentRoot, model.skipPredicate, sentence.start, sentence.end - sentence.start
								);
							} catch ( e ) {
								if ( window.console && console.warn ) {
									console.warn( 'PageReader highlight failed', e );
								}
								currentHighlight = null;
							}
						};

						// Only the last queued utterance's onend means the whole
						// read is finished -- speechSynthesis itself already plays
						// the queued utterances in order, so the others need no
						// onend handler here.
						if ( index === sentenceList.length - 1 ) {
							utterance.onend = function () {
								if ( myGeneration === speechGeneration ) {
									stopSpeaking();
								}
							};
						}

						// Also cancels every other still-queued sentence -- without
						// this, an error partway through would leave the rest of the
						// article still queued and playing while the button/UI had
						// already reset to idle.
						utterance.onerror = function () {
							if ( myGeneration === speechGeneration ) {
								window.speechSynthesis.cancel();
								stopSpeaking();
							}
						};

						window.speechSynthesis.speak( utterance );
					}

					// A plain for-loop, not forEach, so a synchronous onerror/
					// onend fired by an earlier speak() call in this same loop
					// (some engines report certain failures -- e.g. Chrome's
					// autoplay-policy "not-allowed" error -- synchronously) can
					// stop the loop from queuing any further utterances once it
					// has already reset the UI to idle via stopSpeaking().
					// forEach has no way to break early; a bare for-loop does.
					for ( var index = 0; index < queuedUtterances.length; index++ ) {
						if ( myGeneration !== speechGeneration ) {
							break;
						}
						queueSentenceUtterance( index );
					}
				}

				if ( sentences.length ) {
					speakSentences( sentences );
				} else {
					speakWholeArticle();
				}

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
				// A throw partway through queuing (e.g. after some, but not
				// all, sentences were already handed to speak()) must flush
				// whatever was already queued -- otherwise those utterances
				// keep playing under a button that stopSpeaking() alone
				// already reset to idle.
				window.speechSynthesis.cancel();
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

	// Resolves what element to read, most specific signal first:
	//
	//   1. contentClass/contentSelector config, unchanged -- any page using
	//      the kids-readaloud class (or a configured fallback selector)
	//      keeps working exactly as before.
	//   2. Opt-OUT default: no marker of any kind means read the whole
	//      eligible content area (root itself -- this page already passed
	//      server-side namespace/title eligibility to get PageReader loaded
	//      at all, so there's nothing further to check here). An editor
	//      excludes the rare exception -- a banner, a nav link -- with a
	//      pagereader-readaloud-skip-start/-end marker pair (see
	//      findSkipRanges()) rather than the whole article needing a
	//      wrapper just to get to the one thing that should stay silent.
	function resolveContentRegion( root ) {
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
			var selected = root.querySelector( fallbackSelector );
			if ( selected ) {
				return selected;
			}
		}

		// Opt-out default. root.nodeType === 1 (an Element) covers the normal
		// case -- the wikipage.content hook's own $content argument, almost
		// always #mw-content-text or a narrower re-render fragment. root can
		// only be the whole `document` (nodeType 9) via this file's own
		// DOMContentLoaded fallback for an environment with no mw.hook, which
		// never happens on a real MediaWiki page load; document.body is a
		// reasonable next-best root there, still well short of chrome like
		// the sidebar or search box.
		//
		// wikipage.content is a generic, shared MediaWiki hook -- other
		// gadgets/extensions (reference-popup previews, live-preview
		// widgets, comment threads) fire it too, for their own unrelated
		// fragments, on the very same eligible page, and MediaWiki core
		// itself can replay the hook for just a narrower re-rendered
		// fragment rather than the whole content area again. The class/
		// selector branches above are both explicit opt-in signals, safe
		// regardless of which fragment fires the hook; the opt-out default
		// has no such signal, so it requires root to actually BE the
		// page's own content area -- not merely somewhere inside it -- or
		// any such narrower fragment would itself be treated as "the whole
		// content to read", inserting a second button scoped to just that
		// fragment (findExistingButton() looks for the existing button
		// relative to the real content area, not this unrelated fragment,
		// so it never finds it).
		var contentArea = document.getElementById( 'mw-content-text' );
		var isContentArea = !contentArea || root === contentArea;
		if ( root && root.nodeType === 1 && isContentArea ) {
			return root;
		}
		if ( root === document && document.body ) {
			return document.body;
		}

		return null;
	}

	// {{ReadAloudButton}} emits a hidden <span class="pagereader-button-anchor">
	// marker -- its mere presence on the page (anywhere, not necessarily next
	// to the read-aloud content) is an explicit per-page override of where
	// the button goes, taking priority over $wgPageReaderButtonPlacement.
	// Left in the DOM permanently (never removed) so a repeat wikipage.content
	// firing can still find it and locate the existing button via
	// findFollowingSibling(), the same pattern used for the voice select and
	// pause button.
	//
	// Deliberately searches the whole document, not just root: initPageReader()
	// sets root from the wikipage.content hook's own $content argument, which
	// MediaWiki core fires as a narrower fragment (e.g. just the content div)
	// on some re-renders, not always the same #mw-content-text wrapper used on
	// first load. The anchor is documented as placeable anywhere on the page,
	// independent of where the read-aloud content itself is marked, so a
	// root-scoped search would both miss an anchor placed outside root and
	// fail to find the already-inserted button next to it -- inserting a
	// second one via the placement-based fallback.
	function findButtonAnchor() {
		return document.querySelector( '.pagereader-button-anchor' );
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
	function findExistingButton( content, placement, anchor ) {
		// An anchor (from {{ReadAloudButton}}, see findButtonAnchor()) always
		// wins over the configured placement mode when present -- it's an
		// explicit, per-page, editor-controlled override, the same way
		// __NOPAGEREADER__ already overrides site config per-page.
		if ( anchor ) {
			return findFollowingSibling( anchor, 'pagereader-button' );
		}
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

	function insertButton( content, placement, anchor ) {
		var button = document.createElement( 'button' );
		button.className = 'pagereader-button';
		button.setAttribute( 'aria-pressed', 'false' );

		if ( anchor ) {
			anchor.parentNode.insertBefore( button, anchor.nextSibling );
		} else if ( placement === 'after-heading' ) {
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

			var content = resolveContentRegion( root );
			if ( !content || !content.parentNode ) {
				return;
			}

			if ( !( 'speechSynthesis' in window ) ) {
				return;
			}

			var placement = mw.config.get( 'wgPageReaderButtonPlacement' ) || 'before-content';
			var anchor = findButtonAnchor();
			var button = findExistingButton( content, placement, anchor ) ||
				insertButton( content, placement, anchor );

			// Computed from root (not content) regardless of which branch
			// resolveContentRegion() took, so a skip-marker pair works the
			// same way under every scoping mode, not just the opt-out default.
			var skipRanges = findSkipRanges( root );
			bindButton( button, content, skipRanges );
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
