import { describe, expect, it } from 'vitest';
import { makeBox, pointBoxDistance, sweptCapsuleBox } from '../../shared/collision';
import { OneEuroFilter } from '../../shared/oneEuro';
import { dailySeed, mulberry32, parisDateString } from '../../shared/prng';
import {
  INPUT_PACKET_SIZE,
  MSG_INPUT,
  decodeInput,
  encodeInput,
  sanitizeName,
  seqIsNewer,
} from '../../shared/protocol';
import { Pilot } from '../../shared/sim';
import { World } from '../../shared/world';
import { axisAngle, deviceQuat, quatMul, relativePitchRoll, steerAngle, upAngleFromGravity } from '../../client/src/pad/orientation';

describe('protocole binaire', () => {
  it('encode et décode un paquet de 12 octets', () => {
    const buf = encodeInput({ type: MSG_INPUT, seq: 65535, ts: 123456789, pitch: -0.5, roll: 0.25, buttons: 3 });
    expect(buf.byteLength).toBe(INPUT_PACKET_SIZE);
    const p = decodeInput(buf)!;
    expect(p.type).toBe(MSG_INPUT);
    expect(p.seq).toBe(65535);
    expect(p.ts).toBe(123456789);
    expect(p.pitch).toBeCloseTo(-0.5, 4);
    expect(p.roll).toBeCloseTo(0.25, 4);
    expect(p.buttons).toBe(3);
  });
  it('borne les axes et refuse les tailles invalides', () => {
    const p = decodeInput(encodeInput({ type: 1, seq: 1, ts: 0, pitch: 4, roll: -9, buttons: 0 }))!;
    expect(p.pitch).toBe(1);
    expect(p.roll).toBe(-1);
    expect(decodeInput(new ArrayBuffer(11))).toBeNull();
  });
  it('gère le rebouclage des numéros de séquence', () => {
    expect(seqIsNewer(1, 0)).toBe(true);
    expect(seqIsNewer(0, 65535)).toBe(true);
    expect(seqIsNewer(65535, 0)).toBe(false);
    expect(seqIsNewer(5, 5)).toBe(false);
  });
  it('nettoie les pseudos', () => {
    expect(sanitizeName('  Zoé<script>  ')).toBe('Zoéscript');
    expect(sanitizeName('ab')).toBeNull();
    expect(sanitizeName('un pseudo bien trop long')).toBe('un pseudo bi');
  });
});

describe('PRNG', () => {
  it('mulberry32 est déterministe', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const sa = Array.from({ length: 100 }, a);
    expect(sa).toEqual(Array.from({ length: 100 }, b));
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(sa[0]);
  });
  it('la graine du jour suit la date de Paris', () => {
    // 23h30 UTC le 31/12 = 0h30 à Paris le 1/1
    expect(parisDateString(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(dailySeed(new Date('2026-12-31T23:30:00Z'))).toBe(dailySeed(new Date('2027-01-01T10:00:00Z')));
  });
});

describe('collisions balayées', () => {
  const wall = makeBox(-5, 0, 100, 5, 10, 100.5); // mur fin de 50 cm
  it('ne traverse pas un mur fin à très haute vitesse', () => {
    // 500 m/s à 120 Hz : 4,2 m par pas, bien plus que l'épaisseur du mur
    const t = sweptCapsuleBox({ x: 0, y: 5, z: 98 }, { x: 0, y: 5, z: 102.2 }, 0.7, wall);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(1);
  });
  it('ne touche pas à côté', () => {
    expect(sweptCapsuleBox({ x: 6, y: 5, z: 98 }, { x: 6, y: 5, z: 102 }, 0.7, wall)).toBe(-1);
    expect(sweptCapsuleBox({ x: 5.6, y: 5, z: 98 }, { x: 5.6, y: 5, z: 102 }, 0.7, wall)).toBeGreaterThanOrEqual(0);
  });
  it('distance point-boîte', () => {
    expect(pointBoxDistance({ x: 8, y: 5, z: 100.2 }, wall)).toBeCloseTo(3);
    expect(pointBoxDistance({ x: 0, y: 5, z: 100.2 }, wall)).toBe(0);
  });
  it('un pilote qui fonce droit dans un mur s’écrase au lieu de le traverser', () => {
    const w = new World(7);
    const p = new Pilot(w);
    p.z = 0;
    let crashed = false;
    for (let i = 0; i < 120 * 60 && !crashed; i++) {
      const ev: { type: string }[] = [];
      p.step(1 / 120, { x: 1, y: 0, boost: true, brake: false }, i / 120, ev as never);
      crashed = !p.alive;
    }
    expect(crashed).toBe(true);
  });
});

describe('orientation du téléphone', () => {
  const ref = deviceQuat(30, 40, 0, 90);
  it('roulis et cap nuls en position de référence', () => {
    const r = relativePitchRoll(ref, ref);
    expect(Math.abs(r.roll) + Math.abs(r.pitch) + Math.abs(r.yaw)).toBeLessThan(1e-6);
  });
  it('tourner le volant de 20° donne un roulis de 20°, sans cap', () => {
    const q = quatMul(ref, axisAngle(0, 0, 1, (-20 * Math.PI) / 180));
    const r = relativePitchRoll(ref, q);
    expect(r.roll).toBeCloseTo(20, 3);
    expect(Math.abs(r.yaw)).toBeLessThan(1e-6);
  });
  it('pointer à droite donne un cap positif, sans roulis', () => {
    const q = quatMul(ref, axisAngle(0, 1, 0, (-15 * Math.PI) / 180));
    const r = relativePitchRoll(ref, q);
    expect(r.yaw).toBeCloseTo(15, 3);
    expect(Math.abs(r.roll)).toBeLessThan(1e-6);
    expect(steerAngle(r, 'both')).toBeGreaterThan(0);
  });
  it('déduit l’orientation de l’écran de la gravité', () => {
    // portrait debout : beta = 90
    expect(upAngleFromGravity(0, 90, 0)).toBe(0);
    // paysage (appareil tourné d'un quart de tour vers la gauche) : gamma = -90 environ
    expect(upAngleFromGravity(0, 0, -80)).toBe(90);
    expect(upAngleFromGravity(0, 0, 80)).toBe(270);
    // à plat : indéterminé
    expect(upAngleFromGravity(0, 2, 3)).toBeNull();
  });
  it('basculer le haut vers l’avant donne un tangage positif', () => {
    const q = quatMul(ref, axisAngle(1, 0, 0, (-10 * Math.PI) / 180));
    expect(relativePitchRoll(ref, q).pitch).toBeCloseTo(10, 3);
  });
});

describe('filtre One Euro', () => {
  it('lisse le bruit et suit un échelon', () => {
    const f = new OneEuroFilter(2.2, 0.9, 1);
    let out = 0;
    for (let i = 0; i < 60; i++) out = f.filter(i < 10 ? 0 : 1, 1 / 60);
    expect(out).toBeGreaterThan(0.95);
  });
});
