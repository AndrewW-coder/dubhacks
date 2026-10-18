# Photon setup

How Bridge talks to iMessage, and how to get it running. Owned by **User 1**.

## Which Photon SDK, and why

Bridge uses **Spectrum** (`spectrum-ts`), the SDK the Photon dashboard scaffolds. The Photon track requires projects to be built on the current Photon platform, and this is it.

Under the hood, Spectrum's iMessage provider runs the same Advanced iMessage Kit (`@photon-ai/advanced-imessage` v2.3, gRPC) that Bridge used before. That matters for one gap:

| Feature | Sending (Bridge → phone) | Receiving (phone → Bridge) |
|---|---|---|
| Text, threaded replies | ✅ Spectrum | ✅ Spectrum |
| Tapbacks | ✅ Spectrum | ✅ Spectrum (added) / raw stream (removed) |
| Edits | ✅ Spectrum | ⚠️ Raw stream only |
| Unsends | ✅ Spectrum | ⚠️ Raw stream only |
| Photos, files, voice notes | ✅ Spectrum | ✅ Spectrum |
| Typing indicator | ✅ Spectrum | n/a |

Spectrum's message stream doesn't deliver incoming **edits, unsends, or tapback removals**. `live.ts` reads just those three from the raw Advanced iMessage event stream of the client Spectrum already runs (`app.__internal.platforms`). If that ever causes trouble, set `PHOTON_RAW_EVENTS=0`: everything else keeps working and only those three stop relaying. Ask the Photon booth whether Spectrum will surface them directly.

No Mac and no webhook are needed: Spectrum keeps a live connection to Photon's hosted server from any laptop.

All Photon code lives in `src/photon/`. Nothing else imports Photon.

## 1. Get credentials

1. On <https://app.photon.codes>, create a project and add **iMessage**.
2. **Users page:** add every phone that will text Bridge, including your teammate, demo phones and **the judges' phones before the demo**. The shared pool ignores anyone not on that list.
3. **Each user gets their own Bridge number.** The shared pool assigns every user a number of their own, and texting a different user's number gets "number wasn't recognized". Look up each person's number with:

   ```bash
   npx -y @photon-ai/cli@latest spectrum users list --project <project id> --json
   ```

   (`phoneNumber` is the person, `assignedPhoneNumber` is the Bridge number they text.) Bridge doesn't care: each member already has their own 1:1 thread, and Spectrum sends through the right line. For the demo, each judge needs their own number looked up after being added. A dedicated number (Business plan) would give everyone the same one.
4. Every phone must **text its Bridge number first**. A shared line can't start a conversation.
4. Get the project secret with Photon's CLI:

   ```bash
   npx -y @photon-ai/cli@latest login
   npx -y @photon-ai/cli@latest projects secret --project <project id>
   ```

   (On Windows, `npm create spectrum-project` fails with `spawn npx ENOENT`; the CLI above is the workaround.)

Share the secret with your teammate privately. **Never commit `.env`.**

## 2. Configure

In `.env`:

```
PHOTON_MODE=live
SPECTRUM_PROJECT_ID=<project id>
SPECTRUM_PROJECT_SECRET=<secret>
```

## 3. Smoke test (do this first)

```bash
npm run photon:smoke -- +15551234567
```

It uses the same `LivePhotonClient` the app runs. It messages the phone, edits that greeting after 15 s, and sends then unsends a test message (outbound checks). For 3 minutes it prints every normalized event. From the phone, do each of these:

| Do this on the phone | Expected log | Bridge's answer |
|---|---|---|
| Send text | `── text` | ❤️ on your message + threaded reply `got: …` |
| Threaded reply to Bridge's message | `── text` with `replyTo` set | same |
| Tapback ❤️ | `── tapback` | |
| Remove tapback | `── tapback` with `removed: true` | |
| Edit your message | `── edit` | |
| Unsend your message | `── unsend` | |
| Send photo | `── image` + `downloaded to …` | |
| Send voice note | `── voice` + `downloaded to …` | |

Add `PHOTON_DEBUG=1` to print the raw Spectrum and iMessage payloads. If something maps wrong, fix `toIncoming()` / `fromRawEvent()` in `live.ts`. The rest of the app only sees `IncomingMessage`.

## 4. Run Bridge live

1. Copy `data/family.example.json` to `data/family.json` (gitignored) and put in real phone numbers in E.164 format (`+1…`) or Apple ID emails.
2. Each person texts **their own** Bridge number once (see §1.3).
   - **Voice notes need ffmpeg on the machine running live.** iPhones send `.caf`, which Gemini and OpenAI don't accept, so `media/voice.ts` converts it first. On Windows run `winget install --id Gyan.FFmpeg -e`, then either open a new terminal or set `FFMPEG_PATH` in `.env` to the installed `ffmpeg.exe`. Without ffmpeg, Bridge forwards the recording itself with a note instead of a transcript.
3. Run `npm start` with `PHOTON_MODE=live` (in PowerShell: `$env:PHOTON_MODE = 'live'; npm start`). Every incoming event logs one `[in] …` line.
   - **Don't use `npm run dev` for live on Windows.** When `tsx watch` restarts after a file change, the process detaches from the terminal and keeps running invisibly. The next copy then relays every message twice. Restart `npm start` by hand after code changes. Edits to the family file reload on their own.
   - Bridge refuses to start live if another copy holds `.bridge-tmp/live.lock`. If it says so, find the old copy and stop it.

## 5. Mock mode (for everyone else)

```bash
npm run sim                  # type as any family member
npm run sim:demo             # run data/demo-script.txt end to end
```

Same app, same code paths; only `src/photon/mock.ts` replaces Photon. **Only one process may listen on the live line at a time** (including the dashboard's echo starter), or every message is handled twice. User 1 runs live; User 2 develops in mock mode.

## Gotchas (already handled in code)

- **Echo loop:** Bridge's own sends come back as outbound events. `live.ts` drops them.
- **Don't block the stream:** `live.ts` doesn't await the handler. A message can wait minutes for a reviewer, and the reviewer's answer arrives on the same stream. `index.ts` keeps each sender's messages in order.
- **Message objects:** Spectrum replies, tapbacks, edits and unsends need the `Message`, not just its ID. `live.ts` caches every message it sees or sends and falls back to `space.getMessage(id)`. After a restart, older messages may not resolve.
- **Time windows:** edits work for **15 minutes** and unsends for **2 minutes** after sending. The router catches the error; fallbacks are User 1's TODOs.
- **Voice notes** arrive as `.caf`. Many speech-to-text APIs need mp3/wav/m4a, so convert first if needed.
- **Shared lines:** 1:1 chats only (no group chats, no calls). Bridge only uses 1:1 threads, so that's fine.

## Docs

- Spectrum: <https://photon.codes/docs/spectrum-ts/introduction>
- iMessage lines and routing: <https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing>
- Photon CLI: `npx -y @photon-ai/cli@latest --help`
