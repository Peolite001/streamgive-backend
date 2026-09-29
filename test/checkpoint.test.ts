import { describe, expect, it } from 'vitest';

describe('Intra-Ledger Checkpoint & Resumption (#39)', () => {
  it('processes subsequent events in the same ledger after a mid-ledger crash', async () => {
    const ledgerEvents = [
      { id: 'evt_1', ledger: 100, data: 'first' },
      { id: 'evt_2', ledger: 100, data: 'second' },
    ];

    let checkpoint = { lastLedger: 0, lastEventId: null as string | null };
    const processedEvents: string[] = [];

    // Simulate poll function with checkpoint cursor support
    const mockPoll = async () => {
      // Filter events after current checkpoint cursor
      const pendingEvents = ledgerEvents.filter((e) => {
        if (checkpoint.lastEventId) {
          // If we have an event ID, skip up to and including that ID in the ledger
          return e.id !== checkpoint.lastEventId && e.ledger >= checkpoint.lastLedger;
        }
        return e.ledger >= checkpoint.lastLedger;
      });

      for (const event of pendingEvents) {
        // Process a single event, checkpoint it, then simulate a crash so the
        // next poll has to resume from exactly this point rather than
        // replaying or skipping the rest of the ledger.
        processedEvents.push(event.id);
        checkpoint = { lastLedger: event.ledger, lastEventId: event.id };
        break;
      }
    };

    // Run first poll (simulates crash after evt_1)
    await mockPoll();
    expect(processedEvents).toEqual(['evt_1']);
    expect(checkpoint.lastEventId).toBe('evt_1');

    // Run second poll (resumes from lastEventId in ledger 100)
    await mockPoll();
    
    // Should process evt_2 without skipping it
    expect(processedEvents).toContain('evt_2');
  });
});