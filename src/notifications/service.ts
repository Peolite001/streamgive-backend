import type { NotificationEvent } from './types.js';

/** Real (if NOTIFY_WEBHOOK_URL is set): POSTs the event as JSON. Node's
 * built-in fetch means this needs no extra dependency. */
async function notifyWebhook(event: NotificationEvent): Promise<void> {
  const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });

    if (!res.ok) {
      console.error(
        `webhook notification failed with status ${res.status} for ${webhookUrl}`,
      );
    }
  } catch (err) {
    console.error('webhook notification failed', err);
  }
}

/** Stub: no email provider wired up yet — picking one (SendGrid, Postmark,
 * Resend, ...) is a separate decision. `notify()` below is the only thing
 * the rest of the app calls, so swapping this out later touches no call
 * sites. */
async function notifyEmail(event: NotificationEvent): Promise<void> {
  console.log('[notify:email:stub]', event);
}

export async function notify(event: NotificationEvent): Promise<void> {
  await Promise.all([notifyWebhook(event), notifyEmail(event)]);
}