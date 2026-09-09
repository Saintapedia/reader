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
