import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector2,
} from 'three';

/** Profil du fuselage (révolution) : ogive, corps, rétreint de tuyère. Longueur ~3,6 m, vers -z. */
function bodyProfile(): Vector2[] {
  const pts: Vector2[] = [];
  // de la pointe (y = +1.95) à l'arrière (y = -1.6), rayon x
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    pts.push(new Vector2(0.34 * Math.sin((t * Math.PI) / 2) ** 0.8, 1.95 - t * 1.25));
  }
  pts.push(new Vector2(0.34, -1.2));
  pts.push(new Vector2(0.3, -1.5));
  pts.push(new Vector2(0.22, -1.62));
  return pts;
}

/** Missile procédural orienté vers -z (sens d'avancée dans le repère three). */
export function createMissile(color: string, ghost = false): Group {
  const g = new Group();
  const c = new Color(color);
  const ghostMat = new MeshBasicMaterial({ color: c, transparent: true, opacity: 0.3, depthWrite: false });
  const hull = ghost ? ghostMat : new MeshStandardMaterial({ color: '#e9edf3', metalness: 0.75, roughness: 0.25 });
  const paint = ghost ? ghostMat : new MeshStandardMaterial({ color: c, metalness: 0.4, roughness: 0.35, emissive: c, emissiveIntensity: 0.6 });
  const dark = ghost ? ghostMat : new MeshStandardMaterial({ color: '#23262e', metalness: 0.85, roughness: 0.35 });

  const body = new Mesh(new LatheGeometry(bodyProfile(), 28), hull);
  body.rotation.x = -Math.PI / 2; // l'axe y du profil devient -z
  body.castShadow = !ghost;
  g.add(body);
  // bandes de couleur du joueur
  for (const zz of [-0.55, 0.9]) {
    const band = new Mesh(new CylinderGeometry(0.352, 0.352, zz < 0 ? 0.28 : 0.14, 28), paint);
    band.rotation.x = Math.PI / 2;
    band.position.z = zz;
    g.add(band);
  }
  // tête chercheuse
  const seeker = new Mesh(new SphereGeometry(0.12, 12, 8), ghost ? ghostMat : new MeshStandardMaterial({ color: '#111', metalness: 1, roughness: 0.05 }));
  seeker.position.z = -1.93;
  g.add(seeker);
  // ailerons arrière (en X) et canards avant
  const finGeo = new BoxGeometry(0.04, 0.62, 0.62);
  finGeo.translate(0, 0.31, 0);
  for (let i = 0; i < 4; i++) {
    const fin = new Mesh(finGeo, i % 2 ? paint : dark);
    fin.rotation.z = (i * Math.PI) / 2 + Math.PI / 4;
    fin.position.z = 1.15;
    fin.castShadow = !ghost;
    g.add(fin);
  }
  const canGeo = new BoxGeometry(0.03, 0.28, 0.26);
  canGeo.translate(0, 0.42, 0);
  for (let i = 0; i < 4; i++) {
    const cn = new Mesh(canGeo, dark);
    cn.rotation.z = (i * Math.PI) / 2 + Math.PI / 4;
    cn.position.z = -0.95;
    g.add(cn);
  }
  // tuyère
  const nozzle = new Mesh(new CylinderGeometry(0.2, 0.25, 0.32, 18, 1, true), dark);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.z = 1.72;
  g.add(nozzle);
  // flamme : cône additif + cœur blanc
  const flame = new Mesh(
    new ConeGeometry(0.2, 1.5, 14, 1, true),
    new MeshBasicMaterial({ color: new Color(color).lerp(new Color('#ffffff'), 0.3).multiplyScalar(3), transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false, fog: false }),
  );
  flame.geometry.translate(0, 0.75, 0); // base à la tuyère (y = 0), pointe en y = 1,5
  flame.rotation.x = Math.PI / 2; // y -> +z : la pointe part vers l'arrière
  flame.position.z = 1.82;
  flame.name = 'flame';
  g.add(flame);
  const core = new Mesh(
    new SphereGeometry(0.17, 12, 8),
    new MeshBasicMaterial({ color: new Color('#fff4e0').multiplyScalar(5), transparent: true, blending: AdditiveBlending, depthWrite: false, fog: false }),
  );
  core.position.z = 1.85;
  g.add(core);
  // feux de position
  for (const [x, col] of [
    [-0.5, '#ff2a2a'],
    [0.5, '#2aff6a'],
  ] as const) {
    const l = new Mesh(new SphereGeometry(0.05, 6, 4), new MeshBasicMaterial({ color: new Color(col).multiplyScalar(6), fog: false }));
    l.position.set(x, 0, -0.95);
    g.add(l);
  }
  // bulle de bouclier
  const shield = new Mesh(
    new SphereGeometry(1.9, 24, 16),
    new MeshBasicMaterial({ color: new Color('#4dd2ff').multiplyScalar(1.5), transparent: true, opacity: 0.16, blending: AdditiveBlending, depthWrite: false, fog: false }),
  );
  shield.name = 'shield';
  shield.visible = false;
  g.add(shield);
  return g;
}
