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
			// editPage() below triggers a real page save; without this, the
			// deferred CDN purge tries a real HTTP request to the (blocked)
			// test network and fails the test with an unrelated error.
			'CdnServers' => [],
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
			// Deliberately NOT overriding PageReaderContentClass here: leaving it
			// at its real extension.json default (kids-readaloud) is what lets
			// testKidsNamespacePageLoadsModule's assertion actually catch a
			// regression of the critical production-content-class fix.
			'PageReaderContentSelector' => '',
			'PageReaderSkipSelectors' => [ '.infobox' ],
			'PageReaderButtonPlacement' => 'before-content',
			'PageReaderVoicePitch' => 1.2,
			'PageReaderVoiceRate' => 0.9,
			'PageReaderVoiceGender' => 'male',
			'PageReaderPreferredVoices' => [ 'female' => [ 'Samantha' ], 'male' => [ 'Daniel' ] ],
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

		$jsVars = $out->getJsConfigVars();
		// This is the extension.json shipped default, not a test-fixture value —
		// asserting it here is what locks in the critical fix (the default must
		// match the class real Saintapedia Kids articles actually use).
		$this->assertSame( 'kids-readaloud', $jsVars['wgPageReaderContentClass'] );
		$this->assertSame( 'before-content', $jsVars['wgPageReaderButtonPlacement'] );
		$this->assertSame( [ '.infobox' ], $jsVars['wgPageReaderSkipSelectors'] );
		$this->assertSame( 1.2, $jsVars['wgPageReaderVoicePitch'] );
		$this->assertSame( 0.9, $jsVars['wgPageReaderVoiceRate'] );
		$this->assertSame( 'male', $jsVars['wgPageReaderVoiceGender'] );
		$this->assertSame(
			[ 'female' => [ 'Samantha' ], 'male' => [ 'Daniel' ] ],
			$jsVars['wgPageReaderPreferredVoices']
		);
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

	public function testOnWikiOverlayContentClassReachesJsConfigVars(): void {
		$this->overridePageReaderConfig( [ 'PageReaderConfigPage' => 'PageReader-config' ] );
		$this->editPage( 'MediaWiki:PageReader-config', '{"contentClass": "overlay-class"}' );
		$this->editPage( 'Kids:Overlay content class test', 'Some content.' );

		$out = $this->runBeforePageDisplay( 'Kids:Overlay content class test' );

		$jsVars = $out->getJsConfigVars();
		$this->assertSame( 'overlay-class', $jsVars['wgPageReaderContentClass'] );
	}

	public function testOnWikiOverlayVoiceSettingsReachJsConfigVars(): void {
		$this->overridePageReaderConfig( [ 'PageReaderConfigPage' => 'PageReader-config' ] );
		$this->editPage(
			'MediaWiki:PageReader-config',
			'{"voicePitch": 1.4, "voiceRate": 0.8, "voiceGender": "female"}'
		);
		$this->editPage( 'Kids:Overlay voice settings test', 'Some content.' );

		$out = $this->runBeforePageDisplay( 'Kids:Overlay voice settings test' );

		$jsVars = $out->getJsConfigVars();
		$this->assertSame( 1.4, $jsVars['wgPageReaderVoicePitch'] );
		$this->assertSame( 0.8, $jsVars['wgPageReaderVoiceRate'] );
		$this->assertSame( 'female', $jsVars['wgPageReaderVoiceGender'] );
	}

	public function testOnWikiOverlayPreferredVoicesReachesJsConfigVars(): void {
		$this->overridePageReaderConfig( [ 'PageReaderConfigPage' => 'PageReader-config' ] );
		$this->editPage(
			'MediaWiki:PageReader-config',
			'{"preferredVoices": {"female": ["Zira"]}}'
		);
		$this->editPage( 'Kids:Overlay preferred voices test', 'Some content.' );

		$out = $this->runBeforePageDisplay( 'Kids:Overlay preferred voices test' );

		$jsVars = $out->getJsConfigVars();
		// Overlay curated only 'female'; 'male' must still carry through
		// from the LocalSettings fixture, not disappear.
		$this->assertSame( [ 'Zira' ], $jsVars['wgPageReaderPreferredVoices']['female'] );
		$this->assertSame( [ 'Daniel' ], $jsVars['wgPageReaderPreferredVoices']['male'] );
	}
}
