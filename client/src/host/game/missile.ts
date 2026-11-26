import {
  AdditiveBlending,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  BoxGeometry,
} from 'three';

/** Missile procédural orienté vers -z (sens d'avancée dans le repère three). */
export function createMissile(color: string, ghost = false): Group {
  const g = new Group();
  const c = new Color(color);
  const bodyMat = new MeshBasicMaterial({
    color: ghost ? c : new Color('#d8deef'),
    transparent: ghost,
    opacity: ghost ? 0.35 : 1,
    depthWrite: !ghost,
  });
  const accentMat = new MeshBasicMaterial({ color: c, transparent: ghost, opacity: ghost ? 0.4 : 1 });
  const darkMat = new MeshBasicMaterial({ color: ghost ? c : new Color('#30364a'), transparent: ghost, opacity: ghost ? 0.3 : 1 });

  const body = new Mesh(new CylinderGeometry(0.32, 0.36, 2.6, 14), bodyMat);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const nose = new Mesh(new ConeGeometry(0.32, 1.1, 14), accentMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -1.85;
  g.add(nose);
  const band = new Mesh(new CylinderGeometry(0.37, 0.37, 0.25, 14), accentMat);
  band.rotation.x = Math.PI / 2;
  band.position.z = -0.5;
  g.add(band);
  // ailerons
  for (let i = 0; i < 4; i++) {
    const fin = new Mesh(new BoxGeometry(0.05, 0.75, 0.7), i % 2 ? darkMat : accentMat);
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    fin.position.set(Math.cos(a) * 0.55, Math.sin(a) * 0.55, 1.0);
    fin.rotation.z = a - Math.PI / 2;
    g.add(fin);
  }
  // canards avant
  for (const sx of [-1, 1]) {
    const w = new Mesh(new BoxGeometry(0.6, 0.04, 0.3), darkMat);
    w.position.set(sx * 0.4, 0, -0.9);
    g.add(w);
  }
  // tuyère + flamme
  const flame = new Mesh(
    new ConeGeometry(0.3, 1.6, 12, 1, true),
    new MeshBasicMaterial({ color: new Color(color).multiplyScalar(1.4), transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }),
  );
  flame.rotation.x = -Math.PI / 2;
  flame.position.z = 2.1;
  flame.name = 'flame';
  g.add(flame);
  const core = new Mesh(
    new SphereGeometry(0.28, 10, 8),
    new MeshBasicMaterial({ color: new Color('#ffffff').multiplyScalar(1.4), transparent: true, opacity: 0.95, blending: AdditiveBlending }),
  );
  core.position.z = 1.35;
  g.add(core);
  // bulle de bouclier
  const shield = new Mesh(
    new SphereGeometry(1.9, 20, 14),
    new MeshBasicMaterial({ color: new Color('#4dd2ff'), transparent: true, opacity: 0.18, blending: AdditiveBlending, depthWrite: false }),
  );
  shield.name = 'shield';
  shield.visible = false;
  g.add(shield);
  return g;
}
