import type {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  JsonObject,
} from "n8n-workflow";
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from "n8n-workflow";

import { listSearch, loadOptions, resourceMapping } from "./methods";
import { campaignExecute, campaignFields, campaignOperations } from "./resources/campaign";
import { contactExecute, contactFields, contactOperations } from "./resources/contact";
import { emailExecute, emailFields, emailOperations } from "./resources/email";
import { eventExecute, eventFields, eventOperations } from "./resources/event";
import { segmentExecute, segmentFields, segmentOperations } from "./resources/segment";
import { smsExecute, smsFields, smsOperations } from "./resources/sms";
import {
  suppressionExecute,
  suppressionFields,
  suppressionOperations,
} from "./resources/suppression";
import { templateExecute, templateFields, templateOperations } from "./resources/template";
import type { Operation } from "./shared";

/** Every resource's operations, by resource and then operation value. */
export const OPERATIONS: Record<string, Record<string, Operation>> = {
  email: emailExecute,
  contact: contactExecute,
  suppression: suppressionExecute,
  campaign: campaignExecute,
  event: eventExecute,
  template: templateExecute,
  segment: segmentExecute,
  sms: smsExecute,
};

/**
 * The Rasket node: send email and texts, manage contacts and their segments and topics, the
 * suppression list, campaigns and custom events, and read templates and segments, over the public
 * API.
 */
export class Rasket implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Rasket",
    name: "rasket",
    icon: { light: "file:rasket.svg", dark: "file:rasket.dark.svg" },
    group: ["output"],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: "Send email and texts, and manage contacts, segments and campaigns with Rasket",
    defaults: { name: "Rasket" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [{ name: "rasketApi", required: true }],
    properties: [
      {
        displayName: "Resource",
        name: "resource",
        type: "options",
        noDataExpression: true,
        default: "email",
        options: [
          { name: "Campaign", value: "campaign" },
          { name: "Contact", value: "contact" },
          { name: "Email", value: "email" },
          { name: "Event", value: "event" },
          { name: "Segment", value: "segment" },
          { name: "SMS", value: "sms" },
          { name: "Suppression", value: "suppression" },
          { name: "Template", value: "template" },
        ],
      },
      campaignOperations,
      contactOperations,
      emailOperations,
      eventOperations,
      segmentOperations,
      smsOperations,
      suppressionOperations,
      templateOperations,
      ...campaignFields,
      ...contactFields,
      ...emailFields,
      ...eventFields,
      ...segmentFields,
      ...smsFields,
      ...suppressionFields,
      ...templateFields,
    ],
  };

  methods = { listSearch, loadOptions, resourceMapping };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const resource = this.getNodeParameter("resource", itemIndex);
        const operation = this.getNodeParameter("operation", itemIndex);
        const run = OPERATIONS[resource]?.[operation];
        if (run === undefined) {
          throw new NodeOperationError(
            this.getNode(),
            `The operation '${operation}' is not supported for '${resource}'`,
            { itemIndex },
          );
        }
        const result = await run.call(this, itemIndex);
        const rows: IDataObject[] = Array.isArray(result) ? result : [result];
        for (const json of rows) {
          returnData.push({ json, pairedItem: { item: itemIndex } });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: (error as Error).message },
            pairedItem: { item: itemIndex },
          });
          continue;
        }
        // Both constructors hand back an error that is already theirs unchanged: the operations
        // build every refusal with its item index, its message and what to do about it.
        if (error instanceof NodeApiError) {
          throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex });
        }
        throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
      }
    }

    return [returnData];
  }
}
