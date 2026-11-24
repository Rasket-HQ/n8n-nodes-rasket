# Changelog

## 0.3.0

- **The Rasket Trigger keeps working after n8n restarts.** Earlier versions replaced the signing
  secret with the masked copy Rasket shows, so every delivery after a restart, an upgrade or a
  re-activation failed the signature check. The node now keeps its own secret. If the secret was
  rotated in Rasket, re-activating the workflow takes a new one. A delivery that fails the check
  no longer makes the node ask Rasket for anything, so a forged request cannot break the trigger.
- The trigger offers every Rasket event: SMS queued, sent and failed, a contact unsubscribing from
  texts, the six Inbox events and the five Autopilot proposal events. The **Event Names** field is
  now **Events**.
- A text refused for SMS access says which SMS access the key needs. A refused Inbox-events
  subscription says the key needs Inbox access. A Send only key, and a revoked key, each get their
  own advice. Other refusals no longer suggest a Full access key when that would not help.
- Campaign → Create's **Topic** lists only topics that reach email.
- Built with `@n8n/node-cli` 0.57.4 and checked with `@n8n/scan-community-package` 0.44.0.

## 0.2.1

- The API Key field's placeholder shows the real key shape, `rk_…`.
- Campaign → Send and Create (with Send Now) have a **Send Despite Failed Checks** option. A send
  that a pre-send content check refuses now lists every failing check and names the option.
- A **Send At** with no offset (what the date picker gives) is read in the workflow's time zone,
  not the n8n server's: 9:00 in a New York workflow schedules for 9:00 New York, not 9:00 UTC. An
  instance that never set `GENERIC_TIMEZONE` uses n8n's default, America/New_York. A value with an
  offset, or a date from an expression, keeps its instant.
- Email → Send Template and Schedule send boolean, object and list variables the way Rasket takes
  them (`"true"`, a JSON string) instead of a value it refuses.
- Contact → Delete and Remove From Segment fail on a contact or segment that does not exist,
  instead of reporting success. Removing a contact that is not in the segment still succeeds. A
  retried delete whose first try went through now fails too.
- An SMS quota refusal shows the quota guidance.
- Simplify on Campaign → Get Many and Template → Get Many returns only the fields a list row has,
  with no always-empty subject, sender or variables. Get is unchanged.
- The Segment field's help says what removal does: the contact stays out even when the segment's
  filter matches it.
- The weekly campaigns example reads each campaign's subject with a Get step, so the Slack post no
  longer says "null".

## 0.2.0

- **SMS** in the Rasket node: Send a text to a US or Canadian phone, and Get one with its status,
  messages and cost. The Rasket Trigger adds SMS Delivered and SMS Received.

## 0.1.0

- First release: the **Rasket** node (emails, contacts, segments, topics, suppressions, campaigns,
  custom events, templates) and the **Rasket Trigger** node (webhooks for email, contact, domain,
  suppression and automation-run events, signature-checked), with an API-key credential.
