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
  resolve: (a: Answer | null) => void;
  timer: NodeJS.Timeout;
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
  const messageId = await sendText(handle, text);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(messageId);
      resolve(null);
    }, timeoutMs);
    pending.set(messageId, { handle, messageId, resolve, timer });
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

  clearTimeout(target.timer);
  pending.delete(target.messageId);
  target.resolve(
    msg.kind === "tapback" ? { via: "tapback", tapback: msg.tapback! } : { via: "text", text: msg.text?.trim() ?? "" },
  );
  return true;
}
