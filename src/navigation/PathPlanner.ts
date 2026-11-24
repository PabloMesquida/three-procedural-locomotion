import { Vector3 } from 'three';

import type { LocomotionConfig } from '../locomotion/LocomotionConfig.ts';
import type { Colliders } from '../terrain/Colliders.ts';
import { createGroundHit, type GroundDetector, type GroundHit } from '../terrain/GroundDetector.ts';
import { NARROW_DROP } from '../terrain/NarrowPath.ts';
import { LEDGE_WALL } from '../terrain/Ledge.ts';

/** Side of the cells of the grid it searches on (× stepLength; 15 cm with the default one). */
const CELL = 0.19;
/**
 * It keeps this far from an edge it can't step when it can (× stepLength; ~50 cm): closer, each cell costs
 * more, up to `BERTH_COST` times more right at the edge. It looks like going round it rather than brushing it.
 */
const BERTH = 0.6;
const BERTH_COST = 4;
/**
 * On a narrow path (or getting on or off it) each cell costs this much more than on open ground, besides the
 * cost of the edge: it goes along it only if going round is much longer.
 */
const NARROW_COST = 6;
/**
 * Along a ledge (or getting on or off it) each cell costs this much more than on open ground, instead of the cost of
 * the edge and NARROW_COST: with its back to the wall it is safe, only slower. It goes round it only if that is less
 * than about twice as long as going along it.
 */
const LEDGE_COST = 1;
/**
 * If the destination can't be reached, it goes to the reachable point closest to it, counting as this much more
 * (per metre) what that point is below it: a click on the side of a step or a platform (a point halfway up a
 * vertical face) means going up there, not to the floor beside it, which is closer seen from above.
 */
const BELOW_TARGET = 2;
/**
 * Searching also from the destination: if the character can't stand right on it (next to a railing), from the
 * nearest cell at its level where it can, at most this far (m).
 */
const GOAL_SEARCH = 0.6;
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

/** Directions across which it measures the width of a narrow path: along X, along Z and the two diagonals. */
const ACROSS: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];
/**
 * A narrow path is got on and off only at its ends: a step that changes level by NARROW_DROP or more onto it or
 * off it can't go across it (closer than this to its direction across, cosine).
 */
const NARROW_SIDE_COS = 0.5;
/**
 * Getting on a narrow path at an angle, the route first goes to a point this far before its end, in line with
 * it (× stepLength): the character gets on straight. Less if there isn't room.
 */
const NARROW_APPROACH = 1;
/** A route already in line with the narrow path (closer than this to its line, × stepLength) needs no approach. */
const NARROW_IN_LINE = 0.15;
/** A stretch of the route within this angle of a narrow path (cosine; 30°) comes in line with it. */
const NARROW_ALIGNED_COS = Math.cos(Math.PI / 6);
/**
 * To a destination on a low narrow path (one it can step onto from the ground beside it), it can also get on it
 * from its side, right there: the route goes first to the ground this far from its middle (× stepLength), across
 * it, and from there straight onto it; there it turns to stand along it (`arrival`). It does this when that route
 * is shorter than getting on it at an end.
 */
const SIDE_APPROACH = 0.6;
/**
 * Along a ledge, the route goes this far from its wall (× stepLength; 16 cm with the default one): about where the
 * root goes with the back against it.
 */
const LEDGE_LINE = 0.2;
/**
 * Getting on a ledge from open ground, the route first goes to a point this far before it, on its line (LEDGE_LINE
 * from the wall; × stepLength): the character gets there going along the wall, close to it. Less if it is already
 * nearly there.
 */
const LEDGE_APPROACH = 1;
/**
 * The approach point of a ledge, this far from its wall (× stepLength): walking forward, not yet with the back to the
 * wall, at LEDGE_LINE the shoulder touched it and the guard against walls stopped the body dead.
 */
const LEDGE_APPROACH_LINE = 0.3;
/** A route already on the line of the ledge (closer than this to it, × stepLength) needs no approach. */
const LEDGE_IN_LINE = 0.1;
/** Bisection steps to find each edge of a narrow path (to ≈ 1 cm with cells of 15 cm). */
const NARROW_EDGE_STEPS = 4;

const NEIGHBORS:[number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

interface Cell {
  /** Height of the ground (m; −∞ if there is none). */
  height: number;
  /** Next to a change of level it can't step (or no ground): it isn't walked on. undefined: not known yet. */
  edge?: boolean;
  /**
   * On a narrow path (see `narrowWidth`): an edge, but with drops on both sides close enough; it is walked on,
   * balancing. undefined: not known yet.
   */
  narrow?: boolean;
  /** On a narrow path: the direction across it (index in ACROSS). */
  across?: number;
  /**
   * On a ledge (see `ledgeWidth`): an edge, but with a wall on one side and a drop on the other close enough; it is
   * walked on, sideways with the back to the wall. undefined: not known yet.
   */
  ledge?: boolean;
  /** On a ledge: the direction across it (index in ACROSS) and which way along it the wall is (±1). */
  ledgeAcross?: number;
  ledgeWall?: number;
  /** Within reach of a narrow path (to get on and off it), though close to an edge. undefined: not known yet. */
  nearNarrow?: boolean;
  /** What `nearNarrow` found within reach is a ledge (not a narrow path). */
  nearLedge?: boolean;
  /** Room: distance to the nearest edge cell, up to `BERTH`, or to a collider (m). NaN: not known yet. */
  clearance: number;
  /** Distance to the nearest collider (m; negative inside). NaN: not known yet. */
  apart: number;
  /** Route cost from the start; parent cell (key) and whether it is closed (A*). */
  cost: number;
  parent: number;
  closed: boolean;
  /** The same searching from the destination (cost to it, next cell towards it). */
  back: number;
  parentBack: number;
  closedBack: boolean;
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
 * Besides, it goes round the colliders (see Colliders): what isn't ground and is between the step it can
 * take and its height.
 *
 * Narrow paths (a beam or the top of a wall between drops, narrower than `narrowWidth`) are walked on, though
 * all of them may be next to an edge: the character crosses them balancing. They cost much more than open
 * ground (it goes along them only if it can't go round them). A low one (a beam it can step onto) it crosses over
 * if it is in the way; but if the destination is on one, it gets on it only at its end, in line with it.
 */
export class PathPlanner {
  /** Raycasts of the last plan (to measure its cost). */
  raycasts = 0;
  /**
   * The last route ends on a narrow path got on from its side (see SIDE_APPROACH): the direction (world,
   * horizontal, unit) to turn to there, along the path. NaN (x) otherwise.
   */
  readonly arrival = new Vector3(Number.NaN, 0, 0);

  private readonly detector: GroundDetector;
  private readonly config: () => LocomotionConfig;
  /** Room it needs from an edge (m): the root, from the feet of the controller (`stairs.toeFront + heelBack`). */
  private readonly clearanceNeeded: () => number;
  /** Colliders (or null) and the height of the character for them (m; see LocomotionController.bodyHeight). */
  private readonly colliders: () => Colliders | null;
  private readonly height: () => number;
  private blockers: Colliders | null = null;
  private readonly hit: GroundHit = createGroundHit();
  private readonly origin = new Vector3();
  private readonly cells = new Map<number, Cell>();
  private x0 = 0;
  private z0 = 0;
  private size = 0.15;
  private berth = 0.5;
  /** The destination is on a narrow path: it gets on narrow paths only at their ends (see alongNarrow). */
  private narrowEnds = false;

  constructor(
    detector: GroundDetector,
    config: () => LocomotionConfig,
    clearance: () => number,
    colliders: () => Colliders | null = () => null,
    height: () => number = () => 0,
  ) {
    this.detector = detector;
    this.config = config;
    this.clearanceNeeded = clearance;
    this.colliders = colliders;
    this.height = height;
  }

  /**
   * Route from `start` (world, on the ground at `start.y`) to `target`: puts its points in `out` (world, at
   * the height of the ground; the first one after `start`, the last one the destination or, if it can't be
   * reached, the reachable point closest to it). Returns false if it found no route out of where it is
   * (`out` empty). In `narrow`, for each point, whether the stretch that ends at it goes along a narrow path.
   */
  plan(start: Vector3, target: Vector3, out: Vector3[], narrow: boolean[] = []): boolean {
    this.arrival.x = Number.NaN;
    this.raycasts = 0;
    const found = this.route(start, target, out, narrow);
    // Si llega al destino (si no, la ruta acaba en el punto alcanzable más cercano a él).
    const last = out[out.length - 1];
    const reached = found && last !== undefined && Math.hypot(last.x - target.x, last.z - target.z) < this.size && Math.abs(last.y - target.y) < this.narrowDrop();
    // A un camino angosto bajo, también por su costado: la más corta de las dos, o esta si la otra no llega.
    const side = this.sideRoute(start, target, out);
    if (side && (!reached || length(start, side.points) < length(start, out))) {
      out.length = 0;
      narrow.length = 0;
      out.push(...side.points);
      narrow.push(...side.points.map(() => false));
      this.arrival.copy(side.arrival);
      return true;
    }
    return found;
  }

  /**
   * Route to a destination on a low narrow path getting on it from its side (see SIDE_APPROACH), or null if the
   * destination isn't on one, it is on it already, or it can't get there. `end` is the route to it at an end.
   */
  private sideRoute(start: Vector3, target: Vector3, end: readonly Vector3[]): { points: Vector3[]; arrival: Vector3 } | null {
    const config = this.config();
    if (!(config.narrowWidth > 0)) return null;
    this.reset(start);
    const s = this.size;
    const ti = Math.round((target.x - this.x0) / s);
    const tj = Math.round((target.z - this.z0) / s);
    const c = this.cell(ti, tj, target.y);
    if (!this.isNarrow(ti, tj)) return null;
    // Ya en él (o en otro a su altura): va por él.
    const here = this.cell(0, 0, start.y);
    if (this.isNarrow(0, 0) && Math.abs(here.height - c.height) < this.narrowDrop()) return null;
    const middle = this.narrowMiddle(target.x, target.z, ti, tj, new Vector3(target.x, c.height, target.z));
    const [di, dj] = ACROSS[c.across!];
    const across = Math.hypot(di, dj);
    const ax = di / across;
    const az = dj / across;
    // Por cada lado, desde el suelo de al lado (si se sube de un paso desde él): el lado por el que llega primero y
    // el otro (pegado a una tarima, solo se sube desde ella); la ruta más corta de las que llegan.
    const near = Math.sign((start.x - middle.x) * ax + (start.z - middle.z) * az) || 1;
    const d = SIDE_APPROACH * config.stepLength;
    let points: Vector3[] | null = null;
    for (const side of [near, -near]) {
      const px = middle.x + ax * side * d;
      const pz = middle.z + az * side * d;
      // Los rayos, desde la altura del camino (route() vacía la rejilla: cada lado, de nuevo).
      this.reset(start);
      const ground = this.cell(Math.round((px - this.x0) / s), Math.round((pz - this.z0) / s), c.height);
      const rise = c.height - ground.height;
      if (!(rise >= this.narrowDrop() && rise <= config.maxStepUp)) continue;
      const approach = new Vector3(px, ground.height, pz);
      const candidate: Vector3[] = [];
      if (!this.route(start, approach, candidate, [])) continue;
      const end = candidate[candidate.length - 1];
      if (Math.hypot(end.x - approach.x, end.z - approach.z) > s || Math.abs(end.y - approach.y) > this.narrowDrop()) continue;
      candidate.push(middle.clone());
      if (!points || length(start, candidate) < length(start, points)) points = candidate;
    }
    if (!points) return null;
    // Allí se pone a lo largo del camino, hacia donde estaba yendo (o, si llega de frente, hacia el lado del final
    // de la otra ruta).
    let ux = -az;
    let uz = ax;
    const towards = end.length > 0 ? end[0] : start;
    if ((middle.x - towards.x) * ux + (middle.z - towards.z) * uz < 0) {
      ux = -ux;
      uz = -uz;
    }
    return { points, arrival: new Vector3(ux, 0, uz) };
  }

  /** Starts a new search from `start`: the grid around it, empty. */
  private reset(start: Vector3): void {
    const config = this.config();
    this.size = CELL * config.stepLength;
    this.berth = BERTH * config.stepLength;
    this.x0 = start.x;
    this.z0 = start.z;
    this.cells.clear();
    this.blockers = this.colliders();
    this.blockers?.update();
  }

  /** `plan` without getting on narrow paths from their side. */
  private route(start: Vector3, target: Vector3, out: Vector3[], narrow: boolean[]): boolean {
    out.length = 0;
    narrow.length = 0;
    const config = this.config();
    this.size = CELL * config.stepLength;
    this.berth = BERTH * config.stepLength;
    this.x0 = start.x;
    this.z0 = start.z;
    this.cells.clear();
    this.blockers = this.colliders();
    this.blockers?.update();
    const hard = this.clearanceNeeded();
    const s = this.size;
    const start0 = this.cell(0, 0, start.y);

    // En línea recta, si cabe.
    const ti = Math.round((target.x - this.x0) / s);
    const tj = Math.round((target.z - this.z0) / s);
    this.narrowEnds = false;
    this.cell(ti, tj, target.y);
    this.narrowEnds = this.isNarrow(ti, tj);
    if (this.lineClear(start.x, start.z, start0.height, target.x, target.z, hard, true)) {
      const end = this.cellAt(ti, tj);
      out.push(new Vector3(target.x, end && Number.isFinite(end.height) ? end.height : target.y, target.z));
      this.markNarrow(start, out, narrow);
      return true;
    }

    // A*, con más coste cerca de los bordes, desde los dos lados a la vez: desde donde está y, si el destino se
    // puede pisar, desde él, hasta que se encuentran. Un destino al fondo de un embudo (un pasillo entre barandas
    // al que se llega por una escalera) se encuentra antes desde dentro: desde fuera, la búsqueda llenaba todo el
    // suelo de alrededor antes de dar con la entrada.
    const limit = Math.ceil((1.5 * Math.hypot(ti, tj) * s + SEARCH_MARGIN * config.stepLength) / s);
    const startKey = key(0, 0);
    start0.cost = 0;
    // Lo que le falta a una celda para el destino: en planta y, si queda por debajo de él, más (ver BELOW_TARGET).
    const away = (i: number, j: number, height: number): number => Math.hypot(ti - i, tj - j) * s + BELOW_TARGET * Math.max(target.y - height, 0);
    /**
     * Coste de entrar en la celda (ni, nj) desde (i, j), la celda `c` (por `step` celdas), o NaN si no se
     * puede. `backward`: buscando desde el destino, el paso se da al revés (de (ni, nj) a (i, j)).
     */
    const enter = (c: Cell, i: number, j: number, ni: number, nj: number, step: number, backward: boolean): number => {
      if (Math.abs(ni) > limit + Math.abs(ti) || Math.abs(nj) > limit + Math.abs(tj)) return Number.NaN;
      const n = this.cell(ni, nj, c.height);
      const steps = (a: Cell, b: Cell): boolean => (backward ? this.canStep(b, a) : this.canStep(a, b));
      if (!steps(c, n) || !this.alongNarrow(i, j, ni, nj)) return Number.NaN;
      // En diagonal, sin recortar una esquina: también por los dos de al lado.
      if (ni !== i && nj !== j && (!steps(c, this.cell(ni, j, c.height)) || !steps(c, this.cell(i, nj, c.height)))) return Number.NaN;
      const room = this.clearance(ni, nj);
      // Al borde no, salvo saliendo de donde está o llegando al destino (puede estar junto a un borde).
      const nearStart = Math.hypot(ni, nj) * s <= hard + s;
      // Dentro de un collider o rozándolo, nunca (ni junto al destino: se queda a su borde).
      if (this.apart(ni, nj) < hard && !nearStart) return Number.NaN;
      const nearGoal = Math.hypot(ni - ti, nj - tj) * s <= hard + s;
      // Al borde no, salvo por un camino angosto (o para subir a él o bajar), y entonces cuesta más.
      const tight = ((room < hard && !nearGoal) || this.isEdge(ni, nj)) && !nearStart;
      if (tight && !this.onNarrow(ni, nj, hard)) return Number.NaN;
      // Por una cornisa (o subiendo y bajando de ella), de espaldas a la pared: más despacio, pero sin riesgo.
      if (this.isLedge(ni, nj) || (tight && !this.isNarrow(ni, nj) && this.cell(ni, nj, 0).nearLedge)) return step * s * (1 + LEDGE_COST);
      const crowd = room >= this.berth ? 0 : BERTH_COST * (1 - Math.max(room - hard, 0) / (this.berth - hard));
      // Ir a lo largo de un camino angosto cuesta más; cruzarlo por encima (uno bajo), no.
      const along = (tight || this.isNarrow(ni, nj)) && !(this.isNarrow(ni, nj) && this.acrossNarrow(ni, nj, ni - i, nj - j));
      return step * s * (1 + crowd + (along ? NARROW_COST : 0));
    };
    const forward = new MinHeap();
    forward.push(startKey, HEURISTIC_WEIGHT * Math.hypot(ti, tj) * s);
    // Desde el destino, si se puede estar en él o, si no (pegado a una baranda, en el costado de un escalón), desde
    // la celda a poco de él a la que menos le falta (como el punto más cercano que alcanza: ver BELOW_TARGET). Allí
    // acabará la ruta.
    let goalKey = -1;
    let goalAway = Number.POSITIVE_INFINITY;
    const reach = Math.ceil(GOAL_SEARCH / s);
    for (let di = -reach; di <= reach; di++) {
      for (let dj = -reach; dj <= reach; dj++) {
        if (Math.hypot(di, dj) * s > GOAL_SEARCH) continue;
        const i = ti + di;
        const j = tj + dj;
        const c = this.cell(i, j, target.y);
        if (!Number.isFinite(c.height) || (this.isEdge(i, j) && !this.isNarrow(i, j) && !this.isLedge(i, j)) || this.apart(i, j) < hard) continue;
        const d = away(i, j, c.height);
        if (d < goalAway) {
          goalAway = d;
          goalKey = key(i, j);
        }
      }
    }
    const backward = new MinHeap();
    if (goalKey >= 0) {
      const [gi, gj] = unkey(goalKey);
      this.cells.get(goalKey)!.back = 0;
      backward.push(goalKey, HEURISTIC_WEIGHT * Math.hypot(gi, gj) * s);
    }
    let best = startKey;
    let bestDistance = away(0, 0, start0.height);
    // Celda en que se encuentran las dos búsquedas (o la del destino, si llega a ella desde donde está).
    let meet = -1;
    let expansions = 0;
    let turn = 0;
    while (expansions < MAX_EXPANSIONS && meet < 0 && (forward.size > 0 || backward.size > 0)) {
      const fromGoal = backward.size > 0 && (forward.size === 0 || (turn++ & 1) === 1);
      const k = (fromGoal ? backward : forward).pop();
      const c = this.cells.get(k)!;
      if (fromGoal ? c.closedBack : c.closed) continue;
      if (fromGoal) c.closedBack = true;
      else c.closed = true;
      expansions++;
      const [i, j] = unkey(k);
      if (!fromGoal) {
        const distance = away(i, j, c.height);
        if (distance < bestDistance) {
          best = k;
          bestDistance = distance;
        }
      }
      if (fromGoal ? c.closed || k === startKey : c.closedBack || k === goalKey) {
        meet = k;
        break;
      }
      for (const [di, dj, step] of NEIGHBORS) {
        const ni = i + di;
        const nj = j + dj;
        const cost = enter(c, i, j, ni, nj, step, fromGoal);
        if (Number.isNaN(cost)) continue;
        const n = this.cells.get(key(ni, nj))!;
        if (fromGoal) {
          if (n.closedBack || c.back + cost >= n.back) continue;
          n.back = c.back + cost;
          n.parentBack = k;
          backward.push(key(ni, nj), n.back + HEURISTIC_WEIGHT * Math.hypot(ni, nj) * s);
        } else {
          if (n.closed || c.cost + cost >= n.cost) continue;
          n.cost = c.cost + cost;
          n.parent = k;
          forward.push(key(ni, nj), n.cost + HEURISTIC_WEIGHT * Math.hypot(ti - ni, tj - nj) * s);
        }
      }
    }
    const reached = meet >= 0;
    const end = reached ? meet : best;
    if (!reached && end === startKey) return false;

    // Celdas del camino: desde donde está hasta `end` y, si se encontraron, de ahí al destino.
    const route: number[] = [];
    for (let k = end; k !== startKey && k >= 0; k = this.cells.get(k)!.parent) route.push(k);
    route.reverse();
    if (reached) for (let k = this.cells.get(meet)!.parentBack; k >= 0; k = this.cells.get(k)!.parentBack) route.push(k);
    if (route.length === 0) return false;
    const points: { x: number; z: number; y: number; room: number }[] = route.map((k) => {
      const [i, j] = unkey(k);
      return { x: this.x0 + i * s, z: this.z0 + j * s, y: this.cells.get(k)!.height, room: this.clearance(i, j) };
    });
    const last = points[points.length - 1];
    if (reached && goalKey === key(ti, tj)) {
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
    this.markNarrow(start, out, narrow);
    this.approachNarrow(start, out, narrow);
    this.centerNarrow(out, narrow);
    this.alongWall(out);
    this.approachLedge(start, out);
    return true;
  }

  /**
   * Where the route gets on a ledge from open ground, it first goes to a point before it on its line (LEDGE_APPROACH,
   * at LEDGE_LINE from the wall), if it can walk there and from there on. Getting there at an angle, or far from the
   * wall, the foot ahead would land beyond the edge of the ledge and, moved back onto it, crossed the other one; and the
   * body turned its back to the wall while still coming at it.
   */
  private approachLedge(start: Vector3, points: Vector3[]): void {
    const config = this.config();
    if (!(config.ledgeWidth > 0)) return;
    const s = this.size;
    const step = config.stepLength;
    const at = (x: number, z: number, y: number): [number, number] => {
      const i = Math.round((x - this.x0) / s);
      const j = Math.round((z - this.z0) / s);
      this.cell(i, j, y);
      return [i, j];
    };
    for (let k = 0; k < points.length; k++) {
      const a = k === 0 ? start : points[k - 1];
      const b = points[k];
      // Un tramo que llega a la cornisa: `b` en ella (ya en su línea, ver alongWall) y `a` fuera.
      if (!this.isLedge(...at(b.x, b.z, b.y)) || this.isLedge(...at(a.x, a.z, a.y))) continue;
      // La cornisa en `b`: a lo largo, hacia donde viene la ruta (hacia `a`).
      const c = this.cell(...at(b.x, b.z, b.y), b.y);
      const [di, dj] = ACROSS[c.ledgeAcross!];
      const across = Math.hypot(di, dj);
      let ux = -dj / across;
      let uz = di / across;
      if ((a.x - b.x) * ux + (a.z - b.z) * uz < 0) {
        ux = -ux;
        uz = -uz;
      }
      // Por su línea, desde `b` hacia atrás (no más allá de `a`) hasta donde, un ancho de cornisa más hacia fuera, ya hay
      // suelo a su altura: ahí termina (la entrada). Las celdas no lo dicen: junto a la esquina de la plataforma, con la
      // caída en diagonal, también son de cornisa.
      const ox = (-di / across) * c.ledgeWall!;
      const oz = (-dj / across) * c.ledgeWall!;
      const limit = (a.x - b.x) * ux + (a.z - b.z) * uz;
      let back = -1;
      for (let t = 0; t <= limit; t += s / 2) {
        this.origin.set(b.x + ux * t + ox * config.ledgeWidth, b.y + config.groundProbeHeight, b.z + uz * t + oz * config.ledgeWidth);
        this.raycasts++;
        if (this.detector.castDown(this.origin, config.groundProbeHeight + config.maxStepDown, this.hit) && Math.abs(this.hit.point.y - b.y) <= config.maxStepDown) {
          back = t;
          break;
        }
      }
      // Todo el tramo es cornisa: ya llega por ella.
      if (back < 0) continue;
      const ex = b.x + ux * back;
      const ez = b.z + uz * back;
      const approach = LEDGE_APPROACH * step;
      // Lo que `a` queda antes de la entrada (a lo largo, hacia fuera de la cornisa) y de lado.
      const before = (a.x - ex) * ux + (a.z - ez) * uz;
      const side = Math.abs((a.x - ex) * uz - (a.z - ez) * ux);
      if (side < LEDGE_IN_LINE * step && before >= 0.5 * approach) continue;
      // Si ya está cerca de la entrada, el punto no más allá de donde está (volver atrás para girar daba vueltas); y en
      // vez del punto de antes, si este (de la ruta, no la salida) queda a menos de una aproximación de la entrada: si no,
      // la ruta iba a él, después al de aproximación y después a la cornisa, en zigzag.
      const d0 = before <= 0 ? approach : Math.min(approach, Math.max(before, approach / 2));
      const replace = k > 0 && before > 0 && before < approach * 1.5;
      const from = replace ? (k > 1 ? points[k - 2] : start) : a;
      const off = (LEDGE_APPROACH_LINE - LEDGE_LINE) * step;
      for (const d of [d0, d0 / 2]) {
        const px = ex + ux * d + ox * off;
        const pz = ez + uz * d + oz * off;
        const [pi, pj] = at(px, pz, a.y);
        const pc = this.cell(pi, pj, a.y);
        if (!Number.isFinite(pc.height)) continue;
        if (!this.lineClear(from.x, from.z, from.y, px, pz, 0, false) || !this.lineClear(px, pz, pc.height, b.x, b.z, 0, false)) continue;
        if (replace) points[k - 1] = new Vector3(px, pc.height, pz);
        else {
          points.splice(k, 0, new Vector3(px, pc.height, pz));
          k++;
        }
        break;
      }
    }
  }


  /**
   * The points of the route on a ledge, to LEDGE_LINE from its wall: the body goes along it with its back to the
   * wall, and the cells can be right at the edge of the drop (getting on it there, the body would be over the drop).
   */
  private alongWall(points: Vector3[]): void {
    const config = this.config();
    if (!(config.ledgeWidth > 0)) return;
    const s = this.size;
    const wallHeight = Math.min(LEDGE_WALL * config.stepLength, config.groundProbeHeight);
    for (const p of points) {
      const i = Math.round((p.x - this.x0) / s);
      const j = Math.round((p.z - this.z0) / s);
      this.cell(i, j, p.y);
      if (!this.isLedge(i, j)) continue;
      const c = this.cell(i, j, 0);
      const [di, dj] = ACROSS[c.ledgeAcross!];
      const length = Math.hypot(di, dj) * c.ledgeWall!;
      const ax = di / length;
      const az = dj / length;
      // Desde p, a `t` m hacia la pared: ya es la pared (o se empieza dentro de ella).
      const wallAt = (t: number): boolean => {
        this.origin.set(p.x + ax * t, c.height + config.groundProbeHeight, p.z + az * t);
        this.raycasts++;
        if (!this.detector.castDown(this.origin, config.groundProbeHeight, this.hit)) return false;
        return this.hit.distance < 0 || this.hit.point.y >= c.height + wallHeight;
      };
      let inside = 0;
      let outside = config.ledgeWidth + s;
      if (!wallAt(outside)) continue;
      for (let k = 0; k < NARROW_EDGE_STEPS + 1; k++) {
        const mid = (inside + outside) / 2;
        if (wallAt(mid)) outside = mid;
        else inside = mid;
      }
      const move = (inside + outside) / 2 - LEDGE_LINE * config.stepLength;
      p.x += ax * move;
      p.z += az * move;
    }
  }

  /**
   * The points of the route on a narrow path, to its middle: the cells are as wide as half a path, and their centre
   * can be right at its edge.
   */
  private centerNarrow(points: Vector3[], narrow: readonly boolean[]): void {
    const s = this.size;
    for (let k = 0; k < points.length; k++) {
      // Solo los de un tramo a lo largo de él (cruzándolo, el medio está en su línea).
      if (!narrow[k] && !narrow[k + 1]) continue;
      const p = points[k];
      const i = Math.round((p.x - this.x0) / s);
      const j = Math.round((p.z - this.z0) / s);
      this.cell(i, j, p.y);
      if (this.isNarrow(i, j)) this.narrowMiddle(p.x, p.z, i, j, p);
    }
  }

  /**
   * Middle of the narrow path at cell (i, j), across it from (`x`, `z`): finds both edges by bisection
   * (NARROW_EDGE_STEPS raycasts each). Puts it in `out` (x, z).
   */
  private narrowMiddle(x: number, z: number, i: number, j: number, out: Vector3): Vector3 {
    const c = this.cell(i, j, 0);
    const [di, dj] = ACROSS[c.across!];
    const length = Math.hypot(di, dj);
    const ax = di / length;
    const az = dj / length;
    const drop = this.narrowDrop();
    const config = this.config();
    // Desde (x, z), a `t` m a lo ancho: el suelo cae (o no hay).
    const drops = (t: number): boolean => {
      this.origin.set(x + ax * t, c.height + config.groundProbeHeight, z + az * t);
      this.raycasts++;
      if (!this.detector.castDown(this.origin, config.groundProbeHeight + drop, this.hit)) return true;
      return this.hit.point.y < c.height - drop;
    };
    const most = config.narrowWidth + this.size;
    const edge = (sign: number): number => {
      let inside = 0;
      let outside = sign * most;
      if (!drops(outside)) return Number.NaN;
      for (let k = 0; k < NARROW_EDGE_STEPS; k++) {
        const mid = (inside + outside) / 2;
        if (drops(mid)) outside = mid;
        else inside = mid;
      }
      return (inside + outside) / 2;
    };
    const plus = edge(1);
    const minus = edge(-1);
    if (Number.isNaN(plus) || Number.isNaN(minus)) return out;
    const middle = (plus + minus) / 2;
    out.x = x + ax * middle;
    out.z = z + az * middle;
    return out;
  }

  /**
   * Where the route gets on a narrow path at an angle (a stretch marked in `narrow` after one that isn't), it
   * adds a point before it in line with the path (NARROW_APPROACH), if it can walk there and from there on.
   */
  private approachNarrow(start: Vector3, points: Vector3[], narrow: boolean[]): void {
    const s = this.size;
    const step = this.config().stepLength;
    for (let k = 0; k < points.length; k++) {
      if (!narrow[k] || (k > 0 && narrow[k - 1])) continue;
      const a = k === 0 ? start : points[k - 1];
      const b = points[k];
      // Donde empieza el camino angosto en este tramo, y su dirección a lo largo (hacia `b`).
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const samples = Math.max(Math.ceil(length / (s / 2)), 1);
      let entry = -1;
      let ei = 0;
      let ej = 0;
      for (let n = 0; n <= samples && entry < 0; n++) {
        ei = Math.round((a.x + ((b.x - a.x) * n) / samples - this.x0) / s);
        ej = Math.round((a.z + ((b.z - a.z) * n) / samples - this.z0) / s);
        this.cell(ei, ej, b.y);
        if (this.isNarrow(ei, ej)) entry = n / samples;
      }
      // Ya en él (la ruta sale de una celda del camino): nada. El punto de antes quedaba detrás, y desde el medio de
      // una viga, con el destino delante, se giraba, volvía unos pasos y se giraba otra vez.
      if (entry < 0 || (k === 0 && entry === 0)) continue;
      const [di, dj] = ACROSS[this.cell(ei, ej, b.y).across!];
      // La entrada, en el medio del camino (no en el centro de su celda, que puede estar en su borde).
      const middle = this.narrowMiddle(this.x0 + ei * s, this.z0 + ej * s, ei, ej, new Vector3());
      const ex = middle.x;
      const ez = middle.z;
      let ux = -dj;
      let uz = di;
      const u = Math.hypot(ux, uz);
      ux /= u;
      uz /= u;
      // Hacia donde va por el camino: el último punto seguido sobre él (el primero puede estar justo en la entrada).
      let last = k;
      while (last + 1 < points.length && narrow[last + 1]) last++;
      const far = points[last];
      if ((far.x - ex) * ux + (far.z - ez) * uz < 0) {
        ux = -ux;
        uz = -uz;
      }
      const approach = NARROW_APPROACH * step;
      // Lo que llega antes de la entrada, a lo largo del camino, y lo que va de lado.
      const before = (ex - a.x) * ux + (ez - a.z) * uz;
      const side = Math.abs((a.x - ex) * uz - (a.z - ez) * ux);
      const inLine = side < NARROW_IN_LINE * step;
      // Ya llega en línea con él y desde bastante antes (desde media aproximación si también llega a ese punto en
      // línea; si gira en él, desde toda): nada.
      const prev = k > 1 ? points[k - 2] : start;
      const incoming = Math.hypot(a.x - prev.x, a.z - prev.z);
      const aligned = incoming > 1e-6 && ((a.x - prev.x) * ux + (a.z - prev.z) * uz) / incoming > NARROW_ALIGNED_COS;
      if (inLine && before >= (aligned ? 0.5 : 0.8) * approach) continue;
      // En línea pero justo al lado del extremo (llega a ese punto en diagonal): el punto de antes, más atrás.
      const replace = inLine && k > 0;
      const from = replace ? (k > 1 ? points[k - 2] : start) : a;
      // Todo el tramo de aproximación, salvo que ese punto quede muy cerca de donde ya está (volver atrás un poco para
      // girar enseguida, daba vueltas alrededor del punto): entonces no más atrás de donde está. Si no cabe, a la mitad.
      const close = Math.hypot(a.x - (ex - ux * approach), a.z - (ez - uz * approach)) < approach / 2;
      const back = replace || before <= 0 || !close ? approach : Math.min(approach, Math.max(before, approach / 2));
      const backs = [back, back / 2];
      for (const back of backs) {
        const px = ex - ux * back;
        const pz = ez - uz * back;
        const pc = this.cell(Math.round((px - this.x0) / s), Math.round((pz - this.z0) / s), a.y);
        if (!Number.isFinite(pc.height)) continue;
        if (!this.lineClear(from.x, from.z, from.y, px, pz, 0, false) || !this.lineClear(px, pz, pc.height, b.x, b.z, 0, false)) continue;
        if (replace) {
          points[k - 1] = new Vector3(px, pc.height, pz);
        } else {
          points.splice(k, 0, new Vector3(px, pc.height, pz));
          narrow.splice(k, 0, false);
          k++;
        }
        break;
      }
    }
  }

  /**
   * For each point of the route (after `start`), whether the stretch that ends at it goes along a narrow path (on
   * its cells and not across it: crossing a low beam over is not walking along it).
   */
  private markNarrow(start: Vector3, points: readonly Vector3[], narrow: boolean[]): void {
    narrow.length = 0;
    const s = this.size;
    const on = this.config().narrowWidth > 0;
    let ax = start.x;
    let az = start.z;
    for (const p of points) {
      let found = false;
      const samples = Math.max(Math.ceil(Math.hypot(p.x - ax, p.z - az) / (s / 2)), 1);
      for (let n = 0; n <= samples && on && !found; n++) {
        const t = n / samples;
        const i = Math.round((ax + (p.x - ax) * t - this.x0) / s);
        const j = Math.round((az + (p.z - az) * t - this.z0) / s);
        this.cell(i, j, p.y);
        found = this.isNarrow(i, j) && !this.acrossNarrow(i, j, p.x - ax, p.z - az);
      }
      narrow.push(found);
      ax = p.x;
      az = p.z;
    }
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
    c = { height: found ? this.hit.point.y : Number.NEGATIVE_INFINITY, clearance: Number.NaN, apart: Number.NaN, cost: Number.POSITIVE_INFINITY, parent: -1, closed: false, back: Number.POSITIVE_INFINITY, parentBack: -1, closedBack: false };
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

  /**
   * Cell (i, j) is on a narrow path or a ledge, or close enough to one (`hard` m and a cell) to get on or off it,
   * without being an edge itself.
   */
  private onNarrow(i: number, j: number, hard: number): boolean {
    if (!(this.config().narrowWidth > 0) && !(this.config().ledgeWidth > 0)) return false;
    if (this.isEdge(i, j)) return this.isNarrow(i, j) || this.isLedge(i, j);
    const c = this.cell(i, j, 0);
    if (c.nearNarrow !== undefined) return c.nearNarrow;
    const reach = hard + this.size;
    const r = Math.ceil(reach / this.size);
    let near = false;
    for (let di = -r; di <= r && !near; di++) {
      for (let dj = -r; dj <= r && !near; dj++) {
        if (Math.hypot(di, dj) * this.size > reach) continue;
        // A la misma altura: el camino, no el suelo de abajo junto a él.
        const n = this.cell(i + di, j + dj, c.height);
        if (!this.canStep(c, n) || !this.canStep(n, c) || !(Math.abs(n.height - c.height) < this.narrowDrop())) continue;
        if (this.isNarrow(i + di, j + dj)) near = true;
        else if (this.isLedge(i + di, j + dj)) near = c.nearLedge = true;
      }
    }
    c.nearNarrow = near;
    return near;
  }

  /** Going in the direction (`dx`, `dz`) over the narrow cell (i, j) crosses its path (see NARROW_SIDE_COS). */
  private acrossNarrow(i: number, j: number, dx: number, dz: number): boolean {
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return false;
    const [di, dj] = ACROSS[this.cell(i, j, 0).across!];
    return Math.abs(dx * di + dz * dj) / (length * Math.hypot(di, dj)) > NARROW_SIDE_COS;
  }

  /** Change of level at the sides of a narrow path (m; see NARROW_DROP). */
  private narrowDrop(): number {
    return NARROW_DROP * this.config().stepLength;
  }

  /**
   * The step from cell (ai, aj) to the next one (bi, bj) doesn't get on or off a narrow path across it (see
   * NARROW_SIDE_COS): up or down onto a beam from its side.
   */
  private alongNarrow(ai: number, aj: number, bi: number, bj: number): boolean {
    // Solo yendo a un destino sobre un camino angosto: cruzar uno bajo por encima (pasar al otro lado), sí.
    if (!this.narrowEnds || !(this.config().narrowWidth > 0)) return true;
    const a = this.cell(ai, aj, 0);
    const b = this.cell(bi, bj, a.height);
    if (!(Math.abs(b.height - a.height) >= this.narrowDrop())) return true;
    const si = bi - ai;
    const sj = bj - aj;
    const length = Math.hypot(si, sj);
    for (const [i, j, c] of [[ai, aj, a], [bi, bj, b]] as const) {
      if (!this.isNarrow(i, j)) continue;
      const [di, dj] = ACROSS[c.across!];
      if (Math.abs(si * di + sj * dj) / (length * Math.hypot(di, dj)) > NARROW_SIDE_COS) return false;
    }
    return true;
  }

  /**
   * Cell (i, j) is on a narrow path: across it (along X, Z or a diagonal), the ground drops (NARROW_DROP or more)
   * on both sides within `narrowWidth`: with n cells between both drops, the path is at least n − 1 cells wide (it
   * may be up to n + 1).
   */
  private isNarrow(i: number, j: number): boolean {
    const width = this.config().narrowWidth;
    if (!(width > 0)) return false;
    const c = this.cell(i, j, 0);
    if (c.narrow !== undefined) return c.narrow;
    let narrow = false;
    if (Number.isFinite(c.height)) {
      for (const [di, dj] of ACROSS) {
        const length = Math.hypot(di, dj) * this.size;
        const most = Math.floor(width / length) + 2;
        const a = this.dropAt(i, j, c, di, dj, most);
        const b = a > 0 ? this.dropAt(i, j, c, -di, -dj, most) : 0;
        if (b > 0 && (a + b - 2) * length < width) {
          narrow = true;
          c.across = ACROSS.findIndex(([x, z]) => x === di && z === dj);
          break;
        }
      }
    }
    c.narrow = narrow;
    return narrow;
  }

  /**
   * Cell (i, j) is on a ledge: across it (along X, Z or a diagonal), a drop it can't step down (or no ground) on one
   * side and a wall (ground at least `wallHeight` higher) on the other, within `ledgeWidth`.
   */
  private isLedge(i: number, j: number): boolean {
    const config = this.config();
    const width = config.ledgeWidth;
    if (!(width > 0)) return false;
    const c = this.cell(i, j, 0);
    if (c.ledge !== undefined) return c.ledge;
    let ledge = false;
    if (Number.isFinite(c.height)) {
      for (const [di, dj] of ACROSS) {
        const length = Math.hypot(di, dj) * this.size;
        const most = Math.floor(width / length) + 2;
        for (const sign of [1, -1]) {
          const drop = this.boundAt(i, j, c, sign * di, sign * dj, most);
          if (drop.kind !== 'drop') continue;
          const wall = this.boundAt(i, j, c, -sign * di, -sign * dj, most);
          if (wall.kind === 'wall' && (drop.k + wall.k - 2) * length < width) {
            ledge = true;
            c.ledgeAcross = ACROSS.findIndex(([x, z]) => x === di && z === dj);
            c.ledgeWall = -sign;
            break;
          }
        }
        if (ledge) break;
      }
    }
    c.ledge = ledge;
    return ledge;
  }

  /**
   * Going from cell `c` (i, j) in steps of (di, dj): after how many it finds a drop it can't step down (or no
   * ground) or a wall (ground LEDGE_WALL × stepLength higher, as LocomotionController sees it), within `most`; 'none'
   * if neither (or a step it can climb first).
   */
  private boundAt(i: number, j: number, c: Cell, di: number, dj: number, most: number): { k: number; kind: 'drop' | 'wall' | 'none' } {
    const config = this.config();
    const wall = Math.min(LEDGE_WALL * config.stepLength, config.groundProbeHeight);
    for (let k = 1; k <= most; k++) {
      const n = this.cell(i + k * di, j + k * dj, c.height);
      if (!(n.height >= c.height - config.maxStepDown)) return { k, kind: 'drop' };
      if (n.height >= c.height + wall) return { k, kind: 'wall' };
      if (Math.abs(n.height - c.height) >= this.narrowDrop()) return { k, kind: 'none' };
    }
    return { k: 0, kind: 'none' };
  }

  /**
   * Going from cell `c` (i, j) in steps of (di, dj): after how many it finds a drop (NARROW_DROP or more, or no
   * ground), within `most`; 0 if none (or it finds a rise as high first: a wall, not the side of a path).
   */
  private dropAt(i: number, j: number, c: Cell, di: number, dj: number, most: number): number {
    const drop = this.narrowDrop();
    let previous = c;
    for (let k = 1; k <= most; k++) {
      const n = this.cell(i + k * di, j + k * dj, previous.height);
      if (!(n.height > previous.height - drop)) return k;
      if (n.height >= previous.height + drop) return 0;
      previous = n;
    }
    return 0;
  }

  /**
   * Room at cell (i, j) (m): distance to the nearest edge cell, up to `berth` (Infinity if none that close),
   * or to a collider, if it is closer (measured exactly: negative inside it).
   */
  private clearance(i: number, j: number): number {
    const c = this.cell(i, j, 0);
    if (!Number.isNaN(c.clearance)) return c.clearance;
    const apart = this.apart(i, j);
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
    c.clearance = Math.min(nearest, apart);
    return c.clearance;
  }

  /** Distance (m, horizontal, exact) from the center of cell (i, j) to the nearest collider at its height; Infinity without them. */
  private apart(i: number, j: number): number {
    const c = this.cell(i, j, 0);
    if (!Number.isNaN(c.apart)) return c.apart;
    c.apart = this.blockers && Number.isFinite(c.height)
      ? this.blockers.distance(this.x0 + i * this.size, this.z0 + j * this.size, c.height + this.config().maxStepUp, c.height + this.height())
      : Number.POSITIVE_INFINITY;
    return c.apart;
  }

  /**
   * The straight line from (`ax`, `az`), on ground at `ay`, to (`bx`, `bz`) can be walked: each step of it can
   * be taken and it passes at least `room` m from the edges (`ignoreEnds`: except within `room` of each end,
   * where it can be closer: it starts or ends next to an edge; from colliders, only at the start).
   */
  private lineClear(ax: number, az: number, ay: number, bx: number, bz: number, room: number, ignoreEnds: boolean): boolean {
    const s = this.size;
    const length = Math.hypot(bx - ax, bz - az);
    const samples = Math.max(Math.ceil(length / (s / 2)), 1);
    let pi = Math.round((ax - this.x0) / s);
    let pj = Math.round((az - this.z0) / s);
    let previous = this.cell(pi, pj, ay);
    for (let n = 1; n <= samples; n++) {
      const t = n / samples;
      const i = Math.round((ax + (bx - ax) * t - this.x0) / s);
      const j = Math.round((az + (bz - az) * t - this.z0) / s);
      const c = this.cell(i, j, previous.height);
      if (c !== previous && (!this.canStep(previous, c) || !this.alongNarrow(pi, pj, i, j))) return false;
      pi = i;
      pj = j;
      const fromEnd = Math.min(t, 1 - t) * length;
      if (!(ignoreEnds && fromEnd <= room + s) && this.clearance(i, j) < room) return false;
      // Un collider, tampoco junto al destino (si está dentro de uno, la ruta acaba a su borde); junto a la
      // salida sí (puede estar arrimado a él).
      if (!(ignoreEnds && t * length <= room + s) && this.apart(i, j) < room) return false;
      previous = c;
    }
    return true;
  }
}

/** Length (m, horizontal) of the route `points` from `start`. */
function length(start: Vector3, points: readonly Vector3[]): number {
  let total = 0;
  let from = start;
  for (const p of points) {
    total += Math.hypot(p.x - from.x, p.z - from.z);
    from = p;
  }
  return total;
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
