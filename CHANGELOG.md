# Changelog

## 0.1.0 — Unreleased

- Initial release: ports the Kids read-aloud button out of
  `MediaWiki:Common.js`/`MediaWiki:Common.css` into a standalone,
  config-driven extension with its own conditionally-loaded
  ResourceLoader module.
- Add `$wgPageReaderVoicePitch`/`$wgPageReaderVoiceRate` (default to a
  brighter, gentler pace than a browser's flat default TTS voice) and
  `$wgPageReaderVoiceGender` (auto/female/male, best-effort name
  matching against the browser's available voices), all overridable via
  `MediaWiki:PageReader-config`.
- Add a voice-gender select next to the button; a reader's choice is
  remembered per-browser via `localStorage` and overrides the site
  default.
- Add a pause/resume button, shown only while speech is in progress
  and feature-detected (omitted on a browser without
  `speechSynthesis.pause`/`resume` support).
- Add read-along highlighting of the word currently being spoken
  (best-effort, degrading to sentence-level on browsers that only
  report sentence boundaries, and to no highlighting at all on
  browsers with no `onboundary` support).
