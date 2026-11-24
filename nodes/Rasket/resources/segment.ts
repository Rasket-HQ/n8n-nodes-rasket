import type { INodeProperties } from "n8n-workflow";

import {
  locator,
  type Operation,
  readLimit,
  requiredLocator,
  returnAllAndLimit,
  show,
} from "../shared";
import { rasketList, rasketRequest, segment } from "../transport";

/** Segments, read-only: build them in Rasket, add contacts with Contact → Add to Segment. */

const R = "segment";

export const segmentOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  noDataExpression: true,
  displayOptions: { show: { resource: [R] } },
  default: "get",
  options: [
    { name: "Get", value: "get", action: "Get segment", description: "Retrieve a segment" },
    {
      name: "Get Many",
      value: "getAll",
      action: "Get many segments",
      description: "Retrieve a list of segments",
    },
  ],
};

export const segmentFields: INodeProperties[] = [
  locator({
    name: "segment",
    displayName: "Segment",
    searchListMethod: "searchSegments",
    placeholder: "e.g. 78261eea-8f8b-4381-83c6-79fa7120f1cf",
    description: "One of your segments",
    displayOptions: show(R, ["get"]),
  }),
  ...returnAllAndLimit(R),
];

const get: Operation = async function (itemIndex) {
  const id = requiredLocator(this, "segment", "Segment", itemIndex);
  return rasketRequest(this, { path: `/segments/${segment(id)}`, itemIndex });
};

const getAll: Operation = async function (itemIndex) {
  return rasketList(this, { path: "/segments", itemIndex }, readLimit(this, itemIndex));
};

export const segmentExecute: Record<string, Operation> = { get, getAll };
