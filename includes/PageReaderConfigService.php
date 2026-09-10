<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader;

use MediaWiki\Config\Config;
use MediaWiki\Content\TextContent;
use MediaWiki\MediaWikiServices;
use MediaWiki\Title\Title;
use Throwable;

/**
 * Loads an optional MediaWiki:<PageReaderConfigPage> JSON overlay on top of
 * $wgPageReader* LocalSettings values, mirroring NearMeConfigService.
 */
class PageReaderConfigService {

	private const CACHE_VERSION = 1;
	private const CACHE_TTL = 300;

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

	/**
	 * Deliberately not memoized on the instance: getEffectiveConfig() is a
	 * public method taking Config per call, and instance-level memoization
	 * would defeat the WANObjectCache revision-keyed freshness check below
	 * for the lifetime of any long-running process (e.g. a maintenance
	 * script) that reuses one PageReaderConfigService across many calls.
	 * The WANObjectCache lookup itself is cheap on a hit.
	 */
	private function getResolvedOverlay( Config $mainConfig ): ?array {
		$pageName = (string)$mainConfig->get( 'PageReaderConfigPage' );
		if ( $pageName === '' ) {
			return null;
		}

		$title = Title::makeTitleSafe( NS_MEDIAWIKI, $pageName );
		if ( $title === null || !$title->exists() ) {
			return null;
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
				// A broken config page must degrade to LocalSettings, never break
				// the page render — guard against a non-text content model (no
				// getText()) or any other unexpected failure while reading it.
				try {
					$wikiPage = MediaWikiServices::getInstance()->getWikiPageFactory()->newFromTitle( $title );
					$content = $wikiPage->getContent();
					if ( $content === null || !( $content instanceof TextContent ) ) {
						return null;
					}

					$raw = $this->parseJsonConfig( $content->getText() );
					if ( $raw === null ) {
						return null;
					}

					return $this->normalizeOverlay( $raw );
				} catch ( Throwable $e ) {
					wfDebugLog( 'PageReader', 'Failed to load MediaWiki:PageReader-config: ' . $e->getMessage() );
					return null;
				}
			}
		);

		return ( is_array( $overlay ) && $overlay !== [] ) ? $overlay : null;
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
				// Only accept genuinely namespace-ID-shaped entries — a bare
				// intval() on e.g. "Kids" (a plausible sysop typo for a title
				// prefix instead of a namespace ID) silently produces 0
				// (NS_MAIN), turning a typo into "read-aloud on every
				// main-namespace wikitext page". Negative IDs (NS_SPECIAL,
				// NS_MEDIA, etc.) are valid and must still be allowed.
				$overlay[$key] = array_values( array_map(
					'intval',
					array_filter( $raw[$key], [ self::class, 'isNamespaceLike' ] )
				) );
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

		// Only accept an actual JSON boolean (true/false, unquoted) — a loose
		// (bool) cast would silently turn a sysop's typo'd "false" (string)
		// into true, the opposite of a graceful degrade on malformed input.
		if ( isset( $raw['loadEverywhere'] ) && is_bool( $raw['loadEverywhere'] ) ) {
			$overlay['loadEverywhere'] = $raw['loadEverywhere'];
		}

		foreach ( [ 'contentClass', 'contentSelector', 'buttonPlacement' ] as $key ) {
			if ( isset( $raw[$key] ) && is_string( $raw[$key] ) && trim( $raw[$key] ) !== '' ) {
				$overlay[$key] = trim( $raw[$key] );
			}
		}

		return $overlay;
	}

	/**
	 * True for a value that unambiguously represents a namespace ID: a native
	 * int, a whole-number float, or a string of an optionally-signed integer
	 * (e.g. "1004", "-1"). Negative IDs are valid namespace IDs (NS_SPECIAL,
	 * NS_MEDIA) and must not be rejected.
	 *
	 * @param mixed $entry
	 */
	private static function isNamespaceLike( $entry ): bool {
		if ( is_int( $entry ) ) {
			return true;
		}
		if ( is_float( $entry ) ) {
			return $entry === floor( $entry );
		}
		if ( is_string( $entry ) ) {
			return (bool)preg_match( '/^-?\d+$/', trim( $entry ) );
		}
		return false;
	}
}
