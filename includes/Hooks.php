<?php

declare( strict_types = 1 );

namespace MediaWiki\Extension\PageReader;

use MediaWiki\Config\HashConfig;
use MediaWiki\Hook\GetDoubleUnderscoreIDsHook;
use MediaWiki\MediaWikiServices;
use MediaWiki\Output\Hook\BeforePageDisplayHook;

class Hooks implements BeforePageDisplayHook, GetDoubleUnderscoreIDsHook {

	private PageReaderConfigService $configService;

	public function __construct( PageReaderConfigService $configService ) {
		$this->configService = $configService;
	}

	public function onGetDoubleUnderscoreIDs( &$doubleUnderscoreIDs ) {
		$doubleUnderscoreIDs[] = 'nopagereader';
		$doubleUnderscoreIDs[] = 'nopagereaderhighlight';
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

		// getRawVal()'s $default parameter is deprecated since MW 1.43 (our
		// floor version) and is slated for removal — extension.json declares
		// no upper MediaWiki version bound, so use ?? instead of relying on it.
		$action = $out->getRequest()->getRawVal( 'action' ) ?? 'view';

		if ( !PageReaderEligibility::isEligible( $title, $action, $eligibilityConfig ) ) {
			return;
		}

		// DB-backed opt-out check, deliberately run only for pages that
		// already passed the cheap, in-memory eligibility check above. Both
		// magic words are fetched in a single getProperties() call (one
		// page_props query) rather than one call per property name.
		$pageProps = MediaWikiServices::getInstance()->getPageProps()
			->getProperties( $title, [ 'nopagereader', 'nopagereaderhighlight' ] );
		$props = $pageProps[ $title->getArticleID() ] ?? [];
		if ( isset( $props['nopagereader'] ) ) {
			return;
		}

		// A narrower per-page opt-out than __NOPAGEREADER__ above: the
		// button and read-aloud still work normally, only per-sentence
		// highlighting is suppressed for this one page -- e.g. an editor
		// using PageReader on a non-Kids page who doesn't want the
		// highlight styling there.
		$highlightEnabled = $effective['highlightEnabled'] && !isset( $props['nopagereaderhighlight'] );

		$out->addModules( 'ext.pageReader' );
		$out->addJsConfigVars( [
			'wgPageReaderContentClass' => $effective['contentClass'],
			'wgPageReaderContentSelector' => $effective['contentSelector'],
			'wgPageReaderSkipSelectors' => $effective['skipSelectors'],
			'wgPageReaderButtonPlacement' => $effective['buttonPlacement'],
			'wgPageReaderVoicePitch' => $effective['voicePitch'],
			'wgPageReaderVoiceRate' => $effective['voiceRate'],
			'wgPageReaderVoiceGender' => $effective['voiceGender'],
			'wgPageReaderHighlightEnabled' => $highlightEnabled,
			'wgPageReaderPreferredVoices' => $effective['preferredVoices'],
			'wgPageReaderPiperEnabled' => $effective['piperEnabled'],
		] );
	}
}
