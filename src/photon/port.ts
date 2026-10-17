// The one interface between Bridge and iMessage. Both the live Photon client
// (live.ts) and the terminal simulator (mock.ts) implement it, so everything
// above this layer works the same in both modes.
//
// FROZEN after Phase 0 (owned by User 1). Everyone may CALL these functions;
// only User 1 changes this file.
//
// Everything is addressed by member handle (phone number / Apple ID). Chat
// GUIDs are a Photon detail and never leave src/photon.

import type { IncomingMessage, TapbackKind } from "../types.js";

export interface MessagingPort {
  /** Starts receiving. The handler is called once per incoming event, oldest first. */
  start(handler: (message: IncomingMessage) => Promise<void>): Promise<void>;
  /** Sends text into the member's 1:1 thread with Bridge. Returns the new message's GUID. */
  sendText(toHandle: string, text: string, opts?: { replyToId?: string }): Promise<string>;
  /** Adds (or with remove=true, removes) a tapback on a message in that member's thread. */
  sendTapback(toHandle: string, messageId: string, tapback: TapbackKind, remove?: boolean): Promise<void>;
  /** Edits a message Bridge sent. iMessage allows this for ~15 minutes after sending. */
  editMessage(toHandle: string, messageId: string, newText: string): Promise<void>;
  /** Unsends a message Bridge sent. iMessage allows this for ~2 minutes after sending. */
  unsendMessage(toHandle: string, messageId: string): Promise<void>;
  /** Sends a local file (photo, audio, …). Returns the new message's GUID. */
  sendFile(toHandle: string, filePath: string, opts?: { replyToId?: string; asVoiceNote?: boolean }): Promise<string>;
  /** Downloads an incoming attachment to a local temp file and returns its path. */
  downloadAttachment(attachmentId: string, fileName: string): Promise<string>;
  /** Shows or hides the "…" typing bubble in the member's thread. */
  setTyping(toHandle: string, on: boolean): Promise<void>;
}
