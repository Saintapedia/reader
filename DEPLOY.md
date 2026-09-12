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
`voiceRate`, `voiceGender`.

**LocalSettings-only, cannot be overridden here**: `PageReaderEnabled`,
`PageReaderActions`, `PageReaderContentModels`, `PageReaderIncludeTalk`,
`PageReaderConfigPage` itself. Setting `"enabled": false` or
`"actions": ["view", "edit"]` in this JSON page has **no effect**.

## Per-page editor opt-out

Add `__NOPAGEREADER__` anywhere in a page's wikitext to suppress the
button on that one page.

## Smoke checklist

| Check | Expected |
|-------|----------|
| Load a `Kids:` page | Button appears once, toggles label/class/`aria-pressed` |
| Load `Portal:Kids` | Button appears (the page itself carries the `kids-readaloud` marker) |
| Load a `Portal:Kids/` subpage generated via a path-page template | Module requested (`ext.pageReader` in `RLPAGEMODULES`), but the button appears only if that specific page's content actually contains `class="kids-readaloud"` — most path pages don't, by design (see spec §8); eligible-but-marker-less is expected, not a regression |
| Load a page named `Portal:KidsCorner` | Button does **not** appear (module not requested — outside the exact-or-subpage match) |
| Load any non-Kids page | `ext.pageReader` module not requested (check network panel / `mw.loader.getState('ext.pageReader')`) |
| Add `__NOPAGEREADER__` to a Kids page | Button no longer appears |
| Edit `MediaWiki:PageReader-config` to add a namespace | Takes effect without a restart |
| Save invalid JSON to `MediaWiki:PageReader-config` | Falls back to LocalSettings defaults, no error |
| Voice select (female/male/auto) next to the button | Present, labeled, defaults to female, persists choice across reloads via `localStorage` |
| Pick "female" or "male" then click the button (on a browser/OS with a matching named voice) | Speech uses a voice whose name contains that word; silently falls back to the default voice if none match |
| Click the button to start speech | A pause button appears next to the voice select |
| Click pause, then again to resume | Speech pauses via `speechSynthesis.pause()`, then resumes via `resume()`; label toggles Pause ⇄ Resume |
| Click "Stop reading" while paused | Fully stops, pause button hides and resets |
| Browser without `speechSynthesis.pause`/`resume` support | No pause button is created (rest of the feature still works) |

## Accessibility checklist

Per [USWDS's component accessibility guidance](https://designsystem.digital.gov/documentation/accessibility/) (USWDS has no dedicated read-aloud/TTS component — "VoiceOver" in their docs is Apple's screen reader, used below as a testing tool, not a UI pattern):

| Check | Expected | Status |
|-------|----------|--------|
| Tab to the button | Visible focus outline appears | Automated (`npm run test:a11y` — WCAG AA contrast check on the focus outline) |
| axe-core structural/ARIA scan, idle + speaking + paused states | No violations | Automated (`npm run test:a11y`) |
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
