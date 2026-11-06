import { Vector3 } from 'three';

import type { FootGroundState } from '../terrain/FootPlacement.ts';
import { createGroundHit, type GroundDetector, type GroundHit } from '../terrain/GroundDetector.ts';
import { GroundProfile, treadHeight } from '../terrain/GroundProfile.ts';
import type { LocomotionConfig } from './LocomotionConfig.ts';

/** Jump in height between two samples of the ground that counts as an edge (× foot length). */
const EDGE_HEIGHT = 0.12;
/** Spacing of the samples of the profile (× foot length): the edges are then located by bisection. */
const SAMPLE_SPACING = 0.25;
/** Margin between the foot and an edge (× foot length). */
const EDGE_MARGIN = 0.1;
/** The heel sticks out this much behind the ankle, and the toes this much ahead of the toe joint (× foot length). */
const HEEL_BACK = 0.3;
const TOE_TIP = 0.35;
/** The profile starts this far behind the foot that takes off and ends this far beyond the landing (× stepLength). */
const LOOK_BEHIND = 1;
const LOOK_AHEAD = 1;
/** On treads longer than this (× stepLength) the line over the stairs is flat, except near the edges. */
const LINE_REACH = 0.5;
/** Half the distance over which the slope of the line is measured (× foot length). */
const SLOPE_SPAN = 0.5;
/** Time for the body to start or stop following the line over the stairs (s). */
const BLEND_TIME = 0.3;
/**
 * To know which way the edge of a wall (or a drop it can't step down) runs, it looks for it again this far to
 * one side (× foot length), within this distance before and after (× foot length).
 */
const WALL_SIDE = 2;
const WALL_SEARCH = 4;
/** Bisection steps to locate that second point of the edge. */
const WALL_REFINE_STEPS = 8;
/**
 * It brakes before the wall where it would cross its edge within this distance of the point found (× stepLength),
 * or less if the edge ends before (a corner).
 */
const WALL_EXTENT = 1.5;
/** Walls it remembers at once (in a corner, two). */
const MAX_WALLS = 3;
/** Where it didn't see the edge end, it assumes it goes on this much further than it measured (× its extent). */
const WALL_ASSUMED = 2;
/** If it can't find the edge again to the sides, it looks for its direction this far around the point (× foot length). */
const WALL_AROUND = 1;
/** To check an edge, it looks this far in front of it and behind it (× foot length). */
const WALL_PROBE = 0.5;
/** Bisection steps to find where the edge ends, if it ends within `WALL_SIDE`. */
const WALL_END_STEPS = 5;
/**
 * Coming at the wall at an angle, the toes keep off it as if it came at less than this angle off its normal
 * (cosine): more askew, the landing would have to stay far behind.
 */
const WALL_MIN_COS = 0.2;
/**
 * It brakes only when going towards the wall (cosine with its normal above this). Almost along it, only once it
 * is about to be closer than allowed (see `wallAhead`).
 */
const WALL_AHEAD_COS = 0.02;
/** It forgets the wall once the stance foot is farther than this from it (× stepLength). */
const WALL_FORGET = 2;
/**
 * The look for a wall far ahead goes one step further than needed, so the next step doesn't repeat it if it
 * keeps going in the same direction (within this angle; cosine).
 */
const LOOKED_SAME_COS = Math.cos((10 * Math.PI) / 180);
/** That step further (× `stride`), and a little more: the stance foot advances more or less than the body. */
const FAR_STRIDES = 1.25;

/**
 * Stairs and steps, detected from the geometry (nothing has to be marked):
 *  - when a step would land on a change of level (an edge under the foot or between the feet), it samples
 *    the profile of the ground along the direction of travel (GroundProfile) and moves the landing so that
 *    the whole foot rests on one tread, without skipping any tread it can step on (the gaps between the
 *    treads of stairs without risers are stepped over);
 *  - while there are edges ahead, the root follows a smooth line over the treads (`groundHeight`) instead
 *    of the ground right under it, and the speed is limited so that each step climbs one tread;
 *  - a riser higher than `maxStepUp` is a wall, and a drop deeper than `maxStepDown` an edge it doesn't
 *    step down from: the feet stop before it and so does the body. It looks far enough ahead to brake in
 *    time and remembers the edge (a point and which way it runs) while it is nearby, so that it also brakes
 *    before it when it sets off towards it in another direction.
 * On curved and spiral stairs, while the body turns, the ground is sampled along the arc each foot follows.
 * On ground without edges it does nothing (and doesn't sample).
 */
export class StairPlanner {
  readonly profile = new GroundProfile();
  /** The last profile had edges: there are stairs or steps under or ahead of the character. */
  active = false;
  /** How much the root follows the line over the treads (0–1). */
  blend = 0;
  /** Depth of the treads of the stairs (m; 0 = no flight of stairs, a single step or none). */
  run = 0;
  /**
   * Point (world) on the edge of the last riser it can't climb or drop it can't step down that it found or
   * looked at; NaN if none. It remembers up to `MAX_WALLS` of them while they are nearby (two at a corner).
   */
  readonly wall = new Vector3(Number.NaN, 0, 0);
  /** Horizontal unit normal of that edge, towards the wall (or the drop). */
  readonly wallNormal = new Vector3();
  /**
   * How far that edge goes on each side of `wall` (m, along (n.z, −n.x) with n = `wallNormal`; `wallFrom` ≤ 0
   * ≤ `wallTo`): up to `WALL_EXTENT` × stepLength, or less where it ends before.
   */
  wallFrom = 0;
  wallTo = 0;
  /**
   * Height of the ground on the other side of that edge (m; −∞ if there is none): it is a wall only from
   * ground from which that change of level can't be stepped (going down stairs, the side of a lower tread may
   * be a drop it can step down).
   */
  wallBeyond = Number.NEGATIVE_INFINITY;

  private readonly config: LocomotionConfig;
  private readonly detector: GroundDetector;
  /** Length of the foot, from the heel under the ankle to the toe joint (m). */
  private readonly footLength: number;
  private readonly hit: GroundHit = createGroundHit();
  private readonly tmp = new Vector3();
  private readonly dir = new Vector3();
  private readonly edge = new Vector3();
  private readonly foundAt = new Vector3();
  private readonly checked = new Vector3();
  /** The walls it remembers (`wall`, `wallNormal`, `wallFrom` and `wallTo` of each; point NaN if empty). */
  private readonly walls = Array.from({ length: MAX_WALLS }, () => ({
    point: new Vector3(Number.NaN, 0, 0),
    normal: new Vector3(),
    from: 0,
    to: 0,
    beyond: Number.NEGATIVE_INFINITY,
  }));
  /** Last point far ahead where it looked for a wall (world; NaN if none) and the direction it was going. */
  private readonly lookedAt = new Vector3(Number.NaN, 0, 0);
  private readonly lookedDirection = new Vector3();

  constructor(detector: GroundDetector, config: LocomotionConfig, footLength: number) {
    this.detector = detector;
    this.config = config;
    this.footLength = footLength;
  }

  /** Jump in height that counts as an edge (m). */
  get edgeHeight(): number {
    return EDGE_HEIGHT * this.footLength;
  }

  /** The heel extends this far behind the ankle (m). */
  get heelBack(): number {
    return HEEL_BACK * this.footLength;
  }

  /** The toes extend this far ahead of the ankle (m). */
  get toeFront(): number {
    return (1 + TOE_TIP) * this.footLength;
  }

  /** Forgets the stairs (after a reset or a teleport). */
  reset(): void {
    this.blend = 0;
    this.clearProfile();
    this.wall.x = Number.NaN;
    for (const w of this.walls) w.point.x = Number.NaN;
    this.lookedAt.x = Number.NaN;
  }

  update(dt: number): void {
    const step = dt / BLEND_TIME;
    this.blend = Math.min(Math.max(this.blend + (this.active ? step : -step), 0), 1);
  }

  /** Moves the stored world positions (see `LocomotionController.shift`). */
  shift(offset: Vector3): void {
    this.profile.shift(offset);
    this.wall.add(offset);
    for (const w of this.walls) w.point.add(offset);
    this.lookedAt.add(offset);
  }

  /**
   * Distance from `position` (world), going in the direction `forward`, to the edge of the riser it can't
   * climb (or the drop it can't step down), if it is going towards it and would cross it near the point it
   * found; Infinity otherwise. With `clearance`, to where it would be that far from the edge (measured
   * perpendicular to it: coming at it at an angle, it stops just as far from it; it can be negative). The
   * nearest of the walls it remembers that are walls from ground at `ground` (by default, `position.y`).
   */
  wallAhead(position: Vector3, forward: Vector3, clearance = 0, ground = position.y): number {
    let nearest = Number.POSITIVE_INFINITY;
    for (let k = 0; k < MAX_WALLS; k++) {
      if (this.load(k)) nearest = Math.min(nearest, this.aheadOfWall(position, forward, clearance, ground));
    }
    return nearest;
  }

  /**
   * The body stopped at `position` (world), on ground at `ground`, going in the direction `direction`
   * (horizontal, unit), because just ahead there is a change of level it can't step: it finds the edge and
   * remembers it as a wall (if it doesn't know it yet).
   */
  noteLedge(position: Vector3, direction: Vector3, ground: number): void {
    const reach = WALL_PROBE * this.footLength;
    const blocked = (t: number): boolean =>
      !this.passable(this.heightAt(position.x + direction.x * t, position.z + direction.z * t, ground) - ground);
    if (!blocked(reach)) return;
    let lo = 0;
    let hi = reach;
    for (let k = 0; k < WALL_END_STEPS; k++) {
      const mid = (lo + hi) / 2;
      if (blocked(mid)) hi = mid;
      else lo = mid;
    }
    const at = (lo + hi) / 2;
    this.foundAt.set(position.x + direction.x * at, ground, position.z + direction.z * at);
    this.foundWall(this.foundAt, direction, ground);
  }

  /**
   * How far `position` (world) is closer than `clearance` to the walls it remembers, on this side of them and
   * along them: returns that distance (m; 0 if none) and in `out` the horizontal shift that takes it back to
   * `clearance` from each (those that are walls from ground at `ground`).
   */
  wallPush(position: Vector3, clearance: number, out: Vector3, ground = position.y): number {
    out.set(0, 0, 0);
    for (let k = 0; k < MAX_WALLS; k++) {
      if (!this.load(k)) continue;
      const n = this.wallNormal;
      const perpendicular = (this.wall.x - position.x) * n.x + (this.wall.z - position.z) * n.z;
      if (perpendicular >= clearance || perpendicular < -this.heelBack || !this.alongWall(position.x, position.z)) continue;
      if (this.passable(this.wallBeyond - ground)) continue;
      out.x -= n.x * (clearance - perpendicular);
      out.z -= n.z * (clearance - perpendicular);
    }
    return Math.hypot(out.x, out.z);
  }

  /** `wallAhead` for the wall in `wall` (and the rest of its fields). */
  private aheadOfWall(position: Vector3, forward: Vector3, clearance: number, ground: number): number {
    if (Number.isNaN(this.wall.x) || this.passable(this.wallBeyond - ground)) return Number.POSITIVE_INFINITY;
    const n = this.wallNormal;
    const c = forward.x * n.x + forward.z * n.z;
    if (c < WALL_AHEAD_COS) return Number.POSITIVE_INFINITY;
    const perpendicular = (this.wall.x - position.x) * n.x + (this.wall.z - position.z) * n.z;
    // Ya del otro lado (el borde se acababa y lo rodeó): no es este borde.
    if (perpendicular < -this.heelBack) return Number.POSITIVE_INFINITY;
    const distance = perpendicular / c;
    // Dónde cruzaría el borde, a lo largo de él: lejos del punto encontrado, o pasada una esquina, ya no sigue.
    return this.alongWall(position.x + forward.x * distance, position.z + forward.z * distance)
      ? (perpendicular - clearance) / c
      : Number.POSITIVE_INFINITY;
  }

  /** Puts the remembered wall `k` in `wall` (and the rest of its fields); false if that slot is empty. */
  private load(k: number): boolean {
    const w = this.walls[k];
    if (Number.isNaN(w.point.x)) return false;
    this.wall.copy(w.point);
    this.wallNormal.copy(w.normal);
    this.wallFrom = w.from;
    this.wallTo = w.to;
    this.wallBeyond = w.beyond;
    return true;
  }

  /** Keeps the wall in `wall` (and the rest of its fields) as the remembered wall `k`. */
  private store(k: number): void {
    const w = this.walls[k];
    w.point.copy(this.wall);
    w.normal.copy(this.wallNormal);
    w.from = this.wallFrom;
    w.to = this.wallTo;
    w.beyond = this.wallBeyond;
  }

  /** (`x`, `z`), seen from the edge of `wall`, is within its extent (`wallFrom`–`wallTo`). */
  private alongWall(x: number, z: number): boolean {
    const n = this.wallNormal;
    const along = (x - this.wall.x) * n.z - (z - this.wall.z) * n.x;
    // Donde no lo vio acabar, puede seguir: un poco más allá de lo medido también cuenta (followWall lo mide
    // de nuevo al avanzar).
    const full = WALL_EXTENT * this.config.stepLength;
    const from = this.wallFrom <= -full ? -WALL_ASSUMED * full : this.wallFrom;
    const to = this.wallTo >= full ? WALL_ASSUMED * full : this.wallTo;
    return along >= from && along <= to;
  }

  /**
   * Height the root follows at `position` (world), given the ground right under it (NaN if there is none):
   * over stairs, the line over the treads (blended in and out with `blend`; all of it if there is no
   * ground); elsewhere, that ground.
   */
  groundHeight(position: Vector3, ground: number): number {
    if (this.blend <= 0 || this.profile.edges === 0) return ground;
    const line = this.profile.line(this.profile.along(position), LINE_REACH * this.config.stepLength);
    if (Number.isNaN(line)) return ground;
    return Number.isNaN(ground) ? line : ground + (line - ground) * this.blend;
  }

  /**
   * Slope of the line over the treads at `position` in the direction `forward` (rise / run; + uphill),
   * weighted with `blend`; 0 if it isn't following one.
   */
  slope(position: Vector3, forward: Vector3): number {
    const profile = this.profile;
    if (this.blend <= 0 || profile.edges === 0) return 0;
    const reach = LINE_REACH * this.config.stepLength;
    const u = profile.along(position);
    const h = SLOPE_SPAN * this.footLength;
    const a = profile.line(u - h, reach);
    const b = profile.line(u + h, reach);
    if (Number.isNaN(a) || Number.isNaN(b)) return 0;
    const d = profile.tangent(u, this.dir);
    const facing = forward.x * d.x + forward.z * d.z;
    // Por metro donde está (en una curva, por dentro la escalera es más empinada).
    return (((b - a) / (2 * h)) * facing * this.blend) / profile.pathScale(position);
  }

  /**
   * Landing of a step over stairs. `start`: ankle of the foot that takes off; `stance`: ankle of the
   * planted one and the ground under it; `landing`: where it would land on its own (flat ankle, already on
   * the ground) with `ground`, the query of the ground its foot placement made there; `direction`:
   * horizontal direction of travel; `center`: center of the turn of the body, if it is turning (curved or
   * spiral stairs: the ground is sampled along the arc the foot follows). `probe`: if it doesn't know yet
   * whether there are stairs, it may look for steps higher than the foot placement sees (one raycast; see
   * `levelChange`). `reach`: how far ahead of the stance foot it must see a riser it can't climb or a drop it
   * can't step down, to brake in time before it (m; see `lookFarAhead`); `stride`: about what it advances
   * until the next step (m); `sampleReach`: how far ahead of the stance foot the profile of stairs goes at
   * least (m; `reach` by default; less while it speeds up, see LocomotionController). Near a wall it knows,
   * the landing also keeps off it (`keepOffWall`).
   * Returns the new desired ankle position in `out` (on the chosen tread) and true, or false if it doesn't
   * change (no edges, or the landing is already good).
   */
  planLanding(
    start: Vector3,
    stance: Vector3,
    stanceGround: number,
    landing: Vector3,
    ground: FootGroundState,
    ankleHeight: number,
    direction: Vector3,
    center: Vector3 | null,
    out: Vector3,
    probe = true,
    reach = 0,
    stride = 0,
    sampleReach = reach,
  ): boolean {
    const edge = this.edgeHeight;
    // Lejos ya de la última pared (más que lo que mira hacia delante), la olvida.
    const keep = WALL_FORGET * this.config.stepLength + reach + FAR_STRIDES * stride;
    for (let k = 0; k < MAX_WALLS; k++) {
      const w = this.walls[k];
      if (Math.hypot(stance.x - w.point.x, stance.z - w.point.z) > keep) w.point.x = Number.NaN;
      else if (probe && this.load(k)) {
        this.followWall(stance, stanceGround);
        this.store(k);
      }
    }
    if (!this.active && !this.levelChange(stance, stanceGround, landing, ground, direction, edge, probe)) {
      if (probe) this.lookFarAhead(stance, stanceGround, direction, reach, stride);
      return this.keepOffWall(stance, landing, out, stanceGround);
    }

    const c = this.config;
    const profile = this.profile;
    // En una curva, por el círculo del aterrizaje: es por el que se mueve el pie al ajustarlo (aunque el centro
    // del giro, que cambia de un momento a otro, no sea exactamente el de la escalera).
    profile.setPath(center ? landing : start, this.horizontal(direction), center);
    const uStart = profile.along(start);
    const uStance = profile.along(stance);
    const uLanding = profile.along(landing);
    const from = Math.min(uStart, uStance) - LOOK_BEHIND * c.stepLength;
    const to = Math.max(Math.max(uLanding, uStance) + this.toeFront + LOOK_AHEAD * c.stepLength, uStance + sampleReach);
    const startGround = start.y - ankleHeight;
    profile.sample(this.detector, from, to, SAMPLE_SPACING * this.footLength, edge, startGround, c.groundProbeHeight, c.groundProbeDepth);
    // Huecos (escaleras sin contrahuella): más cortos que lo que el pie necesita para apoyarse.
    profile.markGaps(this.toeFront);
    this.active = profile.edges > 0;
    this.run = 0;
    if (!this.active) return false;

    // Huella del pie de apoyo: la referencia para no saltarse escalones y para el escalón máximo.
    const stanceTread = this.stanceTread(uStance, stanceGround);
    if (stanceTread < 0) {
      // El perfil no coincide con el suelo del pie de apoyo (en un arco muy cerrado junto a un desnivel puede
      // pasar por otro nivel): mejor no seguirlo.
      this.clearProfile();
      return false;
    }
    const stanceHeight = treadHeight(profile.treads[stanceTread], uStance);
    // Por detrás del pie de apoyo, lo que queda más allá de una contrahuella que no se puede subir (o un desnivel
    // que no se puede bajar) no cuenta: ni se pisa ni el cuerpo sigue la línea hacia allí.
    let first = 0;
    for (let i = stanceTread - 1, next = stanceTread; i >= 0; i--) {
      const t = profile.treads[i];
      if (t.gap) continue;
      if (!this.passable(t.endHeight - profile.treads[next].startHeight)) {
        first = next;
        break;
      }
      next = i;
    }
    // Por delante del pie de apoyo, la primera contrahuella demasiado alta (una pared) o desnivel demasiado hondo:
    // ni esa huella ni las de después. Se mide desde la última huella que se puede pisar (los huecos se saltan).
    let end = profile.count;
    let beforeWall = -1;
    // Coseno entre el camino y la normal de la pared: si se llega en diagonal, los dedos quedan más cerca de
    // ella que a lo largo del camino.
    let wallCos = 1;
    for (let i = first, solid = -1; i < profile.count; i++) {
      const t = profile.treads[i];
      if (t.gap) continue;
      const below = solid >= 0 ? profile.treads[solid].endHeight : stanceHeight;
      // La última huella, si es más corta que el pie, puede ser un hueco cortado al final del perfil.
      const cut = i === profile.count - 1 && t.end - t.start < this.toeFront;
      if (solid >= 0 && !cut && !this.passable(t.startHeight - below) && i > stanceTread) {
        const at = profile.point(t.start, this.foundAt);
        at.y = treadHeight(t, (t.start + t.end) / 2);
        const d = profile.tangent(t.start, this.dir);
        this.foundWall(at, d, below);
        wallCos = Math.max(d.x * this.wallNormal.x + d.z * this.wallNormal.z, WALL_MIN_COS);
        end = i;
        beforeWall = solid;
        break;
      }
      solid = i;
    }
    const margin = EDGE_MARGIN * this.footLength;
    let best = Number.NaN;
    let bestTread = -1;
    for (let i = first; i < end; i++) {
      const t = profile.treads[i];
      if (t.gap) continue;
      const height = treadHeight(t, (t.start + t.end) / 2);
      const lo = t.startEdge ? t.start + margin + Math.min(this.heelBack, Math.max(t.end - t.start - 2 * margin - this.toeFront, 0)) : Number.NEGATIVE_INFINITY;
      // Delante de una pared, la punta del pie a `margin` de ella aunque el pie la mire de frente. Pero no por
      // detrás del pie de apoyo, como mucho a su lado: de refilón (coseno pequeño), el aterrizaje acababa cada
      // paso más atrás y los pies se alejaban del cuerpo. Lo que falte, perpendicular a la pared: keepOffWall.
      const hi = !t.endEdge
        ? Number.POSITIVE_INFINITY
        : i === beforeWall
          ? Math.max(t.end - (margin + this.toeFront) / wallCos, Math.min(uStance, t.end - margin - this.toeFront))
          : t.end - margin - this.toeFront;
      if (lo <= hi) {
        const u = Math.min(Math.max(uLanding, lo), hi);
        if (Number.isNaN(best) || Math.abs(u - uLanding) < Math.abs(best - uLanding)) {
          best = u;
          bestTread = i;
        }
        // Sin saltarse escalones: la primera huella de otro nivel por delante del pie de apoyo es la última posible.
        if (t.start > uStance && Math.abs(height - stanceHeight) >= edge) break;
      }
    }
    // El cuerpo no sigue la línea hacia lo que no puede subir.
    if (end < profile.count) profile.truncate(end);
    // Profundidad de los escalones: la más corta por delante del apoyo (desde un descansillo, la de la escalera
    // que viene), de borde a borde de dos huellas seguidas (sin contrahuella, con el hueco). En una curva, en
    // el camino del cuerpo (entre los dos pies; por dentro las huellas son más estrechas).
    const bodyScale = profile.pathScale(this.tmp.addVectors(start, stance).multiplyScalar(0.5));
    let previousStart = Number.NaN;
    for (let i = stanceTread; i < profile.count; i++) {
      const t = profile.treads[i];
      if (t.gap) continue;
      const going = (t.start - previousStart) * bodyScale;
      if (going < 2 * c.stepLength && (this.run === 0 || going < this.run)) this.run = going;
      previousStart = t.startEdge ? t.start : Number.NaN;
    }
    let moved = bestTread >= 0 && Math.abs(best - uLanding) >= 1e-4 * this.footLength;
    if (moved) {
      // Por su camino (en una curva, sin cambiar la distancia al centro).
      profile.moveAlong(landing, best, out);
      out.y = treadHeight(profile.treads[bestTread], best) + ankleHeight;
    }
    profile.dropFirst(first);
    if (this.keepOffWall(stance, moved ? out : landing, out, stanceGround)) moved = true;
    return moved;
  }

  /**
   * Keeps a landing (`landing`, world ankle) off the edge of the wall it knows (`wall`), if the stance foot
   * is on this side of it: the ankle at least a foot and a margin from it, whichever way the foot points (in a
   * tight turn or coming at it at an angle, the profile doesn't ensure that). Returns the new landing in
   * `out` and true, or false if it doesn't change. Off each of the walls it remembers (in a corner, both).
   */
  private keepOffWall(stance: Vector3, landing: Vector3, out: Vector3, ground: number): boolean {
    let moved = false;
    const current = this.checked.copy(landing);
    for (let k = 0; k < MAX_WALLS; k++) {
      if (this.load(k) && this.keepOffOneWall(stance, current, out, ground)) {
        current.copy(out);
        moved = true;
      }
    }
    return moved;
  }

  /** `keepOffWall` for the wall in `wall` (and the rest of its fields). */
  private keepOffOneWall(stance: Vector3, landing: Vector3, out: Vector3, ground: number): boolean {
    if (Number.isNaN(this.wall.x) || this.passable(this.wallBeyond - ground)) return false;
    const n = this.wallNormal;
    const w = this.wall;
    if ((w.x - stance.x) * n.x + (w.z - stance.z) * n.z <= 0) return false;
    const distance = (w.x - landing.x) * n.x + (w.z - landing.z) * n.z;
    const need = EDGE_MARGIN * this.footLength + this.toeFront;
    // Pasado el borde, también (caminando a lo largo de él, el perfil no lo cruza); mucho más allá, ya no es este
    // borde.
    if (distance >= need || distance < -need) return false;
    // Junto a la pared que encontró (más lejos, o pasada una esquina, ya no sigue).
    if (!this.alongWall(landing.x, landing.z)) return false;
    out.copy(landing);
    out.x -= n.x * (need - distance);
    out.z -= n.z * (need - distance);
    return true;
  }

  /** Forgets the profile (not the last wall): the body stops following the line over the treads. */
  private clearProfile(): void {
    this.active = false;
    this.run = 0;
    this.profile.count = 0;
  }

  /**
   * Looks `reach` m ahead of the stance foot (one step further) for a riser it can't climb or a drop it can't
   * step down, to brake in time before it: one raycast, at most every other step while it keeps going the
   * same way. If the ground there is out of reach of a step, it finds by bisection where the level changes:
   * if it is a single jump, it is a wall, and it remembers it (`wall`); if not, they are stairs or a slope,
   * which it will see on reaching them.
   */
  private lookFarAhead(stance: Vector3, stanceGround: number, direction: Vector3, reach: number, stride: number): void {
    if (!(reach > 0)) return;
    const dir = this.horizontal(direction);
    // En el paso anterior ya miró hasta aquí o más, yendo hacia el mismo lado.
    const lx = this.lookedAt.x - stance.x;
    const lz = this.lookedAt.z - stance.z;
    const same = dir.x * this.lookedDirection.x + dir.z * this.lookedDirection.z > LOOKED_SAME_COS;
    if (same && lx * dir.x + lz * dir.z >= reach && Math.abs(lx * dir.z - lz * dir.x) < WALL_SIDE * this.footLength) return;
    const distance = reach + FAR_STRIDES * stride;
    this.lookedAt.set(stance.x + dir.x * distance, stanceGround, stance.z + dir.z * distance);
    this.lookedDirection.copy(dir);
    const far = this.heightAt(this.lookedAt.x, this.lookedAt.z, stanceGround);
    if (this.passable(far - stanceGround)) return;
    let lo = 0;
    let hi = distance;
    let low = stanceGround;
    let high = far;
    for (let k = 0; k < WALL_REFINE_STEPS; k++) {
      const mid = (lo + hi) / 2;
      const h = this.heightAt(stance.x + dir.x * mid, stance.z + dir.z * mid, stanceGround);
      // Sin suelo (far = −∞), es del otro lado.
      if (Math.abs(h - low) <= Math.abs(h - high)) {
        lo = mid;
        low = h;
      } else {
        hi = mid;
        high = h;
      }
    }
    if (this.passable(high - low)) return;
    const at = (lo + hi) / 2;
    // A un pie de cada lado del salto, también: si no, es el hueco entre dos huellas de una escalera sin
    // contrahuella, que se salta.
    const before = this.heightAt(stance.x + dir.x * (at - this.toeFront), stance.z + dir.z * (at - this.toeFront), stanceGround);
    const after = this.heightAt(stance.x + dir.x * (at + this.toeFront), stance.z + dir.z * (at + this.toeFront), stanceGround);
    if (this.passable(after - before)) return;
    this.foundAt.set(stance.x + dir.x * at, Number.isFinite(high) ? high : low, stance.z + dir.z * at);
    this.foundWall(this.foundAt, dir, low);
  }

  /**
   * Remembers the wall whose edge it just found at `point`, coming in the direction `direction` from ground at
   * `ground`, and measures it; if it is on an edge it already knows, it keeps that one (without measuring it
   * again). Either way, it ends up in `wall` (and the rest of its fields). Instead of the farthest one, if it
   * already remembers `MAX_WALLS`.
   */
  private foundWall(point: Vector3, direction: Vector3, ground: number): void {
    const w = this.wall;
    const n = this.wallNormal;
    let empty = -1;
    let farthest = 0;
    let farthestDistance = -1;
    for (let k = 0; k < MAX_WALLS; k++) {
      if (!this.load(k)) {
        if (empty < 0) empty = k;
        continue;
      }
      const known =
        direction.x * n.x + direction.z * n.z > 0 &&
        Math.abs((point.x - w.x) * n.x + (point.z - w.z) * n.z) < WALL_PROBE * this.footLength &&
        this.alongWall(point.x, point.z);
      if (known) return;
      const distance = Math.hypot(point.x - w.x, point.z - w.z);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = k;
      }
    }
    const slot = empty >= 0 ? empty : farthest;
    w.copy(point);
    n.set(direction.x, 0, direction.z).normalize();
    this.measureWall(ground);
    this.wallBeyond = this.beyondWall(ground);
    this.store(slot);
  }

  /**
   * Walking along the wall it knows (the stance foot at `stance`, on ground at `ground`, on this side of it),
   * more than halfway to the end of what it measured, if the edge went on: it finds it again beside the foot
   * and measures it from there. If not, past that end it wouldn't see it (it would neither brake nor keep the
   * feet off it).
   */
  private followWall(stance: Vector3, ground: number): void {
    const w = this.wall;
    const n = this.wallNormal;
    if (Number.isNaN(w.x) || (w.x - stance.x) * n.x + (w.z - stance.z) * n.z <= 0) return;
    const full = WALL_EXTENT * this.config.stepLength;
    const along = (stance.x - w.x) * n.z - (stance.z - w.z) * n.x;
    const goesOn = along > 0 ? this.wallTo >= full : this.wallFrom <= -full;
    if (Math.abs(along) < full / 2 || !goesOn) return;
    // La paralela a la normal por el pie (edgePoint mide el desplazamiento al revés que `along`).
    const p = this.edgePoint(-along, ground);
    if (!p || !this.isEdge(p.x, p.z, n.x, n.z, ground)) return;
    w.x = p.x;
    w.z = p.z;
    const side = WALL_SIDE * this.footLength;
    // Hacia el punto de antes, ya se sabe que sigue al menos hasta él.
    this.wallTo = this.edgeEnd(1, Math.max(-along, 0), side, full, ground);
    this.wallFrom = -this.edgeEnd(-1, Math.max(along, 0), side, full, ground);
    this.wallBeyond = this.beyondWall(ground);
  }

  /**
   * Measures the edge of the wall just found (`wall`), coming from ground at `ground` in the direction
   * `wallNormal`. Its normal (`wallNormal`): perpendicular to the edge, which it finds again a little to one side
   * (if it isn't there, to the other; if neither, it leaves that direction). How far it goes on each side
   * (`wallFrom`, `wallTo`): up to `WALL_EXTENT` × stepLength, or where it ends before (a corner).
   */
  private measureWall(ground: number): void {
    const n = this.wallNormal;
    const w = this.wall;
    const side = WALL_SIDE * this.footLength;
    const full = WALL_EXTENT * this.config.stepLength;
    // Dónde lo encontró otra vez, a lo largo del borde (0 si en ninguna paralela).
    let confirmed = 0;
    for (const s of [side, -side]) {
      const p = this.edgePoint(s, ground);
      if (!p) continue;
      const ex = p.x - w.x;
      const ez = p.z - w.z;
      const length = Math.hypot(ex, ez);
      if (length < 1e-6) continue;
      // Perpendicular al borde, hacia el mismo lado que el camino.
      const sign = ez * n.x - ex * n.z >= 0 ? 1 : -1;
      const nx = (sign * ez) / length;
      const nz = (-sign * ex) / length;
      // Que sea el borde: a mitad de camino, delante este suelo y detrás el otro nivel. Junto a una esquina, la
      // paralela puede dar en la otra cara (y la recta entre los dos puntos cruza el bloque).
      if (!this.isEdge(w.x + ex / 2, w.z + ez / 2, nx, nz, ground)) continue;
      n.set(nx, 0, nz);
      confirmed = ex * nz - ez * nx;
      break;
    }
    // Ni a un lado ni al otro (llegando muy de refilón, las paralelas no lo cruzan): alrededor del punto.
    if (confirmed === 0) this.normalAround(ground);
    this.wallTo = this.edgeEnd(1, Math.max(confirmed, 0), side, full, ground);
    this.wallFrom = -this.edgeEnd(-1, Math.max(-confirmed, 0), side, full, ground);
  }

  /**
   * Normal of the edge at `wall` from what there is around it, `WALL_AROUND` × foot length away: the middle of
   * the directions in which there is a change of level it can't step (half a turn on a straight edge, a quarter
   * at a corner). If it doesn't find a single such span, it leaves `wallNormal` as it was.
   */
  private normalAround(ground: number): void {
    const n = this.wallNormal;
    const nx = n.x;
    const nz = n.z;
    const r = WALL_AROUND * this.footLength;
    // Ángulo desde la normal de ahora, hacia (n.z, −n.x).
    const behind = (a: number): boolean => {
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = this.wall.x + (nx * c + nz * s) * r;
      const z = this.wall.z + (nz * c - nx * s) * r;
      return !this.passable(this.heightAt(x, z, ground) - ground);
    };
    const count = 8;
    const step = (2 * Math.PI) / count;
    const sample: boolean[] = [];
    for (let k = 0; k < count; k++) sample.push(behind(k * step));
    // Una sola racha de direcciones "detrás": dónde entra y dónde sale.
    let enter = -1;
    let exit = -1;
    for (let k = 0; k < count; k++) {
      const prev = sample[(k + count - 1) % count];
      if (!prev && sample[k]) enter = enter < 0 ? k : -2;
      if (sample[k] && !sample[(k + 1) % count]) exit = exit < 0 ? k : -2;
    }
    if (enter < 0 || exit < 0) return;
    const refine = (lo: number, hi: number, loBehind: boolean): number => {
      for (let i = 0; i < WALL_END_STEPS; i++) {
        const mid = (lo + hi) / 2;
        if (behind(mid) === loBehind) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    const from = refine((enter - 1) * step, enter * step, false);
    let to = refine(exit * step, (exit + 1) * step, true);
    if (to < from) to += 2 * Math.PI;
    const mid = (from + to) / 2;
    const c = Math.cos(mid);
    const s = Math.sin(mid);
    n.set(nx * c + nz * s, 0, nz * c - nx * s).normalize();
  }

  /**
   * Looks for the edge again on a parallel to `wallNormal` `s` m to one side of `wall`, from `WALL_SEARCH` ×
   * foot length before it to as far after: the first change of level from the ground of this side (`ground`),
   * if it can't be stepped. Returns the point (in a shared vector), or null.
   */
  private edgePoint(s: number, ground: number): Vector3 | null {
    const n = this.wallNormal;
    const search = WALL_SEARCH * this.footLength;
    const x0 = this.wall.x - n.z * s - n.x * search;
    const z0 = this.wall.z + n.x * s - n.z * search;
    const near = this.heightAt(x0, z0, ground);
    // Empieza en este lado (en una escalera que sube a la pared, puede caer en una huella más baja).
    if (!(Math.abs(near - ground) < this.edgeHeight)) return null;
    // El primer punto que no está a ese nivel: el del final y, si no, otros antes (junto a una esquina, la
    // paralela puede pasar por fuera y volver a este nivel).
    let lo = 0;
    let hi = Number.NaN;
    for (const k of [2, 4, 6, 8]) {
      const t = (k / 8) * 2 * search;
      const h = this.heightAt(x0 + t * n.x, z0 + t * n.z, ground);
      if (Math.abs(h - near) < this.edgeHeight) {
        lo = t;
        continue;
      }
      if (this.passable(h - ground)) return null;
      hi = t;
      break;
    }
    if (Number.isNaN(hi)) return null;
    for (let k = 0; k < WALL_REFINE_STEPS; k++) {
      const mid = (lo + hi) / 2;
      const h = this.heightAt(x0 + mid * n.x, z0 + mid * n.z, ground);
      // El primer cambio de nivel desde `near` (detrás puede haber más escalones; sin suelo, h = −∞).
      if (Math.abs(h - near) < this.edgeHeight) lo = mid;
      else hi = mid;
    }
    const along = (lo + hi) / 2;
    return this.edge.set(x0 + along * n.x, 0, z0 + along * n.z);
  }

  /**
   * There is an edge at (`x`, `z`) with normal (`nx`, `nz`), coming from ground at `ground`: just in front, ground
   * it can step on; just behind, a change of level it can't.
   */
  private isEdge(x: number, z: number, nx: number, nz: number, ground: number): boolean {
    const d = WALL_PROBE * this.footLength;
    if (!this.passable(this.heightAt(x - nx * d, z - nz * d, ground) - ground)) return false;
    return !this.passable(this.heightAt(x + nx * d, z + nz * d, ground) - ground);
  }

  /**
   * How far the edge of `wall` goes in direction `sign` along it (m), knowing it is there up to `from`: it
   * follows it in steps of `side`, up to `full`, until it ends (just behind the edge, ground it can step on
   * again).
   */
  private edgeEnd(sign: number, from: number, side: number, full: number, ground: number): number {
    const n = this.wallNormal;
    const d = WALL_PROBE * this.footLength;
    const behind = (a: number): boolean => {
      const x = this.wall.x + n.z * sign * a + n.x * d;
      const z = this.wall.z - n.x * sign * a + n.z * d;
      return !this.passable(this.heightAt(x, z, ground) - ground);
    };
    let lo = Math.min(from, full);
    let hi = Math.min(lo + side, full);
    while (lo < full && behind(hi)) {
      lo = hi;
      hi = Math.min(lo + side, full);
    }
    if (lo >= full) return full;
    for (let k = 0; k < WALL_END_STEPS; k++) {
      const mid = (lo + hi) / 2;
      if (behind(mid)) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  /** Height of the ground just behind the edge of `wall`, coming from ground at `ground` (m; −∞ if none). */
  private beyondWall(ground: number): number {
    const d = WALL_PROBE * this.footLength;
    return this.heightAt(this.wall.x + this.wallNormal.x * d, this.wall.z + this.wallNormal.z * d, ground);
  }

  /** Height of the ground at (`x`, `z`), looking for it around the height `near` like the profile; −∞ if none. */
  private heightAt(x: number, z: number, near: number): number {
    const c = this.config;
    const origin = this.tmp.set(x, near + c.groundProbeHeight, z);
    return this.detector.castDown(origin, c.groundProbeHeight + c.groundProbeDepth, this.hit) ? this.hit.point.y : Number.NEGATIVE_INFINITY;
  }

  /** Index of the tread the stance foot (at `u`, on ground at `ground`) rests on; −1 if none matches. */
  private stanceTread(u: number, ground: number): number {
    const profile = this.profile;
    const edge = this.edgeHeight;
    const i = profile.treadIndex(u);
    // La de su posición, si está a un escalón o menos de su suelo (el perfil es recto entre los bordes: en un
    // suelo irregular no coincide del todo).
    if (i >= 0 && this.passable(treadHeight(profile.treads[i], u) - ground)) return i;
    // Si no (el tobillo, sobre el hueco de una escalera sin contrahuella; en un arco muy cerrado, un punto fuera
    // del camino que cae en otro nivel): la huella más cercana a la altura de su suelo. El pie está apoyado
    // en ella: no es un hueco (en un arco que cruza un desnivel dos veces, el suelo entre los dos cruces
    // parecía el hueco entre dos huellas más altas).
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let j = 0; j < profile.count; j++) {
      const t = profile.treads[j];
      const v = Math.min(Math.max(u, t.start), t.end);
      const distance = Math.abs(v - u);
      if (Math.abs(treadHeight(t, v) - ground) < edge && distance < bestDistance) {
        best = j;
        bestDistance = distance;
      }
    }
    if (best >= 0) profile.treads[best].gap = false;
    return best;
  }

  /** A change of level of `rise` m (+ up) can be stepped: up to `maxStepUp` up and `maxStepDown` down. */
  private passable(rise: number): boolean {
    return rise <= this.config.maxStepUp && rise >= -this.config.maxStepDown;
  }

  /**
   * Going down from `start` to `landing` (world ankles, of the step just planned): fraction of the
   * horizontal path the foot must cover before it starts to drop, so that the back of the heel has passed
   * the edge of the tread it lands on (0 if there is none).
   */
  dropFraction(start: Vector3, landing: Vector3): number {
    const profile = this.profile;
    const u0 = profile.along(start);
    const u1 = profile.along(landing);
    const i = profile.treadIndex(u1);
    if (u1 - u0 < 1e-6 || i <= 0) return 0;
    const t = profile.treads[i];
    if (!t.startEdge || t.start <= u0) return 0;
    const pass = t.start + this.heelBack + EDGE_MARGIN * this.footLength - u0;
    return Math.min(Math.max(pass / (u1 - u0), 0), 1);
  }

  /**
   * Does the step land on a change of level? The ground under the stance foot or under the toes of the
   * landing foot is off the plane of the ground under its heel (`ground`, from the foot placement). The
   * placement looks for the ground only a little above the ankle and doesn't see a higher step: with
   * `probe`, the ground under the tips of the toes is checked from as high as the root looks (one raycast;
   * a high step under the heel is also under the toes).
   */
  private levelChange(
    stance: Vector3,
    stanceGround: number,
    landing: Vector3,
    ground: FootGroundState,
    direction: Vector3,
    edge: number,
    probe: boolean,
  ): boolean {
    if (!ground.grounded) return true;
    const heel = ground.hit;
    const n = heel.normal;
    if (n.y < 1e-6) return true;
    const off = (x: number, y: number, z: number): number =>
      Math.abs(y - (heel.point.y - (n.x * (x - heel.point.x) + n.z * (z - heel.point.z)) / n.y));
    if (off(stance.x, stanceGround, stance.z) >= edge) return true;
    const toe = ground.toeHit.point;
    if (ground.toeGrounded && off(toe.x, toe.y, toe.z) >= edge) return true;
    if (!probe) return false;
    const c = this.config;
    const low = Math.min(stanceGround, heel.point.y) - c.groundProbeDepth;
    const top = Math.max(stanceGround, heel.point.y) + c.groundProbeHeight;
    const tip = this.tmp.set(landing.x, top, landing.z).addScaledVector(this.horizontal(direction), this.toeFront);
    if (!this.detector.castDown(tip, top - low, this.hit)) return true;
    return off(this.hit.point.x, this.hit.point.y, this.hit.point.z) >= edge;
  }

  /** Horizontal unit vector of a direction. */
  private horizontal(direction: Vector3): Vector3 {
    return this.dir.set(direction.x, 0, direction.z).normalize();
  }
}
