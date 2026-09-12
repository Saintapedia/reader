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
		wgPageReaderVoiceGender: 'auto',
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
 * Loads the real ext.pageReader.js into a fresh jsdom document with the
 * given body HTML and config, and fires the wikipage.content hook once
 * (simulating MediaWiki's normal page-load behavior).
 */
function buildDom( bodyHtml, configOverrides, msgOverrides, voices, seedLocalStorage, supportsPause ) {
	const dom = new JSDOM( '<!doctype html><html><body>' + bodyHtml + '</body></html>', {
		url: 'https://saintapedia.org/wiki/Kids:Test',
		runScripts: 'outside-only',
	} );
	const window = dom.window;
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
		// Simulates a second AJAX-driven wikipage.content firing on the same DOM.
		refire: function () { mwSetup.fireHook( 'wikipage.content' ); },
	};
}

function test( name, fn ) {
	try {
		fn();
		passed++;
		console.log( 'PASS: ' + name );
	} catch ( e ) {
		failed++;
		failures.push( name + ': ' + e.message );
		console.log( 'FAIL: ' + name + ' -- ' + e.message );
	}
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

test( 'no content root found: no button inserted, no error thrown', function () {
	const { window } = buildDom( '<div id="mw-content-text"><p>Nothing marked here.</p></div>' );
	assert.strictEqual( window.document.querySelectorAll( '.pagereader-button' ).length, 0 );
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
		'should have auto/female/male options'
	);
	const label = window.document.querySelector( 'label[for="' + select.id + '"]' );
	assert.ok( label, 'label should be associated with the select via for/id' );
	assert.strictEqual( label.textContent, 'Voice' );
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

console.log( '\n' + passed + ' passed, ' + failed + ' failed' );
if ( failed > 0 ) {
	console.log( '\nFailures:\n' + failures.join( '\n' ) );
	process.exit( 1 );
}
