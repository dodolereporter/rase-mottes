// Salons : un hôte (PC) + jusqu'à 4 manettes. Le serveur ne fait que relayer.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  INPUT_PACKET_SIZE,
  MAX_MESSAGE_BYTES,
  MAX_PADS,
  MSG_INPUT,
  MSG_INPUT_SLOT_BASE,
  PLAYER_COLORS,
  RECONNECT_GRACE_MS,
  ROOM_ALPHABET,
  ROOM_CODE_LEN,
  isRoomCode,
} from '../../shared/protocol';

export interface RoomsOptions {
  maxRooms: number;
  publicUrl: string | null;
  allowedOrigins: (origin: string | undefined, host: string | undefined) => boolean;
  log: (msg: string) => void;
}

interface PadSlot {
  ws: WebSocket | null;
  token: string;
  leftAt: number; // 0 si connectée
  hello: unknown; // dernier message "hello" pour le rejouer à une reconnexion d'hôte (non utilisé)
}

interface Room {
  code: string;
  host: WebSocket | null;
  pads: (PadSlot | null)[];
  createdAt: number;
  emptySince: number;
}

interface Meta {
  alive: boolean;
  tokens: number;
  lastRefill: number;
  room?: Room;
  role?: 'host' | 'pad';
  slot?: number;
}

const RATE_PER_SEC = 150; // 60 Hz d'entrées + marge pour le contrôle
const RATE_BURST = 300;

export class RoomManager {
  readonly wss: WebSocketServer;
  private rooms = new Map<string, Room>();
  private meta = new WeakMap<WebSocket, Meta>();
  private timer: NodeJS.Timeout;

  constructor(private opts: RoomsOptions) {
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref();
  }

  get roomCount() {
    return this.rooms.size;
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
  }

  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    if (!this.opts.allowedOrigins(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  private newCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const bytes = randomBytes(ROOM_CODE_LEN);
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('no room code available');
  }

  private send(ws: WebSocket | null | undefined, msg: unknown) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://x');
    const role = url.searchParams.get('role');
    const meta: Meta = { alive: true, tokens: RATE_BURST, lastRefill: Date.now() };
    this.meta.set(ws, meta);
    ws.on('pong', () => (meta.alive = true));
    ws.on('error', () => ws.terminate());

    if (role === 'host') this.attachHost(ws, meta, req);
    else if (role === 'pad') this.attachPad(ws, meta, url);
    else {
      this.send(ws, { t: 'error', code: 'bad_request' });
      ws.close(1008, 'bad role');
      return;
    }

    ws.on('message', (data, isBinary) => {
      if (!this.consumeToken(meta)) {
        // dépassement de débit : on ignore, et on coupe en cas d'abus prolongé
        if (meta.tokens < -RATE_BURST) ws.close(1008, 'rate limited');
        return;
      }
      if (meta.role === 'pad') this.onPadMessage(meta, data as Buffer, isBinary);
      else if (meta.role === 'host') this.onHostMessage(meta, data as Buffer, isBinary);
    });
    ws.on('close', () => this.onClose(ws, meta));
  }

  private consumeToken(meta: Meta): boolean {
    const now = Date.now();
    meta.tokens = Math.min(RATE_BURST, meta.tokens + ((now - meta.lastRefill) / 1000) * RATE_PER_SEC);
    meta.lastRefill = now;
    meta.tokens -= 1;
    return meta.tokens >= 0;
  }

  private attachHost(ws: WebSocket, meta: Meta, req: IncomingMessage) {
    if (this.rooms.size >= this.opts.maxRooms) {
      this.send(ws, { t: 'error', code: 'server_full' });
      ws.close(1013, 'server full');
      return;
    }
    const code = this.newCode();
    const room: Room = { code, host: ws, pads: Array(MAX_PADS).fill(null), createdAt: Date.now(), emptySince: 0 };
    this.rooms.set(code, room);
    meta.room = room;
    meta.role = 'host';
    const base = this.opts.publicUrl ?? originFromRequest(req);
    this.send(ws, { t: 'room', code, padUrl: `${base}/pad?room=${code}` });
    this.opts.log(`room ${code} created (${this.rooms.size} rooms)`);
  }

  private attachPad(ws: WebSocket, meta: Meta, url: URL) {
    const code = (url.searchParams.get('room') ?? '').toUpperCase();
    const token = url.searchParams.get('token') ?? '';
    const room = isRoomCode(code) ? this.rooms.get(code) : undefined;
    if (!room || !room.host) {
      this.send(ws, { t: 'error', code: 'room_not_found' });
      ws.close(4004, 'room not found');
      return;
    }
    // reconnexion : même jeton, emplacement encore réservé
    let slot = token ? room.pads.findIndex((p) => p && p.token === token) : -1;
    let resumed = slot >= 0;
    if (slot >= 0) {
      const old = room.pads[slot]!;
      if (old.ws && old.ws !== ws) {
        const om = this.meta.get(old.ws);
        if (om) om.role = undefined; // l'ancien socket ne libère pas l'emplacement en se fermant
        old.ws.close(4000, 'replaced');
      }
      old.ws = ws;
      old.leftAt = 0;
    } else {
      slot = room.pads.findIndex((p) => p === null);
      if (slot < 0) {
        this.send(ws, { t: 'error', code: 'room_full' });
        ws.close(4003, 'room full');
        return;
      }
      room.pads[slot] = { ws, token: randomBytes(12).toString('base64url'), leftAt: 0, hello: null };
      resumed = false;
    }
    meta.room = room;
    meta.role = 'pad';
    meta.slot = slot;
    this.send(ws, { t: 'joined', slot, color: PLAYER_COLORS[slot], token: room.pads[slot]!.token, code: room.code });
    this.send(room.host, { t: 'padJoin', slot, resumed });
  }

  private onPadMessage(meta: Meta, data: Buffer, isBinary: boolean) {
    const room = meta.room!;
    if (isBinary) {
      // relais sans analyse au-delà de l'en-tête : on inscrit l'emplacement dans l'octet de type
      if (data.length !== INPUT_PACKET_SIZE || data[0] !== MSG_INPUT) return;
      data[0] = MSG_INPUT_SLOT_BASE + meta.slot!;
      if (room.host && room.host.readyState === WebSocket.OPEN) room.host.send(data, { binary: true });
      return;
    }
    let m: unknown;
    try {
      m = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return;
    this.send(room.host, { t: 'from', slot: meta.slot, m });
  }

  private onHostMessage(meta: Meta, data: Buffer, isBinary: boolean) {
    if (isBinary) return;
    let msg: { t?: string; slot?: number; m?: unknown };
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.t !== 'to' || typeof msg.slot !== 'number' || !msg.m) return;
    const room = meta.room!;
    const payload = JSON.stringify(msg.m);
    const targets = msg.slot < 0 ? room.pads : [room.pads[msg.slot]];
    for (const p of targets) if (p?.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
  }

  private onClose(ws: WebSocket, meta: Meta) {
    const room = meta.room;
    if (!room) return;
    if (meta.role === 'host' && room.host === ws) {
      room.host = null;
      for (const p of room.pads) if (p?.ws) {
        this.send(p.ws, { t: 'hostLeft' });
        p.ws.close(4001, 'host left');
      }
      this.rooms.delete(room.code);
      this.opts.log(`room ${room.code} closed (${this.rooms.size} rooms)`);
    } else if (meta.role === 'pad' && meta.slot !== undefined) {
      const p = room.pads[meta.slot];
      if (p && p.ws === ws) {
        p.ws = null;
        p.leftAt = Date.now();
        this.send(room.host, { t: 'padLeave', slot: meta.slot, final: false });
      }
    }
  }

  /** Heartbeat, libération des emplacements expirés, salons vides. */
  private tick() {
    const now = Date.now();
    for (const ws of this.wss.clients) {
      const m = this.meta.get(ws);
      if (!m) continue;
      if (!m.alive) {
        ws.terminate();
        continue;
      }
      m.alive = false;
      ws.ping();
    }
    for (const room of this.rooms.values()) {
      room.pads.forEach((p, i) => {
        if (p && !p.ws && now - p.leftAt > RECONNECT_GRACE_MS) {
          room.pads[i] = null;
          this.send(room.host, { t: 'padLeave', slot: i, final: true });
        }
      });
      const empty = room.pads.every((p) => !p);
      if (empty) {
        if (!room.emptySince) room.emptySince = now;
      } else room.emptySince = 0;
      // salon sans manette depuis 2 h : on le ferme
      if (room.emptySince && now - room.emptySince > 2 * 3600_000) room.host?.close(4002, 'idle');
      if (!room.host) this.rooms.delete(room.code);
    }
  }
}

function originFromRequest(req: IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? 'https';
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}
