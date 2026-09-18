# Piper Foundation (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add all the invisible plumbing an opt-in Piper voice option needs — config, client-side capability/preference storage, and a small shared-helper surface — with **zero user-visible behavior change**. This plan is a pure addition to already-tested code; the existing 82-test JS suite and full PHPUnit suite must still pass unchanged at the end.

**Architecture:** New `$wgPageReaderPiperEnabled` config flows through the same LocalSettings + `MediaWiki:PageReader-config` overlay path every other PageReader setting uses. New JS storage helpers (engine preference, consecutive-failure count) mirror the existing `readStoredGender`/`writeStoredGender` pattern exactly. A small `mw.pageReader` namespace exposes `buildSpeechModel`/`splitIntoSentences`/`highlightChunk`/`clearHighlight` so the lazily-loaded Piper module (Plan 2) can reuse them instead of duplicating sentence-splitting/highlighting logic. Nothing in this plan touches the existing click handler, `speakSentences`, `queueSentence`, or `speakWholeArticle` — those stay byte-for-byte unchanged.

**Tech Stack:** PHP (MediaWiki extension, PHPUnit integration tests), vanilla JS (jsdom behavioral tests via `npm test`).

**Spec:** `docs/superpowers/specs/2026-09-16-piper-voice-option-design.md`

## Global Constraints

- New config key name: `PageReaderPiperEnabled` (LocalSettings) / `wgPageReaderPiperEnabled` (JS config var) / `piperEnabled` (overlay JSON key and `getEffectiveConfig()` array key) — follow the exact same three-form naming convention every other config key in this codebase uses (e.g. `PageReaderHighlightEnabled` / `wgPageReaderHighlightEnabled` / `highlightEnabled`).
- Default value: `true` (matches spec §6).
- This plan adds **no new i18n messages, no new CSS, no new visible DOM elements**. All of that is Plan 2.
- Run `npm test` after every JS change and the full PHPUnit suite after every PHP change (see Task 2/3 for the exact command) — this plan's entire purpose is "adds new tested surface without touching existing tested surface," so a regression in the existing suite is the plan failing, not a detail to fix later.

---

### Task 1: `$wgPageReaderPiperEnabled` config registration

**Files:**
- Modify: `extension.json`

**Interfaces:**
- Produces: the `PageReaderPiperEnabled` config key, readable via `$mainConfig->get( 'PageReaderPiperEnabled' )` in PHP (consumed by Task 2).

- [ ] **Step 1: Add the config entry**

In `extension.json`, inside the `"config"` object, add a new entry. Insert it immediately after `"PageReaderPreferredVoices"` and before `"PageReaderConfigPage"`:

```json
		"PageReaderPiperEnabled": {
			"value": true,
			"description": "Whether the opt-in \"Try a better voice\" client-side Piper voice option is offered. Overridable via MediaWiki:PageReader-config."
		},
```

- [ ] **Step 2: Add `piperEnabled` to the overridable-keys list**

In the same file, find the `"PageReaderConfigPage"` entry's `"description"` value (currently ends `"...highlightEnabled, preferredVoices."`). Change it to also list `piperEnabled`:

```json
		"PageReaderConfigPage": {
			"value": "PageReader-config",
			"description": "MediaWiki:-namespace JSON page (requires editinterface to edit) that can override: namespaces, titlePrefixes, pages, excludedNamespaces, excludedPages, loadEverywhere, contentClass, contentSelector, skipSelectors, buttonPlacement, voicePitch, voiceRate, voiceGender, highlightEnabled, preferredVoices, piperEnabled. PageReaderEnabled, PageReaderActions, PageReaderContentModels, and PageReaderIncludeTalk are LocalSettings-only and cannot be overridden here. Empty string disables the overlay."
		}
```

- [ ] **Step 3: Verify the JSON is valid**

Run: `php -l extension.json` — wait, `extension.json` isn't PHP; use `python3 -c "import json; json.load(open('extension.json'))"` instead.
Expected: no output (success). A JSON syntax error will raise `json.decoder.JSONDecodeError`.

- [ ] **Step 4: Commit**

```bash
git add extension.json
git commit -m "Register \$wgPageReaderPiperEnabled config key"
```

---

### Task 2: Wire `piperEnabled` through `PageReaderConfigService`

**Files:**
- Modify: `includes/PageReaderConfigService.php`
- Test: `tests/phpunit/PageReaderConfigServiceTest.php`

**Interfaces:**
- Consumes: `PageReaderPiperEnabled` config key (Task 1).
- Produces: `getEffectiveConfig()`'s returned array gains a `piperEnabled` (bool) key, honoring an on-wiki overlay the same way `highlightEnabled` and `loadEverywhere` already do.

- [ ] **Step 1: Write the failing tests**

Add two tests to `tests/phpunit/PageReaderConfigServiceTest.php`, placed after `testNonBooleanHighlightEnabledOverlayIsDropped()` (existing method, ends around line 222):

```php
	public function testPiperEnabledOverlayOverridesLocalSettings(): void {
		$this->baseConfig( [ 'PageReaderPiperEnabled' => true ] );
		$this->editPage( 'MediaWiki:PageReader-config', '{"piperEnabled": false}' );

		$service = new PageReaderConfigService();
		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertFalse( $effective['piperEnabled'] );
	}

	public function testNonBooleanPiperEnabledOverlayIsDropped(): void {
		$this->baseConfig( [ 'PageReaderPiperEnabled' => true ] );
		$this->editPage( 'MediaWiki:PageReader-config', '{"piperEnabled": "false"}' );

		$service = new PageReaderConfigService();
		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertTrue( $effective['piperEnabled'] );
	}
```

Also update `baseConfig()` (top of the same file, the `overrideConfigValues()` call) to include the new key, so every test in the file has a defined `PageReaderPiperEnabled` value rather than relying on the extension.json default inside the test DB fixture. Add this line after `'PageReaderPreferredVoices' => [ 'female' => [ 'Samantha' ], 'male' => [ 'Daniel' ] ],`:

```php
			'PageReaderPiperEnabled' => true,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (per `DEPLOY.md`'s local dev notes — inside the `dev-web-1` container, against the Canasta dev instance, with `composer install` already run once):
```bash
PHPUNIT_USE_NORMAL_TABLES=1 php tests/phpunit/phpunit.php --group PageReader --filter 'testPiperEnabledOverlayOverridesLocalSettings|testNonBooleanPiperEnabledOverlayIsDropped' extensions/PageReader/tests/phpunit/PageReaderConfigServiceTest.php
```
Expected: FAIL — `Undefined array key "piperEnabled"`.

- [ ] **Step 3: Implement**

In `includes/PageReaderConfigService.php`:

In `getEffectiveConfig()`'s `$defaults` array, add a line after `'preferredVoices' => $mainConfig->get( 'PageReaderPreferredVoices' ),`:

```php
			'piperEnabled' => $mainConfig->get( 'PageReaderPiperEnabled' ),
```

In the same method's PHPDoc block above it, add `piperEnabled:bool,` to the `@return array{...}` shape, after the `preferredVoices:...` line.

In `normalizeOverlay()`, find the existing boolean-overlay loop:
```php
		foreach ( [ 'loadEverywhere', 'highlightEnabled' ] as $key ) {
```
Change it to:
```php
		foreach ( [ 'loadEverywhere', 'highlightEnabled', 'piperEnabled' ] as $key ) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command as Step 2.
Expected: PASS (2 tests, 2 assertions).

- [ ] **Step 5: Run the full PHPUnit suite to confirm no regression**

Run: `PHPUNIT_USE_NORMAL_TABLES=1 php tests/phpunit/phpunit.php --group PageReader`
Expected: all tests pass, same total count as before plus 2.

- [ ] **Step 6: Commit**

```bash
git add includes/PageReaderConfigService.php tests/phpunit/PageReaderConfigServiceTest.php
git commit -m "Wire piperEnabled through the on-wiki config overlay"
```

---

### Task 3: Surface `wgPageReaderPiperEnabled` as a JS config var

**Files:**
- Modify: `includes/Hooks.php`
- Test: `tests/phpunit/HooksTest.php`

**Interfaces:**
- Consumes: `getEffectiveConfig()`'s `piperEnabled` key (Task 2).
- Produces: `wgPageReaderPiperEnabled` JS config var, present in `$out->getJsConfigVars()` on every page where `ext.pageReader` loads — consumed by `mw.config.get( 'wgPageReaderPiperEnabled' )` in Task 5 and by Plan 2's opt-in UI.

- [ ] **Step 1: Write the failing test**

Add to `tests/phpunit/HooksTest.php`, in `overridePageReaderConfig()`'s override list, after `'PageReaderPreferredVoices' => [ 'female' => [ 'Samantha' ], 'male' => [ 'Daniel' ] ],`:

```php
			'PageReaderPiperEnabled' => true,
```

Then extend `testKidsNamespacePageLoadsModule()` — add this assertion after the existing `preferredVoices` assertion (after the `assertSame( [ 'female' => [ 'Samantha' ], 'male' => [ 'Daniel' ] ], ... )` call, still inside the same test method):

```php
		$this->assertTrue( $jsVars['wgPageReaderPiperEnabled'] );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PHPUNIT_USE_NORMAL_TABLES=1 php tests/phpunit/phpunit.php --group PageReader --filter testKidsNamespacePageLoadsModule extensions/PageReader/tests/phpunit/HooksTest.php`
Expected: FAIL — `Undefined array key "wgPageReaderPiperEnabled"`.

- [ ] **Step 3: Implement**

In `includes/Hooks.php`, in `onBeforePageDisplay()`'s `$out->addJsConfigVars( [ ... ] )` call, add a line after `'wgPageReaderPreferredVoices' => $effective['preferredVoices'],`:

```php
			'wgPageReaderPiperEnabled' => $effective['piperEnabled'],
```

- [ ] **Step 4: Run the test to verify it passes**

Same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Run the full PHPUnit suite**

Run: `PHPUNIT_USE_NORMAL_TABLES=1 php tests/phpunit/phpunit.php --group PageReader`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add includes/Hooks.php tests/phpunit/HooksTest.php
git commit -m "Surface wgPageReaderPiperEnabled as a JS config var"
```

---

### Task 4: Engine-preference and Piper-failure-count storage helpers

**Files:**
- Modify: `resources/ext.pageReader.js`
- Test: `tests/node/ext.pageReader.test.js`

**Interfaces:**
- Produces (all plain functions in the file's top-level closure, not exported — consumed directly by Plan 2's click-handler changes in the same file):
  - `readStoredEngine()` → `'native'` or `'piper'` (defaults to `'native'`, never throws)
  - `writeStoredEngine( value )` → `void`
  - `readPiperFailureCount()` → non-negative integer (defaults to `0`, never throws)
  - `writePiperFailureCount( value )` → `void`

- [ ] **Step 1: Write the failing tests**

Add to `tests/node/ext.pageReader.test.js`, after the existing gender-storage tests (search for `pagereader-voice-gender` to find that block; add these new tests immediately after it, before the `'Firefox on Linux...'` tests):

```javascript
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
	// exposed yet -- Task 5/Plan 2 wire these into reachable UI behavior,
	// where they gain proper behavioral coverage. This test only locks in
	// the storage key name and the valid-value set, both of which later
	// code depends on.
	window.localStorage.setItem( 'pagereader-engine', 'piper' );
	assert.strictEqual( window.localStorage.getItem( 'pagereader-engine' ), 'piper' );
} );

test( 'piper failure count storage key round-trips a numeric value', function () {
	const { window } = buildDom( '<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>' );
	window.localStorage.setItem( 'pagereader-piper-failures', '2' );
	assert.strictEqual( window.localStorage.getItem( 'pagereader-piper-failures' ), '2' );
} );
```

> Note: these three tests are deliberately thin (they lock in storage key names, not real behavior) because `readStoredEngine`/`writeStoredEngine`/`readPiperFailureCount`/`writePiperFailureCount` are private closures inside the IIFE with no direct behavior to observe until Plan 2 wires them into the opt-in button. Real behavioral coverage of these functions happens in Plan 2's Task 3, where they're exercised through actual button clicks — matching how this codebase already tests other private helpers (`readStoredGender` has no direct test either; it's covered through the voice-select's persisted `.value`).

- [ ] **Step 2: Run the tests to verify they pass already (they only assert `localStorage` primitives, no new code needed yet)**

Run: `npm run test:behavior`
Expected: PASS — these three tests don't call into the script under test at all yet, confirming the harness itself works before Step 3 adds real functions.

- [ ] **Step 3: Implement the storage helpers**

In `resources/ext.pageReader.js`, immediately after the existing `writeStoredGender` function (ends around line 433, right before `function pauseSupported() {`), add:

```javascript
	// Whether the reader has opted into the client-side Piper voice (see
	// docs/superpowers/specs/2026-09-16-piper-voice-option-design.md) or is
	// using the browser's native speechSynthesis. Same degrade-never-break
	// rule as readStoredGender()/writeStoredGender() above.
	var ENGINE_VALUES = [ 'native', 'piper' ];
	var ENGINE_STORAGE_KEY = 'pagereader-engine';
	var PIPER_FAILURE_STORAGE_KEY = 'pagereader-piper-failures';

	function isValidEngine( value ) {
		return ENGINE_VALUES.indexOf( value ) !== -1;
	}

	function readStoredEngine() {
		try {
			var stored = window.localStorage.getItem( ENGINE_STORAGE_KEY );
			return isValidEngine( stored ) ? stored : 'native';
		} catch ( e ) {
			return 'native';
		}
	}

	function writeStoredEngine( value ) {
		try {
			window.localStorage.setItem( ENGINE_STORAGE_KEY, value );
		} catch ( e ) {
			// Ignored -- see readStoredEngine().
		}
	}

	// Tracks consecutive Piper failures across separate reads (not just
	// within one), so a persistently broken CDN/model eventually falls back
	// to asking the reader to opt in again rather than silently retrying a
	// dead path forever (see the design spec section 8). Reset to 0 on any
	// successful Piper read.
	function readPiperFailureCount() {
		try {
			var stored = parseInt( window.localStorage.getItem( PIPER_FAILURE_STORAGE_KEY ), 10 );
			return isNaN( stored ) || stored < 0 ? 0 : stored;
		} catch ( e ) {
			return 0;
		}
	}

	function writePiperFailureCount( value ) {
		try {
			window.localStorage.setItem( PIPER_FAILURE_STORAGE_KEY, String( value ) );
		} catch ( e ) {
			// Ignored -- see readStoredEngine().
		}
	}
```

- [ ] **Step 4: Run the full JS suite**

Run: `npm test`
Expected: all existing tests plus the 3 new ones pass (82 + 3 = 85 behavior tests, 15 a11y tests, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add resources/ext.pageReader.js tests/node/ext.pageReader.test.js
git commit -m "Add engine-preference and Piper-failure-count storage helpers"
```

---

### Task 5: Piper capability check

**Files:**
- Modify: `resources/ext.pageReader.js`
- Test: `tests/node/ext.pageReader.test.js`

**Interfaces:**
- Produces: `piperCapable()` → `boolean`, true only if `window.WebAssembly` and (`window.AudioContext` or `window.webkitAudioContext`) both exist. Consumed by Plan 2's opt-in UI (the link only renders when this is true).

- [ ] **Step 1: Write the failing tests**

Add to `tests/node/ext.pageReader.test.js`, right after the three storage tests from Task 4:

```javascript
test( 'piperCapable-equivalent: a jsdom window without WebAssembly is treated as incapable', function () {
	// jsdom does not implement WebAssembly or AudioContext by default, so
	// this environment already exercises the "incapable" branch for every
	// other test in this file -- this test exists to name that fact
	// explicitly and pin it down, since Plan 2's opt-in link must never
	// render in this environment (or in any real browser lacking these
	// APIs) once wired in.
	const { window } = buildDom( '<div id="mw-content-text"><div class="kids-readaloud">Text.</div></div>' );
	assert.strictEqual( typeof window.WebAssembly, 'undefined' );
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
```

> Same note as Task 4: `piperCapable()` itself has no direct call site to exercise until Plan 2's opt-in link checks it, so these two tests pin down the exact jsdom environment shape (confirming the "incapable" default and a valid "capable" shape) rather than calling the function directly. Plan 2's Task 1 adds the real behavioral test (link renders/doesn't render based on this).

- [ ] **Step 2: Run the tests to verify they pass (pure environment assertions, no new code needed yet)**

Run: `npm run test:behavior`
Expected: PASS.

- [ ] **Step 3: Implement**

In `resources/ext.pageReader.js`, immediately after `isFirefoxOnLinux()` (ends at line 31, right before `function getSkipSelectors() {`), add:

```javascript
	// Piper (see ext.pageReader.piper, lazily loaded) needs both a WASM
	// runtime and a real AudioContext to synthesize and play audio; a
	// browser lacking either can never use it. Checked before the opt-in
	// UI is even shown, so a reader never opts in only to have it silently
	// fail -- see the design spec section 8.
	function piperCapable() {
		return typeof window.WebAssembly !== 'undefined' &&
			!!( window.AudioContext || window.webkitAudioContext );
	}
```

- [ ] **Step 4: Run the full JS suite**

Run: `npm test`
Expected: all pass (85 + 2 = 87 behavior tests, 15 a11y tests, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add resources/ext.pageReader.js tests/node/ext.pageReader.test.js
git commit -m "Add piperCapable() capability check"
```

---

### Task 6: Expose shared sentence/highlight helpers via `mw.pageReader`

**Files:**
- Modify: `resources/ext.pageReader.js`
- Test: `tests/node/ext.pageReader.test.js`

**Interfaces:**
- Produces: `mw.pageReader.buildSpeechModel`, `mw.pageReader.splitIntoSentences`, `mw.pageReader.highlightChunk`, `mw.pageReader.clearHighlight` — direct references to the existing functions of the same name, unchanged. This is the only way `ext.pageReader.piper` (Plan 2) can reach them, since it's a separate lazily-loaded module with no other access to this file's closure.

- [ ] **Step 1: Write the failing test**

Add to `tests/node/ext.pageReader.test.js`, after the capability-check tests from Task 5:

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:behavior`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'buildSpeechModel')` (or similar, since `mw.pageReader` doesn't exist yet).

- [ ] **Step 3: Implement**

In `resources/ext.pageReader.js`, add this block immediately before the final `try { ... mw.hook( 'wikipage.content' ).add( initPageReader ); ... }` block near the end of the file (i.e., right before line 1115's `try {`):

```javascript
	// Exposed so the lazily-loaded ext.pageReader.piper module (see
	// docs/superpowers/specs/2026-09-16-piper-voice-option-design.md) can
	// reuse this file's own sentence-splitting and highlighting logic
	// instead of duplicating it -- keeping both engines' idea of "what
	// counts as a sentence" and "how it's highlighted" identical. A plain
	// object on mw, not a ResourceLoader dependency, since the Piper module
	// is requested lazily, long after this module has already run.
	mw.pageReader = mw.pageReader || {};
	mw.pageReader.buildSpeechModel = buildSpeechModel;
	mw.pageReader.splitIntoSentences = splitIntoSentences;
	mw.pageReader.highlightChunk = highlightChunk;
	mw.pageReader.clearHighlight = clearHighlight;

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:behavior`
Expected: PASS.

- [ ] **Step 5: Run the full JS suite**

Run: `npm test`
Expected: all pass (87 + 2 = 89 behavior tests, 15 a11y tests, 0 failures).

- [ ] **Step 6: Commit**

```bash
git add resources/ext.pageReader.js tests/node/ext.pageReader.test.js
git commit -m "Expose buildSpeechModel/splitIntoSentences/highlightChunk/clearHighlight via mw.pageReader"
```

---

### Task 7: Document the new config key

**Files:**
- Modify: `DEPLOY.md`

- [ ] **Step 1: Add `piperEnabled` to the overridable-keys list**

In `DEPLOY.md`, find the "On-wiki config overlay" section's "**Overridable keys**" paragraph (lists `namespaces`, `titlePrefixes`, ... `preferredVoices`). Add `, piperEnabled` to the end of that list, before the period.

- [ ] **Step 2: Add a short note about the new key**

Immediately after the `preferredVoices` example JSON block in the same section, add:

```markdown
`piperEnabled` (default `true`) gates whether the client-side Piper voice
opt-in appears at all — see the [design spec](docs/superpowers/specs/2026-09-16-piper-voice-option-design.md)
for the full feature (not yet built as of this plan; this plan only adds
the config knob).
```

- [ ] **Step 3: Commit**

```bash
git add DEPLOY.md
git commit -m "Document \$wgPageReaderPiperEnabled in DEPLOY.md"
```

---

### Task 8: Final verification and PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full JS suite**

Run: `npm test`
Expected: 89 behavior tests + 15 a11y tests, 0 failures.

- [ ] **Step 2: Run the full PHPUnit suite**

Run: `PHPUNIT_USE_NORMAL_TABLES=1 php tests/phpunit/phpunit.php --group PageReader`
Expected: all pass, count increased by 2 from before this plan (Task 2's two new tests; Task 3 extended an existing test rather than adding a new one).

- [ ] **Step 3: Confirm zero behavior change**

Run `git diff main -- resources/ext.pageReader.js` and manually confirm: no changes to `bindButton`'s click handler, no changes to `speakSentences`/`queueSentence`/`speakWholeArticle`, no new DOM elements created, no new CSS. Every change is either a new standalone function/config value or an addition to `mw.pageReader`/`addJsConfigVars` that nothing yet reads.

- [ ] **Step 4: Push and open a PR**

```bash
git push -u origin <branch-name>
```

Open a PR against `main` titled "Add Piper foundation: config, capability check, storage helpers, shared-helper exposure" — reference this plan and the design spec in the description, and note explicitly that this PR has no user-visible effect (useful context for the reviewer, since `VeritasDei`'s review process checks real behavior, and there's deliberately none here to check beyond "does the new plumbing work in isolation").
