// Money conversations: "Send Grandma $50 for New Year", "Grandpa needs medicine".
// Owned by User 2. Called by relay/router.ts for every text message BEFORE it is relayed.
//
// FROZEN SIGNATURE: tryHandlePayment(family, sender, msg) → true if this message was a
// money command and has been fully handled (so it is NOT relayed), false otherwise.
//
// Tools you can use without touching User 1's files:
//   sendText(handle, text)              from ../photon/client.js
//   ask(handle, question, timeoutMs)    from ../relay/prompts.js  → waits for a tapback/reply
//   translate(text, from, to, family)   from ../translate/translator.js

import type { Family, FamilyMember, IncomingMessage } from "../types.js";

export async function tryHandlePayment(family: Family, sender: FamilyMember, msg: IncomingMessage): Promise<boolean> {
  // TODO [U2]
  // 1. Cheap check first (regex for $, ¥, "send", "gift", 钱 …) so normal chat isn't slowed down.
  // 2. Parse the intent with Claude: { recipientId, amount, currency, note }.
  // 3. If requiresConfirmation(sender, amount) (scamCheck.ts): ask() a trusted member first.
  // 4. ask() the sender to confirm: "Send Nai Nai $50 (≈ NT$1,600)? ❤️ to confirm".
  // 5. sendGift() (visa.ts), then tell both sides in their own language.
  return false;
}
