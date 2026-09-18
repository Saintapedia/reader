/* PageReader Piper: lazily-loaded client-side neural voice option. Never
 * requested until a reader opts in via ext.pageReader.js's "Try a better
 * voice" control -- see
 * docs/superpowers/specs/2026-09-16-piper-voice-option-design.md.
 * Every entry point here degrades by rejecting/erroring, letting the
 * caller (ext.pageReader.js) fall back to the native voice -- this file
 * itself does not attempt any fallback logic, that lives entirely in the
 * caller (see that file's speakWithPiper()).
 */
( function () {
	'use strict';

	// Loaded from our own vendored, patched copy (resources/vendor/piper-tts-web.esm.js),
	// not the live jsdelivr CDN build -- the unpatched @mintplex-labs/piper-tts-web@1.0.5
	// +esm build hardcodes a WASM backend path (onnxruntime-web@1.18.0 on cdnjs) that
	// 404s, so every real synthesis call fails with "no available backend found"
	// regardless of browser, and this is still true in 1.0.5 (the latest published
	// version as of this writing). See that file's header comment for the exact
	// patch applied and how to re-vendor after a deliberate version bump. Served as
	// a plain static extension asset (not through ResourceLoader's own bundling,
	// since this needs a real fetchable URL for a runtime import()) via
	// wgExtensionAssetsPath, the same mechanism MediaWiki uses for any other
	// extension asset not delivered through ResourceLoader.
	var PIPER_LIBRARY_URL = mw.config.get( 'wgExtensionAssetsPath' ) +
		'/PageReader/resources/vendor/piper-tts-web.esm.js';
	var VOICE_ID = 'en_US-amy-medium';

	var libraryPromise = null;

	// Dynamic import() works directly inside a plain (non-module) script in
	// every evergreen browser -- confirmed no <script type="module">
	// wrapper is needed. Memoized so a second opt-in click (or the main
	// button's click after opting in) doesn't re-fetch the ~500KB
	// JS/WASM runtime bundle every time; the reader only pays that once
	// per page load.
	function loadLibrary() {
		if ( !libraryPromise ) {
			// A rejected import() (CDN blip, offline, blocked) must not be
			// memoized permanently -- without resetting libraryPromise back
			// to null on rejection, `!libraryPromise` above would stay
			// false forever, so a reader whose opt-in click failed once
			// could never successfully retry for the rest of the page's
			// lifetime, even after the network/CDN recovered.
			libraryPromise = import( PIPER_LIBRARY_URL ).catch( function ( error ) {
				libraryPromise = null;
				throw error;
			} );
		}
		return libraryPromise;
	}

	function download( onProgress ) {
		return loadLibrary().then( function ( piperTts ) {
			return piperTts.download( VOICE_ID, onProgress );
		} );
	}

	// One sentence at a time: Piper's predict() is async (it must
	// synthesize before there's anything to play), unlike
	// speechSynthesis.speak() which hands off to the browser's own
	// internal queue and returns immediately -- so this cannot reuse
	// ext.pageReader.js's native "queue everything up front" design (see
	// that file's speakSentences()) at all. No per-sentence retry here
	// either: any failure reports onError() once, and the caller falls
	// back to the native engine entirely (design spec section 8) rather
	// than this file trying to recover -- there is no native browser
	// queue to fight with here, so the cancel()-cascade class of bug
	// #14 fixed for the native engine cannot happen in this
	// implementation at all.
	//
	// `paused` is tracked explicitly (not inferred from currentAudio)
	// because a pause/resume click can land while a sentence is still
	// being synthesized -- i.e. before any <audio> element exists yet.
	// Without this flag, that click would silently do nothing and the
	// next sentence would start playing regardless of the reader's
	// request the moment its synthesis finished.
	function speak( sentenceList, callbacks ) {
		var cancelled = false;
		var paused = false;
		var currentAudio = null;
		// The blob: URL currently backing currentAudio -- tracked
		// separately so it can be revoked from cancel() too (a mid-play
		// stop calls currentAudio.pause(), which fires neither 'ended'
		// nor 'error', so those two listeners alone would never release
		// it for that case).
		var currentObjectUrl = null;
		// Index -> in-flight/resolved predict() promise. Without this,
		// synthesis for a sentence only ever started after the previous
		// sentence's audio finished playing ('ended'), leaving an audible
		// gap at every sentence boundary while single-threaded WASM
		// inference ran with nothing playing. predictSentence() is called
		// one sentence ahead of playback (see playIndex()) so the next
		// sentence's audio is usually already synthesized -- or well
		// underway -- by the time it's needed. Memoized per index so
		// playIndex()'s own call and its earlier prefetch call for the
		// same index never trigger two concurrent predict() calls for the
		// same sentence.
		var predictions = {};

		function predictSentence( index ) {
			if ( index >= sentenceList.length ) {
				return null;
			}
			if ( !predictions[ index ] ) {
				predictions[ index ] = loadLibrary().then( function ( piperTts ) {
					return piperTts.predict( { text: sentenceList[ index ].text, voiceId: VOICE_ID } );
				} );
				// The one-ahead prefetch call below never attaches its own
				// handler to this promise (see playIndex()) -- if the
				// reader stops the read before playIndex() ever reaches
				// this index to attach its real .catch(), a later
				// rejection here would otherwise be a genuine unhandled
				// promise rejection. This no-op catch only ensures some
				// handler always exists; it doesn't call onError() itself
				// -- playIndex()'s own .then()/.catch() on this same
				// memoized promise still does that normally for an active
				// read, since multiple handlers on one promise all fire
				// independently.
				predictions[ index ].catch( function () {} );
			}
			return predictions[ index ];
		}

		function releaseCurrentAudio() {
			if ( currentObjectUrl ) {
				URL.revokeObjectURL( currentObjectUrl );
				currentObjectUrl = null;
			}
		}

		function playCurrentAudio() {
			currentAudio.play().catch( function ( error ) {
				// HTMLMediaElement.play()'s returned promise rejects on
				// failures the 'error' event does not cover (e.g. an
				// autoplay-policy block) -- without this .catch(), such a
				// rejection would be an unhandled promise rejection and
				// the caller would never learn playback actually failed.
				// But calling .pause() while a play() request is still in
				// flight *also* rejects that same promise, with an
				// AbortError, in every major browser -- an expected,
				// harmless consequence of the reader (or cancel()) simply
				// pausing quickly, not a real synthesis/playback failure.
				// Reporting that as onError() would wrongly trigger the
				// native fallback (and count as a Piper failure) on an
				// ordinary pause.
				if ( !cancelled && !( error && error.name === 'AbortError' ) ) {
					callbacks.onError();
				}
			} );
		}

		function playIndex( index ) {
			if ( cancelled ) {
				return;
			}
			if ( index >= sentenceList.length ) {
				callbacks.onEnd();
				return;
			}
			var sentence = sentenceList[ index ];
			// Call predictSentence( index ) -- registering ITS .then() --
			// before predictSentence( index + 1 ), not after: loadLibrary()
			// returns the same already-resolved, memoized promise for
			// every sentence, and Promise callbacks on one promise fire in
			// the order they were attached. Prefetching index + 1 first
			// would queue ITS predict() call ahead of the current
			// sentence's, so time-to-first-audio would become
			// T(next)+T(current) instead of T(current) -- the opposite of
			// this function's purpose. Calling index first, then index + 1
			// right behind it, means the lookahead's inference genuinely
			// overlaps with the current sentence's playback instead of
			// delaying it.
			var currentPrediction = predictSentence( index );
			predictSentence( index + 1 );
			currentPrediction.then( function ( wavBlob ) {
				if ( cancelled ) {
					return;
				}
				// Consumed -- free the resolved blob now rather than
				// holding every sentence's decoded audio for the rest of
				// the read (there is no seek/rewind, so nothing past this
				// point ever needs it again). Only the index + 1 lookahead
				// prefetched above stays in the map.
				delete predictions[ index ];
				currentObjectUrl = URL.createObjectURL( wavBlob );
				currentAudio = new window.Audio( currentObjectUrl );
				currentAudio.addEventListener( 'play', function () {
					if ( !cancelled ) {
						callbacks.onSentenceStart( sentence );
					}
				} );
				currentAudio.addEventListener( 'ended', function () {
					releaseCurrentAudio();
					if ( !cancelled ) {
						playIndex( index + 1 );
					}
				} );
				currentAudio.addEventListener( 'error', function () {
					releaseCurrentAudio();
					if ( !cancelled ) {
						callbacks.onError();
					}
				} );
				if ( paused ) {
					// The reader paused while this sentence was still
					// synthesizing -- leave it loaded but unplayed; resume()
					// below calls .play() on it once clicked.
					return;
				}
				playCurrentAudio();
			} ).catch( function () {
				if ( !cancelled ) {
					callbacks.onError();
				}
			} );
		}

		playIndex( 0 );

		return {
			cancel: function () {
				cancelled = true;
				if ( currentAudio ) {
					currentAudio.pause();
				}
				// A mid-play stop fires neither 'ended' nor 'error' on
				// currentAudio, so this is the only place that releases
				// the object URL for a sentence stopped while playing.
				releaseCurrentAudio();
			},
			pause: function () {
				paused = true;
				if ( currentAudio ) {
					currentAudio.pause();
				}
			},
			resume: function () {
				paused = false;
				if ( currentAudio ) {
					playCurrentAudio();
				}
			}
		};
	}

	window.pageReaderPiper = {
		download: download,
		speak: speak
	};
}() );
