<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader;

use MediaWiki\Config\Config;
use MediaWiki\Title\Title;

/**
 * Stateless eligibility check: performs no database queries of its own.
 * Relies on the passed-in Title already being hydrated by the caller (as
 * OutputPage::getTitle() is in Hooks::onBeforePageDisplay) — Title methods
 * like getContentModel()/isRedirect() can otherwise trigger a lazy DB
 * lookup on an unhydrated Title. The __NOPAGEREADER__ per-page opt-out (a
 * page property) is checked separately by Hooks::onBeforePageDisplay, only
 * for titles this class already approves.
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
	 * Plain, case-sensitive string-prefix match against the title's prefixed
	 * text (spaces, not underscores — matching Title::getPrefixedText()).
	 * Prefixes such as "Kids:" are not themselves parseable as a Title (no
	 * page name after the colon), so — unlike matchesAnyPage() — no
	 * Title::newFromText() normalization is applied here: "kids:" will NOT
	 * match "Kids:Foo", and "Kids:Foo_bar" (underscore) will NOT match the
	 * prefixed text "Kids:Foo bar" (space). This exact rule is documented in
	 * README.md — keep both in sync if it changes.
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
