import type { IDataObject, INodeProperties } from "n8n-workflow";

import {
  defined,
  mappedValues,
  type Operation,
  pairs,
  pairsParameter,
  requiredString,
  show,
} from "../shared";
import { rasketRequest } from "../transport";

/**
 * Custom events: `POST /events/send`, which starts every enabled automation that listens for the
 * event. The event's declared fields come through a resource mapper; keys it does not declare are
 * accepted too, under More Data. The endpoint takes no idempotency key, so a replayed execution
 * sends the event again.
 */

const R = "event";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const eventOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  noDataExpression: true,
  displayOptions: { show: { resource: [R] } },
  default: "send",
  options: [
    {
      name: "Send",
      value: "send",
      action: "Send custom event",
      description:
        "Send a custom event for a contact, starting every automation that listens for it",
    },
  ],
};

export const eventFields: INodeProperties[] = [
  {
    displayName: "Event Name or ID",
    name: "event",
    type: "options",
    typeOptions: { loadOptionsMethod: "getEvents" },
    default: "",
    required: true,
    description:
      'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
    displayOptions: show(R, ["send"]),
  },
  {
    displayName: "Contact",
    name: "contact",
    type: "string",
    placeholder: "e.g. nathan@example.com",
    default: "",
    required: true,
    description: "The contact's email address, or its Rasket contact ID",
    displayOptions: show(R, ["send"]),
  },
  {
    displayName: "Data",
    name: "data",
    type: "resourceMapper",
    noDataExpression: true,
    default: { mappingMode: "defineBelow", value: null },
    typeOptions: {
      loadOptionsDependsOn: ["event"],
      resourceMapper: {
        resourceMapperMethod: "getEventFields",
        mode: "add",
        fieldWords: { singular: "field", plural: "fields" },
        addAllFields: true,
        multiKeyMatch: false,
        supportAutoMap: false,
        noFieldsError: "This event declares no fields. Add values under 'More Data' instead.",
      },
    },
    displayOptions: show(R, ["send"]),
  },
  {
    ...pairsParameter({
      name: "moreData",
      displayName: "More Data",
      placeholder: "Add Value",
      description: "Values the event does not declare, by name, e.g. plan = Pro",
    }),
    displayOptions: show(R, ["send"]),
  },
];

const send: Operation = async function (itemIndex) {
  const event = requiredString(this, "event", "Event Name or ID", itemIndex);
  const contact = requiredString(this, "contact", "Contact", itemIndex);
  const payload: IDataObject = {
    ...(pairs(this.getNodeParameter("moreData", itemIndex, {})) ?? {}),
    ...(mappedValues(this, "data", itemIndex) as IDataObject),
  };
  const body = defined({
    event,
    ...(UUID.test(contact) ? { contact_id: contact } : { email: contact }),
    payload: Object.keys(payload).length === 0 ? undefined : payload,
  });
  const response = await rasketRequest(this, {
    method: "POST",
    path: "/events/send",
    body,
    itemIndex,
  });
  return { event, contact, ...response };
};

export const eventExecute: Record<string, Operation> = { send };
