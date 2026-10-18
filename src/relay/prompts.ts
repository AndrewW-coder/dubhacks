// "Ask a member a question and wait for their answer." SHARED PRIMITIVE.
// Owned by User 1, used by both:
//   - review/bridgeReview.ts (User 1): "Did Grandpa mean A or B?"
//   - relay/vote.ts          (User 1): shopping cards "A / B / C"
//   - payments/flow.ts       (User 2): "Kevin wants to send you $50. ❤️ to confirm"
//
// The router checks every incoming message against open prompts BEFORE
// relaying it, so an answer is never relayed to the family by mistake. A prompt
// with an `accept` filter only takes the answers it wants; anything else (e.g. a
// threaded "is B too heavy?" on a vote card) is relayed as normal chat.

import { sendFile, sendText } from "../photon/client.js";
import type { IncomingMessage, TapbackKind } from "../types.js";

export type Answer =
  | { via: "tapback"; tapback: TapbackKind }
  | { via: "text"; text: string; threaded?: boolean }; // threaded = a reply to the question itself, not a bare message

interface Pending {
  handle: string;
  messageId: string;
  accept?: (a: Answer) => boolean;
  resolve: (a: Answer | null) => void; // null = withdrawn (cancel)
}

const pending = new Map<string, Pending>(); // prompt message ID → pending prompt (in the order they were opened)

// Short answers that count even without using iMessage's reply feature.
const SHORT_ANSWER = /^\s*(a|b|c|d|1|2|3|4|y|n|yes|no|ok|confirm|cancel|是|不|好)\s*[.!]?\s*$/i;

/**
 * Sends `text` to `handle` and resolves with their answer: a tapback on the
 * question, a threaded reply to it, or a short bare answer like "A" / "yes".
 * Resolves null after `timeoutMs` with no answer.
 */
export async function ask(handle: string, text: string, timeoutMs: number): Promise<Answer | null> {
  return (await askFirst([{ handle, text }], timeoutMs))?.answer ?? null;
}

/**
 * Sends each member their own question at once and resolves with the first
 * answer and who gave it. The other questions are withdrawn, so a late answer
 * from someone else is relayed as normal chat. Resolves null after `timeoutMs`.
 */
export async function askFirst(
  questions: { handle: string; text: string }[],
  timeoutMs: number,
): Promise<{ handle: string; answer: Answer } | null> {
  const ids = await Promise.all(questions.map((q) => sendText(q.handle, q.text)));
  return new Promise((resolve) => {
    const done = (result: { handle: string; answer: Answer } | null) => {
      clearTimeout(timer);
      for (const id of ids) pending.delete(id);
      resolve(result);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    ids.forEach((messageId, i) => {
      const handle = questions[i]!.handle;
      pending.set(messageId, { handle, messageId, resolve: (answer) => answer && done({ handle, answer }) });
    });
  });
}

/**
 * Lower-level: sends one question and returns its message ID right away, plus
 * the answer (null on timeout or `cancel`). `accept` decides which answers this
 * prompt takes; rejected ones go to the person's next open prompt or are relayed.
 */
export async function openPrompt(
  handle: string,
  text: string,
  opts: { timeoutMs: number; accept?: (a: Answer) => boolean; replyToId?: string; filePath?: string },
): Promise<{ messageId: string; answer: Promise<Answer | null> }> {
  // With `filePath`, the question is that image/file (text is ignored), e.g. a shopping card.
  const reply = opts.replyToId ? { replyToId: opts.replyToId } : undefined;
  const messageId = opts.filePath ? await sendFile(handle, opts.filePath, reply) : await sendText(handle, text, reply);
  const answer = new Promise<Answer | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(messageId);
      resolve(null);
    }, opts.timeoutMs);
    pending.set(messageId, {
      handle,
      messageId,
      accept: opts.accept,
      resolve: (a) => {
        clearTimeout(timer);
        resolve(a);
      },
    });
  });
  return { messageId, answer };
}

/** Withdraws an open prompt (its answer resolves null). Returns false if it wasn't open. */
export function cancel(messageId: string): boolean {
  const p = pending.get(messageId);
  if (!p) return false;
  pending.delete(messageId);
  p.resolve(null);
  return true;
}

/** Message IDs of this member's open prompts, oldest first. */
function openPromptsFor(handle: string): string[] {
  return [...pending.values()].filter((p) => sameHandle(p.handle, handle)).map((p) => p.messageId);
}

/** Does this member have an open prompt other than `exceptIds` (e.g. the caller's own)? */
export function hasOtherOpenPrompt(handle: string, exceptIds: string[] = []): boolean {
  return openPromptsFor(handle).some((id) => !exceptIds.includes(id));
}

/** Called by the router for every incoming message. Returns true if it answered a prompt. */
export function tryResolvePrompt(msg: IncomingMessage): boolean {
  let answer: Answer | undefined;
  let target: Pending | undefined;
  if ((msg.kind === "tapback" && !msg.tapbackRemoved) || (msg.kind === "text" && msg.replyToId)) {
    // A tapback on, or threaded reply to, a specific question.
    const p = pending.get(msg.kind === "tapback" ? msg.id : msg.replyToId!);
    if (p && sameHandle(p.handle, msg.fromHandle)) {
      answer = msg.kind === "tapback" ? { via: "tapback", tapback: msg.tapback! } : { via: "text", text: msg.text?.trim() ?? "", threaded: true };
      if (!p.accept || p.accept(answer)) target = p;
      else return false; // not an answer to that question: relay it, threaded where it was posted
    }
  }
  if (!target && msg.kind === "text" && msg.text && SHORT_ANSWER.test(msg.text)) {
    // Bare "A": answers this member's newest open prompt that accepts it.
    answer = { via: "text", text: msg.text.trim() };
    const a = answer;
    target = [...pending.values()].reverse().find((p) => sameHandle(p.handle, msg.fromHandle) && (!p.accept || p.accept(a)));
  }
  if (!target || !answer) return false;

  pending.delete(target.messageId);
  target.resolve(answer);
  return true;
}

/** Phone numbers can arrive as "+1 (555) 000-0001" or "+15550000001"; emails differ only in case. */
function sameHandle(a: string, b: string): boolean {
  const norm = (h: string) => (h.includes("@") ? h.toLowerCase() : h.replace(/[^\d+]/g, ""));
  return norm(a) === norm(b);
}
