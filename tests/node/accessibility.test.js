'use strict';
/**
 * Accessibility checks for the PageReader button, covering what DEPLOY.md's
 * accessibility checklist can't verify without a real browser or screen
 * reader:
 *
 *  - Structural/ARIA correctness (axe-core, scanned against a jsdom DOM in
 *    both the idle and "speaking" button states).
 *  - WCAG 2 AA color contrast for every button color combination, computed
 *    directly from the literal hex values in ext.pageReader.css (jsdom has
 *    no rendering/layout engine, so axe-core's own color-contrast rule
 *    can't run reliably here -- it's excluded below in favor of this exact
 *    calculation, which is actually more precise since the colors are
 *    static, not computed).
 *
 * What this does NOT cover, and still needs a real pass: VoiceOver/JAWS
 * manual testing (see DEPLOY.md's accessibility checklist).
 *
 * Run: node tests/node/accessibility.test.js (after `npm install`)
 */
const fs = require( 'fs' );
const path = require( 'path' );
const assert = require( 'assert' );
const { JSDOM } = require( 'jsdom' );

const RESOURCES_DIR = path.resolve( __dirname, '../../resources' );
const SCRIPT_SRC = fs.readFileSync( path.join( RESOURCES_DIR, 'ext.pageReader.js' ), 'utf8' );
const CSS_SRC = fs.readFileSync( path.join( RESOURCES_DIR, 'ext.pageReader.css' ), 'utf8' );
const AXE_SRC = fs.readFileSync(
	require.resolve( 'axe-core/axe.min.js' ),
	'utf8'
);

let passed = 0;
let failed = 0;
const failures = [];

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

async function asyncTest( name, fn ) {
	try {
		await fn();
		passed++;
		console.log( 'PASS: ' + name );
	} catch ( e ) {
		failed++;
		failures.push( name + ': ' + e.message );
		console.log( 'FAIL: ' + name + ' -- ' + e.message );
	}
}

// --- WCAG 2 contrast ratio, computed from literal hex values ---

function hexToRgb( hex ) {
	hex = hex.replace( '#', '' );
	return [ 0, 2, 4 ].map( ( i ) => parseInt( hex.substr( i, 2 ), 16 ) );
}

function relLuminance( [ r, g, b ] ) {
	const [ rs, gs, bs ] = [ r, g, b ].map( ( c ) => {
		c = c / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );
	} );
	return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio( hex1, hex2 ) {
	const l1 = relLuminance( hexToRgb( hex1 ) );
	const l2 = relLuminance( hexToRgb( hex2 ) );
	const [ lighter, darker ] = l1 > l2 ? [ l1, l2 ] : [ l2, l1 ];
	return ( lighter + 0.05 ) / ( darker + 0.05 );
}

// --- Extract the actual colors from ext.pageReader.css, not hardcoded
// duplicates -- so this test tracks the real file instead of silently
// going stale if the CSS changes.
//
// Each selector pattern is anchored with \s*\{ immediately after, which
// naturally disambiguates ".pagereader-button" from
// ".pagereader-button:hover" / ".pagereader-button.pagereader-speaking"
// (a colon or second class name sits between "button" and the brace in
// those, not whitespace). .match() (non-global) returns the first/leftmost
// match, which is the real rule -- not the @media print block's later
// `.pagereader-button { display: none !important; }` override, which has
// no background/color of its own anyway. ---

function extractRuleBody( css, selectorPattern ) {
	const re = new RegExp( selectorPattern + '\\s*\\{([^}]*)\\}' );
	const m = css.match( re );
	return m ? m[ 1 ] : null;
}

function findHex( body, property ) {
	const re = new RegExp( property + '\\s*:[^;]*?(#[0-9A-Fa-f]{6})' );
	const m = body && body.match( re );
	return m ? m[ 1 ] : null;
}

const idleBody = extractRuleBody( CSS_SRC, '\\.pagereader-button' );
const hoverBody = extractRuleBody( CSS_SRC, '\\.pagereader-button:hover' );
const focusBody = extractRuleBody( CSS_SRC, '\\.pagereader-button:focus-visible' );
const speakingBody = extractRuleBody( CSS_SRC, '\\.pagereader-button\\.pagereader-speaking' );

const idleBackground = findHex( idleBody, 'background' );
const idleText = findHex( idleBody, 'color' );
const hoverBackground = findHex( hoverBody, 'background' );
const focusOutline = findHex( focusBody, 'outline' );
const speakingBackground = findHex( speakingBody, 'background' );
const speakingText = findHex( speakingBody, 'color' );

test( 'CSS color extraction found all expected declarations', function () {
	assert.ok( idleBackground, 'idle background not found in .pagereader-button' );
	assert.ok( idleText, 'idle text color not found in .pagereader-button' );
	assert.ok( hoverBackground, 'hover background not found in .pagereader-button:hover' );
	assert.ok( focusOutline, 'focus outline color not found in .pagereader-button:focus-visible' );
	assert.ok( speakingBackground, 'speaking background not found in .pagereader-button.pagereader-speaking' );
	assert.ok( speakingText, 'speaking text color not found in .pagereader-button.pagereader-speaking' );
} );

// WCAG 2 AA: 4.5:1 for text, 3:1 for non-text UI components (1.4.11).
// The button label is ~1.05em / 700 weight, not unambiguously "large text"
// by WCAG's 18pt/14pt-bold threshold, so held to the stricter 4.5:1.
test( 'idle state: button text meets WCAG AA text contrast (>= 4.5:1)', function () {
	const ratio = contrastRatio( idleText, idleBackground );
	assert.ok( ratio >= 4.5, `ratio was ${ratio.toFixed( 2 )}:1 (text ${idleText} on background ${idleBackground})` );
} );

test( 'hover state: button text meets WCAG AA text contrast (>= 4.5:1)', function () {
	const ratio = contrastRatio( idleText, hoverBackground );
	assert.ok( ratio >= 4.5, `ratio was ${ratio.toFixed( 2 )}:1 (text ${idleText} on background ${hoverBackground})` );
} );

test( 'speaking state: button text meets WCAG AA text contrast (>= 4.5:1)', function () {
	const ratio = contrastRatio( speakingText, speakingBackground );
	assert.ok( ratio >= 4.5, `ratio was ${ratio.toFixed( 2 )}:1 (text ${speakingText} on background ${speakingBackground})` );
} );

test( 'focus outline meets WCAG AA non-text UI contrast (>= 3:1) against idle background', function () {
	const ratio = contrastRatio( focusOutline, idleBackground );
	assert.ok( ratio >= 3.0, `ratio was ${ratio.toFixed( 2 )}:1 (outline ${focusOutline} on background ${idleBackground})` );
} );

// --- axe-core structural/ARIA scan (idle + speaking states) ---

function makeMw( configOverrides ) {
	const config = Object.assign( {
		wgPageReaderContentClass: 'kids-readaloud',
		wgPageReaderContentSelector: '',
		wgPageReaderSkipSelectors: [ '.infobox' ],
		wgPageReaderButtonPlacement: 'before-content',
	}, configOverrides || {} );
	const messages = {
		'pagereader-button-label': 'Read this page aloud',
		'pagereader-button-label-stop': 'Stop reading',
	};
	const hooks = {};
	return {
		mwObj: {
			config: { get: ( k ) => config[ k ] },
			msg: ( k ) => messages[ k ],
			hook: ( name ) => ( {
				add: ( fn ) => { ( hooks[ name ] = hooks[ name ] || [] ).push( fn ); },
			} ),
		},
		fireHook: ( name ) => ( hooks[ name ] || [] ).forEach( ( fn ) => fn() ),
	};
}

function buildPage() {
	const dom = new JSDOM(
		`<!doctype html><html lang="en"><head><title>Kids: Test</title></head><body>
		<main>
		<h1 id="firstHeading">A Saint</h1>
		<div id="mw-content-text">
		<p>Intro paragraph.</p>
		<div class="kids-readaloud">Once upon a time, a kind saint helped many people.</div>
		</div>
		</main>
		</body></html>`,
		{ url: 'https://saintapedia.org/wiki/Kids:Test', runScripts: 'outside-only' }
	);
	const window = dom.window;
	const mwSetup = makeMw();
	window.mw = mwSetup.mwObj;
	window.speechSynthesis = { cancel: () => {}, speak: () => {} };
	window.SpeechSynthesisUtterance = function ( text ) { this.text = text; };
	window.eval( SCRIPT_SRC );
	mwSetup.fireHook( 'wikipage.content' );
	return window;
}

function runAxe( window, contextSelector ) {
	window.eval( AXE_SRC );
	return new Promise( ( resolve, reject ) => {
		window.axe.run(
			window.document.querySelector( contextSelector ),
			{
				resultTypes: [ 'violations' ],
				// color-contrast is handled above via exact calculation --
				// jsdom has no layout/rendering engine, so axe's own
				// canvas-sampling implementation of this rule can't run
				// reliably and would only ever report "incomplete" here.
				rules: { 'color-contrast': { enabled: false } },
			},
			( err, results ) => ( err ? reject( err ) : resolve( results ) )
		);
	} );
}

asyncTest( 'axe-core: no violations in idle state', async () => {
	const window = buildPage();
	const results = await runAxe( window, '#mw-content-text' );
	assert.strictEqual(
		results.violations.length, 0,
		results.violations.map( ( v ) => `${v.id}: ${v.description}` ).join( '; ' )
	);
} ).then( () => {
	return asyncTest( 'axe-core: no violations in speaking state', async () => {
		const window = buildPage();
		window.document.querySelector( '.pagereader-button' )
			.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
		const results = await runAxe( window, '#mw-content-text' );
		assert.strictEqual(
			results.violations.length, 0,
			results.violations.map( ( v ) => `${v.id}: ${v.description}` ).join( '; ' )
		);
	} );
} ).then( () => {
	console.log( '\n' + passed + ' passed, ' + failed + ' failed' );
	if ( failed > 0 ) {
		console.log( '\nFailures:\n' + failures.join( '\n' ) );
		process.exit( 1 );
	}
} );
