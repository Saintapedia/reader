<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader\Tests;

use MediaWiki\Extension\PageReader\PageReaderEligibility;
use MediaWiki\Title\Title;
use MediaWikiIntegrationTestCase;

/**
 * @covers \MediaWiki\Extension\PageReader\PageReaderEligibility
 * @group PageReader
 * @group Database
 */
class PageReaderEligibilityTest extends MediaWikiIntegrationTestCase {

	private function setConfig( array $overrides = [] ): void {
		$this->overrideConfigValues( $overrides + [
			// Only exercised by tests that call editPage() (e.g. the redirect
			// gate test below) — without this, the deferred CDN purge tries a
			// real (blocked) HTTP request and fails the test unrelatedly.
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

	public function testTalkPageIsNotEligibleByDefault(): void {
		$this->setConfig( [ 'PageReaderLoadEverywhere' => true ] );
		$title = Title::makeTitle( NS_TALK, 'AnyPage' );

		$this->assertFalse(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testTalkPageIsEligibleWhenIncludeTalkIsTrue(): void {
		$this->setConfig( [
			'PageReaderLoadEverywhere' => true,
			'PageReaderIncludeTalk' => true,
		] );
		$title = Title::makeTitle( NS_TALK, 'AnyPage' );

		$this->assertTrue(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testPrefixMatchIsCaseSensitive(): void {
		// Lowercase "kids:" must NOT match "Kids:Foo" — prefix matching is
		// plain str_starts_with(), not normalized via Title::newFromText()
		// (documented in README.md's "Title-prefix matching rules").
		$this->setConfig( [ 'PageReaderTitlePrefixes' => [ 'kids:' ] ] );
		$title = Title::makeTitle( NS_MAIN, 'Kids:Foo' );

		$this->assertFalse(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}

	public function testRedirectPageIsNotEligible(): void {
		$this->setConfig( [ 'PageReaderLoadEverywhere' => true ] );
		$this->editPage( 'Kids:Redirect source', '#REDIRECT [[Kids:Redirect target]]' );
		$title = Title::newFromText( 'Kids:Redirect source' );

		$this->assertFalse(
			PageReaderEligibility::isEligible( $title, 'view', $this->config() )
		);
	}
}
