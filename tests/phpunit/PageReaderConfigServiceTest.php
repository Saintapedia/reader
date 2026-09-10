<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader\Tests;

use MediaWiki\Extension\PageReader\PageReaderConfigService;
use MediaWikiIntegrationTestCase;

/**
 * @covers \MediaWiki\Extension\PageReader\PageReaderConfigService
 * @group PageReader
 * @group Database
 */
class PageReaderConfigServiceTest extends MediaWikiIntegrationTestCase {

	private function baseConfig( array $overrides = [] ): void {
		$this->overrideConfigValues( $overrides + [
			// editPage() below triggers a real page save; without this, the
			// deferred CDN purge tries a real HTTP request to the (blocked)
			// test network and fails the test with an unrelated error.
			'CdnServers' => [],
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

	public function testNonNumericNamespaceEntryIsDroppedNotCoercedToMain(): void {
		// A bare intval("Kids") would silently become 0 (NS_MAIN) -- a sysop
		// typo must not turn into "read-aloud on every main-namespace page".
		$this->baseConfig();
		$this->editPage( 'MediaWiki:PageReader-config', '{"namespaces": [1004, "Kids", -1]}' );
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( [ 1004, -1 ], $effective['namespaces'] );
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

	public function testEmptyObjectOverlayFallsBackToLocalSettings(): void {
		$this->baseConfig();
		$this->editPage( 'MediaWiki:PageReader-config', '{}' );
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( [ 1004 ], $effective['namespaces'] );
		$this->assertSame( [ 'Kids:' ], $effective['titlePrefixes'] );
	}

	public function testUnoverridableKeysInOverlayAreSilentlyIgnored(): void {
		// enabled/actions/includeTalk are LocalSettings-only; PageReaderConfigService
		// never reads them from the overlay JSON, so setting them here has no
		// effect and does not interfere with the (unrelated) overridable keys.
		$this->baseConfig();
		$this->editPage(
			'MediaWiki:PageReader-config',
			'{"enabled": false, "actions": ["view", "edit"], "includeTalk": true, "namespaces": [1004, 3000]}'
		);
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( [ 1004, 3000 ], $effective['namespaces'] );
		$this->assertArrayNotHasKey( 'enabled', $effective );
		$this->assertArrayNotHasKey( 'actions', $effective );
		$this->assertArrayNotHasKey( 'includeTalk', $effective );
	}

	public function testParseJsonConfigExtractsObjectFromNowikiWrapper(): void {
		$service = new PageReaderConfigService();

		$parsed = $service->parseJsonConfig( "<nowiki>\n{\"loadEverywhere\": true}\n</nowiki>" );

		$this->assertSame( [ 'loadEverywhere' => true ], $parsed );
	}
}
