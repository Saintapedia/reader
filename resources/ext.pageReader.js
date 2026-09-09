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

	function buildSpeechText( contentRoot ) {
		var clone = contentRoot.cloneNode( true );
		getSkipSelectors().forEach( function ( selector ) {
			var matches = clone.querySelectorAll( selector );
			for ( var i = 0; i < matches.length; i++ ) {
				matches[ i ].parentNode.removeChild( matches[ i ] );
			}
		} );
		return clone.textContent;
	}

	function bindButton( button, contentRoot ) {
		if ( !button || button.getAttribute( 'data-pagereader-bound' ) === '1' ) {
			return;
		}
		button.setAttribute( 'data-pagereader-bound', '1' );
		button.setAttribute( 'type', 'button' );

		var labelIdle = mw.msg( 'pagereader-button-label' );
		var labelStop = mw.msg( 'pagereader-button-label-stop' );
		button.textContent = labelIdle;

		var speaking = false;

		function stopSpeaking() {
			speaking = false;
			button.textContent = labelIdle;
			button.classList.remove( 'pagereader-speaking' );
			button.setAttribute( 'aria-pressed', 'false' );
		}

		button.addEventListener( 'click', function () {
			if ( speaking ) {
				window.speechSynthesis.cancel();
				stopSpeaking();
				return;
			}
			var utterance = new window.SpeechSynthesisUtterance( buildSpeechText( contentRoot ) );
			utterance.onend = stopSpeaking;
			utterance.onerror = stopSpeaking;
			window.speechSynthesis.cancel();
			window.speechSynthesis.speak( utterance );
			speaking = true;
			button.textContent = labelStop;
			button.classList.add( 'pagereader-speaking' );
			button.setAttribute( 'aria-pressed', 'true' );
		} );
	}

	function findContentRoot( root ) {
		var contentClass = mw.config.get( 'wgPageReaderContentClass' );
		if ( contentClass ) {
			if ( root.classList && root.classList.contains( contentClass ) ) {
				return root;
			}
			if ( root.querySelector ) {
				var marked = root.querySelector( '.' + contentClass );
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

	function insertButton( content ) {
		var placement = mw.config.get( 'wgPageReaderButtonPlacement' ) || 'before-content';
		var button = document.createElement( 'button' );
		button.className = 'pagereader-button';
		button.setAttribute( 'aria-pressed', 'false' );

		if ( placement === 'after-heading' ) {
			var heading = document.getElementById( 'firstHeading' );
			if ( heading && heading.parentNode ) {
				heading.parentNode.insertBefore( button, heading.nextSibling );
				return button;
			}
		} else if ( placement === 'top-of-content' ) {
			content.insertBefore( button, content.firstChild );
			return button;
		}

		// Default: 'before-content'.
		content.parentNode.insertBefore( button, content );
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

			var existing = content.previousElementSibling;
			var button;
			if ( existing && existing.classList && existing.classList.contains( 'pagereader-button' ) ) {
				button = existing;
			} else {
				button = insertButton( content );
			}

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
