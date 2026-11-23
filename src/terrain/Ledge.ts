import { Vector3 } from 'three';

import { createGroundHit, type GroundDetector } from './GroundDetector.ts';

const UP = new Vector3(0, 1, 0);
/**
 * The wall of a ledge has to rise at least this much above it (× stepLength; 1.1 m with the default one, and never
 * more than groundProbeHeight): against a lower one (a parapet) it walks as usual.
 */
export const LEDGE_WALL = 1.4;
/** Bisection steps to find the edge and the wall (with `ledgeWidth` 0.45 m, to ≈ 0.7 cm). */
const EDGE_STEPS = 5;
/**
 * It finds the wall again this far behind the probe (m) to know which way it runs (see Ledge.probe), to ≈ 1°. Less than
 * ALONG_SLANT (cosine) off the travel, it is the travel: going straight along it, without the noise of the measure.
 */
const ALONG_PROBE = 0.3;
const ALONG_SLANT = Math.cos((3 * Math.PI) / 180);

/** Where and how it looks for a ledge (see Ledge.probe). */
export interface LedgeProbe {
  /** Horizontal direction of travel (unit, world). */
  forward: Vector3;
  /** Point on the line of travel where it measures, at the height of the ground under the body (world). */
  point: Vector3;
  /** Height of the ground under the body (m, world). */
  ground: number;
  /** Ledges narrower than this (from the wall to the edge) count (m). */
  width: number;
  /** Ground lower than `ground` by more than this is a drop it can't step down (m). */
  drop: number;
  /** Ground higher than `ground` by at least this is a wall (m). */
  wall: number;
  /** Height above `ground` the rays start from (m). */
  rayHeight: number;
}

/** What a vertical ray finds across the line of travel. */
type Cut = 'ground' | 'drop' | 'wall' | 'other';

/**
 * Ledges: a strip of ground with a wall on one side and a drop it can't step down on the other (a cornice on a
 * cliff, the ledge of a building). It needs nothing marked: it looks at the ground with a few rays across the line
 * of travel, like NarrowPath.
 *
 * Each probe casts one ray, alternating sides, at half the width: on open ground that is all. If that side drops,
 * it looks for the edge (bisection) and then for a wall within `width` of it on the other side; if it finds a wall,
 * for its face and then for a drop on the other side. With both, it is a ledge: it finds the wall again a little
 * behind to know which way the ledge runs.
 */
export class Ledge {
  /** The last probe found a ledge. */
  ledge = false;
  /** Horizontal direction from the wall towards the drop (unit, world): where the body faces along it. */
  readonly out = new Vector3(0, 0, 1);
  /** A point of the face of the wall where it was last measured (world; on the ground of the ledge). */
  readonly wallPoint = new Vector3();
  /** Width of the ledge where it was last measured, from the wall to the edge (m; Infinity if there is none). */
  width = Number.POSITIVE_INFINITY;
  /** Where the ledge ended ahead (world; NaN if it hasn't ended): the probe looks ahead of the body. */
  readonly end = new Vector3(Number.NaN, 0, 0);

  private readonly detector: GroundDetector;
  private readonly hit = createGroundHit();
  private readonly origin = new Vector3();
  private readonly right = new Vector3();
  private readonly base = new Vector3();
  private readonly first = new Vector3();
  /** Side the next probe looks at first (+1 right, −1 left). */
  private side = 1;

  constructor(detector: GroundDetector) {
    this.detector = detector;
  }

  /** Forgets the ledge (after a reset or a teleport). */
  reset(): void {
    this.ledge = false;
    this.width = Number.POSITIVE_INFINITY;
    this.end.x = Number.NaN;
    this.side = 1;
  }

  /** Moves the stored world positions (see `LocomotionController.shift`). */
  shift(offset: Vector3): void {
    this.wallPoint.add(offset);
    this.end.add(offset);
  }

  /** On a ledge, or still before the point where it ended (going `forward` from `position`). */
  onLedge(position: Vector3, forward: Vector3): boolean {
    if (this.ledge) return true;
    if (Number.isNaN(this.end.x)) return false;
    if ((this.end.x - position.x) * forward.x + (this.end.z - position.z) * forward.z > 0) return true;
    this.end.x = Number.NaN;
    return false;
  }

  /** Distance (m, horizontal) from `point` to the face of the wall, along `out` (negative: behind it). */
  fromWall(point: Vector3): number {
    return (point.x - this.wallPoint.x) * this.out.x + (point.z - this.wallPoint.z) * this.out.z;
  }

  /** Measures across `probe.forward` at `probe.point`; returns the rays it cast. */
  probe(probe: LedgeProbe): number {
    const right = this.right.crossVectors(probe.forward, UP).normalize();
    let rays = 0;
    const cut = (x: number): Cut => {
      rays++;
      return this.cutAt(probe, right, x);
    };
    this.base.copy(probe.point);
    let s = this.side;
    this.side = -s;
    const half = probe.width / 2;
    let found = cut(s * half);
    if (found === 'ground' || found === 'other') {
      // En una cornisa, el otro lado también (el cuerpo va pegado a la pared: el borde puede quedar más allá).
      if (!this.ledge) return rays;
      s = -s;
      found = cut(s * half);
      if (found === 'ground' || found === 'other') return this.setNone(probe.point, rays);
    }
    // Sin suelo en la línea (el final de la cornisa por delante, un hueco), no se sabe: como estaba.
    if (cut(0) !== 'ground') return rays;
    const looking = found;
    const near = this.boundary(0, s * half, looking, cut);
    const wanted: Cut = looking === 'drop' ? 'wall' : 'drop';
    const far = near - s * probe.width;
    if (cut(far) !== wanted) return this.setNone(probe.point, rays);
    const other = this.boundary(0, far, wanted, cut);
    const wallAt = looking === 'wall' ? near : other;
    const edgeAt = looking === 'wall' ? other : near;
    // La pared, otra vez un poco más atrás: hacia dónde va.
    this.first.copy(probe.point).addScaledVector(right, wallAt);
    this.base.copy(probe.point).addScaledVector(probe.forward, -ALONG_PROBE);
    const sideOfWall = Math.sign(wallAt) || 1;
    const behindReach = wallAt + sideOfWall * probe.width;
    let ax = probe.forward.x;
    let az = probe.forward.z;
    if (cut(edgeAt / 2 + wallAt / 2) === 'ground' && cut(behindReach) === 'wall') {
      const behind = this.boundary(edgeAt / 2 + wallAt / 2, behindReach, 'wall', cut, EDGE_STEPS + 1);
      const dx = this.first.x - (this.base.x + right.x * behind);
      const dz = this.first.z - (this.base.z + right.z * behind);
      const length = Math.hypot(dx, dz);
      if (length > 1e-6 && Math.abs(dx * probe.forward.x + dz * probe.forward.z) / length < ALONG_SLANT) {
        ax = dx / length;
        az = dz / length;
      }
    }
    this.base.copy(probe.point);
    // Perpendicular a la pared, hacia el lado del borde.
    this.out.set(-az, 0, ax);
    const toEdge = (edgeAt - wallAt) * (right.x * this.out.x + right.z * this.out.z);
    if (toEdge < 0) this.out.negate();
    this.wallPoint.copy(this.first);
    this.wallPoint.y = probe.ground;
    this.width = Math.abs(edgeAt - wallAt) * Math.abs(right.x * this.out.x + right.z * this.out.z);
    this.ledge = true;
    this.end.x = Number.NaN;
    return rays;
  }

  /**
   * Distance (m) from `point` (world) to the wall, looking along −`out` (horizontal, unit: from the wall towards the
   * body), with the wall between heights `bottom` and `top` (world): the most it sticks out between them (a vertical
   * ray from `top` finds something above `bottom`). `from`: about where it was (m; NaN = unknown): it looks round it
   * first. `reach`: how far it looks (m). Infinity if there is no wall within `reach`. `rays`: counter of the rays.
   */
  wallDistance(point: Vector3, out: Vector3, bottom: number, top: number, reach: number, from: number, rays: { count: number }): number {
    const has = (d: number): boolean => {
      rays.count++;
      const origin = this.origin.copy(point).addScaledVector(out, -d);
      origin.y = top;
      if (!this.detector.castDown(origin, top - bottom, this.hit)) return false;
      return this.hit.point.y >= bottom;
    };
    let lo = 0;
    let hi = reach;
    let steps = EDGE_STEPS + 2;
    // Cerca de donde estaba: dos rayos y unas pocas bisecciones.
    const window = reach / 16;
    if (Number.isFinite(from) && from - window > 0 && from + window < reach) {
      if (!has(from - window) && has(from + window)) {
        lo = from - window;
        hi = from + window;
        steps = 3;
      }
    }
    if (steps > 3) {
      if (has(0)) return 0;
      if (!has(reach)) return Number.POSITIVE_INFINITY;
    }
    for (let i = 0; i < steps; i++) {
      const mid = (lo + hi) / 2;
      if (has(mid)) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /** No ledge from `point` (where the probe looked). */
  private setNone(point: Vector3, rays: number): number {
    if (this.ledge) this.end.copy(point);
    this.ledge = false;
    this.width = Number.POSITIVE_INFINITY;
    return rays;
  }

  /** Where the ground (at `inside`) gives way to `kind` (at `outside`), lateral offsets (m), by bisection. */
  private boundary(inside: number, outside: number, kind: Cut, cut: (x: number) => Cut, steps = EDGE_STEPS): number {
    for (let i = 0; i < steps; i++) {
      const mid = (inside + outside) / 2;
      if (cut(mid) === kind) outside = mid;
      else inside = mid;
    }
    return (inside + outside) / 2;
  }

  /** What there is `x` m to the right of `base` (left if negative). */
  private cutAt(probe: LedgeProbe, right: Vector3, x: number): Cut {
    const origin = this.origin.copy(this.base).addScaledVector(right, x);
    origin.y = probe.ground + probe.rayHeight;
    if (!this.detector.castDown(origin, probe.rayHeight + probe.drop, this.hit)) return 'drop';
    const y = this.hit.point.y - probe.ground;
    // Empezando dentro de un bloque (más alto que rayHeight), su cara de arriba: una pared.
    if (this.hit.distance < 0 || y >= probe.wall) return 'wall';
    if (y < -probe.drop) return 'drop';
    // Un escalón que se puede subir o bajar no es ni suelo de la cornisa ni pared.
    return Math.abs(y) <= probe.drop / 4 ? 'ground' : 'other';
  }
}
