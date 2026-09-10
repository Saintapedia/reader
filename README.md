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

## Title-prefix matching rules

`$wgPageReaderTitlePrefixes` (default `["Kids:"]`) matches with a plain,
**case-sensitive** `str_starts_with()` against `Title::getPrefixedText()`
(spaces, not underscores) — unlike `$wgPageReaderPages`/
`$wgPageReaderExcludedPages`, prefix entries are **not** normalized via
`Title::newFromText()`. This means `"kids:"` will not match `Kids:Foo`,
and a prefix written with an underscore (`"Kids:Foo_bar"`) will not match
the prefixed text form (`Kids:Foo bar`, space). Write prefixes exactly as
they should appear in `Title::getPrefixedText()` output.

## Requirements

- MediaWiki **≥ 1.43.0**
- PHP version required by that MediaWiki release

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
