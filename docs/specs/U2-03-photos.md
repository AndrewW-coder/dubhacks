# Spec U2-03: Photo explanations (guide step 5)

Subagent: **photos** · Copy: `/home/claude/work/photos/` · Read first: `docs/specs/U2-00-master.md`, `docs/USER2_GUIDE.md` step 5, `src/media/image.ts`, `src/translate/claude.ts` (frozen helper you call), `src/relay/router.ts` (`relayAttachment`).

## Owns
`src/media/image.ts`, new `src/media/image.selftest.ts`. `heic-convert` + `@types/heic-convert` are already installed.

## Goal
When someone shares a photo of a letter, medicine label, form or bill, each recipient gets a short explanation in their own language. Ordinary photos (selfies, food) get nothing extra.

## Requirements

### R1 Formats
- Accept jpeg/png/gif/webp directly.
- Convert **HEIC/HEIF** (iPhone default) to JPEG with `heic-convert` (quality ~0.85) into memory before sending. Detect by extension *and* by magic bytes (`ftypheic`, `ftypheif`, `ftypmif1`, …), because files from Photon may have odd names.
- Size: Claude's limit is about 5 MB per image (verify in Anthropic docs via WebFetch). If a file is over the limit after conversion, skip it gracefully (return "" and log). Don't add a resize dependency.
- Detect the media type from magic bytes when the extension is missing or wrong.

### R2 Prompt + language
- Improve the prompt:
  - **explain what matters** (a medicine dose, a due date, an amount owed, who the letter is from, an action needed);
  - flag anything urgent or suspicious (scam letters, "pay with gift cards");
  - 2–4 short sentences;
  - use the reader's language **name** (add a small local `LANGUAGE_NAMES` map; don't import from translator.ts).
- `hasText: false` for ordinary photos, memes, and screenshots of things that need no explanation. Return "".

### R3 Cost + speed
- Cache results by `(sha1 of file bytes, targetLanguage)`, so the same photo going to 3 recipients costs at most one call per language.
- Coalesce concurrent identical calls: store the in-flight promise, because the router calls `explainImage` for all recipients in parallel.

### R4 Contract
`explainImage()` **never throws**; any failure → "". It does nothing without an API key.

## Verification (no API key exists)
- Fake Anthropic server in `scratch/` (`POST /v1/messages` → `tool_use` `photo_explanation`) that records requests. Run with `ANTHROPIC_API_KEY=fake ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`.
- Test images: make a tiny PNG/JPEG in scratch (e.g. ffmpeg `-f lavfi -i color=…` or a hand-written PNG). For HEIC, try to get a real sample (GitHub raw from a public repo's test fixtures; network is limited to package registries and GitHub). If none is reachable, test HEIC detection on a synthetic header and mock the converter in the selftest, and say so in the report.
- `src/media/image.selftest.ts` asserts:
  - jpeg/png are sent with the right media_type;
  - HEIC is converted (or the mocked path is taken);
  - the cache gives one request for two calls with the same language, and two for different languages;
  - concurrent calls are coalesced;
  - an oversize file gives "" with no request;
  - a server error gives "";
  - no key gives "" with no request.
- End to end: a scratch sim script `nainai: image scratch/label.jpg` with the fake server → recipients get a `📷 Nai Nai's photo: …` line.
- `npx tsc --noEmit`, `npm run sim:demo`, `npm run sim:u2` pass with no keys.
