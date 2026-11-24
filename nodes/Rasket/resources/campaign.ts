import type { IDataObject, IExecuteFunctions, INodeProperties } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import {
  ACKNOWLEDGE_CHECKS_OPTION,
  acknowledgeChecks,
  addressList,
  booleanValue,
  defined,
  fromLocator,
  idempotencyHeader,
  IDEMPOTENCY_KEY_OPTION,
  isLocked,
  locator,
  type Operation,
  optionalText,
  readLimit,
  requiredLocator,
  requiredString,
  returnAllAndLimit,
  show,
  simplifyParameter,
  zonedInstant,
} from "../shared";
import { simplifyCampaign, simplifyCampaignRow } from "../simplify";
import {
  rasketError,
  rasketList,
  rasketRawRequest,
  rasketRequest,
  segment,
  timing,
} from "../transport";

/**
 * Campaigns. "Campaign" is the dashboard's word for the API's broadcast, so every label here says
 * campaign and every path says `/broadcasts`.
 *
 * A send goes through Rasket's send gate: a verified sending domain, a postal address on the team,
 * a segment that resolves, marketing switched on, and a team in good standing. A refusal carries
 * the API's own message, which the error shows as it is. Then the content checks run: a failing one
 * is refused with every failing check listed, unless Send Despite Failed Checks is on.
 */

const R = "campaign";

export const campaignOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  noDataExpression: true,
  displayOptions: { show: { resource: [R] } },
  default: "create",
  options: [
    {
      name: "Cancel",
      value: "cancel",
      action: "Cancel campaign",
      description: "Cancel a scheduled campaign, or stop one that is sending",
    },
    {
      name: "Create",
      value: "create",
      action: "Create campaign",
      description:
        "Create a new campaign for one of your segments, as a draft or sent straight away",
    },
    { name: "Get", value: "get", action: "Get campaign", description: "Retrieve a campaign" },
    {
      name: "Get Many",
      value: "getAll",
      action: "Get many campaigns",
      description: "Retrieve a list of campaigns",
    },
    {
      name: "Send",
      value: "send",
      action: "Send campaign",
      description: "Send a draft campaign now, or schedule it for later",
    },
    {
      name: "Send Test",
      value: "sendTest",
      action: "Send test of campaign",
      description: "Send a test of a draft campaign to up to five addresses",
    },
  ],
};

function campaignLocator(
  operations: string[],
  searchListMethod: string,
  description: string,
): INodeProperties {
  return locator({
    name: "campaign",
    displayName: "Campaign",
    searchListMethod,
    placeholder: "e.g. 0199e1b3-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
    description,
    displayOptions: show(R, operations),
  });
}

export const campaignFields: INodeProperties[] = [
  // Create.
  locator({
    name: "segment",
    displayName: "Segment",
    searchListMethod: "searchSegments",
    placeholder: "e.g. 78261eea-8f8b-4381-83c6-79fa7120f1cf",
    description: "Who receives it",
    displayOptions: show(R, ["create"]),
  }),
  fromLocator(show(R, ["create"]), true),
  {
    displayName: "Subject",
    name: "subject",
    type: "string",
    default: "",
    required: true,
    displayOptions: show(R, ["create"]),
  },
  {
    displayName: "Content",
    name: "content",
    type: "options",
    default: "written",
    options: [
      { name: "Write It Here", value: "written" },
      { name: "Copy a Template", value: "template" },
    ],
    displayOptions: show(R, ["create"]),
  },
  locator({
    name: "template",
    displayName: "Template",
    searchListMethod: "searchPublishedTemplates",
    placeholder: "e.g. 0199d2f1-4c4e-7a20-9c31-6f2b8a0e5d17",
    description: "A published template, whose content is copied into the campaign",
    displayOptions: { show: { resource: [R], operation: ["create"], content: ["template"] } },
  }),
  {
    displayName: "HTML",
    name: "html",
    type: "string",
    typeOptions: { rows: 5 },
    default: "",
    description: "The HTML version. Give HTML, text, or both.",
    displayOptions: { show: { resource: [R], operation: ["create"], content: ["written"] } },
  },
  {
    displayName: "Text",
    name: "text",
    type: "string",
    typeOptions: { rows: 5 },
    default: "",
    description: "The plain-text version",
    displayOptions: { show: { resource: [R], operation: ["create"], content: ["written"] } },
  },
  {
    displayName: "Send Now",
    name: "sendNow",
    type: "boolean",
    default: false,
    description: "Whether to send it as soon as it is created, instead of keeping it as a draft",
    displayOptions: show(R, ["create"]),
  },
  {
    displayName: "Options",
    name: "options",
    type: "collection",
    placeholder: "Add Option",
    default: {},
    displayOptions: show(R, ["create"]),
    options: [
      {
        displayName: "Name",
        name: "name",
        type: "string",
        default: "",
        description: "Only you see it",
      },
      {
        displayName: "Preview Text",
        name: "previewText",
        type: "string",
        default: "",
        description: "The line inboxes show after the subject",
      },
      {
        displayName: "Reply-To",
        name: "replyTo",
        type: "string",
        default: "",
        placeholder: "e.g. support@example.com",
        description: "Comma-separated addresses",
      },
      { ...ACKNOWLEDGE_CHECKS_OPTION, displayOptions: { show: { "/sendNow": [true] } } },
      {
        displayName: "Topic Name or ID",
        name: "topic",
        type: "options",
        typeOptions: { loadOptionsMethod: "getEmailTopics" },
        default: "",
        description:
          'Send only to contacts subscribed to this topic. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
    ],
  },

  // Send, Send Test, Cancel, Get.
  campaignLocator(["send", "sendTest"], "searchDraftCampaigns", "A draft campaign"),
  campaignLocator(
    ["cancel"],
    "searchPendingCampaigns",
    "A scheduled campaign, or one that is sending",
  ),
  campaignLocator(["get"], "searchCampaigns", "One of your campaigns"),
  {
    displayName: "Options",
    name: "sendOptions",
    type: "collection",
    placeholder: "Add Option",
    default: {},
    displayOptions: show(R, ["send"]),
    options: [
      {
        displayName: "Send At",
        name: "sendAt",
        type: "dateTime",
        default: "",
        description:
          "When to send it, in the workflow's time zone unless the value carries an offset. Leave empty to send now.",
      },
      ACKNOWLEDGE_CHECKS_OPTION,
    ],
  },
  {
    displayName: "To",
    name: "to",
    type: "string",
    default: "",
    required: true,
    placeholder: "e.g. nathan@example.com",
    description: "One to five comma-separated addresses",
    displayOptions: show(R, ["sendTest"]),
  },
  {
    displayName: "Options",
    name: "testOptions",
    type: "collection",
    placeholder: "Add Option",
    default: {},
    displayOptions: show(R, ["sendTest"]),
    options: [IDEMPOTENCY_KEY_OPTION],
  },

  // Get Many.
  ...returnAllAndLimit(R),
  {
    displayName: "Filters",
    name: "filters",
    type: "collection",
    placeholder: "Add Filter",
    default: {},
    displayOptions: show(R, ["getAll"]),
    options: [
      {
        displayName: "Search",
        name: "search",
        type: "string",
        default: "",
        placeholder: "e.g. November",
        description: "Campaigns whose name contains this text",
      },
      {
        displayName: "Status",
        name: "status",
        type: "options",
        default: "sent",
        options: [
          { name: "Canceled", value: "canceled" },
          { name: "Draft", value: "draft" },
          { name: "Failed", value: "failed" },
          { name: "Queued", value: "queued" },
          { name: "Scheduled", value: "scheduled" },
          { name: "Sending", value: "sending" },
          { name: "Sent", value: "sent" },
        ],
      },
    ],
  },
  simplifyParameter(R, ["get", "getAll"]),
];

/** `POST /broadcasts`: a template's content is copied into the campaign, or the bodies given. */
const create: Operation = async function (itemIndex) {
  const options = this.getNodeParameter("options", itemIndex, {});
  const content = this.getNodeParameter("content", itemIndex, "written") as string;
  const sendNow = booleanValue(this.getNodeParameter("sendNow", itemIndex, false)) === true;
  let bodies: IDataObject;
  if (content === "template") {
    bodies = { template: { id: requiredLocator(this, "template", "Template", itemIndex) } };
  } else {
    const html = optionalText(this.getNodeParameter("html", itemIndex, ""));
    const text = optionalText(this.getNodeParameter("text", itemIndex, ""));
    if (html === undefined && text === undefined) {
      throw new NodeOperationError(this.getNode(), "The campaign has no content", {
        itemIndex,
        description: "Fill in 'HTML', 'Text', or both, or pick a template to copy.",
      });
    }
    bodies = { html, text };
  }
  const body = defined({
    name: optionalText(options.name),
    segment_id: requiredLocator(this, "segment", "Segment", itemIndex),
    from: requiredLocator(this, "from", "From", itemIndex),
    subject: requiredString(this, "subject", "Subject", itemIndex),
    preview_text: optionalText(options.previewText),
    reply_to: addressList(options.replyTo),
    topic_id: optionalText(options.topic),
    ...bodies,
    ...(sendNow ? { send: true, ...acknowledgeChecks(options) } : {}),
  });
  const created = await rasketRequest(this, {
    method: "POST",
    path: "/broadcasts",
    body,
    itemIndex,
  });
  return { ...created, sent: sendNow };
};

const send: Operation = async function (itemIndex) {
  const id = requiredLocator(this, "campaign", "Campaign", itemIndex);
  const options = this.getNodeParameter("sendOptions", itemIndex, {}) as IDataObject;
  const scheduledAt = zonedInstant(this, options.sendAt);
  const sent = await rasketRequest(this, {
    method: "POST",
    path: `/broadcasts/${segment(id)}/send`,
    body: {
      ...(scheduledAt === undefined ? {} : { scheduled_at: scheduledAt }),
      ...acknowledgeChecks(options),
    },
    itemIndex,
  });
  return { id, ...sent, scheduled_at: scheduledAt ?? null };
};

const sendTest: Operation = async function (itemIndex) {
  const id = requiredLocator(this, "campaign", "Campaign", itemIndex);
  const to = addressList(this.getNodeParameter("to", itemIndex, "")) ?? [];
  const options = this.getNodeParameter("testOptions", itemIndex, {}) as IDataObject;
  const headers = idempotencyHeader(this, options.idempotencyKey, itemIndex);
  const response = await rasketRequest(this, {
    method: "POST",
    path: `/broadcasts/${segment(id)}/test`,
    body: { to },
    ...(headers === undefined ? {} : { headers }),
    itemIndex,
  });
  return { campaign_id: id, ...response };
};

/** `409 resource_locked` (the campaign is being claimed right now) is waited out once. */
const cancel: Operation = async function (itemIndex) {
  const id = requiredLocator(this, "campaign", "Campaign", itemIndex);
  const request = { method: "POST" as const, path: `/broadcasts/${segment(id)}/cancel`, itemIndex };
  let response = await rasketRawRequest(this, request);
  if (isLocked(response.statusCode, response.body)) {
    await timing.sleep(2000);
    response = await rasketRawRequest(this, request);
  }
  if (response.statusCode >= 400) throw rasketError(this, response, itemIndex);
  return { id, ...response.body, canceled: true };
};

/** Get's record has the content; a Get Many row (`ListBroadcastsItem`) has no subject or sender. */
function simplified(
  context: IExecuteFunctions,
  itemIndex: number,
  rows: IDataObject[],
  simplify: (row: IDataObject) => IDataObject,
) {
  return (context.getNodeParameter("simplify", itemIndex, true) as boolean)
    ? rows.map(simplify)
    : rows;
}

const get: Operation = async function (itemIndex) {
  const id = requiredLocator(this, "campaign", "Campaign", itemIndex);
  const campaign = await rasketRequest(this, { path: `/broadcasts/${segment(id)}`, itemIndex });
  return simplified(this, itemIndex, [campaign], simplifyCampaign);
};

const getAll: Operation = async function (itemIndex) {
  const filters = this.getNodeParameter("filters", itemIndex, {});
  const rows = await rasketList(
    this,
    {
      path: "/broadcasts",
      qs: defined({ status: optionalText(filters.status), search: optionalText(filters.search) }),
      itemIndex,
    },
    readLimit(this, itemIndex),
  );
  return simplified(this, itemIndex, rows, simplifyCampaignRow);
};

export const campaignExecute: Record<string, Operation> = {
  create,
  send,
  sendTest,
  cancel,
  get,
  getAll,
};
