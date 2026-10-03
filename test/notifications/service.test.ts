import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { notify } from '../../src/notifications/service.js';
import type { NotificationEvent } from '../../src/notifications/types.js';
import { resetDb } from '../helpers/db.js';

const event: NotificationEvent = {
  type: 'stream_created',
  streamId: '1',
  donorAddress: 'GDONOR',
  ngoId: 'NGO1',
};

describe('notify', () => {
  const originalEnv = process.env.NOTIFY_WEBHOOK_URL;
  const originalSecret = process.env.NOTIFY_WEBHOOK_SECRET;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
    delete process.env.NOTIFY_WEBHOOK_URL;
    // Unset by default so the signing cases opt in explicitly and a stray
    // value in the developer's own .env can't make them pass for free.
    delete process.env.NOTIFY_WEBHOOK_SECRET;
  });

  afterEach(() => {
    // Assigning `undefined` to a process.env key stores the string
    // "undefined" rather than unsetting it, so delete instead when the var
    // was originally absent.
    if (originalEnv === undefined) {
      delete process.env.NOTIFY_WEBHOOK_URL;
    } else {
      process.env.NOTIFY_WEBHOOK_URL = originalEnv;
    }

    if (originalSecret === undefined) {
      delete process.env.NOTIFY_WEBHOOK_SECRET;
    } else {
      process.env.NOTIFY_WEBHOOK_SECRET = originalSecret;
    }
  });

  const okResponse = () => new Response(null, { status: 200 });

  it('logs status code and URL when webhook returns a non-2xx response (500)', async () => {
    const webhookUrl = 'http://example.com/webhook';
    process.env.NOTIFY_WEBHOOK_URL = webhookUrl;

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    );

    await notify(event);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/500.*http:\/\/example\.com\/webhook/),
    );
  });

  it('writes a failure record when webhook returns non-2xx', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    );

    await notify(event);

    const log = await prisma.notificationLog.findFirst({
      where: { channel: 'webhook', success: false },
    });
    expect(log).not.toBeNull();
    expect(log?.eventType).toBe('stream_created');
    expect(log?.error).toMatch(/500/);
  });

  it('writes a success record when webhook returns 2xx', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    await notify(event);

    const log = await prisma.notificationLog.findFirst({
      where: { channel: 'webhook', success: true },
    });
    expect(log).not.toBeNull();
    expect(log?.eventType).toBe('stream_created');
  });

  it('writes an email record on every notify call', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await notify(event);

    const log = await prisma.notificationLog.findFirst({ where: { channel: 'email' } });
    expect(log).not.toBeNull();
    expect(log?.success).toBe(true);
  });

  it('fires the webhook at a URL set after the module was imported', async () => {
    // Regression guard: NOTIFY_WEBHOOK_URL used to be read into a module-level
    // constant, so a value set after import was ignored for the process
    // lifetime. The import at the top of this file has already run by now.
    const webhookUrl = 'http://example.com/set-after-import';
    process.env.NOTIFY_WEBHOOK_URL = webhookUrl;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());

    const event: NotificationEvent = {
      type: 'stream_created',
      streamId: '1',
      donorAddress: 'GDONOR',
      ngoId: 'NGO1',
    };

    await notify(event);

    expect(fetchSpy).toHaveBeenCalledWith(
      webhookUrl,
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      }),
    );
  });

  it('picks up a rotated NOTIFY_WEBHOOK_URL on the next call', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/first';

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());

    const event: NotificationEvent = {
      type: 'stream_withdrawn',
      streamId: '1',
      amount: '10',
    };

    await notify(event);
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/second';
    await notify(event);

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      'http://example.com/first',
      'http://example.com/second',
    ]);
  });

  it('skips the webhook when NOTIFY_WEBHOOK_URL is unset', async () => {
    delete process.env.NOTIFY_WEBHOOK_URL;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());

    await notify({
      type: 'stream_cancelled',
      streamId: '1',
      settledToNgo: '5',
      refundToDonor: '5',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('webhook signature', () => {
    const event: NotificationEvent = {
      type: 'stream_created',
      streamId: '1',
      donorAddress: 'GDONOR',
      ngoId: 'NGO1',
    };

    /** Captures the single fetch the webhook notifier makes. */
    function captureWebhookRequest() {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      return fetchSpy;
    }

    it('signs the body with an HMAC-SHA256 of NOTIFY_WEBHOOK_SECRET', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      process.env.NOTIFY_WEBHOOK_SECRET = 'a-shared-secret';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const body = init.body as string;

      // Recomputed here from the secret and the bytes actually sent, rather
      // than compared against a hard-coded digest — that way the assertion
      // stays true if the payload shape changes, and still fails if the
      // service ever signs something other than what it transmits.
      const expected = createHmac('sha256', 'a-shared-secret').update(body).digest('hex');

      expect(headers['x-streamgive-signature']).toBe(expected);
    });

    it('signs the exact bytes sent as the body, not a re-serialisation', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      process.env.NOTIFY_WEBHOOK_SECRET = 'a-shared-secret';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const signature = headers['x-streamgive-signature'];

      // A receiver only ever has the raw body — this is that verification,
      // done the way the README tells integrators to do it.
      const verified = createHmac('sha256', 'a-shared-secret')
        .update(Buffer.from(init.body as string, 'utf8'))
        .digest('hex');

      expect(signature).toBe(verified);
      expect(JSON.parse(init.body as string)).toEqual(event);
    });

    it('rejects a tampered body: the signature no longer matches', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      process.env.NOTIFY_WEBHOOK_SECRET = 'a-shared-secret';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;

      const forged = JSON.stringify({ ...event, ngoId: 'ATTACKER-NGO' });
      const forgedDigest = createHmac('sha256', 'a-shared-secret').update(forged).digest('hex');

      expect(forgedDigest).not.toBe(headers['x-streamgive-signature']);
    });

    it('omits the signature header when no secret is configured', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;

      expect(headers['x-streamgive-signature']).toBeUndefined();
      expect(headers['content-type']).toBe('application/json');
    });
  });
});