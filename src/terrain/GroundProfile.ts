import { Vector3 } from 'three';

import { createGroundHit, type GroundDetector } from './GroundDetector.ts';

/** Bisection steps to locate an edge between two samples (the error halves each time). */
const EDGE_REFINE_STEPS = 5;
/** Most samples of a profile. */
const MAX_SAMPLES = 96;

/**
 * Flat (or gently sloped) stretch of ground between two edges: positions in meters along the profile's
 * direction, height linear between its ends.
 */
export interface Tread {
  start: number;
  end: number;
  /** Height of the ground (world) at `start` and at `end`. */
  startHeight: number;
  endHeight: number;
  /** Whether `start` / `end` is a real edge (false: the end of the sampled range). */
  startEdge: boolean;
  endEdge: boolean;
}

/**
 * Height profile of the ground along a horizontal line: the treads it is made of, separated by edges (a
 * jump in height of at least `edgeHeight` between two neighboring samples). Each edge is located by
 * bisection, so the samples can be spaced well apart.
 */
export class GroundProfile {
  /** Point of the line at position 0 (world; its height is not used). */
  readonly origin = new Vector3();
  /** Horizontal unit direction of the line (world). */
  readonly direction = new Vector3(0, 0, 1);
  readonly treads: Tread[] = [];
  /** Treads in use (`treads` keeps the rest allocated). */
  count = 0;

  private readonly hit = createGroundHit();
  private readonly probe = new Vector3();
  private castHeight = 0;
  private castDepth = 0;

  /**
   * Samples the ground from `from` to `to` (m along `direction` from `origin`) every `spacing` m. Each
   * sample looks for the ground from `castHeight` above the previous one (the first, above `startHeight`)
   * down to `castDepth` below it: it follows the ground however much it rises or falls in total, without
   * starting inside a high step or above a ceiling. Where there is no ground, the line is cut: what comes
   * after is not used.
   */
  sample(
    detector: GroundDetector,
    origin: Vector3,
    direction: Vector3,
    from: number,
    to: number,
    spacing: number,
    edgeHeight: number,
    startHeight: number,
    castHeight: number,
    castDepth: number,
  ): void {
    this.origin.copy(origin);
    this.direction.set(direction.x, 0, direction.z).normalize();
    this.castHeight = castHeight;
    this.castDepth = castDepth;
    this.count = 0;
    const n = Math.min(Math.max(Math.ceil((to - from) / spacing), 1), MAX_SAMPLES - 1);
    const step = (to - from) / n;
    let previous = this.heightAt(detector, from, startHeight);
    if (!Number.isFinite(previous)) return;
    let tread = this.addTread(from, previous, false);
    for (let i = 1; i <= n; i++) {
      const u = from + i * step;
      const h = this.heightAt(detector, u, previous);
      if (!Number.isFinite(h)) break;
      let edge = Number.NaN;
      let loHeight = previous;
      if (Math.abs(h - previous) >= edgeHeight) {
        // Borde entre las dos muestras: se busca por bisección (cada punto, del lado cuya altura se parece más).
        let lo = u - step;
        let hi = u;
        let hiHeight = h;
        for (let k = 0; k < EDGE_REFINE_STEPS; k++) {
          const mid = (lo + hi) / 2;
          const hm = this.heightAt(detector, mid, Math.max(previous, h));
          if (Number.isFinite(hm) && Math.abs(hm - previous) < Math.abs(hm - h)) {
            lo = mid;
            loHeight = hm;
          } else {
            hi = mid;
            hiHeight = hm;
          }
        }
        // Un escalón sigue siendo un salto entre dos puntos muy juntos; una pendiente fuerte (un bache), no.
        if (Math.abs(hiHeight - loHeight) >= edgeHeight / 2) edge = (lo + hi) / 2;
      }
      if (!Number.isNaN(edge)) {
        tread.end = edge;
        tread.endHeight = loHeight;
        tread.endEdge = true;
        tread = this.addTread(edge, h, true);
      } else {
        tread.end = u;
        tread.endHeight = h;
      }
      previous = h;
    }
  }

  /** Number of edges in the profile. */
  get edges(): number {
    return Math.max(this.count - 1, 0);
  }

  /** Position along the line (m) of a world point. */
  along(point: Vector3): number {
    return (point.x - this.origin.x) * this.direction.x + (point.z - this.origin.z) * this.direction.z;
  }

  /** World point of the line at `u` (height 0). */
  point(u: number, out: Vector3): Vector3 {
    return out.copy(this.origin).addScaledVector(this.direction, u).setY(0);
  }

  /** Keeps only the first `count` treads: the profile ends at the end of the last one. */
  truncate(count: number): void {
    this.count = Math.min(this.count, count);
    if (this.count > 0) this.treads[this.count - 1].endEdge = false;
  }

  /** Moves the heights by `dy` (see `LocomotionController.shift`). */
  shiftHeights(dy: number): void {
    for (let i = 0; i < this.count; i++) {
      this.treads[i].startHeight += dy;
      this.treads[i].endHeight += dy;
    }
  }

  /** Index of the tread at `u` (−1 outside the profile). */
  treadIndex(u: number): number {
    for (let i = 0; i < this.count; i++) {
      const t = this.treads[i];
      if (u >= t.start && u <= t.end) return i;
    }
    return -1;
  }

  /** Height of the profile at `u` (world; −Infinity outside it). */
  height(u: number): number {
    const i = this.treadIndex(u);
    return i < 0 ? Number.NEGATIVE_INFINITY : treadHeight(this.treads[i], u);
  }

  /** Highest ground of the profile between `u0` and `u1` (world; −Infinity if none). */
  maxHeight(u0: number, u1: number): number {
    const a = Math.min(u0, u1);
    const b = Math.max(u0, u1);
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.count; i++) {
      const t = this.treads[i];
      if (t.end < a || t.start > b) continue;
      max = Math.max(max, treadHeight(t, Math.max(a, t.start)), treadHeight(t, Math.min(b, t.end)));
    }
    return max;
  }

  /**
   * Smooth line over the treads (world height at `u`; NaN outside the profile): through the middle of each
   * tread shorter than 2·`reach` and, on longer ones, flat up to `reach` from each edge. It rises like the
   * stairs on average, without steps.
   */
  line(u: number, reach: number): number {
    if (this.count === 0 || u < this.treads[0].start || u > this.treads[this.count - 1].end) return Number.NaN;
    // Nudos (posición, altura) de cada huella, en orden; se interpola entre los dos que rodean a u.
    let previousU = Number.NaN;
    let previousH = Number.NaN;
    for (let i = 0; i < this.count; i++) {
      const t = this.treads[i];
      const short = t.end - t.start < 2 * reach && t.startEdge && t.endEdge;
      const a = short ? (t.start + t.end) / 2 : t.startEdge ? Math.min(t.start + reach, t.end) : t.start;
      const b = short ? a : t.endEdge ? Math.max(t.end - reach, a) : t.end;
      const ha = treadHeight(t, a);
      if (u <= a) return Number.isNaN(previousU) ? ha : previousH + ((ha - previousH) * (u - previousU)) / (a - previousU);
      if (u <= b) return treadHeight(t, u);
      previousU = b;
      previousH = treadHeight(t, b);
    }
    return previousH;
  }

  private addTread(start: number, height: number, edge: boolean): Tread {
    if (this.treads.length <= this.count) {
      this.treads.push({ start: 0, end: 0, startHeight: 0, endHeight: 0, startEdge: false, endEdge: false });
    }
    const t = this.treads[this.count++];
    t.start = start;
    t.end = start;
    t.startHeight = height;
    t.endHeight = height;
    t.startEdge = edge;
    t.endEdge = false;
    return t;
  }

  /** Height of the ground at `u`, looking for it around the height `near`; −Infinity if there is none. */
  private heightAt(detector: GroundDetector, u: number, near: number): number {
    const p = this.probe.copy(this.origin).addScaledVector(this.direction, u);
    p.y = near + this.castHeight;
    return detector.castDown(p, this.castHeight + this.castDepth, this.hit) ? this.hit.point.y : Number.NEGATIVE_INFINITY;
  }
}

/** Height of a tread at `u` (linear between its ends). */
export function treadHeight(t: Tread, u: number): number {
  const length = t.end - t.start;
  if (length <= 1e-9) return t.startHeight;
  return t.startHeight + ((t.endHeight - t.startHeight) * (u - t.start)) / length;
}
