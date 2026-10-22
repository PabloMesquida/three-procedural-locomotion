/**
 * Smooth, deterministic noise over time (1D value noise), for natural variations: the same seed always
 * gives the same motion; different seeds, characters that don't move the same way. Each "channel" is an
 * independent signal.
 */
export class SmoothNoise {
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = Math.floor(seed) >>> 0;
  }

  /**
   * Value in [-1, 1] of channel `channel` at time `t` (in "cycles": it changes to a new random value about
   * `t` times). Sum of two octaves with quintic interpolation (continuous derivatives: no jerks).
   */
  sample(channel: number, t: number): number {
    return (this.octave(channel, t) * 2 + this.octave(channel + 1000, t * 2.3)) / 3;
  }

  private octave(channel: number, t: number): number {
    const i = Math.floor(t);
    const f = t - i;
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    const a = this.hash(channel, i);
    const b = this.hash(channel, i + 1);
    return a + (b - a) * u;
  }

  /** Integer → pseudo-random value in [-1, 1] (integer hash, stateless). */
  private hash(channel: number, i: number): number {
    let h = (this.seed ^ Math.imul(channel + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i, 0xc2b2ae35)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
    return ((h >>> 0) / 0xffffffff) * 2 - 1;
  }
}
