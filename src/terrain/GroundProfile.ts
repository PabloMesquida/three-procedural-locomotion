import { Vector3 } from 'three';

import { createGroundHit, type GroundDetector } from './GroundDetector.ts';

/** Bisection steps to locate an edge between two samples (the error halves each time). */
const EDGE_REFINE_STEPS = 5;
/** How many times a jump can be split in two when the bisection finds a third level in it. */
const MAX_SPLITS = 3;
/** Where there is no ground, the profile takes it this far below where it starts (m): lower than anything. */
const HOLE_DEPTH = 1000;
/** Most samples of a profile. */
const MAX_SAMPLES = 96;
/** Most a profile along an arc turns, each way from its origin (rad): beyond, the angles would wrap around. */
const MAX_ARC_ANGLE = 0.8 * Math.PI;

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
  /** A gap between two higher treads, too short to step on (see `markGaps`): it is stepped over. */
  gap: boolean;
  /**
   * The gap is a drop it can't step down, between two treads it can step from one to the other, no wider than
   * `maxGapStep` (see `markGaps`): it crosses it with a long step.
   */
  cross: boolean;
}

/** A stretch of the profile while `firmTreads` rebuilds it. */
interface Piece {
  start: number;
  end: number;
  startHeight: number;
  endHeight: number;
  startEdge: boolean;
  endEdge: boolean;
  /** Its lowest point (m). */
  low: number;
  /** 0: firm ground; 1: steeper than the slope it walks; 2: no ground. */
  kind: 0 | 1 | 2;
  /** Not stood on: steep, without ground, or a firm stretch too short for a foot between two such. */
  unstandable: boolean;
}

/**
 * Height profile of the ground along a horizontal path, a straight line or an arc (curved and spiral stairs):
 * the treads it is made of, separated by edges (a jump in height of at least `edgeHeight` between two
 * neighboring samples). Each edge is located by bisection, so the samples can be spaced well apart.
 *
 * Positions along the path (`u`) are meters on the path through `origin`. On an arc, a point off that path
 * gets the position of its angle about the center: the edges of curved stairs point to the center, so the
 * treads are the same whatever the radius (only narrower inside; see `pathScale`).
 */
export class GroundProfile {
  /** Point of the path at position 0 (world; its height is not used). */
  readonly origin = new Vector3();
  /** Horizontal unit direction of the path at `origin` (world). */
  readonly direction = new Vector3(0, 0, 1);
  /** Center of the arc (world; only with `turn` ≠ 0). */
  readonly center = new Vector3();
  /** 0: straight line; +1: arc turning left (counterclockwise seen from above); −1: turning right. */
  turn = 0;
  /** Radius of the arc through `origin` (m). */
  radius = 0;
  readonly treads: Tread[] = [];
  /** Treads in use (`treads` keeps the rest allocated). */
  count = 0;

  private readonly hit = createGroundHit();
  private readonly probe = new Vector3();
  private readonly offset = new Vector3();
  private castHeight = 0;
  private castDepth = 0;
  private edgeHeight = 0;
  private holeHeight = 0;
  /** The samples of the last `sample` (position, height, on firm ground) and the stretches `firmTreads` makes. */
  private readonly sampleU: number[] = [];
  private readonly sampleHeight: number[] = [];
  private readonly sampleFirm: boolean[] = [];
  private readonly pieces: Piece[] = [];
  /** Tread being built while sampling. */
  private tread!: Tread;

  /**
   * The path of the next `sample`: through `origin`, heading `direction` (horizontal), straight or, with a
   * `center` (world), an arc about it.
   */
  setPath(origin: Vector3, direction: Vector3, center: Vector3 | null = null): void {
    this.origin.set(origin.x, 0, origin.z);
    this.direction.set(direction.x, 0, direction.z).normalize();
    this.turn = 0;
    if (!center) return;
    this.center.set(center.x, 0, center.z);
    const v = this.offset.subVectors(this.origin, this.center);
    this.radius = v.length();
    if (this.radius < 1e-6) return;
    // Hacia qué lado gira: el centro, a la izquierda (+1) o a la derecha (−1) de la dirección.
    this.turn = this.direction.z * -v.x - this.direction.x * -v.z >= 0 ? 1 : -1;
    this.tangent(0, this.direction);
  }

  /**
   * Samples the ground on the path (see `setPath`) from `from` to `to` (m) every `spacing` m. On an arc, at
   * most MAX_ARC_ANGLE each way from the origin. Each sample looks for the ground from `castHeight` above
   * the previous one (the first, above `startHeight`; never from lower than that) down to `castDepth` below
   * it: it follows the ground however much it rises, without starting inside a high step, above a ceiling
   * or under a higher floor behind which it started. Where there is no ground (a gap over the void, a
   * cliff) it is taken as a hole lower than anything, and it goes on looking for the ground beyond. With `steepCos`
   * (the cosine of the steepest slope it walks on), ground steeper than that is not part of a tread (see `firmTreads`).
   */
  sample(
    detector: GroundDetector,
    from: number,
    to: number,
    spacing: number,
    edgeHeight: number,
    startHeight: number,
    castHeight: number,
    castDepth: number,
    steepCos = Number.NEGATIVE_INFINITY,
    minTread = 0,
  ): void {
    if (this.turn !== 0) {
      const limit = MAX_ARC_ANGLE * this.radius;
      from = Math.max(from, -limit);
      to = Math.min(to, limit);
    }
    this.castHeight = castHeight;
    this.castDepth = castDepth;
    this.count = 0;
    this.edgeHeight = edgeHeight;
    const n = Math.min(Math.max(Math.ceil((to - from) / spacing), 1), MAX_SAMPLES - 1);
    const step = (to - from) / n;
    // Altura con la que se apunta un hueco sin suelo: la misma en todo el perfil, por debajo de todo.
    this.holeHeight = startHeight - HOLE_DEPTH;
    let previous = this.heightAt(detector, from, startHeight);
    // Última altura con suelo: desde ella se busca el siguiente (sobre un hueco no hay a qué seguir).
    let solid = Number.isFinite(previous) ? previous : startHeight;
    const su = this.sampleU;
    const sh = this.sampleHeight;
    const sf = this.sampleFirm;
    su.length = sh.length = sf.length = 0;
    su.push(from);
    sf.push(Number.isFinite(previous) && this.hit.normal.y >= steepCos);
    if (!Number.isFinite(previous)) previous = this.holeHeight;
    sh.push(previous);
    this.tread = this.addTread(from, previous, false);
    for (let i = 1; i <= n; i++) {
      const u = from + i * step;
      // Nunca desde más abajo que donde empieza: si detrás hay un desnivel, desde abajo no se vería lo de arriba.
      const near = Math.max(solid, startHeight);
      let h = this.heightAt(detector, u, near);
      const noGround = !Number.isFinite(h);
      su.push(u);
      sf.push(!noGround && this.hit.normal.y >= steepCos);
      if (noGround) h = this.holeHeight;
      sh.push(h);
      this.span(detector, u - step, previous, u, h, Math.max(near, h), 0);
      previous = h;
      if (!noGround) solid = h;
    }
    if (steepCos > -1) this.firmTreads(minTread);
  }

  /**
   * Ground steeper than the slope it walks on (the samples of the last `sample` that are not firm) is not stood on.
   * The lip of a crevice between two rounded rocks steepens gradually down to its bottom: it is no edge, and the tread
   * went on over the crevice as if it were flat. Here a dip (a stretch of steep samples, with the stretches without
   * ground and those shorter than `minTread` between them, lower than the firm ground on both sides by an edge or
   * more) becomes one tread at the height of its lowest sample, between edges at the last firm sample before it and
   * the first after it: a gap from firm ground to firm ground, crossed (or jumped, or a drop) like the one between two
   * platforms. A steep face between two levels (the side of a rock, a ramp) stays as it was: a step, or a slope (see
   * lookFarAhead). The first and the last sample of the profile stay as they were too (the steep ground may go on).
   */
  private firmTreads(minTread: number): void {
    const su = this.sampleU;
    const sh = this.sampleHeight;
    const sf = this.sampleFirm;
    const count = su.length;
    // Empinada: con suelo (sin él ya es un hueco), ni la primera ni la última.
    const steep = (k: number): boolean => k > 0 && k < count - 1 && !sf[k] && sh[k] > this.holeHeight;
    let any = false;
    for (let k = 1; k < count - 1 && !any; k++) any = steep(k);
    if (!any) return;
    const pieces = this.pieces;
    let n = 0;
    const add = (start: number, end: number, startHeight: number, endHeight: number, low: number, startEdge: boolean, endEdge: boolean, kind: 0 | 1 | 2): void => {
      if (pieces.length <= n) pieces.push({ start: 0, end: 0, startHeight: 0, endHeight: 0, low: 0, startEdge: false, endEdge: false, kind: 0, unstandable: false });
      const p = pieces[n++];
      p.start = start;
      p.end = end;
      p.startHeight = startHeight;
      p.endHeight = endHeight;
      p.low = low;
      p.startEdge = startEdge;
      p.endEdge = endEdge;
      p.kind = kind;
      p.unstandable = kind !== 0;
    };
    // Cada huella, en tramos firmes y empinados (cada tramo empinado, de la última muestra firme antes de él, o el
    // principio de la huella, a la primera después, o su final). Los bordes, solo los de verdad (los de la huella).
    let k = 0;
    for (let i = 0; i < this.count; i++) {
      const t = this.treads[i];
      if (this.hole(t)) {
        add(t.start, t.end, t.startHeight, t.endHeight, this.holeHeight, t.startEdge, t.endEdge, 2);
        continue;
      }
      let from = t.start;
      let fromHeight = t.startHeight;
      while (k < count && su[k] < t.start) k++;
      while (k < count && su[k] <= t.end) {
        if (!steep(k)) {
          k++;
          continue;
        }
        let low = sh[k];
        let e = k;
        while (e + 1 < count && su[e + 1] <= t.end && steep(e + 1)) low = Math.min(low, sh[++e]);
        const before = su[k - 1] >= t.start;
        const after = e + 1 < count && su[e + 1] <= t.end;
        const startU = before ? su[k - 1] : t.start;
        const startH = before ? sh[k - 1] : t.startHeight;
        const endU = after ? su[e + 1] : t.end;
        const endH = after ? sh[e + 1] : t.endHeight;
        if (startU > from) add(from, startU, fromHeight, startH, Math.min(fromHeight, startH), from === t.start && t.startEdge, false, 0);
        add(startU, endU, startH, endH, Math.min(low, startH, endH), startU === t.start && t.startEdge, endU === t.end && t.endEdge, 1);
        from = endU;
        fromHeight = endH;
        k = e + 1;
      }
      if (t.end > from) add(from, t.end, fromHeight, t.endHeight, Math.min(fromHeight, t.endHeight), from === t.start && t.startEdge, t.endEdge, 0);
    }
    // Un tramo firme más corto que un pie entre dos que no se pisan, tampoco (el fondo llano de la grieta).
    for (let p = 1; p < n - 1; p++) {
      const piece = pieces[p];
      if (!piece.unstandable && piece.end - piece.start < minTread && pieces[p - 1].unstandable && pieces[p + 1].unstandable) piece.unstandable = true;
    }
    // De nuevo las huellas.
    this.count = 0;
    let previous: Tread | null = null;
    const emit = (piece: Piece): void => {
      // Sin un borde de verdad entre las dos, la misma huella (como estaba).
      if (previous && piece.kind !== 2 && !this.hole(previous) && !piece.startEdge && !previous.endEdge && previous.end === piece.start) {
        previous.end = piece.end;
        previous.endHeight = piece.endHeight;
        previous.endEdge = piece.endEdge;
        return;
      }
      const t = this.addTread(piece.start, piece.startHeight, piece.startEdge);
      t.end = piece.end;
      t.endHeight = piece.endHeight;
      t.endEdge = piece.endEdge;
      previous = t;
    };
    for (let p = 0; p < n; p++) {
      if (!pieces[p].unstandable) {
        emit(pieces[p]);
        continue;
      }
      // Lo que no se pisa, seguido: una hondonada si tiene algo empinado y queda más honda que el suelo firme de los dos
      // lados (y hay suelo a los dos lados).
      let last = p;
      let low = pieces[p].low;
      let hasSteep = pieces[p].kind === 1;
      while (last + 1 < n && pieces[last + 1].unstandable) {
        last++;
        low = Math.min(low, pieces[last].low);
        if (pieces[last].kind === 1) hasSteep = true;
      }
      const sides = p > 0 && last < n - 1 ? Math.min(pieces[p - 1].endHeight, pieces[last + 1].startHeight) : Number.NEGATIVE_INFINITY;
      if (hasSteep && low < sides - this.edgeHeight) {
        if (previous) previous.endEdge = true;
        const t = this.addTread(pieces[p].start, low, true);
        t.end = pieces[last].end;
        t.endEdge = true;
        pieces[last + 1].startEdge = true;
        previous = t;
      } else {
        for (let q = p; q <= last; q++) emit(pieces[q]);
      }
      p = last;
    }
  }

  /**
   * The ground from `a` (height `ha`) to `b` (height `hb`), the end of the current tread. If they differ by an
   * edge or more, it locates the jump by bisection (each point goes to the side whose height it matches) and,
   * if it is a step (still a jump between two very close points, not a steep slope), ends the current tread
   * there and starts another one. If a point is below both sides or above both, there is another level in between (the gap
   * between two treads without risers, or a narrow tread): the jump is split there, and each half is solved the
   * same way. The bisection always closes in on that level, so it doesn't escape between two samples.
   */
  private span(detector: GroundDetector, a: number, ha: number, b: number, hb: number, near: number, splits: number): void {
    if (Math.abs(hb - ha) < this.edgeHeight) {
      this.tread.end = b;
      this.tread.endHeight = hb;
      return;
    }
    let lo = a;
    let hi = b;
    let loHeight = ha;
    let hiHeight = hb;
    for (let k = 0; k < EDGE_REFINE_STEPS; k++) {
      const mid = (lo + hi) / 2;
      let hm = this.heightAt(detector, mid, near);
      if (!Number.isFinite(hm)) hm = this.holeHeight;
      // Otro nivel: por debajo de los dos lados (un hueco) o por encima. Entre medias es una pendiente.
      const outside = hm < Math.min(ha, hb) - this.edgeHeight || hm > Math.max(ha, hb) + this.edgeHeight;
      if (outside && splits < MAX_SPLITS) {
        this.span(detector, lo, loHeight, mid, hm, near, splits + 1);
        this.span(detector, mid, hm, hi, hb, near, splits + 1);
        return;
      }
      if (Math.abs(hm - ha) < Math.abs(hm - hb)) {
        lo = mid;
        loHeight = hm;
      } else {
        hi = mid;
        hiHeight = hm;
      }
    }
    const t = this.tread;
    if (Math.abs(hiHeight - loHeight) < this.edgeHeight / 2) {
      t.end = b;
      t.endHeight = hb;
      return;
    }
    const edge = (lo + hi) / 2;
    t.end = edge;
    t.endHeight = loHeight;
    t.endEdge = true;
    this.tread = this.addTread(edge, hb, true);
  }

  /**
   * Marks as gaps the treads lower than both neighbors (by an edge or more) and shorter than `maxLength`:
   * the gaps between the treads of stairs without risers, which are stepped over. Also, as gaps it crosses
   * (`cross`), those up to `crossLength` long more than `stepDown` below the tread before them, when it can step
   * from that tread to the next one (up to `stepUp` up and `stepDown` down): a gap in the ground with ground on
   * the other side. And those up to `crossLength` long more than `dipDepth` below the treads on both sides (a crevice
   * between two rocks, a trench), also if it could step down into them.
   */
  markGaps(maxLength: number, crossLength = 0, stepUp = 0, stepDown = 0, dipDepth = Number.POSITIVE_INFINITY): void {
    for (let i = 1; i < this.count - 1; i++) {
      const t = this.treads[i];
      const before = this.treads[i - 1].endHeight;
      const after = this.treads[i + 1].startHeight;
      const bottom = Math.max(t.startHeight, t.endHeight);
      const low = bottom + this.edgeHeight;
      t.gap = t.end - t.start < maxLength && before >= low && after >= low;
      const deep = before - bottom > stepDown || (before - bottom > dipDepth && after - bottom > dipDepth);
      t.cross = !t.gap && t.end - t.start <= crossLength && deep && after - before <= stepUp && before - after <= stepDown;
      if (t.cross) t.gap = true;
    }
  }

  /** Number of edges in the profile. */
  get edges(): number {
    return Math.max(this.count - 1, 0);
  }

  /** Position along the path (m) of a world point (on an arc, of its angle about the center). */
  along(point: Vector3): number {
    if (this.turn === 0) return (point.x - this.origin.x) * this.direction.x + (point.z - this.origin.z) * this.direction.z;
    const ax = this.origin.x - this.center.x;
    const az = this.origin.z - this.center.z;
    const bx = point.x - this.center.x;
    const bz = point.z - this.center.z;
    // Ángulo con signo de a a b alrededor de +Y (positivo = hacia la izquierda).
    return this.turn * Math.atan2(az * bx - ax * bz, ax * bx + az * bz) * this.radius;
  }

  /** World point of the path at `u` (height 0). */
  point(u: number, out: Vector3): Vector3 {
    return this.moveAlong(this.origin, u, out);
  }

  /**
   * Moves `point` (world) along the path to position `u`, keeping its distance to it: on a straight line,
   * parallel to it; on an arc, at the same radius. Height 0.
   */
  moveAlong(point: Vector3, u: number, out: Vector3): Vector3 {
    const du = u - this.along(point);
    if (this.turn === 0) return out.set(point.x, 0, point.z).addScaledVector(this.direction, du);
    const v = rotateY(this.offset.set(point.x - this.center.x, 0, point.z - this.center.z), (this.turn * du) / this.radius);
    return out.copy(this.center).add(v);
  }

  /** Horizontal unit direction of the path at `u` (world). */
  tangent(u: number, out: Vector3): Vector3 {
    if (this.turn === 0) return out.copy(this.direction);
    const v = rotateY(this.offset.subVectors(this.origin, this.center), (this.turn * u) / this.radius);
    // Derivada de la rotación alrededor de +Y: (z, −x), hacia donde avanza el ángulo.
    return out.set(this.turn * v.z, 0, -this.turn * v.x).normalize();
  }

  /**
   * Meters at `point` (world) per meter along the path: on an arc, its radius over the path's (inside, the
   * treads are narrower); 1 on a straight line.
   */
  pathScale(point: Vector3): number {
    if (this.turn === 0) return 1;
    return Math.hypot(point.x - this.center.x, point.z - this.center.z) / this.radius;
  }

  /** Moves the path and the heights by `offset` (see `LocomotionController.shift`). */
  shift(offset: Vector3): void {
    this.origin.x += offset.x;
    this.origin.z += offset.z;
    this.center.x += offset.x;
    this.center.z += offset.z;
    this.shiftHeights(offset.y);
  }

  /** Keeps only the first `count` treads: the profile ends at the end of the last one. */
  truncate(count: number): void {
    this.count = Math.min(this.count, count);
    if (this.count > 0) this.treads[this.count - 1].endEdge = false;
  }

  /** Drops the first `count` treads: the profile starts at the start of the next one. */
  dropFirst(count: number): void {
    if (count <= 0) return;
    count = Math.min(count, this.count);
    for (let i = 0; i < this.count - count; i++) {
      const kept = this.treads[i + count];
      this.treads[i + count] = this.treads[i];
      this.treads[i] = kept;
    }
    this.count -= count;
    if (this.count > 0) this.treads[0].startEdge = false;
  }

  /** Moves the heights by `dy`. */
  private shiftHeights(dy: number): void {
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
   * tread shorter than 2·`reach` and, on longer ones, flat up to `reach` from each edge; over the gaps and the
   * stretches without ground. It rises like the stairs on average, without steps.
   */
  line(u: number, reach: number): number {
    if (this.count === 0 || u < this.treads[0].start || u > this.treads[this.count - 1].end) return Number.NaN;
    // Nudos (posición, altura) de cada huella, en orden; se interpola entre los dos que rodean a u.
    let previousU = Number.NaN;
    let previousH = Number.NaN;
    for (let i = 0; i < this.count; i++) {
      const t = this.treads[i];
      // Ni por donde no hay suelo: uno al final del perfil (en el fondo de una grieta entre dos rocas) no es un hueco
      // (no tiene huella detrás), y la línea bajaba hacia la altura con que se apunta (la raíz, hasta 180 m).
      if (t.gap || this.hole(t)) continue;
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

  /** The tread is a stretch without ground (see `holeHeight`). */
  private hole(t: Tread): boolean {
    return t.startHeight <= this.holeHeight && t.endHeight <= this.holeHeight;
  }

  private addTread(start: number, height: number, edge: boolean): Tread {
    if (this.treads.length <= this.count) {
      this.treads.push({ start: 0, end: 0, startHeight: 0, endHeight: 0, startEdge: false, endEdge: false, gap: false, cross: false });
    }
    const t = this.treads[this.count++];
    t.start = start;
    t.end = start;
    t.startHeight = height;
    t.endHeight = height;
    t.startEdge = edge;
    t.endEdge = false;
    t.gap = false;
    t.cross = false;
    return t;
  }

  /** Height of the ground at `u`, looking for it around the height `near`; −Infinity if there is none. */
  private heightAt(detector: GroundDetector, u: number, near: number): number {
    const p = this.point(u, this.probe);
    p.y = near + this.castHeight;
    return detector.castDown(p, this.castHeight + this.castDepth, this.hit) ? this.hit.point.y : Number.NEGATIVE_INFINITY;
  }
}

/** Rotates `v` (horizontal) by `angle` rad about +Y (positive = to the left, counterclockwise seen from above). */
function rotateY(v: Vector3, angle: number): Vector3 {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  return v.set(v.x * c + v.z * sn, 0, -v.x * sn + v.z * c);
}

/** Height of a tread at `u` (linear between its ends). */
export function treadHeight(t: Tread, u: number): number {
  const length = t.end - t.start;
  if (length <= 1e-9) return t.startHeight;
  return t.startHeight + ((t.endHeight - t.startHeight) * (u - t.start)) / length;
}
