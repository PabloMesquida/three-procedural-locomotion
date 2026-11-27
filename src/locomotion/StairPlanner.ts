import { Vector3 } from 'three';

import type { FootExtent } from '../rig/measureFeet.ts';
import type { FootGroundState } from '../terrain/FootPlacement.ts';
import { createGroundHit, type GroundDetector, type GroundHit } from '../terrain/GroundDetector.ts';
import { NARROW_DROP } from '../terrain/NarrowPath.ts';
import { GroundProfile, treadHeight } from '../terrain/GroundProfile.ts';
import type { LocomotionConfig } from './LocomotionConfig.ts';

/** Jump in height between two samples of the ground that counts as an edge (× foot length). */
const EDGE_HEIGHT = 0.12;
/** Spacing of the samples of the profile (× foot length): the edges are then located by bisection. */
const SAMPLE_SPACING = 0.25;
/** Margin between the foot and an edge (× foot length). */
const EDGE_MARGIN = 0.1;
/**
 * Without a measure of the foot on the model's mesh (see measureFeet): the heel sticks out this much behind
 * the ankle, and the toes this much ahead of the toe joint (× foot length).
 */
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
/** A slope steeper than `maxSlope` is measured this far on each side of the point (× stepLength; see lookFarAhead). */
const STEEP_SPAN = 0.5;
/** Ground with a normal less vertical than this (cosine; 5°) is a slope, not a tread (see aheadSlope). */
const SLOPE_TILTED = Math.cos((5 * Math.PI) / 180);
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
 * Before braking at a remembered edge (or keeping a foot off it), it looks at the ground this far beyond it
 * (× foot length) where it would cross it: if it can step there, the edge has a gap (a beam or a narrow wall
 * leaves from it) and it goes on.
 */
const GAP_PROBE = 0.3;
/**
 * On a narrow path, going almost along it (cosine with the normal of its side below this: within 15° of the path) it
 * doesn't brake for its sides; going towards one, it stops this far from its edge (× foot length): the feet, together
 * under the body, stay on it.
 */
const NARROW_ALONG_COS = Math.sin((15 * Math.PI) / 180);
const NARROW_EDGE_ROOM = 0.25;
/**
 * Gaps it steps across (`maxGapStep`): it looks for the ground on the other side every this much (× foot length), and
 * then where it starts by bisection, in this many steps.
 */
const GAP_SAMPLE = 0.25;
const GAP_REFINE_STEPS = 3;
/** A gap this much wider than `maxGapStep` (× foot length) still counts: what the edges are located to. */
const GAP_TOLERANCE = 0.1;
/** Most rays it looks for the other side of a gap with, before locating it (wider gaps, more spaced). */
const GAP_MAX_SAMPLES = 16;
/**
 * It jumps across a gap (`maxGapJump`) only going at it within this angle of square on (cosine; 35°), and stopped
 * at most this far from its edge, beyond where it stops in front of it (× foot length).
 */
const JUMP_MIN_COS = Math.cos((35 * Math.PI) / 180);
/**
 * Standing at the edge (see `gapJump`), up to this much off it (the way the route goes; the width is measured that way):
 * at the edge of a curved crevice, the route went 40° off the edge it found, and it stood there.
 */
const JUMP_STANDING_COS = Math.cos((50 * Math.PI) / 180);
const JUMP_EDGE_SLACK = 1;
/**
 * Faster than walkSpeed, a gap it jumps across has to be seen in time to take off before it (or brake): between the
 * point it looked at far ahead the step before and the one now, it also looks at the ground every `maxGapStep` (a gap
 * wider than that falls between two of them; a narrower one, it steps across).
 */
const GAP_SCAN_SPEED = 1;
/**
 * Across a gap, the longest step (ankle to ankle, along the way it goes): from the stance foot just before the edge
 * to the landing just past the other one, over the widest gap (`maxGapStep`), and this much more (× foot length).
 */
const GAP_STEP_SLACK = 0.4;
/**
 * Before a gap it crosses, with the step it would take landing in it (and going on at least this much past the stance
 * foot, × stepLength: not stepping in place), it puts the foot just before the edge or crosses it, whichever is closer
 * in proportion to that step. Crossing, the step can be up to `gapReach` long or, running, GAP_STRETCH times that step
 * (see `gapStretch`; walking, a longer step sank the hips more than slowing down). If it stops at the edge with a step
 * so short that the next one, with the body going on as before (about two steps minus this one), would be longer than
 * that, it slows down to GAP_WAIT_SPEED (× walkSpeed) until it crosses (`gapWait`): the next step was 1.2–1.5 m long.
 * If it can't slow down before the edge (it saw the gap late), it crosses with a step up to GAP_STRETCH times as long:
 * the body passed over the gap with both feet behind it.
 */
const GAP_MIN_ADVANCE = 0.25;
/**
 * A dip no wider than `maxGapStep` and deeper than this below the ground on both sides (× stepLength; a crevice between
 * two rocks, a trench) it also crosses with a long step, though it could step down into it: it stepped into it, with
 * the body going down too.
 */
export const GAP_DIP = 0.1;
/** A dip under the landing it crosses (see `crossDip`): the ground is looked at every 1 / DIP_SAMPLES of `maxGapStep`. */
const DIP_SAMPLES = 8;
/** Its sides, at most this much below the stance foot (× GAP_DIP; not the face of the dip, sloping up to the far one). */
const DIP_RIM = 2;
/** Looking for firm ground for a foot (see `firmLanding`): every this much along the step (× foot length). */
const FIRM_SAMPLE = 0.5;
/** …and up to this far to each side (× foot length), each metre to a side costing this many along the step. */
const FIRM_SIDE = 0.5;
const FIRM_SIDE_COST = 1.5;
/** …never closer than this to the stance foot (ankle to ankle, × foot length). */
const FIRM_APART = 0.6;
const GAP_STRETCH = 1.35;
/**
 * Jumping a gap, the other side can be this much lower than a step down (× `maxStepDown`): from the higher rock of a
 * crevice to a lower one, 35 cm below with a step down of 32, it didn't see where to land and stood at the edge.
 */
const JUMP_DROP = 2;
const GAP_WAIT_SPEED = 0.4;

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
  /**
   * The ground under the body is level whatever the profile says: the root leaves the line over the treads (`blend`
   * goes to 0). Balancing on a low narrow path, turned on it, the profile across it saw its sides as steps and the root
   * went down the line between the path and the ground beside it (with the knees bent, 20 cm lower).
   */
  level = false;
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
  /**
   * Width of the gap behind that edge, along its normal, up to ground it can step on again (m; Infinity if there is
   * none within `maxGapStep`): coming at it within that distance, it crosses it with a long step (see `gapAcross`).
   */
  wallGap = Number.POSITIVE_INFINITY;
  /** Height of the ground on the other side of that gap (m; NaN if there is no gap within reach). */
  wallFar = Number.NaN;
  /** `wallGap` and `wallFar` for a jump: up to ground JUMP_DROP times a step down lower (see `gapAhead`). */
  wallJump = Number.POSITIVE_INFINITY;
  wallJumpFar = Number.NaN;
  /**
   * The last step stopped just before a gap it crosses, because the other side was out of reach: until the step that
   * crosses it, it slows down (see LocomotionController), or the body went on and the next step was very long.
   */
  gapWait = false;
  /**
   * The last step crosses a gap (from the stance foot to the landing), or stops just before one to cross it with the
   * next: meanwhile it doesn't speed up (see LocomotionController). Speeding up after a turn, the landing went further
   * and further: a 1.1 m step.
   */
  gapCrossing = false;
  /**
   * It is going to jump across the gap ahead running, without stopping (set by LocomotionController, see
   * `gapAhead`): the edge guard doesn't brake for gaps it jumps across.
   */
  leaping = false;
  /** How much longer than the step it would take it can make the one that crosses a gap (1 walking; see GAP_STRETCH). */
  gapStretch = 1;
  /** Speed of the body (m/s): whether it can slow down before a gap (see GAP_STRETCH). */
  private speed = 0;

  private readonly config: LocomotionConfig;
  private readonly detector: GroundDetector;
  /** Height of the other side found by the last `gapAcross` (NaN if none). */
  private gapFar = Number.NaN;
  /** Length of the foot, from the heel under the ankle to the toe joint (m). */
  private readonly footLength: number;
  /** Spots tried by `firmLanding` (reused). */
  private readonly firmCandidates: { s: number; l: number; cost: number }[] = [];
  private readonly hit: GroundHit = createGroundHit();
  private readonly tmp = new Vector3();
  private readonly dir = new Vector3();
  private readonly edge = new Vector3();
  private readonly foundAt = new Vector3();
  /**
   * Foot (or top) of the last slope steeper than `maxSlope` it saw ahead (see lookFarAhead; x NaN: none) and the
   * direction it was going: it stops before it (see steepAhead).
   */
  private readonly steepPoint = new Vector3(Number.NaN, 0, 0);
  private readonly steepDirection = new Vector3();
  /**
   * Mean slope of the ground from the stance foot to where lookFarAhead last looked (rise / run, + uphill; 0 if it
   * was a wall, a jump or a slope steeper than `maxSlope`): with it the character slows down before a slope.
   */
  private aheadSlope = 0;
  /** The last look ahead saw the ground change level (more than a quarter of a step): it looks again on the next step. */
  private relook = false;
  private readonly checked = new Vector3();
  /** The walls it remembers (`wall`, `wallNormal`, `wallFrom` and `wallTo` of each; point NaN if empty). */
  private readonly walls = Array.from({ length: MAX_WALLS }, () => ({
    point: new Vector3(Number.NaN, 0, 0),
    normal: new Vector3(),
    from: 0,
    to: 0,
    beyond: Number.NEGATIVE_INFINITY,
    gap: Number.POSITIVE_INFINITY,
    far: Number.NaN,
    jump: Number.POSITIVE_INFINITY,
    jumpFar: Number.NaN,
  }));
  /** Last point far ahead where it looked for a wall (world; NaN if none) and the direction it was going. */
  private readonly lookedAt = new Vector3(Number.NaN, 0, 0);
  /** Up to where it looked for gaps along the way it goes (world; NaN if it didn't, see GAP_SCAN_SPEED). */
  private readonly scannedAt = new Vector3(Number.NaN, 0, 0);
  private readonly lookedDirection = new Vector3();

  /** The foot measured on the model's mesh, if it could be (see measureFeet). */
  private readonly extent: FootExtent | null;

  constructor(detector: GroundDetector, config: LocomotionConfig, footLength: number, extent: FootExtent | null = null) {
    this.detector = detector;
    this.config = config;
    this.footLength = footLength;
    this.extent = extent;
  }

  /** Jump in height that counts as an edge (m). */
  get edgeHeight(): number {
    return EDGE_HEIGHT * this.footLength;
  }

  /** The heel extends this far behind the ankle (m): measured on the mesh or, without it, HEEL_BACK. */
  get heelBack(): number {
    return this.extent ? this.extent.back : HEEL_BACK * this.footLength;
  }

  /** The toes extend this far ahead of the ankle (m): measured on the mesh or, without it, TOE_TIP. */
  get toeFront(): number {
    return this.extent ? this.extent.front : (1 + TOE_TIP) * this.footLength;
  }

  /**
   * Longest step across a gap (m, ankle to ankle along the way it goes): over the widest one (`maxGapStep`), from
   * the stance foot just before its edge to the landing just past the other one (see GAP_STEP_SLACK).
   */
  get gapReach(): number {
    const margin = EDGE_MARGIN * this.footLength;
    return this.gapWidth + 2 * margin + this.toeFront + this.heelBack + GAP_STEP_SLACK * this.footLength;
  }

  /**
   * How it goes: how much it runs (0–1; running fully, the step that crosses a gap can be up to GAP_STRETCH times the
   * one it would take) and its speed (m/s).
   */
  setMotion(run: number, speed: number): void {
    this.gapStretch = 1 + (GAP_STRETCH - 1) * run;
    this.speed = speed;
  }

  /** Speed to which it slows down while `gapWait` (m/s). */
  get gapWaitSpeed(): number {
    return GAP_WAIT_SPEED * this.config.walkSpeed;
  }

  /**
   * Widest gap it jumps across (m): `maxGapJump`, up to `maxGapJumpRun` running (in proportion to the speed, from
   * walkSpeed to jogSpeed), and what the edges are located to (GAP_TOLERANCE); 0 if none.
   */
  get jumpWidth(): number {
    const c = this.config;
    const run = Math.max(c.maxGapJumpRun, c.maxGapJump);
    const k = Math.min(Math.max((this.speed - c.walkSpeed) / Math.max(c.jogSpeed - c.walkSpeed, 1e-6), 0), 1);
    const max = c.maxGapJump + (run - c.maxGapJump) * k;
    return max > 0 ? max + GAP_TOLERANCE * this.footLength : 0;
  }

  /**
   * Stopped at `position` (world) on ground at `ground`, wanting to go in the horizontal unit direction `direction`:
   * if just ahead there is the edge of a gap it jumps across (wider than `maxGapStep` and up to `maxGapJump` that way,
   * see JUMP_MIN_COS), it fills `out` (the distance to its edge and its width, along `direction`, and the height of the
   * other side) and returns true. Among the walls it remembers: no raycasts.
   */
  gapJump(position: Vector3, direction: Vector3, ground: number, out: { edge: number; width: number; far: number }): boolean {
    // Medido como lo para el guarda (perpendicular al borde): llegando en diagonal, a lo largo del camino quedaba más
    // lejos y no saltaba. Y también uno que cruzaría de un paso: medido por donde va (no por donde lo midió el guarda),
    // por unos centímetros, y se quedaba parado al borde.
    return this.gapAhead(position, direction, ground, this.toeFront + this.heelBack + JUMP_EDGE_SLACK * this.footLength, out, true);
  }

  /** `gapJump` for the edge of a gap up to `within` m ahead (along `direction`). */
  gapAhead(position: Vector3, direction: Vector3, ground: number, within: number, out: { edge: number; width: number; far: number }, square = false): boolean {
    if (!(this.jumpWidth > 0)) return false;
    for (let k = 0; k < MAX_WALLS; k++) {
      if (!this.load(k) || !Number.isFinite(this.wallJump) || Number.isNaN(this.wallJumpFar)) continue;
      const n = this.wallNormal;
      const c = direction.x * n.x + direction.z * n.z;
      if (c < (square ? JUMP_STANDING_COS : JUMP_MIN_COS)) continue;
      const perpendicular = (this.wall.x - position.x) * n.x + (this.wall.z - position.z) * n.z;
      const edge = perpendicular / c;
      if (perpendicular < -this.heelBack || (square ? perpendicular : edge) > within) continue;
      if (!this.alongWall(position.x + direction.x * edge, position.z + direction.z * edge)) continue;
      const width = this.wallJump / c;
      const rise = this.wallJumpFar - ground;
      // Más ancho de lo que cruza de un paso, o tanto más abajo que no lo baja de un paso (ver JUMP_DROP).
      if (width > this.jumpWidth || rise > this.config.maxStepUp || rise < -JUMP_DROP * this.config.maxStepDown) continue;
      // Uno que cruza de un paso, no (parado ante él, `square`, sí: si el guarda lo paró, no lo cruzaba de un paso).
      if (!square && width <= this.gapWidth && this.passable(rise)) continue;
      out.edge = edge;
      out.width = width;
      out.far = this.wallJumpFar;
      return true;
    }
    return false;
  }

  /** Widest gap it steps across (m): `maxGapStep`, and what the edges are located to (GAP_TOLERANCE); 0 if none. */
  private get gapWidth(): number {
    const max = this.config.maxGapStep;
    return max > 0 ? max + GAP_TOLERANCE * this.footLength : 0;
  }

  /** Forgets the stairs (after a reset or a teleport). */
  reset(): void {
    this.blend = 0;
    this.clearProfile();
    this.wall.x = Number.NaN;
    this.steepPoint.x = Number.NaN;
    for (const w of this.walls) w.point.x = Number.NaN;
    this.lookedAt.x = Number.NaN;
    this.scannedAt.x = Number.NaN;
    this.gapWait = false;
    this.gapCrossing = false;
    this.leaping = false;
  }

  update(dt: number): void {
    const step = dt / BLEND_TIME;
    this.blend = Math.min(Math.max(this.blend + (this.active && !this.level ? step : -step), 0), 1);
  }

  /** Moves the stored world positions (see `LocomotionController.shift`). */
  shift(offset: Vector3): void {
    this.profile.shift(offset);
    this.wall.add(offset);
    for (const w of this.walls) w.point.add(offset);
    this.lookedAt.add(offset);
    this.scannedAt.add(offset);
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
   * Mean slope of the ground ahead (rise / run, + uphill) along `forward` from `position` (world), from the last look
   * ahead (see aheadSlope); 0 if it was looking another way or is already past where it looked.
   */
  slopeAhead(position: Vector3, forward: Vector3): number {
    const p = this.lookedAt;
    if (Number.isNaN(p.x)) return 0;
    const d = this.lookedDirection;
    if (forward.x * d.x + forward.z * d.z < LOOKED_SAME_COS) return 0;
    if ((p.x - position.x) * d.x + (p.z - position.z) * d.z <= 0) return 0;
    return this.aheadSlope;
  }

  /**
   * Distance from `position` (world), going in the direction `forward`, to where it is `clearance` from the foot (or
   * top) of a slope steeper than `maxSlope` it saw ahead (see lookFarAhead), if it is going towards it and would get
   * there within WALL_EXTENT × stepLength of the point found; Infinity otherwise. Past it, it forgets it.
   */
  steepAhead(position: Vector3, forward: Vector3, clearance = 0): number {
    const p = this.steepPoint;
    if (Number.isNaN(p.x)) return Number.POSITIVE_INFINITY;
    const n = this.steepDirection;
    const perpendicular = (p.x - position.x) * n.x + (p.z - position.z) * n.z;
    if (perpendicular < -this.heelBack) {
      p.x = Number.NaN;
      return Number.POSITIVE_INFINITY;
    }
    const c = forward.x * n.x + forward.z * n.z;
    if (c < WALL_AHEAD_COS) return Number.POSITIVE_INFINITY;
    const distance = perpendicular / c;
    const x = position.x + forward.x * distance - p.x;
    const z = position.z + forward.z * distance - p.z;
    if (Math.hypot(x, z) > WALL_EXTENT * this.config.stepLength) return Number.POSITIVE_INFINITY;
    return (perpendicular - clearance) / c;
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
   * The root moves from (`fromX`, `fromZ`), on ground at `ground`, to (`toX`, `toZ`), over a change of level it can't
   * step (see BodyController.gapLine): if it is a gap it steps across (`maxGapStep`), the height to follow over it (that
   * of the side it comes from); NaN if not. A step can cross a gap narrower than itself without the profile seeing it:
   * the first time, it finds the edge and remembers it (a few raycasts); then, none.
   */
  gapLine(fromX: number, fromZ: number, toX: number, toZ: number, ground: number): number {
    if (!(this.config.maxGapStep > 0)) return Number.NaN;
    if (this.overGap(toX, toZ)) return ground;
    const dir = this.tmp.set(toX - fromX, 0, toZ - fromZ);
    if (dir.lengthSq() < 1e-12) return Number.NaN;
    dir.normalize();
    this.noteLedge(this.checked.set(fromX, ground, fromZ), this.dir.copy(dir), ground);
    return this.overGap(toX, toZ) ? ground : Number.NaN;
  }

  /** (`x`, `z`) is over a gap it steps across that it remembers: past its edge, before the other side. */
  private overGap(x: number, z: number): boolean {
    for (let k = 0; k < MAX_WALLS; k++) {
      if (!this.load(k) || !(this.wallGap <= this.gapWidth)) continue;
      const n = this.wallNormal;
      const past = (x - this.wall.x) * n.x + (z - this.wall.z) * n.z;
      const slack = EDGE_MARGIN * this.footLength;
      if (past > -slack && past < this.wallGap + slack && this.alongWall(x, z)) return true;
    }
    return false;
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
      // Ni de un hueco que cruza: parado a medio cruzarlo, queda con un pie a cada lado.
      if (this.wallGap <= this.gapWidth) continue;
      // Ni del costado de un camino angosto: lo apartaba hacia el otro borde, y volvía a querer andar.
      if (this.narrowAt(position.x + n.x * perpendicular, position.z + n.z * perpendicular, ground)) continue;
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
    // Un hueco que cruza de un paso, yendo hacia él (en diagonal es más ancho): no frena.
    if (this.wallGap <= this.gapWidth * c) return Number.POSITIVE_INFINITY;
    // Ni ante uno que va a saltar corriendo (ver `leaping`).
    if (this.leaping && this.wallJump <= this.jumpWidth * c) return Number.POSITIVE_INFINITY;
    const perpendicular = (this.wall.x - position.x) * n.x + (this.wall.z - position.z) * n.z;
    // Ya del otro lado (el borde se acababa y lo rodeó): no es este borde.
    if (perpendicular < -this.heelBack) return Number.POSITIVE_INFINITY;
    const distance = perpendicular / c;
    // Dónde cruzaría el borde, a lo largo de él: lejos del punto encontrado, o pasada una esquina, ya no sigue.
    const x = position.x + forward.x * distance;
    const z = position.z + forward.z * distance;
    if (!this.alongWall(x, z)) return Number.POSITIVE_INFINITY;
    // Por un hueco del borde (sale de él una viga o un muro angosto), tampoco.
    if (this.gapAt(x, z, ground)) return Number.POSITIVE_INFINITY;
    // El costado de un camino angosto (cae también al otro lado): va por él más cerca del borde que `clearance`. Casi
    // a lo largo de él (NARROW_ALONG_COS), no frena; yendo hacia él, se para a NARROW_EDGE_ROOM del borde (y se queda
    // parado: antes se acercaba sin llegar a parar y daba pasos en el sitio contra el borde).
    if (clearance > perpendicular && this.narrowAt(x, z, ground)) {
      if (c < NARROW_ALONG_COS) return Number.POSITIVE_INFINITY;
      return (perpendicular - Math.min(clearance, NARROW_EDGE_ROOM * this.footLength)) / c;
    }
    return (perpendicular - clearance) / c;
  }

  /**
   * The edge of `wall` at (`x`, `z`) is a side of a narrow path: `narrowWidth` before it, on this side, the ground
   * drops too (NARROW_DROP). One raycast.
   */
  private narrowAt(x: number, z: number, ground: number): boolean {
    const width = this.config.narrowWidth;
    if (!(width > 0)) return false;
    const n = this.wallNormal;
    const back = (this.wall.x - x) * n.x + (this.wall.z - z) * n.z - width;
    return this.heightAt(x + n.x * back, z + n.z * back, ground) < ground - NARROW_DROP * this.config.stepLength;
  }

  /**
   * Just beyond the edge of `wall` where (`x`, `z`) crosses it (GAP_PROBE), the ground can be stepped from `ground`:
   * the remembered edge has a gap there. One raycast.
   */
  private gapAt(x: number, z: number, ground: number): boolean {
    const n = this.wallNormal;
    const beyond = (this.wall.x - x) * n.x + (this.wall.z - z) * n.z + GAP_PROBE * this.footLength;
    const h = this.heightAt(x + n.x * beyond, z + n.z * beyond, ground);
    // El labio empinado de un hueco que salta (con la otra orilla medida) no es un paso: con él, el borde no frenaba y
    // el cuerpo cruzaba solo la grieta. Sobre rocas, las caras empinadas sí (subiendo por ellas).
    if (Number.isFinite(this.wallJump) && this.hit.normal.y < this.steepCos) return false;
    return this.passable(h - ground);
  }

  /**
   * From the edge at (`x`, `z`), coming from ground at `ground` and going in the horizontal unit direction (`dx`,
   * `dz`): how far beyond it the ground it can step on starts again, if that is within `maxGapStep` and the whole foot
   * fits there (a gap it crosses with a long step); Infinity otherwise. Up to `maxGapStep` / GAP_SAMPLE raycasts, and
   * a few more if it finds it.
   */
  private gapAcross(x: number, z: number, dx: number, dz: number, ground: number, drop = this.config.maxStepDown): number {
    this.gapFar = Number.NaN;
    const max = Math.max(this.gapWidth, this.jumpWidth);
    if (!(max > 0)) return Number.POSITIVE_INFINITY;
    // Suelo que se puede pisar: a un escalón y no más empinado que maxSlope (el labio de una grieta entre dos rocas
    // redondeadas, que se empina hacia el fondo, es parte del hueco).
    const ok = (d: number): boolean => {
      const rise = this.heightAt(x + dx * d, z + dz * d, ground) - ground;
      return rise <= this.config.maxStepUp && rise >= -drop && this.hit.normal.y >= this.steepCos;
    };
    // Pasado el borde, el hueco (si ahí ya se puede pisar, es una grieta: la ve el perfil, como en una escalera sin
    // contrahuella).
    let lo = WALL_PROBE * this.footLength;
    if (lo > max || ok(lo)) return Number.POSITIVE_INFINITY;
    const step = Math.max(GAP_SAMPLE * this.footLength, max / GAP_MAX_SAMPLES);
    let hi = Number.NaN;
    for (let d = lo + step; ; d += step) {
      const at = Math.min(d, max);
      if (ok(at)) {
        hi = at;
        break;
      }
      lo = at;
      if (at >= max) return Number.POSITIVE_INFINITY;
    }
    for (let k = 0; k < GAP_REFINE_STEPS; k++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) hi = mid;
      else lo = mid;
    }
    // Que quepa el pie entero del otro lado.
    const room = hi + this.heelBack + this.toeFront;
    if (!ok(room)) return Number.POSITIVE_INFINITY;
    this.gapFar = this.heightAt(x + dx * room, z + dz * room, ground);
    return hi;
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
    this.wallGap = w.gap;
    this.wallFar = w.far;
    this.wallJump = w.jump;
    this.wallJumpFar = w.jumpFar;
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
    w.gap = this.wallGap;
    w.far = this.wallFar;
    w.jump = this.wallJump;
    w.jumpFar = this.wallJumpFar;
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
    const profile = this.profile;
    if (profile.edges === 0) return ground;
    const u = profile.along(position);
    // Sobre un hueco que cruza, la línea entera: el suelo de debajo es el fondo del hueco (o ninguno).
    const i = profile.treadIndex(u);
    const over = i >= 0 && profile.treads[i].cross;
    if (this.blend <= 0 && !over) return ground;
    const line = profile.line(u, LINE_REACH * this.config.stepLength);
    if (Number.isNaN(line)) return ground;
    const blend = over ? 1 : this.blend;
    return Number.isNaN(ground) ? line : ground + (line - ground) * blend;
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
    if (!this.active && !this.levelChange(stance, stanceGround, landing, ground, direction, edge, probe) && !this.crossesGap(stance, landing)) {
      if (probe) this.lookFarAhead(stance, stanceGround, direction, reach, stride);
      return this.keepOffWall(stance, landing, out, stanceGround);
    }

    const c = this.config;
    const profile = this.profile;
    // En una curva, por el círculo del aterrizaje: es por el que se mueve el pie al ajustarlo (aunque el centro
    // del giro, que cambia de un momento a otro, no sea exactamente el de la escalera).
    let uStart = 0;
    let uStance = 0;
    let uLanding = 0;
    const sample = (arc: Vector3 | null): void => {
      profile.setPath(arc ? landing : start, this.horizontal(direction), arc);
      uStart = profile.along(start);
      uStance = profile.along(stance);
      uLanding = profile.along(landing);
      const from = Math.min(uStart, uStance) - LOOK_BEHIND * c.stepLength;
      // Al menos hasta donde llega el paso más largo sobre un hueco, con el pie entero: si el perfil acaba dentro del
      // hueco, no ve la otra orilla y lo toma por un desnivel.
      const gapEnd = this.gapWidth > 0 ? uStance + this.gapReach + this.toeFront : Number.NEGATIVE_INFINITY;
      const to = Math.max(Math.max(uLanding, uStance) + this.toeFront + LOOK_AHEAD * c.stepLength, uStance + sampleReach, gapEnd);
      // En los bordes, lo más empinado que maxSlope no se pisa (el labio de una grieta entre dos rocas redondeadas).
      profile.sample(this.detector, from, to, SAMPLE_SPACING * this.footLength, edge, start.y - ankleHeight, c.groundProbeHeight, c.groundProbeDepth, probe ? this.steepCos : Number.NEGATIVE_INFINITY, this.toeFront + this.heelBack);
      // Huecos (escaleras sin contrahuella): más cortos que lo que el pie necesita para apoyarse. Y huecos que cruza
      // con un paso largo (`maxGapStep`). Por un arco, solo el que queda entre los dos pies (uno a cada lado): uno que
      // sale de una plataforma por su borde y vuelve a entrar en ella parecía un hueco por delante (y la raíz salía de
      // la plataforma por encima de él); esos los mira en línea recta (ver dropAhead).
      profile.markGaps(this.toeFront, this.gapWidth, c.maxStepUp, c.maxStepDown, GAP_DIP * c.stepLength);
      if (arc) {
        const lo = Math.min(uStart, uStance);
        const hi = Math.max(uStart, uStance);
        for (let i = 0; i < profile.count; i++) {
          const t = profile.treads[i];
          if (t.cross && (t.start < lo || t.end > hi)) t.cross = t.gap = false;
        }
      }
    };
    sample(center);
    // Girando, si por el arco da con un desnivel que no puede bajar, mira también en línea recta: por el arco, un hueco
    // que cruza (la ruta lo cruza en línea recta) parecía mucho más ancho, y paraba al borde con el cuerpo siguiendo.
    if (center && this.gapWidth > 0 && this.dropAhead(uStance)) {
      sample(null);
      if (!this.crossAhead(uStance)) sample(center);
    }
    this.active = profile.edges > 0;
    this.run = 0;
    if (!this.active) {
      // Un cambio de nivel sin bordes (la cresta o el pie de una rampa) después de girar: también mira por delante. Si
      // no, la pendiente que iba a pisar solo la veía si la había mirado antes, desde más lejos, hacia allí (llegando
      // a una rampa por un giro, no). Yendo recto no: sobre rocas, frenaba por cada cara.
      const dir = this.horizontal(direction);
      const turned = dir.x * this.lookedDirection.x + dir.z * this.lookedDirection.z < LOOKED_SAME_COS;
      if (probe && turned) this.lookFarAhead(stance, stanceGround, direction, reach, stride);
      return false;
    }

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
    // Dónde puede apoyar el pie entero en la huella `i` (`lo`–`hi`, a lo largo del perfil).
    let lo = 0;
    let hi = 0;
    const bounds = (i: number): boolean => {
      const t = profile.treads[i];
      lo = t.startEdge ? t.start + margin + Math.min(this.heelBack, Math.max(t.end - t.start - 2 * margin - this.toeFront, 0)) : Number.NEGATIVE_INFINITY;
      // Delante de una pared, la punta del pie a `margin` de ella aunque el pie la mire de frente. Pero no por
      // detrás del pie de apoyo, como mucho a su lado: de refilón (coseno pequeño), el aterrizaje acababa cada
      // paso más atrás y los pies se alejaban del cuerpo. Lo que falte, perpendicular a la pared: keepOffWall.
      hi = !t.endEdge
        ? Number.POSITIVE_INFINITY
        : i === beforeWall
          ? Math.max(t.end - (margin + this.toeFront) / wallCos, Math.min(uStance, t.end - margin - this.toeFront))
          : t.end - margin - this.toeFront;
      return lo <= hi;
    };
    // Pasado un hueco que cruza, no más lejos del pie de apoyo que el paso más largo (ver GAP_STRETCH).
    const natural = uLanding - uStance;
    const farthest = uStance + Math.max(this.gapReach, natural * this.gapStretch);
    let crossed = false;
    let best = Number.NaN;
    let bestTread = -1;
    for (let i = first; i < end; i++) {
      const t = profile.treads[i];
      if (t.cross && t.start > uStance) crossed = true;
      if (t.gap) continue;
      const height = treadHeight(t, (t.start + t.end) / 2);
      if (bounds(i) && crossed) hi = Math.min(hi, farthest);
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
    // Retenido por un hueco que cruza: al borde o pasado el hueco, lo más parecido al paso que daría (ver GAP_MIN_ADVANCE).
    const next = bestTread + 2;
    this.gapWait = false;
    if (bestTread >= 0 && next < end && profile.treads[bestTread + 1].cross && best < uLanding && natural > GAP_MIN_ADVANCE * c.stepLength) {
      const near = Math.max(best - uStance, 1e-6);
      let cross = bounds(next) && lo <= farthest && Math.abs(Math.log((lo - uStance) / natural)) <= Math.abs(Math.log(near / natural));
      if (!cross && 2 * natural - near > farthest - uStance) {
        // Tendría que esperar: si no le da para frenar antes del borde, cruza estirando el paso (ver GAP_STRETCH).
        const v = this.speed;
        const slow = this.gapWaitSpeed;
        const brake = v > slow ? (v * v - slow * slow) / (2 * c.deceleration) + (v * c.speedEasing) / 2 : 0;
        cross = brake > profile.treads[bestTread].end - uStance && bounds(next) && lo - uStance <= natural * GAP_STRETCH;
        this.gapWait = !cross;
      }
      if (cross) {
        best = lo;
        bestTread = next;
      }
    }
    this.gapCrossing = false;
    for (let i = stanceTread + 1; i < bestTread; i++) if (profile.treads[i].cross) this.gapCrossing = true;
    if (bestTread >= 0 && bestTread + 1 < profile.count && profile.treads[bestTread + 1].cross && best < uLanding) this.gapCrossing = true;
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
   * The step (from `start`, the ankle of the foot that takes off) lands in a dip it crosses (see GAP_DIP) that the profile doesn't see: a crevice between two rocks whose
   * near side slopes down into it (the profile sees treads between edges, and a face sloping down is not an edge). The
   * landing (`landing`, world ankle, already placed) more than GAP_DIP below the stance foot (on ground at
   * `stanceGround`); along `direction`, through the landing, its sides: ahead, the nearest ground more than GAP_DIP above
   * it and no more than DIP_RIM × GAP_DIP below the stance foot, within a step of it; behind, the nearest ground more
   * than GAP_DIP above it that can be stood on (not steeper than `maxSlope`), or the stance foot if there is none on
   * that line, where the foot took off. Between them, no wider than `maxGapStep`, with room for the whole foot past it, the dip.
   * Like a gap it crosses: the foot just before it or past it, whichever is closer in proportion to the step (past it,
   * no farther than the longest step across a gap). Returns that landing in `out` (height: that of the stance foot;
   * it is placed again) and true, or false. Only if the landing is that low: up to about DIP_SAMPLES raycasts if
   * there is no side ahead (going down stairs), and up to about 2 × DIP_SAMPLES if there is.
   */
  crossDip(start: Vector3, stance: Vector3, stanceGround: number, landing: Vector3, ankleHeight: number, direction: Vector3, out: Vector3): boolean {
    const width = this.gapWidth;
    const c = this.config;
    if (!(width > 0)) return false;
    const depth = GAP_DIP * c.stepLength;
    const sole = landing.y - ankleHeight;
    if (!(stanceGround - sole > depth)) return false;
    const d = this.horizontal(direction);
    const dx = d.x;
    const dz = d.z;
    // Lo que avanza el pie desde donde despegó (alcanzando al otro, su paso cruza la grieta aunque no pase del apoyo).
    const natural = (landing.x - start.x) * dx + (landing.z - start.z) * dz;
    if (!(natural > GAP_MIN_ADVANCE * c.stepLength)) return false;
    const behindStance = (stance.x - start.x) * dx + (stance.z - start.z) * dz;
    const step = width / DIP_SAMPLES;
    // Alturas a lo largo del paso, por la línea del aterrizaje, en s (m) desde él.
    const at = (s: number): number => this.heightAt(landing.x + dx * s, landing.z + dz * s, stanceGround);
    const rim = Math.max(sole + depth, stanceGround - DIP_RIM * depth);
    const side = (h: number): boolean => h >= rim && this.passable(h - stanceGround);
    const steepest = Math.tan((Math.min(c.maxSlope, 89) * Math.PI) / 180);
    // La orilla de allá (si no la hay, baja de verdad: una escalera, una rampa).
    let far = Number.NaN;
    for (let k = 1; k * step <= width + step + 1e-9; k++) {
      if (side(at(k * step))) {
        far = k * step;
        break;
      }
    }
    if (Number.isNaN(far)) return false;
    // La de acá: hacia atrás, el primer suelo más de `depth` por encima del aterrizaje en el que se puede estar (no más
    // empinado que maxSlope). Si no lo hay en la línea del aterrizaje (una roca que cae hacia un lado), el pie de apoyo,
    // que está en ella. Con una cuerda entre las dos, el labio inclinado de una roca contaba como parte de la grieta.
    let near = -natural;
    let previous = at(-step);
    for (let k = 1; (k + 1) * step < natural; k++) {
      const next = at(-(k + 1) * step);
      if (previous >= sole + depth && Math.abs(next - previous) <= steepest * step) {
        near = -k * step;
        break;
      }
      previous = next;
    }
    const edgeNear = near + step / 2;
    const edgeFar = far - step / 2;
    if (edgeFar - edgeNear > width) return false;
    const margin = EDGE_MARGIN * this.footLength;
    if (!side(at(edgeFar + this.heelBack + this.toeFront + margin))) return false;
    const before = natural + edgeNear - this.toeFront - margin;
    const past = natural + edgeFar + this.heelBack + margin;
    // Pasada ella, no más lejos del pie de apoyo que el paso más largo sobre un hueco.
    const farthest = Math.max(this.gapReach, (natural - behindStance) * this.gapStretch);
    const canBefore = before > GAP_MIN_ADVANCE * c.stepLength;
    const canPast = past - behindStance <= farthest;
    let u: number;
    if (canBefore && canPast) u = Math.abs(Math.log(past / natural)) <= Math.abs(Math.log(before / natural)) ? past : before;
    else if (canPast) u = past;
    // Si no le da para ninguno de los dos, antes de ella con un paso corto (al menos a la altura del apoyo): el paso
    // siguiente la cruza.
    else if (before > 0) u = before;
    else return false;
    out.set(landing.x + dx * (u - natural), stanceGround + ankleHeight, landing.z + dz * (u - natural));
    return true;
  }

  /**
   * Chooses where the foot rests when the planned landing (`landing`, world ankle, already placed; `ground`, the query
   * of the ground its foot placement made there) is on ground steeper than `maxSlope`: the face of a crevice between
   * two rounded rocks, the side of a stone. Nobody puts a foot there: around it, the nearest spot where the whole foot
   * rests on firm ground (under the heel, the ankle and the tips of the toes: not steeper than `maxSlope`, within a
   * step up or down of the stance foot, on ground at `stanceGround`), along `direction` (shorter or longer, not behind
   * where the foot took off, `start`, nor farther from the stance foot than the longest step across a gap) or a little
   * to a side (see FIRM_SIDE), not on the stance foot (see FIRM_APART). Returns it in `out` (height: that of the stance
   * foot; it is placed again) and true, or false (the landing is firm, or there is none within reach: it stays).
   * Only then: up to three raycasts per spot, nearest first.
   */
  firmLanding(start: Vector3, stance: Vector3, stanceGround: number, landing: Vector3, ground: FootGroundState, ankleHeight: number, direction: Vector3, out: Vector3): boolean {
    const c = this.config;
    if (!(c.maxSlope < 90) || !ground.grounded) return false;
    const flat = Math.cos((c.maxSlope * Math.PI) / 180);
    if (ground.hit.normal.y >= flat) return false;
    // La consulta, la de este aterrizaje.
    if (Math.hypot(ground.rayOrigin.x - landing.x, ground.rayOrigin.z - landing.z) > this.footLength) return false;
    const d = this.horizontal(direction);
    const dx = d.x;
    const dz = d.z;
    const natural = (landing.x - start.x) * dx + (landing.z - start.z) * dz;
    // Un paso de verdad (ver GAP_MIN_ADVANCE): parándose, los pasos en el sitio que lo dejan quieto no; movido el pie,
    // quedaba lejos de su sitio y volvía a dar otro, sin acabar de pararse.
    if (!(natural > GAP_MIN_ADVANCE * c.stepLength)) return false;
    const step = FIRM_SAMPLE * this.footLength;
    // Hacia atrás, hasta donde despegó.
    const back = natural;
    const farthest = Math.max(this.gapReach, Math.hypot(landing.x - stance.x, landing.z - stance.z) * this.gapStretch);
    const apart = FIRM_APART * this.footLength;
    const candidates = this.firmCandidates;
    candidates.length = 0;
    const sides = Math.round(FIRM_SIDE / FIRM_SAMPLE);
    for (let i = -Math.floor(back / step); i * step <= farthest; i++) {
      for (let j = -sides; j <= sides; j++) {
        if (i === 0 && j === 0) continue;
        candidates.push({ s: i * step, l: j * step, cost: Math.abs(i * step) + FIRM_SIDE_COST * Math.abs(j * step) });
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const firm = (x: number, z: number): boolean => {
      const h = this.heightAt(x, z, stanceGround);
      return Number.isFinite(h) && this.hit.normal.y >= flat && this.passable(h - stanceGround);
    };
    for (const { s, l } of candidates) {
      const x = landing.x + dx * s - dz * l;
      const z = landing.z + dz * s + dx * l;
      const fromStance = Math.hypot(x - stance.x, z - stance.z);
      if (fromStance > farthest || fromStance < apart) continue;
      if (!firm(x, z) || !firm(x - dx * this.heelBack, z - dz * this.heelBack) || !firm(x + dx * this.toeFront, z + dz * this.toeFront)) continue;
      out.set(x, stanceGround + ankleHeight, z);
      return true;
    }
    return false;
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
    // Un hueco que cruza: dónde aterriza (antes del borde o pasado el hueco) lo decide el perfil.
    if (this.wallGap <= this.gapWidth) return false;
    const n = this.wallNormal;
    const w = this.wall;
    if ((w.x - stance.x) * n.x + (w.z - stance.z) * n.z <= 0) return false;
    const distance = (w.x - landing.x) * n.x + (w.z - landing.z) * n.z;
    const need = EDGE_MARGIN * this.footLength + this.toeFront;
    // Pasado el borde, también (caminando a lo largo de él, el perfil no lo cruza); mucho más allá, ya no es este
    // borde.
    if (distance >= need || distance < -need) return false;
    // Junto a la pared que encontró (más lejos, o pasada una esquina, ya no sigue), y no por un hueco de ella.
    // Ni en el costado de un camino angosto: allí los pies van por el medio (ver NarrowPath).
    if (!this.alongWall(landing.x, landing.z) || this.gapAt(landing.x, landing.z, ground) || this.narrowAt(landing.x, landing.z, ground)) return false;
    out.copy(landing);
    out.x -= n.x * (need - distance);
    out.z -= n.z * (need - distance);
    return true;
  }

  /**
   * The step from `stance` to `landing` (world ankles; with the toes of the landing) crosses the edge of a gap it steps
   * across that it remembers (see `maxGapStep`): a step that crosses it on its own, landing past it, doesn't see any
   * change of level under the feet, but the body has to follow the line over it (and the landing may not be good).
   */
  private crossesGap(stance: Vector3, landing: Vector3): boolean {
    const d = this.horizontal(this.tmp.subVectors(landing, stance));
    for (let k = 0; k < MAX_WALLS; k++) {
      if (!this.load(k) || !(this.wallGap <= this.gapWidth)) continue;
      const n = this.wallNormal;
      const before = (this.wall.x - stance.x) * n.x + (this.wall.z - stance.z) * n.z;
      const tip = this.toeFront;
      const after = (this.wall.x - landing.x - d.x * tip) * n.x + (this.wall.z - landing.z - d.z * tip) * n.z;
      if (before > 0 && after < 0 && this.alongWall(landing.x, landing.z)) return true;
    }
    return false;
  }

  /** In the profile, past `u`, a drop it can't step down that isn't a gap it crosses. */
  private dropAhead(u: number): boolean {
    const profile = this.profile;
    for (let i = 1; i < profile.count; i++) {
      const t = profile.treads[i];
      if (t.end > u && !t.cross && profile.treads[i - 1].endHeight - t.startHeight > this.config.maxStepDown) return true;
    }
    return false;
  }

  /** In the profile, past `u`, a gap it crosses. */
  private crossAhead(u: number): boolean {
    const profile = this.profile;
    for (let i = 0; i < profile.count; i++) if (profile.treads[i].cross && profile.treads[i].end > u) return true;
    return false;
  }

  /** Forgets the profile (not the last wall): the body stops following the line over the treads. */
  private clearProfile(): void {
    this.active = false;
    this.gapCrossing = false;
    this.gapWait = false;
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
    if (same && !this.relook && lx * dir.x + lz * dir.z >= reach && Math.abs(lx * dir.z - lz * dir.x) < WALL_SIDE * this.footLength) return;
    const distance = reach + FAR_STRIDES * stride;
    this.lookedAt.set(stance.x + dir.x * distance, stanceGround, stance.z + dir.z * distance);
    this.lookedDirection.copy(dir);
    const far = this.heightAt(this.lookedAt.x, this.lookedAt.z, stanceGround);
    // La pendiente que verá, con un rayo más a mitad de camino: si allí (o a mitad) el suelo está inclinado (una rampa,
    // una roca; el extremo de una viga, la otra orilla de un hueco o una huella son planos: un escalón o un salto, que
    // tienen lo suyo), la más empinada de la media y la de esa mitad del camino (una rampa que empieza antes o acaba
    // antes: la media la diluía el llano; mirando desde la cresta de una corta, `far` ya cae abajo, en llano). Por
    // alturas: la normal de un punto en la cara de una piedra suelta frenaba sin motivo.
    const farTilted = this.hit.normal.y < SLOPE_TILTED;
    const mid = this.heightAt(stance.x + (dir.x * distance) / 2, stance.z + (dir.z * distance) / 2, stanceGround);
    const midTilted = this.hit.normal.y < SLOPE_TILTED;
    const mean = (far - stanceGround) / distance;
    let slope = 0;
    if (Number.isFinite(far) && Number.isFinite(mid)) {
      const candidates = [mean];
      if (farTilted) candidates.push((far - mid) / (distance / 2));
      if (midTilted) candidates.push((mid - stanceGround) / (distance / 2));
      if (farTilted || midTilted) for (const c of candidates) if (Math.abs(c) > Math.abs(slope)) slope = c;
    }
    this.aheadSlope = slope;
    // Hacia una pendiente (o escalera), mira otra vez en el paso siguiente: la vuelve a medir más cerca, y ya entera.
    this.relook = Number.isFinite(far) && Math.abs(far - stanceGround) > 0.25 * this.config.maxStepUp;
    // Desde donde miró antes por esta misma línea, si lo hizo (ver GAP_SCAN_SPEED); si no, desde el pie.
    const scan = this.speed > GAP_SCAN_SPEED * this.config.walkSpeed && this.jumpWidth > 0;
    const sx = this.scannedAt.x - stance.x;
    const sz = this.scannedAt.z - stance.z;
    const scanned = same && !Number.isNaN(sx) && Math.abs(sx * dir.z - sz * dir.x) < WALL_SIDE * this.footLength ? Math.max(sx * dir.x + sz * dir.z, this.toeFront) : this.toeFront;
    if (scan) this.scannedAt.set(stance.x + dir.x * distance, stanceGround, stance.z + dir.z * distance);
    else this.scannedAt.x = Number.NaN;
    if (this.passable(far - stanceGround)) {
      if (scan) this.scanForGap(stance, stanceGround, dir, scanned, distance);
      return;
    }
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
    const at = (lo + hi) / 2;
    // A un pie de cada lado: un salto (si no, es el hueco entre dos huellas de una escalera sin contrahuella, que se
    // salta) o una pendiente más empinada que maxSlope (la cara de una roca, una rampa).
    const before = this.heightAt(stance.x + dir.x * (at - this.toeFront), stance.z + dir.z * (at - this.toeFront), stanceGround);
    const tiltBefore = this.hit.normal.y;
    const after = this.heightAt(stance.x + dir.x * (at + this.toeFront), stance.z + dir.z * (at + this.toeFront), stanceGround);
    const jump = !this.passable(high - low) && !this.passable(after - before);
    // La pendiente, a la escala de un paso (los bultos de una piedra pequeña no cuentan): medio paso a cada lado. Es la
    // que verá al llegar (con ella frena antes; la media hasta `far` la diluía el llano de antes).
    let steep = false;
    if (!jump) {
      const span = STEEP_SPAN * this.config.stepLength;
      const back = this.heightAt(stance.x + dir.x * (at - span), stance.z + dir.z * (at - span), stanceGround);
      const upBack = this.hit.normal.y;
      const ahead = this.heightAt(stance.x + dir.x * (at + span), stance.z + dir.z * (at + span), stanceGround);
      const upAhead = this.hit.normal.y;
      steep = this.tooSteep(ahead - back, 2 * span, Math.max(tiltBefore, upAhead, upBack));
      // Una escalera (huellas planas) no: la lleva ella, y frenar antes la retrasaba.
      const tilted = Math.min(upBack, upAhead) < SLOPE_TILTED;
      this.aheadSlope = tilted && Number.isFinite(ahead - back) ? (ahead - back) / (2 * span) : 0;
    }
    // Ni lo uno ni lo otro: escalera o pendiente, que verá al llegar.
    if (!jump && !steep) return;
    this.aheadSlope = 0;
    const wallGround = Number.isFinite(high) ? high : low;
    if (steep) {
      // Al pie de la pendiente (o arriba, bajando): donde el suelo empieza a estar así de inclinado.
      const up = Math.cos((this.config.maxSlope * Math.PI) / 180);
      let flat = 0;
      let tilted = at;
      for (let k = 0; k < WALL_REFINE_STEPS; k++) {
        const mid = (flat + tilted) / 2;
        const h = this.heightAt(stance.x + dir.x * mid, stance.z + dir.z * mid, stanceGround);
        if (Number.isFinite(h) && this.hit.normal.y < up) tilted = mid;
        else flat = mid;
      }
      this.steepPoint.set(stance.x + dir.x * flat, stanceGround, stance.z + dir.z * flat);
      this.steepDirection.copy(dir);
      return;
    }
    // Hasta ese borde, también un hueco antes de él (la bisección puede dar con el más lejano de los dos).
    if (scan) this.scanForGap(stance, stanceGround, dir, scanned, at - this.toeFront);
    this.foundAt.set(stance.x + dir.x * at, wallGround, stance.z + dir.z * at);
    this.foundWall(this.foundAt, dir, low);
  }

  /**
   * Looks at the ground every `maxGapStep` from `from` to `to` m ahead of the stance foot, in the direction `dir` (see
   * GAP_SCAN_SPEED): at the first drop it can't step down, it finds the edge by bisection and remembers it (with the
   * gap behind it, if there is one).
   */
  private scanForGap(stance: Vector3, ground: number, dir: Vector3, from: number, to: number): void {
    const spacing = Math.max(this.config.maxGapStep, SAMPLE_SPACING * this.footLength);
    let lo = from;
    // Suelo que no se pisa: también el más empinado que maxSlope (el labio de una grieta entre rocas redondeadas).
    for (let t = from + spacing; t < to; t += spacing) {
      if (!this.offGround(stance.x + dir.x * t, stance.z + dir.z * t, ground)) {
        lo = t;
        continue;
      }
      let hi = t;
      for (let k = 0; k < WALL_REFINE_STEPS; k++) {
        const mid = (lo + hi) / 2;
        if (!this.offGround(stance.x + dir.x * mid, stance.z + dir.z * mid, ground)) lo = mid;
        else hi = mid;
      }
      const at = (lo + hi) / 2;
      this.foundAt.set(stance.x + dir.x * at, ground, stance.z + dir.z * at);
      this.foundWall(this.foundAt, dir, ground);
      return;
    }
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
    this.wallGap = this.gapAcross(w.x, w.z, n.x, n.z, ground);
    this.wallFar = this.gapFar;
    this.wallJump = this.wallGap;
    this.wallJumpFar = this.wallFar;
    if (!Number.isFinite(this.wallGap)) {
      this.wallJump = this.gapAcross(w.x, w.z, n.x, n.z, ground, JUMP_DROP * this.config.maxStepDown);
      this.wallJumpFar = this.gapFar;
      // Y si no, por donde va (proyectado a la normal, ver gapAhead): en una grieta curva entre rocas, la normal medida
      // sale torcida y por ella la otra orilla quedaba lejos; frenaba al borde y no saltaba.
      const c = direction.x * n.x + direction.z * n.z;
      const d = this.horizontal(direction);
      if (!Number.isFinite(this.wallJump) && c > JUMP_MIN_COS) {
        const along = this.gapAcross(w.x, w.z, d.x, d.z, ground, JUMP_DROP * this.config.maxStepDown);
        if (Number.isFinite(along)) {
          this.wallJump = along * c;
          this.wallJumpFar = this.gapFar;
        }
      }
    }
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
      return this.offGround(x, z, ground);
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
      // Más empinado que maxSlope (el labio de una grieta entre rocas redondeadas): ya del otro lado del borde.
      const firm = this.hit.normal.y >= this.steepCos;
      if (Math.abs(h - near) < this.edgeHeight && firm) {
        lo = t;
        continue;
      }
      if (this.passable(h - ground) && firm) return null;
      hi = t;
      break;
    }
    if (Number.isNaN(hi)) return null;
    for (let k = 0; k < WALL_REFINE_STEPS; k++) {
      const mid = (lo + hi) / 2;
      const h = this.heightAt(x0 + mid * n.x, z0 + mid * n.z, ground);
      // El primer cambio de nivel desde `near` (detrás puede haber más escalones; sin suelo, h = −∞).
      if (Math.abs(h - near) < this.edgeHeight && this.hit.normal.y >= this.steepCos) lo = mid;
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
    return this.offGround(x + nx * d, z + nz * d, ground);
  }

  /**
   * Standing at `position` (world) on ground at `ground`, about to set off in the horizontal unit direction `dir`:
   * looks for the edge of a gap up to `distance` m ahead (and remembers it, see `gapJump`). A few raycasts. Setting
   * off from right by the edge of a crevice, it saw it only with the first step, already over it.
   */
  lookBeforeSetting(position: Vector3, ground: number, dir: Vector3, distance: number): void {
    this.scanForGap(position, ground, this.horizontal(dir), 0, distance);
  }

  /**
   * From (`x`, `z`), in the horizontal unit direction `dir`, how far (m, up to `most`) there is ground it stands on from
   * ground at `ground` (see `offGround`), every half a foot: where it can land and brake after a jump.
   */
  firmRun(x: number, z: number, dir: Vector3, ground: number, most: number): number {
    const step = this.footLength / 2;
    let d = 0;
    while (d < most && !this.offGround(x + dir.x * (d + step), z + dir.z * (d + step), ground)) d += step;
    return Math.min(d, most);
  }

  /**
   * At (`x`, `z`) there is no ground it stands on, from ground at `ground`: a change of level it can't step, no ground,
   * or ground steeper than `maxSlope` (the lip of a crevice between rounded rocks, past the edge of its firm ground).
   */
  private offGround(x: number, z: number, ground: number): boolean {
    return !this.passable(this.heightAt(x, z, ground) - ground) || this.hit.normal.y < this.steepCos;
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
      return this.offGround(x, z, ground);
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
    const h = this.heightAt(this.wall.x + this.wallNormal.x * d, this.wall.z + this.wallNormal.z * d, ground);
    // Más empinado que maxSlope (el labio de una grieta): no se pisa, como si no hubiera suelo.
    return Number.isFinite(h) && this.hit.normal.y < this.steepCos ? Number.NEGATIVE_INFINITY : h;
  }

  /** Cosine of `maxSlope`: ground whose normal is less upright than this is too steep to stand on (−∞: no limit). */
  private get steepCos(): number {
    return this.config.maxSlope < 90 ? Math.cos((this.config.maxSlope * Math.PI) / 180) : Number.NEGATIVE_INFINITY;
  }

  /**
   * Ground that rises or falls `rise` over `run` m with normals (vertical component) of at least `up` is steeper than
   * `maxSlope`: by the heights and by the normals (a flight of stairs rises as much, but its treads are flat).
   */
  private tooSteep(rise: number, run: number, up: number): boolean {
    const max = this.config.maxSlope;
    if (!(max < 90) || !Number.isFinite(rise)) return false;
    const angle = (max * Math.PI) / 180;
    return Math.abs(rise) / run > Math.tan(angle) && up < Math.cos(angle);
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
    // Sobre suelo más empinado que maxSlope (el labio de una grieta entre dos rocas redondeadas): el perfil lo ve.
    if (probe && n.y < this.steepCos) return true;
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
