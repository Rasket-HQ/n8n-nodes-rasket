import type { INodeProperties } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import {
  booleanValue,
  defined,
  idList,
  locator,
  mappedValues,
  type Operation,
  optionalText,
  readLimit,
  requiredLocator,
  requiredString,
  returnAllAndLimit,
  show,
} from "../shared";
import { rasketList, rasketRequest, segment } from "../transport";

/**
 * Contacts: create or update by email (an upsert), read, delete, and their segments and topics.
 * Every contact path takes an email address or a contact ID.
 *
 * Removing a contact that is not in a segment succeeds (the API answers 200). A 404 on a removal
 * or a deletion is an error: the contact or the segment does not exist, which is a typo or a wrong
 * mapping far more often than a replay, and a step that reports success then hides it.
 */

const R = "contact";

export const contactOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  noDataExpression: true,
  displayOptions: { show: { resource: [R] } },
  default: "upsert",
  options: [
    {
      name: "Add to Segment",
      value: "addToSegment",
      action: "Add contact to segment",
      description: "Add a contact to one of your segments",
    },
    {
      name: "Create or Update",
      value: "upsert",
      action: "Create or update contact",
      description: "Create a new record, or update the current one if it already exists (upsert)",
    },
    {
      name: "Delete",
      value: "delete",
      action: "Delete contact",
      description: "Delete a contact permanently",
    },
    { name: "Get", value: "get", action: "Get contact", description: "Retrieve a contact" },
    {
      name: "Get Many",
      value: "getAll",
      action: "Get many contacts",
      description: "Retrieve a list of contacts",
    },
    {
      name: "Remove From Segment",
      value: "removeFromSegment",
      action: "Remove contact from segment",
      description: "Remove a contact from one of your segments",
    },
    {
      name: "Subscribe to Topics",
      value: "subscribeToTopics",
      action: "Subscribe contact to topics",
      description: "Subscribe a contact to one or more topics",
    },
    {
      name: "Unsubscribe From Topics",
      value: "unsubscribeFromTopics",
      action: "Unsubscribe contact from topics",
      description:
        "Unsubscribe a contact from one or more topics, leaving their other topics alone",
    },
  ],
};

const CONTACT_OPERATIONS = [
  "get",
  "delete",
  "addToSegment",
  "removeFromSegment",
  "subscribeToTopics",
  "unsubscribeFromTopics",
];

export const contactFields: INodeProperties[] = [
  {
    displayName: "Email",
    name: "email",
    type: "string",
    placeholder: "e.g. nathan@example.com",
    default: "",
    required: true,
    displayOptions: show(R, ["upsert"]),
  },
  {
    displayName: "Contact",
    name: "contact",
    type: "string",
    placeholder: "e.g. nathan@example.com",
    default: "",
    required: true,
    description: "The contact's email address, or its Rasket contact ID",
    displayOptions: show(R, CONTACT_OPERATIONS),
  },
  {
    ...locator({
      name: "segment",
      displayName: "Segment",
      searchListMethod: "searchSegments",
      placeholder: "e.g. 78261eea-8f8b-4381-83c6-79fa7120f1cf",
      description:
        "One of your segments. Removing a contact keeps it out of the segment even when the segment's filter matches it, until it is added back.",
      displayOptions: show(R, ["addToSegment", "removeFromSegment"]),
    }),
  },
  {
    displayName: "Topic Names or IDs",
    name: "topics",
    type: "multiOptions",
    typeOptions: { loadOptionsMethod: "getTopics" },
    default: [],
    required: true,
    description:
      'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
    displayOptions: show(R, ["subscribeToTopics", "unsubscribeFromTopics"]),
  },
  {
    displayName: "Additional Fields",
    name: "additionalFields",
    type: "collection",
    placeholder: "Add Field",
    default: {},
    displayOptions: show(R, ["upsert"]),
    options: [
      {
        displayName: "Add to Segment Names or IDs",
        name: "segments",
        type: "multiOptions",
        typeOptions: { loadOptionsMethod: "getSegments" },
        default: [],
        description:
          'Segments to add the contact to; the ones they are in are kept. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: "First Name",
        name: "firstName",
        type: "string",
        default: "",
        placeholder: "e.g. Nathan",
      },
      {
        displayName: "Last Name",
        name: "lastName",
        type: "string",
        default: "",
        placeholder: "e.g. Smith",
      },
      {
        displayName: "Subscribe to Topic Names or IDs",
        name: "topicsOptIn",
        type: "multiOptions",
        typeOptions: { loadOptionsMethod: "getTopics" },
        default: [],
        description:
          'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
      {
        displayName: "Unsubscribe From Topic Names or IDs",
        name: "topicsOptOut",
        type: "multiOptions",
        typeOptions: { loadOptionsMethod: "getTopics" },
        default: [],
        description:
          'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
      {
        displayName: "Unsubscribed",
        name: "unsubscribed",
        type: "boolean",
        default: false,
        description:
          "Whether to unsubscribe the contact from everything. Creating or updating never resubscribes someone who opted out.",
      },
    ],
  },
  {
    displayName: "Properties",
    name: "properties",
    type: "resourceMapper",
    noDataExpression: true,
    default: { mappingMode: "defineBelow", value: null },
    typeOptions: {
      resourceMapper: {
        resourceMapperMethod: "getContactProperties",
        mode: "add",
        fieldWords: { singular: "property", plural: "properties" },
        addAllFields: false,
        multiKeyMatch: false,
        supportAutoMap: false,
        noFieldsError:
          "Your team has no contact properties yet. One appears here once a contact has a value for it.",
      },
    },
    displayOptions: show(R, ["upsert"]),
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
        displayName: "Segment Name or ID",
        name: "segment",
        type: "options",
        typeOptions: { loadOptionsMethod: "getSegments" },
        default: "",
        description:
          'Only contacts in this segment. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
    ],
  },
];

function contactPath(contact: string, suffix = ""): string {
  return `/contacts/${segment(contact)}${suffix}`;
}

/**
 * `POST /contacts`, which updates the contact that already has this address and keeps its ID.
 * Segments are only ever added, and a repeat call never resubscribes a contact who opted out.
 */
const upsert: Operation = async function (itemIndex) {
  const email = requiredString(this, "email", "Email", itemIndex);
  const fields = this.getNodeParameter("additionalFields", itemIndex, {});
  const segments = idList(fields.segments);
  const topics = [
    ...idList(fields.topicsOptIn).map((id) => ({ id, subscription: "opt_in" })),
    ...idList(fields.topicsOptOut).map((id) => ({ id, subscription: "opt_out" })),
  ];
  const properties = mappedValues(this, "properties", itemIndex);
  const body = defined({
    email,
    first_name: optionalText(fields.firstName),
    last_name: optionalText(fields.lastName),
    unsubscribed: fields.unsubscribed === undefined ? undefined : booleanValue(fields.unsubscribed),
    properties: Object.keys(properties).length === 0 ? undefined : properties,
    segments: segments.length === 0 ? undefined : segments.map((id) => ({ id })),
    topics: topics.length === 0 ? undefined : topics,
  });
  const created = await rasketRequest(this, { method: "POST", path: "/contacts", body, itemIndex });
  return { ...body, ...created };
};

const get: Operation = async function (itemIndex) {
  const contact = requiredString(this, "contact", "Contact", itemIndex);
  return rasketRequest(this, { path: contactPath(contact), itemIndex });
};

const getAll: Operation = async function (itemIndex) {
  const filters = this.getNodeParameter("filters", itemIndex, {});
  return rasketList(
    this,
    { path: "/contacts", qs: defined({ segment_id: optionalText(filters.segment) }), itemIndex },
    readLimit(this, itemIndex),
  );
};

/** A 404 is an error: the address or ID names no contact (a typo, or a wrong mapping). */
const remove: Operation = async function (itemIndex) {
  const contact = requiredString(this, "contact", "Contact", itemIndex);
  const response = await rasketRequest(this, {
    method: "DELETE",
    path: contactPath(contact),
    itemIndex,
  });
  return { contact, ...response, deleted: true };
};

/**
 * Removing a contact that is not in the segment is already a 200, so a 404 is an error either way:
 * the contact or the segment does not exist.
 */
function changeSegment(method: "POST" | "DELETE"): Operation {
  return async function (itemIndex) {
    const contact = requiredString(this, "contact", "Contact", itemIndex);
    const segmentId = requiredLocator(this, "segment", "Segment", itemIndex);
    const response = await rasketRequest(this, {
      method,
      path: contactPath(contact, `/segments/${segment(segmentId)}`),
      itemIndex,
    });
    return { contact, ...response, segment_id: segmentId, in_segment: method === "POST" };
  };
}

function changeTopics(subscription: "opt_in" | "opt_out"): Operation {
  return async function (itemIndex) {
    const contact = requiredString(this, "contact", "Contact", itemIndex);
    const topics = idList(this.getNodeParameter("topics", itemIndex, []));
    if (topics.length === 0) {
      throw new NodeOperationError(this.getNode(), "No topic is selected", {
        itemIndex,
        description: "Pick at least one topic in 'Topic Names or IDs'.",
      });
    }
    const response = await rasketRequest(this, {
      method: "PATCH",
      path: contactPath(contact, "/topics"),
      body: { topics: topics.map((id) => ({ id, subscription })) },
      itemIndex,
    });
    return { contact, ...response, topic_ids: topics, subscription };
  };
}

export const contactExecute: Record<string, Operation> = {
  upsert,
  get,
  getAll,
  delete: remove,
  addToSegment: changeSegment("POST"),
  removeFromSegment: changeSegment("DELETE"),
  subscribeToTopics: changeTopics("opt_in"),
  unsubscribeFromTopics: changeTopics("opt_out"),
};
