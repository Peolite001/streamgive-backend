import { prisma } from '../db.js';
import type { ContractEvent } from './worker.js';

/** Bounded so a pathological error message can't bloat the row. */
const MAX_ERROR_LENGTH = 2000;

function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Records an event the indexer failed to process, so the caller can move the
 * checkpoint past it instead of retrying it on every poll forever.
 *
 * Upsert rather than create: the unique `eventId` is the whole point of the
 * row, and a duplicate insert throwing here would reintroduce exactly the
 * wedge this table exists to prevent (a manual replay that fails again, say).
 * The newest error message wins.
 *
 * Deliberately *not* fault-tolerant — if this write throws, the database is
 * unreachable, which is a transient fault rather than a bad event. Letting it
 * propagate leaves the checkpoint where it is so the event is retried on the
 * next poll rather than skipped over a blip.
 */
export async function recordDeadLetter(event: ContractEvent, err: unknown): Promise<void> {
  const error = describeError(err);

  await prisma.indexerDeadLetter.upsert({
    where: { eventId: event.id },
    create: {
      eventId: event.id,
      ledger: event.ledger,
      contractId: event.contractId?.toString() ?? null,
      error,
    },
    update: { error },
  });
}
