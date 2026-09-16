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

	var PIPER_CDN_URL = 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js';
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
			libraryPromise = import( PIPER_CDN_URL );
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
	function speak( sentenceList, callbacks ) {
		var cancelled = false;
		var currentAudio = null;

		function playIndex( index ) {
			if ( cancelled ) {
				return;
			}
			if ( index >= sentenceList.length ) {
				callbacks.onEnd();
				return;
			}
			var sentence = sentenceList[ index ];
			loadLibrary().then( function ( piperTts ) {
				return piperTts.predict( { text: sentence.text, voiceId: VOICE_ID } );
			} ).then( function ( wavBlob ) {
				if ( cancelled ) {
					return;
				}
				currentAudio = new window.Audio( URL.createObjectURL( wavBlob ) );
				currentAudio.addEventListener( 'play', function () {
					if ( !cancelled ) {
						callbacks.onSentenceStart( sentence );
					}
				} );
				currentAudio.addEventListener( 'ended', function () {
					if ( !cancelled ) {
						playIndex( index + 1 );
					}
				} );
				currentAudio.addEventListener( 'error', function () {
					if ( !cancelled ) {
						callbacks.onError();
					}
				} );
				currentAudio.play();
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
			},
			pause: function () {
				if ( currentAudio ) {
					currentAudio.pause();
				}
			},
			resume: function () {
				if ( currentAudio ) {
					currentAudio.play();
				}
			}
		};
	}

	window.pageReaderPiper = {
		download: download,
		speak: speak
	};
}() );
