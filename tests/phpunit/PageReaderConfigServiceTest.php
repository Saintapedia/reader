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
			'PageReaderVoicePitch' => 1.15,
			'PageReaderVoiceRate' => 1.05,
			'PageReaderVoiceGender' => 'auto',
			'PageReaderPreferredVoices' => [ 'female' => [ 'Samantha' ], 'male' => [ 'Daniel' ] ],
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

	public function testOverlayOverridesVoiceSettings(): void {
		$this->baseConfig();
		$this->editPage(
			'MediaWiki:PageReader-config',
			'{"voicePitch": 1.4, "voiceRate": 0.9, "voiceGender": "female"}'
		);
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( 1.4, $effective['voicePitch'] );
		$this->assertSame( 0.9, $effective['voiceRate'] );
		$this->assertSame( 'female', $effective['voiceGender'] );
	}

	public function testOutOfRangeVoicePitchAndRateAreClamped(): void {
		$this->baseConfig();
		$this->editPage(
			'MediaWiki:PageReader-config',
			'{"voicePitch": 9, "voiceRate": -3}'
		);
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( 2.0, $effective['voicePitch'] );
		$this->assertSame( 0.1, $effective['voiceRate'] );
	}

	public function testNonNumericVoicePitchIsDroppedNotCoercedToZero(): void {
		// A bare (float) cast on "fast" would silently become 0.0, which is
		// a valid (if silent) pitch value -- must fall back to LocalSettings
		// instead of masquerading as an intentional zero pitch.
		$this->baseConfig();
		$this->editPage( 'MediaWiki:PageReader-config', '{"voicePitch": "fast"}' );
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( 1.15, $effective['voicePitch'] );
	}

	public function testVoiceGenderOverlayIsCaseFolded(): void {
		$this->baseConfig();
		$this->editPage( 'MediaWiki:PageReader-config', '{"voiceGender": "Female"}' );
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( 'female', $effective['voiceGender'] );
	}

	public function testInvalidVoiceGenderOverlayIsDroppedNotPassedThrough(): void {
		// The client only recognizes exact auto/female/male and silently
		// falls back to 'auto' on anything else -- an unvalidated overlay
		// value like "woman" would look like it saved successfully on-wiki
		// while quietly doing nothing client-side. Must fall back to the
		// LocalSettings default here instead of shipping the bad value.
		$this->baseConfig();
		$this->editPage( 'MediaWiki:PageReader-config', '{"voiceGender": "woman"}' );
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( 'auto', $effective['voiceGender'] );
	}

	public function testPreferredVoicesOverlayIsUsedVerbatim(): void {
		$this->baseConfig();
		$this->editPage(
			'MediaWiki:PageReader-config',
			'{"preferredVoices": {"female": ["Zira"], "male": ["David"]}}'
		);
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( [ 'female' => [ 'Zira' ], 'male' => [ 'David' ] ], $effective['preferredVoices'] );
	}

	public function testPreferredVoicesOverlayForOneGenderDoesNotClobberTheOther(): void {
		// A sysop curating just the female list (having discovered a good
		// female voice on a new device) must not silently wipe out the
		// LocalSettings-configured male list -- these are logically
		// independent settings sharing one JSON key.
		$this->baseConfig();
		$this->editPage( 'MediaWiki:PageReader-config', '{"preferredVoices": {"female": ["Zira"]}}' );
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( [ 'Zira' ], $effective['preferredVoices']['female'] );
		$this->assertSame( [ 'Daniel' ], $effective['preferredVoices']['male'] );
	}

	public function testPreferredVoicesOverlayDropsNonStringEntries(): void {
		$this->baseConfig();
		$this->editPage(
			'MediaWiki:PageReader-config',
			'{"preferredVoices": {"female": ["Zira", 42, "", "  Aria  "]}}'
		);
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame( [ 'Zira', 'Aria' ], $effective['preferredVoices']['female'] );
	}

	public function testMalformedPreferredVoicesOverlayFallsBackToLocalSettings(): void {
		$this->baseConfig();
		$this->editPage( 'MediaWiki:PageReader-config', '{"preferredVoices": "not an object"}' );
		$service = new PageReaderConfigService();

		$effective = $service->getEffectiveConfig( $this->getServiceContainer()->getMainConfig() );

		$this->assertSame(
			[ 'female' => [ 'Samantha' ], 'male' => [ 'Daniel' ] ],
			$effective['preferredVoices']
		);
	}
}
