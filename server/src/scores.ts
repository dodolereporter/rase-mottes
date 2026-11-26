// Classement : SQLite + jetons de manche signés (anti-triche raisonnable).

import Database from 'better-sqlite3';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GAME_MODES, GameMode, sanitizeName } from '../../shared/protocol';
import { dailySeed } from '../../shared/prng';

export interface ScoreRow {
  id: number;
  mode: GameMode;
  seed: number;
  name: string;
  distance: number;
  score: number;
  best_combo: number;
  duration: number;
  created_at: string;
}

export class ScoreStore {
  private db: Database.Database;
  private usedNonces = new Map<string, number>();

  constructor(
    dataDir: string,
    private secret: string,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'rase-mottes.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        seed INTEGER NOT NULL,
        name TEXT NOT NULL,
        distance REAL NOT NULL,
        score INTEGER NOT NULL,
        best_combo INTEGER NOT NULL,
        duration REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS scores_mode_seed_score ON scores(mode, seed, score DESC);
      CREATE INDEX IF NOT EXISTS scores_mode_score ON scores(mode, score DESC);
    `);
  }

  close() {
    this.db.close();
  }

  ping(): boolean {
    return this.db.prepare('SELECT 1 AS ok').get() !== undefined;
  }

  // ----- jetons ---------------------------------------------------------------

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issueToken(mode: GameMode, seed: number, now = Date.now()): string {
    const payload = Buffer.from(JSON.stringify({ m: mode, s: seed >>> 0, t: now, n: randomBytes(8).toString('hex') })).toString(
      'base64url',
    );
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token: unknown): { m: GameMode; s: number; t: number; n: string } | null {
    if (typeof token !== 'string' || token.length > 400) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  // ----- scores ---------------------------------------------------------------

  submit(body: unknown, now = Date.now()): { ok: true; id: number; rank: number } | { ok: false; error: string } {
    if (!body || typeof body !== 'object') return { ok: false, error: 'bad_request' };
    const b = body as Record<string, unknown>;
    const tok = this.verifyToken(b.token);
    if (!tok) return { ok: false, error: 'bad_token' };
    if (this.usedNonces.has(tok.n)) return { ok: false, error: 'token_used' };
    const name = sanitizeName(b.name);
    if (!name) return { ok: false, error: 'bad_name' };
    const distance = Number(b.distance);
    const score = Math.floor(Number(b.score));
    const bestCombo = Math.floor(Number(b.bestCombo));
    const duration = Number(b.duration);
    if (![distance, score, bestCombo, duration].every(Number.isFinite)) return { ok: false, error: 'bad_request' };
    if (distance < 0 || duration <= 0 || score < 0 || bestCombo < 1 || bestCombo > 25) return { ok: false, error: 'bad_values' };

    // cohérence temporelle : la manche ne peut pas avoir duré plus longtemps que le jeton n'a existé
    // (marge pour ralenti / pauses : la durée déclarée est en temps de jeu, toujours ≤ temps réel)
    const elapsed = (now - tok.t) / 1000;
    if (elapsed < 0 || elapsed > 6 * 3600) return { ok: false, error: 'token_expired' };
    if (duration > elapsed + 2) return { ok: false, error: 'bad_duration' };
    // vitesse max ≈ 235 m/s × 1,5 (boost) : on laisse une marge
    if (distance > duration * 360 + 50) return { ok: false, error: 'bad_distance' };
    // vitesse min : 60 m/s × 0,55 (aérofrein) × 0,6 (ralenti)
    if (distance < duration * 15 - 50) return { ok: false, error: 'bad_distance' };
    // score : distance ×2 au plus + bonus plafonnés
    if (score > distance * 2 + duration * 6000 + 1000) return { ok: false, error: 'bad_score' };
    if (tok.m === 'daily') {
      const okSeeds = [dailySeed(new Date(tok.t)), dailySeed(new Date(tok.t - 3600_000))];
      if (!okSeeds.includes(tok.s)) return { ok: false, error: 'bad_seed' };
    }
    this.usedNonces.set(tok.n, now);
    if (this.usedNonces.size > 50_000) {
      for (const [k, t] of this.usedNonces) if (now - t > 7 * 3600_000) this.usedNonces.delete(k);
    }
    const info = this.db
      .prepare('INSERT INTO scores (mode, seed, name, distance, score, best_combo, duration) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tok.m, tok.s, name, Math.round(distance * 10) / 10, score, bestCombo, Math.round(duration * 100) / 100);
    const id = Number(info.lastInsertRowid);
    return { ok: true, id, rank: this.rankOf(tok.m, tok.s, score) };
  }

  rankOf(mode: GameMode, seed: number, score: number): number {
    const row =
      mode === 'daily'
        ? this.db.prepare('SELECT COUNT(*) AS c FROM scores WHERE mode = ? AND seed = ? AND score > ?').get(mode, seed, score)
        : this.db.prepare('SELECT COUNT(*) AS c FROM scores WHERE mode = ? AND score > ?').get(mode, score);
    return (row as { c: number }).c + 1;
  }

  leaderboard(mode: string | undefined, seed: number | undefined, limit = 20): Omit<ScoreRow, 'seed'>[] {
    const m = (GAME_MODES as string[]).includes(mode ?? '') ? (mode as GameMode) : 'solo';
    const lim = Math.max(1, Math.min(100, limit));
    const cols = 'id, mode, name, distance, score, best_combo, duration, created_at';
    if (m === 'daily' || seed !== undefined) {
      const s = seed ?? dailySeed();
      return this.db
        .prepare(`SELECT ${cols} FROM scores WHERE mode = ? AND seed = ? ORDER BY score DESC, id ASC LIMIT ?`)
        .all(m, s >>> 0, lim) as ScoreRow[];
    }
    return this.db.prepare(`SELECT ${cols} FROM scores WHERE mode = ? ORDER BY score DESC, id ASC LIMIT ?`).all(m, lim) as ScoreRow[];
  }
}

/** Limiteur simple par IP (fenêtre glissante). */
export class IpLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  allow(ip: string, now = Date.now()): boolean {
    const arr = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(ip, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(ip, arr);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}
