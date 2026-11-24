import { createHmac, timingSafeEqual } from "crypto";

/**
 * Rasket signs every webhook delivery the way Svix does (06 §6 in the Rasket repository; the
 * published `@rasket/webhook-verify` is the reference). Written out here rather than imported:
 * a verified n8n node may have no runtime dependency, and these are the five steps:
 *
 * 1. require `svix-id`, `svix-timestamp`, `svix-signature`
 * 2. reject when |now − timestamp| > 300 s
 * 3. expected = base64(HMAC-SHA256(base64decode(secret without `whsec_`), `${id}.${timestamp}.${body}`))
 * 4. compare against each `v1,<sig>` in `svix-signature` in constant time (two during a rotation)
 * 5. any match → the delivery is Rasket's
 *
 * The body must be the raw bytes as they arrived: parsing JSON and writing it out again is not the
 * identity function.
 */

export const TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = "whsec_";

export type VerificationFailure =
  "missing_headers" | "invalid_timestamp" | "timestamp_out_of_window" | "no_matching_signature";

export interface SignatureHeaders {
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
}

/** The three headers, from Node's lower-cased header object. */
export function signatureHeaders(headers: Record<string, unknown>): SignatureHeaders {
  const read = (name: string): string | undefined => {
    const value = headers[name];
    if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  return {
    id: read("svix-id"),
    timestamp: read("svix-timestamp"),
    signature: read("svix-signature"),
  };
}

function signingKey(secret: string): Buffer {
  const body = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(body, "base64");
}

/** The digest a correctly signed delivery carries, as raw bytes. */
export function expectedSignature(
  id: string,
  timestamp: string,
  body: string,
  secret: string,
): Buffer {
  return createHmac("sha256", signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest();
}

/**
 * Whether any `v1,<sig>` in the header matches. Every candidate of the right length is compared,
 * and the loop does not stop at the first match.
 */
export function matchesSignature(header: string, expected: Buffer): boolean {
  let matched = false;
  for (const part of header.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || value === undefined || value === "") continue;
    const candidate = Buffer.from(value, "base64");
    if (candidate.length !== expected.length) continue;
    if (timingSafeEqual(candidate, expected)) matched = true;
  }
  return matched;
}

/**
 * `null` when the delivery is Rasket's, otherwise why not. `nowSeconds` is the receiving clock
 * in Unix seconds.
 */
export function verifySignature(
  headers: SignatureHeaders,
  body: string,
  secret: string,
  nowSeconds: number,
): VerificationFailure | null {
  if (
    headers.id === undefined ||
    headers.timestamp === undefined ||
    headers.signature === undefined
  ) {
    return "missing_headers";
  }
  const sentAt = Number(headers.timestamp);
  if (!Number.isFinite(sentAt)) return "invalid_timestamp";
  if (Math.abs(nowSeconds - sentAt) > TOLERANCE_SECONDS) return "timestamp_out_of_window";
  const expected = expectedSignature(headers.id, headers.timestamp, body, secret);
  return matchesSignature(headers.signature, expected) ? null : "no_matching_signature";
}
