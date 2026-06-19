import crypto from 'crypto'
import { readFile } from 'fs/promises'
import path from 'path'
import { ServerClient } from 'postmark'

// Postmark provider for whitebox-pro-server-plugin-mail. Implements the same neutral
// provider contract as whitebox-pro-mail-mailgun, so the plugin code is identical —
// only the SDK, webhook auth (Postmark uses HTTP Basic auth, not HMAC), and the
// JSON payload shapes differ. Compose: mail({ provider: postmark({ … }) }).

// Postmark RecordType → whitebox canonical event vocabulary.
const RECORD_MAP = {
  Delivery:      'delivered',
  Open:          'opened',
  Click:         'clicked',
  Bounce:        'bounced',
  SpamComplaint: 'complained',
}

// Postmark API ErrorCodes that mean the address is unusable (don't retry).
const PERMANENT_CODES = new Set([300, 406])

const CONTENT_TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
  '.zip': 'application/zip', '.json': 'application/json',
}
const contentType = (filename) => CONTENT_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream'

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  try { return crypto.timingSafeEqual(ab, bb) } catch { return false }
}

export function postmark({ serverToken, from, messageStream = 'outbound', webhookUser, webhookPassword } = {}) {
  if (!serverToken) {
    throw new Error('postmark(): serverToken is required')
  }
  const client = new ServerClient(serverToken)

  // Postmark secures inbound/tracking webhooks with HTTP Basic auth configured
  // on the webhook URL. If no credentials are configured we don't verify (secure
  // the endpoint by other means, e.g. a secret path or network policy).
  function verifyBasicAuth(req) {
    if (!webhookUser && !webhookPassword) return true
    const hdr = req.headers?.authorization || req.get?.('authorization') || ''
    const m = /^Basic\s+(.+)$/i.exec(hdr)
    if (!m) return false
    const [u, pw = ''] = Buffer.from(m[1], 'base64').toString('utf8').split(':')
    return safeEqual(u, webhookUser || '') && safeEqual(pw, webhookPassword || '')
  }

  async function toPostmarkMessage({ from: msgFrom, to, replyTo, subject, html, text, headers, attachments = [], track = false }) {
    const Attachments = await Promise.all(attachments.map(async a => ({
      Name: a.filename,
      Content: (await readFile(a.path)).toString('base64'),
      ContentType: contentType(a.filename),
    })))
    return {
      From: msgFrom || from,
      To: to,
      ReplyTo: replyTo || undefined,
      Subject: subject,
      HtmlBody: html || undefined,
      TextBody: text || undefined,
      Headers: headers ? Object.entries(headers).map(([Name, Value]) => ({ Name, Value: String(Value) })) : undefined,
      Attachments: Attachments.length ? Attachments : undefined,
      TrackOpens: !!track,
      TrackLinks: track ? 'HtmlAndText' : 'None',
      MessageStream: messageStream,
    }
  }

  return {
    name: 'postmark',
    // Postmark's sendEmailBatch accepts up to 500 fully-independent messages.
    maxBatchSize: 500,

    async send(msg) {
      const resp = await client.sendEmail(await toPostmarkMessage(msg))
      return { messageId: resp?.MessageID || null }
    },

    // Native batch: each message is independent (full per-recipient rendering),
    // and Postmark returns a result per message — aligned with the input order —
    // each with its own MessageID / ErrorCode.
    async sendBatch(messages) {
      if (!messages.length) return []
      const built = await Promise.all(messages.map(toPostmarkMessage))
      const results = await client.sendEmailBatch(built)
      return messages.map((_, i) => {
        const r = results[i] || {}
        return {
          messageId: r.MessageID || null,
          error: r.ErrorCode ? (r.Message || `Postmark ErrorCode ${r.ErrorCode}`) : null,
        }
      })
    },

    // Postmark uses the same Basic-auth check for both webhook kinds.
    verifySignature(req /* , kind */) {
      return verifyBasicAuth(req)
    },

    parseInbound(req) {
      const b = req.body || {}
      return {
        from:     b.FromFull?.Email || b.From,
        to:       b.OriginalRecipient || b.ToFull?.[0]?.Email || b.To || null,
        subject:  b.Subject,
        body:     b.StrippedTextReply || b.TextBody || null,
        bodyHtml: b.HtmlBody || null,
        attachments: (b.Attachments || []).map(a => ({ filename: a.Name, content: Buffer.from(a.Content || '', 'base64') })),
      }
    },

    parseTracking(req) {
      const b = req.body || {}
      const rt = b.RecordType
      if (!rt) return null

      let event = RECORD_MAP[rt]
      let severity = null
      let errorMessage = null
      let recipient = b.Recipient || b.Email || null

      if (rt === 'Bounce') {
        severity = (b.Inactive || b.Type === 'HardBounce') ? 'permanent' : 'temporary'
        errorMessage = b.Description || b.Details || null
      } else if (rt === 'SpamComplaint') {
        errorMessage = b.Description || null
      } else if (rt === 'SubscriptionChange') {
        // Only a suppression (unsubscribe / spam) maps to an event; re-subscribes are ignored.
        if (!b.SuppressSending) return null
        event = 'unsubscribed'
      }

      if (!event) return null
      return { messageId: b.MessageID || null, event, recipient, severity, errorMessage }
    },

    classifyError(err) {
      if (!err) return { permanent: false }
      const code = err.code ?? err.ErrorCode ?? err.statusCode
      const numeric = typeof code === 'number' ? code : parseInt(code, 10)
      const msg = String(err.message || '')
      const permanent = (Number.isFinite(numeric) && PERMANENT_CODES.has(numeric)) || /inactive|invalid email|not a valid/i.test(msg)
      return { permanent, statusCode: Number.isFinite(numeric) ? numeric : null, message: msg }
    },
  }
}

export default postmark
