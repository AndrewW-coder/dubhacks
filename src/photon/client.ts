// Thin wrapper around the Photon SDK so the rest of the app never imports it directly.
// TODO: install the Photon 2.0 SDK and wire these up (check their docs / booth for setup).

import type { IncomingMessage } from "../types.js";

export function onMessage(handler: (message: IncomingMessage) => Promise<void>): void {
  // TODO: subscribe to incoming iMessages and convert them to IncomingMessage
}

/** Sends a message and returns its iMessage ID (needed for the relay message map). */
export async function sendText(toHandle: string, text: string, replyToId?: string): Promise<string> {
  // TODO
  throw new Error("not implemented");
}

export async function sendTapback(toHandle: string, messageId: string, tapback: string): Promise<void> {
  // TODO
}

export async function editMessage(toHandle: string, messageId: string, newText: string): Promise<void> {
  // TODO
}

export async function unsendMessage(toHandle: string, messageId: string): Promise<void> {
  // TODO
}

export async function sendAttachment(toHandle: string, filePath: string): Promise<string> {
  // TODO
  throw new Error("not implemented");
}
