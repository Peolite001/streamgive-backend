import { createHmac } from 'node:crypto';

import { prisma } from '../db.js';
import type { NotificationEvent } from './types.js';

const deliveredEventIds = new Set<string>();
const MAX_DELIVERED_EVENT_IDS = 10_000;

/**
 * Header carrying an HMAC-SHA256 of the request body, keyed with
 * `NOTIFY_WEBHOOK_SECRET`, so a receiver can tell a real notification from
 * one posted by anybody who happened to learn the webhook URL. Lower-case
 * hex, no prefix. See the "Notification events" section of the README for
 * the receiver-side verification recipe.
 */
const SIGNATURE_HEADER = 'x-streamgive-signature';

/** Real (if NOTIFY_WEBHOOK_URL is set): POSTs the event as JSON. Node's
 * built-in fetch means this needs no extra dependency. */
async function notifyWebhook(event: NotificationEvent): Promise<void> {
  // Deliberately read per call rather than captured at module load: hoisting
  // this to a module-level constant freezes the URL at import time, so a
  // value set (or rotated) later in the process lifetime would be ignored
  // until a restart. test/notifications/service.test.ts guards this.
  const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
  if (!webhookUrl) return;

  // Serialised once and reused as both the signed input and the request
  // body. Signing a second `JSON.stringify(event)` would work today but
  // couples the signature to key ordering staying identical between two
  // calls — the receiver verifies against the raw bytes it read off the
  // wire, so those bytes are what has to be signed.
  const body = JSON.stringify(event);

  const headers: Record<string, string> = { 'content-type': 'application/json' };

  // Read per call rather than at module load so deployments can rotate the
  // secret without a restart, and so tests can set it per case.
  const secret = process.env.NOTIFY_WEBHOOK_SECRET;
  if (secret) {
    headers[SIGNATURE_HEADER] = createHmac('sha256', secret).update(body).digest('hex');
  }

  let success = false;
  let error: string | undefined;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body,
    });

    if (res.ok) {
      success = true;
    } else {
      error = `status ${res.status}`;
      console.error(
        `webhook notification failed with status ${res.status} for ${webhookUrl}`,
      );
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error('webhook notification failed', err);
  }

  await prisma.notificationLog.create({
    data: { eventType: event.type, channel: 'webhook', success, error },
  });
}

/** Stub: no email provider wired up yet — picking one (SendGrid, Postmark,
 * Resend, ...) is a separate decision. `notify()` below is the only thing
 * the rest of the app calls, so swapping this out later touches no call
 * sites. */
async function notifyEmail(event: NotificationEvent): Promise<void> {
  console.log('[notify:email:stub]', event);

  await prisma.notificationLog.create({
    data: { eventType: event.type, channel: 'email', success: true },
  });
}

export async function notify(event: NotificationEvent): Promise<void> {
  if (event.eventId && deliveredEventIds.has(event.eventId)) return;
  if (event.eventId) {
    deliveredEventIds.add(event.eventId);
    if (deliveredEventIds.size > MAX_DELIVERED_EVENT_IDS) {
      const oldest = deliveredEventIds.values().next().value;
      if (oldest) deliveredEventIds.delete(oldest);
    }
  }
  await Promise.all([notifyWebhook(event), notifyEmail(event)]);
}
