// Core of Bridge: takes a message from one family member and relays it,
// translated, into every other member's 1:1 thread. Owned by User 1.
//
// User 2 never needs to edit this file: every User 2 feature is already called
// from here through a frozen function signature:
//   translate()          src/translate/translator.ts
//   needsReview()        src/translate/confidence.ts
//   isEmergency()        src/translate/confidence.ts
//   tryHandlePayment()   src/payments/flow.ts
//   transcribe()         src/media/voice.ts
//   explainImage()       src/media/image.ts

import type { Family, FamilyMember, IncomingMessage, Translation } from "../types.js";
import { getFamilyByHandle, getMember } from "../db/store.js";
import { editMessage, downloadAttachment, sendFile, sendTapback, sendText, unsendMessage } from "../photon/client.js";
import * as map from "./messageMap.js";
import { explain } from "./explain.js";
import { translate } from "../translate/translator.js";
import { isEmergency, needsReview } from "../translate/confidence.js";
import { requestReview } from "../review/bridgeReview.js";
import { transcribe } from "../media/voice.js";
import { explainImage } from "../media/image.js";
import { tryHandlePayment } from "../payments/flow.js";

export async function handleIncoming(msg: IncomingMessage): Promise<void> {
  const family = getFamilyByHandle(msg.fromHandle);
  if (!family) {
    // TODO [U1] onboarding for unknown senders (or ignore silently during the demo)
    await sendText(msg.fromHandle, "Hi! I'm Bridge. Ask a family member to add you to your family's Bridge.");
    return;
  }
  const sender = getMember(family, msg.fromHandle)!;

  switch (msg.kind) {
    case "text": {
      const text = msg.text ?? "";
      if (text.trim() === "?") return explain(sender, msg.replyToId);
      if (await tryHandlePayment(family, sender, msg)) return; // [U2] money commands
      return relayText(family, sender, msg, text);
    }
    case "voice": {
      const path = await downloadAttachment(msg.attachment!.id, msg.attachment!.fileName);
      const transcript = await transcribe(path, sender.language); // [U2]
      return relayText(family, sender, msg, transcript, "🎤 ");
      // TODO [U1] optionally also forward the original audio, or send synthesize() output (U2) back
    }
    case "image":
    case "file":
      return relayAttachment(family, sender, msg);
    case "tapback":
      return relayTapback(family, sender, msg);
    case "edit":
      return relayEdit(family, sender, msg);
    case "unsend":
      return relayUnsend(family, sender, msg);
  }
}

function others(family: Family, sender: FamilyMember) {
  return family.members.filter((m) => m.id !== sender.id);
}

function format(sender: FamilyMember, t: Translation, prefix = "", urgent = false): string {
  const flag = urgent ? "🚨 " : "";
  const unsure = t.uncertain ? "  (translation unsure — reply ? for the original)" : "";
  return `${flag}${sender.name}: ${prefix}${t.text}${unsure}`;
}

/** Which message in `recipient`'s thread does this reply point at? */
function replyTargetFor(replyToId: string | undefined, recipient: FamilyMember): string | undefined {
  if (!replyToId) return undefined;
  const original = map.findOriginal(replyToId);
  return original ? map.getCopies(original).get(recipient.handle)?.messageId : undefined;
}

async function relayText(family: Family, sender: FamilyMember, msg: IncomingMessage, text: string, prefix = "") {
  map.recordOriginal(msg.id, { fromHandle: sender.handle, text, sentAt: msg.receivedAt });
  const urgent = isEmergency(text);
  // TODO [U1] if urgent, also alert everyone with a separate flagged message / effect

  await Promise.all(
    others(family, sender).map(async (recipient) => {
      let t = await translate(text, sender, recipient, family); // [U2]
      if (!urgent && needsReview(text, t)) {
        t = await requestReview(family, sender, recipient, text, t); // [U1]
      }
      const id = await sendText(recipient.handle, format(sender, t, prefix, urgent), {
        replyToId: replyTargetFor(msg.replyToId, recipient),
      });
      map.recordRelay(msg.id, recipient.handle, id, t);
    }),
  );
}

async function relayAttachment(family: Family, sender: FamilyMember, msg: IncomingMessage) {
  map.recordOriginal(msg.id, { fromHandle: sender.handle, sentAt: msg.receivedAt });
  const path = await downloadAttachment(msg.attachment!.id, msg.attachment!.fileName);
  await Promise.all(
    others(family, sender).map(async (recipient) => {
      const id = await sendFile(recipient.handle, path, { replyToId: replyTargetFor(msg.replyToId, recipient) });
      map.recordRelay(msg.id, recipient.handle, id);
      if (msg.kind === "image") {
        const explanation = await explainImage(path, recipient.language); // [U2]
        if (explanation) await sendText(recipient.handle, `📷 ${sender.name}'s photo: ${explanation}`, { replyToId: id });
      }
    }),
  );
}

async function relayTapback(family: Family, sender: FamilyMember, msg: IncomingMessage) {
  const original = map.findOriginal(msg.id);
  if (!original) return; // tapback on something Bridge didn't relay (e.g. a review question)
  for (const [handle, copy] of map.getCopies(original)) {
    if (handle === sender.handle) continue;
    await sendTapback(handle, copy.messageId, msg.tapback!, msg.tapbackRemoved);
  }
  // TODO [U1] iMessage shows tapbacks from "Bridge", not from the person — consider also
  // a short text like "Kevin ❤️'d your message" for elders who won't notice
}

async function relayEdit(family: Family, sender: FamilyMember, msg: IncomingMessage) {
  const original = map.findOriginal(msg.id);
  if (!original) return;
  map.updateOriginalText(original, msg.text ?? "");
  for (const [handle, copy] of map.getCopies(original)) {
    if (handle === sender.handle) continue;
    const recipient = getMember(family, handle)!;
    const t = await translate(msg.text ?? "", sender, recipient, family); // edits skip review (keeps it fast)
    await editMessage(handle, copy.messageId, format(sender, t)).catch((err) =>
      // TODO [U1] past iMessage's 15-minute edit window: send "✏️ correction: …" as a reply instead
      console.error("[relay] edit failed", err),
    );
    map.recordRelay(original, handle, copy.messageId, t);
  }
}

async function relayUnsend(family: Family, sender: FamilyMember, msg: IncomingMessage) {
  const original = map.findOriginal(msg.id);
  if (!original) return;
  for (const [handle, copy] of map.getCopies(original)) {
    if (handle === sender.handle) continue;
    await unsendMessage(handle, copy.messageId).catch((err) =>
      // TODO [U1] past the 2-minute unsend window: edit the copy to "(message removed)" instead
      console.error("[relay] unsend failed", err),
    );
  }
}
