import './host.css';
import QRCode from 'qrcode';
import {
  GAME_MODES,
  GameMode,
  HostToPad,
  MODE_LABEL,
  PLAYER_COLORS,
  PadToHost,
  Phase,
} from '../../../shared/protocol';
import { dailySeed, parisDateString } from '../../../shared/prng';
import { Pilot, PilotInput, SIM_DT, SimEvent } from '../../../shared/sim';
import { DISTRICT_LEN, DISTRICT_NAMES, World, clamp } from '../../../shared/world';
import { AudioEngine } from './audio';
import { GameRenderer } from './game/renderer';
import { LocalInput } from './localInput';
import { HostNet } from './net';

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const ROUNDS = 3;
const KEYBOARD = -1;

const ui = document.getElementById('ui')!;
const canvas = document.getElementById('gl') as HTMLCanvasElement;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number) => Math.floor(n).toLocaleString('fr-FR');
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* quota / navigation privée */
    }
  },
};

interface LeaderEntry {
  name: string;
  score: number;
  distance: number;
  best_combo: number;
}

interface RunResult {
  distance: number;
  score: number;
  bestCombo: number;
  grazes: number;
  maxSpeed: number;
  rings: number;
  perfects: number;
  duration: number;
  rank?: number;
  personalBest: boolean;
  name: string;
}

class HostApp {
  net: HostNet;
  audio = new AudioEngine();
  local = new LocalInput();
  renderer: GameRenderer;
  world = new World(1);
  pilots: Pilot[] = [];
  /** emplacement de manette pour chaque pilote (KEYBOARD = clavier) */
  owners: number[] = [];
  phase: Phase = 'lobby';
  mode: GameMode = 'solo';
  seed = 1;
  simTime = 0;
  acc = 0;
  countdownT = 0;
  countdownTotal = 0;
  lastCountBeep = -1;
  crashSlowmo = 0;
  endTimer = -1;
  autoPaused = false;
  pauseInfo = '';
  round = 0;
  partyTotals = new Map<number, { dist: number; wins: number }>();
  lastRoundDist: number[] = [];
  runToken: Promise<string | null> = Promise.resolve(null);
  lastResult: RunResult | null = null;
  leaderboard: LeaderEntry[] = [];
  ghostRec: number[] = [];
  ghostLoaded: number[] | null = null;
  lastDistrict = -1;
  lastFrame = performance.now();
  boostTimer = 0;
  lobbyDirty = true;
  qrSvg = '';
  roomCode = '';
  padUrl = '';
  private hudEls: Record<string, HTMLElement> = {};

  constructor() {
    this.renderer = new GameRenderer(canvas, this.world, DEBUG);
    this.net = new HostNet({
      onRoom: async (code, url) => {
        this.roomCode = code;
        this.padUrl = url;
        this.qrSvg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#05040c', light: '#ffffff' } });
        this.lobbyDirty = true;
        this.renderScreen();
      },
      onPadJoin: (slot) => {
        this.audio.blip([660, 990], 'triangle', 0.07, 0.12);
        this.sendState(slot);
        this.lobbyDirty = true;
        this.renderScreen();
      },
      onPadLeave: () => {
        this.lobbyDirty = true;
        if (this.phase === 'lobby' || this.phase === 'over' || this.phase === 'partyOver') this.renderScreen();
      },
      onPadMessage: (slot, m) => this.onPadMessage(slot, m),
      onDisconnect: () => {
        this.roomCode = '';
        this.qrSvg = '';
        this.toLobby();
      },
    });
    this.net.connect();
    this.setupPreview();
    this.bindKeys();
    this.fetchLeaderboard();
    this.renderScreen();
    requestAnimationFrame((t) => this.frame(t));
    (window as unknown as Record<string, unknown>).__game = this;
  }

  // ------------------------------------------------------------------------
  // Messages des manettes
  // ------------------------------------------------------------------------

  private onPadMessage(slot: number, m: PadToHost) {
    const pad = this.net.pads[slot];
    switch (m.t) {
      case 'hello':
      case 'name':
        this.lobbyDirty = true;
        if (this.phase === 'lobby') this.renderScreen();
        break;
      case 'mode':
        if (GAME_MODES.includes(m.mode) && (this.phase === 'lobby' || this.phase === 'over' || this.phase === 'partyOver')) {
          this.setMode(m.mode);
          if (this.phase !== 'lobby') this.toLobby();
        }
        break;
      case 'ready':
        if (this.phase !== 'lobby') break;
        if (this.mode === 'party') {
          pad.ready = true;
          this.lobbyDirty = true;
          this.renderScreen();
          this.tryStartParty();
          this.broadcastState();
        } else this.startRun(slot, false);
        break;
      case 'replay':
        if (this.phase === 'over') this.startRun(slot, true);
        else if (this.phase === 'partyOver') this.startParty();
        else if (this.phase === 'lobby') this.onPadMessage(slot, { t: 'ready' });
        break;
      case 'menu':
        if (this.phase === 'over' || this.phase === 'partyOver' || this.phase === 'paused') this.toLobby();
        break;
      case 'pause':
        this.togglePause();
        break;
    }
  }

  private setMode(mode: GameMode) {
    this.mode = mode;
    for (const p of this.net.pads) p.ready = false;
    this.lobbyDirty = true;
    this.fetchLeaderboard();
    this.renderScreen();
    this.broadcastState();
  }

  private isPilot(slot: number) {
    return this.owners.includes(slot) && (this.phase === 'playing' || this.phase === 'countdown' || this.phase === 'paused');
  }

  private stateInfo(): string | undefined {
    if (this.phase === 'lobby' && this.mode === 'party') {
      const con = this.net.pads.filter((p) => p.connected);
      const r = con.filter((p) => p.ready).length;
      return con.length < 2 ? 'Il faut au moins 2 manettes connectées.' : `${r}/${con.length} prêts`;
    }
    if (this.phase === 'paused') return this.pauseInfo;
    if (this.phase === 'roundOver') return `Manche ${this.round}/${ROUNDS} terminée`;
    return undefined;
  }

  private sendState(slot: number) {
    const pad = this.net.pads[slot];
    if (!pad.connected) return;
    this.net.send(slot, {
      t: 'state',
      phase: this.phase,
      mode: this.mode,
      pilot: this.isPilot(slot),
      ready: pad.ready,
      info: this.stateInfo(),
      round: this.mode === 'party' ? this.round : undefined,
      rounds: this.mode === 'party' ? ROUNDS : undefined,
    });
  }

  broadcastState() {
    for (const p of this.net.pads) this.sendState(p.slot);
  }

  private haptic(owner: number, p: Extract<HostToPad, { t: 'haptic' }>['p']) {
    if (owner >= 0) this.net.send(owner, { t: 'haptic', p });
  }

  // ------------------------------------------------------------------------
  // Déroulement des parties
  // ------------------------------------------------------------------------

  /** Aperçu animé derrière l'écran d'accueil : un missile en pilote automatique. */
  private setupPreview() {
    this.world = new World((Math.random() * 2 ** 32) >>> 0);
    this.renderer.setWorld(this.world);
    const p = new Pilot(this.world);
    this.pilots = [p];
    this.owners = [];
    this.renderer.setPilots([{ pilot: p, color: PLAYER_COLORS[0] }]);
    this.simTime = 0;
  }

  private newWorld(seed: number) {
    this.seed = seed >>> 0;
    this.world = new World(this.seed);
    this.renderer.setWorld(this.world);
    this.simTime = 0;
    this.acc = 0;
  }

  startRun(slot: number, replay: boolean) {
    if (this.mode === 'party') return;
    this.audio.unlock();
    const seed = this.mode === 'daily' ? dailySeed() : (Math.random() * 2 ** 32) >>> 0;
    this.newWorld(seed);
    const p = new Pilot(this.world);
    this.pilots = [p];
    this.owners = [slot];
    this.renderer.setPilots([{ pilot: p, color: slot >= 0 ? PLAYER_COLORS[slot] : PLAYER_COLORS[0] }], this.mode === 'daily');
    this.ghostRec = [];
    this.ghostLoaded = null;
    if (this.mode === 'daily') {
      try {
        const g = JSON.parse(store.get(`rm_ghost_${seed}`) ?? 'null');
        if (g && Array.isArray(g.f)) this.ghostLoaded = g.f;
      } catch {
        /* */
      }
    }
    this.runToken = fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: this.mode, seed: this.seed }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.token ?? null)
      .catch(() => null);
    this.lastDistrict = -1;
    this.startCountdown(replay ? 0.9 : 2.4);
  }

  private tryStartParty() {
    const con = this.net.pads.filter((p) => p.connected);
    if (con.length >= 2 && con.every((p) => p.ready)) this.startParty();
  }

  startParty() {
    const con = this.net.pads.filter((p) => p.connected).map((p) => p.slot);
    if (con.length < 2) {
      this.toLobby();
      return;
    }
    this.audio.unlock();
    this.owners = con;
    this.round = 0;
    this.partyTotals = new Map(con.map((s) => [s, { dist: 0, wins: 0 }]));
    this.startRound();
  }

  private startRound() {
    this.round++;
    this.newWorld((Math.random() * 2 ** 32) >>> 0);
    this.owners = this.owners.filter((s) => this.net.pads[s].connected || this.net.pads[s].reserved);
    this.pilots = this.owners.map(() => new Pilot(this.world));
    this.renderer.setPilots(
      this.pilots.map((pilot, i) => ({ pilot, color: PLAYER_COLORS[this.owners[i]], label: this.net.pads[this.owners[i]].name })),
    );
    this.lastDistrict = -1;
    this.startCountdown(this.round === 1 ? 2.4 : 1.6);
  }

  private startCountdown(sec: number) {
    this.phase = 'countdown';
    this.countdownT = sec;
    this.countdownTotal = sec;
    this.lastCountBeep = -1;
    this.endTimer = -1;
    this.crashSlowmo = 0;
    this.autoPaused = false;
    for (const s of this.owners) if (s >= 0) this.net.send(s, { t: 'calibrate' });
    this.broadcastState();
    this.renderScreen();
  }

  togglePause() {
    if (this.phase === 'playing') this.pause(false, 'Pause');
    else if (this.phase === 'paused') this.startCountdown(1);
  }

  private pause(auto: boolean, info: string) {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.autoPaused = auto;
    this.pauseInfo = info;
    this.broadcastState();
    this.renderScreen();
  }

  toLobby() {
    this.phase = 'lobby';
    this.owners = [];
    for (const p of this.net.pads) p.ready = false;
    this.setupPreview();
    this.fetchLeaderboard();
    this.lobbyDirty = true;
    this.renderScreen();
    this.broadcastState();
  }

  private async finishRun() {
    const p = this.pilots[0];
    const owner = this.owners[0];
    const name = owner >= 0 ? this.net.pads[owner].name : store.get('rm_host_name') ?? 'Pilote';
    const key = this.mode === 'daily' ? `rm_best_daily_${this.seed}` : 'rm_best_solo';
    const prevBest = Number(store.get(key) ?? 0);
    const score = p.totalScore;
    const res: RunResult = {
      distance: p.z,
      score,
      bestCombo: p.bestCombo,
      grazes: p.grazes,
      maxSpeed: p.maxSpeed,
      rings: p.rings,
      perfects: p.perfects,
      duration: p.time,
      personalBest: score > prevBest,
      name,
    };
    if (res.personalBest) store.set(key, String(score));
    if (this.mode === 'daily') {
      try {
        const g = JSON.parse(store.get(`rm_ghost_${this.seed}`) ?? 'null');
        if (!g || g.d < p.z) store.set(`rm_ghost_${this.seed}`, JSON.stringify({ d: p.z, f: this.ghostRec }));
      } catch {
        /* */
      }
    }
    this.lastResult = res;
    this.phase = 'over';
    this.broadcastState();
    this.renderScreen();
    if (owner >= 0) this.net.send(owner, { t: 'result', distance: res.distance, score: res.score, best: res.personalBest });
    // envoi au classement
    const token = await this.runToken;
    if (token) {
      try {
        const r = await fetch('/api/scores', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, name, distance: p.z, score, bestCombo: p.bestCombo, duration: p.time }),
        });
        if (r.ok) {
          const j = await r.json();
          res.rank = j.rank;
          if (owner >= 0) this.net.send(owner, { t: 'result', distance: res.distance, score: res.score, rank: j.rank, best: res.personalBest });
        }
      } catch {
        /* hors ligne : pas de classement */
      }
    }
    await this.fetchLeaderboard();
    if (this.phase === 'over' && this.lastResult === res) this.renderScreen();
  }

  private finishRound() {
    const dists = this.pilots.map((p) => p.z);
    this.lastRoundDist = dists;
    let best = 0;
    dists.forEach((d, i) => (d > dists[best] ? (best = i) : 0));
    this.owners.forEach((s, i) => {
      const t = this.partyTotals.get(s) ?? { dist: 0, wins: 0 };
      t.dist += dists[i];
      if (i === best) t.wins++;
      this.partyTotals.set(s, t);
    });
    if (this.round >= ROUNDS) {
      this.phase = 'partyOver';
      // résultat individuel sur chaque téléphone
      this.owners.forEach((s) => {
        const t = this.partyTotals.get(s)!;
        const rank = [...this.partyTotals.values()].filter((o) => o.dist > t.dist).length + 1;
        this.net.send(s, { t: 'result', distance: t.dist, score: Math.floor(t.dist), rank });
      });
    } else {
      this.phase = 'roundOver';
      this.endTimer = 4.5;
    }
    this.broadcastState();
    this.renderScreen();
  }

  async fetchLeaderboard() {
    try {
      const q = this.mode === 'daily' ? `mode=daily&seed=${dailySeed()}` : `mode=solo`;
      const r = await fetch(`/api/leaderboard?${q}&limit=10`);
      if (r.ok) this.leaderboard = (await r.json()).entries;
    } catch {
      this.leaderboard = [];
    }
    if (this.phase === 'lobby') {
      this.lobbyDirty = true;
      this.renderScreen();
    }
  }

  // ------------------------------------------------------------------------
  // Boucle principale
  // ------------------------------------------------------------------------

  private inputFor(i: number, local: PilotInput & { active: boolean }): PilotInput {
    const owner = this.owners[i];
    if (this.mode === 'party') {
      const pad = this.net.pads[owner];
      // manette perdue : le missile vole droit
      if (!pad || !this.net.isFresh(owner, 250)) return { x: 0, y: 0, boost: false, brake: false };
      return { x: pad.x, y: pad.y, boost: pad.boost, brake: pad.brake };
    }
    let x = local.x;
    let y = local.y;
    let boost = local.boost;
    let brake = local.brake;
    if (owner >= 0) {
      const pad = this.net.pads[owner];
      if (this.net.isFresh(owner, 250)) {
        x = clamp(x + pad.x, -1, 1);
        y = clamp(y + pad.y, -1, 1);
        boost ||= pad.boost;
        brake ||= pad.brake;
      }
    }
    return { x, y, boost, brake };
  }

  private autopilot(p: Pilot): PilotInput {
    const ahead = this.world.pathAt(p.z + p.speed * 0.35);
    return {
      x: clamp((ahead.x - p.x) / 6, -1, 1) * 0.8,
      y: clamp((ahead.y - p.y) / 6, -1, 1) * 0.8,
      boost: false,
      brake: false,
    };
  }

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    const realDt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const local = this.local.read(realDt);
    if (this.local.startPressed()) this.onStartKey();

    let alpha = 1;
    if (this.phase === 'lobby') {
      // démo en arrière-plan
      const p = this.pilots[0];
      if (p) {
        this.acc += realDt;
        let steps = 0;
        while (this.acc >= SIM_DT && steps++ < 12) {
          p.step(SIM_DT, this.autopilot(p), this.simTime, []);
          this.simTime += SIM_DT;
          this.acc -= SIM_DT;
        }
        if (!p.alive || p.z > 6000) this.setupPreview();
        alpha = this.acc / SIM_DT;
      }
    } else if (this.phase === 'countdown') {
      this.countdownT -= realDt;
      const n = Math.ceil(this.countdownT);
      if (n !== this.lastCountBeep && n >= 0) {
        this.lastCountBeep = n;
        this.audio.countdown(n === 0);
        this.renderScreen();
      }
      if (this.countdownT <= 0) {
        this.phase = 'playing';
        this.acc = 0;
        this.broadcastState();
        this.renderScreen();
      }
      for (const p of this.pilots) p.prev = { x: p.x, y: p.y, z: p.z };
    } else if (this.phase === 'playing') {
      this.stepPlaying(realDt, local);
      alpha = this.acc / SIM_DT;
    } else if (this.phase === 'paused') {
      const owner = this.owners[0];
      if (this.autoPaused && this.mode !== 'party' && owner >= 0 && this.net.isFresh(owner, 120)) this.startCountdown(1);
    } else if (this.phase === 'roundOver') {
      this.endTimer -= realDt;
      if (this.endTimer <= 0) this.startRound();
    }

    // jauge de boost vers les téléphones (10 Hz)
    this.boostTimer -= realDt;
    if (this.boostTimer <= 0 && (this.phase === 'playing' || this.phase === 'countdown')) {
      this.boostTimer = 0.1;
      this.pilots.forEach((p, i) => {
        const o = this.owners[i];
        if (o >= 0) this.net.send(o, { t: 'boost', v: Math.round(p.boost * 100) / 100 });
      });
    }

    const p0 = this.pilots[0];
    const flying = this.phase === 'playing' && !!p0 && p0.alive;
    const ts = this.phase === 'playing' ? (this.crashSlowmo > 0 ? 0.3 : 1) * (this.mode !== 'party' && p0 ? p0.timeScale : 1) : 1;
    this.audio.update(p0 ? clamp((p0.speed - 60) / 220, 0, 1) : 0, !!p0?.boosting, flying || this.phase === 'lobby', ts);

    this.renderer.render(Math.min(1, alpha), realDt * ts, this.simTime, this.mode === 'daily' ? (i) => this.ghostAt(i) : undefined);
    this.updateHud();
  }

  private stepPlaying(realDt: number, local: PilotInput & { active: boolean }) {
    const solo = this.mode !== 'party';
    const owner = this.owners[0];
    // solo : pause automatique si la manette ne répond plus
    if (solo && owner >= 0 && !this.net.isFresh(owner, 500) && performance.now() - this.local.lastActive > 500 && this.pilots[0].alive) {
      this.pause(true, this.net.pads[owner].connected ? 'Manette inactive…' : 'Manette déconnectée, reconnexion…');
      return;
    }
    if (document.visibilityState !== 'visible') {
      if (solo) this.pause(false, 'Pause');
      return;
    }
    if (this.crashSlowmo > 0) this.crashSlowmo -= realDt;
    const p0 = this.pilots[0];
    const ts = (this.crashSlowmo > 0 ? 0.3 : 1) * (solo ? p0.timeScale : 1);
    this.acc += realDt * ts;
    let steps = 0;
    const events: SimEvent[] = [];
    while (this.acc >= SIM_DT && steps++ < 14) {
      this.pilots.forEach((p, i) => {
        if (!p.alive) return;
        events.length = 0;
        const dt = solo ? SIM_DT : SIM_DT * p.timeScale;
        p.step(dt, this.inputFor(i, local), this.simTime, events);
        for (const e of events) this.onSimEvent(i, e);
      });
      this.simTime += SIM_DT;
      this.acc -= SIM_DT;
      // fantôme : positions à 20 Hz
      if (this.mode === 'daily' && p0.alive && this.ghostRec.length / 3 < p0.time * 20) {
        this.ghostRec.push(Math.round(p0.x * 10) / 10, Math.round(p0.y * 10) / 10, Math.round(p0.z * 10) / 10);
      }
    }
    if (steps >= 14) this.acc = 0;

    // changement de quartier
    const d = this.world.districtIndexAt(p0.z);
    const k = Math.floor(p0.z / DISTRICT_LEN);
    if (k !== this.lastDistrict) {
      this.lastDistrict = k;
      this.showBanner(DISTRICT_NAMES[d]);
    }

    if (this.pilots.every((p) => !p.alive)) {
      if (this.endTimer < 0) this.endTimer = solo ? 1.4 : 1.8;
      this.endTimer -= realDt;
      if (this.endTimer <= 0) {
        this.endTimer = -1;
        if (solo) void this.finishRun();
        else this.finishRound();
      }
    }
  }

  private ghostAt(i: number) {
    if (i !== 0 || !this.ghostLoaded || !this.pilots[0]) return null;
    const g = this.ghostLoaded;
    const f = this.pilots[0].time * 20;
    const k = Math.floor(f);
    if ((k + 1) * 3 + 2 >= g.length) return null;
    const t = f - k;
    const lerp = (j: number) => g[k * 3 + j] + (g[(k + 1) * 3 + j] - g[k * 3 + j]) * t;
    return { x: lerp(0), y: lerp(1), z: lerp(2) };
  }

  private onSimEvent(i: number, e: SimEvent) {
    const owner = this.owners[i];
    const view = this.renderer.viewRectsCss()[i];
    switch (e.type) {
      case 'graze':
        this.audio.graze(e.side);
        if (!e.ground) this.renderer.sparks(i, e.side);
        this.renderer.kick(i, 0.35, 0.08, [1, 0.85, 0.3]);
        this.haptic(owner, 'graze');
        this.popup(view, e.ground ? `RASE-MOTTES +${e.pts}` : `FRÔLÉ +${e.pts}`, e.ground ? '#4f8a3c' : '#ff5a36', e.side);
        break;
      case 'ring':
        this.audio.ring(e.perfect);
        this.renderer.kick(i, 0.1, e.perfect ? 0.2 : 0.08, [1, 0.9, 0.4]);
        this.haptic(owner, 'ring');
        this.popup(view, e.perfect ? `PARFAIT +${e.pts}` : `+${e.pts}`, '#c98a00', 0);
        break;
      case 'pickup':
        this.audio.pickup();
        this.haptic(owner, 'bonus');
        this.popup(view, e.kind === 'shield' ? 'BOUCLIER' : e.kind === 'slowmo' ? 'RALENTI' : 'AIMANT', '#2f5bff', 0);
        break;
      case 'shieldHit':
        this.audio.shieldHit();
        this.renderer.kick(i, 1, 0.5, [0.3, 0.8, 1]);
        this.haptic(owner, 'crash');
        this.popup(view, 'BOUCLIER BRISÉ', '#2f5bff', 0);
        break;
      case 'brake':
        this.audio.brake();
        break;
      case 'crash':
        this.audio.crash();
        this.renderer.explode(i);
        this.haptic(owner, 'crash');
        if (this.mode !== 'party') this.crashSlowmo = 0.3;
        break;
    }
  }

  private onStartKey() {
    this.audio.unlock();
    if (this.phase === 'lobby' && this.mode !== 'party') this.startRun(KEYBOARD, false);
    else if (this.phase === 'over') this.startRun(this.owners[0] ?? KEYBOARD, true);
    else if (this.phase === 'partyOver') this.startParty();
  }

  private bindKeys() {
    const unlock = () => {
      this.audio.unlock();
      this.renderScreen();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', (e) => {
      this.audio.unlock();
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'Enter' || (e.code === 'Space' && this.phase !== 'playing')) {
        e.preventDefault();
        this.onStartKey();
      } else if (e.code === 'Escape') {
        if (this.phase === 'playing') this.togglePause();
        else if (this.phase !== 'lobby') this.toLobby();
      } else if (e.code === 'KeyP') this.togglePause();
      else if (e.code === 'KeyM') this.audio.setMuted(!this.audio.muted);
      else if (['Digit1', 'Digit2', 'Digit3'].includes(e.code) && (this.phase === 'lobby' || this.phase === 'over')) {
        this.setMode(GAME_MODES[Number(e.code.slice(5)) - 1]);
        if (this.phase !== 'lobby') this.toLobby();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' && this.phase === 'playing' && this.mode !== 'party') this.pause(false, 'Pause');
    });
  }

  // ------------------------------------------------------------------------
  // Interface
  // ------------------------------------------------------------------------

  private bannerTimer = 0;
  private showBanner(text: string) {
    const b = this.hudEls.banner;
    if (!b) return;
    b.textContent = text;
    b.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => b.classList.remove('show'), 2400);
  }

  private popup(rect: { left: number; top: number; width: number; height: number } | undefined, text: string, color: string, side: number) {
    if (!rect) return;
    const el = document.createElement('div');
    el.className = 'popup';
    el.textContent = text;
    el.style.color = color;
    el.style.left = `${rect.left + rect.width * (0.5 + side * 0.16)}px`;
    el.style.top = `${rect.top + rect.height * 0.42}px`;
    if (this.pilots.length > 1) el.style.fontSize = '18px';
    ui.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  private boardHtml(title: string, entries: LeaderEntry[], highlight?: { name: string; score: number }) {
    const rows = entries
      .map(
        (e, i) =>
          `<li class="${highlight && e.name === highlight.name && e.score === highlight.score ? 'me' : ''}"><span class="r">${i + 1}</span><span>${esc(e.name)}</span><span class="num">${fmt(e.distance)} m</span><span class="num">${fmt(e.score)}</span></li>`,
      )
      .join('');
    return `<div class="board glass"><h3>${title}</h3><ol>${rows || '<li><span></span><span class="small">Aucun score pour l’instant. À toi de jouer.</span></li>'}</ol></div>`;
  }

  renderScreen() {
    const phase = this.phase;
    if (phase === 'lobby') {
      if (!this.lobbyDirty && ui.querySelector('.lobby')) return;
      this.lobbyDirty = false;
      const slots = this.net.pads
        .map(
          (p) =>
            `<div class="slot ${p.connected ? 'on' : ''} ${p.ready ? 'ready' : ''}" style="--c:${p.color}"><div class="who" style="color:${p.connected ? p.color : 'inherit'}">${p.connected ? esc(p.name) : p.reserved ? 'Reconnexion…' : `Joueur ${p.slot + 1}`}</div><div class="st">${p.connected ? (p.ready ? 'PRÊT' : 'connecté') : 'libre'}</div></div>`,
        )
        .join('');
      const modeDesc: Record<GameMode, string> = {
        solo: 'Vole le plus loin possible. Frôle tout.',
        daily: `Même ville pour tous aujourd'hui (${parisDateString()}), avec ton fantôme.`,
        party: '2 à 4 joueurs, écran partagé, 3 manches.',
      };
      ui.innerHTML = `
        <div class="lobby">
          <div class="left">
            <div class="eyebrow">Arcade · téléphone = manette</div>
            <h1 class="title">Rase<br/>Mottes<span class="dot">.</span></h1>
            <p class="tagline">Scanne le code, tiens ton téléphone à deux mains et penche-le pour piloter. Frôle tout, ne touche rien.</p>
            <div class="qrbox glass">
              <div class="qr">${this.qrSvg || ''}</div>
              <div>
                <div class="small">Code du salon</div>
                <div class="code" data-testid="room-code">${this.roomCode || '····'}</div>
                <div class="small">${this.padUrl ? esc(this.padUrl.replace(/^https?:\/\//, '')) : 'Connexion au serveur…'}</div>
              </div>
            </div>
            <div class="slots">${slots}</div>
          </div>
          <div class="left">
            <div class="modes">${GAME_MODES.map((m, i) => `<button class="mode interactive ${m === this.mode ? 'sel' : ''}" data-mode="${m}"><b>${i + 1}. ${MODE_LABEL[m]}</b><span>${modeDesc[m]}</span></button>`).join('')}</div>
            ${this.mode === 'party' ? '<div class="board glass"><h3>Soirée</h3><div class="small">Chaque joueur appuie sur « Prêt » sur son téléphone. La partie démarre quand tout le monde est prêt.</div></div>' : this.boardHtml(this.mode === 'daily' ? 'Classement du jour' : 'Meilleurs pilotes', this.leaderboard)}
            <div class="keys">Choix du mode et départ depuis le téléphone. Sans téléphone : <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> mode, <kbd>Entrée</kbd> jouer, flèches/ZQSD, <kbd>Espace</kbd> boost, <kbd>Maj</kbd> frein, <kbd>P</kbd> pause, <kbd>M</kbd> muet.</div>
          </div>
          ${this.audio.started ? '' : '<div class="sound glass">Clique n’importe où pour activer le son</div>'}
        </div>`;
      ui.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => (b.onclick = () => this.setMode(b.dataset.mode as GameMode)));
      this.hudEls = {};
      return;
    }
    this.lobbyDirty = true;

    if (phase === 'countdown' || phase === 'playing' || phase === 'paused') {
      if (!ui.querySelector('.hud')) this.buildHud();
      const cd = this.hudEls.center;
      if (phase === 'countdown') {
        const n = Math.ceil(this.countdownT);
        cd.innerHTML = `<div class="countdown">${n > 0 ? n : 'GO'}</div>`;
      } else if (phase === 'paused') {
        cd.innerHTML = `<div class="card" style="text-align:center"><h2>${esc(this.pauseInfo || 'Pause')}</h2><div class="cta">Reprends depuis le téléphone (ou <kbd>P</kbd>)</div></div>`;
      } else cd.innerHTML = '';
      return;
    }

    if (phase === 'over') {
      const r = this.lastResult;
      if (!r) return;
      ui.innerHTML = `
        <div class="center"><div class="card">
          <div class="over-grid">
            <div>
              <h2>${r.personalBest ? 'Nouveau record !' : 'Crash !'}</h2>
              <div class="small">${esc(r.name)} · ${MODE_LABEL[this.mode]}${r.rank ? ` · <b style="color:var(--amber)">rang #${r.rank}</b>` : ''}</div>
              <div class="stats">
                <div class="stat"><b class="num">${fmt(r.distance)} m</b><span>Distance</span></div>
                <div class="stat"><b class="num">${fmt(r.score)}</b><span>Score</span></div>
                <div class="stat"><b>x${r.bestCombo}</b><span>Meilleur combo</span></div>
                <div class="stat"><b class="num">${r.grazes}</b><span>Frôlements</span></div>
                <div class="stat"><b class="num">${fmt(r.maxSpeed * 3.6)} km/h</b><span>Vitesse max</span></div>
                <div class="stat"><b class="num">${r.rings}${r.perfects ? ` <small>(${r.perfects}★)</small>` : ''}</b><span>Anneaux</span></div>
              </div>
              <div class="cta">« Rejouer » sur le téléphone <kbd>Entrée</kbd></div>
            </div>
            ${this.boardHtml(this.mode === 'daily' ? 'Classement du jour' : 'Classement', this.leaderboard, { name: r.name, score: r.score })}
          </div>
        </div></div>`;
      this.hudEls = {};
      return;
    }

    if (phase === 'roundOver' || phase === 'partyOver') {
      const final = phase === 'partyOver';
      const rows = this.owners
        .map((s, i) => ({ s, i, t: this.partyTotals.get(s)!, d: this.lastRoundDist[i] ?? 0 }))
        .sort((a, b) => (final ? b.t.dist - a.t.dist : b.d - a.d));
      ui.innerHTML = `
        <div class="center"><div class="card">
          <h2>${final ? `${esc(this.net.pads[rows[0].s].name)} gagne la soirée` : `Manche ${this.round}/${ROUNDS}`}</h2>
          <div class="standings">
            ${rows
              .map(
                (r, k) =>
                  `<div class="row ${k === 0 ? 'win' : ''}" style="--c:${PLAYER_COLORS[r.s]}"><b>${k + 1}</b><span style="color:${PLAYER_COLORS[r.s]};font-weight:800">${esc(this.net.pads[r.s].name)}</span><span class="num">${fmt(r.d)} m</span><span class="num small">total ${fmt(r.t.dist)} m · ${r.t.wins} manche(s)</span></div>`,
              )
              .join('')}
          </div>
          <div class="cta">${final ? '« Rejouer » sur le téléphone pour une nouvelle soirée' : 'Manche suivante…'}</div>
        </div></div>`;
      this.hudEls = {};
    }
  }

  private buildHud() {
    const multi = this.pilots.length > 1;
    if (!multi) {
      ui.innerHTML = `
        <div class="hud">
          <div class="tl pill"><div class="dist num" id="h-dist">0<small> m</small></div><div class="score num" id="h-score">0</div></div>
          <div class="combo" id="h-combo"><div class="x" id="h-x">x1</div><div class="bar"><div id="h-cbar"></div></div></div>
          <div class="tr pill"><div class="speed num" id="h-speed">0<small> km/h</small></div><div class="ping num" id="h-ping"></div></div>
          <div class="bottom"><div class="powerups" id="h-pu"></div><div class="boostbar" id="h-bb"><div id="h-boost"></div></div></div>
          <div class="banner" id="h-banner"></div>
          <div class="center" id="h-center"></div>
          ${DEBUG ? '<div class="debug" id="h-debug"></div>' : ''}
        </div>`;
    } else {
      const rects = this.renderer.viewRectsCss();
      ui.innerHTML = `
        <div class="hud">
          ${rects
            .map(
              (r, i) => `
            <div class="vborder" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px"></div>
            <div class="vpanel" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;--c:${PLAYER_COLORS[this.owners[i]]}">
              <div class="card-mini">
                <div class="name">${esc(this.net.pads[this.owners[i]].name)}</div>
                <div class="d num" id="v-d${i}">0 m</div>
                <div class="meta num" id="v-m${i}"></div>
                <div class="boostbar"><div id="v-b${i}"></div></div>
              </div>
              <div class="dead hidden" id="v-x${i}">CRASH</div>
            </div>`,
            )
            .join('')}
          <div class="banner" id="h-banner"></div>
          <div class="center" id="h-center"></div>
          ${DEBUG ? '<div class="debug" id="h-debug"></div>' : ''}
        </div>`;
    }
    this.hudEls = {};
    ui.querySelectorAll<HTMLElement>('[id]').forEach((el) => (this.hudEls[el.id.replace(/^h-/, '')] = el));
  }

  private updateHud() {
    const h = this.hudEls;
    if (!h.center) return;
    const multi = this.pilots.length > 1;
    if (!multi) {
      const p = this.pilots[0];
      if (!p) return;
      h.dist.innerHTML = `${fmt(p.z)}<small> m</small>`;
      h.score.textContent = `${fmt(p.totalScore)} pts`;
      h.speed.innerHTML = `${fmt(p.speed * 3.6)}<small> km/h</small>`;
      h.x.textContent = `x${p.combo}`;
      h.combo.style.opacity = p.combo > 1 ? '1' : '0.25';
      h.cbar.style.width = `${(p.comboT / 3) * 100}%`;
      h.boost.style.width = `${p.boost * 100}%`;
      h.bb.classList.toggle('on', p.boosting);
      const pu: string[] = [];
      if (p.shield) pu.push('Bouclier');
      if (p.slowmoT > 0) pu.push(`Ralenti ${p.slowmoT.toFixed(1)} s`);
      if (p.magnetT > 0) pu.push(`Aimant ${p.magnetT.toFixed(1)} s`);
      if (p.brakeCd > 0) pu.push(`frein ${p.brakeCd.toFixed(1)} s`);
      h.pu.innerHTML = pu.map((s) => `<span>${s}</span>`).join('');
      const owner = this.owners[0];
      if (owner >= 0) {
        const rtt = this.net.pads[owner].rtt;
        h.ping.textContent = `ping ${Math.round(rtt)} ms`;
        h.ping.classList.toggle('warn', rtt > 120);
        if (rtt > 120) h.ping.textContent += ' ⚠ latence élevée';
      } else h.ping.textContent = 'clavier';
    } else {
      this.pilots.forEach((p, i) => {
        const pad = this.net.pads[this.owners[i]];
        h[`v-d${i}`].textContent = `${fmt(p.z)} m`;
        h[`v-m${i}`].textContent = `${fmt(p.speed * 3.6)} km/h · x${p.combo} · ${Math.round(pad.rtt)} ms${pad.connected ? '' : ' · manette perdue'}`;
        h[`v-b${i}`].style.width = `${p.boost * 100}%`;
        h[`v-x${i}`].classList.toggle('hidden', p.alive);
      });
    }
    if (h.debug) {
      const lines = [
        `fps ${this.renderer.fps.toFixed(0)}  qualité ${this.renderer.quality}  pixelRatio ${this.renderer.renderer.getPixelRatio().toFixed(2)}  bloom ${this.renderer.post.bloom.enabled}`,
        `tronçons ${this.renderer.city.chunkCount}  graine ${this.seed}  t ${this.simTime.toFixed(1)}`,
        ...this.net.pads
          .filter((p) => p.connected)
          .map((p) => `manette ${p.slot + 1}: ${Math.round(p.rtt)} ms  ${p.rateWindow.length} pkt/s  perdus ${p.lost}  retard ${p.late}  x ${p.x.toFixed(2)} y ${p.y.toFixed(2)}`),
      ];
      h.debug.textContent = lines.join('\n');
    }
  }
}

new HostApp();
