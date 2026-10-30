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
/** Time for the body to start or stop following the line over the stairs (s). */
const BLEND_TIME = 0.3;

/**
 * Stairs and steps, detected from the geometry (nothing has to be marked):
 *  - when a step would land on a change of level (an edge under the foot or between the feet), it samples
 *    the profile of the ground along the direction of travel (GroundProfile) and moves the landing so that
 *    the whole foot rests on one tread, without skipping any tread it can step on;
 *  - while there are edges ahead, the root follows a smooth line over the treads (`groundHeight`) instead
 *    of the ground right under it, and the speed is limited so that each step climbs one tread;
 *  - a riser higher than `maxStepUp` is a wall: the feet stop in front of it and so does the body.
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
  /** Position (world) of the first riser it can't climb; NaN if none. */
  readonly wall = new Vector3(Number.NaN, 0, 0);

  private readonly config: LocomotionConfig;
  private readonly detector: GroundDetector;
  /** Length of the foot, from the heel under the ankle to the toe joint (m). */
  private readonly footLength: number;
  private readonly hit: GroundHit = createGroundHit();
  private readonly tmp = new Vector3();
  private readonly dir = new Vector3();

  constructor(detector: GroundDetector, config: LocomotionConfig, footLength: number) {
    this.detector = detector;
    this.config = config;
    this.footLength = footLength;
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
    this.active = false;
    this.blend = 0;
    this.run = 0;
    this.profile.count = 0;
    this.wall.x = Number.NaN;
  }

  update(dt: number): void {
    const step = dt / BLEND_TIME;
    this.blend = Math.min(Math.max(this.blend + (this.active ? step : -step), 0), 1);
  }

  /** Moves the stored world positions (see `LocomotionController.shift`). */
  shift(offset: Vector3): void {
    this.profile.origin.add(offset);
    this.profile.shiftHeights(offset.y);
    this.wall.add(offset);
  }

  /**
   * Distance from `position` (world) to the riser it can't climb, if it is ahead in the direction `forward`
   * (within 45° of the direction the stairs were sampled in); Infinity otherwise.
   */
  wallAhead(position: Vector3, forward: Vector3): number {
    if (Number.isNaN(this.wall.x)) return Number.POSITIVE_INFINITY;
    const d = this.profile.direction;
    if (forward.x * d.x + forward.z * d.z < Math.SQRT1_2) return Number.POSITIVE_INFINITY;
    return (this.wall.x - position.x) * d.x + (this.wall.z - position.z) * d.z;
  }

  /**
   * Height the root follows at `position` (world), given the ground right under it: over stairs, the line
   * over the treads (blended in and out with `blend`); elsewhere, that ground.
   */
  groundHeight(position: Vector3, ground: number): number {
    if (this.blend <= 0 || this.profile.edges === 0) return ground;
    const line = this.profile.line(this.profile.along(position), LINE_REACH * this.config.stepLength);
    return Number.isNaN(line) ? ground : ground + (line - ground) * this.blend;
  }

  /**
   * Landing of a step over stairs. `start`: ankle of the foot that takes off; `stance`: ankle of the
   * planted one and the ground under it; `landing`: where it would land on its own (flat ankle, already on
   * the ground) with `ground`, the query of the ground its foot placement made there; `direction`:
   * horizontal direction of travel. `probe`: if it doesn't know yet whether there are stairs, it may look
   * for steps higher than the foot placement sees (two raycasts; see `levelChange`).
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
    out: Vector3,
    probe = true,
  ): boolean {
    const edge = EDGE_HEIGHT * this.footLength;
    if (!this.active && !this.levelChange(stance, stanceGround, landing, ground, direction, edge, probe)) return false;

    const c = this.config;
    const profile = this.profile;
    const p = this.tmp.set(start.x, 0, start.z);
    const dir = this.horizontal(direction);
    const uStance = (stance.x - p.x) * dir.x + (stance.z - p.z) * dir.z;
    const uLanding = (landing.x - p.x) * dir.x + (landing.z - p.z) * dir.z;
    const from = Math.min(0, uStance) - LOOK_BEHIND * c.stepLength;
    const to = Math.max(uLanding, uStance) + this.toeFront + LOOK_AHEAD * c.stepLength;
    const startGround = start.y - ankleHeight;
    profile.sample(this.detector, p, dir, from, to, SAMPLE_SPACING * this.footLength, edge, startGround, c.groundProbeHeight, c.groundProbeDepth);
    this.active = profile.edges > 0;
    this.run = 0;
    this.wall.x = Number.NaN;
    if (!this.active) return false;

    // Huella del pie de apoyo: la referencia para no saltarse escalones y para el escalón máximo.
    const stanceTread = profile.treadIndex(uStance);
    const stanceHeight = stanceTread >= 0 ? treadHeight(profile.treads[stanceTread], uStance) : stanceGround;
    const margin = EDGE_MARGIN * this.footLength;
    let best = Number.NaN;
    let bestTread = -1;
    for (let i = 0; i < profile.count; i++) {
      const t = profile.treads[i];
      const height = treadHeight(t, (t.start + t.end) / 2);
      const riser = i > 0 ? t.startHeight - profile.treads[i - 1].endHeight : 0;
      if (riser > c.maxStepUp && t.start > uStance) {
        // Contrahuella demasiado alta: es una pared; ni esta huella ni las de después.
        profile.point(t.start, this.wall);
        this.wall.y = height;
        // El cuerpo no sigue la línea hacia lo que no puede subir.
        profile.truncate(i);
        break;
      }
      const lo = t.startEdge ? t.start + margin + Math.min(this.heelBack, Math.max(t.end - t.start - 2 * margin - this.toeFront, 0)) : Number.NEGATIVE_INFINITY;
      const hi = t.endEdge ? t.end - margin - this.toeFront : Number.POSITIVE_INFINITY;
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
    // Profundidad de los escalones: la de la primera huella entera por delante del apoyo.
    for (let i = Math.max(stanceTread, 0); i < profile.count; i++) {
      const t = profile.treads[i];
      if (t.startEdge && t.endEdge && t.end - t.start < 2 * c.stepLength) {
        this.run = t.end - t.start;
        break;
      }
    }
    if (bestTread < 0 || Math.abs(best - uLanding) < 1e-4 * this.footLength) return false;
    profile.point(best, out);
    out.y = treadHeight(profile.treads[bestTread], best) + ankleHeight;
    return true;
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
