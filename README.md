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
- Optional on-wiki JSON overlay (`MediaWiki:PageReader-config`) lets a
  wiki editor with `MediaWiki:` page rights adjust eligibility and
  content-targeting without a code deploy — see [DEPLOY.md](./DEPLOY.md).
- A content editor can opt a single page out with `__NOPAGEREADER__`
  anywhere in that page's wikitext — no config access needed.
- The button can be placed anywhere in any article: put
  `class="pagereader-content"` (configurable) on any wrapper element,
  and the button is inserted immediately before it.

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
