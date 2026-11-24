import type { IDataObject, INodeProperties } from "n8n-workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Rasket } from "../nodes/Rasket/Rasket.node";
import { timing } from "../nodes/Rasket/transport";

import { apiError, harness, type Reply, rl, type Sent } from "./harness";

beforeEach(() => {
  vi.spyOn(timing, "sleep").mockResolvedValue(undefined);
});

/**
 * One case per resource and operation, run through the node's own `execute`: the parameters a user
 * sets, what Rasket answers, and the request and output that must come of it. The first test walks
 * the node's description and fails when an operation has no case here.
 */

const API = "https://api.rasket.com";
const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const CONTACT_ID = "e169aa45-1ecf-4183-9955-b1499d5701d3";
const SEGMENT_ID = "78261eea-8f8b-4381-83c6-79fa7120f1cf";
const TEMPLATE_ID = "0199d2f1-4c4e-7a20-9c31-6f2b8a0e5d17";
const CAMPAIGN_ID = "0199e1b3-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const TOPIC_ID = "b6d24b8e-af0b-4c3c-be0c-359bbd97381e";
const SMS_ID = "01928c3e-5b7a-7c1e-9a2f-3d4e5f60718a";

interface Case {
  readonly parameters: IDataObject;
  readonly replies: Reply[];
  readonly check: (sent: Sent[], output: IDataObject[]) => void;
}

function only(sent: Sent[]): Sent {
  expect(sent).toHaveLength(1);
  return sent[0] as Sent;
}

const CASES: Record<string, Case> = {
  "email:send": {
    parameters: {
      resource: "email",
      operation: "send",
      from: rl("hello@acme.example"),
      to: "ada@example.com, grace@example.com",
      subject: "Welcome",
      html: "<p>Hi</p>",
      text: "",
      options: {
        cc: "ops@acme.example",
        idempotencyKey: "order-1042",
        tags: { pair: [{ name: "invoice", value: "1042" }] },
      },
    },
    replies: [{ body: { id: EMAIL_ID } }],
    check: (sent, output) => {
      const request = only(sent);
      expect(request).toMatchObject({
        method: "POST",
        url: `${API}/emails`,
        credential: "rasketApi",
      });
      expect(request.headers).toMatchObject({
        "Idempotency-Key": "order-1042",
        "User-Agent": "n8n-nodes-rasket/0.3.0",
      });
      expect(request.body).toStrictEqual({
        from: "hello@acme.example",
        subject: "Welcome",
        html: "<p>Hi</p>",
        to: ["ada@example.com", "grace@example.com"],
        cc: ["ops@acme.example"],
        tags: [{ name: "invoice", value: "1042" }],
      });
      expect(output).toStrictEqual([{ id: EMAIL_ID }]);
    },
  },
  "email:sendTemplate": {
    parameters: {
      resource: "email",
      operation: "sendTemplate",
      template: rl(TEMPLATE_ID),
      from: rl(""),
      to: "ada@example.com",
      variables: { mappingMode: "defineBelow", value: { first_name: "Ada", plan: "", seats: 3 } },
      options: { subject: "Your plan" },
    },
    replies: [{ body: { id: EMAIL_ID } }],
    check: (sent) => {
      expect(only(sent).body).toStrictEqual({
        subject: "Your plan",
        template: { id: TEMPLATE_ID, variables: { first_name: "Ada", seats: 3 } },
        to: ["ada@example.com"],
      });
    },
  },
  "email:schedule": {
    parameters: {
      resource: "email",
      operation: "schedule",
      sendAt: "2026-10-03T09:00:00.000Z",
      content: "template",
      template: rl(TEMPLATE_ID),
      from: rl("hello@acme.example"),
      to: "ada@example.com",
      variables: { value: {} },
    },
    replies: [{ body: { id: EMAIL_ID } }],
    check: (sent, output) => {
      expect(only(sent).body).toStrictEqual({
        from: "hello@acme.example",
        template: { id: TEMPLATE_ID },
        to: ["ada@example.com"],
        scheduled_at: "2026-10-03T09:00:00.000Z",
      });
      expect(output).toStrictEqual([{ id: EMAIL_ID, scheduled_at: "2026-10-03T09:00:00.000Z" }]);
    },
  },
  "email:reschedule": {
    parameters: {
      resource: "email",
      operation: "reschedule",
      emailId: rl(EMAIL_ID),
      sendAt: "2026-10-04T09:00:00.000Z",
    },
    replies: [apiError(409, "resource_locked"), { body: { id: EMAIL_ID } }],
    check: (sent, output) => {
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({
        method: "PATCH",
        url: `${API}/emails/${EMAIL_ID}`,
        body: { scheduled_at: "2026-10-04T09:00:00.000Z" },
      });
      expect(output).toStrictEqual([{ id: EMAIL_ID, scheduled_at: "2026-10-04T09:00:00.000Z" }]);
    },
  },
  "email:cancel": {
    parameters: { resource: "email", operation: "cancel", emailId: rl(EMAIL_ID) },
    replies: [
      apiError(400, "validation_error"),
      { body: { id: EMAIL_ID, last_event: "canceled" } },
    ],
    check: (sent, output) => {
      expect(sent.map((request) => `${request.method} ${request.url}`)).toStrictEqual([
        `POST ${API}/emails/${EMAIL_ID}/cancel`,
        `GET ${API}/emails/${EMAIL_ID}`,
      ]);
      expect(output).toStrictEqual([{ id: EMAIL_ID, canceled: true }]);
    },
  },
  "email:get": {
    parameters: { resource: "email", operation: "get", emailId: EMAIL_ID, simplify: true },
    replies: [
      {
        body: {
          object: "email",
          id: EMAIL_ID,
          from: "hello@acme.example",
          to: ["ada@example.com"],
          cc: [],
          bcc: [],
          reply_to: [],
          subject: "Welcome",
          html: "<p>Hi</p>",
          text: "Hi",
          last_event: "delivered",
          created_at: "2026-10-01T12:00:00.000Z",
          scheduled_at: null,
          message_id: "<x@acme.example>",
          tags: { invoice: "1042" },
        },
      },
    ],
    check: (sent, output) => {
      expect(only(sent)).toMatchObject({ method: "GET", url: `${API}/emails/${EMAIL_ID}` });
      expect(output).toStrictEqual([
        {
          id: EMAIL_ID,
          from: "hello@acme.example",
          to: "ada@example.com",
          subject: "Welcome",
          last_event: "delivered",
          created_at: "2026-10-01T12:00:00.000Z",
          scheduled_at: null,
          cc: "",
          reply_to: "",
          tags: { invoice: "1042" },
        },
      ]);
    },
  },
  "email:getAll": {
    parameters: {
      resource: "email",
      operation: "getAll",
      returnAll: true,
      filters: { status: "bounced" },
      simplify: false,
    },
    replies: [
      { body: { data: [{ id: "a" }, { id: "b" }], has_more: true } },
      { body: { data: [{ id: "c" }], has_more: false } },
    ],
    check: (sent, output) => {
      expect(sent.map((request) => request.qs)).toStrictEqual([
        { status: "bounced", limit: 100 },
        { status: "bounced", limit: 100, after: "b" },
      ]);
      expect(output.map((row) => row.id)).toStrictEqual(["a", "b", "c"]);
    },
  },
  "contact:upsert": {
    parameters: {
      resource: "contact",
      operation: "upsert",
      email: " ada@example.com ",
      additionalFields: {
        firstName: "Ada",
        unsubscribed: false,
        segments: [SEGMENT_ID],
        topicsOptIn: [TOPIC_ID],
      },
      properties: { value: { plan: "Pro", seats: 3, vip: true, empty: "" } },
    },
    replies: [{ statusCode: 201, body: { object: "contact", id: CONTACT_ID } }],
    check: (sent, output) => {
      expect(only(sent)).toMatchObject({ method: "POST", url: `${API}/contacts` });
      expect(only(sent).body).toStrictEqual({
        email: "ada@example.com",
        first_name: "Ada",
        unsubscribed: false,
        properties: { plan: "Pro", seats: 3, vip: true },
        segments: [{ id: SEGMENT_ID }],
        topics: [{ id: TOPIC_ID, subscription: "opt_in" }],
      });
      expect(output[0]).toMatchObject({ id: CONTACT_ID, email: "ada@example.com" });
    },
  },
  "contact:get": {
    parameters: { resource: "contact", operation: "get", contact: "ada+news@example.com" },
    replies: [{ body: { id: CONTACT_ID, email: "ada+news@example.com" } }],
    check: (sent, output) => {
      expect(only(sent).url).toBe(`${API}/contacts/ada%2Bnews%40example.com`);
      expect(output).toStrictEqual([{ id: CONTACT_ID, email: "ada+news@example.com" }]);
    },
  },
  "contact:getAll": {
    parameters: {
      resource: "contact",
      operation: "getAll",
      returnAll: false,
      limit: 2,
      filters: { segment: SEGMENT_ID },
    },
    replies: [{ body: { data: [{ id: "a" }, { id: "b" }], has_more: true } }],
    check: (sent, output) => {
      expect(only(sent).qs).toStrictEqual({ segment_id: SEGMENT_ID, limit: 2 });
      expect(output).toHaveLength(2);
    },
  },
  "contact:delete": {
    parameters: { resource: "contact", operation: "delete", contact: CONTACT_ID },
    replies: [{ body: { object: "contact", id: CONTACT_ID, deleted: true } }],
    check: (sent, output) => {
      expect(only(sent)).toMatchObject({ method: "DELETE", url: `${API}/contacts/${CONTACT_ID}` });
      expect(output).toStrictEqual([
        { contact: CONTACT_ID, object: "contact", id: CONTACT_ID, deleted: true },
      ]);
    },
  },
  "contact:addToSegment": {
    parameters: {
      resource: "contact",
      operation: "addToSegment",
      contact: "ada@example.com",
      segment: rl(SEGMENT_ID),
    },
    replies: [{ body: { contact_id: CONTACT_ID, segment_id: SEGMENT_ID } }],
    check: (sent, output) => {
      expect(only(sent)).toMatchObject({
        method: "POST",
        url: `${API}/contacts/ada%40example.com/segments/${SEGMENT_ID}`,
      });
      expect(output[0]).toMatchObject({ contact_id: CONTACT_ID, in_segment: true });
    },
  },
  "contact:removeFromSegment": {
    parameters: {
      resource: "contact",
      operation: "removeFromSegment",
      contact: "ada@example.com",
      segment: rl(SEGMENT_ID, "id"),
    },
    replies: [
      {
        body: {
          object: "contact_segment",
          contact_id: CONTACT_ID,
          segment_id: SEGMENT_ID,
          deleted: true,
        },
      },
    ],
    check: (sent, output) => {
      expect(only(sent).method).toBe("DELETE");
      expect(output).toStrictEqual([
        {
          contact: "ada@example.com",
          object: "contact_segment",
          contact_id: CONTACT_ID,
          segment_id: SEGMENT_ID,
          deleted: true,
          in_segment: false,
        },
      ]);
    },
  },
  "contact:subscribeToTopics": {
    parameters: {
      resource: "contact",
      operation: "subscribeToTopics",
      contact: "ada@example.com",
      topics: [TOPIC_ID],
    },
    replies: [{ body: { contact_id: CONTACT_ID } }],
    check: (sent) => {
      expect(only(sent)).toMatchObject({
        method: "PATCH",
        url: `${API}/contacts/ada%40example.com/topics`,
        body: { topics: [{ id: TOPIC_ID, subscription: "opt_in" }] },
      });
    },
  },
  "contact:unsubscribeFromTopics": {
    parameters: {
      resource: "contact",
      operation: "unsubscribeFromTopics",
      contact: "ada@example.com",
      topics: [TOPIC_ID],
    },
    replies: [{ body: { contact_id: CONTACT_ID } }],
    check: (sent, output) => {
      expect(only(sent).body).toStrictEqual({
        topics: [{ id: TOPIC_ID, subscription: "opt_out" }],
      });
      expect(output[0]).toMatchObject({ subscription: "opt_out", topic_ids: [TOPIC_ID] });
    },
  },
  "suppression:add": {
    parameters: { resource: "suppression", operation: "add", email: "ada@example.com" },
    replies: [{ statusCode: 201, body: { id: "s1" } }],
    check: (sent, output) => {
      expect(only(sent)).toMatchObject({
        method: "POST",
        url: `${API}/suppressions`,
        body: { email: "ada@example.com" },
      });
      expect(output).toStrictEqual([{ email: "ada@example.com", id: "s1" }]);
    },
  },
  "suppression:remove": {
    parameters: { resource: "suppression", operation: "remove", email: "ada@example.com" },
    replies: [{ body: {} }],
    check: (sent, output) => {
      expect(only(sent)).toMatchObject({
        method: "DELETE",
        url: `${API}/suppressions/ada%40example.com`,
      });
      expect(output).toStrictEqual([{ email: "ada@example.com", removed: true }]);
    },
  },
  "suppression:getAll": {
    parameters: {
      resource: "suppression",
      operation: "getAll",
      returnAll: false,
      limit: 5,
      filters: { origin: "unsubscribe" },
    },
    replies: [{ body: { data: [{ id: "s1", email: "ada@example.com" }], has_more: false } }],
    check: (sent, output) => {
      expect(only(sent).qs).toStrictEqual({ origin: "unsubscribe", limit: 5 });
      expect(output).toHaveLength(1);
    },
  },
  "campaign:create": {
    parameters: {
      resource: "campaign",
      operation: "create",
      segment: rl(SEGMENT_ID),
      from: rl("Acme <news@acme.example>", "address"),
      subject: "November news",
      content: "template",
      template: rl(TEMPLATE_ID),
      sendNow: true,
      options: { name: "November", topic: TOPIC_ID },
    },
    replies: [{ statusCode: 201, body: { id: CAMPAIGN_ID } }],
    check: (sent, output) => {
      expect(only(sent)).toMatchObject({ method: "POST", url: `${API}/broadcasts` });
      expect(only(sent).body).toStrictEqual({
        name: "November",
        segment_id: SEGMENT_ID,
        from: "Acme <news@acme.example>",
        subject: "November news",
        topic_id: TOPIC_ID,
        template: { id: TEMPLATE_ID },
        send: true,
      });
      expect(output).toStrictEqual([{ id: CAMPAIGN_ID, sent: true }]);
    },
  },
  "campaign:send": {
    parameters: {
      resource: "campaign",
      operation: "send",
      campaign: rl(CAMPAIGN_ID),
      sendOptions: { sendAt: "2026-10-05T08:00:00.000Z" },
    },
    replies: [{ body: { id: CAMPAIGN_ID } }],
    check: (sent) => {
      expect(only(sent)).toMatchObject({
        method: "POST",
        url: `${API}/broadcasts/${CAMPAIGN_ID}/send`,
        body: { scheduled_at: "2026-10-05T08:00:00.000Z" },
      });
    },
  },
  "campaign:sendTest": {
    parameters: {
      resource: "campaign",
      operation: "sendTest",
      campaign: rl(CAMPAIGN_ID),
      to: "ada@example.com",
      testOptions: {},
    },
    replies: [{ body: { data: [{ id: EMAIL_ID, to: "ada@example.com" }] } }],
    check: (sent, output) => {
      expect(only(sent)).toMatchObject({
        url: `${API}/broadcasts/${CAMPAIGN_ID}/test`,
        body: { to: ["ada@example.com"] },
      });
      expect(output[0]).toMatchObject({ campaign_id: CAMPAIGN_ID });
    },
  },
  "campaign:cancel": {
    parameters: { resource: "campaign", operation: "cancel", campaign: rl(CAMPAIGN_ID) },
    replies: [{ body: { id: CAMPAIGN_ID } }],
    check: (sent, output) => {
      expect(only(sent)).toMatchObject({
        method: "POST",
        url: `${API}/broadcasts/${CAMPAIGN_ID}/cancel`,
      });
      expect(output).toStrictEqual([{ id: CAMPAIGN_ID, canceled: true }]);
    },
  },
  "campaign:get": {
    parameters: {
      resource: "campaign",
      operation: "get",
      campaign: rl(CAMPAIGN_ID),
      simplify: false,
    },
    replies: [{ body: { id: CAMPAIGN_ID, name: "November", html: "<p/>" } }],
    check: (sent, output) => {
      expect(only(sent).url).toBe(`${API}/broadcasts/${CAMPAIGN_ID}`);
      expect(output).toStrictEqual([{ id: CAMPAIGN_ID, name: "November", html: "<p/>" }]);
    },
  },
  "campaign:getAll": {
    parameters: {
      resource: "campaign",
      operation: "getAll",
      returnAll: false,
      limit: 10,
      filters: { status: "sent" },
      simplify: true,
    },
    replies: [{ body: { data: [{ id: CAMPAIGN_ID, name: "November", status: "sent" }] } }],
    check: (sent, output) => {
      expect(only(sent).qs).toStrictEqual({ status: "sent", limit: 10 });
      expect(output[0]).toMatchObject({ id: CAMPAIGN_ID, status: "sent", sent_at: null });
    },
  },
  "event:send": {
    parameters: {
      resource: "event",
      operation: "send",
      event: "trial.started",
      contact: CONTACT_ID,
      data: { value: { plan: "Pro" } },
      moreData: { pair: [{ name: "source", value: "n8n" }] },
    },
    replies: [{ body: { object: "event", event: "trial.started" } }],
    check: (sent) => {
      expect(only(sent)).toMatchObject({ method: "POST", url: `${API}/events/send` });
      expect(only(sent).body).toStrictEqual({
        event: "trial.started",
        contact_id: CONTACT_ID,
        payload: { source: "n8n", plan: "Pro" },
      });
    },
  },
  "sms:send": {
    parameters: {
      resource: "sms",
      operation: "send",
      to: "+14155550123",
      text: "Your order has shipped.",
      options: { category: "transactional", idempotencyKey: "order-1042-sms" },
    },
    replies: [{ body: { object: "sms", id: SMS_ID, status: "queued" } }],
    check: (sent, output) => {
      const request = only(sent);
      expect(request).toMatchObject({ method: "POST", url: `${API}/sms` });
      expect(request.headers).toMatchObject({ "Idempotency-Key": "order-1042-sms" });
      expect(request.body).toStrictEqual({
        to: "+14155550123",
        text: "Your order has shipped.",
        category: "transactional",
      });
      expect(output).toStrictEqual([{ object: "sms", id: SMS_ID, status: "queued" }]);
    },
  },
  "sms:get": {
    parameters: { resource: "sms", operation: "get", smsId: SMS_ID },
    replies: [{ body: { object: "sms", id: SMS_ID, status: "delivered" } }],
    check: (sent) => {
      expect(only(sent)).toMatchObject({ method: "GET", url: `${API}/sms/${SMS_ID}` });
    },
  },
  "template:get": {
    parameters: {
      resource: "template",
      operation: "get",
      template: rl(TEMPLATE_ID),
      simplify: true,
    },
    replies: [
      {
        body: {
          id: TEMPLATE_ID,
          name: "Welcome",
          status: "published",
          variables: [{ key: "first_name" }, { key: "plan" }],
          html: "<p/>",
        },
      },
    ],
    check: (sent, output) => {
      expect(only(sent).url).toBe(`${API}/templates/${TEMPLATE_ID}`);
      expect(output[0]).toMatchObject({ name: "Welcome", variables: "first_name, plan" });
      expect(output[0]).not.toHaveProperty("html");
    },
  },
  "template:getAll": {
    parameters: {
      resource: "template",
      operation: "getAll",
      returnAll: true,
      filters: { search: "welcome" },
      simplify: false,
    },
    replies: [{ body: { data: [{ id: TEMPLATE_ID }], has_more: false } }],
    check: (sent) => {
      expect(only(sent).qs).toStrictEqual({ search: "welcome", limit: 100 });
    },
  },
  "segment:get": {
    parameters: { resource: "segment", operation: "get", segment: rl(SEGMENT_ID) },
    replies: [{ body: { id: SEGMENT_ID, name: "Customers" } }],
    check: (sent, output) => {
      expect(only(sent).url).toBe(`${API}/segments/${SEGMENT_ID}`);
      expect(output).toStrictEqual([{ id: SEGMENT_ID, name: "Customers" }]);
    },
  },
  "segment:getAll": {
    parameters: { resource: "segment", operation: "getAll", returnAll: true },
    replies: [{ body: { data: [{ id: SEGMENT_ID }], has_more: false } }],
    check: (sent, output) => {
      expect(only(sent)).toMatchObject({ url: `${API}/segments`, qs: { limit: 100 } });
      expect(output).toHaveLength(1);
    },
  },
};

/** `resource:operation` for every operation the node offers. */
function describedOperations(): string[] {
  const properties: INodeProperties[] = new Rasket().description.properties;
  return properties
    .filter((property) => property.name === "operation")
    .flatMap((property) => {
      const resources = (property.displayOptions?.show?.resource ?? []) as string[];
      const values = (property.options ?? []).map((option) =>
        String((option as { value: unknown }).value),
      );
      return resources.flatMap((resource) => values.map((value) => `${resource}:${value}`));
    });
}

async function run(
  parameters: IDataObject | IDataObject[],
  replies: Reply[],
  continueOnFail = false,
) {
  const h = harness({ parameters, replies, continueOnFail });
  const [output] = await new Rasket().execute.call(h.context);
  return { h, output: output ?? [] };
}

describe("Rasket node", () => {
  it("has a case for every resource and operation it offers, and none it doesn't", () => {
    expect(describedOperations().sort()).toStrictEqual(Object.keys(CASES).sort());
  });

  it.each(Object.entries(CASES))("%s", async (_key, testCase) => {
    const { h, output } = await run(testCase.parameters, testCase.replies);
    testCase.check(
      h.sent,
      output.map((item) => item.json),
    );
    expect(h.queue).toHaveLength(0);
    for (const item of output) expect(item.pairedItem).toStrictEqual({ item: 0 });
  });

  it("pairs each output with its input item", async () => {
    const parameters = { resource: "segment", operation: "get", segment: rl(SEGMENT_ID) };
    const { output } = await run(
      [parameters, parameters],
      [{ body: { id: "one" } }, { body: { id: "two" } }],
    );
    expect(output.map((item) => item.pairedItem)).toStrictEqual([{ item: 0 }, { item: 1 }]);
  });

  it("refuses more than fifty recipients before calling Rasket", async () => {
    const to = Array.from({ length: 51 }, (_, index) => `user${String(index)}@example.com`).join(
      ",",
    );
    await expect(
      run(
        {
          resource: "email",
          operation: "send",
          from: rl("hello@acme.example"),
          to,
          subject: "Hi",
          html: "<p/>",
        },
        [],
      ),
    ).rejects.toThrow("The email has 51 recipients");
  });

  it("refuses a send with neither HTML nor text", async () => {
    await expect(
      run(
        {
          resource: "email",
          operation: "send",
          from: rl("hello@acme.example"),
          to: "a@b.c",
          subject: "Hi",
        },
        [],
      ),
    ).rejects.toThrow("The email has no content");
  });

  it("names the item and Rasket's reason, and says what to do, when Rasket refuses", async () => {
    const parameters = { resource: "segment", operation: "get", segment: rl(SEGMENT_ID) };
    const error: unknown = await run(parameters, [
      apiError(404, "not_found", "Segment not found."),
    ]).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: "Segment not found.",
      description: expect.stringContaining("Pick it again") as unknown,
      context: { itemIndex: 0 },
    });
  });

  it("outputs the error and carries on when Continue On Fail is set", async () => {
    const parameters = { resource: "segment", operation: "get", segment: rl(SEGMENT_ID) };
    const { output } = await run(
      [parameters, parameters],
      [apiError(404, "not_found", "Segment not found."), { body: { id: SEGMENT_ID } }],
      true,
    );
    expect(output.map((item) => item.json)).toStrictEqual([
      { error: "Segment not found." },
      { id: SEGMENT_ID },
    ]);
  });
});
