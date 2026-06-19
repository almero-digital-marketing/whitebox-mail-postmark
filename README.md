# whitebox-pro-mail-postmark

[Postmark](https://postmarkapp.com/) provider for `whitebox-pro-server-plugin-mail`. Lives in its own repo; the mail plugin stays provider-agnostic and composes this in.

```js
import { mail } from 'whitebox-pro-server-plugin-mail'
import { postmark } from 'whitebox-pro-mail-postmark'

mail({
  provider: postmark({
    serverToken:     process.env.WB_POSTMARK_SERVER_TOKEN,
    from:            process.env.WB_POSTMARK_FROM,            // a verified Sender Signature
    // messageStream:  'outbound',
    webhookUser:     process.env.WB_POSTMARK_WEBHOOK_USER,    // HTTP Basic auth on the webhook URLs
    webhookPassword: process.env.WB_POSTMARK_WEBHOOK_PASSWORD,
  }),
  company: 'team@example.com',
  auth: { secret: process.env.WB_MAIL_TOKEN },
})
```

## What it implements

The same contract as the Mailgun provider — only the internals differ:

| method | Postmark specifics |
|---|---|
| `send(msg) → { messageId }` | `ServerClient.sendEmail` (PascalCase fields); `TrackOpens`/`TrackLinks`; base64 attachments; returns `MessageID` |
| `sendBatch(messages)` + `maxBatchSize: 500` | `sendEmailBatch` — independently-rendered messages, one result per recipient each with its own `MessageID`/error |
| `verifySignature(req)` | HTTP **Basic auth** (Postmark doesn't HMAC-sign); off if no credentials configured |
| `parseInbound(req)` | `FromFull`/`Subject`/`StrippedTextReply`/`HtmlBody` + base64 `Attachments` |
| `parseTracking(req)` | dispatches on `RecordType` (Delivery/Open/Click/Bounce/SpamComplaint/SubscriptionChange) → canonical event; hard bounce ⇒ `permanent` |
| `classifyError(err)` | ErrorCodes 300/406 + keywords ⇒ permanent |

> Postmark has no `event_id`-style pixel↔API dedup concern here — there's no browser pixel; the plugin records a single first-party send + tracking events.

## Webhook setup

Postmark posts JSON and secures webhooks with **HTTP Basic auth** on the URL (it doesn't HMAC-sign). Set a username/password and pass the *same* pair to `postmark({ webhookUser, webhookPassword })` — the plugin rejects any request whose `Authorization: Basic …` header doesn't match.

> If you leave `webhookUser`/`webhookPassword` unset, this provider does **not** verify webhooks (open endpoint). Either set them, or secure the route another way (secret path, network policy).

**1. Sender Signature.** Postmark → **Sender Signatures** — verify the address you'll send from and put it in `WB_POSTMARK_FROM`. Postmark refuses to send from an unverified signature/domain.

**2. Tracking events.** Postmark → your **Message Stream → Webhooks → Add webhook**:
- URL — `https://USER:PASSWORD@YOUR_HOST/mail/webhooks/tracking` (Basic-auth creds in the URL), matching `webhookUser`/`webhookPassword`.
- Tick the event types you want; each posts a distinct `RecordType`:

| Postmark RecordType | canonical | effect in WhiteBox |
|---|---|---|
| Delivery | `delivered` | outbox status → delivered |
| Open | `opened` | → opened, recorded in awareness |
| Click | `clicked` | → engaged, recorded in awareness |
| Bounce (`Inactive`/`HardBounce`) | `bounced` (permanent) | → **invalid** list |
| SpamComplaint | `complained` | → **suppression** list |
| SubscriptionChange (`SuppressSending`) | `unsubscribed` | → **suppression** list |

Opens/clicks require **Open Tracking / Link Tracking** enabled on the stream (the plugin also sends `TrackOpens`/`TrackLinks` per message).

**3. Inbound mail / replies.** Postmark → the **Inbound** stream → set its **Inbound Webhook** URL to `https://USER:PASSWORD@YOUR_HOST/mail/webhooks/inbox`. Postmark gives the stream an inbound address (a hash@inbound.postmarkapp.com, or your own MX-pointed domain) — mail to it is POSTed as JSON, attachments base64-encoded.

Full URLs are under the mail plugin's `/mail` mount: `…/mail/webhooks/tracking` and `…/mail/webhooks/inbox`.

## Credentials

All from the environment — never commit them:

- `WB_POSTMARK_SERVER_TOKEN`
- `WB_POSTMARK_FROM`
- `WB_POSTMARK_WEBHOOK_USER` / `WB_POSTMARK_WEBHOOK_PASSWORD`
