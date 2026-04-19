import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

interface PendingEntry {
  id: string;
  customer_id: string;
  minutes: number;
  description: string | null;
  entry_date: string;
  billable: boolean;
  client_created_at: number;
  synced_at: number | null;
}

interface TimerState {
  id: 'singleton';
  running: boolean;
  customer_id: string | null;
  description: string;
  billable: boolean;
  started_at: number | null;
}

interface TimeDBSchema extends DBSchema {
  pending: {
    key: string;
    value: PendingEntry;
    indexes: { 'by-synced': number };
  };
  timer: {
    key: 'singleton';
    value: TimerState;
  };
}

const DB_NAME = 'mybooks-time';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<TimeDBSchema>> | null = null;

function getDB(): Promise<IDBPDatabase<TimeDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<TimeDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('pending')) {
          const s = db.createObjectStore('pending', { keyPath: 'id' });
          s.createIndex('by-synced', 'synced_at');
        }
        if (!db.objectStoreNames.contains('timer')) {
          db.createObjectStore('timer', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

export function newEntryId(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `te_${hex}`;
}

export async function queueEntry(entry: Omit<PendingEntry, 'id' | 'synced_at' | 'client_created_at'> & { id?: string }): Promise<PendingEntry> {
  const db = await getDB();
  const record: PendingEntry = {
    id: entry.id ?? newEntryId(),
    customer_id: entry.customer_id,
    minutes: entry.minutes,
    description: entry.description,
    entry_date: entry.entry_date,
    billable: entry.billable,
    client_created_at: Date.now(),
    synced_at: null,
  };
  await db.put('pending', record);
  return record;
}

export async function listPending(): Promise<PendingEntry[]> {
  const db = await getDB();
  const all = await db.getAll('pending');
  return all.sort((a, b) => b.client_created_at - a.client_created_at);
}

export async function listUnsynced(): Promise<PendingEntry[]> {
  const all = await listPending();
  return all.filter((e) => e.synced_at == null);
}

export async function markSynced(id: string, when: number = Date.now()): Promise<void> {
  const db = await getDB();
  const existing = await db.get('pending', id);
  if (!existing) return;
  existing.synced_at = when;
  await db.put('pending', existing);
}

export async function removeEntry(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('pending', id);
}

export async function getTimer(): Promise<TimerState> {
  const db = await getDB();
  const row = await db.get('timer', 'singleton');
  return row ?? { id: 'singleton', running: false, customer_id: null, description: '', billable: true, started_at: null };
}

export async function saveTimer(state: Omit<TimerState, 'id'>): Promise<void> {
  const db = await getDB();
  await db.put('timer', { id: 'singleton', ...state });
}

export async function clearTimer(): Promise<void> {
  await saveTimer({ running: false, customer_id: null, description: '', billable: true, started_at: null });
}
