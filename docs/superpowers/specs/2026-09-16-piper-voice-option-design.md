# PageReader — Piper voice option design spec

**Date:** 2026-09-16
**Repo:** https://github.com/Saintapedia/reader
**Status:** Approved design, not yet implemented

## 1. Motivation

`speechSynthesis` is not a real synthesizer built into the browser — it's a
thin wrapper around whatever voice backend the OS/browser happens to expose.
Chrome ships access to Google's cloud network voices (good quality); Firefox
and Safari fall back to the OS's native TTS, which on Linux is
speech-dispatcher/espeak-ng — old, robotic, and (per `#13`/`#15`) buggy the
moment `pitch`/`rate` are touched at all. There is no code fix that makes a
40-year-old formant synthesizer sound like a neural voice; the backend itself
is the ceiling.

[Piper](https://github.com/rhasspy/piper) (MIT-licensed neural TTS) offers a
real way past that ceiling: genuinely good-quality voices, fast enough to run
client-side via WASM, with no server-side dependency and no text ever leaving
the reader's device. This spec adds Piper as an **explicit, opt-in** upgrade
path alongside the existing native voice — never a replacement for it.

## 2. Scope

**In scope:**
- A "Try a better voice" opt-in next to the existing Female/Male/Auto
  select, offering 3 launch voices.
- Client-side WASM synthesis and playback, served from a public CDN
  (jsdelivr, from Piper's npm-published packages) — no new hosting or
  ops burden for Saintapedia.
- Caching the downloaded model (Cache Storage) so it's a one-time cost
  per device per voice, not per page.
- A persisted reader preference (localStorage) so the choice sticks
  across visits, with a visible, always-available way to change or
  revert it.
- Graceful fallback to the native voice on any Piper-path failure —
  the feature must never make read-aloud *less* reliable than it is
  today.
- A sysop kill switch (`$wgPageReaderPiperEnabled`), matching every
  other PageReader toggle.

**Out of scope (this pass):**
- More than 3 voices at launch (adding more later is a cheap follow-up
  once this ships and works).
- Server-side/self-hosted model hosting (see §4 for why CDN was chosen).
- A cloud TTS API (Google Cloud TTS, Polly, etc.) — rejected earlier in
  design discussion: per-character billing, sends reader text to a
  third party (a real concern on a kids' site), and reintroduces a
  hard *server-side* dependency this extension exists to avoid.
- Accent/voice curation beyond the 3 launch voices (`$wgPageReaderPreferredVoices`-style
  curation for Piper voices is a natural future extension, not built here).
- Network-connection detection (`navigator.connection`) to gate the
  download — rejected in favor of always showing a plain size warning,
  since that API is unreliable (notably absent on iOS Safari) and a
  fixed warning is simpler and equally honest.

## 3. Launch voices

| Voice | Description | Role |
|---|---|---|
| `en_US-amy-medium` | Warm, friendly US female | Default/lead |
| `en_GB-alba-medium` | Scottish-accented UK female | Accent variety |
| `en_US-ryan-medium` | US male | Alternate |

Served via jsdelivr from Piper's npm-published voice packages (exact
package/version pinned at implementation time — see §9, open risk).

## 4. Why a public CDN, not self-hosting

Self-hosting the WASM runtime + model files (20–60MB each) on
Saintapedia's own infra was considered and rejected: it's real,
ongoing ops work (hosting, updates, bandwidth) for a small team, with
no corresponding benefit over a CDN for this use case — the models
are optional, opt-in downloads, not something the base site depends
on to function. jsdelivr is already an allowed script host under this
project's CSP.

The tradeoff accepted: this reintroduces a third-party runtime
dependency, which is notable given PageReader's entire reason for
existing is isolating the site from exactly that class of risk (the
2026-09-08/09 Common.js outage). The mitigating design choices — lazy
loading (§5) and mandatory fallback-to-native on any failure (§7) —
exist specifically to keep a CDN outage from being able to break
anything beyond "the opt-in doesn't work right now."

## 5. Architecture

Piper doesn't plug into `speechSynthesis` — it's a WASM model producing
raw PCM audio, with no `SpeechSynthesisUtterance`, no built-in queueing,
no `onstart`/`onend` events. This is a **second, parallel playback
pipeline**, not a drop-in voice swap.

To avoid doubling the complexity of `ext.pageReader.js`, Piper support
lives in its own lazily-loaded ResourceLoader module,
`ext.pageReader.piper`, requested only when a reader clicks "Try a
better voice." Readers who never opt in download zero bytes of it and
see zero behavioral change.

The core module's existing sentence-splitting and highlighting logic
is voice-engine-agnostic and stays as-is. It gains one abstraction:
`speakSentences()` drives an interface (queue a sentence; get notified
on start/end/error) that either the native player or a new Piper
player can implement, so highlighting, pause/resume, and the
retry-on-error logic built in `#9`/`#11`/`#13`/`#14` do not need to
know which engine is producing the audio.

## 6. Components

**`ext.pageReader.js`** (existing, unchanged core)
- Eligibility, button/UI insertion, sentence splitting, highlighting,
  skip markers, pause/resume: untouched.
- New: the "Try a better voice" link/UI, and the player-interface
  abstraction described in §5.

**`ext.pageReader.piper`** (new, lazy-loaded module)
- **Loader** — fetches the Piper WASM runtime + chosen voice model
  from jsdelivr.
- **Cache** — Cache Storage wrapper; checks for an already-downloaded
  model before fetching, stores after a successful fetch.
- **Synthesizer** — given one sentence's text + the selected voice,
  runs WASM inference, returns audio as a Blob.
- **Player adapter** — plays each sentence's Blob via an `<audio>`
  element in sequence, translating its `play`/`ended`/`error` events
  into the same shape the native path already produces.

**New UI**
- "Try a better voice" link next to the existing voice-gender select.
- A picker showing the 3 voices plus a plain size warning ("~25MB,
  saved on this device — download now?") shown every time, regardless
  of connection type. The size shown is the real model file size for
  the chosen voice (known up front from the package metadata, not a
  guess), so a reader picking Alba vs. Ryan sees that voice's actual
  download cost, not a single rounded figure for all three.
- A persistent, visible "using: Amy (better voice) — change" indicator
  once opted in, so switching back to native or trying a different
  Piper voice is always one click away — never a one-shot decision.

**New config**
- `$wgPageReaderPiperEnabled` (LocalSettings + `MediaWiki:PageReader-config`
  overlay, default `true`) gates whether the opt-in UI renders at all.

**New client storage**
- `localStorage`: chosen engine (native/piper) + chosen Piper voice,
  alongside the existing persisted gender choice.
- Cache Storage: the actual downloaded model/runtime bytes, keyed by
  voice + version.

## 7. Data flow

1. Page loads; button inserted exactly as today. If
   `$wgPageReaderPiperEnabled`, the "Try a better voice" link also
   renders — the only footprint for readers who never touch it.
2. Reader clicks the link → picker shows the 3 voices with size
   estimate → picks one → confirms.
3. `mw.loader` requests `ext.pageReader.piper` for the first time. It
   checks Cache Storage for that voice model; if absent, fetches the
   WASM runtime + model from jsdelivr, showing a "Downloading voice…"
   state; stores the result in Cache Storage on success.
4. Choice is saved to `localStorage`. Reading starts immediately with
   the new voice — same "click and it goes" feel as today.
5. On later visits, the button renders instantly in native-ready
   state (no blocking wait on page load). Clicking "Read this page
   aloud" checks the saved preference, requests the now browser-cached
   `ext.pageReader.piper` module (no re-download), and speaks with it.
   The "change voice" control stays visible at all times.
6. Sentence splitting/highlighting is identical either way — only
   which player produces the start/end/error-equivalent events
   changes.

## 8. Error handling

Every Piper-path failure — CDN unreachable, browser lacks WASM/
AudioContext support, Cache Storage quota exceeded, a corrupt
download, a WASM inference error — is caught and falls back to native
`speechSynthesis` **for that read**, with a one-time notice ("Couldn't
load that voice, using the default instead"). This must never become
a second way for read-aloud itself to break, matching the extension's
core try/catch philosophy (see the 2026-09-09 design spec §1).

The saved preference is **not** cleared on a single transient failure
(a CDN blip shouldn't force re-opting-in every visit), but **is**
cleared after 3 consecutive failures (tracked alongside the preference
in `localStorage`, reset to 0 on any success), so a reader isn't
silently stuck retrying a persistently broken path forever — they
simply get asked again next time rather than the feature quietly
degrading with no way back short of manually re-opting in.

Before the "Try a better voice" link is even shown, a cheap,
synchronous capability check (`typeof WebAssembly !== 'undefined'` +
`AudioContext`/`webkitAudioContext` presence) runs on every page load
— no caching needed, it's effectively free — so a browser that clearly
cannot run this never sees the option, rather than opting in and then
failing.

## 9. Open risks / follow-ups for implementation time

- **Exact npm package/version to pin** for the Piper WASM runtime and
  the 3 voice models needs to be finalized against what's actually
  published on jsdelivr at implementation time — not fixed in this
  spec.
- **Per-sentence synthesis latency**: Piper is designed to run faster
  than real-time even on modest CPUs, but the actual latency of
  per-sentence WASM inference (vs. synthesizing the whole article at
  once) needs real-device measurement before assuming it doesn't
  introduce a perceptible gap at each sentence boundary — the existing
  "queue everything up front" approach that fixed Chrome's network-voice
  gap (`#9`) doesn't have a direct equivalent here, since Piper clips
  must be synthesized before they can be queued at all.
- **iOS Safari Cache Storage eviction** behavior needs to be confirmed
  empirically, not assumed from general knowledge.

## 10. Testing

**Covered by the existing jsdom suite**, in the same style as today's
`speechSynthesis` mocking:
- Opt-in link renders/hides based on `$wgPageReaderPiperEnabled`.
- `localStorage` persistence and read-back of engine/voice choice.
- The player-adapter contract, with a mocked Piper module (mocking
  `synthesize()`/playback calls the same way `speechSynthesis.speak`
  is mocked today).
- Fallback-to-native on a simulated fetch/inference failure, including
  the "clear preference after repeated failures" behavior from §8.

**Not coverable by jsdom — needs real-browser verification**, the same
category of thing that made the pitch/rate bug (`#13`/`#15`) and the
retry-cascade recursion bug (`#14`) invisible to automated tests:
actual WASM execution, real audio quality/output, real jsdelivr fetch
behavior, and real Cache Storage persistence/eviction on Chrome,
Firefox, and Safari/iOS. Budget real listening/testing time before
shipping, not just green CI.
