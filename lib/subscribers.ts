/**
 * Email subscribers storage (file-based).
 *
 * MVP: persisted to data/subscribers.json. Same pattern as debug_sessions.json.
 * When volume grows or we need queries across fields, migrate to Postgres.
 *
 * Each subscriber stores a snapshot of their profile at signup time so a future
 * digest sender can personalize without needing a live user session.
 */

import fs from 'fs';
import path from 'path';
import type { ChildProfile } from './types';

const SUBS_PATH = path.join(process.cwd(), 'data', 'subscribers.json');

export interface SubscriberProfile {
  children: ChildProfile[];
  neighborhoods: string[];
  budget: string;
  specialNeeds?: string;
}

export interface Subscriber {
  id: number;
  email: string;
  signed_up_at: string;             // ISO
  updated_at: string;               // ISO — bumped whenever we upsert
  source: 'chat_onboarding' | 'quiz_onboarding' | 'favorites_panel' | 'other';
  profile: SubscriberProfile;
  referrer_url?: string;
  // Delivery bookkeeping — future digest sender will read/write these.
  welcome_sent_at: string | null;
  last_digest_sent_at: string | null;
  unsubscribed_at: string | null;
}

interface SubscribersFile {
  next_id: number;
  subscribers: Subscriber[];
}

function readFile(): SubscribersFile {
  try {
    if (!fs.existsSync(SUBS_PATH)) {
      return { next_id: 1, subscribers: [] };
    }
    const raw = fs.readFileSync(SUBS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { next_id: 1, subscribers: [] };
    return {
      next_id: parsed.next_id ?? 1,
      subscribers: Array.isArray(parsed.subscribers) ? parsed.subscribers : [],
    };
  } catch {
    return { next_id: 1, subscribers: [] };
  }
}

function writeFile(data: SubscribersFile) {
  // Ensure data/ dir exists (first run, fresh deploy).
  const dir = path.dirname(SUBS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SUBS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  // Intentionally simple — we bounce-check later via Resend. This just filters
  // obvious garbage like "asdf" or empty strings.
  const e = email.trim();
  if (e.length < 5 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/**
 * Insert a new subscriber or update an existing one (matched by email,
 * case-insensitive). We always refresh the profile snapshot on upsert so the
 * latest state is what the digest sender sees.
 *
 * Returns:
 *   { subscriber, created: true }  → new row
 *   { subscriber, created: false } → existing row refreshed
 */
export function upsertSubscriber(input: {
  email: string;
  source: Subscriber['source'];
  profile: SubscriberProfile;
  referrer_url?: string;
}): { subscriber: Subscriber; created: boolean } {
  const data = readFile();
  const email = normalizeEmail(input.email);
  const now = new Date().toISOString();

  const existing = data.subscribers.find((s) => normalizeEmail(s.email) === email);
  if (existing) {
    existing.profile = input.profile;
    existing.updated_at = now;
    if (input.referrer_url) existing.referrer_url = input.referrer_url;
    // Resurrect if they previously unsubscribed and now opt back in.
    existing.unsubscribed_at = null;
    writeFile(data);
    return { subscriber: existing, created: false };
  }

  const sub: Subscriber = {
    id: data.next_id,
    email,
    signed_up_at: now,
    updated_at: now,
    source: input.source,
    profile: input.profile,
    referrer_url: input.referrer_url,
    welcome_sent_at: null,
    last_digest_sent_at: null,
    unsubscribed_at: null,
  };
  data.subscribers.push(sub);
  data.next_id = data.next_id + 1;
  writeFile(data);
  return { subscriber: sub, created: true };
}

export function listSubscribers(): Subscriber[] {
  return readFile().subscribers.slice().sort((a, b) => b.id - a.id);
}

export function countSubscribers(): number {
  return readFile().subscribers.length;
}
