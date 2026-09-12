# Changelog

## 0.1.0 — Unreleased

- Initial release: ports the Kids read-aloud button out of
  `MediaWiki:Common.js`/`MediaWiki:Common.css` into a standalone,
  config-driven extension with its own conditionally-loaded
  ResourceLoader module.
- Add `$wgPageReaderVoicePitch`/`$wgPageReaderVoiceRate` (default to a
  brighter, gentler pace than a browser's flat default TTS voice) and
  `$wgPageReaderVoiceGender` (female/male/auto, defaulting to female,
  best-effort name matching against the browser's available voices),
  all overridable via `MediaWiki:PageReader-config`.
- Add a voice-gender select next to the button; a reader's choice is
  remembered per-browser via `localStorage` and overrides the site
  default.
- Add `$wgPageReaderPreferredVoices` (per-gender curated voice-name
  list, overridable via `MediaWiki:PageReader-config`) checked before
  the generic female/male name match, for voices that don't self-label
  gender in their name.
- Add a pause/resume button, shown only while speech is in progress
  and feature-detected (omitted on a browser without
  `speechSynthesis.pause`/`resume` support).
- Add read-along sentence highlighting: the article is split into
  sentences client-side and spoken as a chain of utterances,
  highlighting the sentence currently playing (chosen over word-level
  tracking for cross-browser reliability). Controlled by
  `$wgPageReaderHighlightEnabled` (default `true`).
