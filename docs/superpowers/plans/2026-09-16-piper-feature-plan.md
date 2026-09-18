# Piper Voice Option (Plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the actual opt-in Piper voice: a "Try a better voice" control, a lazily-loaded engine module wrapping `@mintplex-labs/piper-tts-web`, and the click-handler wiring that lets a reader who's opted in hear Amy's voice instead of their browser's native one — with a guaranteed fallback to native on any failure.

**Architecture:** `resources/ext.pageReader.piper.js` is a new, separate ResourceLoader module — never loaded until a reader opts in — that dynamically imports the pinned Piper library build from jsdelivr and exposes exactly two functions on `window.pageReaderPiper`: `download(onProgress)` and `speak(sentenceList, callbacks)`. It does **not** reuse the native engine's `speakSentences`/`queueSentence`/retry machinery at all — that machinery exists specifically to work around real browser-native-queue quirks (Chrome's synthesize-ahead behavior, `cancel()` cascading to sibling utterances) that simply don't exist when PageReader is driving its own `<audio>` elements one at a time. Instead, the Piper engine gets its own much simpler sequential player, and the two engines are unified only at the orchestration level: both report `onSentenceStart`/`onEnd`/`onError` through the same shape, and both reuse Plan 1's exposed `mw.pageReader.highlightChunk`/`clearHighlight`/`buildSpeechModel`/`splitIntoSentences` so highlighting behavior is identical regardless of which engine is speaking.

**Tech Stack:** vanilla JS (jsdom behavioral tests via `npm test`), `@mintplex-labs/piper-tts-web@1.0.5` (MIT-licensed, loaded from jsdelivr at runtime, never installed as an npm dependency of this repo).

**Spec:** `docs/superpowers/specs/2026-09-16-piper-voice-option-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-16-piper-foundation-plan.md` (Plan 1) must be merged first — this plan calls `readStoredEngine`, `writeStoredEngine`, `readPiperFailureCount`, `writePiperFailureCount`, `piperCapable`, and `mw.pageReader.*`, all added there.

## Global Constraints

- Pinned CDN URL (do not change without a deliberate version-bump PR): `https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js`
- Voice ID (single launch voice, per spec §3): `en_US-amy-medium`
- Every Piper-path failure falls back to the native engine for that read — never a broken button, never a silent hang (spec §8).
- The saved engine preference is cleared after **3** consecutive Piper failures (spec §8), resetting to 0 on any success.
- `resources/ext.pageReader.piper.js` itself (the real dynamic `import()` and real Piper library interaction) is **not** unit-testable in jsdom — that's explicit in the spec (§10) and not a gap to try to paper over with a fake test. All the risk that jsdom *can* usefully catch (state machine correctness, fallback branching, failure counting) lives in `ext.pageReader.js`'s own click-handler code, tested there with `window.pageReaderPiper` mocked exactly the way `window.speechSynthesis` already is.

---

### Task 1: The `ext.pageReader.piper` module

**Files:**
- Create: `resources/ext.pageReader.piper.js`
- Modify: `extension.json`

**Interfaces:**
- Produces: `window.pageReaderPiper.download( onProgress )` → `Promise<void>` (resolves once the voice model is cached in OPFS; `onProgress` is called zero or more times with `{ loaded, total }` in bytes). `window.pageReaderPiper.speak( sentenceList, callbacks )` → returns `{ cancel(), pause(), resume() }`; `sentenceList` is the same `{text, start, end}[]` shape `mw.pageReader.splitIntoSentences()` (Plan 1) produces; `callbacks` is `{ onSentenceStart(sentence), onEnd(), onError() }`.

- [ ] **Step 1: Register the ResourceModule**

In `extension.json`, inside `"ResourceModules"`, add a new entry after `"ext.pageReader"`:

```json
		"ext.pageReader.piper": {
			"scripts": [ "resources/ext.pageReader.piper.js" ]
		}
```

- [ ] **Step 2: Write the module**

Create `resources/ext.pageReader.piper.js`:

```javascript
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
```

- [ ] **Step 3: Verify the JSON is valid and the JS has no syntax errors**

Run: `python3 -c "import json; json.load(open('extension.json'))"` — expected: no output.
Run: `node --check resources/ext.pageReader.piper.js` — expected: no output (success).

- [ ] **Step 4: Sanity-check the pinned CDN URL still resolves**

Run: `curl -sI 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js' | head -1`
Expected: `HTTP/2 200`. (This was verified once already during spec research; re-verify here since real time has passed and this step is cheap.)

- [ ] **Step 5: Commit**

```bash
git add extension.json resources/ext.pageReader.piper.js
git commit -m "Add the ext.pageReader.piper module"
```

---

### Task 2: i18n messages for the opt-in UI

**Files:**
- Modify: `i18n/en.json`
- Modify: `i18n/qqq.json`
- Modify: `extension.json`

- [ ] **Step 1: Add the message keys**

In `i18n/en.json`, add after `"pagereader-pause-label-resume": "Resume reading"` (add a trailing comma to that line):

```json
	"pagereader-piper-optin-label": "Try a better voice",
	"pagereader-piper-optin-confirm": "Download Amy's voice (~60MB)?",
	"pagereader-piper-downloading": "Downloading voice…",
	"pagereader-piper-active": "Using Amy's voice — tap to use default"
```

In `i18n/qqq.json`, add the matching documentation entries after `"pagereader-pause-label-resume": "..."`:

```json
	"pagereader-piper-optin-label": "Label on the button that lets a reader opt into a higher-quality client-side voice, before they've clicked it.",
	"pagereader-piper-optin-confirm": "Label shown after the first click on the opt-in button, asking the reader to confirm the ~60MB download by clicking again. {{doc-important|Approximate size of the en_US-amy-medium Piper voice model in megabytes; update if the pinned voice/version changes.}}",
	"pagereader-piper-downloading": "Label shown on the opt-in button while the voice model is downloading. Progress percentage is appended by JS, not part of this message.",
	"pagereader-piper-active": "Label on the opt-in button once the reader has opted into the better voice, offering to switch back to the default (native) voice."
```

- [ ] **Step 2: Register the messages with the `ext.pageReader` module**

In `extension.json`, in `"ResourceModules"` → `"ext.pageReader"` → `"messages"`, add after `"pagereader-pause-label-resume"`:

```json
				"pagereader-piper-optin-label",
				"pagereader-piper-optin-confirm",
				"pagereader-piper-downloading",
				"pagereader-piper-active"
```

- [ ] **Step 3: Verify JSON validity**

Run: `for f in i18n/en.json i18n/qqq.json extension.json; do python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" || echo "INVALID: $f"; done`
Expected: no `INVALID` output.

- [ ] **Step 4: Commit**

```bash
git add i18n/en.json i18n/qqq.json extension.json
git commit -m "Add i18n messages for the Piper opt-in UI"
```

---

### Task 3: The opt-in control — creation and rendering

**Files:**
- Modify: `resources/ext.pageReader.js`
- Test: `tests/node/ext.pageReader.test.js`

**Interfaces:**
- Produces: `createPiperOptIn()` → `HTMLButtonElement|null` (null when `!mw.config.get('wgPageReaderPiperEnabled')` or `!piperCapable()`); `findPiperOptIn(button)` → the opt-in element or `null`; `setPiperOptInState(optIn, state)` where `state` is one of `'default'`, `'confirm'`, `'downloading'`, `'active'`, setting both `textContent` and a `data-pagereader-piper-state` attribute.

- [ ] **Step 1: Write the failing tests**

Add to `tests/node/ext.pageReader.test.js`, after the `mw.pageReader` exposure tests from Plan 1's Task 6:

```javascript
test( 'the Piper opt-in control renders next to the voice select when enabled and capable', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }
	);
	window.WebAssembly = {};
	window.AudioContext = function () {};
	// The control is created at module-init time (inside createControls()),
	// so re-firing the content hook is needed to pick up the capability
	// globals set just above, matching how this file's other capability-
	// dependent tests (e.g. the pause-button-support tests) already work.
	const { refire } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }
	);
	assert.ok( true ); // placeholder replaced in Step 3 once the real fixture exists
} );
```

> This first draft is intentionally incomplete — `buildDom()` doesn't yet support pre-setting `window.WebAssembly`/`window.AudioContext` before the script under test evaluates, since `piperCapable()` is checked at *module-init time* (inside `createControls()`, called synchronously when `wikipage.content` fires during `buildDom()` itself), not lazily on click. Fix this properly in the next step rather than leaving the placeholder.

- [ ] **Step 2: Extend `buildDom()` to support capability injection**

In `tests/node/ext.pageReader.test.js`, `buildDom()`'s signature currently ends `...supportsPause, userAgent )`. Add one more parameter, `piperCapable`, and use it right after the `dom` is constructed but before `dom.window.eval( SCRIPT_SRC )` (search for that exact line):

```javascript
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
```

(This inserts the two new lines and the changed function signature; everything else in the function body is unchanged.)

- [ ] **Step 3: Rewrite the test using the new parameter**

Replace the placeholder test from Step 1 with:

```javascript
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
		// piperCapableFlag omitted -- defaults to jsdom's real lack of WebAssembly/AudioContext.
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm run test:behavior`
Expected: FAIL — `optIn` is `null` in the first and fourth tests (the element doesn't exist yet).

- [ ] **Step 5: Implement `createPiperOptIn` and `setPiperOptInState`**

In `resources/ext.pageReader.js`, add immediately after `createPauseButton()` (ends around line 455, right before `function createControls() {`):

```javascript
	// One persistent button cycling through 4 states, rather than a
	// separate confirm popover -- matches this file's existing style of a
	// single element whose label/state changes (see the pause button
	// above) instead of introducing new hidden/shown DOM structure.
	function createPiperOptIn() {
		if ( !mw.config.get( 'wgPageReaderPiperEnabled' ) || !piperCapable() ) {
			return null;
		}
		var optIn = document.createElement( 'button' );
		optIn.setAttribute( 'type', 'button' );
		optIn.className = 'pagereader-piper-optin';
		return optIn;
	}

	function setPiperOptInState( optIn, state ) {
		optIn.setAttribute( 'data-pagereader-piper-state', state );
		optIn.disabled = state === 'downloading';
		if ( state === 'confirm' ) {
			optIn.textContent = mw.msg( 'pagereader-piper-optin-confirm' );
		} else if ( state === 'downloading' ) {
			optIn.textContent = mw.msg( 'pagereader-piper-downloading' );
		} else if ( state === 'active' ) {
			optIn.textContent = mw.msg( 'pagereader-piper-active' );
		} else {
			optIn.textContent = mw.msg( 'pagereader-piper-optin-label' );
		}
	}
```

In the same file, in `createControls()` (currently ends with `return fragment;` around line 498), insert the opt-in control into the fragment. Add this right before the existing `var pauseButton = createPauseButton();` line:

```javascript
		var piperOptIn = createPiperOptIn();
		if ( piperOptIn ) {
			setPiperOptInState( piperOptIn, readStoredEngine() === 'piper' ? 'active' : 'default' );
			fragment.appendChild( piperOptIn );
		}

```

Add `findPiperOptIn` right after `findPauseButton` (around line 522):

```javascript
	function findPiperOptIn( button ) {
		return findFollowingSibling( button, 'pagereader-piper-optin' );
	}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:behavior`
Expected: PASS.

- [ ] **Step 7: Run the full suite to confirm no regression**

Run: `npm test`
Expected: all prior tests still pass, plus these 4 new ones.

- [ ] **Step 8: Commit**

```bash
git add resources/ext.pageReader.js tests/node/ext.pageReader.test.js
git commit -m "Add the Piper opt-in control's creation and state rendering"
```

---

### Task 4: Test-harness support for mocking `window.pageReaderPiper` and `mw.loader`

**Files:**
- Test: `tests/node/ext.pageReader.test.js`

**Interfaces:**
- Produces: a `makePiperMock()` helper, matching the existing `makeSpeechSynthesis()` helper's shape — returns `{ piper, state }` where `state.downloadCalls`, `state.speakCalls` (array of `{ sentenceList, callbacks }`), and `state.lastController` are inspectable by tests.

- [ ] **Step 1: Add the mock factory**

In `tests/node/ext.pageReader.test.js`, add immediately after `makeSpeechSynthesis()` (ends around line 100, right before the `buildDom` JSDoc comment):

```javascript
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
```

- [ ] **Step 2: Verify no syntax errors**

Run: `node --check tests/node/ext.pageReader.test.js`
Expected: no output.

- [ ] **Step 3: Run the full suite to confirm nothing broke (no new tests call these yet)**

Run: `npm test`
Expected: all pass, same count as end of Task 3.

- [ ] **Step 4: Commit**

```bash
git add tests/node/ext.pageReader.test.js
git commit -m "Add Piper mock helpers to the test harness"
```

---

### Task 5: The opt-in button's click handler (confirm → download → active)

**Files:**
- Modify: `resources/ext.pageReader.js`
- Test: `tests/node/ext.pageReader.test.js`

Since `Promise` resolution is asynchronous, tests in this task use `async`/`await` around a `Promise.resolve().then(...)` flush, matching the pattern already needed for any async assertion in this file — check the top of the file for whether `test()` already supports async test functions before writing these.

- [ ] **Step 1: Check async test support and extend if needed**

Run: `grep -n "function test(" tests/node/ext.pageReader.test.js`

Read the `test()` function definition (around line 149). If it does not already `await` the return value of `fn()`, update it to support async test functions:

```javascript
async function test( name, fn ) {
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
```

And confirm every call site of `test(...)` in the file is either awaited or that the file's overall execution model tolerates fire-and-forget async tests (check how `passed`/`failed`/summary printing happens at the bottom of the file — if it prints a summary synchronously right after the last `test(...)` call, async tests won't have finished yet, and the runner needs converting to await each `test()` call in sequence, or collecting all test promises and `Promise.all`-ing them before printing the summary). Make whatever minimal change is needed so the final printed pass/fail count is accurate; this is infrastructure the remaining steps in this task depend on being correct.

- [ ] **Step 2: Run the full suite to confirm the async infrastructure change didn't break anything**

Run: `npm test`
Expected: same pass count as before, 0 failures.

- [ ] **Step 3: Commit the infrastructure change on its own**

```bash
git add tests/node/ext.pageReader.test.js
git commit -m "Support async test functions in the JS test harness"
```

- [ ] **Step 4: Write the failing tests**

Add to `tests/node/ext.pageReader.test.js`, after the opt-in rendering tests from Task 3:

```javascript
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
	assert.strictEqual( state.downloadCalls, 1 );

	// Flush the download()/loader promise chain.
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();

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
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();

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
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm run test:behavior`
Expected: FAIL (no click handler exists on the opt-in button yet, so its state never changes).

- [ ] **Step 6: Implement the click handler**

In `resources/ext.pageReader.js`'s `bindButton()` function, find the existing `if ( pauseButton ) { pauseButton.addEventListener(...) }` block (ends around line 894, right before the closing `}` of `bindButton`). Add this new block immediately before that closing `}`:

```javascript
		var piperOptIn = findPiperOptIn( button );
		if ( piperOptIn ) {
			piperOptIn.addEventListener( 'click', function () {
				try {
					var state = piperOptIn.getAttribute( 'data-pagereader-piper-state' );
					if ( state === 'active' ) {
						writeStoredEngine( 'native' );
						setPiperOptInState( piperOptIn, 'default' );
						return;
					}
					if ( state === 'default' ) {
						setPiperOptInState( piperOptIn, 'confirm' );
						return;
					}
					if ( state !== 'confirm' ) {
						return;
					}
					setPiperOptInState( piperOptIn, 'downloading' );
					mw.loader.using( 'ext.pageReader.piper' ).then( function () {
						return window.pageReaderPiper.download( function ( progress ) {
							if ( progress && progress.total ) {
								piperOptIn.textContent = mw.msg( 'pagereader-piper-downloading' ) +
									' ' + Math.round( progress.loaded * 100 / progress.total ) + '%';
							}
						} );
					} ).then( function () {
						writeStoredEngine( 'piper' );
						writePiperFailureCount( 0 );
						setPiperOptInState( piperOptIn, 'active' );
					} ).catch( function () {
						setPiperOptInState( piperOptIn, 'default' );
						if ( window.console && console.warn ) {
							console.warn( 'PageReader: Piper download failed' );
						}
					} );
				} catch ( e ) {
					if ( window.console && console.warn ) {
						console.warn( 'PageReader failed', e );
					}
				}
			} );
		}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:behavior`
Expected: PASS.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add resources/ext.pageReader.js tests/node/ext.pageReader.test.js
git commit -m "Wire the Piper opt-in control's click handler"
```

---

### Task 6: Main button wiring — speaking with Piper, pause/stop integration, failure fallback

**Files:**
- Modify: `resources/ext.pageReader.js`
- Test: `tests/node/ext.pageReader.test.js`

This is the task that actually makes the "Read this page aloud" button use Piper once opted in, and is where the 3-consecutive-failures fallback rule (spec §8) lives.

- [ ] **Step 1: Write the failing tests**

Add to `tests/node/ext.pageReader.test.js`, after Task 5's tests:

```javascript
test( 'the main button speaks with Piper when opted in, highlighting each sentence via the shared helper', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Hello there. Saint today lived well.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( state.speakCalls.length, 1 );
	assert.strictEqual( state.speakCalls[ 0 ].sentenceList.length, 2 );
	assert.strictEqual( state.speakCalls[ 0 ].sentenceList[ 0 ].text, 'Hello there.' );

	// Simulate the mocked speak()'s onSentenceStart callback firing.
	state.speakCalls[ 0 ].callbacks.onSentenceStart( state.speakCalls[ 0 ].sentenceList[ 0 ] );
	const mark = window.document.querySelector( '.pagereader-highlight' );
	assert.ok( mark, 'onSentenceStart should highlight via the shared mw.pageReader.highlightChunk' );
	assert.strictEqual( mark.textContent, 'Hello there.' );
} );

test( 'onEnd from the Piper engine resets the button to idle, same as the native path', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( button.textContent, 'Stop reading' );

	state.speakCalls[ 0 ].callbacks.onEnd();

	assert.strictEqual( button.textContent, 'Read this page aloud' );
	assert.strictEqual( button.getAttribute( 'aria-pressed' ), 'false' );
} );

test( 'clicking Stop while speaking with Piper cancels the Piper controller, not speechSynthesis', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	const cancelCountBefore = speechState.cancelCount;

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	assert.strictEqual( state.lastController.cancelled, true );
	assert.strictEqual(
		speechState.cancelCount, cancelCountBefore,
		'native speechSynthesis.cancel() must not be called for a Piper-engine read'
	);
	assert.strictEqual( button.textContent, 'Read this page aloud' );
} );

test( 'pause/resume while speaking with Piper drives the Piper controller, not speechSynthesis', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	const pauseButton = window.document.querySelector( '.pagereader-pause-button' );

	pauseButton.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( state.lastController.paused, true );
	assert.strictEqual( speechState.pauseCount, 0 );

	pauseButton.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	assert.strictEqual( state.lastController.paused, false );
	assert.strictEqual( speechState.resumeCount, 0 );
} );

test( 'a Piper onError falls back to the native engine for that read', function () {
	const { window, speechState } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );
	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );

	state.speakCalls[ 0 ].callbacks.onError();

	assert.strictEqual( speechState.spoken.length, 1, 'the native engine must pick up the same read' );
	assert.strictEqual( window.localStorage.getItem( 'pagereader-piper-failures' ), '1' );
	assert.strictEqual(
		window.localStorage.getItem( 'pagereader-engine' ), 'piper',
		'a single failure must not clear the preference yet'
	);
} );

test( 'the 3rd consecutive Piper failure clears the engine preference back to native', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );

	for ( let i = 0; i < 3; i++ ) {
		button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
		state.speakCalls[ state.speakCalls.length - 1 ].callbacks.onError();
	}

	assert.strictEqual( window.localStorage.getItem( 'pagereader-engine' ), 'native' );
	assert.strictEqual( window.localStorage.getItem( 'pagereader-piper-failures' ), '0' );
} );

test( 'a success after failures resets the failure count to 0', function () {
	const { window } = buildDom(
		'<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>',
		{ wgPageReaderPiperEnabled: true }, null, null,
		{ 'pagereader-engine': 'piper' }, null, null, true
	);
	const state = installPiperMock( window );
	const button = window.document.querySelector( '.pagereader-button' );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	state.speakCalls[ 0 ].callbacks.onError();
	assert.strictEqual( window.localStorage.getItem( 'pagereader-piper-failures' ), '1' );

	button.dispatchEvent( new window.Event( 'click', { bubbles: true } ) );
	state.speakCalls[ 1 ].callbacks.onEnd();

	assert.strictEqual( window.localStorage.getItem( 'pagereader-piper-failures' ), '0' );
} );
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:behavior`
Expected: FAIL — the main button still always uses the native engine (`state.speakCalls.length` is `0` in every new test).

- [ ] **Step 3: Implement**

In `resources/ext.pageReader.js`'s `bindButton()`, find the variable declarations near the top (around line 554, right after `var queuedUtterances = null;`). Add a new state variable:

```javascript
		// Non-null only while a Piper-engine read is active; mirrors
		// queuedUtterances' role for the native engine (a strong reference
		// to whatever's currently playing/pausable/cancellable).
		var piperController = null;
```

In `stopSpeaking()` (currently starts `function stopSpeaking() {`), add a line resetting it, right after `queuedUtterances = null;`:

```javascript
			piperController = null;
```

Find the click handler's opening (`button.addEventListener( 'click', function () { try { if ( speaking ) {`, around line 580-586). Change the `if ( speaking )` branch from:

```javascript
				if ( speaking ) {
					window.speechSynthesis.cancel();
					stopSpeaking();
					return;
				}
```

to:

```javascript
				if ( speaking ) {
					if ( piperController ) {
						piperController.cancel();
					} else {
						window.speechSynthesis.cancel();
					}
					stopSpeaking();
					return;
				}
```

Find the line `if ( sentences.length ) {` inside the same click handler (the branch that currently chooses between `speakSentences(...)` and `speakWholeArticle()`, around line 798 in the pre-Plan-2 file). Change:

```javascript
				if ( sentences.length ) {
					speakSentences( sentences, 0, -1 );
				} else {
					speakWholeArticle();
				}
```

to:

```javascript
				if ( readStoredEngine() === 'piper' && piperCapable() && mw.config.get( 'wgPageReaderPiperEnabled' ) ) {
					speakWithPiper( sentences.length ? sentences : splitIntoSentences( model.text ), myGeneration );
				} else if ( sentences.length ) {
					speakSentences( sentences, 0, -1 );
				} else {
					speakWholeArticle();
				}
```

> Note: `speakWithPiper` always gets a real sentence list, even when `wgPageReaderHighlightEnabled` is `false` (the `highlightEnabled` variable that normally gates whether `sentences` is populated at all) — Piper has no "speak the whole article as one utterance" mode the way the native `speakWholeArticle()` does, since it synthesizes per-sentence regardless; `splitIntoSentences( model.text )` is called as a fallback specifically for that case. This does mean Piper-engine reads always highlight per-sentence even if the site has highlighting disabled site-wide for the native engine — an acceptable, minor inconsistency worth a one-line mention in the PR description, not a blocker.

Now add the `speakWithPiper` function itself. Place it immediately after `speakWholeArticle()`'s closing `}` (search for `window.speechSynthesis.speak( utterance );\n\t\t\t\t}` that ends `speakWholeArticle`, right before the comment block starting `// onstart is reliably supported everywhere`):

```javascript
				// Requests the lazily-loaded Piper module (already cached on
				// this device after the reader's opt-in -- see
				// findPiperOptIn()'s click handler above) and speaks with
				// it, falling back to the native engine entirely on any
				// failure. Mirrors the native path's speechGeneration guard
				// so a stale callback from an already-cancelled Piper read
				// can't resurrect a UI state that's already moved on.
				function speakWithPiper( sentenceList, myGeneration ) {
					mw.loader.using( 'ext.pageReader.piper' ).then( function () {
						if ( myGeneration !== speechGeneration ) {
							return;
						}
						piperController = window.pageReaderPiper.speak( sentenceList, {
							onSentenceStart: function ( sentence ) {
								if ( myGeneration !== speechGeneration ) {
									return;
								}
								currentHighlight = clearHighlight( currentHighlight );
								currentHighlight = highlightChunk(
									contentRoot, model.skipPredicate, sentence.start, sentence.end - sentence.start
								);
							},
							onEnd: function () {
								if ( myGeneration === speechGeneration ) {
									writePiperFailureCount( 0 );
									stopSpeaking();
								}
							},
							onError: function () {
								if ( myGeneration !== speechGeneration ) {
									return;
								}
								var failures = readPiperFailureCount() + 1;
								writePiperFailureCount( failures );
								if ( failures >= 3 ) {
									writeStoredEngine( 'native' );
									writePiperFailureCount( 0 );
								}
								piperController = null;
								stopSpeaking();
								if ( sentenceList.length ) {
									speakSentences( sentenceList, 0, -1 );
								} else {
									speakWholeArticle();
								}
							}
						} );
					} ).catch( function () {
						if ( myGeneration !== speechGeneration ) {
							return;
						}
						var failures = readPiperFailureCount() + 1;
						writePiperFailureCount( failures );
						if ( failures >= 3 ) {
							writeStoredEngine( 'native' );
							writePiperFailureCount( 0 );
						}
						if ( sentenceList.length ) {
							speakSentences( sentenceList, 0, -1 );
						} else {
							speakWholeArticle();
						}
					} );
				}

```

Finally, update the pause button's click handler (currently `if ( pauseButton ) { pauseButton.addEventListener( 'click', function () { ... window.speechSynthesis.resume()/.pause() ... } ); }`, around line 872-893) to branch on `piperController`:

```javascript
			pauseButton.addEventListener( 'click', function () {
				try {
					if ( !speaking ) {
						return;
					}
					if ( paused ) {
						if ( piperController ) {
							piperController.resume();
						} else {
							window.speechSynthesis.resume();
						}
						paused = false;
						pauseButton.textContent = labelPause;
						pauseButton.setAttribute( 'aria-pressed', 'false' );
					} else {
						if ( piperController ) {
							piperController.pause();
						} else {
							window.speechSynthesis.pause();
						}
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
```

(Only the two `if ( piperController ) { ... } else { window.speechSynthesis... }` branches are new; the rest of this handler is unchanged from before this task.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:behavior`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add resources/ext.pageReader.js tests/node/ext.pageReader.test.js
git commit -m "Wire the main button to speak with Piper when opted in, with native fallback"
```

---

### Task 7: CSS for the opt-in control

**Files:**
- Modify: `resources/ext.pageReader.css`

- [ ] **Step 1: Add styles**

`.pagereader-pause-button` (in the existing stylesheet) is the closest precedent — a secondary control next to the main button, same color pair already verified to pass the WCAG AA contrast checks in `npm run test:a11y`. Reuse its exact colors rather than introducing new ones. Add this block to `resources/ext.pageReader.css`, after the existing `.pagereader-pause-button` rules (after the `@media print { .pagereader-pause-button { display: none !important; } }` block, before `.pagereader-highlight`):

```css
.pagereader-piper-optin {
	display: inline-block;
	margin: 0.4em 0 1em 0.5em;
	padding: 0.6em 1.1em;
	min-height: 44px;
	min-width: 44px;
	border: 2px solid #152C4A;
	border-radius: 999px;
	background: #FDF8EC;
	color: #152C4A;
	font-size: 0.95em;
	font-weight: 700;
	cursor: pointer;
}

.pagereader-piper-optin:hover {
	background: #F5EFE0;
}

.pagereader-piper-optin:focus-visible {
	outline: 3px solid #1E3A5F;
	outline-offset: 3px;
}

.pagereader-piper-optin[data-pagereader-piper-state="downloading"] {
	opacity: 0.65;
	cursor: progress;
}

.pagereader-piper-optin[data-pagereader-piper-state="active"] {
	border-color: #A85D1B;
	color: #A85D1B;
}

@media print {
	.pagereader-piper-optin {
		display: none !important;
	}
}
```

- [ ] **Step 2: Run the accessibility test suite**

Run: `npm run test:a11y`
Expected: still 15/15 passing — the new control must not introduce a contrast violation. If it does, adjust the colors and re-run until green (see `DEPLOY.md`'s accessibility section for the exact contrast thresholds this suite checks).

- [ ] **Step 3: Commit**

```bash
git add resources/ext.pageReader.css
git commit -m "Style the Piper opt-in control"
```

---

### Task 8: Documentation

**Files:**
- Modify: `DEPLOY.md`
- Modify: `README.md`

- [ ] **Step 1: Add smoke-checklist rows**

In `DEPLOY.md`'s "Smoke checklist" table, add these rows (after the existing `$wgPageReaderHighlightEnabled` row):

```markdown
| On a WASM/AudioContext-capable browser with `$wgPageReaderPiperEnabled` true | The "Try a better voice" control appears next to the voice select |
| Set `$wgPageReaderPiperEnabled = false;` | The control does not appear |
| Click "Try a better voice" once | Label changes to a download-size confirmation; nothing downloads yet |
| Click it again | Downloads Amy's voice model with visible progress, then shows "Using Amy's voice — tap to use default" |
| Click "Read this page aloud" after opting in | Reads with Amy's voice; sentence highlighting stays in sync |
| Click "Stop reading" / the pause button while using Amy's voice | Both work identically to the native engine |
| Block `cdn.jsdelivr.net` and click "Read this page aloud" after opting in | Falls back to the native voice for that read, no broken UI |
| Force 3 consecutive Piper failures (e.g. with jsdelivr blocked) | Engine preference reverts to native; the opt-in control returns to its default (not "active") state |
```

- [ ] **Step 2: Add a Piper section to `DEPLOY.md`**

Replace the one-paragraph `piperEnabled` note Plan 1's Task 7 added (search for `piperEnabled` in `DEPLOY.md`) with a full section, inserted after the "Per-page editor opt-out" section and before "Content scoping: what gets read":

```markdown
## Opt-in Piper voice

Readers can opt into a higher-quality, client-side neural voice
("Amy," `en_US-amy-medium` from the open-source [Piper](https://github.com/rhasspy/piper)
project) via a "Try a better voice" control next to the voice-gender
select, on any browser with WebAssembly and AudioContext support. The
voice model (~60MB) downloads once per device, from jsdelivr, and is
cached by the browser — no text is ever sent to a third party, and
nothing downloads until the reader explicitly opts in.

`$wgPageReaderPiperEnabled` (default `true`, overridable via
`MediaWiki:PageReader-config` like everything else) turns this control
off site-wide if needed. Any failure in the Piper path (a blocked CDN,
an unsupported browser, a corrupt download) falls back to the native
voice for that read; 3 consecutive failures clear the reader's saved
preference so they're asked to opt in again rather than silently stuck.

Full design rationale: [`docs/superpowers/specs/2026-09-16-piper-voice-option-design.md`](docs/superpowers/specs/2026-09-16-piper-voice-option-design.md).
Real audio quality, download/caching behavior, and cross-browser
consistency are **not** covered by `npm test` (jsdom cannot execute
real WASM or real network fetches) — see that plan's real-browser
verification task before trusting a green CI run alone.
```

- [ ] **Step 3: Add a bullet to `README.md`'s Features list**

In `README.md`'s `## Features` bulleted list, add this bullet after the existing voice-gender/preferred-voices bullet:

```markdown
- An opt-in, client-side neural voice ("Amy," via the open-source
  [Piper](https://github.com/rhasspy/piper) project) for readers who
  want better or more consistent quality than their browser's own
  built-in voice — a one-time ~60MB download, cached on-device, never
  sending page text anywhere. `$wgPageReaderPiperEnabled` (default
  `true`) is the sysop kill switch.
```

- [ ] **Step 4: Commit**

```bash
git add DEPLOY.md README.md
git commit -m "Document the Piper voice option"
```

---

### Task 9: Real-browser verification (manual — not automatable)

**Files:** none (verification only, on a real deployed or dev-instance page)

This task exists because jsdom cannot exercise any of: real dynamic `import()` from jsdelivr, real Piper WASM inference, real audio playback/quality, or real OPFS persistence/eviction — exactly the category of gap that made the pitch/rate bug (`#13`/`#15`) and the retry-cascade recursion bug (`#14`) invisible to automated tests earlier in this project. Do not consider this plan done until every step below has been performed on a real page, on real hardware, with a real network connection to jsdelivr.

- [ ] **Step 1: Chrome — full opt-in flow**

On a real Kids: page (with real internet access — not the sandboxed dev container used earlier in this project, which has no route to jsdelivr): click "Try a better voice," confirm, watch the download percentage actually progress, and confirm the button reaches the active state and immediately starts reading in Amy's voice. Listen for actual audio; confirm sentence highlighting stays in sync with what's audible.

- [ ] **Step 2: Chrome — persistence across reload**

Reload the page. Confirm the opt-in control shows the active state without re-downloading (check the Network tab: no request to jsdelivr for the model file on this second load, only for a request when the reader clicks "Read this page aloud" — if a request happens, `stored()`/OPFS caching is not working as documented and needs investigating before shipping). Click "Read this page aloud" and confirm playback starts with no visible delay beyond real inference time.

- [ ] **Step 3: Measure real per-sentence latency**

On a multi-sentence article, note whether there's a perceptible gap between sentences (per spec §9's open risk). If there is, note how large in the PR description — this may need a follow-up (e.g. beginning synthesis of the next sentence while the current one is still playing) but is not necessarily a blocker for an initial opt-in ship, since it's a "in exchange for a better voice, this one is slightly slower" tradeoff a reader has explicitly opted into.

- [ ] **Step 4: Firefox and Safari — same flow**

Repeat Steps 1-2 on Firefox and Safari (desktop). Confirm the opt-in control appears (capability check passes) and the full flow works identically.

- [ ] **Step 5: A browser that should NOT show the opt-in**

Find or simulate a browser/environment lacking WASM or AudioContext support (or temporarily stub `piperCapable()` to return false) and confirm the opt-in control simply doesn't render — no broken UI, no console error.

- [ ] **Step 6: iOS Safari — OPFS eviction**

On an iOS device, opt in, force-quit Safari (or leave the device idle per whatever interval is practical to test), and reopen the page after a delay. Confirm the fallback-on-missing-model path (a `download()` call inside `predict()`/`speak()`'s first invocation, since the library re-downloads transparently if OPFS no longer has the model — confirm this actually happens rather than erroring) works correctly rather than silently failing.

- [ ] **Step 7: Simulate a CDN failure**

Block `cdn.jsdelivr.net` (browser devtools network request blocking, or a hosts-file entry) and click "Try a better voice." Confirm the opt-in control returns to the default state (not stuck on "downloading") and the console shows the expected warning, not an uncaught exception.

- [ ] **Step 8: Document results and open a PR**

Summarize what was verified (and on which real browsers/devices) directly in the PR description — this is exactly the kind of evidence `VeritasDei`'s review process has asked for on prior audio-behavior PRs in this project (see PR #11/#13's review history for the expected level of detail).

```bash
git push -u origin <branch-name>
```

Open a PR against `main` titled "Add opt-in Piper voice option," referencing this plan, Plan 1 (must already be merged), and the design spec.
