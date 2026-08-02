/**
 * Customer-match identifier hashing — the one module in the codebase that ever
 * touches a plaintext email or phone number. `ads.sh audiences
 * upload-customer-match` (bin/audiences.ts) calls `hashEmail`/`hashPhone`
 * immediately upon reading each CSV row and discards the raw value in the same
 * expression (destructure-and-hash, not store-then-hash) — no other module
 * ever receives the plaintext string.
 *
 * Normalization follows Google's documented Customer Match requirements:
 * emails are lowercased and trimmed before hashing; phone numbers are
 * normalized to E.164 (a leading "+", digits only) before hashing. Hashing is
 * plain SHA-256 (Node's built-in `crypto`, no new dependency) — Google's API
 * expects the hex-digest string on `UserIdentifier.hashed_email` /
 * `.hashed_phone_number`; there is no SDK-side hashing helper (confirmed
 * against the `google-ads-api` proto types — see plan.md Phase 0).
 */

import { createHash } from "node:crypto";

/** SHA-256 hex digest of `value`. Pure. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Normalize an email per Google's Customer Match rules (trim, lowercase) and
 * return its SHA-256 hex digest. Never returns or logs the plaintext value.
 */
export function hashEmail(rawEmail: string): string {
  return sha256Hex(rawEmail.trim().toLowerCase());
}

/**
 * Normalize a phone number to E.164 (leading "+", digits only — strips
 * spaces, dashes, parens; a bare 10-digit US number gets a "+1" prefix, since
 * that's the overwhelmingly common unqualified case for this tool's US/Canada
 * audience — see entities.ts's GEO_TARGETS) and return its SHA-256 hex digest.
 * Never returns or logs the plaintext value.
 */
export function hashPhone(rawPhone: string): string {
  const digits = rawPhone.replace(/[^0-9+]/g, "");
  const e164 = digits.startsWith("+")
    ? digits
    : digits.length === 10
      ? `+1${digits}`
      : `+${digits}`;
  return sha256Hex(e164);
}
