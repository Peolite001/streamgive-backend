
export function startIndexer(pollOnce: () => Promise<void>, intervalMs: number) {
  let timeoutId: NodeJS.Timeout | null = null;
  let isStopped = false;
  let isPolling = false;

  const poll = async () => {
    if (isStopped) return;

    if (isPolling) {
      // Skip this tick if a poll is already in flight
      scheduleNext();
      return;
    }

    isPolling = true;
    try {
      await pollOnce();
    } catch (error) {
      console.error('Error during indexer poll:', error);
    } finally {
      isPolling = false;
      scheduleNext();
    }
  };

  const scheduleNext = () => {
    if (isStopped) return;
    timeoutId = setTimeout(poll, intervalMs);
  };

  // Kick off the initial poll
  poll();

  // Return stop function that cancels any pending timer
  return () => {
    isStopped = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}