import type { IDataObject, IExecuteFunctions, INodeProperties } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import {
  addressList,
  defined,
  fromLocator,
  idempotencyHeader,
  IDEMPOTENCY_KEY_OPTION,
  isLocked,
  locator,
  locatorValue,
  mappedValues,
  MAX_RECIPIENTS,
  type Operation,
  optionalText,
  pairs,
  pairsParameter,
  readLimit,
  requiredLocator,
  requiredString,
  returnAllAndLimit,
  show,
  simplifyParameter,
  zonedInstant,
} from "../shared";
import { simplifyEmail } from "../simplify";
import {
  rasketError,
  rasketList,
  rasketRawRequest,
  rasketRequest,
  segment,
  timing,
} from "../transport";

/**
 * Emails: send one written here or from a template, schedule one, move or cancel a scheduled one,
 * and read what was sent. Every send is `POST /emails`.
 */

const R = "email";

export const emailOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  noDataExpression: true,
  displayOptions: { show: { resource: [R] } },
  default: "send",
  options: [
    {
      name: "Cancel",
      value: "cancel",
      action: "Cancel scheduled email",
      description: "Cancel a scheduled email before it is sent",
    },
    { name: "Get", value: "get", action: "Get email", description: "Retrieve an email you sent" },
    {
      name: "Get Many",
      value: "getAll",
      action: "Get many emails",
      description: "Retrieve a list of emails you sent",
    },
    {
      name: "Reschedule",
      value: "reschedule",
      action: "Reschedule email",
      description: "Move a scheduled email to a new send time",
    },
    {
      name: "Schedule",
      value: "schedule",
      action: "Schedule email",
      description: "Schedule an email to send later",
    },
    {
      name: "Send",
      value: "send",
      action: "Send email",
      description: "Send an email written here",
    },
    {
      name: "Send Template",
      value: "sendTemplate",
      action: "Send template email",
      description: "Send one of your published templates, filling in its variables",
    },
  ],
};

/** Whether this operation's email is a template (Send Template, or Schedule with a template). */
const TEMPLATE_CONTENT = {
  sendTemplate: { show: { resource: [R], operation: ["sendTemplate"] } },
  scheduleTemplate: { show: { resource: [R], operation: ["schedule"], content: ["template"] } },
};

function templateLocator(operation: "sendTemplate" | "schedule"): INodeProperties {
  return locator({
    name: "template",
    displayName: "Template",
    searchListMethod: "searchPublishedTemplates",
    placeholder: "e.g. 0199d2f1-4c4e-7a20-9c31-6f2b8a0e5d17",
    description: "A published template. Its variables appear below once it is picked.",
    displayOptions:
      operation === "sendTemplate"
        ? TEMPLATE_CONTENT.sendTemplate
        : TEMPLATE_CONTENT.scheduleTemplate,
  });
}

function variablesMapper(operation: "sendTemplate" | "schedule"): INodeProperties {
  return {
    displayName: "Variables",
    name: "variables",
    type: "resourceMapper",
    noDataExpression: true,
    default: { mappingMode: "defineBelow", value: null },
    required: true,
    typeOptions: {
      loadOptionsDependsOn: ["template.value"],
      resourceMapper: {
        resourceMapperMethod: "getTemplateVariables",
        mode: "add",
        fieldWords: { singular: "variable", plural: "variables" },
        addAllFields: true,
        multiKeyMatch: false,
        supportAutoMap: false,
        noFieldsError: "This template has no variables, or no published version yet.",
      },
    },
    displayOptions:
      operation === "sendTemplate"
        ? TEMPLATE_CONTENT.sendTemplate
        : TEMPLATE_CONTENT.scheduleTemplate,
  };
}

const writtenContent = (operations: string[], extra: Record<string, string[]> = {}) => ({
  show: { resource: [R], operation: operations, ...extra },
});

const SEND_AT: Omit<INodeProperties, "displayOptions"> = {
  displayName: "Send At",
  name: "sendAt",
  type: "dateTime",
  default: "",
  required: true,
  description:
    "When to send it, up to 30 days ahead, in the workflow's time zone unless the value carries an offset",
};

const SCHEDULED_EMAIL = (operations: string[]): INodeProperties =>
  locator({
    name: "emailId",
    displayName: "Email",
    searchListMethod: "searchScheduledEmails",
    placeholder: "e.g. 4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    description: "A scheduled email",
    displayOptions: show(R, operations),
  });

function sendOptions(operations: string[], templateOperation: boolean): INodeProperties {
  return {
    displayName: "Options",
    name: "options",
    type: "collection",
    placeholder: "Add Option",
    default: {},
    displayOptions: show(R, operations),
    options: [
      {
        displayName: "BCC",
        name: "bcc",
        type: "string",
        default: "",
        placeholder: "e.g. nathan@example.com",
        description: "Comma-separated addresses",
      },
      {
        displayName: "CC",
        name: "cc",
        type: "string",
        default: "",
        placeholder: "e.g. nathan@example.com",
        description: "Comma-separated addresses",
      },
      IDEMPOTENCY_KEY_OPTION,
      {
        displayName: "Reply-To",
        name: "replyTo",
        type: "string",
        default: "",
        placeholder: "e.g. support@example.com",
        description: "Comma-separated addresses",
      },
      ...(templateOperation
        ? [
            {
              displayName: "Subject",
              name: "subject",
              type: "string" as const,
              default: "",
              description: "Overrides the subject the template sets",
            },
          ]
        : []),
      {
        ...pairsParameter({
          name: "tags",
          displayName: "Tags",
          placeholder: "Add Tag",
          description:
            "Name/value pairs stored on the email and sent back on its webhook events, e.g. invoice = 1042",
        }),
      },
    ],
  };
}

export const emailFields: INodeProperties[] = [
  // Schedule: when, then what.
  { ...SEND_AT, displayOptions: show(R, ["schedule"]) },
  {
    displayName: "Content",
    name: "content",
    type: "options",
    default: "written",
    options: [
      { name: "Write It Here", value: "written" },
      { name: "Use a Template", value: "template" },
    ],
    displayOptions: show(R, ["schedule"]),
  },
  templateLocator("sendTemplate"),
  templateLocator("schedule"),
  fromLocator(writtenContent(["send"]), true),
  fromLocator(writtenContent(["schedule"], { content: ["written"] }), true),
  fromLocator(TEMPLATE_CONTENT.sendTemplate, false),
  fromLocator(TEMPLATE_CONTENT.scheduleTemplate, false),
  {
    displayName: "To",
    name: "to",
    type: "string",
    default: "",
    required: true,
    placeholder: "e.g. nathan@example.com",
    description: `Comma-separated addresses, up to ${String(MAX_RECIPIENTS)}`,
    displayOptions: show(R, ["send", "sendTemplate", "schedule"]),
  },
  {
    displayName: "Subject",
    name: "subject",
    type: "string",
    default: "",
    required: true,
    displayOptions: writtenContent(["send"]),
  },
  {
    displayName: "Subject",
    name: "subject",
    type: "string",
    default: "",
    required: true,
    displayOptions: writtenContent(["schedule"], { content: ["written"] }),
  },
  {
    displayName: "HTML",
    name: "html",
    type: "string",
    typeOptions: { rows: 5 },
    default: "",
    description: "The HTML version. Give HTML, text, or both.",
    displayOptions: writtenContent(["send"]),
  },
  {
    displayName: "HTML",
    name: "html",
    type: "string",
    typeOptions: { rows: 5 },
    default: "",
    description: "The HTML version. Give HTML, text, or both.",
    displayOptions: writtenContent(["schedule"], { content: ["written"] }),
  },
  {
    displayName: "Text",
    name: "text",
    type: "string",
    typeOptions: { rows: 5 },
    default: "",
    description: "The plain-text version",
    displayOptions: writtenContent(["send"]),
  },
  {
    displayName: "Text",
    name: "text",
    type: "string",
    typeOptions: { rows: 5 },
    default: "",
    description: "The plain-text version",
    displayOptions: writtenContent(["schedule"], { content: ["written"] }),
  },
  variablesMapper("sendTemplate"),
  variablesMapper("schedule"),
  sendOptions(["send"], false),
  sendOptions(["sendTemplate"], true),
  sendOptions(["schedule"], false),

  // Reschedule and Cancel.
  SCHEDULED_EMAIL(["reschedule", "cancel"]),
  { ...SEND_AT, displayName: "New Send At", displayOptions: show(R, ["reschedule"]) },

  // Get.
  {
    displayName: "Email ID",
    name: "emailId",
    type: "string",
    default: "",
    required: true,
    placeholder: "e.g. 4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    description: "The ID a send returned, or one from an email event",
    displayOptions: show(R, ["get"]),
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
        placeholder: "e.g. invoice",
        description: "Emails whose recipient or subject contains this text",
      },
      {
        displayName: "Status",
        name: "status",
        type: "options",
        default: "delivered",
        description: "The email's latest event",
        options: [
          { name: "Bounced", value: "bounced" },
          { name: "Canceled", value: "canceled" },
          { name: "Clicked", value: "clicked" },
          { name: "Complained", value: "complained" },
          { name: "Delivered", value: "delivered" },
          { name: "Delivery Delayed", value: "delivery_delayed" },
          { name: "Failed", value: "failed" },
          { name: "Opened", value: "opened" },
          { name: "Queued", value: "queued" },
          { name: "Scheduled", value: "scheduled" },
          { name: "Sent", value: "sent" },
          { name: "Suppressed", value: "suppressed" },
        ],
      },
    ],
  },
  simplifyParameter(R, ["get", "getAll"]),
];

/** The fields every send shares: recipients, the extra addresses and the tags. */
function envelope(context: IExecuteFunctions, itemIndex: number): IDataObject {
  const options = context.getNodeParameter("options", itemIndex, {});
  const to = addressList(context.getNodeParameter("to", itemIndex, ""));
  if (to === undefined) {
    throw new NodeOperationError(context.getNode(), "The 'To' parameter is empty", {
      itemIndex,
      description: "Give at least one recipient address.",
    });
  }
  if (to.length > MAX_RECIPIENTS) {
    throw new NodeOperationError(
      context.getNode(),
      `The email has ${String(to.length)} recipients`,
      {
        itemIndex,
        description: `Rasket sends to at most ${String(MAX_RECIPIENTS)} recipients per email. Split them over several items.`,
      },
    );
  }
  const tags = pairs(options.tags);
  return {
    to,
    cc: addressList(options.cc),
    bcc: addressList(options.bcc),
    reply_to: addressList(options.replyTo),
    tags:
      tags === undefined
        ? undefined
        : Object.entries(tags).map(([name, value]) => ({ name, value })),
  };
}

function writtenBody(context: IExecuteFunctions, itemIndex: number): IDataObject {
  const html = optionalText(context.getNodeParameter("html", itemIndex, ""));
  const text = optionalText(context.getNodeParameter("text", itemIndex, ""));
  if (html === undefined && text === undefined) {
    throw new NodeOperationError(context.getNode(), "The email has no content", {
      itemIndex,
      description: "Fill in 'HTML', 'Text', or both.",
    });
  }
  return {
    from: requiredLocator(context, "from", "From", itemIndex),
    subject: requiredString(context, "subject", "Subject", itemIndex),
    html,
    text,
  };
}

/**
 * Template variables as `POST /emails` takes them: text or numbers only. The API reads `"true"` and
 * `"false"` for a boolean variable and a JSON string for an object or list one, so the resource
 * mapper's booleans, objects and arrays are written out that way rather than refused.
 */
function variableValues(values: Record<string, unknown>): IDataObject {
  const out: IDataObject = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" || typeof value === "number") out[key] = value;
    else if (typeof value === "boolean") out[key] = String(value);
    else if (typeof value === "object" && value !== null) out[key] = JSON.stringify(value);
  }
  return out;
}

function templateBody(
  context: IExecuteFunctions,
  itemIndex: number,
  subject?: unknown,
): IDataObject {
  const id = requiredLocator(context, "template", "Template", itemIndex);
  const variables = variableValues(mappedValues(context, "variables", itemIndex));
  const from = locatorValue(context, "from", itemIndex);
  return {
    from: from === "" ? undefined : from,
    subject: optionalText(subject),
    template: { id, ...(Object.keys(variables).length === 0 ? {} : { variables }) },
  };
}

async function postEmail(
  context: IExecuteFunctions,
  itemIndex: number,
  body: IDataObject,
): Promise<IDataObject> {
  const options = context.getNodeParameter("options", itemIndex, {});
  const headers = idempotencyHeader(context, options.idempotencyKey, itemIndex);
  return rasketRequest(context, {
    method: "POST",
    path: "/emails",
    body: defined(body),
    ...(headers === undefined ? {} : { headers }),
    itemIndex,
  });
}

/**
 * Send At as the ISO instant the API takes: an offsetless time is the workflow's time zone's
 * (`zonedInstant`), and a blank one names the parameter.
 */
function sendAt(context: IExecuteFunctions, itemIndex: number): string {
  const raw: unknown = context.getNodeParameter("sendAt", itemIndex, "");
  return zonedInstant(context, raw) ?? requiredString(context, "sendAt", "Send At", itemIndex);
}

/**
 * A request on a scheduled email that may be mid-claim: `409 resource_locked` is waited out once
 * (two seconds), since a moment later the answer is final either way.
 */
async function onScheduledEmail(
  context: IExecuteFunctions,
  itemIndex: number,
  request: { method: "PATCH" | "POST"; path: string; body?: IDataObject },
) {
  let response = await rasketRawRequest(context, { ...request, itemIndex });
  if (isLocked(response.statusCode, response.body)) {
    await timing.sleep(2000);
    response = await rasketRawRequest(context, { ...request, itemIndex });
  }
  return response;
}

const send: Operation = async function (itemIndex) {
  return postEmail(this, itemIndex, {
    ...writtenBody(this, itemIndex),
    ...envelope(this, itemIndex),
  });
};

const sendTemplate: Operation = async function (itemIndex) {
  const options = this.getNodeParameter("options", itemIndex, {});
  return postEmail(this, itemIndex, {
    ...templateBody(this, itemIndex, options.subject),
    ...envelope(this, itemIndex),
  });
};

const schedule: Operation = async function (itemIndex) {
  const content = this.getNodeParameter("content", itemIndex, "written") as string;
  const body =
    content === "template" ? templateBody(this, itemIndex) : writtenBody(this, itemIndex);
  const scheduledAt = sendAt(this, itemIndex);
  const sent = await postEmail(this, itemIndex, {
    ...body,
    ...envelope(this, itemIndex),
    scheduled_at: scheduledAt,
  });
  return { ...sent, scheduled_at: scheduledAt };
};

const reschedule: Operation = async function (itemIndex) {
  const id = requiredLocator(this, "emailId", "Email", itemIndex);
  const scheduledAt = sendAt(this, itemIndex);
  const response = await onScheduledEmail(this, itemIndex, {
    method: "PATCH",
    path: `/emails/${segment(id)}`,
    body: { scheduled_at: scheduledAt },
  });
  if (response.statusCode >= 400) throw rasketError(this, response, itemIndex);
  return { id, scheduled_at: scheduledAt };
};

/**
 * `POST /emails/{id}/cancel`. An email that is already canceled is `400 validation_error`, the same
 * as one already sent, so a 400 is read back: when the email's last event is `canceled`, a replayed
 * run succeeds instead of failing.
 */
const cancel: Operation = async function (itemIndex) {
  const id = requiredLocator(this, "emailId", "Email", itemIndex);
  const path = `/emails/${segment(id)}`;
  const response = await onScheduledEmail(this, itemIndex, {
    method: "POST",
    path: `${path}/cancel`,
  });
  if (response.statusCode === 400) {
    const email = await rasketRawRequest(this, { path, itemIndex });
    if (email.statusCode === 200 && email.body.last_event === "canceled") {
      return { id, canceled: true };
    }
  }
  if (response.statusCode >= 400) throw rasketError(this, response, itemIndex);
  return { id, canceled: true };
};

function simplified(context: IExecuteFunctions, itemIndex: number, rows: IDataObject[]) {
  const simplify = context.getNodeParameter("simplify", itemIndex, true) as boolean;
  return simplify ? rows.map(simplifyEmail) : rows;
}

const get: Operation = async function (itemIndex) {
  const id = requiredString(this, "emailId", "Email ID", itemIndex);
  const email = await rasketRequest(this, { path: `/emails/${segment(id)}`, itemIndex });
  return simplified(this, itemIndex, [email]);
};

const getAll: Operation = async function (itemIndex) {
  const filters = this.getNodeParameter("filters", itemIndex, {});
  const rows = await rasketList(
    this,
    {
      path: "/emails",
      qs: defined({ status: optionalText(filters.status), search: optionalText(filters.search) }),
      itemIndex,
    },
    readLimit(this, itemIndex),
  );
  return simplified(this, itemIndex, rows);
};

export const emailExecute: Record<string, Operation> = {
  send,
  sendTemplate,
  schedule,
  reschedule,
  cancel,
  get,
  getAll,
};
