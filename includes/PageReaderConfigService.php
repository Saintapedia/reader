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
