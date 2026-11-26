// Protocole commun hôte / manette / serveur.

export const MAX_PADS = 4;
export const ROOM_CODE_LEN = 4;
/** Lettres sans ambiguïté visuelle (pas de I, O, L, 0, 1...). */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const RECONNECT_GRACE_MS = 30_000;
export const MAX_MESSAGE_BYTES = 1024;

export const PLAYER_COLORS = ['#22e8ff', '#ff3ea5', '#ffd23e', '#7dff5a'] as const;
export const PLAYER_NAMES_COLOR = ['Cyan', 'Magenta', 'Ambre', 'Vert'] as const;

export type GameMode = 'solo' | 'daily' | 'party';
export const GAME_MODES: GameMode[] = ['solo', 'daily', 'party'];
export const MODE_LABEL: Record<GameMode, string> = {
  solo: 'Solo infini',
  daily: 'Défi du jour',
  party: 'Soirée',
};

// ---------------------------------------------------------------------------
// Entrées binaires (12 octets, little-endian)
//   0  u8   type (pad -> serveur : MSG_INPUT ; serveur -> hôte : MSG_INPUT_SLOT_BASE + slot)
//   1  u16  séquence
//   3  u32  horodatage (ms, horloge manette)
//   7  i16  tangage  [-32767, 32767] <=> [-1, 1]
//   9  i16  roulis   [-32767, 32767] <=> [-1, 1]
//   11 u8   boutons
// ---------------------------------------------------------------------------
export const INPUT_PACKET_SIZE = 12;
export const MSG_INPUT = 0x01;
export const MSG_INPUT_SLOT_BASE = 0x10; // 0x10..0x13 : relayé par le serveur, slot dans le quartet bas

export const BTN_BOOST = 1 << 0;
export const BTN_BRAKE = 1 << 1;

export interface InputPacket {
  type: number;
  seq: number;
  ts: number;
  pitch: number; // [-1, 1]
  roll: number; // [-1, 1]
  buttons: number;
}

const clamp1 = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);

export function encodeInput(p: InputPacket, out?: ArrayBuffer): ArrayBuffer {
  const buf = out ?? new ArrayBuffer(INPUT_PACKET_SIZE);
  const dv = new DataView(buf);
  dv.setUint8(0, p.type & 0xff);
  dv.setUint16(1, p.seq & 0xffff, true);
  dv.setUint32(3, p.ts >>> 0, true);
  dv.setInt16(7, Math.round(clamp1(p.pitch) * 32767), true);
  dv.setInt16(9, Math.round(clamp1(p.roll) * 32767), true);
  dv.setUint8(11, p.buttons & 0xff);
  return buf;
}

export function decodeInput(data: ArrayBuffer | ArrayBufferView): InputPacket | null {
  const view =
    data instanceof ArrayBuffer
      ? new DataView(data)
      : new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.byteLength !== INPUT_PACKET_SIZE) return null;
  return {
    type: view.getUint8(0),
    seq: view.getUint16(1, true),
    ts: view.getUint32(3, true),
    pitch: view.getInt16(7, true) / 32767,
    roll: view.getInt16(9, true) / 32767,
    buttons: view.getUint8(11),
  };
}

/** Vrai si `seq` est plus récent que `last` (compteur u16 qui reboucle). */
export function seqIsNewer(seq: number, last: number): boolean {
  const diff = (seq - last) & 0xffff;
  return diff !== 0 && diff < 0x8000;
}

// ---------------------------------------------------------------------------
// Messages de contrôle JSON
// ---------------------------------------------------------------------------

export type Phase =
  | 'lobby'
  | 'countdown'
  | 'playing'
  | 'paused'
  | 'over'
  | 'roundOver'
  | 'partyOver';

/** Messages hôte -> manette (encapsulés par le serveur). */
export type HostToPad =
  | {
      t: 'state';
      phase: Phase;
      mode: GameMode;
      pilot: boolean; // cette manette pilote-t-elle en ce moment ?
      ready: boolean;
      info?: string;
      round?: number;
      rounds?: number;
    }
  | { t: 'calibrate' }
  | { t: 'boost'; v: number }
  | { t: 'haptic'; p: 'graze' | 'bonus' | 'crash' | 'ring' }
  | { t: 'ping'; ts: number }
  | { t: 'net'; rtt: number }
  | { t: 'result'; distance: number; score: number; rank?: number; best?: boolean };

/** Messages manette -> hôte. */
export type PadToHost =
  | { t: 'hello'; name: string }
  | { t: 'pong'; ts: number }
  | { t: 'ready' }
  | { t: 'mode'; mode: GameMode }
  | { t: 'replay' }
  | { t: 'menu' }
  | { t: 'name'; name: string }
  | { t: 'pause' };

/** Serveur -> hôte */
export type ServerToHost =
  | { t: 'room'; code: string; padUrl: string }
  | { t: 'padJoin'; slot: number; resumed: boolean }
  | { t: 'padLeave'; slot: number; final: boolean }
  | { t: 'from'; slot: number; m: PadToHost }
  | { t: 'error'; code: string };

/** Hôte -> serveur */
export type HostToServer = { t: 'to'; slot: number; m: HostToPad }; // slot -1 = toutes les manettes

/** Serveur -> manette */
export type ServerToPad =
  | { t: 'joined'; slot: number; color: string; token: string; code: string }
  | { t: 'hostLeft' }
  | { t: 'error'; code: 'room_not_found' | 'room_full' | 'bad_request' | 'rate_limited' }
  | HostToPad;

export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _\-.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12)
    .trim();
  return cleaned.length >= 3 ? cleaned : null;
}

export function isRoomCode(code: unknown): code is string {
  return (
    typeof code === 'string' &&
    code.length === ROOM_CODE_LEN &&
    [...code].every((c) => ROOM_ALPHABET.includes(c))
  );
}
