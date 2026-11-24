import { describe, expect, it } from "vitest";

import { listSearch, loadOptions, resourceMapping } from "../nodes/Rasket/methods";
import { Rasket } from "../nodes/Rasket/Rasket.node";

import { apiError, harness, rl } from "./harness";

/** The pickers: searchable lists, plain dropdowns and the three resource mappers. */

const API = "https://api.rasket.com";
const TEMPLATE_ID = "0199d2f1-4c4e-7a20-9c31-6f2b8a0e5d17";

describe("listSearch", () => {
  it("lists published templates with their alias, searching on Rasket and paging by cursor", async () => {
    const h = harness({
      replies: [
        {
          body: {
            data: [
              { id: "t1", name: "Welcome", alias: "welcome" },
              { id: "t2", name: "Receipt" },
            ],
            has_more: true,
          },
        },
      ],
    });
    const result = await listSearch.searchPublishedTemplates.call(h.context, "wel", "t0");
    expect(h.sent[0]).toMatchObject({
      url: `${API}/templates`,
      qs: { status: "published", limit: 100, search: "wel", after: "t0" },
    });
    expect(result).toStrictEqual({
      results: [
        { name: "Welcome (welcome)", value: "t1" },
        { name: "Receipt", value: "t2" },
      ],
      paginationToken: "t2",
    });
  });

  it("filters segments here, since GET /segments has no search", async () => {
    const h = harness({
      replies: [
        {
          body: {
            data: [
              { id: "s1", name: "Customers" },
              { id: "s2", name: "Trials" },
            ],
            has_more: false,
          },
        },
      ],
    });
    const result = await listSearch.searchSegments.call(h.context, "cust");
    expect(h.sent[0]?.qs).toStrictEqual({ limit: 100 });
    expect(result).toStrictEqual({ results: [{ name: "Customers", value: "s1" }] });
  });

  it("lists every template for Get, whatever its status", async () => {
    const h = harness({ replies: [{ body: { data: [{ id: "t1", name: "Draft one" }] } }] });
    await listSearch.searchTemplates.call(h.context);
    expect(h.sent[0]?.qs).toStrictEqual({ limit: 100 });
  });

  it("lists campaigns with their status", async () => {
    const h = harness({
      replies: [{ body: { data: [{ id: "c1", name: "November", status: "sent" }] } }],
    });
    const result = await listSearch.searchCampaigns.call(h.context, "Nov");
    expect(h.sent[0]?.qs).toStrictEqual({ limit: 100, search: "Nov" });
    expect(result.results).toStrictEqual([{ name: "November (sent)", value: "c1" }]);
  });

  it("offers only drafts to Send and Send Test", async () => {
    const h = harness({ replies: [{ body: { data: [{ id: "c1", name: "" }] } }] });
    const result = await listSearch.searchDraftCampaigns.call(h.context);
    expect(h.sent[0]?.qs).toStrictEqual({ status: "draft", limit: 100 });
    expect(result.results).toStrictEqual([{ name: "c1", value: "c1" }]);
  });

  it("offers sending and scheduled campaigns to Cancel", async () => {
    const h = harness({
      replies: [
        { body: { data: [{ id: "g1", name: "Going out" }] } },
        { body: { data: [{ id: "q1", name: "Now" }] } },
        { body: { data: [{ id: "s1", name: "Later" }] } },
      ],
    });
    const result = await listSearch.searchPendingCampaigns.call(h.context);
    // Every status Cancel accepts (CANCELABLE_STATUSES), "sending" included (FA-10).
    expect(h.sent.map((request) => request.qs?.status)).toStrictEqual([
      "sending",
      "queued",
      "scheduled",
    ]);
    expect(result.results).toStrictEqual([
      { name: "Going out (sending)", value: "g1" },
      { name: "Now (queued)", value: "q1" },
      { name: "Later (scheduled)", value: "s1" },
    ]);
  });

  it("labels scheduled emails by subject, recipients and time", async () => {
    const h = harness({
      replies: [
        {
          body: {
            data: [
              {
                id: "e1",
                subject: "Reminder",
                to: ["ada@example.com"],
                scheduled_at: "2026-10-03T09:00:00.000Z",
              },
            ],
          },
        },
      ],
    });
    const result = await listSearch.searchScheduledEmails.call(h.context);
    expect(h.sent[0]?.qs).toMatchObject({ status: "scheduled" });
    expect(result.results).toStrictEqual([
      { name: "Reminder → ada@example.com — 2026-10-03T09:00:00.000Z", value: "e1" },
    ]);
  });

  it("offers hello@ on each verified domain that can send, marking the managed one", async () => {
    const h = harness({
      replies: [
        {
          body: {
            data: [
              { name: "acme.example", status: "verified" },
              { name: "acme.rasket.email", status: "verified", managed: true },
              { name: "off.example", status: "verified", capabilities: { sending: "disabled" } },
            ],
          },
        },
      ],
    });
    const result = await listSearch.searchFromAddresses.call(h.context);
    expect(h.sent[0]?.qs).toStrictEqual({ limit: 100, status: "verified" });
    expect(result.results).toStrictEqual([
      { name: "hello@acme.example", value: "hello@acme.example" },
      { name: "hello@acme.rasket.email (team members only)", value: "hello@acme.rasket.email" },
    ]);
  });
});

describe("loadOptions", () => {
  it("lists topics with their description", async () => {
    const h = harness({
      replies: [{ body: { data: [{ id: "tp1", name: "Product news", description: "Monthly" }] } }],
    });
    await expect(loadOptions.getTopics.call(h.context)).resolves.toStrictEqual([
      { name: "Product news", value: "tp1", description: "Monthly" },
    ]);
    expect(h.sent[0]?.url).toBe(`${API}/topics`);
  });

  it("offers an email campaign only the topics that reach email", async () => {
    const h = harness({
      replies: [
        {
          body: {
            data: [
              { id: "tp1", name: "Product news", channels: ["email"] },
              { id: "tp2", name: "Order texts", channels: ["sms"] },
              { id: "tp3", name: "Offers", channels: ["email", "sms"] },
            ],
          },
        },
      ],
    });
    await expect(loadOptions.getEmailTopics.call(h.context)).resolves.toStrictEqual([
      { name: "Product news", value: "tp1" },
      { name: "Offers", value: "tp3" },
    ]);
    const campaignTopic = JSON.stringify(new Rasket().description.properties).match(
      /"name":"topic","type":"options","typeOptions":\{"loadOptionsMethod":"(\w+)"/,
    );
    expect(campaignTopic?.[1]).toBe("getEmailTopics");
  });

  it("lists segments", async () => {
    const h = harness({ replies: [{ body: { data: [{ id: "s1", name: "Customers" }] } }] });
    await expect(loadOptions.getSegments.call(h.context)).resolves.toStrictEqual([
      { name: "Customers", value: "s1" },
    ]);
  });

  it("lists custom events by name, which is what a send takes", async () => {
    const h = harness({ replies: [{ body: { data: [{ id: "ev1", name: "trial.started" }] } }] });
    await expect(loadOptions.getEvents.call(h.context)).resolves.toStrictEqual([
      { name: "trial.started", value: "trial.started" },
    ]);
  });
});

describe("resourceMapping", () => {
  it("makes each variable of the published version a field, required when it has no fallback", async () => {
    const h = harness({
      parameters: { template: rl(TEMPLATE_ID) },
      replies: [
        {
          body: {
            data: [
              { id: "v3", published: false, variables: [{ key: "draft_only", type: "string" }] },
              {
                id: "v2",
                published: true,
                variables: [
                  { key: "first_name", type: "string" },
                  { key: "seats", type: "number", fallback_value: 1 },
                  { key: "items", type: "list" },
                ],
              },
            ],
            has_more: false,
          },
        },
      ],
    });
    const result = await resourceMapping.getTemplateVariables.call(h.context);
    expect(h.sent[0]?.url).toBe(`${API}/templates/${TEMPLATE_ID}/versions`);
    expect(result.fields.map((field) => [field.id, field.type, field.required])).toStrictEqual([
      ["first_name", "string", true],
      ["seats", "number", false],
      ["items", "array", true],
    ]);
  });

  it("explains a template with no published version instead of failing", async () => {
    const h = harness({
      parameters: { template: rl(TEMPLATE_ID) },
      replies: [apiError(404, "not_found")],
    });
    const result = await resourceMapping.getTemplateVariables.call(h.context);
    expect(result).toMatchObject({
      fields: [],
      emptyFieldsNotice: expect.stringContaining("no published version") as unknown,
    });
  });

  it("explains a template from an expression without calling Rasket", async () => {
    const h = harness({ parameters: { template: rl("={{ $json.template }}") } });
    const result = await resourceMapping.getTemplateVariables.call(h.context);
    expect(result.fields).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it("types the team's contact properties", async () => {
    const h = harness({
      replies: [
        {
          body: {
            data: [
              { id: "p1", key: "plan", type: "string" },
              { id: "p2", key: "seats", type: "number" },
              { id: "p3", key: "vip", type: "boolean" },
            ],
            has_more: false,
          },
        },
      ],
    });
    const result = await resourceMapping.getContactProperties.call(h.context);
    expect(result.fields.map((field) => [field.id, field.type])).toStrictEqual([
      ["plan", "string"],
      ["seats", "number"],
      ["vip", "boolean"],
    ]);
  });

  it("makes a custom event's declared fields, a date as a date and time", async () => {
    const h = harness({
      parameters: { event: "trial.started" },
      replies: [
        {
          body: {
            name: "trial.started",
            schema: { plan: "string", ends_at: "date", seats: "number" },
          },
        },
      ],
    });
    const result = await resourceMapping.getEventFields.call(h.context);
    expect(h.sent[0]?.url).toBe(`${API}/events/trial.started`);
    expect(result.fields.map((field) => [field.id, field.type])).toStrictEqual([
      ["plan", "string"],
      ["ends_at", "dateTime"],
      ["seats", "number"],
    ]);
  });
});
