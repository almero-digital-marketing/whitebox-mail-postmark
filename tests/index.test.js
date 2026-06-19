import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Postmark SDK so send() never touches the network.
const sendEmail = vi.fn(async () => ({ MessageID: 'pm-123', ErrorCode: 0 }))
vi.mock('postmark', () => ({ ServerClient: class { sendEmail = sendEmail } }))

const { postmark } = await import('../src/index.js')

const make = (extra = {}) => postmark({ serverToken: 'tok', from: 'sender@x.com', ...extra })

beforeEach(() => sendEmail.mockClear())

describe('contract', () => {
  it('exposes the provider methods', () => {
    const p = make()
    expect(p.name).toBe('postmark')
    for (const m of ['send', 'verifySignature', 'parseInbound', 'parseTracking', 'classifyError']) {
      expect(typeof p[m]).toBe('function')
    }
  })

  it('throws without a serverToken', () => {
    expect(() => postmark({ from: 'x@y.com' })).toThrow(/serverToken/)
  })
})

describe('send', () => {
  it('maps to Postmark PascalCase, sets tracking, returns MessageID', async () => {
    const p = make()
    const out = await p.send({ to: 'a@b.com', subject: 'Hi', html: '<p>x</p>', track: true })
    expect(out).toEqual({ messageId: 'pm-123' })
    const arg = sendEmail.mock.calls[0][0]
    expect(arg).toMatchObject({
      From: 'sender@x.com',
      To: 'a@b.com',
      Subject: 'Hi',
      HtmlBody: '<p>x</p>',
      TrackOpens: true,
      TrackLinks: 'HtmlAndText',
      MessageStream: 'outbound',
    })
  })

  it('honors per-message from and disables tracking', async () => {
    const p = make()
    await p.send({ from: 'me@z.com', to: 'a@b.com', subject: 'Hi', text: 'x' })
    const arg = sendEmail.mock.calls[0][0]
    expect(arg.From).toBe('me@z.com')
    expect(arg.TrackOpens).toBe(false)
    expect(arg.TrackLinks).toBe('None')
  })
})

describe('verifySignature (Basic auth)', () => {
  const creds = 'Basic ' + Buffer.from('hook:s3cret').toString('base64')

  it('accepts when no creds configured (verification off)', () => {
    expect(make().verifySignature({ headers: {} })).toBe(true)
  })

  it('accepts matching Basic auth', () => {
    const p = make({ webhookUser: 'hook', webhookPassword: 's3cret' })
    expect(p.verifySignature({ headers: { authorization: creds } })).toBe(true)
  })

  it('rejects wrong credentials / missing header', () => {
    const p = make({ webhookUser: 'hook', webhookPassword: 's3cret' })
    expect(p.verifySignature({ headers: { authorization: 'Basic ' + Buffer.from('hook:nope').toString('base64') } })).toBe(false)
    expect(p.verifySignature({ headers: {} })).toBe(false)
  })
})

describe('parseInbound', () => {
  it('maps Postmark inbound JSON + base64 attachments', () => {
    const p = make()
    const req = {
      body: {
        FromFull: { Email: 'a@b.com' },
        OriginalRecipient: 'in@x.com',
        Subject: 'Re: x',
        StrippedTextReply: 'hello',
        HtmlBody: '<p>hello</p>',
        Attachments: [{ Name: 'r.png', Content: Buffer.from('img').toString('base64'), ContentType: 'image/png' }],
      },
    }
    expect(p.parseInbound(req)).toEqual({
      from: 'a@b.com',
      to: 'in@x.com',
      subject: 'Re: x',
      body: 'hello',
      bodyHtml: '<p>hello</p>',
      attachments: [{ filename: 'r.png', content: Buffer.from('img') }],
    })
  })
})

describe('parseTracking', () => {
  it.each([
    ['Delivery', 'delivered'],
    ['Open', 'opened'],
    ['Click', 'clicked'],
    ['SpamComplaint', 'complained'],
  ])('maps RecordType %s → %s', (rt, canonical) => {
    const p = make()
    const out = p.parseTracking({ body: { RecordType: rt, MessageID: 'pm-1', Recipient: 'a@b.com' } })
    expect(out).toMatchObject({ event: canonical, messageId: 'pm-1', recipient: 'a@b.com' })
  })

  it('marks a hard bounce as permanent', () => {
    const out = make().parseTracking({ body: { RecordType: 'Bounce', MessageID: 'pm-1', Email: 'a@b.com', Type: 'HardBounce', Description: 'no such user' } })
    expect(out).toMatchObject({ event: 'bounced', severity: 'permanent', recipient: 'a@b.com', errorMessage: 'no such user' })
  })

  it('marks a soft bounce as temporary', () => {
    const out = make().parseTracking({ body: { RecordType: 'Bounce', MessageID: 'pm-1', Email: 'a@b.com', Type: 'SoftBounce' } })
    expect(out.severity).toBe('temporary')
  })

  it('maps a suppression SubscriptionChange to unsubscribed; ignores re-subscribe', () => {
    const p = make()
    expect(p.parseTracking({ body: { RecordType: 'SubscriptionChange', Recipient: 'a@b.com', SuppressSending: true } }))
      .toMatchObject({ event: 'unsubscribed', recipient: 'a@b.com' })
    expect(p.parseTracking({ body: { RecordType: 'SubscriptionChange', Recipient: 'a@b.com', SuppressSending: false } })).toBe(null)
  })

  it('returns null without a RecordType', () => {
    expect(make().parseTracking({ body: {} })).toBe(null)
  })
})

describe('classifyError', () => {
  it('treats inactive/invalid ErrorCodes + keywords as permanent', () => {
    const p = make()
    expect(p.classifyError({ code: 406, message: 'inactive recipient' }).permanent).toBe(true)
    expect(p.classifyError({ code: 300, message: 'Invalid email request' }).permanent).toBe(true)
    expect(p.classifyError({ code: 500, message: 'server error' }).permanent).toBe(false)
  })
})
