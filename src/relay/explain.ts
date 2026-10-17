// Reply "?" to any relayed message to see the original text and cultural context.
// Owned by User 1.

import type { FamilyMember } from "../types.js";
import { getFamilyByHandle, getMember } from "../db/store.js";
import { sendText } from "../photon/client.js";
import * as map from "./messageMap.js";

export async function explain(asker: FamilyMember, replyToId?: string): Promise<void> {
  const originalId = (replyToId && map.findOriginal(replyToId)) || map.lastOriginalIn(asker.handle);
  const original = originalId && map.getOriginal(originalId);
  if (!originalId || !original) {
    await sendText(asker.handle, "Reply ? to a message and I'll show you the original.");
    return;
  }
  const family = getFamilyByHandle(asker.handle)!;
  const from = getMember(family, original.fromHandle);
  const copy = map.getCopies(originalId).get(asker.handle);
  const lines = [`${from?.name ?? "They"} wrote: “${original.text ?? "(attachment)"}”`];
  if (copy?.translation?.notes) lines.push(`💡 ${copy.translation.notes}`);
  // TODO [U1] write this reply in the asker's language (ask translate() for it)
  await sendText(asker.handle, lines.join("\n"), { replyToId: copy?.messageId });
}
