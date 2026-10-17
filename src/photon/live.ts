// Live iMessage through Spectrum (spectrum-ts), Photon's current SDK. Owned by User 1.
//
// Spectrum's message stream delivers new messages, threaded replies, photos,
// voice notes and tapbacks. It does not surface incoming edits, unsends or
// tapback removals, so we also read just those three event types from the raw
// Advanced iMessage stream of the client Spectrum already runs. Set
// PHOTON_RAW_EVENTS=0 to turn that off.
//
// Docs: https://photon.codes/docs/spectrum-ts/introduction

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Emoji, Spectrum, attachment, reaction, reply, voice } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Content, Message, Space } from "spectrum-ts";
import type { MessageEvent } from "@photon-ai/advanced-imessage";
import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { config } from "../config.js";
import type { IncomingMessage, MessageKind, TapbackKind } from "../types.js";
import type { MessagingPort } from "./port.js";

const TMP_DIR = resolve(".bridge-tmp");
const TAPBACKS: TapbackKind[] = ["love", "like", "dislike", "laugh", "emphasize", "question"];
const TAPBACK_BY_EMOJI = new Map<string, TapbackKind>(TAPBACKS.map((k) => [Emoji[k], k]));

type Handler = (message: IncomingMessage) => Promise<void>;
type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;
interface IMessageInstance {
  space: { create(user: string): Promise<Space> };
}
interface Downloadable {
  read(): Promise<Buffer>;
}

export class LivePhotonClient implements MessagingPort {
  private ready: Promise<{ app: SpectrumApp; im: IMessageInstance }>;
  private spaces = new Map<string, Space>(); // handle → 1:1 space with Bridge
  private messages = new Map<string, Message>(); // message ID → Message (needed to reply, react, edit, unsend)
  private myTapbacks = new Map<string, Message>(); // handle|target|kind → our reaction (to remove it later)
  private attachments = new Map<string, Downloadable>(); // attachment ID → downloader
  private recentTapbacks = new Map<string, number>(); // dedupe key → timestamp

  constructor() {
    if (!config.spectrumProjectId || !config.spectrumProjectSecret) {
      throw new Error("PHOTON_MODE=live needs SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in .env (see docs/PHOTON_SETUP.md)");
    }
    this.ready = Spectrum({
      projectId: config.spectrumProjectId,
      projectSecret: config.spectrumProjectSecret,
      providers: [imessage.config()],
    }).then((app) => ({ app, im: imessage(app) as unknown as IMessageInstance }));
  }

  // ── Receiving ────────────────────────────────────────────────────────────

  async start(handler: Handler): Promise<void> {
    const { app } = await this.ready;
    console.log("[photon] live mode via Spectrum");
    void this.followSpectrum(app, handler);
    if (process.env.PHOTON_RAW_EVENTS !== "0") this.followRawEvents(app, handler);
  }

  private async followSpectrum(app: SpectrumApp, handler: Handler) {
    for (;;) {
      try {
        for await (const [space, message] of app.messages) {
          if (process.env.PHOTON_DEBUG) console.dir({ space: space.id, message }, { depth: 5 });
          if (message.direction === "outbound") continue; // our own sends: ignore or we loop forever
          const fromHandle = message.sender?.id;
          if (!fromHandle) continue;
          this.spaces.set(fromHandle, space);
          this.messages.set(message.id, message);
          // Not awaited: a handler can wait minutes for a reviewer's answer, and that answer
          // arrives on this same stream. index.ts keeps each sender's messages in order.
          for (const msg of this.toIncoming(message, fromHandle)) dispatch(handler, msg);
        }
      } catch (err) {
        console.error("[photon] Spectrum stream dropped, reconnecting in 2s", err);
      }
      await sleep(2000);
    }
  }

  private toIncoming(
    message: Message,
    fromHandle: string,
    content: Content = message.content,
    replyToId?: string,
  ): IncomingMessage[] {
    const base = { id: message.id, fromHandle, receivedAt: message.timestamp ?? new Date(), replyToId };
    switch (content.type) {
      case "text":
        return [{ ...base, kind: "text", text: content.text }];
      case "markdown":
        return [{ ...base, kind: "text", text: content.markdown }];
      case "reply":
        return this.toIncoming(message, fromHandle, content.content as Content, content.target.id);
      case "attachment":
        this.attachments.set(content.id, content);
        return [{ ...base, kind: kindOf(content.mimeType), attachment: { id: content.id, fileName: content.name, mimeType: content.mimeType } }];
      case "voice": {
        const id = content.id ?? message.id;
        this.attachments.set(id, content);
        return [{ ...base, kind: "voice", attachment: { id, fileName: content.name ?? "voice.caf", mimeType: content.mimeType } }];
      }
      case "reaction": {
        const kind = TAPBACK_BY_EMOJI.get(content.emoji);
        if (!kind) return []; // emoji/sticker reactions: TODO [U1] optional
        const t = this.tapback(fromHandle, base.receivedAt, content.target.id, kind, false);
        return t ? [t] : [];
      }
      case "group": // a message with several parts (e.g. photo + caption)
        return content.items.flatMap((item) => {
          this.messages.set(item.id, item);
          return this.toIncoming(item, fromHandle);
        });
      default:
        return []; // read receipts, polls, contact cards: not relayed
    }
  }

  /** Edits, unsends and tapback removals, which Spectrum's stream doesn't deliver. */
  private followRawEvents(app: SpectrumApp, handler: Handler) {
    const clients = app.__internal.platforms.get("imessage")?.client as { client: AdvancedIMessage }[] | undefined;
    if (!clients?.length) {
      console.warn("[photon] no raw iMessage client found: incoming edits/unsends/tapback removals won't relay");
      return;
    }
    for (const { client } of clients) {
      void (async () => {
        for (;;) {
          try {
            for await (const event of client.messages.subscribeEvents()) {
              if (process.env.PHOTON_DEBUG) console.dir({ raw: event }, { depth: 6 });
              const msg = this.fromRawEvent(event);
              if (msg) dispatch(handler, msg);
            }
          } catch (err) {
            console.error("[photon] raw event stream dropped, reconnecting in 2s", err);
          }
          await sleep(2000);
        }
      })();
    }
  }

  private fromRawEvent(event: MessageEvent): IncomingMessage | undefined {
    if (event.isFromMe) return undefined;
    const fromHandle = event.actor?.address ?? handleFromChatGuid(event.chatGuid);
    if (!fromHandle) return undefined;
    const receivedAt = event.occurredAt ?? new Date();
    switch (event.type) {
      case "message.reactionRemoved":
        return this.tapback(fromHandle, receivedAt, event.messageGuid, event.reaction.kind, true);
      case "message.edited":
        return { id: event.messageGuid, fromHandle, receivedAt, kind: "edit", text: event.content.text ?? "" };
      case "message.unsent":
        return { id: event.messageGuid, fromHandle, receivedAt, kind: "unsend" };
      default:
        return undefined; // everything else arrives through Spectrum
    }
  }

  private tapback(fromHandle: string, receivedAt: Date, targetId: string, kind: string, removed: boolean) {
    if (!TAPBACKS.includes(kind as TapbackKind)) return undefined;
    const key = `${fromHandle}|${targetId}|${kind}|${removed}`;
    const now = Date.now();
    if (now - (this.recentTapbacks.get(key) ?? 0) < 5000) return undefined; // same tapback seen twice
    this.recentTapbacks.set(key, now);
    const msg: IncomingMessage = {
      id: targetId,
      fromHandle,
      receivedAt,
      kind: "tapback",
      tapback: kind as TapbackKind,
      tapbackRemoved: removed,
    };
    return msg;
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  private async spaceFor(handle: string): Promise<Space> {
    let space = this.spaces.get(handle);
    if (!space) {
      space = await (await this.ready).im.space.create(handle);
      this.spaces.set(handle, space);
    }
    return space;
  }

  private async find(space: Space, messageId: string): Promise<Message | undefined> {
    return this.messages.get(messageId) ?? (await space.getMessage(messageId).catch(() => undefined));
  }

  private remember(sent: Message | undefined): string {
    if (!sent) throw new Error("Spectrum skipped the send (unsupported content)");
    this.messages.set(sent.id, sent);
    return sent.id;
  }

  async sendText(toHandle: string, text: string, opts?: { replyToId?: string }): Promise<string> {
    const space = await this.spaceFor(toHandle);
    const target = opts?.replyToId ? await this.find(space, opts.replyToId) : undefined;
    return this.remember(await space.send(target ? reply(text, target) : text));
  }

  async sendTapback(toHandle: string, messageId: string, tapback: TapbackKind, remove = false) {
    const space = await this.spaceFor(toHandle);
    const key = `${toHandle}|${messageId}|${tapback}`;
    if (remove) {
      const mine = this.myTapbacks.get(key);
      if (mine) await space.unsend(mine);
      this.myTapbacks.delete(key);
      return;
    }
    const target = await this.find(space, messageId);
    if (!target) return console.warn(`[photon] tapback target ${messageId} not found`);
    const sent = await space.send(reaction(Emoji[tapback], target));
    if (sent) this.myTapbacks.set(key, sent);
  }

  async editMessage(toHandle: string, messageId: string, newText: string) {
    const space = await this.spaceFor(toHandle);
    await space.edit(await this.find(space, messageId), newText);
  }

  async unsendMessage(toHandle: string, messageId: string) {
    const space = await this.spaceFor(toHandle);
    await space.unsend(await this.find(space, messageId));
  }

  async sendFile(toHandle: string, filePath: string, opts?: { replyToId?: string; asVoiceNote?: boolean }) {
    const space = await this.spaceFor(toHandle);
    const file = opts?.asVoiceNote ? voice(filePath) : attachment(filePath);
    const target = opts?.replyToId ? await this.find(space, opts.replyToId) : undefined;
    return this.remember(await space.send(target ? reply(file, target) : file));
  }

  async downloadAttachment(attachmentId: string, fileName: string): Promise<string> {
    const source = this.attachments.get(attachmentId);
    if (!source) throw new Error(`attachment ${attachmentId} not seen on this run`);
    await mkdir(TMP_DIR, { recursive: true });
    const path = join(TMP_DIR, `${attachmentId.replace(/[^\w-]/g, "_")}-${basename(fileName)}`);
    await writeFile(path, await source.read());
    return path;
  }

  async setTyping(toHandle: string, on: boolean) {
    const space = await this.spaceFor(toHandle);
    await (on ? space.startTyping() : space.stopTyping()).catch(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function dispatch(handler: Handler, msg: IncomingMessage) {
  handler(msg).catch((err) => console.error("[photon] handler failed", msg.id, err));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Direct chat GUIDs look like "any;-;+15551234567". */
function handleFromChatGuid(chatGuid: string): string | undefined {
  const [, sep, address] = chatGuid.split(";");
  return sep === "-" ? address : undefined;
}

function kindOf(mimeType: string): MessageKind {
  if (mimeType.startsWith("audio/")) return "voice";
  if (mimeType.startsWith("image/")) return "image";
  return "file";
}
