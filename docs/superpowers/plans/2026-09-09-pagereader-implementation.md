# PageReader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Kids read-aloud button out of `MediaWiki:Common.js`/`MediaWiki:Common.css` into a standalone, config-driven MediaWiki extension (`PageReader`) with its own conditionally-loaded ResourceLoader module.

**Architecture:** A `PageReaderEligibility` helper (pure, unit-testable) decides — from `Title`, request action, and `Config` — whether a page qualifies. `Hooks::onBeforePageDisplay` calls it, adds a cheap DB-backed `__NOPAGEREADER__` page-property check only for pages that already pass, then loads `ext.pageReader` (JS+CSS) and passes JS-side config via `addJsConfigVars`. A `PageReaderConfigService` optionally overlays `MediaWiki:PageReader-config` (JSON) on top of LocalSettings, cached via `WANObjectCache` keyed on the page's latest revision ID, mirroring `Saintapedia/NearMe`'s `NearMeConfigService`.

**Tech Stack:** MediaWiki extension (PHP 8.1+, MediaWiki ≥ 1.43.0), plain JS (no build step, matches WantedSort/NearMe), PHPUnit (`MediaWikiIntegrationTestCase`, run via MediaWiki core's `tests/phpunit/phpunit.php`).

**Spec:** `docs/superpowers/specs/2026-09-09-pagereader-design.md`

## Global Constraints

- Extension technical name: `PageReader`. Branding/display name: "Saintapedia Reader". Config prefix: `$wgPageReader*`.
- Repo: `https://github.com/Saintapedia/reader`. Skeleton follows `Saintapedia/WantedSort` and `Saintapedia/NearMe` conventions (extension.json shape, `AutoloadNamespaces` → `MediaWiki\Extension\PageReader\`, `ResourceFileModulePaths.remoteExtPath: "PageReader"`).
- Defaults must reproduce today's exact Saintapedia Kids-only behavior with **zero LocalSettings changes**: `PageReaderNamespaces = [1004]`, `PageReaderTitlePrefixes = ["Kids:"]`, `PageReaderPages = ["Portal:Kids"]`.
- Button label strings, exactly: **"Read this page aloud"** ↔ **"Stop reading"** (not the reference repo's "Read this aloud").
- Every JS entry point wrapped in try/catch — a failure here must never affect other page JS (this is the entire reason this extension exists; see spec §1).
- Out of scope: do not touch `MediaWiki:Common.js`/`MediaWiki:Common.css`, Kids infobox/portal CSS, or anything beyond the read-aloud button (spec §2). Voice picker, rate/pitch, and a user preference are explicitly deferred (spec §11) — do not build them.
- License: GPL-2.0-or-later (matches `WantedSort`).
- Git identity for commits in this repo: `user.name "Saintapedia"`, `user.email "tom@saintapedia.org"` (already configured locally; do not change it).
- Commit messages end with the attribution footer already used in this session:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01YSCWs5rSLs1bRpMav3nq7C
  ```

---

## Task 1: Extension skeleton and config registration

**Files:**
- Create: `extension.json`
- Create: `LICENSE` (GPL-2.0-or-later text)
- Create: `composer.json`
- Create: `phpcs.xml`
- Create: `.gitignore`

**Interfaces:**
- Produces: the full `$wgPageReader*` config surface (names, types, defaults) that every later task's code reads via `Config::get( 'PageReaderX' )`.

- [ ] **Step 1: Create `extension.json` with name, license, requirements, autoloading, and every config default**

```json
{
	"name": "PageReader",
	"version": "0.1.0",
	"author": [ "Saintapedia contributors" ],
	"url": "https://github.com/Saintapedia/reader",
	"descriptionmsg": "pagereader-desc",
	"license-name": "GPL-2.0-or-later",
	"type": "other",
	"manifest_version": 2,
	"requires": {
		"MediaWiki": ">= 1.43.0"
	},
	"AutoloadNamespaces": {
		"MediaWiki\\Extension\\PageReader\\": "includes/"
	},
	"MessagesDirs": {
		"PageReader": [ "i18n" ]
	},
	"config": {
		"PageReaderEnabled": {
			"value": true,
			"description": "Site-wide kill switch. LocalSettings-only; not overridable via MediaWiki:PageReader-config."
		},
		"PageReaderActions": {
			"value": [ "view" ],
			"description": "Request actions eligible for the read-aloud module."
		},
		"PageReaderContentModels": {
			"value": [ "wikitext" ],
			"description": "Content models eligible for the read-aloud module."
		},
		"PageReaderIncludeTalk": {
			"value": false,
			"description": "Whether talk pages are eligible."
		},
		"PageReaderNamespaces": {
			"value": [ 1004 ],
			"description": "Namespaces that are always eligible. Default (1004) is Saintapedia's Kids namespace."
		},
		"PageReaderTitlePrefixes": {
			"value": [ "Kids:" ],
			"description": "Titles whose prefixed text starts with any of these strings are eligible."
		},
		"PageReaderPages": {
			"value": [ "Portal:Kids" ],
			"description": "Titles that exactly equal, or are a subpage of, any of these are eligible."
		},
		"PageReaderExcludedNamespaces": {
			"value": [],
			"description": "Namespaces excluded even if otherwise eligible. Checked before the allow-lists."
		},
		"PageReaderExcludedPages": {
			"value": [],
			"description": "Pages excluded even if otherwise eligible (same match rule as PageReaderPages)."
		},
		"PageReaderLoadEverywhere": {
			"value": false,
			"description": "If true, ignore PageReaderNamespaces/TitlePrefixes/Pages and load on every page passing the other gates."
		},
		"PageReaderContentClass": {
			"value": "pagereader-content",
			"description": "CSS class marking the element to read aloud. An editor can place it anywhere in any article."
		},
		"PageReaderContentSelector": {
			"value": "",
			"description": "Fallback CSS selector used when no PageReaderContentClass element is found. Empty = no fallback."
		},
		"PageReaderSkipSelectors": {
			"value": [
				".infobox", ".navbox", ".toc", ".thumb", ".reflist",
				".mw-editsection", ".printfooter", ".catlinks"
			],
			"description": "Elements stripped from a clone of the content root before reading textContent."
		},
		"PageReaderButtonPlacement": {
			"value": "before-content",
			"description": "One of: before-content, after-heading, top-of-content."
		},
		"PageReaderConfigPage": {
			"value": "PageReader-config",
			"description": "MediaWiki:-namespace JSON page overriding the above (except Enabled). Empty string disables the overlay."
		}
	},
	"ResourceFileModulePaths": {
		"localBasePath": "",
		"remoteExtPath": "PageReader"
	}
}
```

- [ ] **Step 2: Create `LICENSE`**

```
                    GNU GENERAL PUBLIC LICENSE
                       Version 2, June 1991
```

Copy the full standard GPL-2.0-or-later text used by `WantedSort`'s `LICENSE` file verbatim (do not paraphrase a license).

- [ ] **Step 3: Create `composer.json`**

```json
{
	"name": "saintapedia/pagereader",
	"description": "MediaWiki extension: config-driven, conditionally-loaded read-aloud button",
	"license": "GPL-2.0-or-later",
	"require": {
		"php": ">=8.1"
	},
	"require-dev": {
		"mediawiki/mediawiki-codesniffer": "^44.0",
		"mediawiki/minus-x": "^1.1",
		"php-parallel-lint/php-parallel-lint": "^1.3"
	},
	"scripts": {
		"test": [
			"parallel-lint --exclude vendor .",
			"phpcs -p -s"
		],
		"fix": [
			"phpcbf"
		]
	},
	"config": {
		"allow-plugins": {
			"dealerdirect/phpcodesniffer-composer-installer": true
		}
	}
}
```

- [ ] **Step 4: Create `phpcs.xml`**

```xml
<?xml version="1.0"?>
<ruleset name="PageReader">
	<rule ref="./vendor/mediawiki/mediawiki-codesniffer/MediaWiki" />
	<file>.</file>
	<exclude-pattern>vendor/</exclude-pattern>
</ruleset>
```

- [ ] **Step 5: Create `.gitignore`**

```
/vendor/
/node_modules/
.phpunit.result.cache
```

- [ ] **Step 6: Validate `extension.json` is well-formed and has every required key**

Run:
```bash
php -r '
$json = json_decode(file_get_contents("extension.json"), true);
if ($json === null) { fwrite(STDERR, "invalid JSON\n"); exit(1); }
foreach (["name","version","license-name","manifest_version","AutoloadNamespaces","config"] as $key) {
    if (!array_key_exists($key, $json)) { fwrite(STDERR, "missing $key\n"); exit(1); }
}
foreach (["PageReaderEnabled","PageReaderNamespaces","PageReaderTitlePrefixes","PageReaderPages",
          "PageReaderExcludedNamespaces","PageReaderExcludedPages","PageReaderLoadEverywhere",
          "PageReaderContentClass","PageReaderContentSelector","PageReaderSkipSelectors",
          "PageReaderButtonPlacement","PageReaderConfigPage","PageReaderActions",
          "PageReaderContentModels","PageReaderIncludeTalk"] as $key) {
    if (!array_key_exists($key, $json["config"])) { fwrite(STDERR, "missing config.$key\n"); exit(1); }
}
echo "OK\n";
'
```
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add extension.json LICENSE composer.json phpcs.xml .gitignore
git commit -m "$(cat <<'EOF'
Add extension skeleton and full PageReader config surface

Registers every $wgPageReader* default up front so later tasks only
add behavior, not new config wiring.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YSCWs5rSLs1bRpMav3nq7C
EOF
)"
```

- [ ] **Step 8: Symlink into the local Canasta dev instance so PHPUnit has somewhere to run**

Every later task runs `php tests/phpunit/phpunit.php --group PageReader` — that command needs the extension loaded into a real MediaWiki install *now*, not just at final verification (Task 9). Do this once, here:

```bash
ln -sfn /home/tom/extensions/reader \
  /home/tom/canasta-workspace/dev/mediawiki-code/extensions/PageReader
```

Add `wfLoadExtension( 'PageReader' );` to the dev instance's LocalSettings (or `config/wikis.yaml`, matching how WantedSort/NearMe are enabled there), restart the dev instance, and confirm `Special:Version` lists **PageReader** with no fatal. From here on, every task's PHPUnit command is run as:
```bash
cd /home/tom/canasta-workspace/dev/mediawiki-code
php tests/phpunit/phpunit.php --group PageReader
```

---

## Task 2: PageReaderEligibility helper

**Files:**
- Create: `includes/PageReaderEligibility.php`
- Test: `tests/phpunit/PageReaderEligibilityTest.php`

**Interfaces:**
- Consumes: `Config::get( 'PageReaderEnabled'|'PageReaderActions'|'PageReaderContentModels'|'PageReaderIncludeTalk'|'PageReaderNamespaces'|'PageReaderTitlePrefixes'|'PageReaderPages'|'PageReaderExcludedNamespaces'|'PageReaderExcludedPages'|'PageReaderLoadEverywhere' )`.
- Produces: `PageReaderEligibility::isEligible( Title $title, string $action, Config $config ): bool` — used by `Hooks::onBeforePageDisplay` (Task 4) as the first, DB-free gate. **Does not** check the `__NOPAGEREADER__` page property — that is a separate, DB-backed check Task 4 performs only for titles this method already approves (keeps the DB lookup off the hot path for the vast majority of ineligible page views).

- [ ] **Step 1: Write the failing tests**

Create `tests/phpunit/PageReaderEligibilityTest.php`:

```php
<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader\Tests;

use MediaWiki\Extension\PageReader\PageReaderEligibility;
use MediaWiki\Title\Title;
use MediaWikiIntegrationTestCase;

/**
 * @covers \MediaWiki\Extension\PageReader\PageReaderEligibility
 * @group PageReader
 */
class PageReaderEligibilityTest extends MediaWikiIntegrationTestCase {

	private function setConfig( array $overrides = [] ): void {
		$this->overrideConfigValues( $overrides + [
			'PageReaderEnabled' => true,
			'PageReaderActions' => [ 'view' ],
			'PageReaderContentModels' => [ 'wikitext' ],
			'PageReaderIncludeTalk' => false,
			'PageReaderNamespaces' => [ 1004 ],
			'PageReaderTitlePrefixes' => [ 'Kids:' ],
			'PageReaderPages' => [ 'Portal:Kids' ],
			'PageReaderExcludedNamespaces' => [],
			'PageReaderExcludedPages' => [],
			'PageReaderLoadEverywhere' => false,
		] );
	}

	private function config() {
		return $this->getServiceContainer()->getMainConfig();
	}

	public function testDisabledSiteWideIsNeverEligible(): void {
		$this->setConfig( [ 'PageReaderEnabled' => false ] );
		$title = Title::makeTitle( 1004, 'AnyPage' );

		$this->assertFalse(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testExcludedNamespaceWinsOverIncludedNamespace(): void {
		$this->setConfig( [ 'PageReaderExcludedNamespaces' => [ 1004 ] ] );
		$title = Title::makeTitle( 1004, 'AnyPage' );

		$this->assertFalse(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testDefaultNamespaceIsEligible(): void {
		$this->setConfig();
		$title = Title::makeTitle( 1004, 'AnyPage' );

		$this->assertTrue(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testKidsPrefixIsEligible(): void {
		$this->setConfig();
		$title = Title::makeTitle( NS_MAIN, 'Kids:Foo' );

		$this->assertTrue(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testPortalKidsExactIsEligible(): void {
		$this->setConfig();
		$title = Title::makeTitle( NS_MAIN, 'Portal:Kids' );

		$this->assertTrue(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testPortalKidsSubpageIsEligible(): void {
		$this->setConfig();
		$title = Title::makeTitle( NS_MAIN, 'Portal:Kids/Bar' );

		$this->assertTrue(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testPortalKidsCornerIsNotFalselyEligible(): void {
		$this->setConfig();
		$title = Title::makeTitle( NS_MAIN, 'Portal:KidsCorner' );

		$this->assertFalse(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testEditActionIsNotEligible(): void {
		$this->setConfig();
		$title = Title::makeTitle( 1004, 'AnyPage' );

		$this->assertFalse(
			PageReaderEligibility::isEligible( $title, 'edit', $this->config() )
		);
	}

	public function testNonWikitextContentModelIsNotEligible(): void {
		$this->setConfig();
		// MediaWiki:Common.js gets the 'javascript' content model by core convention.
		$title = Title::makeTitle( NS_MEDIAWIKI, 'Common.js' );

		$this->assertFalse(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testLoadEverywhereOverridesAllowLists(): void {
		$this->setConfig( [
			'PageReaderLoadEverywhere' => true,
			'PageReaderNamespaces' => [],
			'PageReaderTitlePrefixes' => [],
			'PageReaderPages' => [],
		] );
		$title = Title::makeTitle( NS_MAIN, 'SomeRandomArticle' );

		$this->assertTrue(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testExcludedPageWinsOverLoadEverywhere(): void {
		$this->setConfig( [
			'PageReaderLoadEverywhere' => true,
			'PageReaderExcludedPages' => [ 'Main Page' ],
		] );
		$title = Title::makeTitle( NS_MAIN, 'Main Page' );

		$this->assertFalse(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `php tests/phpunit/phpunit.php --group PageReader` (from the MediaWiki root, with `extensions/PageReader` symlinked or copied in — see Task 9 for the local Canasta path)

Expected: FAIL — `Class "MediaWiki\Extension\PageReader\PageReaderEligibility" not found`

- [ ] **Step 3: Write `includes/PageReaderEligibility.php`**

```php
<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader;

use MediaWiki\Config\Config;
use MediaWiki\Title\Title;

/**
 * Stateless eligibility check: does not touch the database. The
 * __NOPAGEREADER__ per-page opt-out (a page property) is checked
 * separately by Hooks::onBeforePageDisplay, only for titles this
 * class already approves.
 */
class PageReaderEligibility {

	public static function isEligible( Title $title, string $action, Config $config ): bool {
		if ( !$config->get( 'PageReaderEnabled' ) ) {
			return false;
		}

		if ( !in_array( $action, $config->get( 'PageReaderActions' ), true ) ) {
			return false;
		}

		if ( !in_array( $title->getContentModel(), $config->get( 'PageReaderContentModels' ), true ) ) {
			return false;
		}

		if ( $title->isTalkPage() && !$config->get( 'PageReaderIncludeTalk' ) ) {
			return false;
		}

		if ( $title->isRedirect() ) {
			return false;
		}

		if ( in_array( $title->getNamespace(), $config->get( 'PageReaderExcludedNamespaces' ), true ) ) {
			return false;
		}

		if ( self::matchesAnyPage( $title, $config->get( 'PageReaderExcludedPages' ) ) ) {
			return false;
		}

		if ( $config->get( 'PageReaderLoadEverywhere' ) ) {
			return true;
		}

		if ( in_array( $title->getNamespace(), $config->get( 'PageReaderNamespaces' ), true ) ) {
			return true;
		}

		if ( self::matchesAnyPrefix( $title, $config->get( 'PageReaderTitlePrefixes' ) ) ) {
			return true;
		}

		if ( self::matchesAnyPage( $title, $config->get( 'PageReaderPages' ) ) ) {
			return true;
		}

		return false;
	}

	/**
	 * Plain string-prefix match against the title's prefixed text. Prefixes
	 * such as "Kids:" are not themselves parseable as a Title (no page name
	 * after the colon), so — unlike matchesAnyPage() — no Title::newFromText()
	 * normalization is applied here; site operators are expected to write
	 * the correct casing, which is documented in README.md.
	 *
	 * @param array<int,string> $prefixes
	 */
	private static function matchesAnyPrefix( Title $title, array $prefixes ): bool {
		$text = $title->getPrefixedText();
		foreach ( $prefixes as $prefix ) {
			if ( str_starts_with( $text, $prefix ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Exact-or-subpage match. Each entry is normalized via Title::newFromText()
	 * so "portal:kids" and "Portal:Kids" behave identically. An entry that
	 * doesn't parse to a valid title is skipped.
	 *
	 * @param array<int,string> $pages
	 */
	private static function matchesAnyPage( Title $title, array $pages ): bool {
		$text = $title->getPrefixedText();
		foreach ( $pages as $page ) {
			$normalizedTitle = Title::newFromText( $page );
			if ( $normalizedTitle === null ) {
				continue;
			}
			$normalized = $normalizedTitle->getPrefixedText();
			if ( $text === $normalized || str_starts_with( $text, $normalized . '/' ) ) {
				return true;
			}
		}
		return false;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `php tests/phpunit/phpunit.php --group PageReader`

Expected: `OK (11 tests, ...)`, all green.

- [ ] **Step 5: Commit**

```bash
git add includes/PageReaderEligibility.php tests/phpunit/PageReaderEligibilityTest.php
git commit -m "$(cat <<'EOF'
Add PageReaderEligibility with full test coverage

Pure, DB-free eligibility check covering enabled/actions/content
model/talk/redirect/excluded-namespace/excluded-page/load-everywhere/
namespace/title-prefix/exact-or-subpage matching, including the
Portal:Kids vs Portal:KidsCorner false-positive case.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YSCWs5rSLs1bRpMav3nq7C
EOF
)"
```

---

## Task 3: PageReaderConfigService (on-wiki JSON overlay)

**Files:**
- Create: `includes/PageReaderConfigService.php`
- Test: `tests/phpunit/PageReaderConfigServiceTest.php`

**Interfaces:**
- Consumes: `Config::get( 'PageReaderConfigPage'|'PageReaderNamespaces'|'PageReaderTitlePrefixes'|'PageReaderPages'|'PageReaderExcludedNamespaces'|'PageReaderExcludedPages'|'PageReaderLoadEverywhere'|'PageReaderContentClass'|'PageReaderContentSelector'|'PageReaderSkipSelectors'|'PageReaderButtonPlacement' )`.
- Produces: `PageReaderConfigService::getEffectiveConfig( Config $mainConfig ): array` returning an associative array with exactly the keys `namespaces`, `titlePrefixes`, `pages`, `excludedNamespaces`, `excludedPages`, `loadEverywhere`, `contentClass`, `contentSelector`, `skipSelectors`, `buttonPlacement` — consumed by `Hooks::onBeforePageDisplay` (Task 4) in place of reading those ten `$wgPageReader*` values directly.

- [ ] **Step 1: Write the failing tests**

Create `tests/phpunit/PageReaderConfigServiceTest.php`:

```php
<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader\Tests;

use MediaWiki\Extension\PageReader\PageReaderConfigService;
use MediaWikiIntegrationTestCase;

/**
 * @covers \MediaWiki\Extension\PageReader\PageReaderConfigService
 * @group PageReader
 */
class PageReaderConfigServiceTest extends MediaWikiIntegrationTestCase {

	private function baseConfig( array $overrides = [] ): void {
		$this->overrideConfigValues( $overrides + [
			'PageReaderConfigPage' => 'PageReader-config',
			'PageReaderNamespaces' => [ 1004 ],
			'PageReaderTitlePrefixes' => [ 'Kids:' ],
			'PageReaderPages' => [ 'Portal:Kids' ],
			'PageReaderExcludedNamespaces' => [],
			'PageReaderExcludedPages' => [],
			'PageReaderLoadEverywhere' => false,
			'PageReaderContentClass' => 'pagereader-content',
			'PageReaderContentSelector' => '',
			'PageReaderSkipSelectors' => [ '.infobox' ],
			'PageReaderButtonPlacement' => 'before-content',
		] );
	}

	public function testFallsBackToLocalSettingsWhenPageDoesNotExist(): void {
		$this->baseConfig();
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( [ 1004 ], $effective['namespaces'] );
		$this->assertSame( [ 'Kids:' ], $effective['titlePrefixes'] );
	}

	public function testOverlayOverridesNamespacesWhenPageExists(): void {
		$this->baseConfig();
		$this->editPage( 'MediaWiki:PageReader-config', '{"namespaces": [1004, 2000]}' );
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( [ 1004, 2000 ], $effective['namespaces'] );
		// Fields not present in the overlay still fall back to LocalSettings.
		$this->assertSame( [ 'Kids:' ], $effective['titlePrefixes'] );
	}

	public function testMalformedJsonFallsBackToLocalSettings(): void {
		$this->baseConfig();
		$this->editPage( 'MediaWiki:PageReader-config', 'not valid json {{{' );
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( [ 1004 ], $effective['namespaces'] );
	}

	public function testEmptyConfigPageNameDisablesOverlay(): void {
		$this->baseConfig( [ 'PageReaderConfigPage' => '' ] );
		$this->editPage( 'MediaWiki:PageReader-config', '{"namespaces": [9999]}' );
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( [ 1004 ], $effective['namespaces'] );
	}

	public function testParseJsonConfigExtractsObjectFromNowikiWrapper(): void {
		$service = new PageReaderConfigService();

		$parsed = $service->parseJsonConfig( "<nowiki>\n{\"loadEverywhere\": true}\n</nowiki>" );

		$this->assertSame( [ 'loadEverywhere' => true ], $parsed );
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `php tests/phpunit/phpunit.php --group PageReader`

Expected: FAIL — `Class "MediaWiki\Extension\PageReader\PageReaderConfigService" not found`

- [ ] **Step 3: Write `includes/PageReaderConfigService.php`**

```php
<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader;

use MediaWiki\Config\Config;
use MediaWiki\MediaWikiServices;
use MediaWiki\Title\Title;

/**
 * Loads an optional MediaWiki:<PageReaderConfigPage> JSON overlay on top of
 * $wgPageReader* LocalSettings values, mirroring NearMeConfigService.
 */
class PageReaderConfigService {

	private const CACHE_VERSION = 1;
	private const CACHE_TTL = 300;

	private ?array $resolvedOverlay = null;
	private bool $overlayResolved = false;

	/**
	 * @return array{
	 *   namespaces:array<int,int>,
	 *   titlePrefixes:array<int,string>,
	 *   pages:array<int,string>,
	 *   excludedNamespaces:array<int,int>,
	 *   excludedPages:array<int,string>,
	 *   loadEverywhere:bool,
	 *   contentClass:string,
	 *   contentSelector:string,
	 *   skipSelectors:array<int,string>,
	 *   buttonPlacement:string
	 * }
	 */
	public function getEffectiveConfig( Config $mainConfig ): array {
		$defaults = [
			'namespaces' => $mainConfig->get( 'PageReaderNamespaces' ),
			'titlePrefixes' => $mainConfig->get( 'PageReaderTitlePrefixes' ),
			'pages' => $mainConfig->get( 'PageReaderPages' ),
			'excludedNamespaces' => $mainConfig->get( 'PageReaderExcludedNamespaces' ),
			'excludedPages' => $mainConfig->get( 'PageReaderExcludedPages' ),
			'loadEverywhere' => $mainConfig->get( 'PageReaderLoadEverywhere' ),
			'contentClass' => $mainConfig->get( 'PageReaderContentClass' ),
			'contentSelector' => $mainConfig->get( 'PageReaderContentSelector' ),
			'skipSelectors' => $mainConfig->get( 'PageReaderSkipSelectors' ),
			'buttonPlacement' => $mainConfig->get( 'PageReaderButtonPlacement' ),
		];

		$overlay = $this->getResolvedOverlay( $mainConfig );
		if ( $overlay === null ) {
			return $defaults;
		}

		return array_merge( $defaults, $overlay );
	}

	private function getResolvedOverlay( Config $mainConfig ): ?array {
		if ( $this->overlayResolved ) {
			return $this->resolvedOverlay;
		}
		$this->overlayResolved = true;

		$pageName = (string)$mainConfig->get( 'PageReaderConfigPage' );
		if ( $pageName === '' ) {
			return $this->resolvedOverlay = null;
		}

		$title = Title::makeTitleSafe( NS_MEDIAWIKI, $pageName );
		if ( $title === null || !$title->exists() ) {
			return $this->resolvedOverlay = null;
		}

		$cache = MediaWikiServices::getInstance()->getMainWANObjectCache();
		$key = $cache->makeKey(
			'pagereader-config-overlay',
			self::CACHE_VERSION,
			$title->getLatestRevID()
		);

		$overlay = $cache->getWithSetCallback(
			$key,
			self::CACHE_TTL,
			function () use ( $title ) {
				$wikiPage = MediaWikiServices::getInstance()->getWikiPageFactory()->newFromTitle( $title );
				$content = $wikiPage->getContent();
				if ( $content === null ) {
					return null;
				}

				$raw = $this->parseJsonConfig( $content->getText() );
				if ( $raw === null ) {
					return null;
				}

				return $this->normalizeOverlay( $raw );
			}
		);

		return $this->resolvedOverlay = ( is_array( $overlay ) && $overlay !== [] ) ? $overlay : null;
	}

	/**
	 * @internal For unit tests
	 * @return array<string,mixed>|null
	 */
	public function parseJsonConfig( string $text ): ?array {
		$text = trim( $text );
		if ( $text === '' ) {
			return null;
		}

		if ( preg_match( '/\{.*\}/s', $text, $matches ) ) {
			$text = $matches[0];
		}

		$decoded = json_decode( $text, true );
		if ( !is_array( $decoded ) ) {
			wfDebugLog( 'PageReader', 'Failed to parse MediaWiki:PageReader-config as JSON.' );
			return null;
		}

		return $decoded;
	}

	/**
	 * @param array<string,mixed> $raw
	 * @return array<string,mixed>
	 */
	private function normalizeOverlay( array $raw ): array {
		$overlay = [];

		foreach ( [ 'namespaces', 'excludedNamespaces' ] as $key ) {
			if ( isset( $raw[$key] ) && is_array( $raw[$key] ) ) {
				$overlay[$key] = array_values( array_map( 'intval', $raw[$key] ) );
			}
		}

		foreach ( [ 'titlePrefixes', 'pages', 'excludedPages', 'skipSelectors' ] as $key ) {
			if ( isset( $raw[$key] ) && is_array( $raw[$key] ) ) {
				$overlay[$key] = array_values( array_filter( array_map(
					static function ( $entry ) {
						return is_string( $entry ) ? trim( $entry ) : null;
					},
					$raw[$key]
				), static function ( $entry ) {
					return $entry !== null && $entry !== '';
				} ) );
			}
		}

		if ( isset( $raw['loadEverywhere'] ) ) {
			$overlay['loadEverywhere'] = (bool)$raw['loadEverywhere'];
		}

		foreach ( [ 'contentClass', 'contentSelector', 'buttonPlacement' ] as $key ) {
			if ( isset( $raw[$key] ) && is_string( $raw[$key] ) && trim( $raw[$key] ) !== '' ) {
				$overlay[$key] = trim( $raw[$key] );
			}
		}

		return $overlay;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `php tests/phpunit/phpunit.php --group PageReader`

Expected: `OK (16 tests, ...)`, all green.

- [ ] **Step 5: Commit**

```bash
git add includes/PageReaderConfigService.php tests/phpunit/PageReaderConfigServiceTest.php
git commit -m "$(cat <<'EOF'
Add PageReaderConfigService for the MediaWiki:PageReader-config overlay

Mirrors NearMeConfigService: WANObjectCache keyed on the config page's
latest revision ID, tolerant JSON-in-wikitext parsing, field-by-field
fallback to LocalSettings when the page is absent, empty, or malformed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YSCWs5rSLs1bRpMav3nq7C
EOF
)"
```

---

## Task 4: Hooks — BeforePageDisplay, GetDoubleUnderscoreIDs, and the `__NOPAGEREADER__` magic word

**Files:**
- Create: `includes/Hooks.php`
- Create: `PageReader.i18n.magic.php`
- Modify: `extension.json` (add `Hooks`, `ExtensionMessagesFiles`, `HookHandlers`)
- Test: `tests/phpunit/HooksTest.php`

**Interfaces:**
- Consumes: `PageReaderEligibility::isEligible()` (Task 2), `PageReaderConfigService::getEffectiveConfig()` (Task 3), core's `MediaWikiServices::getInstance()->getPageProps()->getProperties( Title, string ): array`.
- Produces: on a page passing eligibility, `OutputPage::addModules( 'ext.pageReader' )` and `OutputPage::addJsConfigVars` with keys `wgPageReaderContentClass`, `wgPageReaderContentSelector`, `wgPageReaderSkipSelectors`, `wgPageReaderButtonPlacement` — consumed by `ext.pageReader.js` (Task 6).
- The `__NOPAGEREADER__` behavior switch: registering the magic word ID `nopagereader` via `GetDoubleUnderscoreIDs` is sufficient for MediaWiki core to automatically call `ParserOutput::setUnsortedPageProperty( 'nopagereader' )` when the switch appears in wikitext (core's `Parser::handleDoubleUnderscore`, confirmed against MediaWiki 1.43.9 core source at `includes/parser/Parser.php:4139-4141`) — **no `ParserFirstCallInit` hook is needed.**

- [ ] **Step 1: Write the failing tests**

Create `tests/phpunit/HooksTest.php`:

```php
<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader\Tests;

use MediaWiki\Context\RequestContext;
use MediaWiki\Extension\PageReader\Hooks;
use MediaWiki\Extension\PageReader\PageReaderConfigService;
use MediaWiki\Output\OutputPage;
use MediaWiki\Request\FauxRequest;
use MediaWiki\Title\Title;
use MediaWikiIntegrationTestCase;

/**
 * @covers \MediaWiki\Extension\PageReader\Hooks
 * @group PageReader
 * @group Database
 */
class HooksTest extends MediaWikiIntegrationTestCase {

	private function overridePageReaderConfig( array $overrides = [] ): void {
		$this->overrideConfigValues( $overrides + [
			'PageReaderEnabled' => true,
			'PageReaderActions' => [ 'view' ],
			'PageReaderContentModels' => [ 'wikitext' ],
			'PageReaderIncludeTalk' => false,
			'PageReaderNamespaces' => [ 1004 ],
			'PageReaderTitlePrefixes' => [ 'Kids:' ],
			'PageReaderPages' => [ 'Portal:Kids' ],
			'PageReaderExcludedNamespaces' => [],
			'PageReaderExcludedPages' => [],
			'PageReaderLoadEverywhere' => false,
			'PageReaderContentClass' => 'pagereader-content',
			'PageReaderContentSelector' => '',
			'PageReaderSkipSelectors' => [ '.infobox' ],
			'PageReaderButtonPlacement' => 'before-content',
			'PageReaderConfigPage' => '',
		] );
	}

	/**
	 * Calls Hooks::onBeforePageDisplay() directly rather than driving a full
	 * Article::view()+OutputPage::output() page render: BeforePageDisplay
	 * only fires inside OutputPage::output() (confirmed against MediaWiki
	 * 1.43.9 core, includes/Output/OutputPage.php:3186), and output() also
	 * echoes HTML and renders the skin — unnecessary side effects for a
	 * test that only needs to know which modules got added.
	 */
	private function runBeforePageDisplay( string $pageName ): OutputPage {
		$title = Title::newFromText( $pageName );
		$context = new RequestContext();
		$context->setTitle( $title );
		$context->setRequest( new FauxRequest( [ 'action' => 'view' ] ) );
		$context->setConfig( $this->getServiceContainer()->getMainConfig() );

		$out = $context->getOutput();
		$out->setTitle( $title );

		$hooks = new Hooks( new PageReaderConfigService() );
		$hooks->onBeforePageDisplay( $out, $context->getSkin() );

		return $out;
	}

	public function testKidsNamespacePageLoadsModule(): void {
		$this->overridePageReaderConfig();
		$this->editPage( 'Kids:Test page', 'Some kid-friendly content.' );

		$out = $this->runBeforePageDisplay( 'Kids:Test page' );

		$this->assertContains( 'ext.pageReader', $out->getModules() );
	}

	public function testNonKidsPageDoesNotLoadModule(): void {
		$this->overridePageReaderConfig();
		$this->editPage( 'Ordinary page', 'Nothing special here.' );

		$out = $this->runBeforePageDisplay( 'Ordinary page' );

		$this->assertNotContains( 'ext.pageReader', $out->getModules() );
	}

	public function testNoPageReaderSwitchSuppressesModuleOnEligiblePage(): void {
		$this->overridePageReaderConfig();
		$this->editPage( 'Kids:Opted out', "Some content.\n__NOPAGEREADER__" );

		$out = $this->runBeforePageDisplay( 'Kids:Opted out' );

		$this->assertNotContains( 'ext.pageReader', $out->getModules() );
	}

	public function testOnWikiOverlayNamespaceMakesPageEligible(): void {
		$this->overridePageReaderConfig( [ 'PageReaderConfigPage' => 'PageReader-config' ] );
		$this->editPage( 'MediaWiki:PageReader-config', '{"namespaces": [1004, 0]}' );
		$this->editPage( 'Ordinary page under overlay', 'Nothing special, but namespace 0 is now listed.' );

		$out = $this->runBeforePageDisplay( 'Ordinary page under overlay' );

		$this->assertContains( 'ext.pageReader', $out->getModules() );
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `php tests/phpunit/phpunit.php --group PageReader`

Expected: FAIL — `Class "MediaWiki\Extension\PageReader\Hooks" not found` (and/or the magic word `__NOPAGEREADER__` not recognized, since nothing registers it yet).

- [ ] **Step 3: Create `PageReader.i18n.magic.php`**

```php
<?php
/**
 * Magic words for the PageReader extension.
 *
 * @file
 * @ingroup Extensions
 */

$magicWords = [];

/** English (English) */
$magicWords['en'] = [
	'nopagereader' => [ '0', '__NOPAGEREADER__' ],
];
```

- [ ] **Step 4: Write `includes/Hooks.php`**

```php
<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader;

use MediaWiki\Config\HashConfig;
use MediaWiki\Hook\GetDoubleUnderscoreIDsHook;
use MediaWiki\MediaWikiServices;
use MediaWiki\Output\Hook\BeforePageDisplayHook;
use MediaWiki\Output\OutputPage;
use Skin;

class Hooks implements BeforePageDisplayHook, GetDoubleUnderscoreIDsHook {

	private PageReaderConfigService $configService;

	public function __construct( PageReaderConfigService $configService ) {
		$this->configService = $configService;
	}

	public function onGetDoubleUnderscoreIDs( &$doubleUnderscoreIDs ) {
		$doubleUnderscoreIDs[] = 'nopagereader';
	}

	public function onBeforePageDisplay( $out, $skin ): void {
		$title = $out->getTitle();
		if ( $title === null ) {
			return;
		}

		$mainConfig = $out->getConfig();
		if ( !$mainConfig->get( 'PageReaderEnabled' ) ) {
			return;
		}

		// Resolve the on-wiki overlay once. This is the config that must
		// govern eligibility itself (namespaces/prefixes/pages/excluded/
		// loadEverywhere) — not just JS-side content-targeting — otherwise
		// editing MediaWiki:PageReader-config would silently do nothing.
		$effective = $this->configService->getEffectiveConfig( $mainConfig );

		$eligibilityConfig = new HashConfig( [
			'PageReaderEnabled' => true,
			'PageReaderActions' => $mainConfig->get( 'PageReaderActions' ),
			'PageReaderContentModels' => $mainConfig->get( 'PageReaderContentModels' ),
			'PageReaderIncludeTalk' => $mainConfig->get( 'PageReaderIncludeTalk' ),
			'PageReaderNamespaces' => $effective['namespaces'],
			'PageReaderTitlePrefixes' => $effective['titlePrefixes'],
			'PageReaderPages' => $effective['pages'],
			'PageReaderExcludedNamespaces' => $effective['excludedNamespaces'],
			'PageReaderExcludedPages' => $effective['excludedPages'],
			'PageReaderLoadEverywhere' => $effective['loadEverywhere'],
		] );

		$action = $out->getRequest()->getRawVal( 'action', 'view' );

		if ( !PageReaderEligibility::isEligible( $title, $action, $eligibilityConfig ) ) {
			return;
		}

		// DB-backed opt-out check, deliberately run only for pages that
		// already passed the cheap, in-memory eligibility check above.
		$props = MediaWikiServices::getInstance()->getPageProps()
			->getProperties( $title, 'nopagereader' );
		if ( $props !== [] ) {
			return;
		}

		$out->addModules( 'ext.pageReader' );
		$out->addJsConfigVars( [
			'wgPageReaderContentClass' => $effective['contentClass'],
			'wgPageReaderContentSelector' => $effective['contentSelector'],
			'wgPageReaderSkipSelectors' => $effective['skipSelectors'],
			'wgPageReaderButtonPlacement' => $effective['buttonPlacement'],
		] );
	}
}
```

Note: `Actions`/`ContentModels`/`IncludeTalk`/`Enabled` are intentionally read straight from `$mainConfig` (LocalSettings only) since the spec's overlay field list (spec §5) does not include them — only `namespaces`/`titlePrefixes`/`pages`/`excludedNamespaces`/`excludedPages`/`loadEverywhere` (plus the content-targeting fields) are wiki-overlay-able. `getEffectiveConfig()` is still called unconditionally once `PageReaderEnabled` passes — this adds one `Title::exists()`-style lookup per page view sitewide, mitigated by the `WANObjectCache` keyed on the config page's latest revision ID (Task 3), the same cost profile as other per-request lookups core already performs in `BeforePageDisplay`. Skipping it entirely would silently break the on-wiki overlay for the exact use case it was built for (a wiki editor changing namespaces without a deploy), so this cost is accepted rather than optimized away in v1.

- [ ] **Step 5: Register hooks and the magic word file in `extension.json`**

Add to `extension.json`:

```json
	"ExtensionMessagesFiles": {
		"PageReaderMagic": "PageReader.i18n.magic.php"
	},
	"HookHandlers": {
		"main": {
			"class": "MediaWiki\\Extension\\PageReader\\Hooks",
			"services": [ "PageReader.ConfigService" ]
		}
	},
	"Hooks": {
		"BeforePageDisplay": "main",
		"GetDoubleUnderscoreIDs": "main"
	},
```

Since `Hooks` now takes a constructor dependency, register the service. Create `includes/ServiceWiring.php`:

```php
<?php

declare( strict_types = 1 );

use MediaWiki\Extension\PageReader\PageReaderConfigService;
use MediaWiki\MediaWikiServices;

return [
	'PageReader.ConfigService' => static function ( MediaWikiServices $services ): PageReaderConfigService {
		return new PageReaderConfigService();
	},
];
```

Add to `extension.json`:
```json
	"ServiceWiringFiles": [
		"includes/ServiceWiring.php"
	],
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `php tests/phpunit/phpunit.php --group PageReader`

Expected: `OK (20 tests, ...)`, all green.

- [ ] **Step 7: Commit**

```bash
git add includes/Hooks.php includes/ServiceWiring.php PageReader.i18n.magic.php extension.json tests/phpunit/HooksTest.php
git commit -m "$(cat <<'EOF'
Wire up BeforePageDisplay, the __NOPAGEREADER__ switch, and service registration

Eligibility is decided from the overlay-merged effective config (not
raw LocalSettings alone), so editing MediaWiki:PageReader-config can
actually change which pages load the module — the overlay would
otherwise only affect JS-side content targeting, not eligibility.

GetDoubleUnderscoreIDs registers the magic word; core's Parser
automatically records it as a page property (verified against
MediaWiki 1.43.9 core: Parser::handleDoubleUnderscore calls
setUnsortedPageProperty for every registered double-underscore ID),
so no custom parse-time hook is needed. The DB-backed page-props
lookup runs only for titles that already pass the cheap, in-memory
PageReaderEligibility check.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YSCWs5rSLs1bRpMav3nq7C
EOF
)"
```

---

## Task 5: i18n messages

**Files:**
- Create: `i18n/en.json`
- Create: `i18n/qqq.json`

**Interfaces:**
- Produces: message keys `pagereader-desc`, `pagereader-button-label`, `pagereader-button-label-stop` — consumed by `extension.json`'s `descriptionmsg` (already referenced in Task 1) and by `ext.pageReader.js` (Task 6).

- [ ] **Step 1: Create `i18n/en.json`**

```json
{
	"@metadata": {
		"authors": [ "Saintapedia contributors" ]
	},
	"pagereader-desc": "Adds a configurable, conditionally-loaded read-aloud button (\"Saintapedia Reader\")",
	"pagereader-button-label": "Read this page aloud",
	"pagereader-button-label-stop": "Stop reading"
}
```

- [ ] **Step 2: Create `i18n/qqq.json`**

```json
{
	"@metadata": {
		"authors": [ "Saintapedia contributors" ]
	},
	"pagereader-desc": "{{desc|name=PageReader|url=https://github.com/Saintapedia/reader}}",
	"pagereader-button-label": "Label on the read-aloud button before it starts speaking.",
	"pagereader-button-label-stop": "Label on the read-aloud button while it is speaking, to stop it."
}
```

- [ ] **Step 3: Validate both files are well-formed JSON with matching keys**

Run:
```bash
php -r '
$en = json_decode(file_get_contents("i18n/en.json"), true);
$qqq = json_decode(file_get_contents("i18n/qqq.json"), true);
if ($en === null || $qqq === null) { fwrite(STDERR, "invalid JSON\n"); exit(1); }
$enKeys = array_diff(array_keys($en), ["@metadata"]);
$qqqKeys = array_diff(array_keys($qqq), ["@metadata"]);
sort($enKeys); sort($qqqKeys);
if ($enKeys !== $qqqKeys) { fwrite(STDERR, "key mismatch\n"); exit(1); }
echo "OK\n";
'
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add i18n/en.json i18n/qqq.json
git commit -m "$(cat <<'EOF'
Add i18n messages for description and button labels

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YSCWs5rSLs1bRpMav3nq7C
EOF
)"
```

---

## Task 6: ResourceLoader JS module (`ext.pageReader.js`)

**Files:**
- Create: `resources/ext.pageReader.js`

**Interfaces:**
- Consumes: `mw.config.get( 'wgPageReaderContentClass' | 'wgPageReaderContentSelector' | 'wgPageReaderSkipSelectors' | 'wgPageReaderButtonPlacement' )` (set by `Hooks::onBeforePageDisplay`, Task 4); `mw.msg( 'pagereader-button-label' | 'pagereader-button-label-stop' )` (Task 5).
- Produces: a `.pagereader-button` element and a `.pagereader-speaking` class toggle, styled by `ext.pageReader.css` (Task 7).

- [ ] **Step 1: Write `resources/ext.pageReader.js`**

```js
/* PageReader: config-driven read-aloud button. Every entry point is
 * wrapped in try/catch — a failure here must never affect other page JS.
 * This is the entire reason this extension exists (see spec §1: the
 * 2026-09-08/09 outage where a broken shared Common.js module took down
 * unrelated site features).
 */
( function () {
	'use strict';

	function getSkipSelectors() {
		var configured = mw.config.get( 'wgPageReaderSkipSelectors' );
		return Array.isArray( configured ) ? configured : [];
	}

	function buildSpeechText( contentRoot ) {
		var clone = contentRoot.cloneNode( true );
		getSkipSelectors().forEach( function ( selector ) {
			var matches = clone.querySelectorAll( selector );
			for ( var i = 0; i < matches.length; i++ ) {
				matches[ i ].parentNode.removeChild( matches[ i ] );
			}
		} );
		return clone.textContent;
	}

	function bindButton( button, contentRoot ) {
		if ( !button || button.getAttribute( 'data-pagereader-bound' ) === '1' ) {
			return;
		}
		button.setAttribute( 'data-pagereader-bound', '1' );
		button.setAttribute( 'type', 'button' );

		var labelIdle = mw.msg( 'pagereader-button-label' );
		var labelStop = mw.msg( 'pagereader-button-label-stop' );
		button.textContent = labelIdle;

		var speaking = false;

		function stopSpeaking() {
			speaking = false;
			button.textContent = labelIdle;
			button.classList.remove( 'pagereader-speaking' );
			button.setAttribute( 'aria-pressed', 'false' );
		}

		button.addEventListener( 'click', function () {
			if ( speaking ) {
				window.speechSynthesis.cancel();
				stopSpeaking();
				return;
			}
			var utterance = new window.SpeechSynthesisUtterance( buildSpeechText( contentRoot ) );
			utterance.onend = stopSpeaking;
			utterance.onerror = stopSpeaking;
			window.speechSynthesis.cancel();
			window.speechSynthesis.speak( utterance );
			speaking = true;
			button.textContent = labelStop;
			button.classList.add( 'pagereader-speaking' );
			button.setAttribute( 'aria-pressed', 'true' );
		} );
	}

	function findContentRoot( root ) {
		var contentClass = mw.config.get( 'wgPageReaderContentClass' );
		if ( contentClass ) {
			if ( root.classList && root.classList.contains( contentClass ) ) {
				return root;
			}
			if ( root.querySelector ) {
				var marked = root.querySelector( '.' + contentClass );
				if ( marked ) {
					return marked;
				}
			}
		}

		var fallbackSelector = mw.config.get( 'wgPageReaderContentSelector' );
		if ( fallbackSelector && root.querySelector ) {
			return root.querySelector( fallbackSelector );
		}

		return null;
	}

	function insertButton( content ) {
		var placement = mw.config.get( 'wgPageReaderButtonPlacement' ) || 'before-content';
		var button = document.createElement( 'button' );
		button.className = 'pagereader-button';
		button.setAttribute( 'aria-pressed', 'false' );

		if ( placement === 'after-heading' ) {
			var heading = document.getElementById( 'firstHeading' );
			if ( heading && heading.parentNode ) {
				heading.parentNode.insertBefore( button, heading.nextSibling );
				return button;
			}
		} else if ( placement === 'top-of-content' ) {
			content.insertBefore( button, content.firstChild );
			return button;
		}

		// Default: 'before-content'.
		content.parentNode.insertBefore( button, content );
		return button;
	}

	function initPageReader( $content ) {
		try {
			var root = document;
			if ( $content ) {
				if ( $content.nodeType === 1 ) {
					root = $content;
				} else if ( $content[ 0 ] && $content[ 0 ].nodeType === 1 ) {
					root = $content[ 0 ];
				}
			}

			var content = findContentRoot( root );
			if ( !content || !content.parentNode ) {
				return;
			}

			if ( !( 'speechSynthesis' in window ) ) {
				return;
			}

			var existing = content.previousElementSibling;
			var button;
			if ( existing && existing.classList && existing.classList.contains( 'pagereader-button' ) ) {
				button = existing;
			} else {
				button = insertButton( content );
			}

			bindButton( button, content );
		} catch ( e ) {
			if ( window.console && console.warn ) {
				console.warn( 'PageReader failed', e );
			}
		}
	}

	try {
		if ( typeof mw !== 'undefined' && mw.hook ) {
			mw.hook( 'wikipage.content' ).add( initPageReader );
		} else if ( document.readyState === 'loading' ) {
			document.addEventListener( 'DOMContentLoaded', function () {
				initPageReader();
			} );
		} else {
			initPageReader();
		}
	} catch ( e ) {
		if ( window.console && console.warn ) {
			console.warn( 'PageReader failed', e );
		}
	}
}() );
```

Note on duplicate-guard fidelity: the reference script inserts the button once and relies on `data-kids-bound` on the *button* to avoid re-binding; because `insertButton()` here only runs when no existing `.pagereader-button` sibling is found, and `bindButton()` still checks `data-pagereader-bound` before attaching a second click listener, re-running `initPageReader` (e.g. on a second `wikipage.content` fire for the same content) does not create a duplicate button or a duplicate listener — matching the original guarantee.

- [ ] **Step 2: Manual verification (no JS test harness exists in this codebase; WantedSort/NearMe have none either)**

This step cannot be automated yet — defer functional verification to Task 9's end-to-end Canasta smoke test, which exercises this exact file. Do not skip Task 9.

- [ ] **Step 3: Commit**

```bash
git add resources/ext.pageReader.js
git commit -m "$(cat <<'EOF'
Add ext.pageReader.js: config-driven read-aloud button logic

Ported from Saintapedia/kids assets/kids-readaloud.js: marker-class
content targeting (or a fallback selector), skip-selector-filtered
speech text, mw.hook('wikipage.content') with a DOMContentLoaded
fallback, and try/catch around every entry point.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YSCWs5rSLs1bRpMav3nq7C
EOF
)"
```

---

## Task 7: ResourceLoader CSS module and module registration

**Files:**
- Create: `resources/ext.pageReader.css`
- Modify: `extension.json` (add `ResourceModules`)

**Interfaces:**
- Produces: the `ext.pageReader` ResourceLoader module definition that `Hooks::onBeforePageDisplay` (Task 4) references by name.

- [ ] **Step 1: Write `resources/ext.pageReader.css`**

```css
/* Ported from Saintapedia/kids assets/kids-styles.css
   (.kids-readaloud-button / .kids-readaloud-speaking / @keyframes
   kids-readaloud-pulse), renamed to .pagereader-button /
   .pagereader-speaking. Shared CSS custom properties from
   MediaWiki:Common.css (--kids-gold, --kids-navy-deep,
   --kids-terracotta) are resolved here to literal hex values, since
   that variable-declaring selector group is not moving out of
   Common.css. */

.pagereader-button {
	display: inline-block;
	margin: 0.4em 0 1em;
	padding: 0.75em 1.5em;
	min-height: 44px;
	min-width: 44px;
	border: none;
	border-radius: 999px;
	background: #C4A35A;
	color: #152C4A;
	font-size: 1.05em;
	font-weight: 700;
	cursor: pointer;
	box-shadow: 0 1px 0 rgba( 0, 0, 0, 0.12 );
}

.pagereader-button:hover {
	background: #D4B56A;
}

.pagereader-button:focus-visible {
	outline: 3px solid #1E3A5F;
	outline-offset: 3px;
}

.pagereader-button.pagereader-speaking {
	background: #A85D1B;
	color: #FFFDF5;
	animation: pagereader-pulse 1.2s ease-in-out infinite;
}

@keyframes pagereader-pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.75; }
}

@media ( prefers-reduced-motion: reduce ) {
	.pagereader-button.pagereader-speaking {
		animation: none;
	}
}

@media print {
	.pagereader-button {
		display: none !important;
	}
}
```

- [ ] **Step 2: Register the module in `extension.json`**

Add:
```json
	"ResourceModules": {
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
	},
```

- [ ] **Step 3: Validate `extension.json` is still well-formed**

Run the same validation script from Task 1 Step 6; expect `OK`.

- [ ] **Step 4: Commit**

```bash
git add resources/ext.pageReader.css extension.json
git commit -m "$(cat <<'EOF'
Add ext.pageReader.css and register the ext.pageReader RL module

Button/speaking/keyframes/reduced-motion/print rules ported with
literal color values in place of Common.css's shared custom
properties. targets includes mobile (Minerva) since Kids traffic is
phone-heavy.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YSCWs5rSLs1bRpMav3nq7C
EOF
)"
```

---

## Task 8: README, DEPLOY, CHANGELOG

**Files:**
- Create: `README.md`
- Create: `DEPLOY.md`
- Create: `CHANGELOG.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Write `README.md`**

```markdown
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
```

- [ ] **Step 2: Write `DEPLOY.md`**

```markdown
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
`Portal:Kids` (+ subpages).

**These two defaults (`1004` and `"Kids:"`) are Saintapedia-specific,
not hardcoded assumptions** — any other wiki installing this extension
should expect to override them, either in LocalSettings or via
`MediaWiki:PageReader-config`.

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

Create `MediaWiki:PageReader-config` with JSON such as:
```json
{
	"namespaces": [1004, 2000],
	"titlePrefixes": ["Kids:", "Teen:"],
	"excludedNamespaces": [-1]
}
```
Any field omitted here keeps its `$wgPageReader*` LocalSettings value.
Takes effect immediately on save (cache is keyed on the page's latest
revision ID). An invalid edit (bad JSON) silently falls back to the
LocalSettings defaults rather than breaking the site.

## Per-page editor opt-out

Add `__NOPAGEREADER__` anywhere in a page's wikitext to suppress the
button on that one page.

## Smoke checklist

| Check | Expected |
|-------|----------|
| Load a `Kids:` page | Button appears once, toggles label/class/`aria-pressed` |
| Load `Portal:Kids` and `Portal:Kids/AnySubpage` | Button appears |
| Load a page named `Portal:KidsCorner` | Button does **not** appear |
| Load any non-Kids page | `ext.pageReader` module not requested (check network panel / `mw.loader.getState('ext.pageReader')`) |
| Add `__NOPAGEREADER__` to a Kids page | Button no longer appears |
| Edit `MediaWiki:PageReader-config` to add a namespace | Takes effect without a restart |
| Save invalid JSON to `MediaWiki:PageReader-config` | Falls back to LocalSettings defaults, no error |

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
```

- [ ] **Step 3: Write `CHANGELOG.md`**

```markdown
# Changelog

## 0.1.0 — Unreleased

- Initial release: ports the Kids read-aloud button out of
  `MediaWiki:Common.js`/`MediaWiki:Common.css` into a standalone,
  config-driven extension with its own conditionally-loaded
  ResourceLoader module.
```

- [ ] **Step 4: Commit**

```bash
git add README.md DEPLOY.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
Add README, DEPLOY, and CHANGELOG

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YSCWs5rSLs1bRpMav3nq7C
EOF
)"
```

---

## Task 9: End-to-end verification on the local Canasta dev instance

**Files:** none (verification only).

**Interfaces:** none — this task validates Tasks 1–8 together in a real MediaWiki install. The extension is already symlinked and loaded into the dev instance from Task 1, Step 8.

- [ ] **Step 1: Run the full PHPUnit suite one more time from a clean state**

```bash
cd /home/tom/canasta-workspace/dev/mediawiki-code
php tests/phpunit/phpunit.php --group PageReader
```
Expected: all tests from Tasks 2–4 pass (`OK (20 tests, ...)`).

- [ ] **Step 2: Create test pages and verify eligibility/button behavior in a browser**

Create `Kids:Test page` with some sample text, and `Portal:Kids` and `Portal:Kids/Sub` similarly. For each:
- Load the page; confirm the "Read this page aloud" button appears exactly once.
- Click it; confirm the label changes to "Stop reading", `aria-pressed` becomes `"true"`, and the button visibly pulses.
- Click again; confirm speech stops and the label/class/`aria-pressed` revert.

Create a page titled `Portal:KidsCorner` with sample text; confirm **no** button appears.

Load any ordinary content page (e.g. the wiki's main page); confirm no button appears and, via the browser devtools network panel or `mw.loader.getState( 'ext.pageReader' )` in the console, confirm the module was never requested.

- [ ] **Step 3: Verify the `__NOPAGEREADER__` opt-out**

Edit `Kids:Test page` to add `__NOPAGEREADER__` anywhere in the wikitext, save, reload the page. Confirm the button no longer appears.

- [ ] **Step 4: Verify the on-wiki config overlay**

Create `MediaWiki:PageReader-config` with:
```json
{"namespaces": [1004, 2000]}
```
Reload a page in namespace `2000` (or create one if it doesn't exist on the dev wiki) and confirm the button now appears there too, with no LocalSettings change and no restart. Then edit `MediaWiki:PageReader-config` to invalid JSON (`not json`) and confirm namespace `1004` pages still work (falls back to LocalSettings defaults).

- [ ] **Step 5: Record the result**

If every check in Steps 1–4 passes, this plan is complete. If anything fails, fix the relevant task's code, re-run its own PHPUnit tests, then re-run this task's Steps 1–4 from the top before considering the plan done — do not patch around a failure by skipping a check.

No commit for this task (verification only, no files changed) — unless Step 7 uncovers a bug, in which case fix it under the task where the bug actually lives and commit there.
