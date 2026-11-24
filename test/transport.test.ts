import { beforeEach, describe, expect, it, vi } from "vitest";

import { rasketList, rasketRequest, retryAfterSeconds, timing } from "../nodes/Rasket/transport";

import { apiError, harness } from "./harness";

/** The one way the nodes reach Rasket: headers, errors, the 429 retry and paging. */

beforeEach(() => {
  vi.spyOn(timing, "sleep").mockResolvedValue(undefined);
});

describe("rasketRequest", () => {
  it("sends the User-Agent and JSON headers through the rasketApi credential", async () => {
    const h = harness({ replies: [{ body: { id: "team" } }] });
    await expect(rasketRequest(h.context, { path: "/team" })).resolves.toStrictEqual({
      id: "team",
    });
    expect(h.sent[0]).toMatchObject({
      credential: "rasketApi",
      method: "GET",
      url: "https://api.rasket.com/team",
      headers: { Accept: "application/json", "User-Agent": "n8n-nodes-rasket/0.3.0" },
    });
  });

  it("waits out one rate-limit 429 for its Retry-After, then retries", async () => {
    const h = harness({
      replies: [
        { ...apiError(429, "rate_limit_exceeded"), headers: { "retry-after": "3" } },
        { body: { ok: true } },
      ],
    });
    await expect(rasketRequest(h.context, { path: "/team" })).resolves.toStrictEqual({ ok: true });
    expect(timing.sleep).toHaveBeenCalledWith(3000);
    expect(h.sent).toHaveLength(2);
  });

  it("leaves a second rate-limit 429 to the node's Retry On Fail", async () => {
    const h = harness({
      replies: [apiError(429, "rate_limit_exceeded"), apiError(429, "rate_limit_exceeded")],
    });
    await expect(rasketRequest(h.context, { path: "/team" })).rejects.toMatchObject({
      description: expect.stringContaining("Retry On Fail") as unknown,
    });
  });

  it("never retries a quota 429, and says how to fix it", async () => {
    const h = harness({
      replies: [apiError(429, "monthly_quota_exceeded", "Monthly quota exceeded.")],
    });
    await expect(
      rasketRequest(h.context, { path: "/emails", method: "POST" }),
    ).rejects.toMatchObject({
      message: "Monthly quota exceeded.",
      description: expect.stringContaining("Rasket → Billing") as unknown,
      httpCode: "429",
    });
    expect(h.sent).toHaveLength(1);
    expect(timing.sleep).not.toHaveBeenCalled();
  });

  it("names the field a 422 is about", async () => {
    const h = harness({
      replies: [
        apiError(422, "validation_error", "Invalid request.", {
          errors: [{ path: "from", message: "The domain is not verified." }],
        }),
      ],
    });
    await expect(
      rasketRequest(h.context, { path: "/emails", method: "POST", itemIndex: 2 }),
    ).rejects.toMatchObject({
      message: "Invalid request. (from: The domain is not verified.)",
      context: { itemIndex: 2 },
    });
  });

  it("tells a key without the scope to use a Full access key", async () => {
    const h = harness({
      replies: [
        {
          ...apiError(403, "restricted_api_key"),
          headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' },
        },
      ],
    });
    await expect(rasketRequest(h.context, { path: "/webhooks" })).rejects.toMatchObject({
      description: expect.stringContaining("Full access key") as unknown,
    });
  });

  it("tells a key without SMS access how to get it, in Rasket's own message", async () => {
    const h = harness({
      replies: [
        apiError(
          403,
          "invalid_permission",
          "This API key has no SMS access. An admin can turn it on under API keys.",
        ),
      ],
    });
    await expect(
      rasketRequest(h.context, { path: "/sms", method: "POST", body: { to: "+15555550100" } }),
    ).rejects.toMatchObject({
      message: "This API key has no SMS access. An admin can turn it on under API keys.",
      description:
        "Give this key SMS access in Rasket → API keys: Send only to send texts, Read to read them, Send and manage for both.",
    });
  });

  it("gives an SMS policy refusal no key advice", async () => {
    const h = harness({
      replies: [
        apiError(403, "validation_error", "Texts to this number are not allowed.", {
          details: { reason: "sms_policy" },
        }),
      ],
    });
    const error: unknown = await rasketRequest(h.context, { path: "/sms", method: "POST" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ message: "Texts to this number are not allowed." });
    expect(String((error as { description?: unknown }).description)).not.toContain("access");
  });

  it("tells a Send only key it needs Full access", async () => {
    const h = harness({ replies: [apiError(401, "restricted_api_key")] });
    await expect(rasketRequest(h.context, { path: "/contacts" })).rejects.toMatchObject({
      description:
        "This key can't do this. Use a key with Email access: Full access from Rasket → API keys.",
    });
  });

  it("tells a revoked key to make a new one", async () => {
    const h = harness({ replies: [apiError(403, "restricted_api_key")] });
    await expect(rasketRequest(h.context, { path: "/contacts" })).rejects.toMatchObject({
      description: expect.stringContaining("revoked") as unknown,
    });
  });

  it("says what Inbox events need when the webhook create is refused", async () => {
    const h = harness({
      replies: [apiError(403, "invalid_permission", "This API key has no Inbox access.")],
    });
    await expect(
      rasketRequest(h.context, { path: "/webhooks", method: "POST" }),
    ).rejects.toMatchObject({
      description: expect.stringContaining("Inbox access Read or Read and reply") as unknown,
    });
  });

  it("reads a response that is not Rasket's error shape by its status", async () => {
    const h = harness({ replies: [{ statusCode: 502, body: "<html>Bad gateway</html>" }] });
    await expect(rasketRequest(h.context, { path: "/team" })).rejects.toMatchObject({
      message: "Rasket answered HTTP 502.",
    });
  });

  it("caps Retry-After at ten seconds and defaults to one", () => {
    expect(retryAfterSeconds({ "Retry-After": "120" })).toBe(10);
    expect(retryAfterSeconds({})).toBe(1);
    expect(retryAfterSeconds({ "retry-after": "nonsense" })).toBe(1);
  });
});

describe("rasketList", () => {
  it("pages over the after cursor and stops at the limit", async () => {
    const h = harness({
      replies: [
        { body: { data: [{ id: "a" }, { id: "b" }], has_more: true } },
        { body: { data: [{ id: "c" }, { id: "d" }], has_more: true } },
      ],
    });
    const rows = await rasketList(h.context, { path: "/contacts" }, 3);
    expect(rows.map((row) => row.id)).toStrictEqual(["a", "b", "c"]);
    expect(h.sent.map((request) => request.qs)).toStrictEqual([
      { limit: 3 },
      { limit: 1, after: "b" },
    ]);
  });
});
