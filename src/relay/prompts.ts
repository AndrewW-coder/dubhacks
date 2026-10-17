// "Ask a member a question and wait for their answer." SHARED PRIMITIVE.
// Owned by User 1, used by both:
//   - review/bridgeReview.ts (User 1): "Did Grandpa mean A or B?"
//   - payments/flow.ts      (User 2): "Kevin wants to send you $50. ❤️ to confirm"
//
// The router checks every incoming message against open prompts BEFORE
// relaying it, so an answer is never relayed to the family by mistake.

import { sendText } from "../photon/client.js";
import type { IncomingMessage, TapbackKind } from "../types.js";

export type Answer = { via: "tapback"; tapback: TapbackKind } | { via: "text"; text: string };

interface Pending {
  handle: string;
  messageId: string;
  resolve: (a: Answer) => void;
}

const pending = new Map<string, Pending>(); // prompt message ID → pending prompt

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
      pending.set(messageId, { handle, messageId, resolve: (answer) => done({ handle, answer }) });
    });
  });
}

/** Called by the router for every incoming message. Returns true if it answered a prompt. */
export function tryResolvePrompt(msg: IncomingMessage): boolean {
  let target: Pending | undefined;
  if ((msg.kind === "tapback" && !msg.tapbackRemoved) || msg.replyToId) {
    const p = pending.get(msg.kind === "tapback" ? msg.id : msg.replyToId!);
    if (p && p.handle === msg.fromHandle) target = p;
  }
  if (!target && msg.kind === "text" && msg.text && SHORT_ANSWER.test(msg.text)) {
    // Bare "A": answers this member's most recent open prompt.
    target = [...pending.values()].reverse().find((p) => p.handle === msg.fromHandle);
  }
  if (!target) return false;

  pending.delete(target.messageId);
  target.resolve(
    msg.kind === "tapback" ? { via: "tapback", tapback: msg.tapback! } : { via: "text", text: msg.text?.trim() ?? "" },
  );
  return true;
}
