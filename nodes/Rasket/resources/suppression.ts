import type { INodeProperties } from "n8n-workflow";

import {
  defined,
  type Operation,
  optionalText,
  readLimit,
  requiredString,
  returnAllAndLimit,
  show,
} from "../shared";
import { rasketError, rasketList, rasketRawRequest, rasketRequest, segment } from "../transport";

/**
 * The suppression list: addresses Rasket sends nothing to. Adding twice is harmless (the earlier
 * row is kept), and removing an address that is not there succeeds with `removed: false`.
 */

const R = "suppression";

export const suppressionOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  noDataExpression: true,
  displayOptions: { show: { resource: [R] } },
  default: "add",
  options: [
    {
      name: "Add",
      value: "add",
      action: "Add address to suppression list",
      description: "Stop Rasket from sending any email to an address",
    },
    {
      name: "Get Many",
      value: "getAll",
      action: "Get many suppressions",
      description: "Retrieve a list of suppressed addresses, such as unsubscribes",
    },
    {
      name: "Remove",
      value: "remove",
      action: "Remove address from suppression list",
      description:
        "Let Rasket send to an address again. Removing one that bounced or complained can hurt your sending reputation.",
    },
  ],
};

export const suppressionFields: INodeProperties[] = [
  {
    displayName: "Email",
    name: "email",
    type: "string",
    placeholder: "e.g. nathan@example.com",
    default: "",
    required: true,
    displayOptions: show(R, ["add", "remove"]),
  },
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
        displayName: "Reason",
        name: "origin",
        type: "options",
        default: "unsubscribe",
        description: "Why the address is suppressed",
        options: [
          { name: "Bounce", value: "bounce" },
          { name: "Complaint", value: "complaint" },
          { name: "Added by Hand", value: "manual" },
          { name: "Unsubscribe", value: "unsubscribe" },
        ],
      },
      {
        displayName: "Search",
        name: "search",
        type: "string",
        default: "",
        placeholder: "e.g. example.com",
        description: "Addresses that contain this text",
      },
    ],
  },
];

const add: Operation = async function (itemIndex) {
  const email = requiredString(this, "email", "Email", itemIndex);
  const created = await rasketRequest(this, {
    method: "POST",
    path: "/suppressions",
    body: { email },
    itemIndex,
  });
  return { email, ...created };
};

const remove: Operation = async function (itemIndex) {
  const email = requiredString(this, "email", "Email", itemIndex);
  const response = await rasketRawRequest(this, {
    method: "DELETE",
    path: `/suppressions/${segment(email)}`,
    itemIndex,
  });
  if (response.statusCode === 404) return { email, removed: false };
  if (response.statusCode >= 400) throw rasketError(this, response, itemIndex);
  return { email, removed: true };
};

const getAll: Operation = async function (itemIndex) {
  const filters = this.getNodeParameter("filters", itemIndex, {});
  return rasketList(
    this,
    {
      path: "/suppressions",
      qs: defined({ origin: optionalText(filters.origin), search: optionalText(filters.search) }),
      itemIndex,
    },
    readLimit(this, itemIndex),
  );
};

export const suppressionExecute: Record<string, Operation> = { add, remove, getAll };
