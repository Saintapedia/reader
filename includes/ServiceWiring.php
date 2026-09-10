<?php

declare( strict_types = 1 );

use MediaWiki\Extension\PageReader\PageReaderConfigService;
use MediaWiki\MediaWikiServices;

return [
	'PageReader.ConfigService' => static function ( MediaWikiServices $services ): PageReaderConfigService {
		return new PageReaderConfigService();
	},
];
