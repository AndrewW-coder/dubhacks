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

import type { Family, FamilyMember, IncomingMessage, TapbackKind, Translation } from "../types.js";
import { getFamilyByHandle, getMember } from "../db/store.js";
import { editMessage, downloadAttachment, sendFile, sendTapback, sendText, unsendMessage } from "../photon/client.js";
import * as map from "./messageMap.js";
import { explain } from "./explain.js";
import { say } from "./say.js";
import { translate } from "../translate/translator.js";
import { isEmergency, needsReview } from "../translate/confidence.js";
import { requestReview } from "../review/bridgeReview.js";
import { transcribe } from "../media/voice.js";
import { explainImage } from "../media/image.js";
import { tryHandlePayment } from "../payments/flow.js";

// iMessage's limits, minus a margin. Overridable so the simulator can test the fallbacks.
const EDIT_WINDOW_MS = Number(process.env.EDIT_WINDOW_MS ?? 14.5 * 60_000);
const UNSEND_WINDOW_MS = Number(process.env.UNSEND_WINDOW_MS ?? 110_000);

const TAPBACK_ICON: Record<TapbackKind, string> = { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" };
const TAPBACK_VERB: Record<TapbackKind, string> = {
  love: "loved",
  like: "liked",
  dislike: "disliked",
  laugh: "laughed at",
  emphasize: "emphasized",
  question: "questioned",
};

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
      // transcribe() never throws: on failure it returns a "(voice note — …)" placeholder (see
      // media/voice.ts). Never translate that: forward the recording itself instead.
      if (/^\(voice note — /.test(transcript)) return relayRecording(family, sender, msg, path);
      // A spoken need or request ("我的血压计坏了…") goes through the same money/shopping check as typed text.
      if (await tryHandlePayment(family, sender, { ...msg, kind: "text", text: transcript })) return; // [U2]
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

function format(sender: FamilyMember, t: Translation, prefix = "", urgent = false, label = ""): string {
  const flag = urgent ? "🚨 " : "";
  const unsure = t.uncertain ? "  (translation unsure — reply ? for the original)" : "";
  return `${flag}${label}${sender.name}: ${prefix}${t.text}${unsure}`;
}

/** Which message in `recipient`'s thread does this reply point at? */
function replyTargetFor(replyToId: string | undefined, recipient: FamilyMember): string | undefined {
  if (!replyToId) return undefined;
  const original = map.findOriginal(replyToId);
  return original ? map.getCopies(original).get(recipient.handle)?.messageId : undefined;
}

// Each sender's messages get a sequence number, so a message held for review can be
// labeled "(earlier)" if newer messages from the same sender reached a thread first.
const nextSeq = new Map<string, number>(); // sender handle → next sequence number
const lastShown = new Map<string, number>(); // sender|recipient → highest sequence shown there

async function relayText(family: Family, sender: FamilyMember, msg: IncomingMessage, text: string, prefix = "") {
  map.recordOriginal(msg.id, { fromHandle: sender.handle, text, sentAt: msg.receivedAt });
  const urgent = isEmergency(text);
  // TODO [U1] if urgent, also alert everyone with a separate flagged message / effect
  const seq = nextSeq.get(sender.handle) ?? 0;
  nextSeq.set(sender.handle, seq + 1);

  const deliver = async (recipient: FamilyMember, t: Translation) => {
    const key = `${sender.handle}|${recipient.handle}`;
    const late = (lastShown.get(key) ?? -1) > seq;
    lastShown.set(key, Math.max(lastShown.get(key) ?? -1, seq));
    const label = late ? `(${await say(family, recipient, "earlier")}) ` : "";
    const id = await sendText(recipient.handle, format(sender, t, prefix, urgent, label), {
      replyToId: replyTargetFor(msg.replyToId, recipient),
    });
    map.recordRelay(msg.id, recipient.handle, id, t);
  };

  await Promise.all(
    others(family, sender).map(async (recipient) => {
      const t = await translate(text, sender, recipient, family); // [U2]
      if (!urgent && needsReview(text, t)) {
        // Don't hold the sender's later messages while a reviewer thinks: this one is
        // delivered when the answer comes, labeled "(earlier)" if others went first.
        void requestReview(family, sender, recipient, text, t) // [U1]
          .then((reviewed) => deliver(recipient, reviewed))
          .catch((err) => console.error("[relay] reviewed message failed", msg.id, err));
        return;
      }
      await deliver(recipient, t);
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

/** A voice note that couldn't be turned into text: send the recording, with a line explaining why. */
async function relayRecording(family: Family, sender: FamilyMember, msg: IncomingMessage, path: string) {
  map.recordOriginal(msg.id, { fromHandle: sender.handle, sentAt: msg.receivedAt });
  await Promise.all(
    others(family, sender).map(async (recipient) => {
      const id = await sendFile(recipient.handle, path, {
        replyToId: replyTargetFor(msg.replyToId, recipient),
        asVoiceNote: true,
      });
      map.recordRelay(msg.id, recipient.handle, id);
      const note = await say(family, recipient, `${sender.name} sent a voice note. I couldn't turn it into text, so here's the recording.`);
      await sendText(recipient.handle, `🎤 ${note}`, { replyToId: id });
    }),
  );
}

async function relayTapback(family: Family, sender: FamilyMember, msg: IncomingMessage) {
  const original = map.findOriginal(msg.id);
  if (!original) return; // tapback on something Bridge didn't relay (e.g. a review question)
  const author = map.getOriginal(original)?.fromHandle;
  for (const [handle, copy] of map.getCopies(original)) {
    if (handle === sender.handle) continue;
    await sendTapback(handle, copy.messageId, msg.tapback!, msg.tapbackRemoved);
    // iMessage shows the tapback as coming from "Bridge", which is easy to miss.
    // Authors who opted in also get a line saying who reacted.
    const member = getMember(family, handle);
    if (member?.tapbackNotes && handle === author && !msg.tapbackRemoved) {
      const note = await say(family, member, `${sender.name} ${TAPBACK_VERB[msg.tapback!]} your message`);
      await sendText(handle, `${TAPBACK_ICON[msg.tapback!]} ${note}`, { replyToId: copy.messageId });
    }
  }
}

async function relayEdit(family: Family, sender: FamilyMember, msg: IncomingMessage) {
  // iMessage also sends text-less "edits" (e.g. when a voice note is kept): never blank a copy.
  if (!msg.text?.trim()) return;
  const original = map.findOriginal(msg.id);
  if (!original) return;
  map.updateOriginalText(original, msg.text ?? "");
  for (const [handle, copy] of map.getCopies(original)) {
    if (handle === sender.handle) continue;
    const recipient = getMember(family, handle)!;
    const t = await translate(msg.text ?? "", sender, recipient, family); // edits skip review (keeps it fast)
    const text = format(sender, t);
    const edited =
      age(copy) < EDIT_WINDOW_MS &&
      (await editMessage(handle, copy.messageId, text).then(
        () => true,
        (err) => (console.error("[relay] edit failed, sending a correction instead", err), false),
      ));
    if (!edited) {
      // Past iMessage's edit window: post the new version as a reply to the old one.
      await sendText(handle, `✏️ ${await say(family, recipient, "Correction")}: ${text}`, { replyToId: copy.messageId });
    }
    map.recordRelay(original, handle, copy.messageId, t);
  }
}

async function relayUnsend(family: Family, sender: FamilyMember, msg: IncomingMessage) {
  const original = map.findOriginal(msg.id);
  if (!original) return;
  for (const [handle, copy] of map.getCopies(original)) {
    if (handle === sender.handle) continue;
    const recipient = getMember(family, handle)!;
    // Unsend if iMessage still allows it, else blank the copy with an edit, else say so in a reply.
    const attempt = (ok: boolean, run: () => Promise<void>) =>
      ok ? run().then(() => true, (err) => (console.error("[relay] unsend step failed", err), false)) : Promise.resolve(false);
    if (await attempt(age(copy) < UNSEND_WINDOW_MS, () => unsendMessage(handle, copy.messageId))) continue;
    const removed = await say(family, recipient, `${sender.name} removed this message`);
    if (await attempt(age(copy) < EDIT_WINDOW_MS, () => editMessage(handle, copy.messageId, `🗑 (${removed})`))) continue;
    await sendText(handle, `🗑 ${removed}`, { replyToId: copy.messageId });
  }
}

function age(copy: map.Copy): number {
  return Date.now() - copy.sentAt.getTime();
}
