# PageReader — design spec

**Date:** 2026-09-09
**Repo:** https://github.com/Saintapedia/reader
**Extension technical name:** `PageReader`
**Branding / display name:** "Saintapedia Reader"

## 1. Motivation

A read-aloud button currently lives directly in `MediaWiki:Common.js` /
`MediaWiki:Common.css` on saintapedia.org, scoped (client-side, via a
no-op check) to Kids-namespace pages. Because ResourceLoader bundles all
of Common.js/Common.css into one shared `site` module loaded on every
page, a stale Varnish cache on 2026-09-08/09 served a broken version of
that module and took down **all** site JavaScript — not just the
read-aloud button, but unrelated features (timezone conversion) too —
because everything shares one module.

This extension isolates the read-aloud feature into its own
ResourceLoader module, loaded conditionally (server-side, via
`BeforePageDisplay`) only on pages that are actually eligible, and
managed via git instead of hand-pasted into a protected wiki page.

While doing this port, the feature is generalized from a Saintapedia/
Kids-specific hardcoded behavior into a reusable, config-driven
extension any MediaWiki wiki could install — matching the existing
`Saintapedia/WantedSort` and `Saintapedia/NearMe` conventions on this
wiki (repo skeleton, `$wgFoo*` LocalSettings config with an optional
on-wiki JSON overlay page, no new user right, MIT/GPL-2.0-or-later
license matching sibling extensions).

## 2. Scope

**In scope:**
- A `BeforePageDisplay`-gated ResourceLoader module providing a
  read-aloud button, ported from
  `Saintapedia/kids` `assets/kids-readaloud.js` /
  the `.kids-readaloud-button` / `.kids-readaloud-speaking` /
  `@keyframes kids-readaloud-pulse` rules in `assets/kids-styles.css`.
- Config-driven eligibility (namespaces, title prefixes, exact-or-subpage
  page names, excluded namespaces/pages, action/content-model gates,
  talk-page gate, redirect gate).
- A per-page editor opt-out via a `__NOPAGEREADER__` behavior switch.
- Config-driven content targeting (marker class, optional whole-article
  fallback selector, skip-selectors) and button placement.
- An on-wiki JSON overlay page (`MediaWiki:PageReader-config`),
  mirroring `NearMeConfigService`, so eligibility/content-targeting
  config can be adjusted without a LocalSettings deploy.
- i18n for all button-facing strings.

**Out of scope (this extension does not do):**
- Kids infobox styling, portal styling, or any other rule currently in
  `MediaWiki:Common.css` / `kids/assets/kids-styles.css` beyond the
  read-aloud button. Everything else stays exactly where it is.
- Voice picker, rate/pitch controls, and a user preference to hide the
  control. Explicitly deferred past v1 (see §11).
- Editing/removing the existing `MediaWiki:Common.js` /
  `MediaWiki:Common.css` blocks — Tom does this manually once the
  extension is verified live, since the bot can't edit either page.

## 3. Repo skeleton

Follows the `WantedSort`/`NearMe` convention:

```
PageReader/
  extension.json
  README.md
  DEPLOY.md
  CHANGELOG.md
  LICENSE
  i18n/
    en.json
    qqq.json
  includes/
    Hooks.php
    PageReaderEligibility.php
    PageReaderConfigService.php
  resources/
    ext.pageReader.js
    ext.pageReader.css
  tests/
    phpunit/
      PageReaderEligibilityTest.php
```

`extension.json`: `type: "other"` (no special page), `manifest_version:
2`, `AutoloadNamespaces` → `MediaWiki\Extension\PageReader\`, `Hooks` →
`BeforePageDisplay` and `ParserFirstCallInit` (for the `__NOPAGEREADER__`
switch), `MessagesDirs`, `ResourceModules`, `ResourceFileModulePaths`
(`remoteExtPath: "PageReader"`).

## 4. Configuration

All `$wgPageReader*`, declared with defaults in `extension.json`'s
`"config"` block. Defaults reproduce today's Kids-only Saintapedia
behavior with **zero LocalSettings changes**.

| Variable | Default | Purpose |
|---|---|---|
| `$wgPageReaderEnabled` | `true` | Site-wide kill switch (LocalSettings-only, not wiki-page-overridable). |
| `$wgPageReaderActions` | `['view']` | Only these actions are eligible (excludes edit/history/diff/raw). |
| `$wgPageReaderContentModels` | `['wikitext']` | Only these content models are eligible. |
| `$wgPageReaderIncludeTalk` | `false` | Whether talk pages are eligible. |
| `$wgPageReaderNamespaces` | `[1004]` | Namespaces that are always eligible. |
| `$wgPageReaderTitlePrefixes` | `["Kids:"]` | Titles whose `getPrefixedText()` starts with any entry are eligible. |
| `$wgPageReaderPages` | `["Portal:Kids"]` | Titles that exactly equal, or are a subpage (`Entry/...`) of, any entry are eligible. |
| `$wgPageReaderExcludedNamespaces` | `[]` | Namespaces excluded even if otherwise eligible (checked before the allow-lists). |
| `$wgPageReaderExcludedPages` | `[]` | Pages excluded even if otherwise eligible (same match rule as `Pages`). |
| `$wgPageReaderLoadEverywhere` | `false` | If true, ignore `Namespaces`/`TitlePrefixes`/`Pages` and load on every page that passes the other gates. |
| `$wgPageReaderContentClass` | `"pagereader-content"` | Marker class an editor can put on any element, anywhere in an article, to mark it as the read-aloud content. |
| `$wgPageReaderContentSelector` | `""` | Fallback CSS selector used when no marker element is found. Empty = no fallback (button doesn't appear). |
| `$wgPageReaderSkipSelectors` | `.infobox, .navbox, .toc, .thumb, .reflist, .mw-editsection, .printfooter, .catlinks` | Elements stripped from a clone of the content root before reading `textContent`. |
| `$wgPageReaderButtonPlacement` | `"before-content"` | One of `before-content` \| `after-heading` \| `top-of-content`. |
| `$wgPageReaderConfigPage` | `"PageReader-config"` | Name of a `MediaWiki:`-namespace JSON page (see §5) that can override the above (except `Enabled`). Empty string disables the overlay. |

All title-shaped config entries (`TitlePrefixes`, `Pages`,
`ExcludedPages`) are normalized once via `Title::newFromText()` so
`"portal:kids"` and `"Portal:Kids"` behave identically, and matched
against `$title->getPrefixedText()` (spaces not underscores, includes
namespace).

## 5. On-wiki config overlay

Mirrors `NearMeConfigService` exactly:

- `PageReaderConfigService::getConfig( IContextSource $context )` reads
  `$wgPageReaderConfigPage` (skip if empty), resolves
  `Title::makeTitleSafe( NS_MEDIAWIKI, $pageName )`, and if it exists,
  caches the parsed/normalized result in `MainWANObjectCache` keyed on
  `$title->getLatestRevID()` (auto-invalidates on edit — no explicit
  purge hook needed) with a `CACHE_TTL` of 300s as a safety net.
- JSON parsing is tolerant of wikitext wrappers (`<pre>`/`<nowiki>`)
  via the same `preg_match( '/\{.*\}/s', ... )` extraction NearMe uses.
- Malformed or missing values fall back to the corresponding
  `$wgPageReader*` value field-by-field — a broken wiki page degrades
  to LocalSettings behavior, it never breaks eligibility checking.
- Overridable fields: `namespaces`, `titlePrefixes`, `pages`,
  `excludedNamespaces`, `excludedPages`, `loadEverywhere`,
  `contentClass`, `contentSelector`, `skipSelectors`,
  `buttonPlacement`. `enabled` is intentionally **not** overridable
  here — that stays a sysadmin-only switch.

## 6. Eligibility (`PageReaderEligibility`)

A small, stateless helper — `isEligible( Title $title, string $action,
Config $config, ?ConfigOverlay $overlay = null ): bool` — kept separate
from `Hooks::onBeforePageDisplay` specifically so it's unit-testable
without constructing a full `OutputPage`/`RequestContext`. Checked in
order (cheapest/most-decisive first):

1. `!$config->enabled` → false.
2. `$action` not in `Actions` → false.
3. `$title->getContentModel()` not in `ContentModels` → false.
4. `$title->isTalkPage() && !IncludeTalk` → false.
5. `$title->isRedirect()` → false.
6. Page has the `__NOPAGEREADER__` property set (see §7) → false.
7. `$title->getNamespace()` in `ExcludedNamespaces` → false.
8. `$title` matches (exact-or-subpage) any `ExcludedPages` entry → false.
9. `LoadEverywhere` → true.
10. Else: `$title->getNamespace()` in `Namespaces`, OR
    `getPrefixedText()` starts with any `TitlePrefixes` entry, OR
    `$title` matches (exact-or-subpage) any `Pages` entry → true.
11. Else → false.

`Hooks::onBeforePageDisplay` calls this once; on true, calls
`$out->addModules( 'ext.pageReader' )`.

## 7. Per-page editor opt-out

A `__NOPAGEREADER__` behavior switch (same mechanism core uses for
`__NOTOC__`/`__NOGALLERY__`): registered via `ParserFirstCallInit`,
detected during parse, sets a page property
(`$parser->getOutput()->setPageProperty( 'noPageReader', '1' )`). In
`BeforePageDisplay`, `$out->getProperty( 'noPageReader' )` is checked as
eligibility step 6 above. This lets a content editor turn the button off
on one specific page directly from wikitext — no config access or
LocalSettings/wiki-JSON edit required.

## 8. Content targeting

The JS looks for an element with class `$wgPageReaderContentClass`
(default `pagereader-content`) anywhere in the rendered content root
(`document` on initial load, or the `$content` node passed by
`wikipage.content`). Because an editor controls where that class goes
in their own wikitext, this is inherently "the button can go anywhere
on a page" — no new parser tag is needed.

If no marker element is found and `$wgPageReaderContentSelector` is
non-empty, that selector is tried against the page content area as a
whole-article fallback. If neither resolves to an element, the module
no-ops (no button inserted) — this is the expected steady state on the
vast majority of eligible-but-marker-less pages once `LoadEverywhere`
is used on a wiki that hasn't marked up content yet.

Once a content root is found, a **clone** of it has every element
matching any `$wgPageReaderSkipSelectors` entry removed before
`.textContent` is read for speech — this keeps TTS from reading "edit,"
infobox/table cell soup, references, or category links. The clone is
discarded after reading `textContent`; the live DOM is never mutated.

Button insertion point follows `$wgPageReaderButtonPlacement`:
- `before-content` (default): immediately before the content root,
  matching the exact current Kids behavior.
- `after-heading`: after `#firstHeading`.
- `top-of-content`: as the first child of the content root.

## 9. JS behavior (port fidelity)

Ported from `kids-readaloud.js` with the isolation-of-behavior
guarantees preserved exactly:

- Duplicate-guard: `data-pagereader-bound` attribute check, same as
  the reference's `data-kids-bound`.
- `SpeechSynthesisUtterance` over the (skip-selector-filtered) content
  `textContent`; `speechSynthesis.cancel()` before speaking to avoid
  overlapping utterances.
- Button label toggles via i18n messages: **"Read this page aloud"** ↔
  **"Stop reading"** (this wording, not the reference's "Read this
  aloud" — per the original task spec). `aria-pressed` toggled
  true/false. `kids-readaloud-speaking`-equivalent class
  (`pagereader-speaking`) added/removed for the pulse animation.
- If `speechSynthesis` is unavailable, the button is hidden
  (`display: none`) rather than removed, matching the reference.
- Runs on `mw.hook( 'wikipage.content' ).add( init )` with a
  `DOMContentLoaded` fallback when `mw.hook` isn't available, so it
  fires on both initial load and AJAX-rendered content (e.g. VisualEditor
  previews, InstantCommons-style content swaps).
- **The entire init path is wrapped in try/catch, both at the outer
  IIFE level and inside the per-invocation init function**, matching
  the reference and the explicit safety requirement from the outage:
  a failure here must never be able to propagate and affect other page
  functionality.

CSS (`ext.pageReader.css`) is exactly the `.kids-readaloud-button` /
`.kids-readaloud-speaking` / `@keyframes kids-readaloud-pulse` /
`prefers-reduced-motion` / print rules from `kids-styles.css`, renamed
to `.pagereader-button` / `.pagereader-speaking`, with the shared CSS
custom properties (`--kids-gold`, `--kids-navy-deep`, `--kids-terracotta`,
etc.) resolved to their literal hex values, since those variables are
declared on a `MediaWiki:Common.css` selector group that is **not**
moving (see §2, out of scope) and won't be in scope for elements that
only carry the new `.pagereader-button` class.

## 10. ResourceLoader module

```jsonc
"ext.pageReader": {
  "scripts": [ "resources/ext.pageReader.js" ],
  "styles": [ "resources/ext.pageReader.css" ],
  "dependencies": [ "mediawiki.util" ],
  "messages": [
    "pagereader-button-label",
    "pagereader-button-label-stop"
  ],
  "targets": [ "desktop", "mobile" ]
}
```

`targets` includes `mobile` (Minerva) deliberately — Kids traffic is
phone-heavy, and there's no reason to exclude it.

## 11. Explicitly deferred (not v1)

- Voice picker / rate / pitch controls.
- Persisting user voice/rate choice in `localStorage`.
- A user preference to hide the control.
- Sentence-level chunking (vs. reading the whole filtered `textContent`
  in one utterance) — only relevant if Chrome's utterance length limits
  become an actual problem in practice.

These were raised during design review as good v2 candidates but add
meaningful surface area (a persisted-settings UI, cross-browser voice
enumeration quirks) that isn't needed to safely port and generalize the
existing Kids behavior.

## 12. Testing

**PHPUnit** (`PageReaderEligibilityTest`), covering:
- `Enabled = false` → false regardless of everything else.
- Namespace in `ExcludedNamespaces` → false even if also in `Namespaces`.
- Namespace `1004` → true (default).
- `Kids:Foo` → true (default `TitlePrefixes`).
- `Portal:Kids` → true; `Portal:Kids/Bar` → true; `Portal:KidsCorner` →
  **false** (must not falsely match — this is the case the exact-or-
  subpage match rule exists to prevent).
- `action=edit` → false. Non-`wikitext` content model → false.
- Page with `__NOPAGEREADER__` set → false even in namespace `1004`.
- `LoadEverywhere = true` with an otherwise-ineligible page → true.

**Manual smoke test** on the local Canasta dev instance:
- Load a `Kids:` page and `Portal:Kids` — button appears once, toggles
  label/class/`aria-pressed` correctly, stops on second click and on
  utterance end.
- Load a non-Kids page — confirm the `ext.pageReader` module is **not**
  requested (Special:Version module list / network panel).
- Add `__NOPAGEREADER__` to a Kids page — confirm the button no longer
  appears and the module isn't loaded.
- Edit `MediaWiki:PageReader-config` with an override (e.g. add a
  namespace) — confirm it takes effect without a restart, and that an
  invalid JSON edit degrades gracefully to the LocalSettings defaults.

## 13. Deploy notes (for `DEPLOY.md`)

- Going wiki-wide on another wiki: `$wgPageReaderLoadEverywhere = true;`
  with empty `TitlePrefixes`/`Pages`.
- Disabling Saintapedia's Kids behavior without uninstalling:
  `$wgPageReaderEnabled = false;`.
- `1004` and `"Kids:"` are documented as **Saintapedia-specific
  defaults**, not hardcoded assumptions — other wikis should expect to
  either override them in LocalSettings or via
  `MediaWiki:PageReader-config`.
- After the extension is verified live: Tom manually removes the
  corresponding JS block from `MediaWiki:Common.js` and the
  `.kids-readaloud-button`/`.kids-readaloud-speaking`/
  `@keyframes kids-readaloud-pulse` rules from `MediaWiki:Common.css`
  (the bot cannot edit either protected page).
