// ─── File-based event bus transport ─────────────────────────────────────────

import { appendFile, readFile, readdir, mkdir, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { ulid } from 'ulid';
import { logger } from '../shared/logger.js';
import { DEFAULT_EVENTS_DIR, DEFAULT_RETENTION_DAYS, DEFAULT_POLL_MS } from './constants.js';
import type { EventEnvelope, EventHandler, EventBus, EventKind, Subscription } from './types.js';

export class FileEventBus implements EventBus {
  private subscriptions = new Map<string, Subscription>();
  private lastOffset = new Map<string, number>(); // file → byte offset for tailing
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private eventsDir: string;
  private retentionDays: number;
  private pollMs: number;
  private currentlyPublishing = false; // prevent re-dispatch of own writes

  constructor(eventsDir?: string) {
    this.eventsDir = eventsDir ?? join(homedir(), DEFAULT_EVENTS_DIR);
    this.retentionDays = parseInt(process.env.EVENT_RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS), 10);
    this.pollMs = parseInt(process.env.EVENT_POLL_MS ?? String(DEFAULT_POLL_MS), 10);
  }

  async init(): Promise<void> {
    await mkdir(this.eventsDir, { recursive: true });
    // Seed offset for today's file so we don't replay old events on startup
    await this.seedOffset(this.todayFile());
    this.startWatching();
  }

  async publish(event: Omit<EventEnvelope, 'id' | 'timestamp'>): Promise<string> {
    const id = ulid();
    const envelope: EventEnvelope = {
      ...event,
      id,
      timestamp: new Date().toISOString(),
    };
    const file = this.todayFile();
    this.currentlyPublishing = true;
    try {
      await appendFile(file, JSON.stringify(envelope) + '\n');
    } finally {
      this.currentlyPublishing = false;
    }
    // Dispatch to in-process subscribers immediately
    await this.dispatch(envelope);
    // Update offset past our own write so poll doesn't re-dispatch
    await this.seedOffset(file);
    return id;
  }

  subscribe(kinds: EventKind[] | '*', handler: EventHandler): Subscription {
    const sub: Subscription = { id: ulid(), kinds, handler };
    this.subscriptions.set(sub.id, sub);
    return sub;
  }

  unsubscribe(id: string): void {
    this.subscriptions.delete(id);
  }

  async replay(opts?: { since?: string; kinds?: EventKind[] }): Promise<EventEnvelope[]> {
    const files = await this.listEventFiles();
    const events: EventEnvelope[] = [];

    for (const file of files) {
      const lines = await this.readLines(file);
      for (const line of lines) {
        const event = this.parseLine(line);
        if (!event) continue;
        if (opts?.since && event.timestamp < opts.since) continue;
        if (opts?.kinds && !opts.kinds.includes(event.kind)) continue;
        events.push(event);
      }
    }

    return events.sort((a, b) => a.id.localeCompare(b.id));
  }

  async close(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.subscriptions.clear();
  }

  async pruneOldEvents(): Promise<void> {
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000);
    let files: string[];
    try {
      files = await readdir(this.eventsDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const dateStr = f.replace('.jsonl', '');
      if (new Date(dateStr) < cutoff) {
        await unlink(join(this.eventsDir, f));
      }
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private startWatching(): void {
    this.pollInterval = setInterval(() => this.tailNewEvents(), this.pollMs);
  }

  private async tailNewEvents(): Promise<void> {
    if (this.currentlyPublishing) return;

    const file = this.todayFile();
    let fileSize: number;
    try {
      const s = await stat(file);
      fileSize = s.size;
    } catch {
      return; // file doesn't exist yet
    }

    const offset = this.lastOffset.get(file) ?? 0;
    if (fileSize <= offset) return;

    try {
      const buf = await readFile(file);
      const newData = buf.subarray(offset);
      this.lastOffset.set(file, fileSize);

      const lines = newData.toString('utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        const event = this.parseLine(line);
        if (event) {
          await this.dispatch(event);
        }
      }
    } catch (err) {
      logger.warn({ err }, '[event-bus] Error tailing event file');
    }
  }

  private async dispatch(event: EventEnvelope): Promise<void> {
    for (const sub of this.subscriptions.values()) {
      const kindsMatch = sub.kinds === '*' || sub.kinds.includes(event.kind);
      const instanceMatch = !sub.instance || sub.instance === event.source;
      if (kindsMatch && instanceMatch) {
        try {
          await sub.handler(event);
        } catch (err) {
          logger.error({ err, eventId: event.id }, '[event-bus] Event handler error');
        }
      }
    }
  }

  private todayFile(): string {
    return join(this.eventsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  private async seedOffset(file: string): Promise<void> {
    try {
      const s = await stat(file);
      this.lastOffset.set(file, s.size);
    } catch {
      this.lastOffset.set(file, 0);
    }
  }

  private parseLine(line: string): EventEnvelope | null {
    try {
      return JSON.parse(line) as EventEnvelope;
    } catch {
      return null;
    }
  }

  private async readLines(file: string): Promise<string[]> {
    try {
      const content = await readFile(file, 'utf-8');
      return content.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  private async listEventFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.eventsDir);
      return files
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .map(f => join(this.eventsDir, f));
    } catch {
      return [];
    }
  }
}
