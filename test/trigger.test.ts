import { createHmac } from "crypto";

import type { IDataObject } from "n8n-workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chosenEvents, EVENTS, RasketTrigger } from "../nodes/RasketTrigger/RasketTrigger.node";
import { expectedSignature, verifySignature } from "../nodes/RasketTrigger/signature";

import { apiError, harness, type HarnessOptions } from "./harness";

/**
 * The Rasket Trigger: the webhook endpoint's lifecycle (create, check, delete) and the signature
 * check on every delivery.
 */

const API = "https://api.rasket.com";
const URL = "https://n8n.example.com/webhook/abc/webhook";
const WEBHOOK_ID = "0199f0a1-1111-7222-8333-944455556666";

// Svix's own published example, pinned by @rasket/webhook-verify's known-answer test too.
const VECTOR = {
  whsec: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: "1614265330",
  payload: '{"test": 2432232314}',
  header: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

const SECRET = "whsec_" + Buffer.from("n8n-trigger-test-secret-key").toString("base64");
const OTHER_SECRET = "whsec_" + Buffer.from("a-rotated-secret-for-this-test").toString("base64");
/** What `GET /webhooks/{id}` returns instead of a secret (`packages/webhooks/src/secret.ts`). */
function mask(secret: string): string {
  return `whsec_••••••••${secret.slice(-4)}`;
}
const ROTATED_SECRET =
  "whsec_" + Buffer.from("the-secret-rotate-secret-returned").toString("base64");
const NOW = new Date("2026-10-02T12:00:00.000Z");
const NOW_SECONDS = String(Math.floor(NOW.getTime() / 1000));

function sign(body: string, secret: string, id = "msg_1", timestamp = NOW_SECONDS): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

const DELIVERY = JSON.stringify({
  type: "email.bounced",
  created_at: "2026-10-02T11:59:58.000Z",
  data: {
    email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    to: ["ada@example.com"],
    bounce: { type: "Permanent" },
  },
});

function delivery(
  overrides: { body?: string; signature?: string; timestamp?: string; events?: string[] } = {},
  extra: Partial<HarnessOptions> = {},
) {
  const body = overrides.body ?? DELIVERY;
  const timestamp = overrides.timestamp ?? NOW_SECONDS;
  return harness({
    parameters: { events: overrides.events ?? ["email.bounced", "email.delivered"] },
    staticData: { endpoints: { [URL]: { id: WEBHOOK_ID, secret: SECRET } } },
    request: {
      rawBody: Buffer.from(body),
      headers: {
        "svix-id": "msg_1",
        "svix-timestamp": timestamp,
        "svix-signature": overrides.signature ?? sign(body, SECRET, "msg_1", timestamp),
      },
    },
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("signature", () => {
  const headers = { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.header };
  const signedAt = Number(VECTOR.timestamp);

  it("matches Svix's known-answer vector", () => {
    expect(
      `v1,${expectedSignature(VECTOR.id, VECTOR.timestamp, VECTOR.payload, VECTOR.whsec).toString("base64")}`,
    ).toBe(VECTOR.header);
    expect(verifySignature(headers, VECTOR.payload, VECTOR.whsec, signedAt)).toBeNull();
  });

  it("refuses a changed body, a wrong secret and missing headers", () => {
    expect(verifySignature(headers, '{"test": 2432232315}', VECTOR.whsec, signedAt)).toBe(
      "no_matching_signature",
    );
    expect(verifySignature(headers, VECTOR.payload, OTHER_SECRET, signedAt)).toBe(
      "no_matching_signature",
    );
    expect(
      verifySignature({ ...headers, id: undefined }, VECTOR.payload, VECTOR.whsec, signedAt),
    ).toBe("missing_headers");
  });

  it("accepts any of the signatures sent during a secret rotation", () => {
    const both = {
      ...headers,
      signature: `v1,${Buffer.alloc(32).toString("base64")} ${VECTOR.header}`,
    };
    expect(verifySignature(both, VECTOR.payload, VECTOR.whsec, signedAt)).toBeNull();
  });

  it("refuses a timestamp more than five minutes away, either side", () => {
    expect(verifySignature(headers, VECTOR.payload, VECTOR.whsec, signedAt + 301)).toBe(
      "timestamp_out_of_window",
    );
    expect(verifySignature(headers, VECTOR.payload, VECTOR.whsec, signedAt - 301)).toBe(
      "timestamp_out_of_window",
    );
    expect(verifySignature(headers, VECTOR.payload, VECTOR.whsec, signedAt + 300)).toBeNull();
  });
});

describe("deliveries", () => {
  it("emits one flat item for a correctly signed delivery of a chosen event", async () => {
    const h = delivery();
    const result = await new RasketTrigger().webhook.call(h.context);
    expect(result.workflowData).toStrictEqual([
      [
        {
          json: {
            email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
            to: ["ada@example.com"],
            bounce: { type: "Permanent" },
            event: "email.bounced",
            occurred_at: "2026-10-02T11:59:58.000Z",
            delivery_id: "msg_1",
          },
        },
      ],
    ]);
    expect(h.sent).toHaveLength(0);
  });

  it("answers 401 and starts nothing for a bad signature, and says how to pick up a rotation", async () => {
    const h = delivery({ signature: sign(DELIVERY, OTHER_SECRET) });
    const result = await new RasketTrigger().webhook.call(h.context);
    expect(result).toStrictEqual({ noWebhookResponse: true });
    expect(h.response.statusCode).toBe(401);
    expect(h.response.json).toStrictEqual({
      message:
        "Signature check failed: no_matching_signature. If the signing secret was rotated in Rasket, deactivate and re-activate the workflow.",
    });
    expect(h.sent).toHaveLength(0);
  });

  it("answers 401 for a body changed after signing", async () => {
    const h = delivery({
      body: DELIVERY.replace("Permanent", "Transient"),
      signature: sign(DELIVERY, SECRET),
    });
    await new RasketTrigger().webhook.call(h.context);
    expect(h.response.statusCode).toBe(401);
    expect(h.sent).toHaveLength(0);
  });

  it("answers 401 for a replay older than five minutes, without asking Rasket", async () => {
    const stale = String(Number(NOW_SECONDS) - 600);
    const h = delivery({ timestamp: stale });
    await new RasketTrigger().webhook.call(h.context);
    expect(h.response.json).toStrictEqual({
      message: "Signature check failed: timestamp_out_of_window.",
    });
    expect(h.sent).toHaveLength(0);
  });

  it("never asks Rasket or changes the stored secret on a forged delivery", async () => {
    // Anyone can POST to the webhook URL; before 0.3.0 a mismatch re-read the (masked) secret.
    const h = delivery(
      { signature: sign(DELIVERY, OTHER_SECRET) },
      { replies: [{ body: { id: WEBHOOK_ID, signing_secret: mask(OTHER_SECRET) } }] },
    );
    await new RasketTrigger().webhook.call(h.context);
    expect(h.response.statusCode).toBe(401);
    expect(h.sent).toHaveLength(0);
    expect(h.queue).toHaveLength(1);
    expect((h.staticData.endpoints as Record<string, IDataObject>)[URL]?.secret).toBe(SECRET);
  });

  it("acknowledges an event that was not chosen without starting the workflow", async () => {
    const h = delivery({ events: ["email.delivered"] });
    const result = await new RasketTrigger().webhook.call(h.context);
    expect(result).toStrictEqual({ webhookResponse: { received: true } });
  });

  it("answers 401 for a URL this node never registered", async () => {
    const h = delivery({}, { staticData: {} });
    await new RasketTrigger().webhook.call(h.context);
    expect(h.response.statusCode).toBe(401);
  });
});

describe("webhook lifecycle", () => {
  const methods = new RasketTrigger().webhookMethods.default;

  it("creates an endpoint for the chosen events and keeps its id and secret per URL", async () => {
    const h = harness({
      parameters: { events: ["email.opened", "contact.created", "not.an.event"] },
      replies: [
        { statusCode: 201, body: { object: "webhook", id: WEBHOOK_ID, signing_secret: SECRET } },
      ],
    });
    await expect(methods.create.call(h.context)).resolves.toBe(true);
    expect(h.sent[0]).toMatchObject({
      method: "POST",
      url: `${API}/webhooks`,
      body: { endpoint: URL, events: ["contact.created", "email.opened"] },
    });
    expect(h.staticData).toStrictEqual({
      endpoints: { [URL]: { id: WEBHOOK_ID, secret: SECRET } },
    });
  });

  it("says what to do when the plan's webhook endpoints are used up", async () => {
    const h = harness({
      parameters: { events: ["email.sent"] },
      replies: [
        apiError(422, "validation_error", "Webhook endpoint limit reached for your plan.", {
          errors: [{ path: "endpoint", message: "Your plan allows 2 webhook endpoints." }],
        }),
      ],
    });
    await expect(methods.create.call(h.context)).rejects.toMatchObject({
      message: "Your plan allows 2 webhook endpoints.",
      description: expect.stringContaining("Rasket → Webhooks") as unknown,
    });
  });

  it("says why a local or plain-http n8n cannot receive webhooks", async () => {
    const h = harness({
      parameters: { events: ["email.sent"] },
      webhookUrl: "http://localhost:5678/webhook/abc/webhook",
      replies: [apiError(422, "validation_error", "endpoint must be a public https URL.")],
    });
    await expect(methods.create.call(h.context)).rejects.toMatchObject({
      message: "Rasket can't deliver to http://localhost:5678/webhook/abc/webhook",
      description: expect.stringContaining("WEBHOOK_URL") as unknown,
    });
  });

  it("finds no endpoint before one was created", async () => {
    const h = harness({ parameters: { events: ["email.sent"] } });
    await expect(methods.checkExists.call(h.context)).resolves.toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  /** `GET /webhooks/{id}` as the API answers it: the secret masked. */
  function detail(secret: string, events = ["email.bounced", "email.delivered"]) {
    return { body: { id: WEBHOOK_ID, endpoint: URL, events, signing_secret: mask(secret) } };
  }

  function stored(h: { staticData: IDataObject }): unknown {
    return (h.staticData.endpoints as Record<string, IDataObject> | undefined)?.[URL]?.secret;
  }

  it("finds the endpoint, keeps its secret and patches in a changed event selection", async () => {
    const h = harness({
      parameters: { events: ["email.sent", "email.bounced"] },
      staticData: { endpoints: { [URL]: { id: WEBHOOK_ID, secret: SECRET } } },
      replies: [detail(SECRET, ["email.sent"]), { body: { id: WEBHOOK_ID } }],
    });
    await expect(methods.checkExists.call(h.context)).resolves.toBe(true);
    expect(h.sent[1]).toMatchObject({
      method: "PATCH",
      url: `${API}/webhooks/${WEBHOOK_ID}`,
      body: { events: ["email.bounced", "email.sent"] },
    });
    expect(h.sent).toHaveLength(2);
    expect(stored(h)).toBe(SECRET);
  });

  it("restart then valid delivery: a masked GET leaves the real secret in place", async () => {
    const h = delivery({}, { replies: [detail(SECRET)] });
    await expect(methods.checkExists.call(h.context)).resolves.toBe(true);
    expect(h.sent).toStrictEqual([
      expect.objectContaining({ method: "GET", url: `${API}/webhooks/${WEBHOOK_ID}` }),
    ]);
    expect(stored(h)).toBe(SECRET);

    const result = await new RasketTrigger().webhook.call(h.context);
    expect(h.response.statusCode).toBeUndefined();
    expect(result.workflowData?.[0]).toHaveLength(1);
  });

  it("rotates the secret when Rasket's mask ends differently, and keeps the new one", async () => {
    const h = harness({
      parameters: { events: ["email.bounced", "email.delivered"] },
      staticData: { endpoints: { [URL]: { id: WEBHOOK_ID, secret: SECRET } } },
      replies: [
        detail(OTHER_SECRET),
        { body: { object: "webhook", id: WEBHOOK_ID, signing_secret: ROTATED_SECRET } },
      ],
    });
    await expect(methods.checkExists.call(h.context)).resolves.toBe(true);
    expect(h.sent[1]).toMatchObject({
      method: "POST",
      url: `${API}/webhooks/${WEBHOOK_ID}/rotate-secret`,
    });
    expect(stored(h)).toBe(ROTATED_SECRET);
    expect(h.queue).toHaveLength(0);
  });

  it("rotates when 0.2.x left a masked secret in the static data", async () => {
    const h = harness({
      parameters: { events: ["email.bounced", "email.delivered"] },
      staticData: { endpoints: { [URL]: { id: WEBHOOK_ID, secret: mask(SECRET) } } },
      replies: [
        detail(SECRET),
        { body: { object: "webhook", id: WEBHOOK_ID, signing_secret: ROTATED_SECRET } },
      ],
    });
    await expect(methods.checkExists.call(h.context)).resolves.toBe(true);
    expect(h.sent[1]).toMatchObject({
      method: "POST",
      url: expect.stringMatching(/rotate-secret$/) as unknown,
    });
    expect(stored(h)).toBe(ROTATED_SECRET);
  });

  it("forgets the endpoint when rotate-secret finds it gone, so activation creates a new one", async () => {
    const h = harness({
      parameters: { events: ["email.bounced", "email.delivered"] },
      staticData: { endpoints: { [URL]: { id: WEBHOOK_ID, secret: SECRET } } },
      replies: [detail(OTHER_SECRET), apiError(404, "not_found")],
    });
    await expect(methods.checkExists.call(h.context)).resolves.toBe(false);
    expect(h.staticData).toStrictEqual({ endpoints: {} });
  });

  it("does not rotate when a refused event change fails the activation", async () => {
    const h = harness({
      parameters: { events: ["inbox.message.received"] },
      staticData: { endpoints: { [URL]: { id: WEBHOOK_ID, secret: SECRET } } },
      replies: [
        detail(OTHER_SECRET),
        apiError(403, "invalid_permission", "This API key has no Inbox access."),
      ],
    });
    await expect(methods.checkExists.call(h.context)).rejects.toMatchObject({
      description: expect.stringContaining("Inbox access") as unknown,
    });
    expect(h.sent.map((sent) => sent.method)).toStrictEqual(["GET", "PATCH"]);
    expect(stored(h)).toBe(SECRET);
  });

  it("forgets an endpoint deleted in Rasket so activation creates a new one", async () => {
    const h = harness({
      parameters: { events: ["email.sent"] },
      staticData: { endpoints: { [URL]: { id: WEBHOOK_ID, secret: SECRET } } },
      replies: [apiError(404, "not_found")],
    });
    await expect(methods.checkExists.call(h.context)).resolves.toBe(false);
    expect(h.staticData).toStrictEqual({ endpoints: {} });
  });

  it("deletes the endpoint, and treats one already gone as deleted", async () => {
    for (const reply of [
      { body: { object: "webhook", id: WEBHOOK_ID, deleted: true } },
      apiError(404, "not_found"),
    ]) {
      const h = harness({
        staticData: { endpoints: { [URL]: { id: WEBHOOK_ID, secret: SECRET } } },
        replies: [reply],
      });
      await expect(methods.delete.call(h.context)).resolves.toBe(true);
      expect(h.sent[0]).toMatchObject({ method: "DELETE", url: `${API}/webhooks/${WEBHOOK_ID}` });
      expect(h.staticData).toStrictEqual({ endpoints: {} });
    }
  });

  it("keeps the record and fails when Rasket refuses the delete", async () => {
    const h = harness({
      staticData: { endpoints: { [URL]: { id: WEBHOOK_ID, secret: SECRET } } },
      replies: [apiError(500, "internal_server_error", "Something went wrong.")],
    });
    await expect(methods.delete.call(h.context)).rejects.toMatchObject({
      message: "Something went wrong.",
    });
    expect(Object.keys(h.staticData.endpoints as IDataObject)).toStrictEqual([URL]);
  });
});

describe("events", () => {
  it("offers the SMS, Inbox and Autopilot events, and keeps every one it offers", () => {
    const values = EVENTS.map((event) => event.value);
    for (const event of [
      "sms.queued",
      "sms.sent",
      "sms.failed",
      "contact.sms_unsubscribed",
      "inbox.conversation.created",
      "inbox.message.received",
      "inbox.reply.sent",
      "inbox.note.created",
      "inbox.conversation.assigned",
      "inbox.conversation.status_changed",
      "autopilot.proposal.created",
      "autopilot.proposal.approved",
      "autopilot.proposal.skipped",
      "autopilot.proposal.expired",
      "autopilot.proposal.sent",
    ]) {
      expect(values).toContain(event);
    }
    expect(chosenEvents(values)).toStrictEqual([...new Set(values)].sort());
  });
});
