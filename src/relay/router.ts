// Core of Bridge: takes a message from one family member and relays it,
// translated, into every other member's 1:1 thread.

import type { IncomingMessage } from "../types.js";
import { getFamilyByHandle } from "../db/store.js";

export async function handleIncoming(message: IncomingMessage): Promise<void> {
  const family = getFamilyByHandle(message.fromHandle);
  if (!family) return; // TODO: onboarding flow for unknown senders

  switch (message.kind) {
    case "text":
      // TODO: for each other member:
      //   translate (translate/translator.ts)
      //   if confidence is low → review/bridgeReview.ts, else send
      //   record relayed IDs in relay/messageMap.ts
      break;
    case "voice":
    case "image":
      // TODO: media/voice.ts or media/image.ts → then same path as text
      break;
    case "tapback":
    case "edit":
    case "unsend":
      // TODO: look up relayed copies in messageMap and apply to each
      break;
  }
}
