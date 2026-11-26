// Orientation du téléphone -> tangage / roulis relatifs à une position de référence.
// On ne lit jamais beta/gamma bruts : on construit un quaternion (ordre Z-X'-Y'' de la
// spec W3C), on corrige l'orientation de l'écran, puis q_rel = inverse(q_ref) * q.

export type Quat = [number, number, number, number]; // x, y, z, w

const DEG = Math.PI / 180;

export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function axisAngle(ax: number, ay: number, az: number, rad: number): Quat {
  const s = Math.sin(rad / 2);
  return [ax * s, ay * s, az * s, Math.cos(rad / 2)];
}

export function rotateVec(q: Quat, v: [number, number, number]): [number, number, number] {
  // v' = q v q*
  const p: Quat = [v[0], v[1], v[2], 0];
  const r = quatMul(quatMul(q, p), quatConj(q));
  return [r[0], r[1], r[2]];
}

/** Quaternion appareil -> monde à partir des angles W3C (degrés), corrigé de l'angle d'écran. */
export function deviceQuat(alpha: number, beta: number, gamma: number, screenAngleDeg: number): Quat {
  const qz = axisAngle(0, 0, 1, alpha * DEG);
  const qx = axisAngle(1, 0, 0, beta * DEG);
  const qy = axisAngle(0, 1, 0, gamma * DEG);
  const q = quatMul(quatMul(qz, qx), qy);
  // repère écran : rotation de -angle autour de l'axe Z de l'appareil
  return quatMul(q, axisAngle(0, 0, 1, -screenAngleDeg * DEG));
}

/**
 * Tangage / roulis (degrés) de q par rapport à qRef.
 * roulis > 0 : on tourne le « volant » vers la droite (sens horaire vu par le joueur).
 * tangage > 0 : on bascule le haut de l'écran vers l'avant (loin du joueur).
 */
export function relativePitchRoll(qRef: Quat, q: Quat): { pitch: number; roll: number; yaw: number } {
  const rel = quatMul(quatConj(qRef), q);
  const up = rotateVec(rel, [0, 1, 0]);
  const roll = Math.atan2(up[0], up[1]) / DEG;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -up[2]))) / DEG;
  // cap : direction visée par le dos du téléphone (comme un pointeur), indépendante du roulis
  const fwd = rotateVec(rel, [0, 0, -1]);
  const yaw = Math.atan2(fwd[0], -fwd[2]) / DEG;
  return { pitch, roll, yaw };
}

export type SteerStyle = 'both' | 'wheel' | 'aim';

/** Angle de direction (deg) selon le style choisi : volant (roulis), visée (cap) ou les deux. */
export function steerAngle(r: { roll: number; yaw: number }, style: SteerStyle): number {
  if (style === 'wheel') return r.roll;
  if (style === 'aim') return r.yaw * 1.3;
  return r.roll + r.yaw * 1.3;
}

/**
 * Angle d'écran (deg, multiple de 90) tel que le haut de l'écran soit le plus proche
 * de la verticale réelle. null si le téléphone est tenu presque à plat.
 */
export function upAngleFromGravity(alpha: number, beta: number, gamma: number): number | null {
  const qd = deviceQuat(alpha, beta, gamma, 0);
  const up = rotateVec(quatConj(qd), [0, 0, 1]); // verticale du monde dans le repère de l'appareil
  if (Math.hypot(up[0], up[1]) < 0.35) return null;
  const a = Math.atan2(up[0], up[1]) / DEG;
  return (((Math.round(a / 90) * 90) % 360) + 360) % 360;
}

export interface AxisSettings {
  sensitivity: number; // 0.5 .. 2
  deadZone: number; // 0 .. 0.25
  invertY: boolean;
}

const MAX_ANGLE = 40;

/** Angle (deg) -> axe normalisé [-1, 1] avec zone morte et sensibilité. */
export function shapeAxis(deg: number, s: AxisSettings): number {
  let v = Math.max(-1, Math.min(1, deg / MAX_ANGLE));
  const a = Math.abs(v);
  if (a < s.deadZone) return 0;
  v = (Math.sign(v) * (a - s.deadZone)) / (1 - s.deadZone);
  return Math.max(-1, Math.min(1, v * s.sensitivity));
}
