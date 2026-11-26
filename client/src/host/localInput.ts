import type { PilotInput } from '../../../shared/sim';

/** Clavier (flèches / ZQSD / WASD, espace = boost, Maj = aérofrein) et manette Gamepad API. */
export class LocalInput {
  private keys = new Set<string>();
  private sx = 0;
  private sy = 0;
  lastActive = 0;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.lastActive = performance.now();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private k(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  /** Entrée combinée, lissée pour le clavier (sinon trop binaire). */
  read(dt: number): PilotInput & { active: boolean } {
    const tx = (this.k('ArrowRight', 'KeyD') ? 1 : 0) - (this.k('ArrowLeft', 'KeyA', 'KeyQ') ? 1 : 0);
    const ty = (this.k('ArrowUp', 'KeyW', 'KeyZ') ? 1 : 0) - (this.k('ArrowDown', 'KeyS') ? 1 : 0);
    const r = 1 - Math.exp(-dt / 0.07);
    this.sx += (tx - this.sx) * r;
    this.sy += (ty - this.sy) * r;
    let x = this.sx;
    let y = this.sy;
    let boost = this.k('Space');
    let brake = this.k('ShiftLeft', 'ShiftRight', 'KeyB');
    const pads = navigator.getGamepads?.() ?? [];
    for (const gp of pads) {
      if (!gp) continue;
      const ax = gp.axes[0] ?? 0;
      const ay = gp.axes[1] ?? 0;
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
      if (dz(ax) || dz(ay)) {
        x = dz(ax);
        y = -dz(ay);
        this.lastActive = performance.now();
      }
      if (gp.buttons[0]?.pressed || gp.buttons[7]?.pressed) {
        boost = true;
        this.lastActive = performance.now();
      }
      if (gp.buttons[1]?.pressed || gp.buttons[6]?.pressed) brake = true;
    }
    const active = Math.abs(x) > 0.01 || Math.abs(y) > 0.01 || boost || brake;
    return { x, y, boost, brake, active };
  }

  /** Bouton « start » de la manette Gamepad (appui détecté par front montant). */
  private prevStart = false;
  startPressed(): boolean {
    let pressed = false;
    for (const gp of navigator.getGamepads?.() ?? []) if (gp && (gp.buttons[9]?.pressed || gp.buttons[0]?.pressed)) pressed = true;
    const edge = pressed && !this.prevStart;
    this.prevStart = pressed;
    return edge;
  }
}
