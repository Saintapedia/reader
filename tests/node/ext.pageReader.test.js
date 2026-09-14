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
function buildDom( bodyHtml, configOverrides, msgOverrides, voices, seedLocalStorage, supportsPause, userAgent ) {
	const dom = new JSDOM( '<!doctype html><html><body>' + bodyHtml + '</body></html>', {
		url: 'https://saintapedia.org/wiki/Kids:Test',
		runScripts: 'outside-only',
		resources: userAgent ? { userAgent: userAgent } : undefined,
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
		// Simulates a second AJAX-driven wikipage.content firing on the same
		// DOM. Optionally takes a contentNode to simulate MediaWiki core
		// firing with a narrower $content fragment than the initial full-page
		// fire -- real re-renders don't always pass the same node.
		refire: function ( contentNode ) { mwSetup.fireHook( 'wikipage.content', contentNode ); },
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

	// The 2nd speak() call (sentence 1, "Saint today lived well.") errors
	// and is retried: sentence 0 already succeeded and is not re-spoken,
	// but sentence 1's retry and sentence 2 are both re-queued fresh, in
	// order, with no duplicates and no gap.
	assert.strictEqual( speechState.utterances.length, 4, 'one failed attempt plus 3 successful ones' );
	assert.deepStrictEqual(
		speechState.utterances.map( function ( u ) { return u.text; } ),
		[ 'Hello there.', 'Saint today lived well.', 'Saint today lived well.', 'A third sentence here.' ]
	);
	// Nothing aborted -- the read is still genuinely in progress.
	assert.strictEqual( button.textContent, 'Stop reading' );
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
			'Sentence two.', // retried, succeeds
			'Sentence three.',
			'Sentence four.', // fails on its OWN first attempt
			'Sentence four.', // must still get its own retry, succeeds
		]
	);
} );

test( "speakWholeArticle (highlighting disabled) also gets a single silent retry before aborting", function () {
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

test( 'speak() throwing mid-queue is caught and still cancels whatever was already queued', function () {
	// Regression test: the outer catch around the whole click handler must
	// call speechSynthesis.cancel() before stopSpeaking(), same as every
	// other error-recovery path here -- stopSpeaking() alone only drops
	// the JS-side queuedUtterances reference, it does not stop the browser
	// from playing whatever it was already handed via speak().
	const { window, speechState, speechSynthesis } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>'
	);
	const originalSpeak = speechSynthesis.speak;
	let speakCalls = 0;
	speechSynthesis.speak = function ( utterance ) {
		speakCalls++;
		if ( speakCalls === 2 ) {
			throw new Error( 'simulated speak() failure, e.g. a stale voice object' );
		}
		originalSpeak( utterance );
	};

	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	// cancelCount is 2, not 1: the click handler already calls cancel()
	// once unconditionally before building the queue; this asserts the
	// catch block's own cancel() call also ran.
	assert.strictEqual( speechState.cancelCount, 2, 'cancel() must run as part of catching the thrown error' );
	assert.strictEqual( button.textContent, 'Read this page aloud' );
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

console.log( '\n' + passed + ' passed, ' + failed + ' failed' );
if ( failed > 0 ) {
	console.log( '\nFailures:\n' + failures.join( '\n' ) );
	process.exit( 1 );
}
