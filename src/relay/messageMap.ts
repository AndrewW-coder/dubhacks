// Maps an original message to its copy in every member's thread. Owned by User 1.
// Needed so replies, tapbacks, edits, and unsends land on the right copy.
//
// The sender's own original counts as their "copy", so a tapback on the
// original (in the sender's thread) is mirrored onto everyone else's copy too.

import type { Translation } from "../types.js";

export interface OriginalInfo {
  fromHandle: string;
  text?: string;
  sentAt: Date;
}

export interface Copy {
  messageId: string;
  translation?: Translation; // what this recipient was shown (for "?" and edits)
  sentAt: Date; // iMessage only allows edits for 15 min and unsends for 2 min after this
}

const originals = new Map<string, OriginalInfo>(); // originalId → info
const copies = new Map<string, Map<string, Copy>>(); // originalId → (handle → copy)
const copyToOriginal = new Map<string, string>(); // any copy ID → originalId
const lastInThread = new Map<string, string>(); // handle → most recent originalId shown there

export function recordOriginal(originalId: string, info: OriginalInfo): void {
  originals.set(originalId, info);
  recordRelay(originalId, info.fromHandle, originalId);
}

export function recordRelay(originalId: string, handle: string, messageId: string, translation?: Translation): void {
  if (!copies.has(originalId)) copies.set(originalId, new Map());
  const existing = copies.get(originalId)!.get(handle);
  const sentAt = existing?.messageId === messageId ? existing.sentAt : new Date(); // an edit keeps the original send time
  copies.get(originalId)!.set(handle, { messageId, translation, sentAt });
  copyToOriginal.set(messageId, originalId);
  lastInThread.set(handle, originalId);
}

export function getOriginal(originalId: string): OriginalInfo | undefined {
  return originals.get(originalId);
}

export function updateOriginalText(originalId: string, text: string): void {
  const o = originals.get(originalId);
  if (o) o.text = text;
}

export function getCopies(originalId: string): Map<string, Copy> {
  return copies.get(originalId) ?? new Map();
}

/** Given any message ID (an original or a relayed copy), find the original's ID. */
export function findOriginal(messageId: string): string | undefined {
  return copyToOriginal.get(messageId);
}

/** The most recent message shown in a member's thread (for a bare "?" with no reply target). */
export function lastOriginalIn(handle: string): string | undefined {
  return lastInThread.get(handle);
}
