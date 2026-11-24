import type {
  IDataObject,
  IHookFunctions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
  JsonObject,
} from "n8n-workflow";
import { NodeApiError, NodeConnectionTypes } from "n8n-workflow";

import {
  rasketError,
  rasketRawRequest,
  type RasketResponse,
  readErrorBody,
  segment,
} from "../Rasket/transport";

import { signatureHeaders, verifySignature } from "./signature";

/**
 * Starts a workflow when something happens in Rasket. Activating the workflow creates one Rasket
 * webhook endpoint pointed at n8n's URL for the chosen events (`POST /webhooks`); deactivating it
 * deletes the endpoint. Every delivery's signature is checked against the endpoint's signing
 * secret, which only this node holds (in the workflow's static data).
 *
 * Rasket returns the plaintext secret only from `POST /webhooks` and
 * `POST /webhooks/{id}/rotate-secret`; `GET /webhooks/{id}` masks it (`whsec_••••••••` and the
 * last four characters). So the node never stores what GET says. It compares the mask's last four
 * characters with its own secret's, and rotates when they differ.
 *
 * Each active workflow with a Rasket Trigger uses one webhook endpoint of the plan's allowance, and
 * so does listening for a test event while it runs.
 */

/** Every event `POST /webhooks` accepts, labelled the way the dashboard says them. */
export const EVENTS = [
  { name: "Automation Run Completed", value: "automation.run.completed" },
  { name: "Automation Run Failed or Stopped", value: "automation.run.failed" },
  { name: "Automation Run Started", value: "automation.run.started" },
  { name: "Autopilot Proposal Approved", value: "autopilot.proposal.approved" },
  { name: "Autopilot Proposal Created", value: "autopilot.proposal.created" },
  { name: "Autopilot Proposal Expired", value: "autopilot.proposal.expired" },
  { name: "Autopilot Proposal Sent", value: "autopilot.proposal.sent" },
  { name: "Autopilot Proposal Skipped", value: "autopilot.proposal.skipped" },
  { name: "Contact Created", value: "contact.created" },
  { name: "Contact Deleted", value: "contact.deleted" },
  { name: "Contact Unsubscribed From Texts", value: "contact.sms_unsubscribed" },
  { name: "Contact Updated", value: "contact.updated" },
  { name: "Domain Created", value: "domain.created" },
  { name: "Domain Deleted", value: "domain.deleted" },
  { name: "Domain Updated", value: "domain.updated" },
  { name: "Email Bounced", value: "email.bounced" },
  { name: "Email Canceled", value: "email.canceled" },
  { name: "Email Delivered", value: "email.delivered" },
  { name: "Email Delivery Delayed", value: "email.delivery_delayed" },
  { name: "Email Failed", value: "email.failed" },
  { name: "Email Link Clicked", value: "email.clicked" },
  { name: "Email Marked as Spam", value: "email.complained" },
  { name: "Email Opened", value: "email.opened" },
  { name: "Email Received", value: "email.received" },
  { name: "Email Scheduled", value: "email.scheduled" },
  { name: "Email Sent", value: "email.sent" },
  { name: "Email Suppressed", value: "email.suppressed" },
  { name: "Inbox Conversation Assigned", value: "inbox.conversation.assigned" },
  { name: "Inbox Conversation Created", value: "inbox.conversation.created" },
  { name: "Inbox Conversation Status Changed", value: "inbox.conversation.status_changed" },
  { name: "Inbox Message Received", value: "inbox.message.received" },
  { name: "Inbox Note Added", value: "inbox.note.created" },
  { name: "Inbox Reply Sent", value: "inbox.reply.sent" },
  { name: "SMS Delivered", value: "sms.delivered" },
  { name: "SMS Failed", value: "sms.failed" },
  { name: "SMS Queued", value: "sms.queued" },
  { name: "SMS Received", value: "sms.received" },
  { name: "SMS Sent", value: "sms.sent" },
  { name: "Suppression Added", value: "suppression.added" },
  { name: "Suppression Removed", value: "suppression.removed" },
];

const KNOWN_EVENTS: ReadonlySet<string> = new Set(EVENTS.map((event) => event.value));

/** What the node keeps per webhook URL: n8n's test and production URLs each get their own. */
interface EndpointRecord extends IDataObject {
  id: string;
  secret: string;
}

type Context = IHookFunctions | IWebhookFunctions;

/** What `GET /webhooks/{id}` shows instead of the secret: the prefix, bullets, the last four. */
function isMask(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("whsec_") && value.includes("•");
}

function lastFour(secret: string): string {
  return secret.slice(-4);
}

/**
 * Whether the stored secret has to be replaced: it is missing, it is itself a mask (0.2.x stored
 * the masked GET value after a restart), or Rasket's mask ends differently, so the secret was
 * rotated somewhere else. A GET value that is not a recognisable mask says nothing either way.
 */
function needsRotation(stored: unknown, remote: unknown): boolean {
  if (typeof stored !== "string" || stored === "" || isMask(stored)) return true;
  return isMask(remote) && lastFour(remote) !== lastFour(stored);
}

function endpoints(context: Context): Record<string, EndpointRecord> {
  const data = context.getWorkflowStaticData("node");
  if (typeof data.endpoints !== "object" || data.endpoints === null) data.endpoints = {};
  return data.endpoints as Record<string, EndpointRecord>;
}

function webhookUrl(context: Context): string {
  return context.getNodeWebhookUrl("default") ?? "";
}

/** The events picked, known ones only, de-duplicated and sorted. */
export function chosenEvents(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const known = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => KNOWN_EVENTS.has(item));
  return [...new Set(known)].sort();
}

/**
 * `POST /webhooks`' two refusals a user can act on: the plan's endpoint allowance, and a URL Rasket
 * will not deliver to (Rasket only delivers to public https addresses, which a local or plain-http
 * n8n is not).
 */
function createError(
  context: IHookFunctions,
  response: RasketResponse<unknown>,
  url: string,
): NodeApiError {
  const body = readErrorBody(response.body);
  if (response.statusCode === 422 && body?.message?.startsWith("Webhook endpoint limit") === true) {
    return new NodeApiError(context.getNode(), body as JsonObject, {
      message: body.errors?.[0]?.message ?? "Your plan's webhook endpoint limit is reached",
      description:
        "Each active workflow with a Rasket Trigger uses one webhook endpoint, and so does listening for a test event. Delete endpoints you no longer use in Rasket → Webhooks, or upgrade your plan.",
      httpCode: "422",
    });
  }
  if (
    response.statusCode === 422 &&
    body?.message?.startsWith("endpoint must be a public https URL") === true
  ) {
    return new NodeApiError(context.getNode(), body as JsonObject, {
      message: `Rasket can't deliver to ${url}`,
      description:
        "Rasket only sends webhooks to a public https address. Run n8n behind a public https URL and set n8n's WEBHOOK_URL to it, or use n8n Cloud.",
      httpCode: "422",
    });
  }
  return rasketError(context, response);
}

export class RasketTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Rasket Trigger",
    name: "rasketTrigger",
    icon: { light: "file:rasket.svg", dark: "file:rasket.dark.svg" },
    group: ["trigger"],
    version: 1,
    subtitle: '={{$parameter["events"].join(", ")}}',
    description:
      "Starts the workflow when emails, texts, contacts, inbox conversations, domains, suppressions or automation runs change in Rasket",
    defaults: { name: "Rasket Trigger" },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "rasketApi", required: true }],
    webhooks: [
      {
        name: "default",
        httpMethod: "POST",
        responseMode: "onReceived",
        path: "webhook",
      },
    ],
    properties: [
      {
        displayName: "Events",
        name: "events",
        type: "multiOptions",
        required: true,
        default: [],
        description:
          "The events that start the workflow. Inbox events need an API key with Inbox access Read or Read and reply, and no channel limit.",
        options: EVENTS,
      },
    ],
  };

  webhookMethods = {
    default: {
      /**
       * Whether this URL's endpoint still exists. n8n asks on every activation, a restart or an
       * upgrade included. It also brings the endpoint up to date: a changed event selection is
       * patched in, then the secret is rotated if this node no longer holds the one Rasket signs
       * with (see `needsRotation`). The PATCH goes first, so a refused one (Inbox events need an
       * Inbox-access key) leaves the secret alone. Rotating keeps the previous secret valid for 24
       * hours, so deliveries already on their way still verify.
       */
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const url = webhookUrl(this);
        const records = endpoints(this);
        const record = records[url];
        if (record === undefined) return false;

        const response = await rasketRawRequest(this, { path: `/webhooks/${segment(record.id)}` });
        if (response.statusCode === 404) {
          delete records[url];
          return false;
        }
        if (response.statusCode >= 400) throw rasketError(this, response);
        if (response.body.endpoint !== url) {
          delete records[url];
          return false;
        }

        const wanted = chosenEvents(this.getNodeParameter("events", []));
        const current = chosenEvents(response.body.events);
        if (wanted.join(",") !== current.join(",")) {
          const patched = await rasketRawRequest(this, {
            method: "PATCH",
            path: `/webhooks/${segment(record.id)}`,
            body: { events: wanted },
          });
          if (patched.statusCode >= 400) throw rasketError(this, patched);
        }

        if (needsRotation(record.secret, response.body.signing_secret)) {
          const rotated = await rasketRawRequest(this, {
            method: "POST",
            path: `/webhooks/${segment(record.id)}/rotate-secret`,
          });
          if (rotated.statusCode === 404) {
            delete records[url];
            return false;
          }
          if (rotated.statusCode >= 400) throw rasketError(this, rotated);
          const secret = rotated.body.signing_secret;
          if (typeof secret !== "string" || isMask(secret)) {
            throw new NodeApiError(this.getNode(), rotated.body as JsonObject, {
              message: "Rasket rotated the webhook's signing secret but did not return it",
              description: "Deactivate and activate the workflow again.",
            });
          }
          record.secret = secret;
        }
        return true;
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const url = webhookUrl(this);
        const events = chosenEvents(this.getNodeParameter("events", []));
        const response = await rasketRawRequest(this, {
          method: "POST",
          path: "/webhooks",
          body: { endpoint: url, events },
        });
        if (response.statusCode >= 400) throw createError(this, response, url);
        const id = response.body.id;
        const secret = response.body.signing_secret;
        if (typeof id !== "string" || typeof secret !== "string") {
          throw new NodeApiError(this.getNode(), response.body as JsonObject, {
            message: "Rasket created the webhook but did not return its signing secret",
            description: "Deactivate and activate the workflow again.",
          });
        }
        endpoints(this)[url] = { id, secret };
        return true;
      },

      /** `DELETE /webhooks/{id}`; an endpoint that is already gone is the outcome we wanted. */
      async delete(this: IHookFunctions): Promise<boolean> {
        const url = webhookUrl(this);
        const records = endpoints(this);
        const record = records[url];
        if (record === undefined) return true;
        const response = await rasketRawRequest(this, {
          method: "DELETE",
          path: `/webhooks/${segment(record.id)}`,
        });
        if (response.statusCode >= 400 && response.statusCode !== 404)
          throw rasketError(this, response);
        delete records[url];
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const request = this.getRequestObject() as unknown as WebhookRequest;
    const record = endpoints(this)[webhookUrl(this)];
    if (record === undefined) return refuse(this, "This webhook is not registered with Rasket.");

    if (request.rawBody === undefined && typeof request.readRawBody === "function") {
      await request.readRawBody();
    }
    const raw = Buffer.isBuffer(request.rawBody)
      ? request.rawBody.toString("utf8")
      : JSON.stringify(this.getBodyData());
    const headers = signatureHeaders(this.getHeaderData());
    const now = Math.floor(Date.now() / 1000);

    // Never ask Rasket here: anyone can POST to this URL, so a failed check must not change what
    // the node holds. A secret rotated in Rasket is picked up on the next activation.
    const failure = verifySignature(headers, raw, record.secret, now);
    if (failure === "no_matching_signature") {
      return refuse(
        this,
        "Signature check failed: no_matching_signature. If the signing secret was rotated in Rasket, deactivate and re-activate the workflow.",
      );
    }
    if (failure !== null) return refuse(this, `Signature check failed: ${failure}.`);

    let envelope: IDataObject;
    try {
      envelope = JSON.parse(raw) as IDataObject;
    } catch {
      return refuse(this, "The body is not JSON.");
    }
    const type = typeof envelope.type === "string" ? envelope.type : "";
    if (!chosenEvents(this.getNodeParameter("events", [])).includes(type)) {
      return { webhookResponse: { received: true } };
    }
    const data =
      typeof envelope.data === "object" && envelope.data !== null && !Array.isArray(envelope.data)
        ? (envelope.data as IDataObject)
        : {};
    return {
      workflowData: [
        this.helpers.returnJsonArray({
          ...data,
          event: type,
          occurred_at: typeof envelope.created_at === "string" ? envelope.created_at : null,
          delivery_id: headers.id ?? null,
        }),
      ],
    };
  }
}

/**
 * The parts of n8n's Express request and response this node uses. n8n's types name Express, which
 * a community node does not depend on, so they are described here instead.
 */
interface WebhookRequest {
  rawBody?: unknown;
  readRawBody?: () => Promise<void>;
}

interface WebhookResponse {
  status(code: number): { json(body: unknown): void };
}

/** Answer 401 and start nothing. Rasket retries a refused delivery, then parks it. */
function refuse(context: IWebhookFunctions, message: string): IWebhookResponseData {
  const response = context.getResponseObject() as unknown as WebhookResponse;
  response.status(401).json({ message });
  return { noWebhookResponse: true };
}
