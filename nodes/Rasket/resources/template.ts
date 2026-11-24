import type { IDataObject, IExecuteFunctions, INodeProperties } from "n8n-workflow";

import {
  defined,
  locator,
  type Operation,
  optionalText,
  readLimit,
  requiredLocator,
  returnAllAndLimit,
  show,
  simplifyParameter,
} from "../shared";
import { simplifyTemplate, simplifyTemplateRow } from "../simplify";
import { rasketList, rasketRequest, segment } from "../transport";

/** Templates, read-only: create and edit them in Rasket, send them with Email → Send Template. */

const R = "template";

export const templateOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  noDataExpression: true,
  displayOptions: { show: { resource: [R] } },
  default: "get",
  options: [
    { name: "Get", value: "get", action: "Get template", description: "Retrieve a template" },
    {
      name: "Get Many",
      value: "getAll",
      action: "Get many templates",
      description: "Retrieve a list of templates",
    },
  ],
};

export const templateFields: INodeProperties[] = [
  locator({
    name: "template",
    displayName: "Template",
    searchListMethod: "searchTemplates",
    placeholder: "e.g. 0199d2f1-4c4e-7a20-9c31-6f2b8a0e5d17",
    description: "One of your templates",
    displayOptions: show(R, ["get"]),
  }),
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
        placeholder: "e.g. welcome",
        description: "Templates whose name or alias contains this text",
      },
      {
        displayName: "Status",
        name: "status",
        type: "options",
        default: "published",
        options: [
          { name: "Draft", value: "draft" },
          { name: "Published", value: "published" },
        ],
      },
    ],
  },
  simplifyParameter(R, ["get", "getAll"]),
];

/** Get's record has the content; a Get Many row (`TemplateListItem`) has none. */
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
  const id = requiredLocator(this, "template", "Template", itemIndex);
  const template = await rasketRequest(this, { path: `/templates/${segment(id)}`, itemIndex });
  return simplified(this, itemIndex, [template], simplifyTemplate);
};

const getAll: Operation = async function (itemIndex) {
  const filters = this.getNodeParameter("filters", itemIndex, {});
  const rows = await rasketList(
    this,
    {
      path: "/templates",
      qs: defined({ status: optionalText(filters.status), search: optionalText(filters.search) }),
      itemIndex,
    },
    readLimit(this, itemIndex),
  );
  return simplified(this, itemIndex, rows, simplifyTemplateRow);
};

export const templateExecute: Record<string, Operation> = { get, getAll };
