import type { IDataObject } from "n8n-workflow";

/**
 * The Simplify output for records with more than ten fields (n8n's UX guidelines): the ten most
 * useful, flattened, most-used first. Lists of addresses become one comma-separated string, which
 * is what a "To" field elsewhere takes. A Get Many row carries fewer fields than Get's record, so
 * the `…Row` versions list only what a row has: a field that is never there would always be null.
 */

function text(row: IDataObject, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function joined(row: IDataObject, key: string): string {
  const value = row[key];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(", ");
  return typeof value === "string" ? value : "";
}

export function simplifyEmail(email: IDataObject): IDataObject {
  return {
    id: text(email, "id"),
    from: text(email, "from"),
    to: joined(email, "to"),
    subject: text(email, "subject"),
    last_event: text(email, "last_event"),
    created_at: text(email, "created_at"),
    scheduled_at: text(email, "scheduled_at"),
    cc: joined(email, "cc"),
    reply_to: joined(email, "reply_to"),
    tags: email.tags ?? null,
  };
}

export function simplifyCampaign(campaign: IDataObject): IDataObject {
  return {
    id: text(campaign, "id"),
    name: text(campaign, "name"),
    status: text(campaign, "status"),
    subject: text(campaign, "subject"),
    from: text(campaign, "from"),
    segment_id: text(campaign, "segment_id"),
    topic_id: text(campaign, "topic_id"),
    created_at: text(campaign, "created_at"),
    scheduled_at: text(campaign, "scheduled_at"),
    sent_at: text(campaign, "sent_at"),
  };
}

/** A Get Many row (`ListBroadcastsItem`): no subject, sender or content, so none is listed. */
export function simplifyCampaignRow(campaign: IDataObject): IDataObject {
  return {
    id: text(campaign, "id"),
    name: text(campaign, "name"),
    status: text(campaign, "status"),
    channel: text(campaign, "channel") ?? "email",
    segment_id: text(campaign, "segment_id"),
    topic_id: text(campaign, "topic_id"),
    created_at: text(campaign, "created_at"),
    scheduled_at: text(campaign, "scheduled_at"),
    sent_at: text(campaign, "sent_at"),
  };
}

export function simplifyTemplate(template: IDataObject): IDataObject {
  const variables = Array.isArray(template.variables)
    ? (template.variables as IDataObject[])
        .map((variable) => variable.key)
        .filter((key) => typeof key === "string")
        .join(", ")
    : null;
  return {
    id: text(template, "id"),
    name: text(template, "name"),
    alias: text(template, "alias"),
    status: text(template, "status"),
    subject: text(template, "subject"),
    from: text(template, "from"),
    variables,
    published_at: text(template, "published_at"),
    created_at: text(template, "created_at"),
    updated_at: text(template, "updated_at"),
  };
}

/** A Get Many row (`TemplateListItem`): no subject, sender or variables, so none is listed. */
export function simplifyTemplateRow(template: IDataObject): IDataObject {
  return {
    id: text(template, "id"),
    name: text(template, "name"),
    alias: text(template, "alias"),
    status: text(template, "status"),
    published_at: text(template, "published_at"),
    created_at: text(template, "created_at"),
    updated_at: text(template, "updated_at"),
  };
}
