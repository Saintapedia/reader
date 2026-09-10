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
		// The button itself can end up inside contentRoot (the 'top-of-content'
		// placement inserts it as content's first child) — always strip it so
		// its own label is never read aloud, regardless of $wgPageReaderSkipSelectors.
		var ownButton = clone.querySelectorAll( '.pagereader-button' );
		for ( var j = 0; j < ownButton.length; j++ ) {
			ownButton[ j ].parentNode.removeChild( ownButton[ j ] );
		}
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
				utterance.onend = stopSpeaking;
				utterance.onerror = stopSpeaking;
				window.speechSynthesis.cancel();
				window.speechSynthesis.speak( utterance );
				speaking = true;
				button.textContent = labelStop;
				button.classList.add( 'pagereader-speaking' );
				button.setAttribute( 'aria-pressed', 'true' );
			} catch ( e ) {
				if ( window.console && console.warn ) {
					console.warn( 'PageReader failed', e );
				}
				stopSpeaking();
			}
		} );
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

	// The duplicate-button guard in initPageReader() needs to look in the same
	// place insertButton() puts the button, for each placement mode — otherwise
	// a repeat wikipage.content firing (e.g. an AJAX content refresh) won't find
	// the existing button and will insert another one.
	function findExistingButton( content, placement ) {
		var candidate;
		if ( placement === 'after-heading' ) {
			var heading = document.getElementById( 'firstHeading' );
			candidate = heading && heading.nextElementSibling;
		} else if ( placement === 'top-of-content' ) {
			candidate = content.firstElementChild;
		} else {
			candidate = content.previousElementSibling;
		}
		if ( candidate && candidate.classList && candidate.classList.contains( 'pagereader-button' ) ) {
			return candidate;
		}
		return null;
	}

	function insertButton( content, placement ) {
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
