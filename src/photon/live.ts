// Live iMessage through Photon's Advanced iMessage Kit (gRPC transport).
// Owned by User 1.
//
// Why this SDK: Bridge needs tapbacks, threaded replies, edits and unsends.
// Photon's open-source `imessage-kit` can't send those; the Advanced kit can.
// Why gRPC (not HTTP): gRPC gives a live event stream from a laptop, with no
// public webhook URL needed. Runs on Windows/macOS/Linux; no Mac required.
//
// Docs: https://photon.codes/docs/advanced-kits/imessage/getting-started

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createClient } from "@photon-ai/advanced-imessage/grpc";
import type { Message, MessageEvent } from "@photon-ai/advanced-imessage";
import { config } from "../config.js";
import type { AttachmentRef, IncomingMessage, MessageKind, TapbackKind } from "../types.js";
import type { MessagingPort } from "./port.js";

const TMP_DIR = resolve(".bridge-tmp");
const TAPBACKS: TapbackKind[] = ["love", "like", "dislike", "laugh", "emphasize", "question"];

type Client = ReturnType<typeof createClient>;

export class LivePhotonClient implements MessagingPort {
  private im: Client;
  private chatGuids = new Map<string, string>(); // handle → chat GUID
  private lastSequence: number | undefined;
  private recentTapbacks = new Map<string, number>(); // dedupe key → timestamp

  // TODO [U1] if Photon gives each test phone its own line + token (shared pool routing),
  // hold one client per line and pick it by handle in chatFor()/start().
  constructor() {
    if (!config.imessageAddress || !config.imessageToken) {
      throw new Error("PHOTON_MODE=live needs IMESSAGE_ADDRESS and IMESSAGE_TOKEN in .env (see docs/PHOTON_SETUP.md)");
    }
    this.im = createClient({
      address: config.imessageAddress,
      token: config.imessageToken,
      tls: config.imessageTls,
      retry: true,
    });
  }

  // ── Receiving ────────────────────────────────────────────────────────────

  async start(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    console.log(`[photon] live mode, connecting to ${config.imessageAddress}`);
    // Runs forever: subscribe, and on any stream error replay what we missed, then resubscribe.
    void (async () => {
      for (;;) {
        try {
          if (this.lastSequence !== undefined) {
            for await (const event of this.im.events.catchUp(this.lastSequence)) {
              if (event.type === "catchup.complete") break;
              if (event.type.startsWith("message.")) await this.dispatch(event as MessageEvent, handler);
            }
          }
          for await (const event of this.im.messages.subscribeEvents()) {
            await this.dispatch(event, handler);
          }
        } catch (err) {
          console.error("[photon] event stream dropped, reconnecting in 2s", err);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
  }

  private async dispatch(event: MessageEvent, handler: (m: IncomingMessage) => Promise<void>) {
    this.lastSequence = event.sequence;
    if (process.env.PHOTON_DEBUG) console.dir(event, { depth: 6 });
    if (event.isFromMe) return; // our own sends echo back as events — ignore them or we loop forever
    const fromHandle = event.actor?.address ?? handleFromChatGuid(event.chatGuid);
    if (!fromHandle) return;
    this.chatGuids.set(fromHandle, event.chatGuid);
    const msg = this.toIncoming(event, fromHandle);
    if (msg) await handler(msg);
  }

  private toIncoming(event: MessageEvent, fromHandle: string): IncomingMessage | undefined {
    const base = { fromHandle, receivedAt: event.occurredAt ?? new Date() };
    switch (event.type) {
      case "message.received": {
        const m = event.message;
        // Some servers also deliver a tapback as a "received" message pointing at its target.
        if (m.reactionTargetGuid && m.reaction) {
          return this.tapback(base, m.reactionTargetGuid, m.reaction.kind, false);
        }
        const attachment = firstAttachment(m);
        return {
          ...base,
          id: m.guid,
          kind: kindOf(m, attachment),
          text: m.content.text ?? undefined,
          attachment,
          replyToId: m.threadOriginatorGuid ?? m.replyTargetGuid ?? undefined,
        };
      }
      case "message.reactionAdded":
      case "message.reactionRemoved":
        return this.tapback(base, event.messageGuid, event.reaction.kind, event.type === "message.reactionRemoved");
      case "message.edited":
        return { ...base, id: event.messageGuid, kind: "edit", text: event.content.text ?? "" };
      case "message.unsent":
        return { ...base, id: event.messageGuid, kind: "unsend" };
      default:
        return undefined; // read receipts, stickers: not relayed
    }
  }

  private tapback(
    base: { fromHandle: string; receivedAt: Date },
    targetId: string,
    kind: string,
    removed: boolean,
  ): IncomingMessage | undefined {
    if (!TAPBACKS.includes(kind as TapbackKind)) return undefined; // emoji/sticker reactions: TODO [U1] optional
    const key = `${base.fromHandle}|${targetId}|${kind}|${removed}`;
    const now = Date.now();
    if (now - (this.recentTapbacks.get(key) ?? 0) < 5000) return undefined; // same tapback seen twice
    this.recentTapbacks.set(key, now);
    return { ...base, id: targetId, kind: "tapback", tapback: kind as TapbackKind, tapbackRemoved: removed };
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  private async chatFor(handle: string): Promise<string> {
    let guid = this.chatGuids.get(handle);
    if (!guid) {
      guid = (await this.im.chats.create([handle])).chat.guid;
      this.chatGuids.set(handle, guid);
    }
    return guid;
  }

  async sendText(toHandle: string, text: string, opts?: { replyToId?: string }): Promise<string> {
    const sent = await this.im.messages.sendText(await this.chatFor(toHandle), text, {
      replyTo: opts?.replyToId,
    });
    return sent.guid;
  }

  async sendTapback(toHandle: string, messageId: string, tapback: TapbackKind, remove = false) {
    await this.im.messages.setReaction(await this.chatFor(toHandle), messageId, { kind: tapback }, !remove);
  }

  async editMessage(toHandle: string, messageId: string, newText: string) {
    await this.im.messages.edit(await this.chatFor(toHandle), messageId, newText, {
      backwardCompatText: `Edited: ${newText}`,
    });
  }

  async unsendMessage(toHandle: string, messageId: string) {
    await this.im.messages.unsend(await this.chatFor(toHandle), messageId);
  }

  async sendFile(toHandle: string, filePath: string, opts?: { replyToId?: string; asVoiceNote?: boolean }) {
    const uploaded = await this.im.attachments.upload({
      fileName: basename(filePath),
      data: new Uint8Array(await readFile(filePath)),
    });
    const sent = await this.im.messages.sendAttachment(await this.chatFor(toHandle), uploaded.attachment.guid, {
      replyTo: opts?.replyToId,
      isAudioMessage: opts?.asVoiceNote,
    });
    return sent.guid;
  }

  async downloadAttachment(attachmentId: string, fileName: string): Promise<string> {
    await mkdir(TMP_DIR, { recursive: true });
    const chunks: Uint8Array[] = [];
    for await (const frame of this.im.attachments.downloadStream(attachmentId)) {
      if (frame.type === "primaryChunk") chunks.push(frame.data);
    }
    const path = join(TMP_DIR, `${attachmentId.replace(/[^\w-]/g, "_")}-${basename(fileName)}`);
    await writeFile(path, Buffer.concat(chunks));
    return path;
  }

  async setTyping(toHandle: string, on: boolean) {
    await this.im.chats.setTyping(await this.chatFor(toHandle), on).catch(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Direct chat GUIDs look like "any;-;+15551234567". */
function handleFromChatGuid(chatGuid: string): string | undefined {
  const [, sep, address] = chatGuid.split(";");
  return sep === "-" ? address : undefined;
}

function firstAttachment(m: Message): AttachmentRef | undefined {
  const a = m.content.attachments.find((x) => !x.isHidden);
  return a ? { id: a.guid, fileName: a.fileName, mimeType: a.mimeType } : undefined;
}

function kindOf(m: Message, a: AttachmentRef | undefined): MessageKind {
  if (!a) return "text";
  if (m.isAudioMessage || a.mimeType.startsWith("audio/")) return "voice";
  if (a.mimeType.startsWith("image/")) return "image";
  return "file";
}
