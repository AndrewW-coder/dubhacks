// Maps an original message to its copy in every member's thread. Owned by User 1.
// Needed so replies, tapbacks, edits, and unsends land on the right copy.
//
// The sender's own original counts as their "copy", so a tapback on the
// original (in the sender's thread) is mirrored onto everyone else's copy too.
//
// In live mode the map is saved to .bridge-tmp/message-map.json (MESSAGE_MAP_FILE overrides;
// "off" disables) and reloaded on start, so a restart mid-demo doesn't break replies, tapbacks
// and edits on earlier messages. Entries older than 3 days, or beyond the newest 3000 messages,
// are dropped. The simulator never loads or saves it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  scheduleSave();
}

export function getOriginal(originalId: string): OriginalInfo | undefined {
  return originals.get(originalId);
}

export function updateOriginalText(originalId: string, text: string): void {
  const o = originals.get(originalId);
  if (o) o.text = text;
  scheduleSave();
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

// ── Saving across restarts (live mode only) ─────────────────────────────────

const MAX_MESSAGES = 3000;
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;

function mapFile(): string | undefined {
  const v = (process.env.MESSAGE_MAP_FILE ?? "").trim();
  if (v.toLowerCase() === "off") return undefined;
  if (v) return resolve(v);
  return (process.env.PHOTON_MODE ?? "").trim().toLowerCase() === "live" ? resolve(".bridge-tmp", "message-map.json") : undefined;
}

interface Saved {
  version: 1;
  originals: [string, { fromHandle: string; text?: string; sentAt: string }][];
  copies: [string, [string, { messageId: string; translation?: Translation; sentAt: string }][]][];
  lastInThread: [string, string][];
}

let saveTimer: NodeJS.Timeout | undefined;

function scheduleSave() {
  if (saveTimer || !mapFile()) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    save();
  }, 500);
  saveTimer.unref?.();
}

function save() {
  const file = mapFile();
  if (!file) return;
  try {
    prune();
    const data: Saved = {
      version: 1,
      originals: [...originals].map(([id, o]) => [id, { ...o, sentAt: o.sentAt.toISOString() }]),
      copies: [...copies].map(([id, m]) => [id, [...m].map(([h, c]) => [h, { ...c, sentAt: c.sentAt.toISOString() }])]),
      lastInThread: [...lastInThread],
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file); // never leave a half-written file behind
  } catch (err) {
    console.error("[map] couldn't save the message map", err);
  }
}

/** Drop messages older than 3 days, then keep only the newest MAX_MESSAGES. */
function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  const newest = (id: string) => Math.max(...[...(copies.get(id)?.values() ?? [])].map((c) => c.sentAt.getTime()), originals.get(id)?.sentAt.getTime() ?? 0);
  const ids = [...copies.keys()];
  const drop = new Set(ids.filter((id) => newest(id) < cutoff));
  const kept = ids.filter((id) => !drop.has(id));
  for (const id of kept.slice(0, Math.max(0, kept.length - MAX_MESSAGES))) drop.add(id); // oldest first (insertion order)
  for (const id of drop) {
    for (const c of copies.get(id)?.values() ?? []) copyToOriginal.delete(c.messageId);
    copies.delete(id);
    originals.delete(id);
  }
  for (const [h, id] of lastInThread) if (drop.has(id)) lastInThread.delete(h);
}

function load() {
  const file = mapFile();
  if (!file || !existsSync(file)) return;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Saved;
    if (data.version !== 1) return;
    for (const [id, o] of data.originals) originals.set(id, { ...o, sentAt: new Date(o.sentAt) });
    for (const [id, list] of data.copies) {
      const m = new Map<string, Copy>();
      for (const [h, c] of list) {
        m.set(h, { ...c, sentAt: new Date(c.sentAt) });
        copyToOriginal.set(c.messageId, id);
      }
      copies.set(id, m);
    }
    for (const [h, id] of data.lastInThread) lastInThread.set(h, id);
    prune();
    console.log(`[map] restored ${copies.size} messages from ${file}`);
  } catch (err) {
    console.error("[map] couldn't read the saved message map; starting fresh", err);
  }
}

load();
process.once("exit", () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    save();
  }
});
