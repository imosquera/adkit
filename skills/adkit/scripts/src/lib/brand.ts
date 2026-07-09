/**
 * Single source of truth for the differentiation reference (me-too copy signal).
 *
 * These are immutable, declarative values (`as const` readonly tuples / objects) —
 * never computed via side effects (constitution Principle III/VI; FP-003). They are
 * imported by audit/scoring.ts (me-too copy detection), so the "who we differentiate
 * from" knowledge has ONE authoritative home (constitution Principle X — DRY; FR-016).
 */

/**
 * One axis a competitor like ChatGPT cannot easily replicate. `triggers` are the
 * lowercase lexemes whose presence in an ad's copy counts the axis as covered.
 *
 * Naming note: the Python `NamedTuple` `DifferentiationAxis` (fields `name`,
 * `triggers`) is modeled here as a readonly object type.
 */
export type DifferentiationAxis = {
  readonly name: string;
  readonly triggers: readonly string[];
};

/**
 * The three axes from FR-015. Copy that leads with these reads as a vertical product,
 * not a general-purpose AI chat tool.
 */
export const DIFFERENTIATION_AXES = [
  {
    name: "integration",
    triggers: [
      "crm",
      "integrat",
      "stack",
      "workflow",
      "connect",
      "sync",
      "plug",
      "api",
      "hubspot",
      "salesforce",
      "zendesk",
      "marketing stack",
    ],
  },
  {
    name: "consistency",
    triggers: [
      "brand voice",
      "brand-voice",
      "voice-matched",
      "voice matched",
      "on-brand",
      "on brand",
      "consistent",
      "consistency",
      "tone",
      "every channel",
      "across channels",
    ],
  },
  {
    name: "outcome",
    triggers: [
      "sign-up",
      "sign up",
      "signup",
      "conversion",
      "convert",
      "reply rate",
      "response rate",
      "revenue",
      "roi",
      "pipeline",
      "leads",
      "book",
      "close",
    ],
  },
] as const satisfies readonly DifferentiationAxis[];

/** Phrases that mark copy as an undifferentiated, general-AI-tool promise (FR-014). */
export const GENERIC_AI_PHRASES = [
  "ai writer",
  "ai writing",
  "ai chatbot",
  "ai chat",
  "ai assistant",
  "ai bot",
  "chatbot",
  "ai-powered writing",
  "ai content",
  "ask ai",
  "powered by ai",
  "generative ai",
  "smart assistant",
] as const;

/** The competitor set the differentiation judgement is made relative to (FR-014/FR-016). */
export const DIFFERENTIATION_COMPETITORS = ["ChatGPT", "Claude", "Gemini", "Copilot"] as const;
