# PageReader

MediaWiki extension providing a config-driven, conditionally-loaded
**read-aloud button** ("Saintapedia Reader") — ported out of
`MediaWiki:Common.js`/`MediaWiki:Common.css` so a stale-cache failure of
the shared site JS module can never take down unrelated features again
(see [the design spec](docs/superpowers/specs/2026-09-09-pagereader-design.md)
for the full history and rationale).

## Features

- Loads its ResourceLoader module only on eligible pages, decided
  server-side via `BeforePageDisplay` — never shipped to pages that
  don't need it.
- Eligibility is namespace / title-prefix / exact-or-subpage
  configurable via `$wgPageReader*` LocalSettings, with sensible
  defaults reproducing Saintapedia's Kids-only behavior out of the box.
- Optional on-wiki JSON overlay (`MediaWiki:PageReader-config`, requires
  `editinterface` to edit) lets a sysop adjust eligibility and
  content-targeting without a code deploy — see [DEPLOY.md](./DEPLOY.md)
  for the exact list of overridable keys.
- A content editor can opt a single page out with `__NOPAGEREADER__`
  anywhere in that page's wikitext — no config access needed.
- The button can be placed anywhere in any article: put
  `class="kids-readaloud"` (configurable via `$wgPageReaderContentClass`
  — the default matches existing Saintapedia Kids content) on any
  wrapper element, and the button is inserted immediately before it.
- Editor-friendly wikitext templates (not code — see DEPLOY.md) let any
  editor mark read-aloud content and control button placement without
  touching raw HTML or LocalSettings: a `{{ReadAloud/start}}` /
  `{{ReadAloud/end}}` pair marks the content boundary anywhere on any
  page, and an optional `{{ReadAloudButton}}` marker overrides where
  the button itself appears on that page, taking priority over the
  site-wide `$wgPageReaderButtonPlacement` setting.
- Speech pitch/rate default to a brighter, gentler pace than a
  browser's flat default TTS voice (`$wgPageReaderVoicePitch` /
  `$wgPageReaderVoiceRate`, both sysop-tunable), and a voice-gender
  select (`$wgPageReaderVoiceGender`: female/male/auto, defaulting to
  female, best-effort name matching against the browser's available
  voices) appears next to the button — a reader's own choice there is
  remembered per-browser via `localStorage` and overrides the site
  default. `$wgPageReaderPreferredVoices` lets a sysop curate specific
  known-good voice names per gender (e.g. macOS's "Samantha", which
  doesn't have "female" in its name) that take priority over the
  generic name match. On Firefox, the pitch/rate tuning is skipped in
  favor of the browser's own default (1/1) — Firefox on Linux (via its
  speech-dispatcher/espeak-ng bridge) was found to badly garble audio at
  a non-default pitch/rate on an otherwise-unaffected voice; voice-gender
  selection is unaffected and still applies normally on Firefox.
- A pause/resume button appears next to the voice select once speech
  starts (feature-detected — omitted entirely on a browser without
  `speechSynthesis.pause`/`resume` support).
- Read-along highlighting: the article is split into sentences
  client-side and spoken as a chain of utterances, highlighting the
  sentence currently playing (sentence-level, not word-level — chosen
  for reliability across browsers, since `speechSynthesis`'s
  word-boundary events are notoriously inconsistent). Controlled by
  `$wgPageReaderHighlightEnabled` (default `true`); disabling it falls
  back to a single utterance for the whole article with no
  highlighting.

## Title-prefix matching rules

`$wgPageReaderTitlePrefixes` (default `["Kids:"]`) matches with a plain,
**case-sensitive** `str_starts_with()` against `Title::getPrefixedText()`
(spaces, not underscores) — unlike `$wgPageReaderPages`/
`$wgPageReaderExcludedPages`, prefix entries are **not** normalized via
`Title::newFromText()`. This means `"kids:"` will not match `Kids:Foo`,
and a prefix written with an underscore (`"Kids:Foo_bar"`) will not match
the prefixed text form (`Kids:Foo bar`, space). Write prefixes exactly as
they should appear in `Title::getPrefixedText()` output.

## Testing

PHP: `tests/phpunit/` (run via MediaWiki core's PHPUnit — see DEPLOY.md's
local dev notes).

JS: `resources/ext.pageReader.js` has no PHPUnit coverage of its own, so
`tests/node/ext.pageReader.test.js` loads it into a real DOM via
[jsdom](https://github.com/jsdom/jsdom) (mocking `mw.config`/`mw.msg`/
`mw.hook` and `speechSynthesis`) and actually clicks the button —
covering button placement/insertion, the duplicate-button guard across
all three `PageReaderButtonPlacement` modes, label/`aria-pressed`/class
toggling, skip-selector filtering (including a malformed selector, which
must not abort speech), and the content-fallback-selector path.

Accessibility: `tests/node/accessibility.test.js` runs an
[axe-core](https://github.com/dequelabs/axe-core) structural/ARIA scan
against the button in both idle and "speaking" states, plus WCAG 2 AA
color-contrast checks computed directly from the literal hex values in
`ext.pageReader.css` (jsdom has no rendering engine, so axe's own
canvas-based contrast check can't run reliably — this is a more precise
substitute for colors that are static, not computed). See
[DEPLOY.md](./DEPLOY.md)'s accessibility checklist for what's still
manual (a VoiceOver/JAWS pass).

```bash
npm install
npm test
```

## Requirements

- MediaWiki **≥ 1.43.0**
- PHP version required by that MediaWiki release
- Node.js (for `npm test` only — not needed to run the extension itself)

## Installation

```bash
cd /path/to/mediawiki/extensions
git clone https://github.com/Saintapedia/reader.git PageReader
```

```php
wfLoadExtension( 'PageReader' );
```

Canasta `settings.yaml`:
```yaml
extensions:
  - PageReader
```

Saintapedia needs **no further configuration** — the shipped defaults
reproduce today's Kids-namespace/`Kids:`/`Portal:Kids` behavior exactly.
See [DEPLOY.md](./DEPLOY.md) for other wikis' configuration options and
the Common.js/Common.css cleanup step.
