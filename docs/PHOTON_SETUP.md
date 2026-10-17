# Photon setup

How Bridge talks to iMessage, and how to get it running. Owned by **User 1**.

## Which Photon SDK, and why

Photon has several iMessage SDKs. Bridge uses the **Advanced iMessage Kit** (`@photon-ai/advanced-imessage`, v2.3) over **gRPC**.

| Option | Tapbacks / replies / edit / unsend | Needs a Mac | Verdict |
|---|---|---|---|
| `@photon-ai/imessage-kit` (open source) | ❌ Can't send them (read-only fields) | ✅ Yes, Full Disk Access | Not enough for Bridge |
| **`@photon-ai/advanced-imessage` (gRPC)** | ✅ All of them | ❌ No, it talks to Photon's hosted server | **Use this** |
| `@photon-ai/advanced-imessage` (HTTP) | ✅ Sending only | ❌ No | Incoming events come by webhook, so you'd need a public URL. Skip it |
| `spectrum-ts` + `@spectrum-ts/imessage` | Reactions and replies; edit/unsend not clearly documented on shared lines | ❌ No | **Plan B** if Photon only gives you a project ID and secret |

gRPC gives a live event stream straight to a laptop (Windows, macOS or Linux), so there's no webhook, no ngrok and no Mac. The old README note that "Photon requires a Mac signed in to iMessage" only applies to the open-source kit.

All Photon code lives in `src/photon/`. Nothing else imports Photon, so switching to Plan B changes only `src/photon/live.ts`.

## 1. Get credentials

You need two values:

- `IMESSAGE_ADDRESS`: the line's gRPC address as `host:port` with **no** `https://`, e.g. `line-1.imsg.photon.codes:443`
- `IMESSAGE_TOKEN`: the bearer token for that line

Get them from the Photon dashboard at <https://app.photon.codes> or from the **Photon booth**. Ask the booth these questions early:

1. "We're using `@photon-ai/advanced-imessage` over gRPC. Can we have a line **address + token**?" (If they only hand out Spectrum project ID/secret, ask how to get a line token from it, or use Plan B.)
2. "On the shared line, do **edit, unsend, tapbacks and threaded replies** all work?"
3. "Do all our test phones reach the **same** Bridge number?" On Photon's shared pool, each recipient can be routed through a different number. Bridge is 1:1 threads only, so that's fine *if one token can send to all of them*. If each phone gets its own line and token, `live.ts` needs one client per line (see TODO below).
4. "Do test phones need to be registered or added as senders in the dashboard first?"
5. "What are the limits?" The docs say 5,000 messages/server/day and **50 new conversations/line/day**, so don't burn conversations on throwaway numbers.

Share the values with your teammate by private message. **Never commit `.env`.**

## 2. Install and configure

```bash
npm install          # installs the SDK plus its gRPC peer deps (already in package.json)
cp .env.example .env
```

In `.env`:

```
PHOTON_MODE=live
IMESSAGE_ADDRESS=line-1.imsg.photon.codes:443
IMESSAGE_TOKEN=...
IMESSAGE_TLS=true
```

## 3. Smoke test (do this first)

```bash
npm run photon:smoke -- +15551234567
```

This sends one message to that phone, then prints **every raw event** for 2 minutes. From the phone, do each of these and check that an event appears:

| Do this on the phone | Expected event | Field `live.ts` reads |
|---|---|---|
| Send text | `message.received` | `event.message.content.text`, `event.actor.address` |
| Threaded reply to Bridge's message | `message.received` | `message.threadOriginatorGuid` or `message.replyTargetGuid` ⚠️ check which |
| Tapback ❤️ | `message.reactionAdded` (maybe also a `received` with `reactionTargetGuid`) | `event.messageGuid`, `event.reaction.kind` |
| Remove tapback | `message.reactionRemoved` | |
| Edit own message | `message.edited` | `event.messageGuid`, `event.content.text` |
| Unsend own message | `message.unsent` | `event.messageGuid` |
| Send photo | `message.received` with `content.attachments[0].mimeType` = `image/*` | |
| Send voice note | `message.received` with `message.isAudioMessage` = true | |

If a field is named differently than `live.ts` expects, fix the mapping in `toIncoming()`. The rest of the app only sees `IncomingMessage`. You can also run the real bot with `PHOTON_DEBUG=1` to print every raw event.

## 4. Run Bridge live

1. Copy `data/family.example.json` to `data/family.json` (gitignored) and put in real phone numbers, in E.164 format (`+1…`) or Apple ID emails.
2. Each person texts the Bridge number once, or Bridge texts them first.
3. Run `npm run dev`.

## 5. Mock mode (for everyone else)

```bash
npm run sim                  # type as any family member
npm run sim:demo             # run data/demo-script.txt end to end
```

Same app, same code paths. Only `src/photon/mock.ts` replaces Photon. **Only one process may listen on the live line at a time**, or every message gets relayed twice. So User 1 runs live and User 2 develops in mock mode.

## Gotchas (already handled in code, keep them in mind)

- **Echo loop:** Bridge's own sends come back as events with `isFromMe: true`. `live.ts` drops them.
- **Chat GUIDs:** message APIs take a chat GUID (`any;-;+15551234567`), not a phone number. `live.ts` gets it once with `chats.create([handle])` and caches it.
- **Time windows:** edits only work for **15 minutes** and unsends for **2 minutes** after sending. Past that, the SDK throws. The router catches the error; fallbacks are User 1's TODOs.
- **Reconnects:** the stream isn't retried automatically. `live.ts` keeps the last `event.sequence` and replays missed events with `events.catchUp()` before resubscribing.
- **Voice notes** arrive as `.caf`. Many speech-to-text APIs need mp3/wav/m4a, so convert first if needed.
- **Shared lines don't support calls.** That doesn't affect us; voice notes are just attachments.

## Docs

- Getting started: <https://photon.codes/docs/advanced-kits/imessage/getting-started>
- Messages and events: <https://photon.codes/docs/advanced-kits/imessage/messages>
- Lines, routing and quotas: <https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing>
- SDK README (v2.3): <https://www.npmjs.com/package/@photon-ai/advanced-imessage>
