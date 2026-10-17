// Entry point for messaging. Picks the live Photon client or the terminal
// simulator based on PHOTON_MODE, and re-exports the port's functions so the
// rest of the app can just `import { sendText } from "../photon/client.js"`.
//
// FROZEN after Phase 0 (owned by User 1).

import { config } from "../config.js";
import type { MessagingPort } from "./port.js";
import type { IncomingMessage, TapbackKind } from "../types.js";

let port: MessagingPort | undefined;

async function getPort(): Promise<MessagingPort> {
  if (!port) {
    port =
      config.photonMode === "live"
        ? new (await import("./live.js")).LivePhotonClient()
        : new (await import("./mock.js")).MockPhotonClient();
  }
  return port;
}

export async function onMessage(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
  await (await getPort()).start(handler);
}

export async function sendText(toHandle: string, text: string, opts?: { replyToId?: string }): Promise<string> {
  return (await getPort()).sendText(toHandle, text, opts);
}

export async function sendTapback(toHandle: string, messageId: string, tapback: TapbackKind, remove = false) {
  return (await getPort()).sendTapback(toHandle, messageId, tapback, remove);
}

export async function editMessage(toHandle: string, messageId: string, newText: string) {
  return (await getPort()).editMessage(toHandle, messageId, newText);
}

export async function unsendMessage(toHandle: string, messageId: string) {
  return (await getPort()).unsendMessage(toHandle, messageId);
}

export async function sendFile(
  toHandle: string,
  filePath: string,
  opts?: { replyToId?: string; asVoiceNote?: boolean },
): Promise<string> {
  return (await getPort()).sendFile(toHandle, filePath, opts);
}

export async function downloadAttachment(attachmentId: string, fileName: string): Promise<string> {
  return (await getPort()).downloadAttachment(attachmentId, fileName);
}

export async function setTyping(toHandle: string, on: boolean) {
  return (await getPort()).setTyping(toHandle, on);
}
