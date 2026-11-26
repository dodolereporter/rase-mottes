// Moteur de rendu : scène, vues (1 à 4), caméras, missiles, effets, qualité adaptative.

import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  Points,
  PointsMaterial,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { Box } from '../../../../shared/collision';
import { Pilot } from '../../../../shared/sim';
import { CHUNK_LEN, DISTRICT_LEN, World, clamp } from '../../../../shared/world';
import { CityRenderer } from './city';
import { ambient, createCeilingMaterial, createGroundMaterial, createSkyMaterial } from './materials';
import { createMissile } from './missile';
import { PALETTES, Palette, mixPalette } from './palette';
import { Particles } from './particles';
import { PostFX, View } from './post';

export interface PilotView {
  pilot: Pilot;
  color: string;
  missile: Group;
  camera: PerspectiveCamera;
  camPos: { x: number; y: number; z: number };
  roll: number;
  bank: number;
  shake: number;
  flash: number;
  flashColor: [number, number, number];
  fov: number;
  palette: Palette;
  label?: string;
  crashT: number;
  ghost?: Group;
  ghostPos?: { x: number; y: number; z: number } | null;
}

const QUALITY_LEVELS = [
  { pr: 2, bloom: true },
  { pr: 1.5, bloom: true },
  { pr: 1.25, bloom: true },
  { pr: 1, bloom: true },
  { pr: 0.85, bloom: true },
  { pr: 0.85, bloom: false },
  { pr: 0.7, bloom: false },
];

/** Circulation aérienne lointaine : files de feux qui filent entre les tours (décor). */
class Traffic {
  readonly points: Points;
  private n = 360;
  private lane = new Float32Array(this.n * 4); // décalage x, y, vitesse, z
  private pos = new Float32Array(this.n * 3);
  private col = new Float32Array(this.n * 3);
  constructor() {
    for (let i = 0; i < this.n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const dir = Math.random() < 0.5 ? -1 : 1;
      this.lane[i * 4] = side * (40 + Math.random() * 110);
      this.lane[i * 4 + 1] = 35 + Math.floor(Math.random() * 6) * 14 + Math.random() * 2;
      this.lane[i * 4 + 2] = dir * (35 + Math.random() * 40);
      this.lane[i * 4 + 3] = Math.random() * 1200;
      const c = dir > 0 ? new Color('#ff3030') : new Color('#fff2d0');
      c.multiplyScalar(dir > 0 ? 1.2 : 1.6);
      this.col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new BufferAttribute(this.col, 3));
    this.points = new Points(geo, new PointsMaterial({ size: 2.2, vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
    this.points.frustumCulled = false;
  }
  update(dt: number, baseZ: number, world: World) {
    for (let i = 0; i < this.n; i++) {
      let rz = this.lane[i * 4 + 3] + this.lane[i * 4 + 2] * dt;
      rz = ((rz % 1200) + 1200) % 1200;
      this.lane[i * 4 + 3] = rz;
      const z = baseZ - 100 + rz;
      const p = world.pathAt(Math.max(0, z));
      this.pos[i * 3] = p.x + this.lane[i * 4];
      this.pos[i * 3 + 1] = this.lane[i * 4 + 1];
      this.pos[i * 3 + 2] = -z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

export class GameRenderer {
  renderer: WebGLRenderer;
  scene = new Scene();
  city: CityRenderer;
  post: PostFX;
  particles = new Particles();
  views: PilotView[] = [];
  private sky: Mesh;
  private skyMat = createSkyMaterial();
  private ground: Mesh;
  private groundMat = createGroundMaterial();
  private debugLines: LineSegments | null = null;
  private ceiling: Mesh;
  private traffic = new Traffic();
  private ceilingMat = createCeilingMaterial();
  private width = 1;
  private height = 1;
  quality = 0;
  private frameTimes: number[] = [];
  private lastQualityChange = 0;
  fps = 60;

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    debug: boolean,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    const maxPr = Math.min(window.devicePixelRatio || 1, 2);
    this.quality = QUALITY_LEVELS.findIndex((q) => q.pr <= maxPr + 0.01);

    this.city = new CityRenderer(world);
    this.scene.add(this.city.group);

    this.sky = new Mesh(new SphereGeometry(50, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    this.ground = new Mesh(new PlaneGeometry(6000, 6000), this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.frustumCulled = false;
    this.scene.add(this.ground);
    this.scene.add(this.particles.points);

    this.scene.add(this.traffic.points);
    this.ceiling = new Mesh(new PlaneGeometry(300, 1400), this.ceilingMat);
    this.ceiling.rotation.x = -Math.PI / 2;
    this.ceiling.frustumCulled = false;
    this.ceiling.renderOrder = 5;
    this.scene.add(this.ceiling);

    if (debug) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(400 * 24 * 3), 3));
      this.debugLines = new LineSegments(geo, new LineBasicMaterial({ color: '#00ff88' }));
      this.debugLines.frustumCulled = false;
      this.scene.add(this.debugLines);
    }

    this.post = new PostFX(this.renderer, this.scene);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setWorld(world: World) {
    this.world = world;
    this.city.setWorld(world);
    this.particles.clear();
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const pr = Math.min(QUALITY_LEVELS[this.quality].pr, window.devicePixelRatio > 1 ? 2 : 1.25);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height, false);
    this.post.setSize(this.width, this.height, pr);
    this.post.bloom.enabled = QUALITY_LEVELS[this.quality].bloom;
    this.particles.setViewportHeight(this.height * pr);
    this.particles.scale = this.quality >= 5 ? 0.5 : 1;
    this.layoutViews();
  }

  setPilots(list: { pilot: Pilot; color: string; label?: string }[], ghost = false) {
    for (const v of this.views) {
      this.scene.remove(v.missile);
      if (v.ghost) this.scene.remove(v.ghost);
    }
    this.views = list.map(({ pilot, color, label }) => {
      const missile = createMissile(color);
      this.scene.add(missile);
      const camera = new PerspectiveCamera(70, 1, 0.2, 2600);
      const v: PilotView = {
        pilot,
        color,
        missile,
        camera,
        camPos: { x: pilot.x, y: pilot.y + 2.5, z: pilot.z - 9 },
        roll: 0,
        bank: 0,
        shake: 0,
        flash: 0,
        flashColor: [1, 1, 1],
        fov: 70,
        palette: mixPalette(PALETTES[0], PALETTES[0], 0),
        label,
        crashT: 0,
      };
      if (ghost) {
        v.ghost = createMissile('#ffffff', true);
        v.ghost.visible = false;
        this.scene.add(v.ghost);
      }
      return v;
    });
    this.layoutViews();
  }

  private rects: View['rect'][] = [];
  private layoutViews() {
    const n = this.views.length;
    if (n <= 1) this.rects = [{ x: 0, y: 0, w: 1, h: 1 }];
    else if (n === 2) this.rects = [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ];
    else this.rects = [
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    ];
    this.views.forEach((v, i) => {
      const r = this.rects[i];
      v.camera.aspect = (r.w * this.width) / (r.h * this.height);
      v.camera.updateProjectionMatrix();
    });
  }

  /** Rectangles des vues en pixels CSS (origine en haut à gauche) pour le HUD. */
  viewRectsCss() {
    return this.rects.slice(0, this.views.length).map((r) => ({
      left: r.x * this.width,
      top: (1 - r.y - r.h) * this.height,
      width: r.w * this.width,
      height: r.h * this.height,
    }));
  }

  private paletteAt(z: number, out: Palette) {
    const k = Math.floor(z / DISTRICT_LEN);
    const into = z - k * DISTRICT_LEN;
    const cur = PALETTES[this.world.districtIndexAt(z)];
    if (into < 160 && k > 0) {
      const prev = PALETTES[this.world.districtIndexAt(z - 170)];
      mixPalette(prev, cur, into / 160, out);
    } else mixPalette(cur, cur, 0, out);
  }

  /** Effets ponctuels. */
  kick(i: number, shake: number, flash = 0, color: [number, number, number] = [1, 1, 1]) {
    const v = this.views[i];
    if (!v) return;
    v.shake = Math.max(v.shake, shake);
    if (flash > v.flash) {
      v.flash = flash;
      v.flashColor = color;
    }
  }

  explode(i: number) {
    const v = this.views[i];
    if (!v) return;
    const p = v.pilot;
    const c = new Color(v.color);
    this.particles.burst(p.x, p.y, -p.z, 260, 45, new Color('#ffb347').multiplyScalar(2), 1.6, 1.2);
    this.particles.burst(p.x, p.y, -p.z, 160, 70, c.clone().multiplyScalar(2.5), 1.0, 0.9);
    this.particles.burst(p.x, p.y, -p.z, 80, 20, new Color('#ffffff').multiplyScalar(2), 2.6, 0.5);
    v.missile.visible = false;
    v.crashT = 0.001;
    this.kick(i, 1.6, 0.9, [1, 0.55, 0.3]);
  }

  sparks(i: number, side: number) {
    const v = this.views[i];
    if (!v) return;
    const p = v.pilot;
    const c = new Color(v.color).multiplyScalar(2.5);
    for (let k = 0; k < 18 * this.particles.scale; k++)
      this.particles.emit(p.x + side * 0.8, p.y, -p.z, side * (8 + Math.random() * 15), (Math.random() - 0.5) * 12, 20 + Math.random() * 30, c, 0.5, 0.35, 3);
  }

  /** Une image : alpha = fraction d'interpolation, realDt = temps réel écoulé, t = temps du monde. */
  render(alpha: number, realDt: number, t: number, ghostFrame?: (i: number) => { x: number; y: number; z: number } | null) {
    // qualité adaptative
    this.frameTimes.push(realDt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = 1 / Math.max(avg, 1e-3);
    const now = performance.now();
    if (this.frameTimes.length >= 90 && now - this.lastQualityChange > 2500 && document.visibilityState === 'visible') {
      if (this.fps < 55 && this.quality < QUALITY_LEVELS.length - 1) {
        this.quality++;
        this.lastQualityChange = now;
        this.frameTimes = [];
        this.resize();
      } else if (this.fps > 59.5 && avg < 1 / 75 && this.quality > 0 && now - this.lastQualityChange > 15000) {
        // marge confortable : on remonte d'un cran (rarement)
        this.quality--;
        this.lastQualityChange = now;
        this.frameTimes = [];
        this.resize();
      }
    }

    ambient.uTime.value = t;

    // tronçons nécessaires pour chaque pilote
    const ranges: [number, number][] = this.views.map((v) => {
      const c = Math.floor(v.pilot.z / CHUNK_LEN);
      return [c - 1, c + 5];
    });
    this.city.update(ranges, t);

    const views: View[] = [];
    this.views.forEach((v, i) => {
      const p = v.pilot;
      const x = p.prev.x + (p.x - p.prev.x) * alpha;
      const y = p.prev.y + (p.y - p.prev.y) * alpha;
      const z = p.prev.z + (p.z - p.prev.z) * alpha;
      const lm = p.latMax || 1;

      // missile : roulis dans les virages, tangage selon la montée
      const targetBank = -clamp(p.vx / lm, -1, 1) * 0.95;
      v.bank += (targetBank - v.bank) * (1 - Math.exp(-realDt * 14));
      v.missile.position.set(x, y, -z);
      // le nez pointe dans la direction de vol réelle (cap et assiette pilotés par le téléphone)
      const fwd = Math.max(p.speed, 1);
      v.missile.rotation.set(Math.atan2(p.vy, fwd) * 1.3, -Math.atan2(p.vx, fwd) * 1.3, v.bank, 'YXZ');
      const flame = v.missile.getObjectByName('flame');
      if (flame) flame.scale.set(1, 1, (p.boosting ? 2.2 : 1) * (0.85 + Math.random() * 0.3));
      const sh = v.missile.getObjectByName('shield');
      if (sh) sh.visible = p.shield;

      // traînée
      if (p.alive) {
        const c = new Color(v.color).multiplyScalar(p.boosting ? 1.8 : 1.0);
        const n = Math.ceil((p.boosting ? 4 : 2) * this.particles.scale);
        for (let k = 0; k < n; k++)
          this.particles.emit(x + (Math.random() - 0.5) * 0.3, y + (Math.random() - 0.5) * 0.3, -z + 2.2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 8, c, p.boosting ? 0.9 : 0.6, 0.35, 1);
      } else if (v.crashT > 0) {
        v.crashT += realDt;
        if (v.crashT < 2.5 && Math.random() < 0.6)
          this.particles.emit(x + (Math.random() - 0.5) * 3, y, -z, (Math.random() - 0.5) * 3, 6 + Math.random() * 6, (Math.random() - 0.5) * 3, new Color('#ff7a30').multiplyScalar(1.5), 2.5, 1.2, 1);
      }

      // caméra : suit avec un léger retard, roulis partiel
      const speed01 = clamp((p.speed - 60) / 220, 0, 1);
      const back = 8.5 + speed01 * 2.5;
      const k = 1 - Math.exp(-realDt * (p.alive ? 9 : 2));
      v.camPos.x += (x - v.camPos.x) * k;
      v.camPos.y += (y + 2.3 - v.camPos.y) * k;
      v.camPos.z = p.alive ? z - back : v.camPos.z + (z - back - 6 - v.camPos.z) * k;
      v.roll += (v.bank * 0.35 - v.roll) * (1 - Math.exp(-realDt * 6));
      v.shake = Math.max(0, v.shake - realDt * 2.2);
      v.flash = Math.max(0, v.flash - realDt * 2.5);
      const shk = v.shake * v.shake * 0.9 + (p.boosting ? 0.05 : 0) + speed01 * 0.02;
      const cam = v.camera;
      cam.position.set(v.camPos.x + (Math.random() - 0.5) * shk, v.camPos.y + (Math.random() - 0.5) * shk, -v.camPos.z);
      cam.lookAt(x * 0.7 + v.camPos.x * 0.3, y + 0.6, -(z + 40));
      cam.rotateZ(v.roll);
      const fovTarget = 68 + speed01 * 22 + (p.boosting ? 8 : 0) - (p.brakeT > 0 ? 6 : 0);
      v.fov += (fovTarget - v.fov) * (1 - Math.exp(-realDt * 4));
      cam.fov = v.fov;
      cam.updateProjectionMatrix();

      this.paletteAt(z, v.palette);

      // fantôme
      if (v.ghost && ghostFrame) {
        const gp = ghostFrame(i);
        v.ghostPos = gp;
        v.ghost.visible = !!gp;
        if (gp) v.ghost.position.set(gp.x, gp.y, -gp.z);
      }

      views.push({
        camera: cam,
        rect: this.rects[i],
        speed: p.alive ? speed01 * 0.8 + (p.boosting ? 0.5 : 0) : 0,
        aberration: p.boosting ? 1 : p.slowmoT > 0 ? 0.4 : 0,
        flash: v.flash,
        flashColor: v.flashColor,
        before: () => this.beforeView(v, t),
      });
    });

    this.particles.update(realDt);
    if (this.views[0]) this.traffic.update(realDt, this.views[0].pilot.z, this.world);
    // en tunnel, pas de circulation aérienne visible
    this.traffic.points.visible = !!this.views[0] && this.world.districtDef(this.views[0].pilot.z).ceiling === undefined;
    if (this.debugLines && this.views[0]) this.updateDebug(this.views[0].pilot, t);
    this.post.render(views, t);
  }

  private beforeView(v: PilotView, t: number) {
    const pal = v.palette;
    ambient.fogColor.value.copy(pal.fog);
    ambient.fogNear.value = pal.fogNear;
    ambient.fogFar.value = pal.fogFar;
    ambient.uNeonA.value.copy(pal.neonA);
    ambient.uNeonB.value.copy(pal.neonB);
    ambient.uWindow.value.copy(pal.window);
    const su = this.skyMat.uniforms;
    su.uTop.value.copy(pal.skyTop);
    su.uBottom.value.copy(pal.skyBottom);
    su.uHorizon.value.copy(pal.horizon);
    su.uSkyline.value.copy(pal.skyline);
    this.sky.position.copy(v.camera.position);
    const gu = this.groundMat.uniforms;
    gu.uGround.value.copy(pal.ground);
    gu.uGrid.value.copy(pal.grid);
    gu.uWater.value = pal.water;
    this.ground.position.set(Math.round(v.camera.position.x / 10) * 10, 0, Math.round(v.camera.position.z / 10) * 10);
    this.city.prepareView(t, (id) => v.pilot.isTaken(id));
    // plafond du couloir (absent dans les tunnels, qui ont un vrai plafond)
    const pz = v.pilot.z;
    const tunnel = this.world.districtDef(pz).ceiling !== undefined;
    this.ceiling.visible = !tunnel;
    if (!tunnel) {
      const cy = this.world.ceilingAt(pz + 20);
      this.ceiling.position.set(v.pilot.x, cy, -(pz + 600));
      this.ceilingMat.uniforms.uNear.value = clamp(1 - (cy - v.pilot.y) / 7, 0, 1);
    }
    ambient.uLightPos.value.copy(v.missile.position);
    ambient.uLightPos.value.z += 1.5;
    ambient.uLightCol.value.set(v.color).multiplyScalar(v.pilot.alive ? (v.pilot.boosting ? 1.0 : 0.6) : 0);
    // les autres missiles restent visibles (écran partagé) ; le fantôme n'apparaît que dans sa vue
    for (const o of this.views) if (o.ghost) o.ghost.visible = o === v && !!o.ghostPos;
  }

  private updateDebug(p: Pilot, t: number) {
    const lines = this.debugLines!;
    const pos = lines.geometry.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    let n = 0;
    const pushBox = (b: Box) => {
      if (n >= 400) return;
      const xs = [b.minX, b.maxX];
      const ys = [b.minY, b.maxY];
      const zs = [-b.minZ, -b.maxZ];
      const corners: number[][] = [];
      for (const X of xs) for (const Y of ys) for (const Z of zs) corners.push([X, Y, Z]);
      const edges = [
        [0, 1], [2, 3], [4, 5], [6, 7],
        [0, 2], [1, 3], [4, 6], [5, 7],
        [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      let o = n * 72;
      for (const [a, b2] of edges) {
        arr.set(corners[a], o);
        arr.set(corners[b2], o + 3);
        o += 6;
      }
      n++;
    };
    for (const { box } of p.candidates(p.z - 5, p.z + 120, t)) pushBox({ ...box });
    lines.geometry.setDrawRange(0, n * 24);
    pos.needsUpdate = true;
  }
}
