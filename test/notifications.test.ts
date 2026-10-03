import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notify } from '../src/notifications/service.js';
import type { NotificationEvent } from '../src/notifications/types.js';

describe('notification service', () => {
  const originalEnv = process.env.NOTIFY_WEBHOOK_URL;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NOTIFY_WEBHOOK_URL = originalEnv;
    } else {
      delete process.env.NOTIFY_WEBHOOK_URL;
    }
  });

  it('POSTs the expected JSON body when NOTIFY_WEBHOOK_URL is set', async () => {
    const webhookUrl = 'https://example.com/webhook';
    process.env.NOTIFY_WEBHOOK_URL = webhookUrl;

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    const event: NotificationEvent = {
      type: 'ngo_approved',
      ownerAddress: 'G1234567890',
      ngoId: 'ngo-123',
    };

    await notify(event);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
  });

  it('does not throw or block notify() when webhook request fails', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'https://example.com/webhook';

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const event: NotificationEvent = {
      type: 'ngo_revoked',
      ownerAddress: 'G1234567890',
      ngoId: 'ngo-123',
    };

    await expect(notify(event)).resolves.not.toThrow();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('delivers an indexed event only once when the poll is retried', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'https://example.com/webhook';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const event: NotificationEvent = {
      type: 'ngo_approved',
      ownerAddress: 'G1234567890',
      ngoId: 'ngo-retried',
      eventId: `event-${Date.now()}-duplicate-test`,
    };

    await notify(event);
    await notify(event);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
