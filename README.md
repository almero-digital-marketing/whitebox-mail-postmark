# whitebox-mail-postmark

[Postmark](https://postmarkapp.com/) provider for [`whitebox-server-plugin-mail`](../../whitebox-server-plugin-mail). Lives in its own repo; the mail plugin stays provider-agnostic and composes this in.

```js
import { mail } from 'whitebox-server-plugin-mail'
import { postmark } from 'whitebox-mail-postmark'

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
| `verifySignature(req)` | HTTP **Basic auth** (Postmark doesn't HMAC-sign); off if no credentials configured |
| `parseInbound(req)` | `FromFull`/`Subject`/`StrippedTextReply`/`HtmlBody` + base64 `Attachments` |
| `parseTracking(req)` | dispatches on `RecordType` (Delivery/Open/Click/Bounce/SpamComplaint/SubscriptionChange) → canonical event; hard bounce ⇒ `permanent` |
| `classifyError(err)` | ErrorCodes 300/406 + keywords ⇒ permanent |

> Postmark has no `event_id`-style pixel↔API dedup concern here — there's no browser pixel; the plugin records a single first-party send + tracking events.

## Webhooks

Postmark posts JSON. Configure these webhook URLs (set the same Basic-auth user/password you passed to `postmark({ … })`):

- inbound → `POST /mail/webhooks/inbox`
- delivery / open / click / bounce / spam-complaint / subscription-change → `POST /mail/webhooks/tracking`

## Credentials

All from the environment — never commit them:

- `WB_POSTMARK_SERVER_TOKEN`
- `WB_POSTMARK_FROM`
- `WB_POSTMARK_WEBHOOK_USER` / `WB_POSTMARK_WEBHOOK_PASSWORD`
