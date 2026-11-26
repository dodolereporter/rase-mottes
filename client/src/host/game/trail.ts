import { AdditiveBlending, BufferAttribute, BufferGeometry, Camera, Color, Mesh, ShaderMaterial, Vector3 } from 'three';

const N = 48; // points du ruban
const STEP = 0.8; // distance min entre deux points (m)

/** Ruban de traînée continu, toujours face à la caméra (calculé pour chaque vue). */
export class Trail {
  readonly mesh: Mesh;
  private pts: Vector3[] = [];
  private pos = new Float32Array(N * 2 * 3);
  private alpha = new Float32Array(N * 2);
  private geo = new BufferGeometry();
  width = 0.55;

  constructor(color: Color) {
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.mesh = new Mesh(
      this.geo,
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: { uColor: { value: color } },
        vertexShader: /* glsl */ `
          attribute float aAlpha;
          varying float vA;
          void main() { vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying float vA;
          void main() { gl_FragColor = vec4(uColor * vA, 1.0); }
        `,
      }),
    );
    this.mesh.frustumCulled = false;
  }

  reset() {
    this.pts = [];
    this.geo.setDrawRange(0, 0);
  }

  /** Ajoute la position de la tuyère ; `relative` décale tout le ruban vers l'arrière (vitesse apparente). */
  push(p: Vector3) {
    const last = this.pts[0];
    if (last && last.distanceTo(p) < STEP) last.copy(p);
    else {
      this.pts.unshift(p.clone());
      if (this.pts.length > N) this.pts.pop();
    }
  }

  /** Recalcule les sommets face à la caméra. */
  orient(camera: Camera) {
    const n = this.pts.length;
    if (n < 2) {
      this.geo.setDrawRange(0, 0);
      return;
    }
    const cam = camera.position;
    const dir = new Vector3();
    const toCam = new Vector3();
    const side = new Vector3();
    for (let i = 0; i < n; i++) {
      const p = this.pts[i];
      const q = this.pts[Math.min(i + 1, n - 1)];
      const r = this.pts[Math.max(i - 1, 0)];
      dir.subVectors(q, r).normalize();
      toCam.subVectors(cam, p).normalize();
      side.crossVectors(dir, toCam).normalize();
      const f = i / (N - 1);
      const w = this.width * (1 - f * 0.6) * (i === 0 ? 0.6 : 1);
      this.pos.set([p.x + side.x * w, p.y + side.y * w, p.z + side.z * w], i * 6);
      this.pos.set([p.x - side.x * w, p.y - side.y * w, p.z - side.z * w], i * 6 + 3);
      const a = (1 - f) ** 1.6;
      this.alpha[i * 2] = a;
      this.alpha[i * 2 + 1] = a;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
  }
}
