# n8n-nodes-rasket

The [Rasket](https://www.rasket.com) nodes for [n8n](https://n8n.io). Use them to send email and
texts from a workflow, keep contacts and segments up to date, run campaigns, and start a workflow
when an email bounces, a text is delivered, a contact signs up or an automation finishes.

The package has two nodes:

- **Rasket** sends email and texts, and manages contacts, segments, topics, the suppression list,
  campaigns and custom events. It also reads templates and segments. It can be used as a tool by n8n's AI
  Agent.
- **Rasket Trigger** starts a workflow from Rasket webhooks. It checks the signature of every
  delivery.

The full guide, with every operation, the trigger's requirements and troubleshooting, is at
[rasket.com/docs/integrations/n8n](https://www.rasket.com/docs/integrations/n8n).

## Install

In n8n, open **Settings → Community nodes → Install** and enter `n8n-nodes-rasket`. On a
self-hosted instance you can also run `npm install n8n-nodes-rasket` in your n8n custom
directory. See n8n's
[community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

1. In Rasket, open **API keys** and create a key with **Full access**.
2. In n8n, add a **Rasket API** credential and paste the key.

n8n checks the key by reading your team (`GET /team`). A key with Sending access only can send
email, but it cannot manage contacts or create the trigger's webhook.

To send texts, also set the key's **SMS access** to Send only (Send and manage to read them too).
For Inbox events in the trigger, set its **Inbox access** to Read, with no channel limit.

## Operations

| Resource        | Operations                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Email**       | Send, Send Template, Schedule, Reschedule, Cancel, Get, Get Many                                                           |
| **Contact**     | Create or Update, Get, Get Many, Delete, Add to Segment, Remove From Segment, Subscribe to Topics, Unsubscribe From Topics |
| **Suppression** | Add, Remove, Get Many                                                                                                      |
| **Campaign**    | Create, Send, Send Test, Cancel, Get, Get Many                                                                             |
| **Event**       | Send                                                                                                                       |
| **Template**    | Get, Get Many                                                                                                              |
| **Segment**     | Get, Get Many                                                                                                              |
| **SMS**         | Send, Get                                                                                                                  |

Things you will meet:

- **Pick, don't paste.** Templates, segments, campaigns, scheduled emails, topics and custom
  events are lists to choose from. You can still switch to **By ID** and map an ID from an earlier
  node.
- **From** lists `hello@` on each of your verified domains. Switch to **Address** to use any
  other address on them. A team with no verified domain must add one in Rasket → Domains first.
- **Template variables become fields.** Once you pick a template in **Send Template** (or
  **Schedule** with a template), each variable of its published version appears as a field. A
  variable without a fallback is required.
- **Contact properties and event fields** work the same way, from your team's properties and the
  event's declared fields. **More Data** takes any other key.
- **Idempotency Key** (under Options) stops the same email going out twice. A second send with
  the same key within 24 hours returns the first email. Map something unique from your trigger.
- **Replays are safe where Rasket allows it.** Removing a contact that is not in the segment and
  canceling a canceled email succeed. Deleting a contact, or removing one from a segment, fails
  when the contact or the segment does not exist, a contact deleted by an earlier try included.
  **Send** of a custom event has no idempotency, so a replayed execution sends the event again.
- **Send At** with no offset (what the date picker gives) is read in the workflow's time zone
  (its settings, or the instance's `GENERIC_TIMEZONE`), never the n8n server's.
- **Campaign checks.** A campaign send that fails a pre-send content check (a broken link, a
  missing unsubscribe link) is refused with every failing check listed. **Send Despite Failed
  Checks**, under Send's options or Create's with Send Now, sends it anyway.
- **Rate limits.** When Rasket's per-second limit is hit, the node waits for the `Retry-After`
  time (at most ten seconds) and tries once more. Beyond that, turn on **Retry On Fail** in the
  node's settings. A used-up sending quota is not retried; the error says to raise it in Rasket →
  Billing.
- **Simplify** (on Email, Campaign and Template **Get** and **Get Many**) returns the ten most
  useful fields of a record. A Get Many row of campaigns or templates carries no subject, sender
  or variables, so Simplify there returns only what a row has; use **Get** for the rest. Turn it
  off for the full record.
- **Deletes** return `{ "deleted": true }`.

## Trigger

Choose the events that should start the workflow:

- **Email:** sent, delivered, delivery delayed, bounced, marked as spam, opened, link clicked,
  failed, suppressed, scheduled, canceled, received.
- **Contact:** created, updated, deleted.
- **Domain:** created, updated, deleted.
- **Suppression:** added, removed.
- **Automation run:** started, completed, failed or stopped.
- **SMS:** queued, sent, delivered, failed, received, and a contact unsubscribed from texts.
- **Inbox:** conversation created, message received, reply sent, note added, conversation assigned,
  conversation status changed. These need a key with Inbox access.
- **Autopilot proposal:** created, approved, skipped, expired, sent.

When you activate the workflow, the node creates a webhook endpoint in Rasket for your n8n URL
and the chosen events. Deactivating the workflow deletes the endpoint. Each delivery becomes one
item: the event's data, plus `event`, `occurred_at` and `delivery_id`.

Good to know:

- **Each active workflow uses one webhook endpoint** of your plan's allowance. **Listen for test
  event** uses another one while it listens. If none are left, activation says so: delete unused
  endpoints in Rasket → Webhooks, or upgrade.
- **Rasket only delivers to a public https address.** A local or plain-http n8n can't receive
  webhooks. Run n8n behind a public https URL and set n8n's `WEBHOOK_URL` to it, or use n8n Cloud.
- **Signatures are checked** on every delivery, with the endpoint's signing secret and a
  five-minute window. A delivery that fails the check gets a 401 and starts nothing; it shows
  only in the endpoint's deliveries in Rasket → Webhooks. Rasket retries it, then parks it there.
  If you rotate the signing secret in Rasket, deactivate and re-activate the workflow: the node
  then takes a new secret. If Rasket disabled the endpoint after repeated failures, enable it
  again in Rasket → Webhooks.
- Changing the selected events and saving updates the endpoint the next time the workflow is
  activated.

## Compared with the Rasket app for Zapier

Every Zapier action and search is a Rasket node operation, and every Zapier trigger has a match:

| Zapier                                                                                 | n8n                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| New Email Event, New Received Email, New/Updated/Deleted Contact, Automation Run Event | Rasket Trigger, the matching events                                                        |
| New Unsubscribe, New Suppression                                                       | Rasket Trigger, **Suppression Added**                                                      |
| New Verified Domain                                                                    | Rasket Trigger, **Domain Updated**                                                         |
| New Sent Campaign                                                                      | Schedule Trigger + Campaign → Get Many, status **Sent** (Rasket sends no campaign webhook) |
| Send Email, Send Template Email, Schedule / Reschedule / Cancel Scheduled Email        | Email → Send, Send Template, Schedule, Reschedule, Cancel                                  |
| Create or Update Contact, Delete Contact, segment and topic actions                    | Contact operations                                                                         |
| Add to / Remove from Suppression List                                                  | Suppression → Add, Remove                                                                  |
| Send Custom Event                                                                      | Event → Send                                                                               |
| Create / Send / Send Test / Cancel Campaign                                            | Campaign operations                                                                        |
| Find Contact, Find Email, Find Template, Find Segment, Find Campaign                   | Contact → Get, Email → Get, Template / Segment / Campaign → Get or Get Many                |

## Example workflows

Four example workflows are described in the
[guide](https://www.rasket.com/docs/integrations/n8n#example-workflows). They are not in the npm
package; once n8n has verified the nodes, they are in n8n's template gallery.

- **Send a Rasket email for each new Typeform response:** Typeform Trigger → Rasket **Email →
  Send**.
- **Update HubSpot contacts when a Rasket email bounces:** Rasket Trigger (**Email Bounced**) →
  Filter (permanent bounces) → HubSpot.
- **Add new Rasket contacts to Google Sheets:** Rasket Trigger (**Contact Created**) → Google
  Sheets.
- **Post the week's sent Rasket campaigns to Slack:** Schedule Trigger → Rasket **Campaign → Get
  Many** (status Sent) → Filter (last seven days) → Rasket **Campaign → Get** (for the subject) →
  Slack.

## Compatibility

Built and tested against `n8n-workflow` 2.41, n8n node API version 1.

## Support

Questions and bugs: [support@rasket.com](mailto:support@rasket.com), or the
[guide](https://www.rasket.com/docs/integrations/n8n).

## Licence

MIT
