import { Vector3 } from 'three';

import { createGroundHit, type GroundDetector } from './GroundDetector.ts';

const UP = new Vector3(0, 1, 0);
/**
 * Ground lower than the path by this much (× stepLength; 10 cm with the default one) is a drop at its side: a
 * path between such drops, narrower than `narrowWidth`, is narrow.
 */
export const NARROW_DROP = 0.125;
/** Bisection steps to find each edge (with `narrowWidth` 0.3 m, to ≈ 0.5 cm). */
const EDGE_STEPS = 5;
/**
 * The direction of the path: it finds the same edge again this far behind the probe (m), towards the body (with one
 * more bisection step: it starts from the whole width), and the path runs along the line between both (to ≈ 1°). Less
 * than ALONG_SLANT (cosine) off the travel, it is the travel: walking straight along it, without the noise of the
 * measure. With more (it was 10°), turning on the path the error stayed: the next probes look along it.
 */
const ALONG_PROBE = 0.25;
const ALONG_SLANT = Math.cos((3 * Math.PI) / 180);

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
   * Direction across the path (horizontal, unit; to the right of the travel): from its edge, measured where it
   * crosses the probe and a little behind (ALONG_PROBE). The path runs perpendicular to it through `center`.
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
  /** Point the rays are cast across from (the probe's, or the one behind it). */
  private readonly base = new Vector3();
  /** Side the next probe looks at first (+1 right, −1 left). */
  private side = 1;
  /** `dropsAway` of each side (−1, +1 of `across`) since the path was last measured: 1 yes, 0 no, NaN not looked. */
  private readonly away = [Number.NaN, Number.NaN];

  constructor(detector: GroundDetector) {
    this.detector = detector;
  }

  /** Forgets the path (after a reset or a teleport). */
  reset(): void {
    this.narrow = false;
    this.width = Number.POSITIVE_INFINITY;
    this.end.x = Number.NaN;
    this.side = 1;
    this.away[0] = this.away[1] = Number.NaN;
  }

  /** Moves the stored world positions (see `LocomotionController.shift`). */
  shift(offset: Vector3): void {
    this.center.add(offset);
    this.end.add(offset);
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
    this.base.copy(probe.point);
    let s = this.side;
    this.side = -s;
    const half = probe.width / 2;
    this.level = probe.ground;
    if (probe.levelAhead) {
      rays++;
      const origin = this.origin.copy(probe.point);
      origin.y = probe.ground + probe.rayHeight;
      if (this.detector.castDown(origin, 2 * probe.rayHeight, this.hit)) this.level = this.hit.point.y;
    }
    // Around the line of travel or, on a narrow path, around its centre (the body may go off it a little). Looking
    // along it the other way (turning round on it), `right` is against `across`: the centre, on the other side.
    const d = right.dot(this.across);
    const c = this.narrow ? this.offset(probe.point) / (d < 0 ? Math.min(d, -0.5) : Math.max(d, 0.5)) : 0;
    if (!drops(c + s * half)) {
      // Ground at half the width on this side: if the path were narrow, the other side would drop before half
      // the width (the next probe looks there first). On a narrow path, unless the other side drops: its centre,
      // measured further back, may be a little off, and on a path almost as wide as `width` the ray fell on its edge.
      if (!this.narrow || !drops(c - s * half)) {
        if (this.narrow) this.setWide(probe.point);
        return rays;
      }
      s = -s;
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
    rays += this.direction(probe, right, s, edge, (edge + other) / 2);
    this.narrow = true;
    this.end.x = Number.NaN;
    // Medido en un corte oblicuo, el ancho de verdad es menor.
    this.width = Math.abs(edge - other) * Math.abs(right.dot(this.across));
    this.away[0] = this.away[1] = Number.NaN;
    return rays;
  }

  /**
   * On side `side` of the path (+1 towards `across`, −1 against it), `beyond` m past its edge, the ground is more
   * than `maxDown` below the path, or missing: it can't step down there. One raycast per side each time the path is
   * measured (`rayHeight`: from how high above the path).
   */
  dropsAway(side: number, maxDown: number, beyond: number, rayHeight: number): boolean {
    const k = side > 0 ? 1 : 0;
    if (Number.isNaN(this.away[k])) {
      const reach = (side > 0 ? 1 : -1) * (this.width / 2 + beyond);
      const origin = this.origin.copy(this.center).addScaledVector(this.across, reach);
      origin.y = this.center.y + rayHeight;
      const hit = this.detector.castDown(origin, rayHeight + maxDown, this.hit);
      this.away[k] = !hit || this.hit.point.y < this.center.y - maxDown ? 1 : 0;
    }
    return this.away[k] === 1;
  }

  /**
   * `across`: the edge on side `s` (at `edge`, lateral offset from the probe) found again ALONG_PROBE behind, and the
   * path along the line between both; `right` if it can't find it there or the path goes almost along the travel.
   * Returns the rays it cast.
   */
  private direction(probe: NarrowProbe, right: Vector3, s: number, edge: number, middle: number): number {
    let rays = 0;
    this.across.copy(right);
    const forward = probe.forward;
    this.base.copy(probe.point).addScaledVector(forward, -ALONG_PROBE);
    const drops = (x: number): boolean => {
      rays++;
      return this.dropAt(probe, right, x);
    };
    // Del medio (aún en el camino) a todo el ancho de ese lado (ya fuera).
    const outside = middle + s * probe.width;
    if (drops(middle) || !drops(outside)) {
      this.base.copy(probe.point);
      return rays;
    }
    const behind = this.edge(middle, outside, drops, EDGE_STEPS + 1);
    this.base.copy(probe.point);
    // El borde va de (−ALONG_PROBE, behind) a (0, edge) en (adelante, derecha).
    const ahead = ALONG_PROBE;
    const sideways = edge - behind;
    const length = Math.hypot(ahead, sideways);
    // A lo largo: adelante·ahead + derecha·sideways; a lo ancho, a su derecha.
    const ax = (forward.x * ahead + right.x * sideways) / length;
    const az = (forward.z * ahead + right.z * sideways) / length;
    this.across.set(-az, 0, ax);
    if (this.across.dot(right) < 0) this.across.negate();
    if (this.across.dot(right) > ALONG_SLANT) this.across.copy(right);
    return rays;
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
  }

  /** Edge between `inside` (ground) and `outside` (drop), lateral offsets (m), by bisection. */
  private edge(inside: number, outside: number, drops: (x: number) => boolean, steps = EDGE_STEPS): number {
    for (let i = 0; i < steps; i++) {
      const mid = (inside + outside) / 2;
      if (drops(mid)) outside = mid;
      else inside = mid;
    }
    return (inside + outside) / 2;
  }

  /** The ground `x` m to the right of `base` (left if negative) is lower than `level` by `drop`, or missing. */
  private dropAt(probe: NarrowProbe, right: Vector3, x: number): boolean {
    const origin = this.origin.copy(this.base).addScaledVector(right, x);
    origin.y = this.level + probe.rayHeight;
    if (!this.detector.castDown(origin, probe.rayHeight + probe.drop, this.hit)) return true;
    return this.hit.point.y < this.level - probe.drop;
  }
}
