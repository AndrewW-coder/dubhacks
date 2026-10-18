// Family vote: show everyone the same options, in their own language, and let
// them pick with a tapback or a letter. Owned by User 1 (docs/specs/VISA-SHOPPING.md,
// U1-SHOPPING-HANDOFF.md). Used by the shopping flow through src/shop/u1.ts.
//
// `card(reader)` returns one message, or a heading + one card per option:
//   [heading, card A, card B, …]  each sent as its own message, in order.
// A card may be { text, image }: the image (a rendered card) is sent first, then the text
// (letter + link). Both are that option's card: a tapback on either is a vote for it.
//
// What counts as a vote (first vote per person wins):
//   - a tapback on option card i → option i (any kind but 👎 / ❓, which aren't votes);
//   - a tapback on the heading (or a single-message card): 👍 A · ❤️ B · 😂 C · ‼️ D;
//   - a letter A–D or 1–4, as a threaded reply to any of the vote's messages, or bare.
//     A bare letter is NOT a vote while the voter has another Bridge question open
//     (a translation review, a money question), so "A" reaches that question instead.
// A voter with a money question in progress gets their cards once it closes (spec U2-13, M-2),
// or after MAX_HOLD_MS at the latest: a bare answer still goes to that question either way.
// Everything else is relayed as normal chat: "is B too heavy?" as a threaded reply to a
// card threads onto the same card in everyone else's thread (cards are in messageMap).
//
// VoteResult.how says how each member voted. Only "card" (❤️ or ‼️ on that option's own
// card) is clear enough for the shopping flow to treat as the buyer's agreement.
//
// Everyone sees the votes as they come in: each vote is mirrored as a tapback on that card in
// the other voters' threads (the voter's own tapback kind, or 👍 for a letter).
//
// Closes when a majority agrees, everyone has voted, or `timeoutMs` passes. Most votes wins; a
// tie goes to `opts.tieBreaker`'s pick (the shopping flow passes the buyer), else the earliest
// option; nobody → null. The vote's prompts are then withdrawn.

import { cancel, hasOtherOpenPrompt, openPrompt, type Answer } from "./prompts.js";
import * as map from "./messageMap.js";
import { hasOpenMoneyPrompt } from "../payments/flow.js";
import { sendTapback } from "../photon/client.js";
import type { Family, FamilyMember, TapbackKind } from "../types.js";

export type VoteHow = "card" | "tapback" | "letter";
export interface VoteResult {
  winner: number | null; // option index, or null if nobody voted in time
  votes: Map<string, number>; // member id → option index
  how: Map<string, VoteHow>; // member id → how they voted
}
export type VotePart = string | { text: string; image?: string };
export type VoteCard = (reader: FamilyMember) => Promise<string | VotePart[]>;

const LETTERS = ["A", "B", "C", "D"];
const TAPBACK_OPTION: Partial<Record<TapbackKind, number>> = { like: 0, love: 1, laugh: 2, emphasize: 3 };
const NOT_VOTES = new Set<TapbackKind>(["dislike", "question"]);
const CLEAR_ON_CARD = new Set<TapbackKind>(["love", "emphasize"]);
const BUSY_POLL_MS = 250;
const MAX_HOLD_MS = 10_000; // never hold someone's cards longer than this
const IMAGE_SEND_MS = 20_000; // an image that hasn't sent by then is replaced by its text card

let voteSeq = 0;

export function familyVote(
  family: Family,
  voters: FamilyMember[],
  card: VoteCard,
  optionCount: number,
  timeoutMs: number,
  opts: { tieBreaker?: string } = {}, // member id whose pick breaks a tie
): Promise<VoteResult> {
  const n = Math.max(1, Math.min(optionCount, LETTERS.length));
  const id = `vote-${++voteSeq}`;
  const votes = new Map<string, number>();
  const how = new Map<string, VoteHow>();
  const prompts = new Map<string, string[]>(); // member id → this vote's open prompt IDs
  const cards = new Map<string, string[]>(); // member id → card message IDs by option (heading + cards layout only)
  const shown = new Map<string, TapbackKind>(); // member id → tapback that shows their vote to others
  let closed = false;

  return new Promise<VoteResult>((resolve) => {
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const ids of prompts.values()) ids.forEach(cancel);
      resolve({ winner: tally(votes, n, opts.tieBreaker), votes, how });
    };
    const timer = setTimeout(finish, timeoutMs);

    /** Show `voter`'s vote as a tapback on that card in `reader`'s thread. */
    const mirror = (voter: FamilyMember, reader: FamilyMember) => {
      const option = votes.get(voter.id);
      const target = option === undefined ? undefined : cards.get(reader.id)?.[option];
      if (!target || reader.id === voter.id) return;
      sendTapback(reader.handle, target, shown.get(voter.id) ?? "like").catch((err) =>
        console.error("[vote] couldn't show the vote to", reader.id, err),
      );
    };

    const record = (voter: FamilyMember, option: number, kind: VoteHow, tapback?: TapbackKind) => {
      votes.set(voter.id, option);
      how.set(voter.id, kind);
      shown.set(voter.id, tapback ?? "like");
      for (const reader of voters) mirror(voter, reader);
      (prompts.get(voter.id) ?? []).forEach(cancel); // done voting: their other cards stop taking answers
      const counts = countVotes(votes, n);
      if (votes.size >= voters.length || counts.some((c) => c > voters.length / 2)) finish();
    };

    /** Which option an answer on part `cardIndex` (undefined = heading / single card) votes for. */
    const optionFor = (voter: FamilyMember, answer: Answer, cardIndex: number | undefined): number | undefined => {
      if (closed || votes.has(voter.id)) return undefined;
      if (answer.via === "tapback") {
        if (NOT_VOTES.has(answer.tapback)) return undefined;
        const option = cardIndex ?? TAPBACK_OPTION[answer.tapback];
        return option !== undefined && option < n ? option : undefined;
      }
      // A bare letter yields to the voter's other open questions (a translation review, a money question).
      if (!answer.threaded && busy(voter, prompts.get(voter.id))) return undefined;
      return parseVote(answer.text, n);
    };

    const sendCards = async (voter: FamilyMember) => {
      const raw = await card(voter);
      // Hold the cards briefly while another question is open, so it stays the newest one.
      const holdStart = Date.now();
      if (busy(voter)) console.log(`[vote] holding ${voter.name}'s cards: another question is open`);
      while (!closed && busy(voter) && Date.now() - holdStart < MAX_HOLD_MS) await new Promise((r) => setTimeout(r, BUSY_POLL_MS));
      if (closed) return;
      const parts = Array.isArray(raw) ? raw : [raw];
      console.log(`[vote] sending ${voter.name} ${parts.length} message(s)${parts.some((p) => typeof p !== "string" && p.image) ? " with card images" : ""}`);
      const ids: string[] = [];
      prompts.set(voter.id, ids);
      const cardIds: string[] = [];
      if (parts.length > 1) cards.set(voter.id, cardIds);
      for (let i = 0; i < parts.length; i++) {
        if (closed) return;
        // With a heading + cards, part i (1..n) is option i-1.
        const cardIndex = parts.length > 1 && i >= 1 && i <= n ? i - 1 : undefined;
        const part = parts[i]!;
        const messages = typeof part === "string" ? [{ text: part }] : part.image ? [{ text: "", file: part.image, key: "img" }, { text: part.text }] : [{ text: part.text }];
        let textAlreadySent = false;
        for (const m of messages) {
          if (closed) return;
          if (textAlreadySent) break;
          const prompt = (text: string, filePath?: string) =>
            openPrompt(voter.handle, text, { timeoutMs: timeoutMs + 5_000, accept: (a) => optionFor(voter, a, cardIndex) !== undefined, filePath });
          let sent: Awaited<ReturnType<typeof prompt>>;
          let key = "key" in m ? `-${m.key}` : "";
          if ("file" in m) {
            // A stuck image upload must never hold up this person's other cards: fall back to the text line.
            const image = await withTimeout(prompt("", m.file), IMAGE_SEND_MS).catch((err) => {
              console.warn(`[vote] card image to ${voter.name} didn't send (${err instanceof Error ? err.message : err}); sending the text card`);
              return undefined;
            });
            if (image) sent = image;
            else {
              sent = await prompt(typeof part === "string" ? part : part.text);
              textAlreadySent = true;
              key = "";
            }
          } else {
            sent = await prompt(m.text);
          }
          const { messageId, answer } = sent;
          ids.push(messageId);
          if (cardIndex !== undefined) cardIds[cardIndex] ??= messageId; // votes show on the image when there is one
          if (closed) cancel(messageId);
          // Each part is a shared "original" with one copy per voter, so threaded replies and
          // tapbacks that aren't votes land on the same card in everyone else's thread.
          // (Copies only: there is no sender's original, so nothing is ever mirrored back to "Bridge".)
          map.recordRelay(`${id}-part-${i}${key}`, voter.handle, messageId);
          void answer.then((a) => {
            if (!a) return; // withdrawn or timed out
            const option = optionFor(voter, a, cardIndex);
            if (option === undefined) return;
            const kind: VoteHow =
              a.via === "text" ? "letter" : cardIndex === option && CLEAR_ON_CARD.has(a.tapback) ? "card" : "tapback";
            record(voter, option, kind, a.via === "tapback" ? a.tapback : undefined);
          });
        }
      }
      // Cards that went out late (held for another question) still show the votes so far.
      for (const other of voters) mirror(other, voter);
    };

    for (const voter of voters) {
      sendCards(voter).catch((err) => console.error("[vote] couldn't send the cards to", voter.id, err));
    }
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
}

/** Another Bridge question open for this voter, besides the vote's own prompts? */
function busy(voter: FamilyMember, ownIds: string[] = []): boolean {
  return hasOpenMoneyPrompt(voter) || hasOtherOpenPrompt(voter.handle, ownIds);
}

/** "B", "b.", "B!", "2" → 1. Undefined if it isn't a vote for one of `n` options. */
export function parseVote(text: string, n: number): number | undefined {
  const t = text.trim().replace(/[.!。！]+$/, "").trim().toUpperCase();
  let i = LETTERS.indexOf(t);
  if (i < 0 && /^[1-4]$/.test(t)) i = Number(t) - 1;
  return i >= 0 && i < n ? i : undefined;
}

function countVotes(votes: Map<string, number>, n: number): number[] {
  const counts = new Array<number>(n).fill(0);
  for (const v of votes.values()) if (v >= 0 && v < n) counts[v]!++;
  return counts;
}

/** Most votes; a tie goes to `tieBreaker`'s pick if it's among the tied, else the earliest; no votes → null. */
function tally(votes: Map<string, number>, n: number, tieBreaker?: string): number | null {
  const counts = countVotes(votes, n);
  const top = Math.max(...counts);
  if (top === 0) return null;
  const pick = tieBreaker === undefined ? undefined : votes.get(tieBreaker);
  if (pick !== undefined && counts[pick] === top) return pick;
  return counts.findIndex((c) => c === top);
}
