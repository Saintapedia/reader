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
	}, configOverrides || {} );
	const messages = Object.assign( {
		'pagereader-button-label': 'Read this page aloud',
		'pagereader-button-label-stop': 'Stop reading',
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

function makeSpeechSynthesis() {
	const state = { spoken: [], cancelCount: 0 };
	const speechSynthesis = {
		cancel: function () { state.cancelCount++; },
		speak: function ( utterance ) { state.spoken.push( utterance.text ); },
	};
	return { speechSynthesis: speechSynthesis, state: state };
}

/**
 * Loads the real ext.pageReader.js into a fresh jsdom document with the
 * given body HTML and config, and fires the wikipage.content hook once
 * (simulating MediaWiki's normal page-load behavior).
 */
function buildDom( bodyHtml, configOverrides, msgOverrides ) {
	const dom = new JSDOM( '<!doctype html><html><body>' + bodyHtml + '</body></html>', {
		url: 'https://saintapedia.org/wiki/Kids:Test',
		runScripts: 'outside-only',
	} );
	const window = dom.window;
	const mwSetup = makeMw( configOverrides, msgOverrides );
	window.mw = mwSetup.mwObj;
	const speech = makeSpeechSynthesis();
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

test( 'before-content: button inserted immediately before marker element', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><p>Intro.</p><div class="kids-readaloud">Once upon a time.</div></div>'
	);
	const button = window.document.querySelector( '.pagereader-button' );
	assert.ok( button, 'button should exist' );
	assert.strictEqual( button.nextElementSibling.className, 'kids-readaloud' );
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
	assert.ok( speechState.spoken[ 0 ].includes( 'Story text here.' ) );
} );

test( 'after-heading: falls back to before-content when #firstHeading is missing', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderButtonPlacement: 'after-heading' }
	);
	const button = window.document.querySelector( '.pagereader-button' );
	assert.ok( button, 'button should still be inserted via fallback' );
	assert.strictEqual( button.nextElementSibling.className, 'kids-readaloud' );
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
	assert.strictEqual( button.nextElementSibling.tagName, 'ARTICLE' );
} );

console.log( '\n' + passed + ' passed, ' + failed + ' failed' );
if ( failed > 0 ) {
	console.log( '\nFailures:\n' + failures.join( '\n' ) );
	process.exit( 1 );
}
