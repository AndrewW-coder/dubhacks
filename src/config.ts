// Loads environment variables. See .env.example.
// SHARED FILE — frozen after Phase 0. All variables already exist; read new ones here only if you must.

import "dotenv/config";

const env = (key: string, fallback = "") => process.env[key]?.trim() || fallback;

export const config = {
  // Shared
  photonMode: env("PHOTON_MODE", "mock") as "mock" | "live",
  familyFile: env("FAMILY_FILE"),

  // User 1: Photon / relay / review
  imessageAddress: env("IMESSAGE_ADDRESS"),
  imessageToken: env("IMESSAGE_TOKEN"),
  imessageTls: env("IMESSAGE_TLS", "true") !== "false",
  spectrumProjectId: env("SPECTRUM_PROJECT_ID"),
  spectrumProjectSecret: env("SPECTRUM_PROJECT_SECRET"),
  reviewTimeoutMs: Number(env("REVIEW_TIMEOUT_MS", "120000")),

  // User 2: translation / media / payments
  speechProvider: env("SPEECH_PROVIDER"),
  speechApiKey: env("SPEECH_API_KEY"),
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
  reviewConfidenceThreshold: Number(env("REVIEW_CONFIDENCE_THRESHOLD", "0.75")),
  visaMode: env("VISA_MODE", "mock") as "mock" | "sandbox",
  visaUserId: env("VISA_USER_ID"),
  visaPassword: env("VISA_PASSWORD"),
  visaCertPath: env("VISA_CERT_PATH"),
  visaKeyPath: env("VISA_KEY_PATH"),
  visaCaPath: env("VISA_CA_PATH"),
};
