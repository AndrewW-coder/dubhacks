// Bridge to User 1's not-yet-written shopping pieces. Owned by User 2 (spec U2-10c).
//
//   familyVote(...)  → relay/vote.ts (U1) if it exists, else the stand-in below
//   trackOrder(...)  → shop/orders.ts (U1) if it exists, else a one-off confirmation
//   shopLimitUsd(m) / shipTo(m) → FamilyMember fields from U1's contract commit, read with an
//                    optional cast so types.ts stays untouched until then
//
// The modules are imported through a variable specifier, so tsc never needs the files. When
// User 1 merges them, they are used with no code change here.
//
// Card contract (agreed with the orchestrator, additive to VISA-SHOPPING.md): `card(reader)` may
// return a string[]: element 0 is the heading, elements 1..n are option cards A..n, each sent as
// its own message in order (so iMessage previews each card's link). A single string stays valid.
//
// Vote stand-in rules:
//   - a letter A–D (or 1–4) votes for that option, from a bare message or a threaded reply;
//   - a tapback on option card i votes for option i (any kind except 👎 and ❓, which aren't votes);
//   - a tapback on the heading (or the reminder) uses 👍 A · ❤️ B · 😂 C · ‼️ D;
//   - VoteResult.how says HOW each member voted. Only "card" (a ❤️ or ‼️ tapback on that option's
//     own card) is unambiguous enough to count as the buyer's agreement (spec U2-13 core rule).
//     A letter (bare or threaded: prompts.ts can't tell them apart), a 👍/😂, or a heading tapback
//     is "letter"/"tapback": a vote, never consent. U1's familyVote gives no `how`, so the buyer
//     is always asked to confirm there;
//   - other open questions (M-2): a voter with an open money question (hasOpenMoneyPrompt), or
//     another open Bridge question (relay/prompts.js hasOtherOpenPrompt / openPromptsFor, when
//     User 1 adds them: feature-detected), gets no vote prompts until it closes, so the cards
//     can't take its answer; and a bare letter that arrives while one is open is never a vote;
//   - the first vote per person counts; it closes on a majority, when everyone voted, or on the
//     timeout (most votes; ties go to the earliest option; nobody voted → winner null).
// Votes are never relayed: every heading/card is a prompt (relay/prompts.ts) that stays open
// until that person votes. prompts.ts has no peek/cancel, so a bare "ok"/"yes"/"好" during the
// vote lands on a vote prompt; it's passed on (to an older prompt of that person, e.g. a money
// question, else relayed as normal chat), and once all of a voter's prompts are used up that way,
// Bridge re-opens the vote with one short reminder message.
//
// Settings (optional, read from process.env here):
//   SHOP_VOTE_TIMEOUT_MS   default vote window for callers (voteTimeoutMs(), default 120000)

import { config } from "../config.js";
import { sendText } from "../photon/client.js";
import { ask, tryResolvePrompt, type Answer } from "../relay/prompts.js";
import * as promptsModule from "../relay/prompts.js";
import { say } from "../relay/say.js";
import { hasOpenMoneyPrompt } from "../payments/flow.js";
import { formatMoney } from "../payments/visa.js";
import type { Family, FamilyMember, IncomingMessage, TapbackKind } from "../types.js";
import type { Product } from "./catalog.js";
import type { OrderResult } from "./checkout.js";

/** How a member voted: "card" = ❤️/‼️ on that option's own card (unambiguous); else a vote only. */
export type VoteHow = "card" | "tapback" | "letter";
export interface VoteResult {
  winner: number | null;
  votes: Map<string, number>; // member id → option index
  how?: Map<string, VoteHow>; // member id → how they voted (the stand-in sets it; U1's may not)
}
/** Extra context for the order confirmation (ignored by U1's trackOrder until it wants it). */
export interface OrderInfo {
  /** The need's occasion or category: "gift" wording only for a gift. */
  isGift?: boolean;
  /** What was bought, in English ("blood pressure monitor"), for "Mei ordered a new …". */
  what?: string;
}
export type VoteCard = (reader: FamilyMember) => Promise<string | string[]>;

export function voteTimeoutMs(): number {
  const n = Number(process.env.SHOP_VOTE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

/** FamilyMember.shopLimitUsd (U1's contract field), if set. */
export function shopLimitUsd(member: FamilyMember): number | undefined {
  const v = (member as FamilyMember & { shopLimitUsd?: unknown }).shopLimitUsd;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** FamilyMember.shipTo (U1's contract field), if set. City + country only, never a street address. */
export function shipTo(member: FamilyMember): { city: string; country: string } | undefined {
  const v = (member as FamilyMember & { shipTo?: { city?: unknown; country?: unknown } }).shipTo;
  return v && typeof v.city === "string" && typeof v.country === "string" ? { city: v.city, country: v.country } : undefined;
}

// ── Optional User 1 modules ─────────────────────────────────────────────────

type VoteModule = { familyVote: (f: Family, v: FamilyMember[], c: VoteCard, n: number, t: number) => Promise<VoteResult> };
type OrdersModule = { trackOrder: (f: Family, b: FamilyMember, m: FamilyMember, p: Product, o: OrderResult) => void };

const VOTE_MODULE = "../relay/vote.js";
const ORDERS_MODULE = "./orders.js";
const loaded = new Map<string, Promise<unknown>>();

/** Test hook: force the stand-ins even if User 1's modules exist. */
export const u1Options = { useStandIns: false };

async function optional<T>(specifier: string, fn: string): Promise<T | undefined> {
  if (u1Options.useStandIns) return undefined;
  if (!loaded.has(specifier)) {
    loaded.set(
      specifier,
      import(specifier).then(
        (m: Record<string, unknown>) => (typeof m[fn] === "function" ? m : undefined),
        (err: { code?: string }) => {
          if (err?.code !== "ERR_MODULE_NOT_FOUND") console.error(`[shop] couldn't load ${specifier}, using the stand-in`, err);
          return undefined;
        },
      ),
    );
  }
  return (await loaded.get(specifier)) as T | undefined;
}

export async function familyVote(family: Family, voters: FamilyMember[], card: VoteCard, optionCount: number, timeoutMs: number): Promise<VoteResult> {
  const mod = await optional<VoteModule>(VOTE_MODULE, "familyVote");
  if (mod) return mod.familyVote(family, voters, card, optionCount, timeoutMs);
  return standInVote(family, voters, card, optionCount, timeoutMs);
}

export function trackOrder(family: Family, buyer: FamilyMember, forMember: FamilyMember, product: Product, order: OrderResult, info: OrderInfo = {}): void {
  void optional<OrdersModule>(ORDERS_MODULE, "trackOrder")
    .then((mod) => (mod ? mod.trackOrder(family, buyer, forMember, product, order) : standInTrackOrder(family, buyer, forMember, product, order, info)))
    .catch((err) => console.error("[shop] order confirmation failed", err));
}

// ── Vote stand-in ───────────────────────────────────────────────────────────

const LETTERS = ["A", "B", "C", "D"];
const TAPBACK_LETTER: Partial<Record<TapbackKind, number>> = { like: 0, love: 1, laugh: 2, emphasize: 3 };
const ICONS = ["👍", "❤️", "😂", "‼️"];
/** Tapbacks on an option's own card that say "this one" clearly enough to be the buyer's yes. */
const CONSENT_TAPBACKS = new Set<TapbackKind>(["love", "emphasize"]);
/** How often a held-back voter is re-checked for a closed money / other question. */
const BUSY_POLL_MS = 250;
/** Live iMessage sends run in parallel; a short gap keeps the heading and cards in order. */
const SEND_GAP_MS = config.photonMode === "live" ? 700 : 0;

let fwdSeq = 0;

/**
 * Does this voter have another open Bridge question (not one of our `ownOpen` vote prompts)?
 * Uses relay/prompts.js hasOtherOpenPrompt / openPromptsFor when User 1 adds them (feature-
 * detected, any of: boolean, count, or list result); false until then. Never throws.
 */
export function hasOtherOpenQuestion(handle: string, ownOpen = 0): boolean {
  try {
    const p = promptsModule as unknown as Record<string, unknown>;
    if (typeof p.openPromptsFor === "function") {
      const r = (p.openPromptsFor as (h: string) => unknown)(handle);
      const n = Array.isArray(r) ? r.length : typeof r === "number" ? r : r instanceof Map || r instanceof Set ? r.size : 0;
      return n > ownOpen;
    }
    // A plain yes/no can't tell our own prompts from others: only trusted before we open any.
    if (typeof p.hasOtherOpenPrompt === "function" && ownOpen === 0) return Boolean((p.hasOtherOpenPrompt as (h: string) => unknown)(handle));
  } catch (err) {
    console.error("[shop] open-prompt check failed", err);
  }
  return false;
}

/** A bare answer that wasn't a vote: give it to the person's next open prompt, else relay it as chat. */
export async function passOn(member: FamilyMember, text: string): Promise<void> {
  const msg: IncomingMessage = { id: `shop-fwd-${++fwdSeq}`, fromHandle: member.handle, kind: "text", text, receivedAt: new Date() };
  if (tryResolvePrompt(msg)) return;
  const { handleIncoming } = await import("../relay/router.js"); // lazy: router → flow → shopFlow → here
  await handleIncoming(msg);
}

/** "B", "b.", "B!", "2" → 1. Undefined if it isn't a vote for one of `n` options. */
export function parseVote(text: string, n: number): number | undefined {
  const t = text.trim().replace(/[.!。！]+$/, "").trim().toUpperCase();
  let i = LETTERS.indexOf(t);
  if (i < 0 && /^[1-4]$/.test(t)) i = Number(t) - 1;
  return i >= 0 && i < n ? i : undefined;
}

function standInVote(family: Family, voters: FamilyMember[], card: VoteCard, optionCount: number, timeoutMs: number): Promise<VoteResult> {
  const n = Math.max(1, Math.min(optionCount, LETTERS.length));
  const votes = new Map<string, number>();
  const how = new Map<string, VoteHow>();
  let closed = false;

  return new Promise<VoteResult>((resolve) => {
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      resolve({ winner: tally(votes, n), votes, how });
    };
    const timer = setTimeout(finish, timeoutMs);
    const maybeFinish = () => {
      const counts = countVotes(votes, n);
      if (votes.size >= voters.length || counts.some((c) => c > voters.length / 2)) finish();
    };
    const promptMs = timeoutMs + 5_000; // prompts outlive the vote a little; late answers are passed on

    const openVoter = async (voter: FamilyMember) => {
      const raw = await card(voter);
      // M-2: while this voter has an open money question (or another open Bridge question), hold
      // their cards back, so the newest prompt (the one a bare "yes"/"A" lands on) stays theirs.
      while (!closed && (hasOpenMoneyPrompt(voter) || hasOtherOpenQuestion(voter.handle, 0))) await new Promise((r) => setTimeout(r, BUSY_POLL_MS));
      const parts = Array.isArray(raw) ? raw : [raw];
      let open = 0; // this voter's prompts that can still take a vote

      const onAnswer = async (answer: Answer | null, cardIndex: number | undefined) => {
        if (!answer) return; // the prompt timed out
        open--;
        const voted = votes.has(voter.id);
        if (answer.via === "text") {
          // A bare letter is never a vote while this voter has another question open (M-2).
          const busy = hasOpenMoneyPrompt(voter) || hasOtherOpenQuestion(voter.handle, open);
          const v = closed || voted || busy ? undefined : parseVote(answer.text, n);
          if (v !== undefined) {
            votes.set(voter.id, v);
            how.set(voter.id, "letter");
            return maybeFinish();
          }
          await passOn(voter, answer.text); // chat that happened to look like an answer ("ok", "好")
        } else if (!closed && !voted && answer.tapback !== "dislike" && answer.tapback !== "question") {
          const v = cardIndex ?? TAPBACK_LETTER[answer.tapback];
          if (v !== undefined && v < n) {
            votes.set(voter.id, v);
            how.set(voter.id, cardIndex !== undefined && CONSENT_TAPBACKS.has(answer.tapback) ? "card" : "tapback");
            return maybeFinish();
          }
        }
        if (!closed && !votes.has(voter.id) && open === 0) await reopen();
      };

      const register = (text: string, cardIndex: number | undefined) => {
        open++;
        void ask(voter.handle, text, promptMs)
          .then((a) => onAnswer(a, cardIndex))
          .catch((err) => console.error("[shop] vote prompt failed", err));
      };

      const reopen = async () => {
        const letters = LETTERS.slice(0, n).join(", ");
        const icons = ICONS.slice(0, n).map((icon, i) => `${icon} ${LETTERS[i]}`).join(" · ");
        register(`🗳️ ${await say(family, voter, `Still deciding: reply ${letters}, or tapback this message`)} (${icons})`, undefined);
      };

      for (let i = 0; i < parts.length; i++) {
        if (closed) return;
        // With a heading + cards, part i (1..n) is option i-1; anything else uses the tapback letters.
        const cardIndex = parts.length > 1 && i >= 1 && i <= n ? i - 1 : undefined;
        register(parts[i]!, cardIndex);
        if (SEND_GAP_MS) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
        else await new Promise((r) => setImmediate(r)); // let the send start before the next one
      }
    };

    void Promise.all(voters.map((v) => openVoter(v).catch((err) => console.error("[shop] couldn't send the cards to", v.id, err))));
  });
}

function countVotes(votes: Map<string, number>, n: number): number[] {
  const counts = new Array<number>(n).fill(0);
  for (const v of votes.values()) if (v >= 0 && v < n) counts[v]!++;
  return counts;
}

/** Most votes; ties go to the earliest option; no votes → null. */
export function tally(votes: Map<string, number>, n: number): number | null {
  const counts = countVotes(votes, n);
  let best = -1;
  counts.forEach((c, i) => {
    if (c > 0 && (best < 0 || c > counts[best]!)) best = i;
  });
  return best < 0 ? null : best;
}

// ── trackOrder stand-in ─────────────────────────────────────────────────────

/**
 * In each reader's language: "Kevin bought Nai Nai a gift 🎁, arriving Thursday." for a gift
 * occasion, else "Mei ordered a new blood pressure monitor for Nai Nai, arriving Thursday.".
 * Names, product and price are never translated.
 */
async function standInTrackOrder(family: Family, buyer: FamilyMember, forMember: FamilyMember, product: Product, order: OrderResult, info: OrderInfo = {}): Promise<void> {
  const day = order.eta ? weekday(order.eta) : undefined;
  const arriving = day ? `, arriving ${day}` : "";
  const thing = (info.what ?? "").replace(/^(a|an|the|some)\s+/i, "").trim();
  const ordered = thing && !/^something\b/i.test(thing) ? `a new ${thing}` : "a new item";
  await Promise.all(
    family.members.map(async (reader) => {
      const who = reader.id === buyer.id ? "You" : buyer.name;
      const to = reader.id === forMember.id ? "you" : forMember.name;
      const sentence = info.isGift
        ? `${who} bought ${to} a gift 🎁${arriving}.`
        : `${who} ordered ${ordered} for ${to}${arriving}.`;
      const name = product.name[reader.language] ?? product.name[reader.language.split("-")[0]!] ?? product.name.en ?? product.id;
      const paid = reader.id === buyer.id && order.charged ? ` · ${formatMoney(order.charged.amount, order.charged.currency)}` : "";
      const ref = reader.id === buyer.id && order.orderId ? ` · #${order.orderId}` : "";
      await sendText(reader.handle, `✅ ${await say(family, reader, sentence)}\n🛍️ ${name}${paid}${ref}`);
    }),
  );
}

function weekday(iso: string): string | undefined {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
