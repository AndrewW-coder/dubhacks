// Shared types used across the app.
// SHARED FILE — frozen after Phase 0. Changes must be ADDITIVE ONLY (new optional
// fields or new types), made in a tiny commit of their own, pushed right away,
// and announced to the other person. Types used by only one module belong in
// that module's own file, not here.

export type LanguageCode = string; // e.g. "en", "zh", "ko", "vi"

export interface FamilyMember {
  id: string; // short alias, e.g. "nainai" (used by the simulator: "nainai: hello")
  name: string; // display name shown to other members, e.g. "Nai Nai"
  handle: string; // E.164 phone number or Apple ID email used in iMessage
  language: LanguageCode;
  relationship: string; // e.g. "grandmother", "grandson" (used for tone and honorifics)
  isBilingualReviewer: boolean; // can confirm hard translations
  reviewLanguages?: LanguageCode[]; // languages this reviewer reads, e.g. ["en", "zh"]
  currency?: string; // e.g. "USD", "TWD" (used for Visa gifts)
  isTrustedForMoney?: boolean; // confirms money requests coming from elders
}

export interface Family {
  id: string;
  name: string;
  members: FamilyMember[];
}

export type MessageKind = "text" | "voice" | "image" | "file" | "tapback" | "edit" | "unsend";

export type TapbackKind = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

export interface AttachmentRef {
  id: string; // Photon attachment GUID (mock: a local file path)
  fileName: string;
  mimeType: string;
}

/** Everything that arrives from iMessage, normalized by src/photon. Nothing else sees Photon's types. */
export interface IncomingMessage {
  id: string; // message GUID of THIS message (for edit/unsend/tapback: the TARGET message GUID)
  fromHandle: string;
  kind: MessageKind;
  text?: string; // text, or the new text for an edit
  attachment?: AttachmentRef; // for voice / image / file
  replyToId?: string; // the message this one replies to (threaded reply), if any
  tapback?: TapbackKind; // for kind === "tapback"
  tapbackRemoved?: boolean; // true when a tapback was taken away
  receivedAt: Date;
}

export interface Translation {
  text: string;
  confidence: number; // 0-1
  notes?: string; // cultural context shown when someone replies "?"
  alternatives?: string[]; // offered to the bilingual reviewer when confidence is low
  uncertain?: boolean; // set when sent without a reviewer's answer
}
