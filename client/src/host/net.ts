import { OneEuroFilter } from '../../../shared/oneEuro';
import {
  BTN_BOOST,
  BTN_BRAKE,
  HostToPad,
  MAX_PADS,
  MSG_INPUT_SLOT_BASE,
  PLAYER_COLORS,
  PadToHost,
  ServerToHost,
  decodeInput,
  sanitizeName,
  seqIsNewer,
} from '../../../shared/protocol';

export interface PadState {
  slot: number;
  color: string;
  connected: boolean;
  reserved: boolean; // emplacement réservé (déconnecté < 30 s)
  name: string;
  ready: boolean;
  // entrées filtrées
  x: number;
  y: number;
  boost: boolean;
  brake: boolean;
  lastInputAt: number; // performance.now()
  lastSeq: number;
  lastTs: number;
  hasSeq: boolean;
  fx: OneEuroFilter;
  fy: OneEuroFilter;
  // réseau
  rtt: number;
  received: number;
  lost: number;
  late: number;
  rateWindow: number[];
}

export interface HostNetEvents {
  onRoom(code: string, padUrl: string): void;
  onPadJoin(slot: number, resumed: boolean): void;
  onPadLeave(slot: number, final: boolean): void;
  onPadMessage(slot: number, m: PadToHost): void;
  onDisconnect(): void;
}

export class HostNet {
  ws: WebSocket | null = null;
  code = '';
  padUrl = '';
  pads: PadState[];
  private pingTimer = 0;

  constructor(private ev: HostNetEvents) {
    this.pads = Array.from({ length: MAX_PADS }, (_, slot) => ({
      slot,
      color: PLAYER_COLORS[slot],
      connected: false,
      reserved: false,
      name: `Joueur ${slot + 1}`,
      ready: false,
      x: 0,
      y: 0,
      boost: false,
      brake: false,
      lastInputAt: 0,
      lastSeq: 0,
      lastTs: 0,
      hasSeq: false,
      fx: new OneEuroFilter(2.2, 0.9, 1),
      fy: new OneEuroFilter(2.2, 0.9, 1),
      rtt: 0,
      received: 0,
      lost: 0,
      late: 0,
      rateWindow: [],
    }));
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?role=host`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.onJson(e.data);
      else this.onBinary(e.data as ArrayBuffer);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      for (const p of this.pads) {
        p.connected = false;
        p.reserved = false;
        p.ready = false;
      }
      this.ev.onDisconnect();
      setTimeout(() => this.connect(), 1500);
    };
    clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      for (const p of this.pads) if (p.connected) this.send(p.slot, { t: 'ping', ts: performance.now() });
    }, 1000);
  }

  private onJson(raw: string) {
    let m: ServerToHost;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    switch (m.t) {
      case 'room':
        this.code = m.code;
        this.padUrl = m.padUrl;
        this.ev.onRoom(m.code, m.padUrl);
        break;
      case 'padJoin': {
        const p = this.pads[m.slot];
        p.connected = true;
        p.reserved = false;
        p.hasSeq = false;
        p.fx.reset();
        p.fy.reset();
        if (!m.resumed) {
          p.ready = false;
          p.name = `Joueur ${m.slot + 1}`;
          p.lost = p.late = p.received = 0;
        }
        this.ev.onPadJoin(m.slot, m.resumed);
        break;
      }
      case 'padLeave': {
        const p = this.pads[m.slot];
        p.connected = false;
        p.reserved = !m.final;
        if (m.final) p.ready = false;
        p.x = p.y = 0;
        p.boost = p.brake = false;
        this.ev.onPadLeave(m.slot, m.final);
        break;
      }
      case 'from': {
        const p = this.pads[m.slot];
        if (!p) return;
        const msg = m.m;
        if (msg.t === 'pong') {
          const rtt = performance.now() - msg.ts;
          p.rtt = p.rtt ? p.rtt * 0.6 + rtt * 0.4 : rtt;
          this.send(p.slot, { t: 'net', rtt: Math.round(p.rtt) });
          return;
        }
        if (msg.t === 'hello' || msg.t === 'name') {
          const n = sanitizeName(msg.name);
          if (n) p.name = n;
        }
        this.ev.onPadMessage(m.slot, msg);
        break;
      }
    }
  }

  private onBinary(buf: ArrayBuffer) {
    const pkt = decodeInput(buf);
    if (!pkt) return;
    const slot = pkt.type - MSG_INPUT_SLOT_BASE;
    const p = this.pads[slot];
    if (!p) return;
    // on ignore les paquets en retard (désordonnés)
    if (p.hasSeq && !seqIsNewer(pkt.seq, p.lastSeq)) {
      p.late++;
      return;
    }
    if (p.hasSeq) p.lost += Math.max(0, ((pkt.seq - p.lastSeq) & 0xffff) - 1);
    const dt = p.hasSeq ? Math.min(0.1, Math.max(1 / 240, (pkt.ts - p.lastTs) / 1000)) : 1 / 60;
    p.hasSeq = true;
    p.lastSeq = pkt.seq;
    p.lastTs = pkt.ts;
    p.received++;
    const now = performance.now();
    p.lastInputAt = now;
    p.rateWindow.push(now);
    while (p.rateWindow.length && now - p.rateWindow[0] > 1000) p.rateWindow.shift();
    p.x = p.fx.filter(pkt.roll, dt);
    p.y = p.fy.filter(pkt.pitch, dt);
    p.boost = (pkt.buttons & BTN_BOOST) !== 0;
    p.brake = (pkt.buttons & BTN_BRAKE) !== 0;
  }

  send(slot: number, m: HostToPad) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'to', slot, m }));
  }

  /** Vrai si la manette a envoyé une entrée récemment. */
  isFresh(slot: number, ms = 500): boolean {
    const p = this.pads[slot];
    return p.connected && performance.now() - p.lastInputAt < ms;
  }
}
