/**
 * Tests for the process-level error handlers defined in src/index.ts.
 *
 * Strategy: import only the `shutdown` export (which is pure async teardown,
 * no process.exit) and verify it calls stopIndexer + app.close(). The
 * unhandledRejection handler is tested by emitting the event directly on the
 * mocked process listeners via a subprocess-style check that confirms
 * process.exit(1) would be triggered on that path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock heavy dependencies before src/index.ts is imported so the module can
// be loaded without a real DB, RPC server, or network.
// ---------------------------------------------------------------------------

vi.mock('dotenv/config', () => ({}));

vi.mock('../src/server.js', () => ({
  buildServer: vi.fn(() => ({
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

const mockStopIndexer = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/indexer/worker.js', () => ({
  startIndexer: vi.fn(() => mockStopIndexer),
}));

vi.mock('../src/indexer/dispatch.js', () => ({
  dispatchEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Now load the module under test.
// ---------------------------------------------------------------------------
const { shutdown } = await import('../src/index.js');
const { buildServer } = await import('../src/server.js');
const mockApp = vi.mocked(buildServer).mock.results[0]?.value as {
  log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
};

describe('shutdown()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.close.mockResolvedValue(undefined);
  });

  it('stops the indexer and closes the server', async () => {
    await shutdown('SIGTERM');

    expect(mockStopIndexer).toHaveBeenCalledOnce();
    expect(mockApp.close).toHaveBeenCalledOnce();
  });

  it('logs the signal that triggered the shutdown', async () => {
    await shutdown('SIGTERM');

    expect(mockApp.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM' }),
      'shutting down',
    );
  });

  it('propagates server close errors so callers can decide the exit code', async () => {
    const boom = new Error('close failed');
    mockApp.close.mockRejectedValue(boom);

    await expect(shutdown('SIGTERM')).rejects.toThrow('close failed');
  });
});

describe('unhandledRejection policy', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.close.mockResolvedValue(undefined);
    // Prevent process.exit from terminating the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('exits with code 1 when an unhandled rejection occurs', async () => {
    // Emit the event the same way Node does for an uncaught rejection.
    process.emit('unhandledRejection', new Error('db connection lost'), Promise.resolve());

    // Allow the microtask queue and any pending promises to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('tears down the indexer and server before exiting on unhandled rejection', async () => {
    process.emit('unhandledRejection', new Error('rpc timeout'), Promise.resolve());

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockStopIndexer).toHaveBeenCalled();
    expect(mockApp.close).toHaveBeenCalled();
  });

  it('still exits with code 1 when shutdown itself errors during an unhandled rejection', async () => {
    mockApp.close.mockRejectedValue(new Error('shutdown error'));

    process.emit('unhandledRejection', new Error('original rejection'), Promise.resolve());

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
