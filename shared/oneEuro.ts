/**
 * Filtre One Euro (Casiez, Roussel, Vogel 2012) : lisse fortement les petits
 * mouvements (tremblement) tout en restant réactif sur les mouvements rapides.
 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  constructor(
    public minCutoff = 1.2,
    public beta = 0.6,
    public dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, dt: number): number {
    if (this.xPrev === null || dt <= 0) {
      this.xPrev = x;
      return x;
    }
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuroFilter.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}
