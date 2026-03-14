import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileEventBus } from '../transport.js';
import { tmpdir } from 'os';
import { mkdtemp, rm, writeFile, readdir } from 'fs/promises';
import { join } from 'path';

describe('Event Bus', () => {
  let bus: FileEventBus;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainifai-events-'));
    bus = new FileEventBus(tempDir);
    await bus.init();
  });

  afterEach(async () => {
    await bus.close();
    await rm(tempDir, { recursive: true });
  });

  it('publish and subscribe round-trip', async () => {
    const received: unknown[] = [];
    bus.subscribe(['instance.registered'], async (event) => {
      received.push(event);
    });

    await bus.publish({
      kind: 'instance.registered',
      source: 'test-project',
      data: { name: 'test-project', type: 'coding', description: 'A test', path: '/tmp/test', parent: 'global' },
    });

    expect(received).toHaveLength(1);
    expect((received[0] as any).kind).toBe('instance.registered');
    expect((received[0] as any).data.name).toBe('test-project');
  });

  it('wildcard subscription receives all events', async () => {
    const received: unknown[] = [];
    bus.subscribe('*', async (event) => { received.push(event); });

    await bus.publish({ kind: 'instance.registered', source: 'a', data: {} });
    await bus.publish({ kind: 'instance.updated', source: 'b', data: {} });

    expect(received).toHaveLength(2);
  });

  it('filtered subscription ignores non-matching events', async () => {
    const received: unknown[] = [];
    bus.subscribe(['instance.registered'], async (event) => { received.push(event); });

    await bus.publish({ kind: 'instance.updated', source: 'a', data: {} });
    await bus.publish({ kind: 'instance.registered', source: 'b', data: {} });

    expect(received).toHaveLength(1);
    expect((received[0] as any).source).toBe('b');
  });

  it('replay returns persisted events', async () => {
    await bus.publish({ kind: 'instance.registered', source: 'a', data: { name: 'a' } });
    await bus.publish({ kind: 'instance.updated', source: 'b', data: { name: 'b' } });

    const events = await bus.replay();
    expect(events).toHaveLength(2);
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain('instance.registered');
    expect(kinds).toContain('instance.updated');
  });

  it('replay filters by kind', async () => {
    await bus.publish({ kind: 'instance.registered', source: 'a', data: {} });
    await bus.publish({ kind: 'instance.updated', source: 'b', data: {} });

    const events = await bus.replay({ kinds: ['instance.updated'] });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('instance.updated');
  });

  it('replay filters by since timestamp', async () => {
    await bus.publish({ kind: 'instance.registered', source: 'a', data: {} });
    await bus.publish({ kind: 'instance.updated', source: 'b', data: {} });

    // Use a future timestamp — should exclude all events
    const future = new Date(Date.now() + 60_000).toISOString();
    const noEvents = await bus.replay({ since: future });
    expect(noEvents).toHaveLength(0);

    // Use a past timestamp — should include all events
    const past = new Date(Date.now() - 60_000).toISOString();
    const allEvents = await bus.replay({ since: past });
    expect(allEvents).toHaveLength(2);
  });

  it('unsubscribe stops delivery', async () => {
    const received: unknown[] = [];
    const sub = bus.subscribe('*', async (event) => { received.push(event); });

    await bus.publish({ kind: 'instance.registered', source: 'a', data: {} });
    expect(received).toHaveLength(1);

    bus.unsubscribe(sub.id);
    await bus.publish({ kind: 'instance.registered', source: 'b', data: {} });
    expect(received).toHaveLength(1);
  });

  it('published events have id and timestamp', async () => {
    const received: any[] = [];
    bus.subscribe('*', async (event) => { received.push(event); });

    const id = await bus.publish({ kind: 'instance.registered', source: 'a', data: {} });

    expect(id).toBeTruthy();
    expect(received[0].id).toBe(id);
    expect(received[0].timestamp).toBeTruthy();
  });

  it('full round-trip: register → query → response', async () => {
    const responses: any[] = [];

    // Global subscribes to registrations and sends query
    bus.subscribe(['instance.registered'], async (event) => {
      await bus.publish({
        kind: 'query.request',
        source: 'global',
        target: event.source,
        data: { queryType: 'search', query: 'recent activity' },
      });
    });

    // Child subscribes to queries and responds
    bus.subscribe(['query.request'], async (event) => {
      if (event.target === 'child-1') {
        await bus.publish({
          kind: 'query.response',
          source: 'child-1',
          replyTo: event.id,
          data: { results: [{ kind: 'Activity', id: 'act-1' }] },
        });
      }
    });

    // Global collects responses
    bus.subscribe(['query.response'], async (event) => {
      responses.push(event);
    });

    // Child registers
    await bus.publish({
      kind: 'instance.registered',
      source: 'child-1',
      data: { name: 'child-1', type: 'coding', description: 'Test', path: '/tmp/child', parent: 'global' },
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].data.results).toHaveLength(1);
    expect(responses[0].replyTo).toBeDefined();
  });

  it('prune removes old event files', async () => {
    // Create a fake old file
    const oldDate = '2020-01-01';
    await writeFile(join(tempDir, `${oldDate}.jsonl`), '{}');

    await bus.pruneOldEvents();

    const files = await readdir(tempDir);
    expect(files.find(f => f.includes(oldDate))).toBeUndefined();
  });

  it('prune keeps recent event files', async () => {
    // Publish an event to create today's file
    await bus.publish({ kind: 'instance.registered', source: 'a', data: {} });

    await bus.pruneOldEvents();

    const files = await readdir(tempDir);
    const today = new Date().toISOString().slice(0, 10);
    expect(files.find(f => f.includes(today))).toBeDefined();
  });
});
