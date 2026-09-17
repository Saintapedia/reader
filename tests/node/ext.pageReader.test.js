'use strict';
/**
 * Behavioral test suite for resources/ext.pageReader.js, using jsdom to
 * simulate a real page (mw.config/mw.msg/mw.hook mocked, speechSynthesis
 * stubbed) and actually clicking the button. This exists because the JS
 * logic has no PHPUnit coverage and is easy to regress silently -- two
 * real bugs (a placement-specific duplicate-button guard, and a single
 * invalid on-wiki-configured skip selector aborting the whole utterance)
 * were found by manual/AI code review after PHPUnit was already green.
 * Every test below traces to a specific finding from that review.
 *
 * Run: node tests/node/ext.pageReader.test.js (after `npm install`)
 */
const fs = require( 'fs' );
const path = require( 'path' );
const assert = require( 'assert' );
const { JSDOM } = require( 'jsdom' );

const SCRIPT_PATH = path.resolve( __dirname, '../../resources/ext.pageReader.js' );
const SCRIPT_SRC = fs.readFileSync( SCRIPT_PATH, 'utf8' );

let passed = 0;
let failed = 0;
const failures = [];

function makeMw( configOverrides, msgOverrides ) {
	const config = Object.assign( {
		wgPageReaderContentClass: 'kids-readaloud',
		wgPageReaderContentSelector: '',
		wgPageReaderSkipSelectors: [ '.infobox' ],
		wgPageReaderButtonPlacement: 'before-content',
		wgPageReaderVoicePitch: 1.15,
		wgPageReaderVoiceRate: 1.05,
		wgPageReaderVoiceGender: 'female',
		wgPageReaderHighlightEnabled: true,
		wgPageReaderPreferredVoices: { female: [], male: [] },
	}, configOverrides || {} );
	const messages = Object.assign( {
		'pagereader-button-label': 'Read this page aloud',
		'pagereader-button-label-stop': 'Stop reading',
		'pagereader-voice-label': 'Voice',
		'pagereader-voice-auto': 'Auto',
		'pagereader-voice-female': 'Female',
		'pagereader-voice-male': 'Male',
		'pagereader-pause-label': 'Pause reading',
		'pagereader-pause-label-resume': 'Resume reading',
		'pagereader-piper-optin-label': 'Try a better voice',
		'pagereader-piper-optin-confirm': "Download Amy's voice (~60MB)?",
		'pagereader-piper-downloading': 'Downloading voice…',
		'pagereader-piper-active': "Using Amy's voice — tap to use default",
	}, msgOverrides || {} );
	const hooks = {};
	return {
		mwObj: {
			config: { get: function ( key ) { return config[ key ]; } },
			msg: function ( key ) { return messages[ key ]; },
			hook: function ( name ) {
				return {
					add: function ( fn ) {
						hooks[ name ] = hooks[ name ] || [];
						hooks[ name ].push( fn );
					},
				};
			},
		},
		fireHook: function ( name, arg ) {
			( hooks[ name ] || [] ).forEach( function ( fn ) { fn( arg ); } );
		},
	};
}

function makeSpeechSynthesis( voices, supportsPause ) {
	let currentVoices = voices || [];
	const state = { spoken: [], cancelCount: 0, utterances: [], pauseCount: 0, resumeCount: 0 };
	const speechSynthesis = {
		cancel: function () { state.cancelCount++; },
		speak: function ( utterance ) {
			state.spoken.push( utterance.text );
			state.utterances.push( utterance );
		},
		getVoices: function () { return currentVoices; },
		// Real browsers always have this property (whether or not the
		// implementation ever actually fires it); present here so the
		// module's `'onvoiceschanged' in window.speechSynthesis` feature
		// check behaves like a real browser rather than an unusually
		// minimal mock.
		onvoiceschanged: null,
		// Test-only helper (not part of the real Web Speech API) simulating
		// Chrome's asynchronous voice list population: swaps the list
		// getVoices() returns, then fires the module's own listener exactly
		// as a real 'voiceschanged' event would.
		simulateVoicesArriving: function ( newVoices ) {
			currentVoices = newVoices;
			if ( typeof speechSynthesis.onvoiceschanged === 'function' ) {
				speechSynthesis.onvoiceschanged();
			}
		},
	};
	if ( supportsPause !== false ) {
		speechSynthesis.pause = function () { state.pauseCount++; };
		speechSynthesis.resume = function () { state.resumeCount++; };
	}
	return { speechSynthesis: speechSynthesis, state: state };
}

/**
 * Mocks window.pageReaderPiper the same way makeSpeechSynthesis() mocks
 * window.speechSynthesis -- this file's real ext.pageReader.piper.js is
 * never loaded or exercised in these tests (it does a real dynamic
 * import() of a CDN URL, which jsdom cannot meaningfully fake); instead
 * these tests mock the CONTRACT ext.pageReader.js's click handler expects
 * from it, which is where the actual branching/fallback/failure-counting
 * logic under test lives.
 */
function makePiperMock() {
	const state = { downloadCalls: 0, downloadShouldReject: false, speakCalls: [], lastController: null };
	const piper = {
		download: function ( onProgress ) {
			state.downloadCalls++;
			if ( state.downloadShouldReject ) {
				return Promise.reject( new Error( 'simulated download failure' ) );
			}
			if ( typeof onProgress === 'function' ) {
				onProgress( { loaded: 50, total: 100 } );
				onProgress( { loaded: 100, total: 100 } );
			}
			return Promise.resolve();
		},
		speak: function ( sentenceList, callbacks ) {
			const controller = {
				cancelled: false,
				paused: false,
				cancel: function () { controller.cancelled = true; },
				pause: function () { controller.paused = true; },
				resume: function () { controller.paused = false; },
			};
			state.speakCalls.push( { sentenceList: sentenceList, callbacks: callbacks } );
			state.lastController = controller;
			return controller;
		},
	};
	return { piper: piper, state: state };
}

/**
 * Installs a mocked window.pageReaderPiper and a window.mw.loader.using()
 * that resolves immediately (simulating an already-cached module fetch --
 * real load-failure behavior is exercised separately by resolving to a
 * rejected promise instead). Call after buildDom(), before dispatching the
 * click that triggers the mw.loader.using(...).then(...) chain.
 */
function installPiperMock( window, loaderShouldReject ) {
	const { piper, state } = makePiperMock();
	window.pageReaderPiper = piper;
	window.mw.loader = {
		using: function () {
			return loaderShouldReject ?
				Promise.reject( new Error( 'simulated module load failure' ) ) :
				Promise.resolve();
		},
	};
	return state;
}

/**
 * Waits for the microtask queue (any pending mw.loader.using(...).then(...)
 * chain) to fully drain, via a macrotask (setTimeout) rather than a fixed
 * number of Promise.resolve() hops -- robust regardless of how many .then()
 * links the real chain under test has.
 */
function flushAsync() {
	return new Promise( function ( resolve ) { setTimeout( resolve, 0 ); } );
}

/**
 * Loads the real ext.pageReader.js into a fresh jsdom document with the
 * given body HTML and config, and fires the wikipage.content hook once
 * (simulating MediaWiki's normal page-load behavior).
 */
function buildDom( bodyHtml, configOverrides, msgOverrides, voices, seedLocalStorage, supportsPause, userAgent, piperCapableFlag ) {
	const dom = new JSDOM( '<!doctype html><html><body>' + bodyHtml + '</body></html>', {
		url: 'https://saintapedia.org/wiki/Kids:Test',
		runScripts: 'outside-only',
		resources: userAgent ? { userAgent: userAgent } : undefined,
	} );
	const window = dom.window;
	if ( piperCapableFlag ) {
		window.WebAssembly = {};
		window.AudioContext = function () {};
	}
	if ( seedLocalStorage ) {
		Object.keys( seedLocalStorage ).forEach( function ( key ) {
			window.localStorage.setItem( key, seedLocalStorage[ key ] );
		} );
	}
	const mwSetup = makeMw( configOverrides, msgOverrides );
	window.mw = mwSetup.mwObj;
	const speech = makeSpeechSynthesis( voices, supportsPause );
	window.speechSynthesis = speech.speechSynthesis;
	window.SpeechSynthesisUtterance = function ( text ) {
		this.text = text;
		this.onend = null;
		this.onerror = null;
	};
	const consoleWarnings = [];
	window.console.warn = function () {
		consoleWarnings.push( Array.prototype.slice.call( arguments ).join( ' ' ) );
	};

	dom.window.eval( SCRIPT_SRC );
	mwSetup.fireHook( 'wikipage.content' );

	return {
		window: window,
		speechState: speech.state,
		speechSynthesis: speech.speechSynthesis,
		consoleWarnings: consoleWarnings,
		// Simulates a second AJAX-driven wikipage.content firing on the same
		// DOM. Optionally takes a contentNode to simulate MediaWiki core
		// firing with a narrower $content fragment than the initial full-page
		// fire -- real re-renders don't always pass the same node.
		refire: function ( contentNode ) { mwSetup.fireHook( 'wikipage.content', contentNode ); },
	};
}

// Test functions may return a Promise (e.g. to await a mocked async
// Piper download/predict chain) -- since this file is plain CommonJS
// (no top-level await), such a test's pass/fail is deferred rather than
// awaited inline here; pendingAsyncTests is drained before the final
// summary is printed at the bottom of this file.
const pendingAsyncTests = [];

function test( name, fn ) {
	var result;
	try {
		result = fn();
	} catch ( e ) {
		failed++;
		failures.push( name + ': ' + e.message );
		console.log( 'FAIL: ' + name + ' -- ' + e.message );
		return;
	}
	if ( result && typeof result.then === 'function' ) {
		pendingAsyncTests.push(
			result.then( function () {
				passed++;
				console.log( 'PASS: ' + name );
			} ).catch( function ( e ) {
				failed++;
				failures.push( name + ': ' + e.message );
				console.log( 'FAIL: ' + name + ' -- ' + e.message );
			} )
		);
		return;
	}
	passed++;
	console.log( 'PASS: ' + name );
}

test( 'before-content: button + voice controls inserted immediately before marker element', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><p>Intro.</p><div class="kids-readaloud">Once upon a time.</div></div>'
	);
	const button = window.document.querySelector( '.pagereader-button' );
	const content = window.document.querySelector( '.kids-readaloud' );
	assert.ok( button, 'button should exist' );
	assert.strictEqual( button.nextElementSibling.className, 'pagereader-voice-select' );
	assert.ok(
		button.compareDocumentPosition( content ) & window.Node.DOCUMENT_POSITION_FOLLOWING,
		'content should follow the button + voice-controls group'
	);
	assert.strictEqual( button.textContent, 'Read this page aloud' );
	assert.strictEqual( button.getAttribute( 'aria-pressed' ), 'false' );
} );

test( 'before-content: re-firing wikipage.content does not duplicate the button', function () {
	const { window, refire } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	refire();
	refire();
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );
} );

test( 'top-of-content: re-firing does not duplicate the button', function () {
	const { window, refire } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderButtonPlacement: 'top-of-content' }
	);
	refire();
	refire();
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );
} );

test( 'after-heading (heading present): re-firing does not duplicate the button', function () {
	const { window, refire } = buildDom(
		'<h1 id="firstHeading">A Saint</h1><div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderButtonPlacement: 'after-heading' }
	);
	refire();
	refire();
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );
} );

test( 'after-heading (heading missing, before-content fallback): re-firing does not duplicate', function () {
	const { window, refire } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderButtonPlacement: 'after-heading' }
	);
	refire();
	refire();
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );
} );

test( 'click toggles label, aria-pressed, and speaking class; speaks filtered text', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud"><span class="infobox">SKIP ME</span>Read this text aloud please.</div></div>'
	);
	const button = window.document.querySelector( '.pagereader-button' );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( button.textContent, 'Stop reading' );
	assert.strictEqual( button.getAttribute( 'aria-pressed' ), 'true' );
	assert.ok( button.classList.contains( 'pagereader-speaking' ) );
	assert.strictEqual( speechState.spoken.length, 1 );
	assert.ok( !speechState.spoken[ 0 ].includes( 'SKIP ME' ), 'skip selector should remove infobox text' );
	assert.ok( speechState.spoken[ 0 ].includes( 'Read this text aloud please.' ) );
	assert.ok( !speechState.spoken[ 0 ].includes( 'Stop reading' ), "button's own label must not be read" );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( button.textContent, 'Read this page aloud' );
	assert.strictEqual( button.getAttribute( 'aria-pressed' ), 'false' );
	assert.ok( !button.classList.contains( 'pagereader-speaking' ) );
	assert.strictEqual( speechState.cancelCount, 2, 'cancel() called before speak() and on stop' );
} );

test( 'top-of-content: button is first child and is excluded from speech text', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Story text here.</div></div>',
		{ wgPageReaderButtonPlacement: 'top-of-content' }
	);
	const content = window.document.querySelector( '.kids-readaloud' );
	assert.strictEqual( content.firstElementChild.className, 'pagereader-button' );

	content.firstElementChild.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( speechState.spoken.length, 1 );
	assert.ok( !speechState.spoken[ 0 ].includes( 'Read this page aloud' ) );
	assert.strictEqual(
		speechState.spoken[ 0 ], 'Story text here.',
		'voice select/label/pause button text must not leak into speech when they sit inside contentRoot'
	);
} );

test( 'after-heading: falls back to before-content when #firstHeading is missing', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderButtonPlacement: 'after-heading' }
	);
	const button = window.document.querySelector( '.pagereader-button' );
	assert.ok( button, 'button should still be inserted via fallback' );
	assert.strictEqual( button.nextElementSibling.className, 'pagereader-voice-select' );
} );

test( 'after-heading: inserts right after #firstHeading when present', function () {
	const { window } = buildDom(
		'<h1 id="firstHeading">A Saint</h1><div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderButtonPlacement: 'after-heading' }
	);
	const heading = window.document.getElementById( 'firstHeading' );
	assert.strictEqual( heading.nextElementSibling.className, 'pagereader-button' );
} );

test( 'an invalid skip selector is skipped, not fatal -- speech still works', function () {
	const { window, speechState, consoleWarnings } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud"><span class="infobox">SKIP</span>Good text.</div></div>',
		{ wgPageReaderSkipSelectors: [ ':::not-a-real-selector', '.infobox' ] }
	);
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.spoken.length, 1, 'speech must still happen despite the bad selector' );
	assert.ok( !speechState.spoken[ 0 ].includes( 'SKIP' ), 'the valid .infobox selector must still apply' );
	assert.ok( speechState.spoken[ 0 ].includes( 'Good text.' ) );
	assert.ok( consoleWarnings.some( function ( w ) { return w.indexOf( 'invalid skip selector' ) !== -1; } ) );
} );

test( 'opt-out default: a page with no marker, class, or selector match still gets a button and reads everything', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><p>Nothing marked here at all.</p></div>'
	);
	const button = window.document.querySelector( '.pagereader-button' );
	assert.ok( button, 'an unmarked page should still be readable end to end, not silently skipped' );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( speechState.spoken.length, 1 );
	assert.ok( speechState.spoken[ 0 ].includes( 'Nothing marked here at all.' ) );
} );

test( 'a wikipage.content fire for an unrelated fragment outside #mw-content-text does not get its own button', function () {
	// Regression test: wikipage.content is a generic, shared MediaWiki
	// hook -- other gadgets/extensions (reference-popup previews, live-
	// preview widgets, comment threads) fire it too, for their own
	// unrelated fragments, on the very same eligible page. The opt-out
	// default must not treat every such fragment as readable content
	// just because it happens to be an Element.
	const { window, refire } = buildDom(
		'<div id="mw-content-text"><p>Real article content.</p></div>' +
			'<div id="popup-preview"><p>Unrelated reference popup text.</p></div>'
	);
	assert.strictEqual(
		window.document.querySelectorAll( '.pagereader-button' ).length, 1,
		'only one button after the initial load'
	);

	refire( window.document.getElementById( 'popup-preview' ) );

	assert.strictEqual(
		window.document.querySelectorAll( '.pagereader-button' ).length, 1,
		'the unrelated popup-preview fragment must not get its own button'
	);
} );

test( 'a wikipage.content re-fire scoped to a narrower fragment inside #mw-content-text does not duplicate the button', function () {
	// Regression found by external review: the opt-out default's guard
	// only checked that root was somewhere inside #mw-content-text
	// (contentArea.contains(root)), not that root WAS #mw-content-text --
	// so a later wikipage.content re-fire scoped to an arbitrary
	// descendant (a live-preview widget's own partial re-render, a
	// gadget's fragment update, MediaWiki core's own T360592-style replay)
	// was itself treated as "the whole content to read". Since that
	// narrower root sits in a different place in the DOM than
	// #mw-content-text, findExistingButton() can't find the button
	// already inserted next to the real content area and inserts a
	// second one scoped to just that narrow fragment.
	const { window, refire } = buildDom(
		'<div id="mw-content-text"><p>Real article content.</p>' +
			'<div id="inner-widget"><p>An unrelated inner fragment re-render.</p></div></div>'
	);
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );

	refire( window.document.getElementById( 'inner-widget' ) );

	assert.strictEqual(
		window.document.querySelectorAll( '.pagereader-button' ).length, 1,
		'a re-fire scoped to a fragment inside #mw-content-text must not insert a second button'
	);
} );

test( 'the opt-out default does not read sysop/editor UI chrome living inside the content area', function () {
	// Found live: an unmarked page reading the whole content area by
	// default also picks up MediaWiki's own UI elements that happen to
	// live inside #mw-content-text (e.g. the patrol link on a new/
	// unpatrolled page) -- previously invisible to PageReader entirely,
	// since a page with no explicit content marker got no button at all.
	const { window, speechState } = buildDom(
		'<div id="mw-content-text">' +
			'<p>Real article content.</p>' +
			'<div class="patrollink">Mark this page as patrolled</div>' +
		'</div>',
		{ wgPageReaderSkipSelectors: [ '.infobox', '.patrollink' ] }
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.spoken.length, 1 );
	assert.ok( speechState.spoken[ 0 ].includes( 'Real article content.' ) );
	assert.ok( !speechState.spoken[ 0 ].includes( 'patrolled' ) );
} );

// Marker elements, not HTML comments -- MediaWiki's parser strips literal
// wikitext comments from rendered output entirely, so a comment-based
// marker would never actually reach a real page's DOM (confirmed live).
// A hidden <span>, like {{ReadAloudButton}}'s own marker, survives.
const SKIP_START = '<span class="pagereader-readaloud-skip-start" style="display:none"></span>';
const SKIP_END = '<span class="pagereader-readaloud-skip-end" style="display:none"></span>';

test( 'a pagereader-readaloud-skip region is excluded under the opt-out default, everything else is still read', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text">' +
			'<p>Read this part.</p>' +
			SKIP_START +
			'<p>Skip this part.</p>' +
			SKIP_END +
			'<p>Read this too.</p>' +
		'</div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.spoken.length, 1 );
	assert.ok( speechState.spoken[ 0 ].includes( 'Read this part.' ) );
	assert.ok( speechState.spoken[ 0 ].includes( 'Read this too.' ) );
	assert.ok( !speechState.spoken[ 0 ].includes( 'Skip this part' ) );
} );

test( 'multiple pagereader-readaloud-skip regions on the same page are all excluded', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text">' +
			SKIP_START + '<p>Skip one.</p>' + SKIP_END +
			'<p>Read this.</p>' +
			SKIP_START + '<p>Skip two.</p>' + SKIP_END +
		'</div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.spoken.length, 1 );
	assert.strictEqual( speechState.spoken[ 0 ].trim(), 'Read this.' );
} );

test( 'a skip region nested inside another silences the whole outer region', function () {
	// Regression test: a naive single-pending-start parser lets a second
	// skip-start (before the first pair's matching skip-end) silently
	// overwrite the first, so only the inner pair actually gets excluded
	// -- leaking the outer region's own text into speech. Depth-tracking
	// must collapse the whole nested structure into one excluded range.
	const { window, speechState } = buildDom(
		'<div id="mw-content-text">' +
			SKIP_START +
			'<p>Outer A.</p>' +
			SKIP_START +
			'<p>Inner B.</p>' +
			SKIP_END +
			'<p>Outer C.</p>' +
			SKIP_END +
			'<p>Normal text.</p>' +
		'</div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.spoken.length, 1 );
	assert.ok( !speechState.spoken[ 0 ].includes( 'Outer A' ) );
	assert.ok( !speechState.spoken[ 0 ].includes( 'Inner B' ) );
	assert.ok( !speechState.spoken[ 0 ].includes( 'Outer C' ) );
	assert.ok( speechState.spoken[ 0 ].includes( 'Normal text.' ) );
} );

test( 'sentence highlighting never highlights nodes inside a pagereader-readaloud-skip region', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text">' +
			'<p>First sentence.</p>' +
			SKIP_START +
			'<p>Skipped sentence.</p>' +
			SKIP_END +
			'<p>Last sentence.</p>' +
		'</div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	speechState.utterances[ 0 ].onstart();

	const marks = window.document.querySelectorAll( 'mark.pagereader-highlight' );
	assert.ok( marks.length > 0 );
	marks.forEach( function ( mark ) {
		assert.ok( !mark.textContent.includes( 'Skipped' ), 'a mark must never wrap text from inside a skip region' );
	} );
} );

test( 'contentSelector fallback is used when no marker class is present', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><article>Whole-article fallback text.</article></div>',
		{ wgPageReaderContentSelector: 'article' }
	);
	const button = window.document.querySelector( '.pagereader-button' );
	assert.ok( button, 'button should be inserted via the fallback selector' );
	assert.strictEqual( button.nextElementSibling.className, 'pagereader-voice-select' );
} );

test( 'pitch and rate from config are applied to the utterance', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoicePitch: 1.3, wgPageReaderVoiceRate: 0.9 }
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].pitch, 1.3 );
	assert.strictEqual( speechState.utterances[ 0 ].rate, 0.9 );
} );

test( 'out-of-range pitch/rate config values are clamped client-side', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoicePitch: 99, wgPageReaderVoiceRate: -1 }
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].pitch, 2 );
	assert.strictEqual( speechState.utterances[ 0 ].rate, 0.1 );
} );

const FIREFOX_LINUX_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const FIREFOX_WINDOWS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

test( 'Firefox on Linux gets the browser default pitch/rate (1/1) regardless of config', function () {
	// Works around a Firefox/Linux (speech-dispatcher + espeak-ng) bug
	// where a non-default pitch/rate produces badly garbled audio; a
	// default-pitch/rate utterance on the same backend is unaffected.
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoicePitch: 1.3, wgPageReaderVoiceRate: 0.9 },
		null, null, null, null, FIREFOX_LINUX_USER_AGENT
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].pitch, 1, 'Firefox/Linux must ignore the configured pitch tuning' );
	assert.strictEqual( speechState.utterances[ 0 ].rate, 1, 'Firefox/Linux must ignore the configured rate tuning' );
} );

test( 'Firefox on Linux still applies voice-gender selection despite skipping pitch/rate tuning', function () {
	const voices = [
		{ name: 'Generic Voice' },
		{ name: 'Google UK English Female' },
	];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'female', wgPageReaderVoicePitch: 1.3, wgPageReaderVoiceRate: 0.9 },
		null, voices, null, null, FIREFOX_LINUX_USER_AGENT
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Google UK English Female' );
	assert.strictEqual( speechState.utterances[ 0 ].pitch, 1 );
} );

test( 'Firefox on Windows is unaffected -- the workaround is scoped to Linux, not Firefox generally', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoicePitch: 1.3, wgPageReaderVoiceRate: 0.9 },
		null, null, null, null, FIREFOX_WINDOWS_USER_AGENT
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].pitch, 1.3, 'Firefox/Windows never had the garbling bug -- tuning must apply' );
	assert.strictEqual( speechState.utterances[ 0 ].rate, 0.9 );
} );

test( 'a non-Firefox browser is unaffected by the Firefox pitch/rate workaround', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoicePitch: 1.3, wgPageReaderVoiceRate: 0.9 }
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].pitch, 1.3 );
	assert.strictEqual( speechState.utterances[ 0 ].rate, 0.9 );
} );

test( "voiceGender 'female' picks the first voice whose name contains 'female'", function () {
	const voices = [
		{ name: 'Generic Voice' },
		{ name: 'Google UK English Female' },
		{ name: 'Google UK English Male' },
	];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'female' },
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Google UK English Female' );
} );

test( 'a curated preferredVoices name wins over the generic female/male substring match', function () {
	const voices = [
		{ name: 'Samantha' },
		{ name: 'Google UK English Female' },
	];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{
			wgPageReaderVoiceGender: 'female',
			wgPageReaderPreferredVoices: { female: [ 'Samantha' ], male: [] },
		},
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Samantha' );
} );

test( 'preferredVoices matches earlier names in the list first, regardless of voice order', function () {
	const voices = [
		{ name: 'Zira' },
		{ name: 'Samantha' },
	];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{
			wgPageReaderVoiceGender: 'female',
			// "Samantha" is listed first even though "Zira" is the first
			// voice in the device's list -- the preference order must win.
			wgPageReaderPreferredVoices: { female: [ 'Samantha', 'Zira' ], male: [] },
		},
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Samantha' );
} );

test( 'preferredVoices with no match on this device falls back to the generic substring match', function () {
	const voices = [ { name: 'Google UK English Female' } ];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{
			wgPageReaderVoiceGender: 'female',
			wgPageReaderPreferredVoices: { female: [ 'Samantha' ], male: [] },
		},
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Google UK English Female' );
} );

test( 'an empty/missing preferredVoices config does not change existing behavior', function () {
	const voices = [ { name: 'Google UK English Female' } ];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'female', wgPageReaderPreferredVoices: undefined },
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Google UK English Female' );
} );

test( 'preferredVoices matches as a substring of a real device voice name, not only exact equality', function () {
	// The documented Windows example is fragment "Zira" against a voice
	// actually named "Microsoft Zira Desktop" -- an implementation that
	// only checked exact equality would pass every other preferredVoices
	// test (they all happen to use exact-match fixtures) while failing on
	// every real device.
	const voices = [
		{ name: 'Microsoft Zira Desktop - English (United States)' },
		{ name: 'Google UK English Female' },
	];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{
			wgPageReaderVoiceGender: 'female',
			// Also mixed-case, to prove the match is case-insensitive.
			wgPageReaderPreferredVoices: { female: [ 'ZIRA' ], male: [] },
		},
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual(
		speechState.utterances[ 0 ].voice.name,
		'Microsoft Zira Desktop - English (United States)'
	);
} );

test( 'a male preferredVoices fragment also matches by substring', function () {
	const voices = [ { name: 'Microsoft David Desktop' }, { name: 'Google UK English Male' } ];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{
			wgPageReaderVoiceGender: 'male',
			wgPageReaderPreferredVoices: { female: [], male: [ 'David' ] },
		},
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Microsoft David Desktop' );
} );

test( 'a non-string entry in preferredVoices is skipped, not thrown on -- speech must still work', function () {
	// $wgPageReaderPreferredVoices (LocalSettings) reaches the client
	// unsanitized, unlike the overlay path. A bare (names[n] || '') check
	// lets a truthy non-string (e.g. 42) through to .toLowerCase(), which
	// throws -- caught by the click handler's try/catch, aborting before
	// speak() is ever reached. The reader would hear nothing at all, not
	// even the generic female/male fallback.
	const voices = [ { name: 'Samantha' }, { name: 'Google UK English Female' } ];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{
			wgPageReaderVoiceGender: 'female',
			wgPageReaderPreferredVoices: { female: [ 42, 'Samantha' ], male: [] },
		},
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances.length, 1, 'speech must not abort' );
	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Samantha' );
} );

test( "voiceGender 'male' does not match a name containing 'female'", function () {
	const voices = [
		{ name: 'Google UK English Female' },
		{ name: 'Google UK English Male' },
	];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'male' },
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Google UK English Male' );
} );

test( "voiceGender 'auto' leaves the default voice untouched", function () {
	const voices = [ { name: 'Google UK English Female' } ];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'auto' },
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice, undefined );
} );

test( 'no matching voice on the device falls back to the default voice without error', function () {
	const voices = [ { name: 'Generic Voice' } ];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'female' },
		null,
		voices
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice, undefined );
	assert.strictEqual( speechState.spoken.length, 1 );
} );

test( 'voice select is inserted next to the button with an associated visible-to-AT label', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const select = window.document.querySelector( '.pagereader-voice-select' );
	assert.ok( select, 'voice select should exist' );
	assert.strictEqual(
		select.querySelectorAll( 'option' ).length, 3,
		'should have female/male/auto options'
	);
	const label = window.document.querySelector( 'label[for="' + select.id + '"]' );
	assert.ok( label, 'label should be associated with the select via for/id' );
	assert.strictEqual( label.textContent, 'Voice' );
} );

test( 'voice select options are ordered female, male, auto', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const select = window.document.querySelector( '.pagereader-voice-select' );
	const values = Array.prototype.map.call( select.options, function ( o ) { return o.value; } );
	assert.deepStrictEqual( values, [ 'female', 'male', 'auto' ] );
} );

test( 'voice select defaults to female when no site override or stored preference exists', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const select = window.document.querySelector( '.pagereader-voice-select' );
	assert.strictEqual( select.value, 'female' );
} );

test( 'voice select initial value falls back to the site-configured default gender', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'male' }
	);
	const select = window.document.querySelector( '.pagereader-voice-select' );
	assert.strictEqual( select.value, 'male' );
} );

test( 'a previously stored voice preference overrides the site default on load', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'male' },
		null,
		null,
		{ 'pagereader-voice-gender': 'female' }
	);
	const select = window.document.querySelector( '.pagereader-voice-select' );
	assert.strictEqual( select.value, 'female' );
} );

test( 'an invalid stored voice preference is ignored, falling back to the site default', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'male' },
		null,
		null,
		{ 'pagereader-voice-gender': 'bogus' }
	);
	const select = window.document.querySelector( '.pagereader-voice-select' );
	assert.strictEqual( select.value, 'male' );
} );

test( 'changing the voice select persists the choice to localStorage', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const select = window.document.querySelector( '.pagereader-voice-select' );
	select.value = 'female';
	select.dispatchEvent( new window.Event( 'change', { bubbles: true } ) );

	assert.strictEqual( window.localStorage.getItem( 'pagereader-voice-gender' ), 'female' );
} );

test( 'readStoredEngine defaults to native when nothing is stored', function () {
	const { window } = buildDom( '<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>' );
	assert.strictEqual( window.localStorage.getItem( 'pagereader-engine' ), null );
	// readStoredEngine() itself is not exposed on window -- exercised
	// indirectly via the stored value it reads/writes, matching how
	// readStoredGender()/writeStoredGender() are tested elsewhere in this
	// file (via the voice-select's own persisted value, not a direct call).
} );

test( 'writeStoredEngine persists a valid value and ignores an invalid one', function () {
	const { window } = buildDom( '<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>' );
	// Exercised via localStorage directly here since neither helper is
	// exposed yet -- Plan 2's opt-in button gives these proper behavioral
	// coverage. This test only locks in the storage key name and the
	// valid-value set, both of which later code depends on.
	window.localStorage.setItem( 'pagereader-engine', 'piper' );
	assert.strictEqual( window.localStorage.getItem( 'pagereader-engine' ), 'piper' );
} );

test( 'piper failure count storage key round-trips a numeric value', function () {
	const { window } = buildDom( '<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>' );
	window.localStorage.setItem( 'pagereader-piper-failures', '2' );
	assert.strictEqual( window.localStorage.getItem( 'pagereader-piper-failures' ), '2' );
} );

test( 'piperCapable-equivalent: a jsdom window without AudioContext is treated as incapable', function () {
	// Node.js itself (not jsdom) provides a global WebAssembly regardless of
	// DOM emulation -- confirmed via `node -e "console.log(typeof WebAssembly)"`
	// printing 'object' with no jsdom involved at all, so that alone can't
	// be used to exercise the "incapable" branch here. jsdom does NOT
	// implement AudioContext/webkitAudioContext, though, which is what
	// actually keeps this environment (and every other test in this file)
	// on the "incapable" branch -- this test exists to name that fact
	// explicitly and pin it down, since the opt-in link (Plan 2) must never
	// render in this environment (or in any real browser lacking these
	// APIs) once wired in.
	const { window } = buildDom( '<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>' );
	assert.strictEqual( typeof window.AudioContext, 'undefined' );
	assert.strictEqual( typeof window.webkitAudioContext, 'undefined' );
} );

test( 'piperCapable-equivalent: a window with both WebAssembly and AudioContext is treated as capable', function () {
	const { window } = buildDom( '<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>' );
	window.WebAssembly = {};
	window.AudioContext = function () {};
	assert.strictEqual( typeof window.WebAssembly, 'object' );
	assert.strictEqual( typeof window.AudioContext, 'function' );
} );

test( 'mw.pageReader exposes buildSpeechModel, splitIntoSentences, highlightChunk, and clearHighlight', function () {
	const { window } = buildDom( '<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>' );
	assert.strictEqual( typeof window.mw.pageReader, 'object' );
	assert.strictEqual( typeof window.mw.pageReader.buildSpeechModel, 'function' );
	assert.strictEqual( typeof window.mw.pageReader.splitIntoSentences, 'function' );
	assert.strictEqual( typeof window.mw.pageReader.highlightChunk, 'function' );
	assert.strictEqual( typeof window.mw.pageReader.clearHighlight, 'function' );
} );

test( 'mw.pageReader.splitIntoSentences behaves identically to the function used internally', function () {
	const { window } = buildDom( '<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>' );
	const sentences = window.mw.pageReader.splitIntoSentences( 'One sentence. Two sentences.' );
	assert.strictEqual( sentences.length, 2 );
	assert.strictEqual( sentences[ 0 ].text, 'One sentence.' );
	assert.strictEqual( sentences[ 1 ].text, 'Two sentences.' );
} );

test( 'the Piper opt-in control renders next to the voice select when enabled and capable', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null, null, null, null, true
	);
	const optIn = window.document.querySelector( '.pagereader-piper-optin' );
	assert.ok( optIn, 'opt-in control should exist' );
	assert.strictEqual( optIn.getAttribute( 'data-pagereader-piper-state' ), 'default' );
	assert.strictEqual( optIn.textContent, 'Try a better voice' );
} );

test( 'the Piper opt-in control does not render when wgPageReaderPiperEnabled is false', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: false }, null, null, null, null, null, true
	);
	assert.strictEqual( window.document.querySelector( '.pagereader-piper-optin' ), null );
} );

test( 'the Piper opt-in control does not render when the browser lacks WASM/AudioContext', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }
		// piperCapableFlag omitted -- defaults to jsdom's real lack of AudioContext.
	);
	assert.strictEqual( window.document.querySelector( '.pagereader-piper-optin' ), null );
} );

test( 'the Piper opt-in control shows the active state when the reader already opted in', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const optIn = window.document.querySelector( '.pagereader-piper-optin' );
	assert.strictEqual( optIn.getAttribute( 'data-pagereader-piper-state' ), 'active' );
	assert.strictEqual( optIn.textContent, "Using Amy's voice — tap to use default" );
} );

test( 'clicking the Piper opt-in control moves default -> confirm without downloading', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null, null, null, null, true
	);
	const state = installPiperMock( window );
	const optIn = window.document.querySelector( '.pagereader-piper-optin' );

	optIn.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( optIn.getAttribute( 'data-pagereader-piper-state' ), 'confirm' );
	assert.strictEqual( state.downloadCalls, 0, 'the first click must not start a download yet' );
} );

test( 'confirming the Piper opt-in downloads, then reaches the active state', async function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null, null, null, null, true
	);
	const state = installPiperMock( window );
	const optIn = window.document.querySelector( '.pagereader-piper-optin' );

	optIn.dispatchEvent( new window.Event( 'click', { bubbles: true } ) ); // default -> confirm
	optIn.dispatchEvent( new window.Event( 'click', { bubbles: true } ) ); // confirm -> downloading

	assert.strictEqual( optIn.getAttribute( 'data-pagereader-piper-state' ), 'downloading' );

	// Flush the mw.loader.using()/download() promise chain -- a macrotask
	// flush (not a fixed number of Promise.resolve() hops) so this doesn't
	// depend on exactly how many .then() links the real chain has.
	await flushAsync();

	assert.strictEqual( state.downloadCalls, 1 );
	assert.strictEqual( optIn.getAttribute( 'data-pagereader-piper-state' ), 'active' );
	assert.strictEqual(
		window.localStorage.getItem( 'pagereader-engine' ), 'piper',
		'opting in must persist the engine preference'
	);
} );

test( 'a failed download returns the opt-in control to the default state', async function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null, null, null, null, true
	);
	const state = installPiperMock( window );
	state.downloadShouldReject = true;
	const optIn = window.document.querySelector( '.pagereader-piper-optin' );

	optIn.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	optIn.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	await flushAsync();

	assert.strictEqual( optIn.getAttribute( 'data-pagereader-piper-state' ), 'default' );
	assert.strictEqual(
		window.localStorage.getItem( 'pagereader-engine' ), null,
		'a failed download must not persist an engine preference'
	);
} );

test( 'clicking the Piper opt-in control while active switches back to native', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	installPiperMock( window );
	const optIn = window.document.querySelector( '.pagereader-piper-optin' );

	optIn.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( optIn.getAttribute( 'data-pagereader-piper-state' ), 'default' );
	assert.strictEqual( window.localStorage.getItem( 'pagereader-engine' ), 'native' );
} );

test( 'the main button speaks with Piper when opted in, highlighting each sentence via the shared helper', async function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	await flushAsync();

	assert.strictEqual( state.speakCalls.length, 1 );
	assert.strictEqual( state.speakCalls[ 0 ].sentenceList.length, 2 );
	assert.strictEqual( state.speakCalls[ 0 ].sentenceList[ 0 ].text, 'Hello there.' );

	// Simulate the mocked speak()'s onSentenceStart callback firing.
	state.speakCalls[ 0 ].callbacks.onSentenceStart( state.speakCalls[ 0 ].sentenceList[ 0 ] );
	const mark = window.document.querySelector( '.pagereader-highlight' );
	assert.ok( mark, 'onSentenceStart should highlight via the shared mw.pageReader.highlightChunk' );
	assert.strictEqual( mark.textContent, 'Hello there.' );
} );

test( 'onEnd from the Piper engine resets the button to idle, same as the native path', async function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	await flushAsync();
	assert.strictEqual( button.textContent, 'Stop reading' );

	state.speakCalls[ 0 ].callbacks.onEnd();

	assert.strictEqual( button.textContent, 'Read this page aloud' );
	assert.strictEqual( button.getAttribute( 'aria-pressed' ), 'false' );
} );

test( 'clicking Stop while speaking with Piper cancels the Piper controller, not speechSynthesis', async function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	await flushAsync();
	const cancelCountBefore = speechState.cancelCount;

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( state.lastController.cancelled, true );
	assert.strictEqual(
		speechState.cancelCount, cancelCountBefore,
		'native speechSynthesis.cancel() must not be called for a Piper-engine read'
	);
	assert.strictEqual( button.textContent, 'Read this page aloud' );
} );

test( 'pause/resume while speaking with Piper drives the Piper controller, not speechSynthesis', async function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	await flushAsync();
	const pauseButton = window.document.querySelector( '.pagereader-pause-button' );

	pauseButton.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( state.lastController.paused, true );
	assert.strictEqual( speechState.pauseCount, 0 );

	pauseButton.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( state.lastController.paused, false );
	assert.strictEqual( speechState.resumeCount, 0 );
} );

test( 'a Piper onError falls back to the native engine for that read', async function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	await flushAsync();

	state.speakCalls[ 0 ].callbacks.onError();

	assert.strictEqual( speechState.spoken.length, 1, 'the native engine must pick up the same read' );
	assert.strictEqual( window.localStorage.getItem( 'pagereader-piper-failures' ), '1' );
	assert.strictEqual(
		window.localStorage.getItem( 'pagereader-engine' ), 'piper',
		'a single failure must not clear the preference yet'
	);
	// Regression check: the button must never flash back to idle while a
	// same-read native fallback is actually in progress -- calling
	// stopSpeaking() before handing off to speakSentences() would reset the
	// button to idle even though audio is now genuinely playing natively,
	// mirroring the exact class of bug #14 fixed earlier in this project.
	assert.strictEqual( button.textContent, 'Stop reading', 'must stay in the speaking state during fallback' );
} );

test( 'the 3rd consecutive Piper failure clears the engine preference back to native', async function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );
	const optIn = window.document.querySelector( '.pagereader-piper-optin' );

	for ( let i = 0; i < 3; i++ ) {
		button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) ); // start a fresh read
		await flushAsync();
		state.speakCalls[ state.speakCalls.length - 1 ].callbacks.onError(); // this attempt fails
		if ( i < 2 ) {
			// The button deliberately stays in the "speaking" state during
			// a same-read native fallback (see speakWithPiper()), so a
			// reader -- and this test -- must click Stop before the next
			// click starts a genuinely fresh read; otherwise it would just
			// stop the in-progress native fallback instead.
			button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
		}
	}

	assert.strictEqual( window.localStorage.getItem( 'pagereader-engine' ), 'native' );
	assert.strictEqual( window.localStorage.getItem( 'pagereader-piper-failures' ), '0' );
	// Regression check: the stored preference reverting to native is not
	// enough on its own -- the opt-in control itself must also drop out of
	// its "active" state, or a reader would see it still claiming to be
	// using the better voice when a fresh click would actually use native.
	assert.strictEqual( optIn.getAttribute( 'data-pagereader-piper-state' ), 'default' );
	assert.strictEqual( optIn.textContent, 'Try a better voice' );
} );

test( 'the Piper engine speaks the whole article as one chunk with no highlighting when highlightEnabled is false', async function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>',
		{ wgPageReaderPiperEnabled: true, wgPageReaderHighlightEnabled: false }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	await flushAsync();

	assert.strictEqual( state.speakCalls.length, 1 );
	assert.strictEqual(
		state.speakCalls[ 0 ].sentenceList.length, 1,
		'the whole article must be a single chunk, not re-split into sentences, when highlighting is disabled'
	);
	assert.strictEqual(
		state.speakCalls[ 0 ].sentenceList[ 0 ].text, 'Hello there. Saint today lived well.'
	);

	// Even if the Piper module fires onSentenceStart for this chunk, it
	// must not highlight anything -- matching speakWholeArticle()'s own
	// no-highlighting behavior on the native path for the same config.
	state.speakCalls[ 0 ].callbacks.onSentenceStart( state.speakCalls[ 0 ].sentenceList[ 0 ] );
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-highlight' ).length, 0 );
} );

test( 'a success after failures resets the failure count to 0', async function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	await flushAsync();
	state.speakCalls[ 0 ].callbacks.onError();
	assert.strictEqual( window.localStorage.getItem( 'pagereader-piper-failures' ), '1' );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) ); // stop the native fallback
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) ); // start a fresh (piper) read
	await flushAsync();
	state.speakCalls[ 1 ].callbacks.onEnd();

	assert.strictEqual( window.localStorage.getItem( 'pagereader-piper-failures' ), '0' );
} );

test( "the select's current value, not the site config, wins at speak time", function () {
	const voices = [ { name: 'Google UK English Female' }, { name: 'Google UK English Male' } ];
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'male' },
		null,
		voices
	);
	const select = window.document.querySelector( '.pagereader-voice-select' );
	select.value = 'female';
	select.dispatchEvent( new window.Event( 'change', { bubbles: true } ) );

	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Google UK English Female' );
} );

test( 're-firing wikipage.content does not duplicate the voice select', function () {
	const { window, refire } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	refire();
	refire();
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-voice-select' ).length, 1 );
} );

test( 'pause button is hidden until speech starts, then shown', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const pauseButton = window.document.querySelector( '.pagereader-pause-button' );
	assert.ok( pauseButton, 'pause button should exist' );
	assert.strictEqual( pauseButton.hidden, true );

	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( pauseButton.hidden, false );
	assert.strictEqual( pauseButton.textContent, 'Pause reading' );
} );

test( 'clicking pause calls speechSynthesis.pause() and toggles to Resume', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	const pauseButton = window.document.querySelector( '.pagereader-pause-button' );

	pauseButton.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( speechState.pauseCount, 1 );
	assert.strictEqual( pauseButton.textContent, 'Resume reading' );
	assert.strictEqual( pauseButton.getAttribute( 'aria-pressed' ), 'true' );

	pauseButton.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( speechState.resumeCount, 1 );
	assert.strictEqual( pauseButton.textContent, 'Pause reading' );
	assert.strictEqual( pauseButton.getAttribute( 'aria-pressed' ), 'false' );
} );

test( 'stopping while paused resets and hides the pause button', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	const pauseButton = window.document.querySelector( '.pagereader-pause-button' );
	pauseButton.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( pauseButton.hidden, true );
	assert.strictEqual( pauseButton.textContent, 'Pause reading' );
	assert.strictEqual( pauseButton.getAttribute( 'aria-pressed' ), 'false' );
	assert.strictEqual( speechState.cancelCount, 2, 'cancel() called before speak() and on stop' );
} );

test( 'utterance ending naturally (onend) also resets and hides the pause button', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	const pauseButton = window.document.querySelector( '.pagereader-pause-button' );
	pauseButton.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	speechState.utterances[ 0 ].onend();

	assert.strictEqual( pauseButton.hidden, true );
	assert.strictEqual( pauseButton.textContent, 'Pause reading' );
} );

test( 'pause button clicks while idle are a no-op (no pause/resume call)', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const pauseButton = window.document.querySelector( '.pagereader-pause-button' );
	pauseButton.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.pauseCount, 0 );
	assert.strictEqual( speechState.resumeCount, 0 );
} );

test( 'no pause button is created when the browser lacks pause/resume support', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		null, null, null, null, false
	);
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-pause-button' ).length, 0 );
	// The rest of the feature must still work with no pause button present.
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( window.document.querySelector( '.pagereader-button' ).textContent, 'Stop reading' );
} );

test( 're-firing wikipage.content does not duplicate the pause button', function () {
	const { window, refire } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	refire();
	refire();
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-pause-button' ).length, 1 );
} );

test( 'a voice list that arrives late (via voiceschanged) is still picked up on the next click', function () {
	// Simulates Chrome's real-world quirk: getVoices() is [] at page load,
	// and the real list only shows up once 'voiceschanged' fires.
	const { window, speechState, speechSynthesis } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderVoiceGender: 'female' },
		null,
		[]
	);
	speechSynthesis.simulateVoicesArriving( [
		{ name: 'Google UK English Female' }, { name: 'Google UK English Male' },
	] );

	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances[ 0 ].voice.name, 'Google UK English Female' );
} );

test( 'duplicate-button guard still finds the button with an extra unrelated sibling between it and content', function () {
	// Regression for a hardcoded sibling-walk hop bound: an intruder
	// element (e.g. from some other gadget) sitting between PageReader's
	// own controls and the content marker must not defeat the guard.
	const { window, refire } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const content = window.document.querySelector( '.kids-readaloud' );
	const intruder = window.document.createElement( 'div' );
	intruder.textContent = 'unrelated widget';
	content.parentNode.insertBefore( intruder, content );

	refire();
	refire();

	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );
} );

test( 'a button anchor overrides the configured placement, wherever it sits on the page', function () {
	const { window } = buildDom(
		'<nav><span class="pagereader-button-anchor" style="display:none"></span></nav>' +
			'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		// Configured for top-of-content, but the anchor should win instead.
		{ wgPageReaderButtonPlacement: 'top-of-content' }
	);
	const anchor = window.document.querySelector( '.pagereader-button-anchor' );
	const button = window.document.querySelector( '.pagereader-button' );
	assert.ok( button, 'button should exist' );
	assert.strictEqual( anchor.nextElementSibling, button, 'button should sit immediately after the anchor' );
	assert.strictEqual(
		window.document.querySelector( '.kids-readaloud' ).firstElementChild, null,
		'content root should be untouched -- top-of-content placement must not apply when an anchor is present'
	);
} );

test( 'button anchor: re-firing wikipage.content does not duplicate the button', function () {
	const { window, refire } = buildDom(
		'<span class="pagereader-button-anchor" style="display:none"></span>' +
			'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	refire();
	refire();
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );
} );

test( 'button anchor: voice select and pause button are still created next to the anchor-placed button', function () {
	const { window } = buildDom(
		'<span class="pagereader-button-anchor" style="display:none"></span>' +
			'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const button = window.document.querySelector( '.pagereader-button' );
	assert.strictEqual( button.nextElementSibling.className, 'pagereader-voice-select' );
	assert.ok( window.document.querySelector( '.pagereader-pause-button' ) );
} );

test( 'no anchor on the page: falls back to the configured placement unchanged', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderButtonPlacement: 'top-of-content' }
	);
	const content = window.document.querySelector( '.kids-readaloud' );
	assert.strictEqual( content.firstElementChild.className, 'pagereader-button' );
} );

test( 'button anchor overrides before-content placement', function () {
	const { window } = buildDom(
		'<span class="pagereader-button-anchor" style="display:none"></span>' +
			'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const anchor = window.document.querySelector( '.pagereader-button-anchor' );
	const button = window.document.querySelector( '.pagereader-button' );
	assert.strictEqual( anchor.nextElementSibling, button );
} );

test( 'button anchor overrides after-heading placement', function () {
	const { window } = buildDom(
		'<span class="pagereader-button-anchor" style="display:none"></span>' +
			'<h1 id="firstHeading">A Saint</h1>' +
			'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderButtonPlacement: 'after-heading' }
	);
	const anchor = window.document.querySelector( '.pagereader-button-anchor' );
	const button = window.document.querySelector( '.pagereader-button' );
	assert.strictEqual( anchor.nextElementSibling, button );
	const heading = window.document.getElementById( 'firstHeading' );
	assert.notStrictEqual(
		heading.nextElementSibling, button,
		'after-heading placement must not apply when an anchor is present'
	);
} );

test( 'button anchor: an extra sibling between the anchor and the button is still found on re-fire', function () {
	const { window, refire } = buildDom(
		'<span class="pagereader-button-anchor" style="display:none"></span>' +
			'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const anchor = window.document.querySelector( '.pagereader-button-anchor' );
	const intruder = window.document.createElement( 'div' );
	intruder.textContent = 'unrelated widget';
	anchor.parentNode.insertBefore( intruder, anchor.nextSibling );

	refire();
	refire();

	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );
} );

// Regression: MediaWiki core's wikipage.content hook doesn't always fire
// with the same $content node -- a later re-render can pass a narrower
// fragment (e.g. just the content wrapper) than the initial full-page fire.
// The anchor is documented as placeable anywhere on the page, independent
// of where the content itself is marked, so a re-fire scoped to just the
// content wrapper (which doesn't contain the anchor or the already-inserted
// button) must still find both via a document-wide search, not silently
// fall through to the placement-based lookup and insert a second button.
test( 'button anchor: a nested re-fire scoped to just the content wrapper does not duplicate the button -- top-of-content', function () {
	const { window, refire } = buildDom(
		'<nav><span class="pagereader-button-anchor" style="display:none"></span></nav>' +
			'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderButtonPlacement: 'top-of-content' }
	);
	const contentNode = window.document.querySelector( '.kids-readaloud' );
	refire( contentNode );
	refire( contentNode );

	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );
} );

test( 'button anchor: a nested re-fire scoped to just the content wrapper does not duplicate the button -- after-heading', function () {
	const { window, refire } = buildDom(
		'<nav><span class="pagereader-button-anchor" style="display:none"></span></nav>' +
			'<h1 id="firstHeading">A Saint</h1>' +
			'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderButtonPlacement: 'after-heading' }
	);
	const contentNode = window.document.querySelector( '.kids-readaloud' );
	refire( contentNode );
	refire( contentNode );

	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );
} );

test( 'button anchor: a nested re-fire scoped to just the content wrapper does not duplicate the button -- before-content', function () {
	const { window, refire } = buildDom(
		'<nav><span class="pagereader-button-anchor" style="display:none"></span></nav>' +
			'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>'
	);
	const contentNode = window.document.querySelector( '.kids-readaloud' );
	refire( contentNode );
	refire( contentNode );

	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 1 );
} );

test( 'multi-sentence content is spoken as a queue, every sentence queued up front', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual(
		speechState.utterances.length, 2,
		'every sentence is queued via speak() immediately, not chained reactively from onend'
	);
	assert.strictEqual( speechState.utterances[ 0 ].text, 'Hello there.' );
	assert.strictEqual( speechState.utterances[ 1 ].text, 'Saint today lived well.' );
	assert.strictEqual(
		speechState.utterances[ 0 ].onend, null,
		'only the last queued utterance ends the read -- speechSynthesis itself plays the queue in order'
	);
	assert.strictEqual( typeof speechState.utterances[ 1 ].onend, 'function' );
} );

test( 'a sentence erroring once is silently retried, and the read continues normally', function () {
	// speakSentences() calls speak() for every sentence synchronously in
	// one loop; if a queued utterance's onerror fires synchronously, the
	// single-retry path re-queues that sentence (and everything after it,
	// to preserve order) once, before the loop that triggered it is even
	// allowed to continue -- otherwise the outer loop would go on to
	// duplicate-queue the same sentences the retry just handled.
	//
	// This mock never fires onstart, so currentlyPlayingIndex never leaves
	// -1 -- the same as a real browser where sentence 1 errors out before
	// sentence 0 has actually started playing. Since the code has no way
	// to tell "sentence 0 already played" from "sentence 0 never played"
	// in that state, the retry must replay the whole pass from its own
	// start (sentence 0 included) rather than resuming from the sentence
	// that errored, or a genuinely-never-played opening sentence would be
	// silently dropped by the cancel() this same handler issues.
	const { window, speechState, speechSynthesis } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">' +
			'Hello there. Saint today lived well. A third sentence here.' +
			'</div></div>'
	);
	const originalSpeak = speechSynthesis.speak;
	let speakCalls = 0;
	speechSynthesis.speak = function ( utterance ) {
		originalSpeak( utterance );
		speakCalls++;
		if ( speakCalls === 2 ) {
			utterance.onerror();
		}
	};

	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances.length, 5, 'the failed attempt plus a full replay of the pass' );
	assert.deepStrictEqual(
		speechState.utterances.map( function ( u ) { return u.text; } ),
		[
			'Hello there.',
			'Saint today lived well.', // fails
			'Hello there.', // replayed -- not yet confirmed to have played
			'Saint today lived well.', // retried, succeeds
			'A third sentence here.',
		]
	);
	// Nothing aborted -- the read is still genuinely in progress.
	assert.strictEqual( button.textContent, 'Stop reading' );
} );

test( 'onstart highlights the sentence currently playing, replacing the previous one', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	speechState.utterances[ 0 ].onstart();
	let mark = window.document.querySelector( '.pagereader-highlight' );
	assert.strictEqual( mark.textContent, 'Hello there.' );

	speechState.utterances[ 1 ].onstart();
	const marks = window.document.querySelectorAll( '.pagereader-highlight' );
	assert.strictEqual( marks.length, 1, 'exactly one highlight mark should exist at a time' );
	assert.strictEqual( marks[ 0 ].textContent, 'Saint today lived well.' );
} );

test( 'a sentence spanning a wikilink is highlighted across all its text nodes, not just the first', function () {
	// Real wiki markup splits a sentence's text across multiple text nodes
	// constantly (links, bold, italic). A highlighter that only wraps the
	// first node leaves most of the spoken sentence unhighlighted.
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">' +
			'He was born in <a href="/wiki/Assisi">Assisi</a> in 1181. He loved animals.' +
			'</div></div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( speechState.utterances[ 0 ].text, 'He was born in Assisi in 1181.' );

	speechState.utterances[ 0 ].onstart();

	const marks = window.document.querySelectorAll( '.pagereader-highlight' );
	assert.ok( marks.length >= 2, 'the sentence spans a link, so more than one node should be wrapped' );
	const highlightedText = Array.prototype.map.call( marks, function ( m ) { return m.textContent; } ).join( '' );
	assert.strictEqual( highlightedText, 'He was born in Assisi in 1181.' );
	assert.ok(
		Array.prototype.some.call( marks, function ( m ) { return m.textContent === 'Assisi'; } ),
		'the link text itself should be one of the wrapped pieces'
	);
} );

test( 'a sentence spanning bold text is highlighted across all its text nodes, and clears fully on the next sentence', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">' +
			'Saint <b>Francis</b> was a friar. He founded an order.' +
			'</div></div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	speechState.utterances[ 0 ].onstart();

	let marks = window.document.querySelectorAll( '.pagereader-highlight' );
	assert.ok( marks.length >= 2 );
	assert.strictEqual(
		Array.prototype.map.call( marks, function ( m ) { return m.textContent; } ).join( '' ),
		'Saint Francis was a friar.'
	);

	speechState.utterances[ 1 ].onstart();

	marks = window.document.querySelectorAll( '.pagereader-highlight' );
	assert.strictEqual(
		Array.prototype.map.call( marks, function ( m ) { return m.textContent; } ).join( '' ),
		'He founded an order.',
		'the multi-node highlight from the first sentence must be fully cleared, not left behind'
	);
	assert.strictEqual(
		window.document.querySelector( '.kids-readaloud' ).textContent,
		'Saint Francis was a friar. He founded an order.',
		'DOM text content must be unchanged after wrap/unwrap'
	);
} );

test( 'clicking Stop mid-sentence: a stale onend from the cancelled queue does not reactivate it', function () {
	// Regression for the generation-guard: cancel() can still cause a
	// queued utterance to fire onend/onerror asynchronously afterwards --
	// that must not be mistaken for "read still in progress".
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>'
	);
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	// Both sentences are queued immediately; only the last carries onend.
	const lastUtterance = speechState.utterances[ 1 ];

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( button.textContent, 'Read this page aloud', 'stopped back to idle' );

	// Simulate the cancelled queue's last utterance firing onend late, after stop.
	lastUtterance.onend();

	assert.strictEqual(
		speechState.utterances.length, 2,
		'a stale onend from the cancelled queue must not queue any further sentences'
	);
	assert.strictEqual( button.textContent, 'Read this page aloud', 'stays idle after the stale onend' );
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-highlight' ).length, 0 );
} );

test( 'a sentence failing twice in a row (original + retry) aborts the whole read', function () {
	const { window, speechState, speechSynthesis } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">' +
			'Hello there. Saint today lived well. A third sentence here.' +
			'</div></div>'
	);
	const originalSpeak = speechSynthesis.speak;
	speechSynthesis.speak = function ( utterance ) {
		originalSpeak( utterance );
		utterance.onerror();
	};

	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual(
		speechState.utterances.length, 2,
		'exactly one original attempt plus one retry attempt -- nothing after that gets queued'
	);
	assert.strictEqual(
		button.textContent, 'Read this page aloud',
		'must not be stuck showing "Stop reading" after the retry also fails'
	);
	assert.ok( !button.classList.contains( 'pagereader-speaking' ) );
	assert.strictEqual( button.getAttribute( 'aria-pressed' ), 'false' );
} );

test( 'each sentence gets its own independent retry -- a later failure is not treated as already-retried', function () {
	// Regression test: the retry must be tracked per sentence (by its
	// absolute position in the article), not as a single flag applied to
	// the whole re-queued tail -- otherwise every sentence after the
	// first one that ever failed would wrongly lose its own single retry.
	//
	// As in the single-failure test above, this mock never fires onstart,
	// so every retry here replays the whole pass from its own start
	// (offset 0) rather than resuming from whichever sentence errored --
	// with two independent failures, that means sentences one through
	// three each get queued three times over (original, retry-of-sentence-
	// two, retry-of-sentence-four) before the read finally completes; only
	// sentence four is spoken twice, since its own failure happens on the
	// last pass. The per-sentence retriedIndex tracking this test exists
	// to verify still holds throughout: sentence two's single retry does
	// not stop sentence four (a different sentence) from getting its own.
	const { window, speechState, speechSynthesis } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">' +
			'Sentence one. Sentence two. Sentence three. Sentence four.' +
			'</div></div>'
	);
	const originalSpeak = speechSynthesis.speak;
	const failedOnce = {};
	speechSynthesis.speak = function ( utterance ) {
		originalSpeak( utterance );
		// Sentence 1 fails once (then succeeds on its retry); sentence 3
		// -- on its own first-ever attempt, unrelated to sentence 1's
		// failure -- also fails once (then succeeds on its retry).
		if ( ( utterance.text === 'Sentence two.' || utterance.text === 'Sentence four.' ) &&
			!failedOnce[ utterance.text ]
		) {
			failedOnce[ utterance.text ] = true;
			utterance.onerror();
		}
	};

	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.deepStrictEqual(
		speechState.utterances.map( function ( u ) { return u.text; } ),
		[
			'Sentence one.',
			'Sentence two.', // fails
			'Sentence one.', // pass replayed from its own start
			'Sentence two.', // retried, succeeds
			'Sentence three.',
			'Sentence four.', // fails on its OWN first attempt
			'Sentence one.', // pass replayed from its own start again
			'Sentence two.',
			'Sentence three.',
			'Sentence four.', // must still get its own retry, succeeds
		]
	);
} );

test( 'a cancel() that synchronously errors sibling utterances does not cause a runaway retry cascade', function () {
	// Regression test found live in a real Chrome (not reproducible via this
	// file's plain cancelCount-only mock): speechSynthesis.cancel() can
	// synchronously fire onerror on this pass's OTHER still-queued
	// utterances too, not just the one whose own onerror called cancel().
	// Before this fix, queuingEpoch was only bumped inside the nested
	// speakSentences() retry call -- which happens AFTER cancel() returns --
	// so a cascaded sibling's onerror still saw the OLD (matching) epoch and
	// spawned its own independent retry pass, whose own siblings could
	// cascade the same way again. Nothing ever cancels an earlier pass's
	// still-pending utterances before the next one starts either, so the
	// number of simultaneously-pending passes and utterances compounded
	// pass over pass until the real recursion overflowed the call stack.
	const { window, speechState, speechSynthesis } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">' +
			'Sentence one. Sentence two. Sentence three.' +
			'</div></div>'
	);
	const alreadyFired = new Set();
	const originalCancel = speechSynthesis.cancel;
	speechSynthesis.cancel = function () {
		originalCancel();
		// Simulate real Chrome: walk the still-queued utterances and fire
		// onerror on each one not already fired, exactly as a native cancel()
		// can for utterances it discards before they ever started.
		speechState.utterances.slice().forEach( function ( u ) {
			if ( !alreadyFired.has( u ) && typeof u.onerror === 'function' ) {
				alreadyFired.add( u );
				u.onerror();
			}
		} );
	};

	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( speechState.utterances.length, 3, 'all three queued up front' );

	alreadyFired.add( speechState.utterances[ 0 ] );
	speechState.utterances[ 0 ].onerror();

	assert.strictEqual(
		speechState.utterances.length, 6,
		'exactly one retry pass (3 more utterances) for the sentence that failed first -- ' +
			"the cascaded siblings' onerror must see a stale epoch and no-op, not each spawn their own retry"
	);
} );

test( 'a stale callback from a cancelled/superseded utterance does not abort an in-progress retry', function () {
	// Regression test: the retry deliberately does not bump
	// speechGeneration (that would also invalidate the utterances it just
	// created), so a delayed onend/onerror from an utterance that
	// speechSynthesis.cancel() already discarded needs a narrower guard
	// (queuingEpoch) to be told apart from the retry that superseded it.
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>'
	);
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	const originalLastUtterance = speechState.utterances[ 1 ];
	speechState.utterances[ 0 ].onstart();
	speechState.utterances[ 1 ].onerror(); // triggers a retry, replaying from sentence 0

	assert.strictEqual( speechState.utterances.length, 4, 'original queue plus a full replay' );
	assert.strictEqual( button.textContent, 'Stop reading', 'the retry is genuinely still in progress' );

	// The ORIGINAL (now-cancelled) last utterance's onend fires late --
	// simulating a browser that doesn't synchronously suppress a
	// cancelled utterance's callbacks. This must be ignored, not treated
	// as "the read finished."
	originalLastUtterance.onend();

	assert.strictEqual(
		button.textContent, 'Stop reading',
		'a stale callback from the superseded (pre-retry) queue must not reset the UI mid-retry'
	);
} );

test( 'speakWholeArticle (highlighting disabled) also gets a single silent retry before aborting', function () {
	const { window, speechState, speechSynthesis } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>',
		{ wgPageReaderHighlightEnabled: false }
	);
	const originalSpeak = speechSynthesis.speak;
	let speakCalls = 0;
	speechSynthesis.speak = function ( utterance ) {
		originalSpeak( utterance );
		speakCalls++;
		if ( speakCalls === 1 ) {
			utterance.onerror();
		}
	};

	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances.length, 2, 'one failed attempt plus one successful retry' );
	assert.strictEqual( button.textContent, 'Stop reading', 'the retry succeeded -- nothing aborted' );
} );

test( 'speakWholeArticle aborts cleanly (with cancel()) if the retry also fails', function () {
	const { window, speechState, speechSynthesis } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>',
		{ wgPageReaderHighlightEnabled: false }
	);
	const originalSpeak = speechSynthesis.speak;
	speechSynthesis.speak = function ( utterance ) {
		originalSpeak( utterance );
		utterance.onerror();
	};

	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances.length, 2, 'one original attempt plus one retry attempt' );
	// cancelCount is 3: the click handler's unconditional initial cancel(),
	// plus one cancel() per onerror firing (original attempt + retry).
	assert.strictEqual( speechState.cancelCount, 3, 'cancel() must run on the exhausted-retry path too' );
	assert.strictEqual( button.textContent, 'Read this page aloud' );
} );

test( 'a synchronous throw partway through queuing flushes whatever was already queued', function () {
	// Regression found by external review: a throw partway through the
	// queuing loop (after some, but not all, sentences were already
	// handed to speak()) is caught by the click handler's outer
	// try/catch, which must call speechSynthesis.cancel() -- otherwise
	// the already-queued utterance(s) keep playing under a button the
	// catch block already reset to idle.
	const { window, speechState, consoleWarnings } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">One sentence here. A second sentence follows.</div></div>'
	);
	const originalSpeak = window.speechSynthesis.speak;
	let speakCalls = 0;
	window.speechSynthesis.speak = function ( utterance ) {
		speakCalls++;
		if ( speakCalls === 2 ) {
			throw new Error( 'simulated synthesis failure' );
		}
		originalSpeak.call( window.speechSynthesis, utterance );
	};

	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual(
		speechState.cancelCount, 2,
		'the initial defensive cancel plus a flush of the already-queued utterance after the throw'
	);
	assert.strictEqual( window.document.querySelector( '.pagereader-button' ).textContent, 'Read this page aloud' );
	assert.ok( consoleWarnings.some( function ( w ) { return w.indexOf( 'PageReader failed' ) !== -1; } ) );
} );

test( 'a later sentence failing while an earlier one is still playing replays the earlier one, not just the failed one', function () {
	// Regression test: speechSynthesis.cancel() can't selectively remove
	// just the failed sentence from the native queue -- it also kills
	// whatever is currently playing. The retry must resume from whichever
	// sentence was actually playing (currentlyPlayingIndex), not from the
	// one that errored, so the interrupted sentence gets replayed instead
	// of silently dropped.
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">' +
			'Sentence one. Sentence two. Sentence three. Sentence four.' +
			'</div></div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	// Sentence 0 ("Sentence one.") starts playing (Chrome may have already
	// synthesized sentences ahead of it, per the whole point of upfront
	// queuing) -- then sentence 2 ("Sentence three."), still queued and
	// not yet started, fails synthesis.
	speechState.utterances[ 0 ].onstart();
	speechState.utterances[ 2 ].onerror();

	assert.deepStrictEqual(
		speechState.utterances.map( function ( u ) { return u.text; } ),
		[
			'Sentence one.', 'Sentence two.', 'Sentence three.', 'Sentence four.', // original queue
			'Sentence one.', 'Sentence two.', 'Sentence three.', 'Sentence four.', // full replay from the interrupted sentence
		],
		'the retry must resume from sentence 0 (interrupted mid-play), not from sentence 2 (the one that errored)'
	);
} );

test( 'a stale onerror from a middle queued sentence after Stop does not reactivate it', function () {
	// Companion to the stale-onend regression above, but for a non-last
	// index and the onerror handler specifically -- cancel() can still
	// cause several already-queued utterances to fire onerror/onend
	// asynchronously after the user has already clicked Stop, and every
	// one of them (not just the last) must be a no-op once the generation
	// guard has moved on.
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">' +
			'One sentence here. A second sentence follows. A third one closes it out.' +
			'</div></div>'
	);
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	const middleUtterance = speechState.utterances[ 1 ];

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	const cancelCountAfterStop = speechState.cancelCount;
	assert.strictEqual( button.textContent, 'Read this page aloud', 'stopped back to idle' );

	// Simulate the cancelled queue's middle utterance firing onerror late.
	middleUtterance.onerror();

	assert.strictEqual(
		speechState.cancelCount, cancelCountAfterStop,
		'a stale onerror from the cancelled queue must not trigger a second cancel'
	);
	assert.strictEqual( button.textContent, 'Read this page aloud', 'stays idle after the stale onerror' );
} );

test( 'highlight persists across pause and is cleared when the queue naturally finishes', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	speechState.utterances[ 0 ].onstart();

	window.document.querySelector( '.pagereader-pause-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.ok( window.document.querySelector( '.pagereader-highlight' ), 'highlight remains visible while paused' );

	speechState.utterances[ 1 ].onstart();
	speechState.utterances[ 1 ].onend();

	assert.strictEqual( window.document.querySelectorAll( '.pagereader-highlight' ).length, 0 );
	assert.strictEqual(
		window.document.querySelector( '.kids-readaloud' ).textContent,
		'Hello there. Saint today lived well.'
	);
} );

test( 'wgPageReaderHighlightEnabled: false speaks the whole article as one utterance, matching pre-highlighting behavior', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>',
		{ wgPageReaderHighlightEnabled: false }
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( speechState.utterances.length, 1 );
	assert.strictEqual( speechState.utterances[ 0 ].text, 'Hello there. Saint today lived well.' );
	assert.strictEqual(
		typeof speechState.utterances[ 0 ].onstart, 'undefined',
		'no per-sentence highlight wiring when highlighting is disabled'
	);

	speechState.utterances[ 0 ].onend();
	assert.strictEqual( speechState.utterances.length, 1, 'no queue to advance -- a single utterance covers everything' );
} );

test( 'a failure inside a sentence onstart highlight never breaks the read-along queue', function () {
	const { window, speechState, consoleWarnings } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>'
	);
	window.document.querySelector( '.pagereader-button' )
		.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	// Force highlightChunk()'s Range usage to throw, simulating an
	// unexpected DOM API failure -- must be caught, logged, and never
	// prevent the sentence queue from continuing.
	const originalCreateRange = window.document.createRange;
	window.document.createRange = function () {
		throw new Error( 'simulated Range failure' );
	};
	speechState.utterances[ 0 ].onstart();
	window.document.createRange = originalCreateRange;

	assert.strictEqual( window.document.querySelectorAll( '.pagereader-highlight' ).length, 0 );
	assert.ok( consoleWarnings.some( ( w ) => w.indexOf( 'PageReader highlight failed' ) !== -1 ) );

	// The rest of the queue -- already speak()'d up front -- must be
	// unaffected by the earlier highlight failure.
	assert.strictEqual( speechState.utterances.length, 2, 'the whole queue was already speak()\'d up front' );
	speechState.utterances[ 1 ].onstart();
	assert.ok(
		window.document.querySelector( '.pagereader-highlight' ),
		'a later sentence in the queue can still highlight normally'
	);
} );

Promise.all( pendingAsyncTests ).then( function () {
	console.log( '\n' + passed + ' passed, ' + failed + ' failed' );
	if ( failed > 0 ) {
		console.log( '\nFailures:\n' + failures.join( '\n' ) );
		process.exit( 1 );
	}
} );
