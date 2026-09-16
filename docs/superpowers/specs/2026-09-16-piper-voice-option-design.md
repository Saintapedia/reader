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
  select, offering one launch voice (§3).
- Client-side WASM synthesis and playback, served from a public CDN
  (jsdelivr, from the `@mintplex-labs/piper-tts-web` npm package) — no
  new hosting or ops burden for Saintapedia.
- Caching the downloaded model (via the Origin Private File System,
  handled internally by the Piper library — see §5) so it's a one-time
  cost per device, not per page.
- A persisted reader preference (localStorage) so the choice sticks
  across visits, with a visible, always-available way to revert to
  native.
- Graceful fallback to the native voice on any Piper-path failure —
  the feature must never make read-aloud *less* reliable than it is
  today.
- A sysop kill switch (`$wgPageReaderPiperEnabled`), matching every
  other PageReader toggle.

**Out of scope (this pass):**
- More than one voice at launch. Originally scoped as 3 voices
  (`en_US-amy-medium` default, `en_GB-alba-medium`, `en_US-ryan-medium`),
  descoped to one after discovering each model is a real ~60MB
  download (see §3) — not the ~25MB figure assumed earlier in design
  discussion, and there's no meaningfully smaller tier for these
  specific voices (Piper's "low" quality tier for the same voices is
  ~63.1MB vs. ~63.2MB "medium" — barely different). Multiple voices
  is an explicit, cheap follow-up once the single-voice path has
  shipped and real usage data exists.
- Server-side/self-hosted model hosting (see §4 for why CDN was chosen).
- A cloud TTS API (Google Cloud TTS, Polly, etc.) — rejected earlier in
  design discussion: per-character billing, sends reader text to a
  third party (a real concern on a kids' site), and reintroduces a
  hard *server-side* dependency this extension exists to avoid.
- Accent/voice curation (`$wgPageReaderPreferredVoices`-style curation
  for Piper voices is a natural future extension once more voices ship).
- Network-connection detection (`navigator.connection`) to gate the
  download — rejected in favor of always showing a plain size warning,
  since that API is unreliable (notably absent on iOS Safari) and a
  fixed warning is simpler and equally honest.

## 3. Launch voice

| Voice | Description | Real download size |
|---|---|---|
| `en_US-amy-medium` | Warm, friendly US female | **~60.3MB** (63,201,294 bytes for the `.onnx` model, confirmed from the library's `voices_static.json` catalog) |

This is meaningfully bigger than the ~25MB figure used earlier in
design discussion before the real catalog was checked — the size
warning shown to the reader (§6) must use this real number, not a
rounded placeholder.

Served via jsdelivr from `@mintplex-labs/piper-tts-web@1.0.5` (latest
published version as of this spec, confirmed on the npm registry; the
jsdelivr URL for this exact version — `https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js`
— was verified to resolve with a 200, wide-open CORS, and a one-year
immutable cache header, which is exactly what a version-pinned CDN
import should look like).

## 4. Why a public CDN, not self-hosting

Self-hosting the WASM runtime + model file (~60MB) on Saintapedia's
own infra was considered and rejected: it's real, ongoing ops work
(hosting, updates, bandwidth) for a small team, with no corresponding
benefit over a CDN for this use case — the model is an optional,
opt-in download, not something the base site depends on to function.
Saintapedia currently sends no `Content-Security-Policy` header at all
(confirmed against the live site), so nothing today blocks loading
from jsdelivr — but if a CSP is ever added later, it will need
`cdn.jsdelivr.net` explicitly allowed for this to keep working; that's
a one-line addition, not a blocker.

The tradeoff accepted: this reintroduces a third-party runtime
dependency, which is notable given PageReader's entire reason for
existing is isolating the site from exactly that class of risk (the
2026-09-08/09 Common.js outage). The mitigating design choices — lazy
loading (§5) and mandatory fallback-to-native on any failure (§8) —
exist specifically to keep a CDN outage from being able to break
anything beyond "the opt-in doesn't work right now."

## 5. Architecture

Piper doesn't plug into `speechSynthesis` — it's a WASM model producing
raw audio, with no `SpeechSynthesisUtterance`, no built-in queueing, no
`onstart`/`onend` events. This is a **second, parallel playback
pipeline**, not a drop-in voice swap.

To avoid doubling the complexity of `ext.pageReader.js`, Piper support
lives in its own lazily-loaded module, `ext.pageReader.piper`,
requested only when a reader clicks "Try a better voice." Readers who
never opt in download zero bytes of it and see zero behavioral change.

This module is a thin wrapper around a real, existing library —
[`@mintplex-labs/piper-tts-web`](https://github.com/Mintplex-Labs/piper-tts-web)
(MIT-licensed, confirmed maintained, ONNX Runtime + WASM under the
hood) — rather than something built from scratch. Its real, documented
API:

```typescript
import * as piperTts from '@mintplex-labs/piper-tts-web';

await piperTts.download( voiceId, onProgress );  // onProgress({ url, loaded, total }) per chunk
const wav = await piperTts.predict( { text, voiceId } );  // Blob; auto-downloads if not cached
await piperTts.stored();  // string[] of cached voiceIds
await piperTts.remove( voiceId );
await piperTts.voices();  // full voice catalog, keyed by voiceId, with file sizes
```

It's ESM-only (`import`), so `ext.pageReader.piper` loads it via a
dynamic `import()` of the jsdelivr ESM build (§3's pinned URL) inside
an inline `<script type="module">`, rather than through MediaWiki's
normal AMD-style ResourceLoader packaging — the module's own JS (the
wrapper and player-adapter code below) is still a normal ResourceLoader
module like the rest of the extension; only the *import of the
third-party library itself* uses this path. Caching happens
automatically inside the library via the browser's
[Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
(OPFS) — not Cache Storage, which earlier drafts of this spec assumed
before this library was identified; PageReader never touches OPFS
directly, only the library's `download()`/`stored()`/`remove()` calls.

The core module's existing sentence-splitting and highlighting logic
is voice-engine-agnostic and stays as-is. It gains one abstraction:
`speakSentences()` drives an interface (queue a sentence; get notified
on start/end/error) that either the native player or the new Piper
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
- **Library wrapper** — dynamically imports `@mintplex-labs/piper-tts-web@1.0.5`
  from jsdelivr; exposes `download(onProgress)`, `predict(text)` →
  `Blob`, and `isDownloaded()` for the single launch voice (all pass
  through to the library's `voiceId`-taking calls with `en_US-amy-medium`
  hardcoded, per §3).
- **Player adapter** — for each sentence, calls `predict()` to get its
  audio Blob, plays it via an `<audio>` element in sequence, and
  translates that element's `play`/`ended`/`error` events into the
  same shape the native path already produces.

**New UI**
- "Try a better voice" link next to the existing voice-gender select.
- A confirmation showing the real size ("Amy's voice is about 60MB and
  will be saved on this device — download now?"), shown every time the
  reader opts in from scratch, regardless of connection type.
- A persistent, visible "using: Amy (better voice) — switch back"
  control once opted in, so reverting to the native voice is always
  one click away — never a one-shot decision.

**New config**
- `$wgPageReaderPiperEnabled` (LocalSettings + `MediaWiki:PageReader-config`
  overlay, default `true`) gates whether the opt-in UI renders at all.

**New client storage**
- `localStorage`: chosen engine (native/piper) + consecutive-failure
  count, alongside the existing persisted gender choice.
- OPFS: the actual downloaded model/runtime bytes, managed entirely by
  `@mintplex-labs/piper-tts-web` itself (§5) — PageReader only ever
  calls `stored()`/`remove()`, never touches OPFS directly.

## 7. Data flow

1. Page loads; button inserted exactly as today. If
   `$wgPageReaderPiperEnabled`, the "Try a better voice" link also
   renders — the only footprint for readers who never touch it.
2. Reader clicks the link → sees the real-size confirmation (§6) →
   confirms.
3. `mw.loader` requests `ext.pageReader.piper` for the first time. It
   dynamically imports the pinned jsdelivr ESM build, checks
   `stored()` for the voice; if absent, calls `download()`, showing a
   "Downloading voice…" state with real progress from `onProgress`.
   The library stores the result in OPFS on success.
4. Choice is saved to `localStorage`. Reading starts immediately with
   the new voice — same "click and it goes" feel as today.
5. On later visits, the button renders instantly in native-ready
   state (no blocking wait on page load). Clicking "Read this page
   aloud" checks the saved preference, requests the now browser-cached
   `ext.pageReader.piper` module (its own JS is cached by ResourceLoader
   as normal; the voice model itself is cached in OPFS, so `predict()`
   does not re-download), and speaks with it. The "switch back to
   native" control stays visible at all times.
6. Sentence splitting/highlighting is identical either way — only
   which player produces the start/end/error-equivalent events
   changes.

## 8. Error handling

Every Piper-path failure — CDN unreachable, browser lacks WASM/
AudioContext support, OPFS quota exceeded, a corrupt download, a WASM
inference error — is caught and falls back to native `speechSynthesis`
**for that read**, with a one-time notice ("Couldn't load that voice,
using the default instead"). This must never become a second way for
read-aloud itself to break, matching the extension's core try/catch
philosophy (see the 2026-09-09 design spec §1).

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

- **Per-sentence synthesis latency**: Piper is designed to run faster
  than real-time even on modest CPUs, but the actual latency of
  per-sentence WASM inference (vs. synthesizing the whole article at
  once) needs real-device measurement before assuming it doesn't
  introduce a perceptible gap at each sentence boundary — the existing
  "queue everything up front" approach that fixed Chrome's network-voice
  gap (`#9`) doesn't have a direct equivalent here, since Piper clips
  must be synthesized before they can be queued at all.
- **iOS Safari OPFS eviction** behavior needs to be confirmed
  empirically, not assumed from general knowledge.
- **`@mintplex-labs/piper-tts-web` version drift**: the pinned `1.0.5`
  jsdelivr URL is immutable (verified in §3), so this extension will
  never silently pick up a breaking upstream change — but that also
  means version bumps are a manual, deliberate future PR, not
  automatic.

## 10. Testing

**Covered by the existing jsdom suite**, in the same style as today's
`speechSynthesis` mocking:
- Opt-in link renders/hides based on `$wgPageReaderPiperEnabled`.
- `localStorage` persistence and read-back of engine choice and
  failure count.
- The player-adapter contract, with a mocked Piper module (mocking
  `predict()`/playback calls the same way `speechSynthesis.speak` is
  mocked today).
- Fallback-to-native on a simulated fetch/inference failure, including
  the "clear preference after 3 consecutive failures" behavior from §8.

**Not coverable by jsdom — needs real-browser verification**, the same
category of thing that made the pitch/rate bug (`#13`/`#15`) and the
retry-cascade recursion bug (`#14`) invisible to automated tests:
actual WASM execution, real audio quality/output, real jsdelivr fetch
behavior, and real OPFS persistence/eviction on Chrome, Firefox, and
Safari/iOS. Budget real listening/testing time before shipping, not
just green CI.
