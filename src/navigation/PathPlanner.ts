import { Vector3 } from 'three';

import type { LocomotionConfig } from '../locomotion/LocomotionConfig.ts';
import { createGroundHit, type GroundDetector, type GroundHit } from '../terrain/GroundDetector.ts';

/** Side of the cells of the grid it searches on (× stepLength; 15 cm with the default one). */
const CELL = 0.19;
/**
 * It keeps this far from an edge it can't step when it can (× stepLength; ~50 cm): closer, each cell costs
 * more, up to `BERTH_COST` times more right at the edge. It looks like going round it rather than brushing it.
 */
const BERTH = 0.6;
const BERTH_COST = 4;
/** Most cells it looks at for a route (then it goes to the reachable one closest to the destination). */
const MAX_EXPANSIONS = 15000;
/** It searches as far as this from the straight line to the destination (m, × stepLength), besides 1.5 × its length. */
const SEARCH_MARGIN = 8;
/**
 * Weight of the estimate of what is left (A*). With 2 it finds a route much sooner (round a platform to its
 * stairs, without exploring the whole face that looks at the destination); a little longer than the
 * shortest, but it is pulled taut afterwards.
 */
const HEURISTIC_WEIGHT = 2;

/**
 * Rounding the corners of the route (Chaikin): passes, fraction of each side it cuts, and at most this much
 * (× cell). The cut passes at least the room the feet need, plus this (× stepLength), from the edges.
 */
const ROUND_PASSES = 3;
const ROUND_CUT = 0.25;
const ROUND_MAX_CUT = 6;
const ROUND_MARGIN = 0.2;

const NEIGHBORS:[number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

interface Cell {
  /** Height of the ground (m; −∞ if there is none). */
  height: number;
  /** Next to a change of level it can't step (or no ground): it isn't walked on. undefined: not known yet. */
  edge?: boolean;
  /** Distance to the nearest edge cell, up to `BERTH` (m; Infinity if none that close). NaN: not known yet. */
  clearance: number;
  /** Route cost from the start; parent cell (key) and whether it is closed (A*). */
  cost: number;
  parent: number;
  closed: boolean;
}

/**
 * Plans a route over the ground to a destination, going round what the character can't step: risers higher
 * than `maxStepUp`, drops deeper than `maxStepDown` and holes, with room for the feet (and a little more when
 * there is space). Stairs and ramps it can walk on are part of the route (it goes up a platform by its
 * stairs).
 *
 * It queries the ground with the same detector and rules as the steps, on a grid of `CELL` × stepLength
 * that it only samples where it searches (A*), and pulls the route taut so it has few points (the character
 * follows it with curves: see `MoveToController`). If the straight line is clear, it doesn't search. If the
 * destination can't be reached, the route ends at the reachable point closest to it.
 *
 * It doesn't see what isn't ground (walls, columns or furniture that aren't in the ground meshes).
 */
export class PathPlanner {
  /** Raycasts of the last plan (to measure its cost). */
  raycasts = 0;

  private readonly detector: GroundDetector;
  private readonly config: () => LocomotionConfig;
  /** Room it needs from an edge (m): the root, from the feet of the controller (`stairs.toeFront + heelBack`). */
  private readonly clearanceNeeded: () => number;
  private readonly hit: GroundHit = createGroundHit();
  private readonly origin = new Vector3();
  private readonly cells = new Map<number, Cell>();
  private x0 = 0;
  private z0 = 0;
  private size = 0.15;
  private berth = 0.5;

  constructor(detector: GroundDetector, config: () => LocomotionConfig, clearance: () => number) {
    this.detector = detector;
    this.config = config;
    this.clearanceNeeded = clearance;
  }

  /**
   * Route from `start` (world, on the ground at `start.y`) to `target`: puts its points in `out` (world, at
   * the height of the ground; the first one after `start`, the last one the destination or, if it can't be
   * reached, the reachable point closest to it). Returns false if it found no route out of where it is
   * (`out` empty).
   */
  plan(start: Vector3, target: Vector3, out: Vector3[]): boolean {
    out.length = 0;
    const config = this.config();
    this.size = CELL * config.stepLength;
    this.berth = BERTH * config.stepLength;
    this.x0 = start.x;
    this.z0 = start.z;
    this.cells.clear();
    this.raycasts = 0;
    const hard = this.clearanceNeeded();
    const s = this.size;
    const start0 = this.cell(0, 0, start.y);

    // En línea recta, si cabe.
    const ti = Math.round((target.x - this.x0) / s);
    const tj = Math.round((target.z - this.z0) / s);
    if (this.lineClear(start.x, start.z, start0.height, target.x, target.z, hard, true)) {
      const end = this.cellAt(ti, tj);
      out.push(new Vector3(target.x, end && Number.isFinite(end.height) ? end.height : target.y, target.z));
      return true;
    }

    // A*, con más coste cerca de los bordes.
    const limit = Math.ceil((1.5 * Math.hypot(ti, tj) * s + SEARCH_MARGIN * config.stepLength) / s);
    const startKey = key(0, 0);
    start0.cost = 0;
    const open = new MinHeap();
    open.push(startKey, HEURISTIC_WEIGHT * Math.hypot(ti, tj) * s);
    let best = startKey;
    let bestDistance = Math.hypot(ti, tj) * s;
    let goal = -1;
    let expansions = 0;
    while (open.size > 0 && expansions < MAX_EXPANSIONS) {
      const k = open.pop();
      const c = this.cells.get(k)!;
      if (c.closed) continue;
      c.closed = true;
      expansions++;
      const [i, j] = unkey(k);
      const distance = Math.hypot(ti - i, tj - j) * s;
      if (distance < bestDistance) {
        best = k;
        bestDistance = distance;
      }
      if (i === ti && j === tj) {
        goal = k;
        break;
      }
      for (const [di, dj, step] of NEIGHBORS) {
        const ni = i + di;
        const nj = j + dj;
        if (Math.abs(ni) > limit + Math.abs(ti) || Math.abs(nj) > limit + Math.abs(tj)) continue;
        const n = this.cell(ni, nj, c.height);
        if (n.closed || !this.canStep(c, n)) continue;
        // En diagonal, sin recortar una esquina: también por los dos de al lado.
        if (di !== 0 && dj !== 0 && (!this.canStep(c, this.cell(ni, j, c.height)) || !this.canStep(c, this.cell(i, nj, c.height)))) continue;
        const room = this.clearance(ni, nj);
        // Al borde no, salvo saliendo de donde está o llegando al destino (puede estar junto a un borde).
        const nearStart = Math.hypot(ni, nj) * s <= hard + s;
        const nearGoal = Math.hypot(ni - ti, nj - tj) * s <= hard + s;
        if ((room < hard && !nearGoal) || this.isEdge(ni, nj)) {
          if (!nearStart) continue;
        }
        const crowd = room >= this.berth ? 0 : BERTH_COST * (1 - Math.max(room - hard, 0) / (this.berth - hard));
        const cost = c.cost + step * s * (1 + crowd);
        if (cost < n.cost) {
          n.cost = cost;
          n.parent = k;
          open.push(key(ni, nj), cost + HEURISTIC_WEIGHT * Math.hypot(ti - ni, tj - nj) * s);
        }
      }
    }
    const end = goal >= 0 ? goal : best;
    if (end === startKey) return false;

    // Celdas del camino, del final al principio.
    const route: number[] = [];
    for (let k = end; k !== startKey; k = this.cells.get(k)!.parent) route.push(k);
    route.reverse();
    const points: { x: number; z: number; y: number; room: number }[] = route.map((k) => {
      const [i, j] = unkey(k);
      return { x: this.x0 + i * s, z: this.z0 + j * s, y: this.cells.get(k)!.height, room: this.clearance(i, j) };
    });
    const last = points[points.length - 1];
    if (goal >= 0) {
      last.x = target.x;
      last.z = target.z;
    }

    // Tensa el camino: de cada punto, al más lejano que se ve en línea recta sin pasar más cerca de un
    // borde que el propio camino.
    let from = { x: start.x, z: start.z, y: start0.height, room: this.clearance(0, 0) };
    let index = 0;
    while (index < points.length) {
      let far = index;
      let room = Math.min(from.room, points[index].room);
      for (let m = index + 1; m < points.length; m++) {
        room = Math.min(room, points[m].room);
        if (!this.lineClear(from.x, from.z, from.y, points[m].x, points[m].z, Math.min(room, this.berth), false)) break;
        far = m;
      }
      const p = points[far];
      out.push(new Vector3(p.x, p.y, p.z));
      from = p;
      index = far + 1;
    }
    this.round(start.x, start.z, start0.height, hard + ROUND_MARGIN * config.stepLength, out);
    return true;
  }

  /**
   * Rounds the corners of the route `points` (after the start, at `x0`, `z0`, on ground at `y0`), cutting
   * each one (Chaikin) while the cut passes at least `room` m from the edges: the corners of a taut route
   * wrap round what it avoids, so the cut gets closer to it.
   */
  private round(x0: number, z0: number, y0: number, room: number, points: Vector3[]): void {
    const s = this.size;
    const route = [new Vector3(x0, y0, z0), ...points];
    for (let pass = 0; pass < ROUND_PASSES; pass++) {
      const next = [route[0]];
      for (let k = 1; k < route.length - 1; k++) {
        const a = route[k - 1];
        const p = route[k];
        const b = route[k + 1];
        const cutA = p.clone().lerp(a, Math.min(ROUND_CUT, ROUND_MAX_CUT * s / Math.max(p.distanceTo(a), 1e-6)));
        const cutB = p.clone().lerp(b, Math.min(ROUND_CUT, ROUND_MAX_CUT * s / Math.max(p.distanceTo(b), 1e-6)));
        if (!this.lineClear(cutA.x, cutA.z, p.y, cutB.x, cutB.z, room, false)) {
          next.push(p);
          continue;
        }
        cutA.y = this.cell(Math.round((cutA.x - this.x0) / s), Math.round((cutA.z - this.z0) / s), p.y).height;
        cutB.y = this.cell(Math.round((cutB.x - this.x0) / s), Math.round((cutB.z - this.z0) / s), p.y).height;
        next.push(cutA, cutB);
      }
      next.push(route[route.length - 1]);
      route.length = 0;
      route.push(...next);
    }
    points.length = 0;
    for (let k = 1; k < route.length; k++) points.push(route[k]);
  }

  /** Cell (i, j), sampling its ground (from around `near`) the first time. */
  private cell(i: number, j: number, near: number): Cell {
    const k = key(i, j);
    let c = this.cells.get(k);
    if (c) return c;
    const config = this.config();
    const top = (Number.isFinite(near) ? near : 0) + config.groundProbeHeight;
    this.origin.set(this.x0 + i * this.size, top, this.z0 + j * this.size);
    this.raycasts++;
    const found = this.detector.castDown(this.origin, config.groundProbeHeight + config.groundProbeDepth, this.hit);
    c = { height: found ? this.hit.point.y : Number.NEGATIVE_INFINITY, clearance: Number.NaN, cost: Number.POSITIVE_INFINITY, parent: -1, closed: false };
    this.cells.set(k, c);
    return c;
  }

  private cellAt(i: number, j: number): Cell | undefined {
    return this.cells.get(key(i, j));
  }

  /** From `a` to the cell next to it `b`: a step it can take. */
  private canStep(a: Cell, b: Cell): boolean {
    if (!Number.isFinite(b.height)) return false;
    const rise = b.height - a.height;
    const c = this.config();
    return rise <= c.maxStepUp && rise >= -c.maxStepDown;
  }

  /** Cell (i, j) is next to a change of level it can't step (either way) or has no ground. */
  private isEdge(i: number, j: number): boolean {
    const c = this.cell(i, j, 0);
    if (c.edge !== undefined) return c.edge;
    let edge = !Number.isFinite(c.height);
    for (let n = 0; n < 4 && !edge; n++) {
      const [di, dj] = NEIGHBORS[n];
      const other = this.cell(i + di, j + dj, c.height);
      edge = !this.canStep(c, other) || !this.canStep(other, c);
    }
    c.edge = edge;
    return edge;
  }

  /** Distance from cell (i, j) to the nearest edge cell, up to `berth` (m; Infinity if none that close). */
  private clearance(i: number, j: number): number {
    const c = this.cell(i, j, 0);
    if (!Number.isNaN(c.clearance)) return c.clearance;
    const r = Math.ceil(this.berth / this.size);
    let nearest = Number.POSITIVE_INFINITY;
    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        const d = Math.hypot(di, dj) * this.size;
        if (d > this.berth || d >= nearest) continue;
        // Desde la altura de esta celda: las de alrededor, si no se conocían todavía.
        this.cell(i + di, j + dj, c.height);
        if (this.isEdge(i + di, j + dj)) nearest = d;
      }
    }
    c.clearance = nearest;
    return nearest;
  }

  /**
   * The straight line from (`ax`, `az`), on ground at `ay`, to (`bx`, `bz`) can be walked: each step of it can
   * be taken and it passes at least `room` m from the edges (`ignoreEnds`: except within `room` of each end,
   * where it can be closer: it starts or ends next to an edge).
   */
  private lineClear(ax: number, az: number, ay: number, bx: number, bz: number, room: number, ignoreEnds: boolean): boolean {
    const s = this.size;
    const length = Math.hypot(bx - ax, bz - az);
    const samples = Math.max(Math.ceil(length / (s / 2)), 1);
    let previous = this.cell(Math.round((ax - this.x0) / s), Math.round((az - this.z0) / s), ay);
    for (let n = 1; n <= samples; n++) {
      const t = n / samples;
      const i = Math.round((ax + (bx - ax) * t - this.x0) / s);
      const j = Math.round((az + (bz - az) * t - this.z0) / s);
      const c = this.cell(i, j, previous.height);
      if (c !== previous && !this.canStep(previous, c)) return false;
      const fromEnd = Math.min(t, 1 - t) * length;
      if (!(ignoreEnds && fromEnd <= room + s) && this.clearance(i, j) < room) return false;
      previous = c;
    }
    return true;
  }
}

/** Key of cell (i, j) (|i|, |j| < 32768). */
function key(i: number, j: number): number {
  return (i + 32768) * 65536 + (j + 32768);
}

function unkey(k: number): [number, number] {
  return [Math.floor(k / 65536) - 32768, (k % 65536) - 32768];
}

/** Binary min-heap of keys by priority. */
class MinHeap {
  private readonly keys: number[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(k: number, priority: number): void {
    const keys = this.keys;
    const p = this.priorities;
    let n = keys.length;
    keys.push(k);
    p.push(priority);
    while (n > 0) {
      const parent = (n - 1) >> 1;
      if (p[parent] <= p[n]) break;
      [keys[parent], keys[n]] = [keys[n], keys[parent]];
      [p[parent], p[n]] = [p[n], p[parent]];
      n = parent;
    }
  }

  pop(): number {
    const keys = this.keys;
    const p = this.priorities;
    const top = keys[0];
    const lastKey = keys.pop()!;
    const lastPriority = p.pop()!;
    if (keys.length > 0) {
      keys[0] = lastKey;
      p[0] = lastPriority;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1;
        const r = l + 1;
        let m = n;
        if (l < keys.length && p[l] < p[m]) m = l;
        if (r < keys.length && p[r] < p[m]) m = r;
        if (m === n) break;
        [keys[m], keys[n]] = [keys[n], keys[m]];
        [p[m], p[n]] = [p[n], p[m]];
        n = m;
      }
    }
    return top;
  }
}
