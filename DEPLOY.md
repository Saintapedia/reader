# PageReader production deploy

## Install (prod or any Canasta wiki)

```bash
cd /path/to/mediawiki/w/extensions   # or user-extensions on Canasta
git clone https://github.com/Saintapedia/reader.git PageReader
```

On Canasta, if code lives under `user-extensions/PageReader`, ensure a symlink:
```bash
ln -sfn ../user-extensions/PageReader /path/to/w/extensions/PageReader
```

Enable:
```php
wfLoadExtension( 'PageReader' );
```

No database schema changes — `update.php` is not required.

## Saintapedia (this wiki)

No LocalSettings changes needed. Defaults already reproduce the exact
current Kids-only behavior: namespace `1004`, `Kids:` prefix,
`Portal:Kids` (+ subpages), and — critically — content class
`kids-readaloud`, matching the class already present in existing Kids:
articles from the prior Common.js implementation. **Do not change the
default content class without also updating (or accepting the loss of)
the read-aloud button on every existing Kids: article that still uses
the old class.**

**These defaults (`1004`, `"Kids:"`, `kids-readaloud`) are
Saintapedia-specific, not hardcoded assumptions** — any other wiki
installing this extension should expect to override them, either in
LocalSettings or via `MediaWiki:PageReader-config`.

## Going wiki-wide on another wiki

```php
$wgPageReaderLoadEverywhere = true;
$wgPageReaderNamespaces = [];
$wgPageReaderTitlePrefixes = [];
$wgPageReaderPages = [];
```

## Disabling Saintapedia's Kids behavior without uninstalling

```php
$wgPageReaderEnabled = false;
```

## On-wiki config overlay

`MediaWiki:PageReader-config` requires `editinterface` to edit (sysop by
default) — same protection level as `MediaWiki:Common.js`. Create it with
JSON such as:
```json
{
	"namespaces": [1004, 2000],
	"titlePrefixes": ["Kids:", "Teen:"],
	"excludedNamespaces": [-1]
}
```
Any field omitted here keeps its `$wgPageReader*` LocalSettings value.
Takes effect immediately on save (cache is keyed on the page's latest
revision ID). An invalid edit (bad JSON, or a non-text content model on
the page) silently falls back to the LocalSettings defaults rather than
breaking the site.

**Overridable keys**: `namespaces`, `titlePrefixes`, `pages`,
`excludedNamespaces`, `excludedPages`, `loadEverywhere`, `contentClass`,
`contentSelector`, `skipSelectors`, `buttonPlacement`, `voicePitch`,
`voiceRate`, `voiceGender`, `highlightEnabled`, `preferredVoices`,
`piperEnabled`.
`preferredVoices` is `{"female": [...], "male": [...]}` — curating just
one gender doesn't clobber the other's LocalSettings value, e.g.:
```json
{
	"preferredVoices": { "female": ["Samantha", "Zira"] }
}
```

`piperEnabled` (default `true`) gates whether the client-side Piper voice
opt-in appears at all — see "Opt-in Piper voice" below for the full feature.

**LocalSettings-only, cannot be overridden here**: `PageReaderEnabled`,
`PageReaderActions`, `PageReaderContentModels`, `PageReaderIncludeTalk`,
`PageReaderConfigPage` itself. Setting `"enabled": false` or
`"actions": ["view", "edit"]` in this JSON page has **no effect**.

## Per-page editor opt-out

Add `__NOPAGEREADER__` anywhere in a page's wikitext to suppress the
button on that one page.

Add `__NOPAGEREADERHIGHLIGHT__` anywhere in a page's wikitext to keep
the button and speech working normally on that page but suppress
read-along sentence highlighting — useful for a page where PageReader
is enabled outside the Kids namespace and the highlight styling isn't
wanted.

## Opt-in Piper voice

Readers can opt into a higher-quality, client-side neural voice
("Amy," `en_US-amy-medium` from the open-source [Piper](https://github.com/rhasspy/piper)
project) as a 4th option in the same voice select used for
Female/Male/Auto, on any browser with WebAssembly and AudioContext
support. Picking "Amy" for the first time shows an inline warning
("about 60MB to download") with its own Download button rather than
downloading immediately; once downloaded, the model (~60MB) is cached
by the browser and picking "Amy" again on a later visit switches
straight over with no re-prompt. No text is ever sent to a third
party, and nothing downloads until the reader explicitly confirms.

The small `@mintplex-labs/piper-tts-web` wrapper library itself is
vendored locally at `resources/vendor/piper-tts-web.esm.js` (a
patched copy — see that file's header comment for why: the unpatched
jsdelivr build has a broken hardcoded WASM backend path that makes
every synthesis call fail, regardless of browser). What's still
fetched from third-party CDNs at runtime: the actual voice model
(Hugging Face), the ONNX runtime WASM binaries (cdnjs), and the Piper
phonemizer WASM binary (jsdelivr) — all only after the reader opts in.

`$wgPageReaderPiperEnabled` (default `true`, overridable via
`MediaWiki:PageReader-config` like everything else) turns this control
off site-wide if needed. Any failure in the Piper path (a blocked CDN,
an unsupported browser, a corrupt download) falls back to the native
voice for that read; 3 consecutive failures clear the reader's saved
preference so they're asked to opt in again rather than silently stuck.

Full design rationale: [`docs/superpowers/specs/2026-09-16-piper-voice-option-design.md`](docs/superpowers/specs/2026-09-16-piper-voice-option-design.md).
Real audio quality, download/caching behavior, and cross-browser
consistency are **not** covered by `npm test` (jsdom cannot execute
real WASM or real network fetches) — see the smoke checklist below and
verify manually in a real browser before trusting a green CI run alone.

## Content scoping: what gets read

By default (opt-out), PageReader reads the **whole eligible content
area** — no markup needed on an ordinary page at all, since the page
already passed server-side namespace/title eligibility to load the
module in the first place. Two ways to narrow that scope:

1. **`$wgPageReaderContentClass`/`$wgPageReaderContentSelector`**
   (unchanged) — still works exactly as documented above, for any page
   using the `kids-readaloud` class (or a configured fallback selector)
   instead of the opt-out default.
2. **A `pagereader-readaloud-skip-start`/`pagereader-readaloud-skip-end`
   marker pair** — excludes one stretch from being read, under *every*
   scoping mode above (including the opt-out default) — for carving a
   banner or a "see the full article" link out of an otherwise-fine
   page without needing to wrap the rest of the article just to get to
   the one thing that should stay silent. A page can have any number of
   skip regions, and they may nest. Plain hidden `<span>` elements, not
   HTML comments: MediaWiki's parser strips literal wikitext comments
   (`<!-- ... -->`) from the rendered output entirely — confirmed
   against a live page render, they never reach the browser's DOM at
   all — so a comment-based marker would silently do nothing for every
   real reader. A single self-closing `<span>` survives normally, the
   same way `{{ReadAloudButton}}`'s own marker already does:
   ```html
   <span class="pagereader-readaloud-skip-start" style="display:none"></span>
   Text to exclude from the read-aloud.
   <span class="pagereader-readaloud-skip-end" style="display:none"></span>
   ```

## Editor-friendly templates (optional, on-wiki content, not code)

Editors can mark read-aloud content and control button placement with
plain wikitext instead of raw HTML — these are wiki `Template:` pages,
not part of this repo, and need to be created once per wiki (the bot
account cannot create wiki content pages any more than it can edit
`MediaWiki:Common.js`/`Common.css` — see "After verification" below).

**`Template:ReadAloudSkip`** (content:
`<span class="pagereader-readaloud-skip-start" style="display:none"></span>`)
and **`Template:ReadAloudSkipEnd`** (content:
`<span class="pagereader-readaloud-skip-end" style="display:none"></span>`)
let an editor write `{{ReadAloudSkip}}...{{ReadAloudSkipEnd}}` around a
stretch to exclude, instead of the raw marker spans above.

**`Template:ReadAloud/start`** (content: `<div class="kids-readaloud">`)
and **`Template:ReadAloud/end`** (content: `</div>`) — a pair rather
than a single parameterized template, so wikitext inside (links,
formatting) never needs pipe-escaping. **Legacy** — prefer the opt-out
default above (no markup at all) for any new content; this template
pair still works for pages that already use it, but breaks
VisualEditor's per-paragraph editing (each transclusion emits one half
of an unbalanced `<div>`, forcing Parsoid to treat everything between
them as one opaque "template content" block — confirmed on production
`Kids:Saint Lucy`) for anything wrapped in it:
```
{{ReadAloud/start}}
Some story text here, with [[links]] and '''formatting''' working normally.
{{ReadAloud/end}}
```

**`Template:ReadAloudButton`** (content:
`<span class="pagereader-button-anchor" style="display:none"></span>`)
— optional; placing this anywhere on a page overrides where the button
appears on that page, taking priority over `$wgPageReaderButtonPlacement`.
The button (and voice select/pause button) is inserted immediately
after wherever this template sits, independent of where the
`ReadAloud/start`/`end` pair marks the actual content.

**`Template:ReadAloudNoHighlight`** (content: `__NOPAGEREADERHIGHLIGHT__`)
— optional; lets an editor suppress read-along highlighting on one page
by writing `{{ReadAloudNoHighlight}}` instead of the raw magic word.

## Smoke checklist

| Check | Expected |
|-------|----------|
| Load a `Kids:` page | Button appears once, toggles label/class/`aria-pressed` |
| Load `Portal:Kids` | Button appears (the page itself carries the `kids-readaloud` marker) |
| Load a `Portal:Kids/` subpage generated via a path-page template, with no marker of any kind | Module requested (`ext.pageReader` in `RLPAGEMODULES`) **and** a button appears, reading the whole eligible content area — the opt-out default, not the old marker-required behavior |
| Load a page named `Portal:KidsCorner` | Button does **not** appear (module not requested — outside the exact-or-subpage match) |
| Load any non-Kids page | `ext.pageReader` module not requested (check network panel / `mw.loader.getState('ext.pageReader')`) |
| Add `__NOPAGEREADER__` to a Kids page | Button no longer appears |
| Add `__NOPAGEREADERHIGHLIGHT__` to a Kids page | Button still appears and speaks normally, but sentences no longer highlight |
| Add a `pagereader-readaloud-skip-start`/`-skip-end` span pair around one stretch on an eligible page | That stretch is silently excluded; everything else in scope is still read |
| Add two skip pairs on the same page, or nest one inside another | Every region is excluded; a nested pair collapses into one excluded region spanning the outermost start to the outermost end |
| A `wikipage.content` fire for a fragment outside `#mw-content-text` (e.g. a reference-popup preview) | Does not get its own button under the opt-out default |
| Wrap content with `{{ReadAloud/start}}`/`{{ReadAloud/end}}` on any eligible page (legacy) | Button appears per placement config, speech covers only the wrapped content |
| Add `{{ReadAloudButton}}` elsewhere on the same page | Button (and voice select/pause button) moves to right after the template, overriding the configured placement |
| Edit `MediaWiki:PageReader-config` to add a namespace | Takes effect without a restart |
| Save invalid JSON to `MediaWiki:PageReader-config` | Falls back to LocalSettings defaults, no error |
| Voice select (female/male/auto) next to the button | Present, labeled, defaults to female, persists choice across reloads via `localStorage` |
| Pick "female" or "male" then click the button (on a browser/OS with a matching named voice) | Speech uses a voice whose name contains that word; silently falls back to the default voice if none match |
| Click the button to start speech | A pause button appears next to the voice select |
| Click pause, then again to resume | Speech pauses via `speechSynthesis.pause()`, then resumes via `resume()`; label toggles Pause ⇄ Resume |
| Click "Stop reading" while paused | Fully stops, pause button hides and resets |
| Browser without `speechSynthesis.pause`/`resume` support | No pause button is created (rest of the feature still works) |
| Click the button to start speech (multi-sentence article) | The current sentence highlights as it's spoken, moving sentence-by-sentence |
| Click "Stop reading" mid-sentence | Speech and highlighting both stop immediately; the next sentence is never spoken |
| Set `$wgPageReaderHighlightEnabled = false;` | Whole article is spoken as one utterance with no highlighting (kill switch) |
| On a WASM/AudioContext-capable browser with `$wgPageReaderPiperEnabled` true | The voice select has a 4th option, "Amy (better voice)" |
| Set `$wgPageReaderPiperEnabled = false;` | The 4th option does not appear |
| Pick "Amy (better voice)" from the select for the first time | An inline warning appears below the select ("about 60MB to download") with a Download button; nothing downloads yet |
| Click Download | Downloads Amy's voice model with visible progress text, then the warning hides |
| Click "Read this page aloud" after downloading | Reads with Amy's voice; sentence highlighting stays in sync |
| Click "Stop reading" / the pause button while using Amy's voice | Both work identically to the native engine |
| Reload the page and pick "Amy (better voice)" again | Switches immediately with no warning/re-download, since the model is already cached |
| Pick "Female"/"Male"/"Auto" while Amy is active, then switch back to "Amy (better voice)" | Still switches immediately (no re-download); the native gender choice is remembered underneath |
| Block `cdn.jsdelivr.net` and click "Read this page aloud" with Amy active | Falls back to the native voice for that read, no broken UI |
| Force 3 consecutive Piper failures (e.g. with jsdelivr blocked) | Engine preference reverts to native; the select's value reverts to the last native gender choice |

## Accessibility checklist

Per [USWDS's component accessibility guidance](https://designsystem.digital.gov/documentation/accessibility/) (USWDS has no dedicated read-aloud/TTS component — "VoiceOver" in their docs is Apple's screen reader, used below as a testing tool, not a UI pattern):

| Check | Expected | Status |
|-------|----------|--------|
| Tab to the button | Visible focus outline appears | Automated (`npm run test:a11y` — WCAG AA contrast check on the focus outline) |
| axe-core structural/ARIA scan, idle + speaking + paused + highlighting states | No violations | Automated (`npm run test:a11y`) |
| WCAG 2 AA color contrast, all button states (idle/hover/speaking/focus) | All ≥ threshold | Automated (`npm run test:a11y`) — see README's Testing section for why this runs as an exact calculation rather than through axe-core directly |
| Activate with keyboard (Space or Enter) | Same as a mouse click — starts/stops speech | Manual — native `<button>` semantics, not separately verified in a real browser this pass |
| Manual pass with VoiceOver (macOS/iOS) or JAWS (Windows) | Button's label and pressed/toggled state are announced correctly | **Still manual** — needs a real screen reader, not automatable from here |
| Automated scan with [pa11y](https://pa11y.org/) against a real deployed Kids page | No new violations introduced by the button | Optional extra pass once deployed; the jsdom-based `npm run test:a11y` scan already covers the button's own markup |

The button already meets USWDS's baseline button guidance by construction — real `<button>` markup (not a styled `<div>`), a 44×44px minimum touch target, and a visible `:focus-visible` outline — so this checklist was largely a verification pass, and most of it is now regression-tested automatically. The VoiceOver/JAWS row is the one genuine gap left before calling this checklist fully closed.

## After verification

Tom manually removes the read-aloud JS block from `MediaWiki:Common.js`
and the `.kids-readaloud-button`/`.kids-readaloud-speaking`/
`@keyframes kids-readaloud-pulse` rules from `MediaWiki:Common.css` —
the bot cannot edit either protected page.

## Rollback

```bash
cd extensions/PageReader && git log --oneline   # find a prior commit
git checkout <commit>
# or disable PageReader in settings.yaml / LocalSettings and restart
```

## Local Canasta dev environment notes

For this repo's own dev/test workflow: the local Canasta "dev" instance
does **not** bind-mount the working repo directly. It runs its own
separate clone at `canasta-workspace/dev/extensions/PageReader`
(matching how WantedSort and NearMe are set up there) — sync it with
`git pull` after pushing commits, rather than symlinking to the working
tree. Running MediaWiki core's own PHPUnit suite against that instance
additionally needs `composer install` (dev deps) run once inside the
`dev-web-1` container, and `PHPUNIT_USE_NORMAL_TABLES=1` set on every
run (the shared dev database's Cargo tables have FULLTEXT indexes that
can't be cloned into TEMPORARY tables, unrelated to this extension).
