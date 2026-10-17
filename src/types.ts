// Shared types used across the app.

export type LanguageCode = string; // e.g. "en", "zh", "ko", "vi"

export interface FamilyMember {
  id: string;
  name: string;
  handle: string; // phone number or Apple ID used in iMessage
  language: LanguageCode;
  relationship: string; // e.g. "grandmother", "grandson" (used for tone and honorifics)
  isBilingualReviewer: boolean; // can confirm hard translations
  currency?: string; // e.g. "USD", "TWD" (used for Visa gifts)
}

export interface Family {
  id: string;
  members: FamilyMember[];
}

export type MessageKind = "text" | "voice" | "image" | "tapback" | "edit" | "unsend";

export interface IncomingMessage {
  id: string;
  fromHandle: string;
  kind: MessageKind;
  text?: string;
  attachmentPath?: string;
  replyToId?: string; // message being replied to or reacted to
  tapback?: string; // e.g. "love", "like", "laugh"
  receivedAt: Date;
}

export interface Translation {
  text: string;
  confidence: number; // 0-1
  notes?: string; // cultural context shown when someone replies "?"
  alternatives?: string[]; // offered to the bilingual reviewer when confidence is low
}
