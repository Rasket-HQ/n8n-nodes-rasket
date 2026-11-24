import type { INodeProperties } from "n8n-workflow";

import {
  defined,
  IDEMPOTENCY_KEY_OPTION,
  idempotencyHeader,
  optionalText,
  type Operation,
  requiredString,
  show,
} from "../shared";
import { rasketRequest, segment } from "../transport";

/**
 * Texts: `POST /sms` and `GET /sms/{id}` (D56). US and Canadian phones only, from one of the
 * team's numbers (before one is approved, only to the team's own verified phones); each text is billed per message (160 characters, or 70 with an emoji).
 * The field is `text`, never `body`. The API key needs SMS access (A512): Send only to send, Read
 * or Send and manage to read.
 */

const R = "sms";

export const smsOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  noDataExpression: true,
  displayOptions: { show: { resource: [R] } },
  default: "send",
  options: [
    {
      name: "Get",
      value: "get",
      action: "Get a text",
      description: "Retrieve a text with its status, messages and cost",
    },
    {
      name: "Send",
      value: "send",
      action: "Send a text",
      description: "Send a text to a US or Canadian phone",
    },
  ],
};

export const smsFields: INodeProperties[] = [
  {
    displayName: "To",
    name: "to",
    type: "string",
    placeholder: "e.g. +14155550123",
    default: "",
    required: true,
    description: "The phone, in E.164 form: a plus sign, the country code and the number",
    displayOptions: show(R, ["send"]),
  },
  {
    displayName: "Text",
    name: "text",
    type: "string",
    typeOptions: { rows: 3 },
    default: "",
    required: true,
    description:
      "Up to 160 characters is one message, or 70 with an emoji or another special character; a longer text is billed as several",
    displayOptions: show(R, ["send"]),
  },
  {
    displayName: "Options",
    name: "options",
    type: "collection",
    placeholder: "Add Option",
    default: {},
    displayOptions: show(R, ["send"]),
    options: [
      {
        displayName: "Category",
        name: "category",
        type: "options",
        default: "transactional",
        options: [
          { name: "Transactional", value: "transactional" },
          { name: "Marketing", value: "marketing" },
        ],
        description:
          "A marketing text needs the contact's SMS consent and waits for daytime hours where they are",
      },
      {
        displayName: "From",
        name: "from",
        type: "string",
        default: "",
        placeholder: "e.g. +18335550199",
        description:
          "One of your approved numbers, or its ID. Leave empty for your number for that country.",
      },
      {
        ...IDEMPOTENCY_KEY_OPTION,
        description:
          "Map something unique, such as an ID from your trigger. A second send with the same key within 24 hours returns the first text instead of sending again.",
      },
    ],
  },
  {
    displayName: "Text ID",
    name: "smsId",
    type: "string",
    default: "",
    required: true,
    description: "The ID Send returned",
    displayOptions: show(R, ["get"]),
  },
];

const send: Operation = async function (itemIndex) {
  const to = requiredString(this, "to", "To", itemIndex);
  const text = requiredString(this, "text", "Text", itemIndex);
  const options = this.getNodeParameter("options", itemIndex, {});
  const headers = idempotencyHeader(this, options.idempotencyKey, itemIndex);
  return rasketRequest(this, {
    method: "POST",
    path: "/sms",
    body: defined({
      to,
      text,
      from: optionalText(options.from),
      category: optionalText(options.category),
    }),
    ...(headers === undefined ? {} : { headers }),
    itemIndex,
  });
};

const get: Operation = async function (itemIndex) {
  const id = requiredString(this, "smsId", "Text ID", itemIndex);
  return rasketRequest(this, { path: `/sms/${segment(id)}`, itemIndex });
};

export const smsExecute: Record<string, Operation> = { get, send };
