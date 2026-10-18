// Family vote: show everyone the same options, in their own language, and let
// them pick with a tapback or a letter. Owned by User 1 (docs/specs/VISA-SHOPPING.md,
// U1-SHOPPING-HANDOFF.md). Used by the shopping flow through src/shop/u1.ts.
//
// `card(reader)` returns one message, or a heading + one card per option:
//   [heading, card A, card B, …]  each sent as its own message, in order.
//
// What counts as a vote (first vote per person wins):
//   - a tapback on option card i → option i (any kind but 👎 / ❓, which aren't votes);
//   - a tapback on the heading (or a single-message card): 👍 A · ❤️ B · 😂 C · ‼️ D;
//   - a letter A–D or 1–4, as a threaded reply to any of the vote's messages, or bare.
//     A bare letter is NOT a vote while the voter has another Bridge question open
//     (a translation review, a money question), so "A" reaches that question instead.
// A voter with a money question in progress gets their cards once it closes (spec U2-13, M-2).
// Everything else is relayed as normal chat: "is B too heavy?" as a threaded reply to a
// card threads onto the same card in everyone else's thread (cards are in messageMap).
//
// VoteResult.how says how each member voted. Only "card" (❤️ or ‼️ on that option's own
// card) is clear enough for the shopping flow to treat as the buyer's agreement.
//
// Closes when a majority agrees, everyone has voted, or `timeoutMs` passes (most votes,
// ties to the earliest option, nobody → null). The vote's prompts are then withdrawn.

import { cancel, hasOtherOpenPrompt, openPrompt, type Answer } from "./prompts.js";
import * as map from "./messageMap.js";
import { hasOpenMoneyPrompt } from "../payments/flow.js";
import type { Family, FamilyMember, TapbackKind } from "../types.js";

export type VoteHow = "card" | "tapback" | "letter";
export interface VoteResult {
  winner: number | null; // option index, or null if nobody voted in time
  votes: Map<string, number>; // member id → option index
  how: Map<string, VoteHow>; // member id → how they voted
}
export type VoteCard = (reader: FamilyMember) => Promise<string | string[]>;

const LETTERS = ["A", "B", "C", "D"];
const TAPBACK_OPTION: Partial<Record<TapbackKind, number>> = { like: 0, love: 1, laugh: 2, emphasize: 3 };
const NOT_VOTES = new Set<TapbackKind>(["dislike", "question"]);
const CLEAR_ON_CARD = new Set<TapbackKind>(["love", "emphasize"]);
const BUSY_POLL_MS = 250;

let voteSeq = 0;

export function familyVote(
  family: Family,
  voters: FamilyMember[],
  card: VoteCard,
  optionCount: number,
  timeoutMs: number,
): Promise<VoteResult> {
  const n = Math.max(1, Math.min(optionCount, LETTERS.length));
  const id = `vote-${++voteSeq}`;
  const votes = new Map<string, number>();
  const how = new Map<string, VoteHow>();
  const prompts = new Map<string, string[]>(); // member id → this vote's open prompt IDs
  let closed = false;

  return new Promise<VoteResult>((resolve) => {
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const ids of prompts.values()) ids.forEach(cancel);
      resolve({ winner: tally(votes, n), votes, how });
    };
    const timer = setTimeout(finish, timeoutMs);

    const record = (voter: FamilyMember, option: number, kind: VoteHow) => {
      votes.set(voter.id, option);
      how.set(voter.id, kind);
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
      // Hold the cards while another question is open, so a bare "yes"/"A" stays with it.
      while (!closed && busy(voter)) await new Promise((r) => setTimeout(r, BUSY_POLL_MS));
      const parts = Array.isArray(raw) ? raw : [raw];
      const ids: string[] = [];
      prompts.set(voter.id, ids);
      for (let i = 0; i < parts.length; i++) {
        if (closed) return;
        // With a heading + cards, part i (1..n) is option i-1.
        const cardIndex = parts.length > 1 && i >= 1 && i <= n ? i - 1 : undefined;
        const { messageId, answer } = await openPrompt(voter.handle, parts[i]!, {
          timeoutMs: timeoutMs + 5_000,
          accept: (a) => optionFor(voter, a, cardIndex) !== undefined,
        });
        ids.push(messageId);
        if (closed) cancel(messageId);
        // Each part is a shared "original" with one copy per voter, so threaded replies and
        // tapbacks that aren't votes land on the same card in everyone else's thread.
        // (Copies only: there is no sender's original, so nothing is ever mirrored back to "Bridge".)
        map.recordRelay(`${id}-part-${i}`, voter.handle, messageId);
        void answer.then((a) => {
          if (!a) return; // withdrawn or timed out
          const option = optionFor(voter, a, cardIndex);
          if (option === undefined) return;
          const kind: VoteHow =
            a.via === "text" ? "letter" : cardIndex === option && CLEAR_ON_CARD.has(a.tapback) ? "card" : "tapback";
          record(voter, option, kind);
        });
      }
    };

    for (const voter of voters) {
      sendCards(voter).catch((err) => console.error("[vote] couldn't send the cards to", voter.id, err));
    }
  });
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

/** Most votes; ties go to the earliest option; no votes → null. */
function tally(votes: Map<string, number>, n: number): number | null {
  const counts = countVotes(votes, n);
  let best = -1;
  counts.forEach((c, i) => {
    if (c > 0 && (best < 0 || c > counts[best]!)) best = i;
  });
  return best < 0 ? null : best;
}
