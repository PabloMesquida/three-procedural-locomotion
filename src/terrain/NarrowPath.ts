import { Vector3 } from 'three';

import { createGroundHit, type GroundDetector } from './GroundDetector.ts';

const UP = new Vector3(0, 1, 0);
/**
 * Ground lower than the path by this much (× stepLength; 10 cm with the default one) is a drop at its side: a
 * path between such drops, narrower than `narrowWidth`, is narrow.
 */
export const NARROW_DROP = 0.125;
/** Bisection steps to find each edge (with `narrowWidth` 0.3 m, to ≈ 2 cm). */
const EDGE_STEPS = 3;
/**
 * Two centres measured at least this far apart (m) give the direction of the path: the middle of any cut across
 * it, also slanting, is on its middle line. It is used only if it is more than ALONG_SLANT (cosine) off the travel:
 * the edges are found to ≈ 1 cm, and along the path the direction of travel is more precise.
 */
const MIN_ALONG = 0.25;
const ALONG_SLANT = Math.cos((10 * Math.PI) / 180);

/** Where and how it looks for the edges of the path (see NarrowPath.probe). */
export interface NarrowProbe {
  /** Horizontal direction of travel (unit, world). */
  forward: Vector3;
  /** Point on the line of travel where it measures, at the height of the ground under the body (world). */
  point: Vector3;
  /** Height of the ground under the body (m, world). */
  ground: number;
  /** Paths narrower than this are narrow (m). */
  width: number;
  /** Ground lower than `ground` by at least this much is a drop (m). */
  drop: number;
  /** Height above `ground` the rays start from (m). */
  rayHeight: number;
  /**
   * The ground ahead may be at another level (a step: a beam that starts higher than the body): it measures the
   * middle first and compares the sides with it. One more ray.
   */
  levelAhead?: boolean;
}

/**
 * Narrow paths: a beam, the top of a wall, a rail. A path is narrow when, across the direction of travel, the
 * ground at the level of the body drops on both sides (more than `drop`) within less than `width`. It needs
 * nothing marked: it looks at the ground with a few rays across the line of travel, ahead of the body.
 *
 * Each probe casts one ray, alternating sides, at half the width: on open ground that is all. Only if that side
 * drops does it look for the edge (bisection), then on the other side at `width` from it and, if that drops too,
 * for the other edge: the path is narrow, and its centre is between both.
 */
export class NarrowPath {
  /** The last probe found a narrow path (or the one before, if the last one couldn't tell). */
  narrow = false;
  /** Centre of the path where it was last measured (world; on the ground of the body). */
  readonly center = new Vector3();
  /**
   * Direction across the path (horizontal, unit; to the right of the travel): from two centres measured one after
   * the other on the path or, with only one, across the travel then. The path runs perpendicular to it through
   * `center`.
   */
  readonly across = new Vector3(1, 0, 0);
  /** Width of the path where it was last measured (m; Infinity if not narrow). */
  width = Number.POSITIVE_INFINITY;
  /**
   * Where the narrow path ended ahead (world; NaN if it hasn't ended): the probe looks ahead of the body, which is
   * still on the path until it gets there.
   */
  readonly end = new Vector3(Number.NaN, 0, 0);

  private readonly detector: GroundDetector;
  private readonly hit = createGroundHit();
  private readonly origin = new Vector3();
  private readonly right = new Vector3();
  /** Height the sides are compared with in the current probe (m, world). */
  private level = 0;
  /** Centre from which it measures the direction of the path (NaN: none yet). */
  private readonly lastCenter = new Vector3(Number.NaN, 0, 0);
  /** Side the next probe looks at first (+1 right, −1 left). */
  private side = 1;

  constructor(detector: GroundDetector) {
    this.detector = detector;
  }

  /** Forgets the path (after a reset or a teleport). */
  reset(): void {
    this.narrow = false;
    this.width = Number.POSITIVE_INFINITY;
    this.end.x = Number.NaN;
    this.lastCenter.x = Number.NaN;
    this.side = 1;
  }

  /** Moves the stored world positions (see `LocomotionController.shift`). */
  shift(offset: Vector3): void {
    this.center.add(offset);
    this.end.add(offset);
    this.lastCenter.add(offset);
  }

  /** On a narrow path, or still before the point where it ended (going `forward` from `position`). */
  onPath(position: Vector3, forward: Vector3): boolean {
    if (this.narrow) return true;
    if (Number.isNaN(this.end.x)) return false;
    if ((this.end.x - position.x) * forward.x + (this.end.z - position.z) * forward.z > 0) return true;
    this.end.x = Number.NaN;
    return false;
  }

  /** Measures the path across `probe.forward` at `probe.point`; returns the rays it cast. */
  probe(probe: NarrowProbe): number {
    const right = this.right.crossVectors(probe.forward, UP).normalize();
    let rays = 0;
    const drops = (x: number): boolean => {
      rays++;
      return this.dropAt(probe, right, x);
    };
    const s = this.side;
    this.side = -s;
    const half = probe.width / 2;
    this.level = probe.ground;
    if (probe.levelAhead) {
      rays++;
      const origin = this.origin.copy(probe.point);
      origin.y = probe.ground + probe.rayHeight;
      if (this.detector.castDown(origin, 2 * probe.rayHeight, this.hit)) this.level = this.hit.point.y;
    }
    // Around the line of travel or, on a narrow path, around its centre (the body may go off it a little).
    const c = this.narrow ? this.offset(probe.point) / Math.max(right.dot(this.across), 0.5) : 0;
    if (!drops(c + s * half)) {
      // Ground at half the width on this side: if the path were narrow, the other side would drop before half
      // the width (the next probe looks there first).
      if (this.narrow) this.setWide(probe.point);
      return rays;
    }
    // Without ground in the middle (the end of the path ahead, a gap), it can't tell: as it was.
    if (drops(c)) return rays;
    const edge = this.edge(c, c + s * half, drops);
    const across = edge - s * probe.width;
    if (!drops(across)) {
      if (this.narrow) this.setWide(probe.point);
      return rays;
    }
    const other = this.edge(c, across, drops);
    this.center.copy(probe.point).addScaledVector(right, (edge + other) / 2);
    this.center.y = this.level;
    this.alongPath(right);
    this.narrow = true;
    this.end.x = Number.NaN;
    // Medido en un corte oblicuo, el ancho de verdad es menor.
    this.width = Math.abs(edge - other) * Math.abs(right.dot(this.across));
    return rays;
  }

  /** `across` from the new centre and the last one (see MIN_ALONG) or, if it can't, `right`. */
  private alongPath(right: Vector3): void {
    const last = this.lastCenter;
    if (!this.narrow || Number.isNaN(last.x)) {
      this.across.copy(right);
      last.copy(this.center);
      return;
    }
    const dx = this.center.x - last.x;
    const dz = this.center.z - last.z;
    const d = Math.hypot(dx, dz);
    if (d < MIN_ALONG) return;
    // A lo largo (dx, dz) × arriba = (−dz, 0, dx), hacia la derecha del avance.
    const sign = -dz * right.x + dx * right.z >= 0 ? 1 : -1;
    this.across.set((-dz / d) * sign, 0, (dx / d) * sign);
    if (this.across.dot(right) > ALONG_SLANT) this.across.copy(right);
    last.copy(this.center);
  }

  /** Distance (m, horizontal) from `point` to the middle of the path, in the direction of `across` (negative: against it). */
  offset(point: Vector3): number {
    return (this.center.x - point.x) * this.across.x + (this.center.z - point.z) * this.across.z;
  }

  /** The path is no longer narrow from `point` (where the probe looked). */
  private setWide(point: Vector3): void {
    this.narrow = false;
    this.width = Number.POSITIVE_INFINITY;
    this.end.copy(point);
    this.lastCenter.x = Number.NaN;
  }

  /** Edge between `inside` (ground) and `outside` (drop), lateral offsets (m), by bisection. */
  private edge(inside: number, outside: number, drops: (x: number) => boolean): number {
    for (let i = 0; i < EDGE_STEPS; i++) {
      const mid = (inside + outside) / 2;
      if (drops(mid)) outside = mid;
      else inside = mid;
    }
    return (inside + outside) / 2;
  }

  /** The ground `x` m to the right of the point (left if negative) is lower than `level` by `drop`, or missing. */
  private dropAt(probe: NarrowProbe, right: Vector3, x: number): boolean {
    const origin = this.origin.copy(probe.point).addScaledVector(right, x);
    origin.y = this.level + probe.rayHeight;
    if (!this.detector.castDown(origin, probe.rayHeight + probe.drop, this.hit)) return true;
    return this.hit.point.y < this.level - probe.drop;
  }
}
