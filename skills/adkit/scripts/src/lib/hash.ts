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

/**
 * A SHA-256 hex digest, branded so it can never be confused with (or
 * accidentally assigned from) a plaintext string at the type level — only
 * `hashEmail`/`hashPhone` below ever produce one. TypeScript's structural
 * typing would otherwise let any `string` (including an unhashed CSV cell)
 * flow into a `HashedIdentifier` field undetected; the non-exported brand
 * symbol closes that gap without a runtime cost (it's erased at compile
 * time — `sha256Hex`'s return is cast to this type in exactly one place).
 */
export type Sha256Hex = string & { readonly __brand: "Sha256Hex" };

/** SHA-256 hex digest of `value`. Pure. The sole place the `Sha256Hex` brand is cast into existence. */
function sha256Hex(value: string): Sha256Hex {
  return createHash("sha256").update(value, "utf8").digest("hex") as Sha256Hex;
}

/**
 * Normalize an email per Google's Customer Match rules (trim, lowercase) and
 * return its SHA-256 hex digest. Never returns or logs the plaintext value.
 */
export function hashEmail(rawEmail: string): Sha256Hex {
  return sha256Hex(rawEmail.trim().toLowerCase());
}

/**
 * Normalize a phone number to E.164 (leading "+", digits only — strips
 * spaces, dashes, parens; a bare 10-digit US number gets a "+1" prefix, since
 * that's the overwhelmingly common unqualified case for this tool's US/Canada
 * audience — see entities.ts's GEO_TARGETS) and return its SHA-256 hex digest.
 * Never returns or logs the plaintext value.
 */
export function hashPhone(rawPhone: string): Sha256Hex {
  const digits = rawPhone.replace(/[^0-9+]/g, "");
  const e164 = digits.startsWith("+")
    ? digits
    : digits.length === 10
      ? `+1${digits}`
      : `+${digits}`;
  return sha256Hex(e164);
}
