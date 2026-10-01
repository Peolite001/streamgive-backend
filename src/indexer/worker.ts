
import { getLatestLedgerSequence, rpcServer } from '../stellar/rpc.js';
import { getCheckpoint, saveCheckpoint } from './checkpoint.js';
import { WATCHED_CONTRACT_IDS } from './contracts.js';

const POLL_INTERVAL_MS = Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 5000);
const START_LEDGER = process.env.INDEXER_START_LEDGER
  ? Number(process.env.INDEXER_START_LEDGER)
  : undefined;

type GetEventsResult = Awaited<ReturnType<typeof rpcServer.getEvents>>;
export type ContractEvent = GetEventsResult['events'][number];
export type EventHandler = (event: ContractEvent) => Promise<void>;

// Cached in memory during the process lifetime so every poll doesn't hit
// the DB just to read the starting point; the source of truth is always
// the `indexer_checkpoints` row, written after every processed event.
let lastProcessedLedger: number | undefined;

/** The RPC rejects an out-of-window startLedger with JSON-RPC -32600 and a
 *  message naming the range it does serve. There is no dedicated error code
 *  for it, so the message is the only signal available. */
function isLedgerOutOfRange(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string' &&
    (err as { message: string }).message.includes(
      'startLedger must be within the ledger range',
    )
  );
}

async function pollOnce(handleEvent: EventHandler): Promise<void> {
  if (WATCHED_CONTRACT_IDS.length === 0) {
    return;
  }

  if (lastProcessedLedger === undefined) {
    const saved = await getCheckpoint();

    if (saved !== undefined) {
      lastProcessedLedger = saved;
    } else {
      // Never run before: use INDEXER_START_LEDGER for backfill if set,
      // otherwise start from "now" to avoid replaying all history.
      lastProcessedLedger = START_LEDGER ?? (await getLatestLedgerSequence());
      await saveCheckpoint(lastProcessedLedger);
      return;
    }
  }

  // The RPC only serves a sliding window of recent ledgers, and rejects a
  // startLedger on either side of it. Two ways to fall outside:
  //
  //   ahead — we checkpoint at the latest ledger, so the very next poll asks
  //     for latest + 1, which has not closed yet. Nothing to do but wait.
  //   behind — if this process is down longer than the retention window, the
  //     saved checkpoint ages out of it and every later poll fails forever.
  //     Skip ahead to the current ledger; the alternative is an indexer that
  //     never recovers. Events in the gap are lost, so say so loudly.
  const latestLedger = await getLatestLedgerSequence();

  if (lastProcessedLedger >= latestLedger) {
    return;
  }

  let events;

  try {
    ({ events } = await rpcServer.getEvents({
      startLedger: lastProcessedLedger + 1,
      filters: [
        {
          type: 'contract',
          contractIds: WATCHED_CONTRACT_IDS,
        },
      ],
    }));
  } catch (err: unknown) {
    if (isLedgerOutOfRange(err)) {
      console.warn(
        `indexer: checkpoint ${lastProcessedLedger} has aged out of the RPC's` +
          ` retention window — skipping to ledger ${latestLedger}. Events in` +
          ` between were missed and will not be indexed.`,
      );

      lastProcessedLedger = latestLedger;
      await saveCheckpoint(lastProcessedLedger);
      return;
    }

    throw err;
  }

  // Nothing happened in the scanned range, but it *was* scanned — advance
  // the checkpoint anyway. Otherwise an idle contract leaves the checkpoint
  // pinned while the chain moves on, until it falls out of the retention
  // window and the recovery above fires on a perfectly healthy indexer.
  if (events.length === 0) {
    lastProcessedLedger = latestLedger;
    await saveCheckpoint(lastProcessedLedger);
    return;
  }

  for (const event of events) {
    await handleEvent(event);

    // Saved per-event, not once per batch: several handlers apply relative
    // deltas (balance -= accrued, etc.), so replaying an already-applied
    // event after a crash would double-count it. Checkpointing after each
    // one bounds the damage to "at most the in-flight event" on a crash.
    lastProcessedLedger = event.ledger;
    await saveCheckpoint(lastProcessedLedger);
  }
}

/**
 * Starts polling for contract events.
 *
 * The returned stop function clears the polling interval and waits for all
 * polls that were already running to finish before resolving.
 */
export function startIndexer(handleEvent: EventHandler): () => Promise<void> {
  if (WATCHED_CONTRACT_IDS.length === 0) {
    // Expected on a fresh local setup before contracts are deployed, not a
    // bug — pollOnce() no-ops until at least one contract id is set. Logged
    // once here (rather than every poll) so it's visible without being noisy.
    console.warn(
      'indexer: NGO_REGISTRY_CONTRACT_ID and DONATION_VAULT_CONTRACT_ID are both unset — no-op until at least one is set. See ENVIRONMENT.md.',
    );
  }

  const inFlightPolls = new Set<Promise<void>>();

  const runPoll = (): void => {
    const pollPromise = pollOnce(handleEvent).catch((err: unknown) => {
      console.error('indexer poll failed', err);
    });

    inFlightPolls.add(pollPromise);
    pollPromise.finally(() => {
      inFlightPolls.delete(pollPromise);
    });
  };

  runPoll();
  const interval = setInterval(runPoll, POLL_INTERVAL_MS);

  return async (): Promise<void> => {
    clearInterval(interval);
    await Promise.all(inFlightPolls);
  };
}
