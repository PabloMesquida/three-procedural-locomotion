import { Matrix4, Quaternion, Vector3 } from 'three';

import { ArmController } from '../body/ArmController.ts';
import { BodyController, wrapAngle } from '../body/BodyController.ts';
import { PelvisController } from '../body/PelvisController.ts';
import { TorsoController } from '../body/TorsoController.ts';
import { TouchController, type TouchMotion } from '../body/TouchController.ts';
import { TwistController } from '../body/TwistController.ts';
import { worldPosition, worldQuaternion } from '../core/pose.ts';
import { LegIK } from '../ik/LegIK.ts';
import type { TwoBoneIKResult } from '../ik/TwoBoneIK.ts';
import type { HumanRig, Side } from '../rig/HumanRig.ts';
import { defaultFootPlacementConfig, FootPlacement, type FootPlacementConfig } from '../terrain/FootPlacement.ts';
import { createGroundHit, type GroundDetector } from '../terrain/GroundDetector.ts';
import type { SurfaceDetector } from '../terrain/SurfaceDetector.ts';
import { FootRoll } from './FootRoll.ts';
import { FootstepPlanner } from './FootstepPlanner.ts';
import { GaitController } from './GaitController.ts';
import { JumpController } from './JumpController.ts';
import { StairPlanner } from './StairPlanner.ts';
import { SmoothNoise } from '../core/noise.ts';
import { createFootTarget, effectiveSwingEnd, evaluateSwing, type FootTarget, swingArc } from './FootTarget.ts';
import { defaultLocomotionConfig, type LocomotionConfig } from './LocomotionConfig.ts';

const DEG = Math.PI / 180;
/**
 * Moment of the stance (fraction) with the knee most bent when taking the weight, and the one at which it
 * is straight again.
 */
const KNEE_LOADING_PEAK = 0.25;
const KNEE_LOADING_END = 0.6;
/**
 * Pre-swing: from this fraction of the stance the trailing knee bends before toe-off, up to PRE_SWING_BEND
 * degrees more.
 */
const PRE_SWING_START = 0.75;
const PRE_SWING_BEND = 30;
/**
 * Up to how many times `walkSpeed` the stance knee bend grows with speed (beyond that, it blends badly
 * with the transition to running).
 */
const MAX_KNEE_SPEED_FACTOR = 1;
/**
 * Hard reach limit of the legs (fraction of the length): almost straight when walking; when running, as
 * before.
 */
const WALK_MAX_REACH = 0.9995;
/**
 * Moment of the cycle (phase of the left foot) at which the maximum drop of the right side is requested;
 * with the lag of the spring it ends up at ≈ 0.2.
 */
const PELVIS_DROP_PEAK = 0.13;
/**
 * Lead (fraction of the cycle) of the pelvis rotation wave, which compensates for the small lag of its
 * spring.
 */
const PELVIS_ROTATION_LEAD = 0.03;
/**
 * Standing still, how far a foot can be ahead of or behind its neutral position without repositioning it
 * (× stepLength).
 */
const IDLE_STAGGER = 0.2;
/**
 * Speed (× walkSpeed) below which the body is considered stopped (≈ 0.01 m/s with the default one).
 * Relative, so that a character of a different size stops at the same moment.
 */
const IDLE_SPEED = 0.007;
/** Fraction of walkSpeed from which the pelvis follows the gait wave fully (below it, it fades out). */
const PELVIS_WAVE_SPEED = 0.5;
/**
 * Moment of the cycle (phase of the left foot) at which the maximum forward tilt is requested (and half a
 * cycle later); with the lag of the spring it ends up at each heel strike, as in the CMU captures.
 */
const PELVIS_TILT_PEAK = -0.03;
/**
 * Swing progress from which the hips start lowering so that the foot about to land reaches the ground.
 * Earlier, the stance knee would bend in the middle of the step; much later, the hips drop abruptly at the
 * end (measured: 0.6 balances both).
 */
const LANDING_ANTICIPATION_START = 0.6;
const RUN_MAX_REACH = 0.97;
/** Foot velocity at toe-off (m/s) above which it is considered a jump in position, not a movement. */
const MAX_LIFTOFF_SPEED = 10;
/**
 * Maximum velocity at which the foot leaves at toe-off when walking, in swing paths per unit of progress
 * (1 = the average velocity of the swing). In motion capture, ≈ 0.8.
 */
const MAX_LIFTOFF_TANGENT = 0.8;
const SIDES: readonly Side[] = ['left', 'right'];
/** Minimum distance between the toes and the ground during the swing (m). */
/** Samples (in time) of the swing to compute the height of the arc. */
const CLEARANCE_SAMPLES = 12;
/** Time to tuck the feet (and extend the hips) after take-off (s). */
const AIR_TUCK_TIME = 0.15;
/** Minimum time to go from a flat foot to full push-off with the toes (s). */
const TOE_OFF_RAMP = 0.1;
/**
 * Walking down a step, fraction of the swing during which the foot moves forward without dropping: at least
 * MIN_DROP_DELAY (mocap of stairs, CMU: at mid-swing it hasn't started dropping yet; at 75 %, it has dropped
 * 60 %) and more if the back of the heel hasn't passed the edge by then, up to MAX_DROP_DELAY.
 */
const MIN_DROP_DELAY = 0.45;
const MAX_DROP_DELAY = 0.8;
/**
 * Extra forward lean requested for the trunk on stairs, per unit of slope (degrees; rise / run): going up
 * and going down. Measured on the trunk (pelvis → neck) it gives what the mocap of stairs shows (CMU),
 * relative to walking on the flat: ≈ +7° going up and ≈ +2.5° going down on stairs of slope 0.6 (17 × 28
 * cm); the spine takes only part of the requested lean.
 */
const STAIR_LEAN_UP = 25;
const STAIR_LEAN_DOWN = 12;
/** Time constant with which the lean follows the slope (s): the slope of the line changes in corners. */
const STAIR_LEAN_TIME = 0.3;
/**
 * Going down a step, the foot lands on the ball with the heel raised this much (rad) and then lowers the heel,
 * as a person does: the ankle reaches further down and the stance knee bends less.
 */
const STAIR_TOE_STRIKE = 20 * DEG;
/**
 * Going up stairs, the trailing foot can raise its heel up to this angle (rad) to push off: the hips stay
 * higher and the knee of the leading leg bends less when it lands (mocap of stairs, CMU: ≈ 47°; with this
 * limit, ≈ 53°, against ≈ 66° without pushing off). More doesn't help: the ankle then moves backwards.
 */
const STAIR_MAX_HEEL_LIFT = 70 * DEG;
/** Fraction of the reach limit of the leg the pushing foot is placed within. */
const PUSH_OFF_MARGIN = 0.995;
/** How fast the speed limit of the stairs is released when they end (× acceleration, per second). */
const STAIR_RELEASE = 0.4;
/** Heel lift at toe-off (degrees) from which `walkLandingLead` applies in full. */
const FULL_HEEL_LIFT = 45;
/** Fraction of the swing over which the toes, bent at toe-off, return to their rest pose. */
const TOE_RELAX = 0.3;
/** Time to flatten the feet (remove the heel/toe roll) when standing still (s). */
const IDLE_SETTLE_TIME = 0.2;
/**
 * Standing still, how often it checks again whether the feet are still settled even if the root hasn't
 * moved (s): that way changes in the configuration or in the terrain under the feet are noticed.
 */
const IDLE_RECHECK_TIME = 0.25;
/** Fraction of walkSpeed below which the arms gradually go to the standing pose. */
const IDLE_ARMS_SPEED = 0.5;
/**
 * When walking, the arm swings further backward than forward: the center of the swing is this fraction of
 * its amplitude behind the vertical (CMU motion capture: ≈ 0.4; Murray 1967, a little less).
 */
const ARM_SWING_BACK = 0.3;
/**
 * When running, with the elbows bent, the arm is almost always behind the body (mocap: ≈ 1.4 × the
 * amplitude).
 */
const RUN_ARM_SWING_BACK = 0.7;
/** Maximum of the increase of the arm swing with speed (×armSwing). */
const MAX_ARM_SWING_GAIN = 1.4;
/** Running blend from which it doesn't touch (and lets go): the hand doesn't rest on things while running. */
const TOUCH_MAX_RUN_BLEND = 0.3;
/**
 * Pivot of the planted foot: if the body turns more than PIVOT_TWIST relative to it (e.g. the foot that
 * was already on the ground when a turn starts), the foot rotates on the toes by however much exceeds that
 * limit, instead of twisting the leg. It starts smoothly PIVOT_SOFTNESS before the limit (rad). While
 * turning, only once the body has passed over the foot: if the foot is ahead (it landed pointing where the
 * body will face), the body catches up with it on its own.
 */
const PIVOT_TWIST = 20 * DEG;
const PIVOT_SOFTNESS = 8 * DEG;
/** Maximum speed (rad/s) at which the planted foot pivots towards what the twist requires. */
const MAX_PIVOT_RATE = 360 * DEG;
/**
 * Minimum distance (× stepLength) from the ankle in the air to the center of the planted foot (see
 * swingDetour).
 */
const SWING_CLEARANCE = 0.22;
/**
 * Maximum deviation of the swing (× stepLength): going around the planted foot doesn't need more, and the
 * leg can't reach.
 */
const MAX_DETOUR = 0.2;
/**
 * Rotation of the foot during the swing (rad) from which the step goes around the planted foot (see
 * swingDetour).
 */
const DETOUR_MIN_TURN = 45 * DEG;
/**
 * Leg twist allowed when pivoting to turn around, before the planted foot rotates (rad; a person, ~45–55°).
 */
const PIVOT_TWIST_TURNING = 45 * DEG;
/**
 * Replan the landing of a foot in the air (see retargetSwing): only in the first part of the swing and if
 * the requested speed changed by at least this much (× walkSpeed).
 */
const RETARGET_MAX_PROGRESS = 0.4;
const RETARGET_SPEED_CHANGE = 0.2;
/** The most a foot lands pointing ahead of the body when turning (rad). */
const MAX_LANDING_LEAD = 30 * DEG;
/**
 * Turn rate (rad/s) below which the body is considered not to be turning (the pivot works in both
 * directions).
 */
const PIVOT_TURNING = 10 * DEG;
const UP = new Vector3(0, 1, 0);
/** Difference relative to the step length below which two measurements are considered equal. */
const TIE_TOLERANCE = 1e-9;

interface LegRuntime {
  ik: LegIK;
  roll: FootRoll;
  /** Knee pole relative to the thigh, in root space. */
  poleOffsetLocal: Vector3;
  result: TwoBoneIKResult | null;
}

/**
 * Orchestrates the locomotion every frame:
 *
 *   BodyController (speed and advance of the body)
 *   → GaitController (when: phase, states, take-offs/landings)
 *   → FootstepPlanner (where each step lands) → swing of the feet
 *   → BodyController (weight distribution → lateral shift)
 *   → PelvisController (position, orientation and height of the hips) → leg IK
 *   → TorsoController (spine, chest and head) → ArmController (arms)
 */
export class LocomotionController {
  readonly config: LocomotionConfig;
  readonly planner: FootstepPlanner;
  readonly gait: GaitController;
  readonly pelvis: PelvisController;
  readonly torso: TorsoController;
  readonly arms: ArmController;
  /** Touching surfaces with the hand (columns, walls, railings). */
  readonly touch: TouchController;
  /** Surfaces that can be touched (null = none: it only touches with `touch.touch`). */
  surfaces: SurfaceDetector | null = null;
  /** Twist bones of arms and legs (if the mapping has them). */
  readonly twist: TwistController;
  readonly jumping: JumpController;
  readonly body: BodyController;
  readonly feet: Record<Side, FootTarget>;
  /** Stairs and steps: where the feet land and the height the body follows (see StairPlanner). */
  readonly stairs: StairPlanner;

  /** Desired crouch (0 = standing, 1 = fully crouched). */
  targetCrouch = 0;
  /** Agachado actual: sigue al deseado a velocidad limitada (config.crouchRate). */
  crouch = 0;

  private readonly rig: HumanRig;
  private readonly detector: GroundDetector;
  /** Foot placement config (shared by both feet), synced with `config` every update. */
  private readonly placementConfig: FootPlacementConfig = { ...defaultFootPlacementConfig };
  private readonly hipShift = new Vector3();
  /** Pose and velocity of each foot at take-off in a jump; `previous`: position in the previous frame. */
  private readonly air: Record<Side, AirFoot> = { left: createAirFoot(), right: createAirFoot() };
  private airTime = 0;
  /** Going idle: progress (0→1) of flattening the feet from their pose when stopping. */
  private settleBlend = 1;
  private readonly settleFrom: Record<Side, { position: Vector3; rotation: Quaternion }> = {
    left: { position: new Vector3(), rotation: new Quaternion() },
    right: { position: new Vector3(), rotation: new Quaternion() },
  };
  /**
   * Standing still: last check of whether the feet are settled (raycasts), with the root matrix it was done
   * with and the time since then. While the root doesn't move, it still holds.
   */
  private readonly settleCheck = { valid: false, settled: false, age: 0, root: new Matrix4() };
  private readonly settleOffset = new Vector3();
  /** Desired speed with which the landing of each foot in the air was planned (see retargetSwing). */
  private readonly swingIntent: Record<Side, { speed: number; replanned: boolean }> = {
    left: { speed: 0, replanned: true },
    right: { speed: 0, replanned: true },
  };
  /** Where each foot is going to land, as it is following it now (see effectiveSwingEnd). */
  private readonly landingEnds: Record<Side, Vector3> = { left: new Vector3(), right: new Vector3() };
  /** Whether the current stance of each foot started with a landing (and not by standing still). */
  private readonly landed: Record<Side, boolean> = { left: false, right: false };
  /** Pivot applied to each planted foot (rad, see pivotStanceFoot). */
  private readonly pivotApplied: Record<Side, number> = { left: 0, right: 0 };
  private readonly shiftMatrix = new Matrix4();
  /** Heel lift of the jump push-off applied to each foot (0–1). */
  private readonly toeOffLevel: Record<Side, number> = { left: 0, right: 0 };
  /** Toe bend of each foot (rad): the one that keeps the toes on the ground with the heel raised. */
  private readonly toeBend: Record<Side, number> = { left: 0, right: 0 };
  /** Toe bend at toe-off: it goes back to 0 in the air. */
  private readonly liftoffToeBend: Record<Side, number> = { left: 0, right: 0 };
  /** Offset of the hips at take-off (m): it smoothly goes back to 0 in the air. */
  private airStartOffset = 0;
  /** Pose of each foot's ankle in the previous frame (for its velocity at toe-off). */
  private readonly footPrevious: Record<Side, Vector3> = { left: new Vector3(), right: new Vector3() };
  /** Duration of the last frame with the feet on the ground (s); 0 = there is no valid previous frame. */
  private lastFootDt = 0;
  /** Speed limit of the stairs (m/s; Infinity = none), released gradually (see stairSpeedLimit). */
  private stairLimit = Number.POSITIVE_INFINITY;
  /** Extra lean of the trunk on stairs (rad), following the slope (see STAIR_LEAN_UP). */
  private stairLean = 0;
  /** Heel lift of each foot pushing off up some stairs (rad, 0 = none; see pushOffStairs). */
  private readonly pushOff: Record<Side, number> = { left: 0, right: 0 };
  /** Highest ankle of each foot for the reach limit of the hips (see pushOffStairs). */
  private readonly reachAnkles: Record<Side, Vector3> = { left: new Vector3(), right: new Vector3() };
  private readonly pushPosition = new Vector3();
  private readonly pushRotation = new Quaternion();

  /** In the air: how far the legs have already extended towards the landing (0–1). */
  private landingPrep = 0;
  private readonly legs: Record<Side, LegRuntime>;
  private readonly qRoot = new Quaternion();
  private readonly tmp = new Vector3();
  private readonly pole = new Vector3();
  private readonly displacement = new Vector3();
  private readonly sampleHit = createGroundHit();
  private readonly samplePos = new Vector3();
  private readonly sampleRot = new Quaternion();
  private readonly sampleAxis = new Vector3();
  private readonly tipDirection = new Vector3();
  private readonly solePoints = [new Vector3(), new Vector3(), new Vector3()];
  private readonly landingVelocity = new Vector3();
  private readonly midStanceDisplacement = new Vector3();
  private readonly midStanceVelocity = new Vector3();
  private readonly qPivot = new Quaternion();
  /** Heading of each foot relative to that of the body at rest (rad): reference for the twist of the leg. */
  private readonly restFootYaw: Record<Side, number> = { left: 0, right: 0 };
  private readonly contacts: Record<Side, Vector3> = { left: new Vector3(), right: new Vector3() };
  /** Natural variation: deterministic noise from the character's seed, and its clock (s). */
  private readonly noise: SmoothNoise;
  private noiseTime = 0;
  private readonly variationNow = { lean: 0, headYaw: 0, headPitch: 0, armLeft: 1, armRight: 1 };

  constructor(
    rig: HumanRig,
    forward: Vector3,
    detector: GroundDetector,
    config: LocomotionConfig = { ...defaultLocomotionConfig }, // a copy: each character has its own config
    seed = 1,
  ) {
    this.noise = new SmoothNoise(seed);
    this.rig = rig;
    this.detector = detector;
    this.config = config;
    this.syncPlacementConfig();

    rig.root.updateWorldMatrix(true, true);
    const rootQInv = rig.root.getWorldQuaternion(new Quaternion()).invert();
    this.body = new BodyController(rig.root, forward, detector, config);

    const placements = {
      left: new FootPlacement(detector, rig.root, rig.left, this.placementConfig),
      right: new FootPlacement(detector, rig.root, rig.right, this.placementConfig),
    };
    this.planner = new FootstepPlanner(rig, placements, config, forward);
    this.gait = new GaitController(config);
    this.pelvis = new PelvisController(rig, config);
    this.torso = new TorsoController(rig, config);
    this.arms = new ArmController(rig, config);
    this.touch = new TouchController(rig, config);
    this.twist = new TwistController(rig);
    this.jumping = new JumpController(config);

    const makeLeg = (side: Side): LegRuntime => {
      const leg = rig[side];
      const thigh = leg.thigh.getWorldPosition(new Vector3());
      const poleWorld = leg.shin.getWorldPosition(new Vector3()).addScaledVector(forward, config.kneePoleDistance);
      return {
        ik: new LegIK(leg, forward),
        roll: new FootRoll(leg, rig.root),
        poleOffsetLocal: poleWorld.sub(thigh).applyQuaternion(rootQInv),
        result: null,
      };
    };
    this.legs = { left: makeLeg('left'), right: makeLeg('right') };
    this.feet = { left: createFootTarget('left'), right: createFootTarget('right') };

    // Largo del pie (talón bajo el tobillo → articulación de los dedos), la media de los dos.
    const footLength = (side: Side): number => {
      const roll = this.legs[side].roll;
      return Math.hypot(roll.toeLocal.x - roll.heelLocal.x, roll.toeLocal.y - roll.heelLocal.y, roll.toeLocal.z - roll.heelLocal.z);
    };
    this.stairs = new StairPlanner(detector, config, (footLength('left') + footLength('right')) / 2);
    this.body.groundLine = (position, ground) => this.stairs.groundHeight(position, ground);
  }

  /** Velocidad deseada (m/s), entre 0 y config.runSpeed. */
  get targetSpeed(): number {
    return this.body.targetSpeed;
  }

  set targetSpeed(value: number) {
    this.body.targetSpeed = value;
  }

  /** Desired heading (rad, relative to the initial orientation; positive = left). */
  get targetHeading(): number {
    return this.body.targetHeading;
  }

  set targetHeading(value: number) {
    this.body.targetHeading = value;
  }

  /** Velocidad actual (m/s). */
  get speed(): number {
    return this.body.state.speed;
  }

  /** Velocidad actual (world, m/s). */
  get velocity(): Vector3 {
    return this.body.state.velocity;
  }

  /**
   * Moves the character by `offset` (world) without changing its motion: the root and everything the
   * locomotion stores in world space (feet, trajectories, jump poses, history of the hips).
   * The caller decides the ground at the new place (see `ProceduralHuman.shiftOrigin`).
   */
  shift(offset: Vector3): void {
    this.body.shift(offset);
    this.torso.shift(offset);
    this.touch.shift(offset);
    this.stairs.shift(offset);
    for (const side of SIDES) {
      const foot = this.feet[side];
      foot.position.add(offset);
      foot.planted.add(offset);
      foot.swing.start.add(offset);
      foot.swing.end.add(offset);
      foot.swing.landing.add(offset);
      foot.swing.previousEnd.add(offset);
      this.air[side].start.add(offset);
      this.air[side].previous.add(offset);
      this.settleFrom[side].position.add(offset);
      this.footPrevious[side].add(offset);
    }
    // La comprobación de pies recolocados sigue valiendo en el sitio nuevo (no repite raycasts).
    this.settleCheck.root.premultiply(this.shiftMatrix.makeTranslation(offset.x, offset.y, offset.z));
  }

  /** Stops the character and rests both feet in their neutral position (keeps the desired crouch). */
  reset(): void {
    this.syncPlacementConfig();
    this.planner.syncStepWidth();
    this.crouch = Math.min(Math.max(this.targetCrouch, 0), 1);
    this.jumping.reset();
    this.landingPrep = 0;
    this.settleBlend = 1;
    this.settleCheck.valid = false;
    this.lastFootDt = 0;
    this.stairs.reset();
    this.stairLimit = Number.POSITIVE_INFINITY;
    this.stairLean = 0;
    this.pivotApplied.left = 0;
    this.pivotApplied.right = 0;
    this.body.reset();
    this.pelvis.reset();
    this.pelvis.forgetMotion();
    this.torso.reset();
    this.arms.reset();
    this.touch.reset();
    this.twist.reset();
    this.gait.reset();
    for (const side of SIDES) {
      this.toeBend[side] = 0;
      this.liftoffToeBend[side] = 0;
      this.legs[side].roll.bendToe(0);
    }
    this.rig.root.updateWorldMatrix(true, true);

    for (const side of SIDES) {
      const foot = this.feet[side];
      this.displacement.set(0, 0, 0);
      this.planner.planLanding(side, this.displacement, this.velocity, 0, foot.planted, foot.plantedRotation);
      foot.position.copy(foot.planted);
      foot.rotation.copy(foot.plantedRotation);
      foot.phase = 'PLANTED';
      foot.swing.t = 0;
      foot.steps = 0;
      // Orientación del pie respecto al cuerpo en reposo: torsión 0.
      this.restFootYaw[side] = wrapAngle(this.footYaw(side, foot.plantedRotation) - this.bodyYaw());
    }
  }

  /** World heading (rad, about +Y from +Z) of the heel → toe direction of a foot with that rotation. */
  private footYaw(side: Side, rotation: Quaternion): number {
    const roll = this.legs[side].roll;
    const d = this.tmp.subVectors(roll.toeLocal, roll.heelLocal).applyQuaternion(rotation);
    return Math.atan2(d.x, d.z);
  }

  /** World heading (rad, about +Y from +Z) the body is moving towards. */
  private bodyYaw(): number {
    const f = this.body.state.forward;
    return Math.atan2(f.x, f.z);
  }

  /**
   * Pivot of the planted foot on the toes (see PIVOT_TWIST): rotates the base pose of the foot (`position`,
   * `rotation`) about the vertical axis through the toes, which stays fixed.
   */
  private pivotStanceFoot(side: Side, position: Vector3, rotation: Quaternion, dt?: number): void {
    // Con `dt`, el pivote avanza hacia lo que pide la torsión, a MAX_PIVOT_RATE como mucho: un pie
    // que aterriza con el cuerpo ya pasado (estaba en el aire cuando empezó el giro) no salta de golpe.
    if (dt !== undefined) {
      const twist = wrapAngle(this.bodyYaw() + this.restFootYaw[side] - this.footYaw(side, rotation));
      const turning = this.body.state.angularVelocity;
      // Pivotando para dar la vuelta (más giro por paso, ver MoveToController), la cadera admite más
      // torsión antes de que el pie gire en el suelo, como en una persona.
      const pivoting = clamp((this.gait.turnPerStepScale - 1) / 2, 0, 1);
      const excess = Math.abs(twist) - (PIVOT_TWIST + (PIVOT_TWIST_TURNING - PIVOT_TWIST) * pivoting);
      const wanted =
        (Math.abs(turning) > PIVOT_TURNING && Math.sign(twist) !== Math.sign(turning)) || excess <= -PIVOT_SOFTNESS
          ? 0
          : Math.sign(twist) * (excess >= PIVOT_SOFTNESS ? excess : (excess + PIVOT_SOFTNESS) ** 2 / (4 * PIVOT_SOFTNESS));
      const step = MAX_PIVOT_RATE * dt;
      this.pivotApplied[side] += clamp(wanted - this.pivotApplied[side], -step, step);
    }
    const amount = this.pivotApplied[side];
    if (amount === 0) return;
    const q = this.qPivot.setFromAxisAngle(UP, amount);
    const toe = this.tmp.copy(this.legs[side].roll.toeLocal).applyQuaternion(rotation).add(position);
    position.sub(toe).applyQuaternion(q).add(toe);
    rotation.premultiply(q);
  }

  /** Requests a jump. Returns false if it isn't possible (already jumping). */
  requestJump(): boolean {
    if (this.body.state.airborne) return false;
    return this.jumping.request();
  }

  /**
   * Natural variation: smooth, slow signals (they change every few seconds) that slightly alter the cadence
   * (±3 %), the lean of the trunk (±1.5°), the gaze (±4° of turn, ±2° up/down) and the swing of each arm
   * separately (±12 %), scaled by `variation`. Deterministic: the same seed repeats exactly the same motion.
   */
  private updateVariation(dt: number): void {
    const amount = this.config.variation;
    this.noiseTime += dt;
    const t = this.noiseTime;
    const n = (channel: number, rate: number): number => (amount > 0 ? amount * this.noise.sample(channel, t * rate) : 0);
    this.gait.frequencyScale = 1 + 0.03 * n(0, 0.4);
    const v = this.variationNow;
    v.lean = 1.5 * DEG * n(1, 0.25);
    v.headYaw = 4 * DEG * n(2, 0.3);
    v.headPitch = 2 * DEG * n(3, 0.35);
    v.armLeft = 1 + 0.12 * n(4, 0.35);
    v.armRight = 1 + 0.12 * n(5, 0.35);
  }

  /** Returns the rig to the rest pose (when leaving this mode). */
  restPose(): void {
    this.pelvis.reset();
    this.pelvis.forgetMotion();
    this.torso.reset();
    this.arms.reset();
    this.touch.reset();
    this.twist.reset();
    for (const side of SIDES) {
      this.legs[side].ik.resetToRest();
      this.legs[side].result = null;
      this.toeBend[side] = 0;
      this.liftoffToeBend[side] = 0;
      this.legs[side].roll.bendToe(0);
    }
  }

  update(dt: number): void {
    const { feet, rig } = this;
    this.updateVariation(dt);
    this.stairs.update(dt);
    this.syncPlacementConfig();
    this.planner.syncStepWidth();

    // 0. Agachado: el nivel actual sigue al deseado; agachado se va más despacio.
    const crouchTarget = Math.min(Math.max(this.targetCrouch, 0), 1);
    const crouchStep = this.config.crouchRate * dt;
    this.crouch += Math.max(-crouchStep, Math.min(crouchStep, crouchTarget - this.crouch));
    const k = smoothstep(this.crouch);
    this.body.speedLimit = Math.min(this.config.runSpeed + (this.config.crouchMaxSpeed - this.config.runSpeed) * k, this.stairSpeedLimit(dt));

    // 1–2. Cuerpo: velocidad y avance de la raíz sobre el suelo. Las caderas vuelven a su pose de
    //      reposo sin recalcular matrices: el cuerpo actualiza después todo el esqueleto.
    this.pelvis.reset(false);
    this.body.update(dt);
    worldQuaternion(rig.root, this.qRoot);

    // 2b. Salto: despegue (velocidad vertical) y aterrizaje.
    //     El frame del despegue aún se resuelve apoyado (final de la preparación);
    //     el cuerpo empieza a subir desde el siguiente.
    const jumpEvent = this.jumping.update(dt, this.body.state);
    if (jumpEvent === 'liftoff') {
      this.body.jump(this.config.jumpSpeed, this.jumping.liftoffElapsed);
    } else if (jumpEvent === 'landed') {
      this.land();
    }
    const inAir = this.body.state.airborne && jumpEvent !== 'liftoff';

    if (inAir) {
      // 3–4 (en el aire). Pies recogidos; antes de tocar el suelo se extienden hacia el aterrizaje.
      this.updateAirFeet(dt);
      this.lastFootDt = 0;
    } else {
      // 3. Gait: modo, fase y eventos de despegue/aterrizaje.
      this.updateGaitMode(dt);
      const angularSpeed = Math.abs(this.body.state.angularVelocity);
      for (const event of this.gait.update(dt, this.speed, angularSpeed)) {
        const foot = feet[event.side];
        if (event.type === 'touchdown') {
          foot.planted.copy(foot.swing.landing);
          foot.plantedRotation.copy(foot.swing.landingRotation);
          this.pivotApplied[event.side] = 0;
          this.landed[event.side] = true;
          foot.steps++;
          // Apoyo según la mayor de la velocidad de ahora y la que habrá al despegar: acelerando a
          // través de la transición, un pie que aterriza caminando pero despegará corriendo no se queda
          // apoyado de más; frenando, tampoco uno colocado para la velocidad de ahora (en ambos casos la
          // pierna de atrás se estiraba y las caderas se hundían).
          this.body.predict(this.gait.stanceDuration(this.speed, angularSpeed), this.midStanceDisplacement, this.midStanceVelocity);
          const fastest = Math.max(this.speed, this.midStanceVelocity.length());
          this.gait.duty[event.side] = this.gait.dutyFor(this.gait.runFactor(fastest));
        } else {
          this.beginSwing(foot, dt);
        }
      }

      if (this.settleBlend < 1) this.settleBlend = Math.min(this.settleBlend + dt / IDLE_SETTLE_TIME, 1);

      // 4. Pies: pose según el estado del gait.
      //    PLANT: aterriza de talón y baja la punta · PLANTED: plano
      //    LIFT: levanta el talón sobre la punta  · SWING: trayectoria en el aire
      for (const side of SIDES) {
        const foot = feet[side];
        const roll = this.legs[side].roll;
        this.footPrevious[side].copy(foot.position);
        foot.phase = this.gait.footState(side);
        if (foot.phase === 'SWING') {
          this.toeOffLevel[side] = 0;
          foot.swing.t = this.gait.swingProgress(side);
          this.retargetSwing(foot);
          evaluateSwing(foot.swing, foot.swing.t, foot.swing.height, foot.position, foot.rotation, 1 - this.gait.blend);
          // Los dedos, doblados al despegar, vuelven a su reposo al principio del swing.
          this.toeBend[side] = this.liftoffToeBend[side] * (1 - smoothstep(foot.swing.t / TOE_RELAX));
          continue;
        }
        foot.position.copy(foot.planted);
        foot.rotation.copy(foot.plantedRotation);
        this.pivotStanceFoot(side, foot.position, foot.rotation, dt);
        if (this.settleBlend < 1) {
          // Recién parado: del pie rodado al apoyado plano.
          const s = smoothstep(this.settleBlend);
          foot.position.lerpVectors(this.settleFrom[side].position, foot.position, s);
          foot.rotation.slerpQuaternions(this.settleFrom[side].rotation, this.qPivot.copy(foot.rotation), s);
        }
        const k = smoothstep(this.gait.stateProgress(side));
        if (foot.phase !== 'LIFT') this.pushOff[side] = 0;
        this.toeBend[side] = foot.phase === 'LIFT' ? Math.max(this.heelLift * this.liftCurve(this.gait.stateProgress(side)), this.pushOff[side]) : 0;
        if (foot.phase === 'LIFT') roll.roll(foot.position, foot.rotation, 'toe', this.toeBend[side]);
        // Solo un pie que acaba de aterrizar baja la punta desde el talón: al echar a andar desde parado,
        // la fase puede reanudarse dentro de la ventana del PLANT con el pie ya plano (saltaba un frame).
        // Y desde el ángulo con el que terminó el swing (planificado corriendo y aterrizando ya caminando,
        // el de ahora es otro y la punta saltaba).
        if (foot.phase === 'PLANT' && this.landed[side]) strikeRoll(roll, foot.position, foot.rotation, foot.swing.heelStrike * (1 - k));
        // Salto: impulso final con la punta (los pies en LIFT ya tienen el talón levantado).
        // Cada pie lo alcanza progresivamente desde que apoya (uno que aterriza tarde no salta de pose).
        const toeOff = Math.min(this.jumping.toeOff(), this.toeOffLevel[side] + dt / TOE_OFF_RAMP);
        this.toeOffLevel[side] = toeOff;
        if (toeOff > 0 && foot.phase !== 'LIFT') {
          this.toeBend[side] = ((this.config.jumpToeOff * Math.PI) / 180) * toeOff;
          roll.roll(foot.position, foot.rotation, 'toe', this.toeBend[side]);
        }
        this.liftoffToeBend[side] = this.toeBend[side];
      }
      this.lastFootDt = dt;
    }

    // 5. Peso: el cuerpo se desplaza hacia el pie (o pies) de apoyo (en el aire, ninguno).
    //    Punto de apoyo de cada pie = contacto del talón con el suelo en su pose apoyada.
    for (const side of SIDES) {
      const foot = feet[side];
      this.contacts[side].copy(this.legs[side].roll.heelLocal).applyQuaternion(foot.plantedRotation).add(foot.planted);
    }
    this.body.updateWeightShift(dt, this.contacts, {
      left: inAir ? 0 : this.gait.supportWeight('left'),
      right: inAir ? 0 : this.gait.supportWeight('right'),
    });

    // 6. Caderas: desplazadas hacia el apoyo, orientadas según los pasos
    //    y lo bastante bajas para alcanzar ambos pies.
    //    Agachado: más bajas, algo hacia atrás (equilibrio) e inclinadas hacia delante.
    //    Salto: se hunden al prepararse y al amortiguar; en el aire las piernas no
    //    limitan la altura hasta que se preparan para aterrizar.
    const bodyState = this.body.state;
    const cfg = this.config;
    this.hipShift.copy(bodyState.shift).addScaledVector(bodyState.forward, -k * cfg.crouchHipBack);
    const maxReach = WALK_MAX_REACH + (RUN_MAX_REACH - WALK_MAX_REACH) * this.gait.blend;
    for (const side of SIDES) {
      const reachAnkle = this.reachAnkles[side].copy(feet[side].position);
      if (this.canPushOff(side)) this.pushOffPose(feet[side], STAIR_MAX_HEEL_LIFT, reachAnkle, this.pushRotation);
    }
    this.pelvis.update({ left: feet.left.position, right: feet.right.position }, this.hipShift, {
      forward: bodyState.forward,
      supportWeights: bodyState.supportWeights,
      speed: bodyState.speed,
      targetHeight: (inAir ? this.airHeight() : this.runHeight()) - k * cfg.crouchDepth + this.jumping.hipOffset(),
      standHeight: this.planner.standHeight(),
      extraPitch: (k * cfg.crouchPelvisTilt * Math.PI) / 180,
      reachWeights: inAir
        ? { left: this.landingPrep, right: this.landingPrep }
        : { left: this.reachWeight('left'), right: this.reachWeight('right') },
      // Rodillas de apoyo (solo al caminar; corriendo mandan los límites de alcance como antes).
      kneeBend: { left: this.stanceKnee('left'), right: this.stanceKnee('right') },
      kneeWeights: inAir
        ? { left: 0, right: 0 }
        : {
            left: this.gait.supportWeight('left') * (1 - this.gait.blend),
            right: this.gait.supportWeight('right') * (1 - this.gait.blend),
          },
      maxReach,
      reachAnkles: this.reachAnkles,
      // Corriendo, las piernas empiezan y dejan de limitar de golpe (despegue estirado, aterrizaje).
      limitRounding: this.gait.blend,
      dt,
      obliquity: inAir ? 0 : this.pelvisObliquity(),
      rotation: this.gait.mode === 'idle' ? undefined : this.pelvisRotation(),
      tilt: inAir ? 0 : this.pelvisTiltWave(),
      landings: inAir
        ? undefined
        : {
            left: effectiveSwingEnd(feet.left.swing, feet.left.swing.t, this.landingEnds.left),
            right: effectiveSwingEnd(feet.right.swing, feet.right.swing.t, this.landingEnds.right),
          },
      landingWeights: { left: this.landingAnticipation('left'), right: this.landingAnticipation('right') },
    });
    if (jumpEvent === 'liftoff') this.beginAir(dt);
    for (const side of SIDES) this.air[side].previous.copy(feet[side].position);
    this.pushOffStairs(maxReach);

    // 7. IK de cada pierna.
    for (const side of SIDES) {
      const leg = this.legs[side];
      const foot = feet[side];
      worldPosition(leg.ik.leg.thigh, this.pole);
      this.pole.add(this.tmp.copy(leg.poleOffsetLocal).applyQuaternion(this.qRoot));
      leg.result = leg.ik.solve(foot.position, this.pole, foot.rotation);
      // En el aire tras un salto, los dedos vuelven a su reposo.
      if (inAir) this.toeBend[side] *= Math.exp(-dt / (TOE_RELAX * AIR_TUCK_TIME));
      leg.roll.bendToe(this.toeBend[side]);
    }
    // 8. Torso: contrarrotación, compensación, inclinación y cabeza estable.
    //    En escaleras, algo más inclinado (más subiendo que bajando).
    const slope = Math.min(Math.max(this.stairs.slope(bodyState.position, bodyState.forward), -1), 1);
    const stairLean = (slope > 0 ? STAIR_LEAN_UP * slope : -STAIR_LEAN_DOWN * slope) * DEG;
    this.stairLean += (stairLean - this.stairLean) * (1 - Math.exp(-dt / STAIR_LEAN_TIME));
    this.torso.update({
      forward: bodyState.forward,
      pelvis: this.pelvis.angles,
      acceleration: bodyState.acceleration,
      turnRemaining: wrapAngle(this.body.targetHeading - bodyState.heading),
      speed: bodyState.speed,
      angularVelocity: bodyState.angularVelocity,
      dt,
      extraLean: ((cfg.walkLean + (cfg.runLean - cfg.walkLean) * this.gait.blend + k * cfg.crouchLean) * Math.PI) / 180 + this.jumping.lean() + this.variationNow.lean + this.stairLean,
      airborne: bodyState.airborne,
      headOffset: { yaw: this.variationNow.headYaw, pitch: this.variationNow.headPitch },
    });

    // 9. Brazos: relajados y en oposición a las piernas.
    const c = cfg;
    const mix = (walk: number, run: number): number => this.gait.mix(walk, run);
    // Parado, los brazos cuelgan más relajados; al echar a andar pasan a la pose de caminar.
    const idle = 1 - smoothstep(bodyState.speed / (IDLE_ARMS_SPEED * c.walkSpeed));
    const relax = (moving: number, still: number): number => moving + (still - moving) * idle;
    // Caminando, el balanceo crece con la velocidad más que el paso (en el mocap, casi en proporción
    // a la velocidad): el paso ya aporta √v (la separación de los pies respecto a la de walkSpeed),
    // y esto, otra √v.
    const walkSwing = c.armSwing * Math.min(Math.sqrt(bodyState.speed / c.walkSpeed), MAX_ARM_SWING_GAIN);
    // Tocar: caminando o parado, con los pies en el suelo.
    this.touch.update(this.touchMotion(dt), this.surfaces);
    this.arms.update({
      forward: bodyState.forward,
      feetAhead: this.tmp.subVectors(feet.right.position, feet.left.position).dot(bodyState.forward),
      stepLength: mix(c.walkSpeed / c.stepFrequency, c.runStepLength),
      dt,
      acceleration: bodyState.acceleration,
      swingScale: { left: this.variationNow.armLeft, right: this.variationNow.armRight },
      touch: { left: this.touch.weight('left'), right: this.touch.weight('right') },
      pose: {
        armAbduction: relax(mix(c.armAbduction, c.runArmAbduction), c.idleArmAbduction),
        elbowBend: relax(mix(c.elbowBend, c.runElbowBend), c.idleElbowBend) + k * c.crouchElbowBend,
        armSwing: mix(walkSwing, c.runArmSwing),
        elbowSwingBend: mix(c.elbowSwingBend, c.runElbowSwingBend),
        armForward: relax(c.armForward, c.idleArmForward) + k * c.crouchArmForward + this.jumping.armForward() - mix(ARM_SWING_BACK * walkSwing, RUN_ARM_SWING_BACK * c.runArmSwing),
      },
    });

    this.touch.apply();

    // 10. Torsión de brazos y piernas: reparte el giro axial que dejaron el IK y los brazos.
    this.twist.update();

    worldPosition(rig.hips, this.body.state.com);
  }

  /**
   * Speed limit over stairs (m/s): the one at which each step climbs one tread, and stopping in front of a
   * riser it can't climb.
   */
  private stairSpeedLimit(dt: number): number {
    const stairs = this.stairs;
    let limit = Number.POSITIVE_INFINITY;
    if (stairs.run > 0 && stairs.blend > 0) {
      // Paso (velocidad / cadencia) igual a la huella: por bisección, la cadencia depende de la velocidad.
      let lo = 0;
      let hi = this.config.runSpeed;
      for (let i = 0; i < 20; i++) {
        const v = (lo + hi) / 2;
        if (v / this.gait.stepFrequencyFor(v) > stairs.run) hi = v;
        else lo = v;
      }
      limit = this.config.runSpeed + (lo - this.config.runSpeed) * stairs.blend;
    }
    // Al acabar la escalera, el límite se suelta poco a poco: acelerando de golpe desde el paso lento de
    // la escalera, la pierna de atrás se quedaba lejos y las caderas se hundían.
    if (limit > this.stairLimit) limit = this.stairLimit + STAIR_RELEASE * this.config.acceleration * dt;
    this.stairLimit = limit >= this.config.runSpeed ? Number.POSITIVE_INFINITY : limit;
    const ahead = stairs.wallAhead(this.body.state.position, this.body.state.forward);
    if (Number.isFinite(ahead)) {
      // Se para con los pies delante de la contrahuella: las puntas, a un talón de ella.
      // Con la mitad de la deceleración: la frenada tiene una rampa (speedEasing) y se pasaba.
      const room = Math.max(ahead - stairs.toeFront - stairs.heelBack, 0);
      limit = Math.min(limit, Math.sqrt(this.config.deceleration * room));
    }
    return limit;
  }

  private syncPlacementConfig(): void {
    this.placementConfig.castHeight = this.config.footProbeHeight;
    this.placementConfig.castDepth = this.config.footProbeDepth;
    this.placementConfig.toeTolerance = this.config.footProbeTolerance;
  }

  /** What the touch gesture needs from the body at this moment. */
  touchMotion(dt = 0): TouchMotion {
    const state = this.body.state;
    return {
      dt,
      forward: state.forward,
      velocity: state.velocity,
      allowed: !state.airborne && this.jumping.phase === 'GROUNDED' && this.gait.blend < TOUCH_MAX_RUN_BLEND,
      still: this.gait.mode === 'idle',
    };
  }

  /** IK error of each leg in the last update (m). */
  ikError(side: Side): number {
    return this.legs[side].result?.error ?? 0;
  }

  /**
   * idle ↔ walk:
   *  - goes to walk if it wants to move or turn, or some foot isn't settled (position or orientation);
   *  - goes back to idle when it doesn't want to move, the body is stopped and both feet are on the ground
   *    and settled (double support).
   */
  private updateGaitMode(dt: number): void {
    // Frenado del todo por un límite (delante de un escalón que no puede subir), no quiere moverse.
    const wantsToMove = (this.targetSpeed > 0 && this.body.speedLimit > 0) || this.speed > IDLE_SPEED * this.config.walkSpeed || this.body.isTurning();
    if (wantsToMove) {
      this.setGaitMode('walk');
      return;
    }
    if (this.gait.mode === 'idle') {
      if (!this.feetSettledIdle(dt)) this.setGaitMode('walk');
    } else if (this.gait.doubleSupport() && this.feetSettled()) {
      this.setGaitMode('idle');
    }
  }

  /**
   * Are both feet where they would be if they took a step to their neutral position? (2 raycasts per foot)
   * Sideways and in orientation, with `idleStepThreshold` and `idleTurnThreshold`. Forward and back, a foot
   * somewhat ahead is accepted (up to IDLE_STAGGER × stepLength), with the body centered between the two: a
   * person who stops with one foot a few centimeters ahead doesn't correct it with another step.
   */
  private feetSettled(): boolean {
    const c = this.config;
    const maxAngle = (c.idleTurnThreshold * Math.PI) / 180;
    const forward = this.body.state.forward;
    const maxStagger = IDLE_STAGGER * c.stepLength;
    let along = 0;
    for (const side of SIDES) {
      // Sobre una escalera, el sitio del pie es el de la huella (sin raycasts de más, ver StairPlanner); si
      // no es donde está, se recoloca aunque esté poco adelantado: estaría pisando un borde.
      let onTread = false;
      const e = this.planner.settleError(this.feet[side], this.settleOffset, (target, rotation) => {
        onTread = this.planStairLanding(side, this.feet[side].planted, 0, target, rotation, false);
      });
      const ahead = this.settleOffset.dot(forward);
      const across = Math.sqrt(Math.max(e.distance * e.distance - ahead * ahead, 0));
      const maxAhead = onTread ? c.idleStepThreshold : maxStagger;
      if (across >= c.idleStepThreshold || Math.abs(ahead) >= maxAhead || e.angle >= maxAngle) return false;
      along += ahead / 2;
    }
    return Math.abs(along) < Math.max(maxStagger / 2, c.idleStepThreshold);
  }

  /**
   * `feetSettled` while standing still: the feet don't move, so the result only changes if the root moves
   * (or the configuration or the terrain changes: it is repeated every IDLE_RECHECK_TIME).
   */
  private feetSettledIdle(dt: number): boolean {
    const check = this.settleCheck;
    const root = this.rig.root.matrixWorld;
    check.age += dt;
    if (!check.valid || check.age >= IDLE_RECHECK_TIME || !root.equals(check.root)) {
      check.settled = this.feetSettled();
      check.valid = true;
      check.age = 0;
      check.root.copy(root);
    }
    return check.settled;
  }

  /**
   * Changes the gait mode. When going idle, the feet (which may be rolling over the heel or the toes)
   * flatten smoothly over IDLE_SETTLE_TIME instead of snapping.
   */
  private setGaitMode(mode: 'idle' | 'walk'): void {
    if (this.gait.mode === mode) return;
    this.gait.mode = mode;
    this.settleCheck.valid = false;
    if (mode === 'idle') {
      this.landed.left = false;
      this.landed.right = false;
      this.settleBlend = 0;
      for (const side of SIDES) {
        this.settleFrom[side].position.copy(this.feet[side].position);
        this.settleFrom[side].rotation.copy(this.feet[side].rotation);
      }
    } else {
      this.settleBlend = 1;
    }
  }

  /**
   * The foot takes off: its trajectory goes from where it is to the landing point.
   * Landing = home + advance of the body during the swing + half the advance during the next stance
   * (walking: the foot ends up under the hip at mid-stance; running, a smaller fraction: it lands closer to
   * the body).
   */
  private beginSwing(foot: FootTarget, dt: number): void {
    const swing = foot.swing;
    swing.t = 0;
    swing.retargetFrom = 1;
    swing.start.copy(foot.position);
    swing.startRotation.copy(foot.rotation);

    const angularSpeed = Math.abs(this.body.state.angularVelocity);
    const swingTime = this.gait.swingDuration(this.speed, angularSpeed, this.gait.duty[foot.side]);
    // El despegue ocurrió entre el frame anterior y este: ya pasó parte del swing.
    const sinceLiftoff = this.gait.swingProgress(foot.side) * swingTime;
    // `foot.position` es aún la del frame anterior, y el despegue ocurrió entre ese frame y este:
    // el swing empieza donde estaba el pie en ese instante, siguiendo la velocidad que traía (el
    // talón levantado gira sobre la punta). Si no, el pie se queda quieto un frame mientras el
    // cuerpo avanza, la pierna trasera se estira de más y, corriendo, tira de las caderas hacia abajo.
    if (foot.phase === 'LIFT') {
      // Despega desde el LIFT: el swing empieza en la pose exacta del despegue (talón levantado del
      // todo sobre la articulación de los dedos), no en la del frame anterior extrapolada en línea recta
      // (el pie rígido avanzaba y la punta podía meterse en un borde que tuviera delante).
      this.liftPose(foot, 1, swing.start, swing.startRotation);
    } else if (this.lastFootDt > 0) {
      const velocity = this.tmp.subVectors(foot.position, this.footPrevious[foot.side]).divideScalar(this.lastFootDt);
      // Un salto de posición (teletransporte, reset) no es una velocidad.
      if (velocity.length() <= MAX_LIFTOFF_SPEED) {
        swing.start.addScaledVector(velocity, Math.max(dt - sinceLiftoff, 0));
      }
    }
    this.planSwingLanding(foot, Math.max(swingTime - sinceLiftoff, 0), angularSpeed);
    this.liftoffTangent(foot, swingTime, angularSpeed);

    // El desvío antes que la altura: la holgura sobre el terreno se mide por donde pasará el pie.
    this.swingDetour(foot);
    swing.height = this.swingHeight(foot);
  }

  /**
   * Where and how the foot in the air lands, with `remaining` seconds of swing ahead: sets
   * `landing`/`landingRotation` (flat foot) and `end`/`endRotation` (with the toes raised), and records the
   * desired speed it was planned with (see retargetSwing).
   */
  private planSwingLanding(foot: FootTarget, remaining: number, angularSpeed: number): void {
    const swing = foot.swing;
    this.swingIntent[foot.side].speed = this.body.targetSpeed;
    this.swingIntent[foot.side].replanned = false;
    // Girando, el pie aterriza ya orientado hacia donde mirará el cuerpo a mitad de su apoyo
    // (se adelanta al giro): la pierna se tuerce la mitad en cada sentido en vez de quedarse
    // atrás todo el apoyo, y los pies acompañan al giro. Las predicciones cuentan desde ahora, así que
    // solo con lo que queda de swing (si no, el aterrizaje dependería de en qué momento del frame despegó).
    const yaw = this.body.predict(remaining, this.displacement, this.landingVelocity);
    // El apoyo, con el giro que llevará al aterrizar: al empezar a pivotar casi no gira todavía, y con
    // el de ahora el apoyo parecería largo y el pie aterrizaría girado de más (luego volvía de golpe).
    const landingTurn = Math.max(angularSpeed, Math.abs(this.body.predictedAngularVelocity));
    const midStance = remaining + this.gait.stanceDuration(this.landingVelocity.length(), landingTurn) / 2;
    const footYaw = yaw + clamp(this.body.predict(midStance, this.midStanceDisplacement, this.midStanceVelocity) - yaw, -MAX_LANDING_LEAD, MAX_LANDING_LEAD);
    const lead = this.landingLead(this.landingVelocity.length());
    this.planner.planLanding(
      foot.side,
      this.displacement,
      this.landingVelocity,
      lead,
      swing.landing,
      swing.landingRotation,
      yaw,
      footYaw,
    );
    this.planStairLanding(foot.side, swing.start, footYaw, swing.landing, swing.landingRotation);
    // Subiendo o bajando un escalón, el pie apoya plano (en el mocap de escaleras, ±3°), y bajando, avanza
    // antes de bajar (ver evaluateSwing).
    const level = this.stairs.active ? swing.landing.y - foot.planted.y : 0;
    swing.dropDelay = 0;
    if (level <= -this.stairs.edgeHeight) {
      // No baja hasta que el talón pasa el borde (caminando, el pie avanza smoothstep(t) del camino).
      const pass = inverseSmoothstep(this.stairs.dropFraction(swing.start, swing.landing));
      swing.dropDelay = clamp(pass, MIN_DROP_DELAY, MAX_DROP_DELAY);
    }

    // El swing termina con la punta levantada: el PLANT la bajará pivotando sobre el talón.
    swing.end.copy(swing.landing);
    swing.endRotation.copy(swing.landingRotation);
    swing.heelStrike = Math.abs(level) >= this.stairs.edgeHeight ? 0 : this.heelStrike;
    // Bajando, de antepié: el tobillo extendido llega más abajo y las caderas no tienen que bajar tanto.
    if (swing.dropDelay > 0) swing.heelStrike = -STAIR_TOE_STRIKE;
    strikeRoll(this.legs[foot.side].roll, swing.end, swing.endRotation, swing.heelStrike);
  }

  /**
   * Over stairs or steps (see StairPlanner): moves the planned landing so that the whole foot rests on one
   * tread.
   */
  private planStairLanding(
    side: Side,
    start: Vector3,
    footYaw: number,
    landing: Vector3,
    landingRotation: Quaternion,
    probe = true,
  ): boolean {
    const other = this.feet[side === 'left' ? 'right' : 'left'];
    const placement = this.planner.placement(side);
    const stanceAnkle = this.planner.placement(other.side).ankleHeight;
    const moved = this.stairs.planLanding(
      start,
      other.planted,
      other.planted.y - stanceAnkle,
      landing,
      placement.state,
      placement.ankleHeight,
      this.body.state.forward,
      this.tmp,
      probe,
    );
    if (moved) this.planner.placeLanding(side, this.tmp, footYaw, landing, landingRotation);
    return moved;
  }

  /**
   * If the requested speed changed a lot since the foot took off (braking or coming out of a turn) and it is
   * still in the first part of the swing, it replans where it lands: otherwise, the step that was already in
   * the air landed where it would have at the previous speed (when braking, a full-stride step). Once per
   * swing.
   */
  private retargetSwing(foot: FootTarget): void {
    const swing = foot.swing;
    const intent = this.swingIntent[foot.side];
    if (intent.replanned || swing.t > RETARGET_MAX_PROGRESS || this.gait.blend > 0) return;
    // Solo por la velocidad: con un cambio de rumbo, reorientar el pie a mitad del swing se nota más
    // (tirón) que lo que gana, y el giro ya lo recogen los pasos siguientes.
    if (Math.abs(intent.speed - this.body.targetSpeed) / this.config.walkSpeed < RETARGET_SPEED_CHANGE) return;
    // El final de antes se guarda: evaluateSwing pasa de él al nuevo desde aquí, sin saltos.
    swing.previousEnd.copy(swing.end);
    swing.previousEndRotation.copy(swing.endRotation);
    const wasGoingUp = swing.end.y > swing.start.y;
    const angularSpeed = Math.abs(this.body.state.angularVelocity);
    const swingTime = this.gait.swingDuration(this.speed, angularSpeed, this.gait.duty[foot.side]);
    this.planSwingLanding(foot, (1 - swing.t) * swingTime, angularSpeed);
    intent.replanned = true;
    swing.retargetFrom = swing.t;
    // Subir o no a un escalón cambia la forma del swing: eso no puede cambiar a mitad de camino.
    if (swing.end.y > swing.start.y !== wasGoingUp) swing.end.y = swing.previousEnd.y;
  }

  /**
   * Curve of the heel in LIFT (0 → 1). When walking, it rises faster and faster until toe-off (as in motion
   * capture) and the swing starts with that velocity; when running, it slows down at toe-off.
   */
  private liftCurve(progress: number): number {
    const k = smoothstep(progress);
    return k + (progress * progress - k) * (1 - this.gait.blend);
  }

  /**
   * Pose of the foot in LIFT with progress `u` (0–1): the planted one, pivoted if the body turns, with the
   * heel raised about the toe joint.
   */
  private liftPose(foot: FootTarget, u: number, outPosition: Vector3, outRotation: Quaternion): Vector3 {
    outPosition.copy(foot.planted);
    outRotation.copy(foot.plantedRotation);
    this.pivotStanceFoot(foot.side, outPosition, outRotation);
    this.legs[foot.side].roll.roll(outPosition, outRotation, 'toe', Math.max(this.heelLift * this.liftCurve(u), this.pushOff[foot.side]));
    return outPosition;
  }

  /**
   * Going up stairs, the trailing foot (in LIFT, with the other one on a higher tread or going to one) can
   * raise its heel beyond the usual lift to push off.
   */
  private canPushOff(side: Side): boolean {
    const foot = this.feet[side];
    if (foot.phase !== 'LIFT' || this.stairs.blend <= 0) return false;
    const other = this.feet[side === 'left' ? 'right' : 'left'];
    const ahead = other.phase === 'SWING' ? other.swing.landing : other.planted;
    return ahead.y - foot.planted.y >= this.stairs.edgeHeight;
  }

  /** Pose of a foot in LIFT with the heel raised `angle` rad about the toe joint. */
  private pushOffPose(foot: FootTarget, angle: number, outPosition: Vector3, outRotation: Quaternion): void {
    outPosition.copy(foot.planted);
    outRotation.copy(foot.plantedRotation);
    this.pivotStanceFoot(foot.side, outPosition, outRotation);
    this.legs[foot.side].roll.roll(outPosition, outRotation, 'toe', angle);
  }

  /**
   * Push-off up stairs: the hips were placed within reach of the highest ankle of the trailing foot (see
   * PelvisMotion.reachAnkles); here that foot raises its heel just enough for the leg to reach it (the
   * smallest angle, by bisection), with the toes still on the tread. It doesn't lower again until it takes
   * off.
   */
  private pushOffStairs(maxReach: number): void {
    for (const side of SIDES) {
      if (!this.canPushOff(side)) continue;
      const foot = this.feet[side];
      const hip = worldPosition(this.legs[side].ik.leg.thigh, this.tmp);
      // Con un margen: justo en el límite, el IK se quedaba a milímetros.
      const reach = this.pelvis.maxLegReach(side, maxReach) * PUSH_OFF_MARGIN;
      if (hip.distanceTo(foot.position) <= reach) continue;
      let lo = this.toeBend[side];
      let hi = STAIR_MAX_HEEL_LIFT;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        this.pushOffPose(foot, mid, this.pushPosition, this.pushRotation);
        if (hip.distanceTo(this.pushPosition) > reach) lo = mid;
        else hi = mid;
      }
      this.pushOffPose(foot, hi, foot.position, foot.rotation);
      this.toeBend[side] = hi;
      this.liftoffToeBend[side] = hi;
      this.pushOff[side] = hi;
    }
  }

  /**
   * Velocity of the ankle at toe-off, in meters per unit of swing progress (`startTangent`): the derivative
   * of the LIFT pose at the end, computed (not measured between frames, which would depend on when within
   * the frame it took off). Limited to a fraction of the swing path.
   */
  private liftoffTangent(foot: FootTarget, swingTime: number, angularSpeed: number): void {
    const tangent = foot.swing.startTangent;
    tangent.set(0, 0, 0);
    const liftTime = this.gait.liftPhase(foot.side) / this.gait.cycleFrequency(this.speed, angularSpeed);
    if (!(liftTime > 0)) return;
    const h = 1e-3;
    this.liftPose(foot, 1, tangent, this.sampleRot);
    tangent.sub(this.liftPose(foot, 1 - h, this.samplePos, this.sampleRot)).multiplyScalar(swingTime / (h * liftTime));
    const limit = MAX_LIFTOFF_TANGENT * foot.swing.start.distanceTo(foot.swing.end);
    if (tangent.length() > limit) tangent.setLength(limit);
  }

  /**
   * Deviation of the swing to go around the planted foot: in a step that rotates the foot a lot (when
   * turning around, the foot that lands already rotated crosses over the one that pivots), if the straight
   * line of the ankle passes closer than SWING_CLEARANCE × stepLength to the center of the other foot, it
   * curves outwards at mid-swing just enough to pass at that distance. When walking or in normal curves it
   * does nothing.
   */
  private swingDetour(foot: FootTarget): void {
    const swing = foot.swing;
    swing.detour.set(0, 0, 0);
    const other = this.feet[foot.side === 'left' ? 'right' : 'left'];
    if (other.phase === 'SWING') return;
    const turn = Math.abs(wrapAngle(this.footYaw(foot.side, swing.endRotation) - this.footYaw(foot.side, swing.startRotation)));
    if (turn < DETOUR_MIN_TURN) return;
    // Centro del pie apoyado: entre el tobillo y la punta.
    const center = this.tmp.copy(this.legs[other.side].roll.toeLocal).applyQuaternion(other.plantedRotation).multiplyScalar(0.5).add(other.planted);
    const ax = swing.end.x - swing.start.x;
    const az = swing.end.z - swing.start.z;
    const length2 = ax * ax + az * az;
    if (length2 < 1e-8) return;
    const u = clamp(((center.x - swing.start.x) * ax + (center.z - swing.start.z) * az) / length2, 0, 1);
    // Solo si pasa cerca en la parte central del swing: cerca del despegue o del aterrizaje el desvío
    // (que entra con sen²(π·t)) tendría que ser enorme para notarse, y estiraba la pierna de lado.
    if (u < 0.2 || u > 0.8) return;
    const px = swing.start.x + ax * u - center.x;
    const pz = swing.start.z + az * u - center.z;
    const distance = Math.hypot(px, pz);
    const clearance = SWING_CLEARANCE * this.config.stepLength;
    if (distance >= clearance) return;
    // Siempre hacia el lado de este pie (el izquierdo rodea por la izquierda): por el otro lado la pierna
    // cruzaría por delante de la de apoyo y las rodillas chocarían. Lo justo para que el punto más
    // cercano quede a `clearance` del pie apoyado.
    const side = foot.side === 'left' ? -1 : 1;
    const forward = this.body.state.forward;
    const nx = -forward.z * side;
    const nz = forward.x * side;
    const along = px * nx + pz * nz; // lo que ya está hacia ese lado
    const across = Math.sqrt(Math.max(distance * distance - along * along, 0));
    const needed = Math.sqrt(Math.max(clearance * clearance - across * across, 0)) - along;
    if (needed <= 0) return;
    const amount = Math.min(needed / Math.sin(Math.PI * u) ** 2, MAX_DETOUR * this.config.stepLength);
    swing.detour.set(nx * amount, 0, nz * amount);
  }

  /**
   * Height of the arc for this step: `stepHeight`, increased if at any moment the toes would be closer than
   * `toeClearance` to the terrain.
   *
   * The swing is sampled in time; at each sample it must clear the ground under the toes at that sample and
   * at the next one (so that no edge slips between two samples). Since the extra height enters with the
   * profile of the arc (`swingArc`), each sample's deficit is divided by that factor.
   */
  private swingHeight(foot: FootTarget): number {
    const base = this.gait.mix(this.config.stepHeight, this.config.runStepHeight);
    if (this.stairs.active) return base + Math.min(this.stairSwingExtra(foot, base), this.config.maxExtraStepHeight);
    const roll = this.legs[foot.side].roll;
    const n = CLEARANCE_SAMPLES;
    const toeY: number[] = [];
    const groundY: number[] = [];
    // La muestra 0 (el pie aún en el suelo, al despegar) no se usa: sin raycast.
    toeY.push(0);
    groundY.push(-Infinity);
    for (let i = 1; i <= n; i++) {
      evaluateSwing(foot.swing, i / n, base, this.samplePos, this.sampleRot, 1 - this.gait.blend);
      const toe = this.tmp.copy(roll.toeLocal).applyQuaternion(this.sampleRot).add(this.samplePos);
      toeY.push(toe.y);
      toe.y += 1;
      groundY.push(this.detector.castDown(toe, 3, this.sampleHit) ? this.sampleHit.point.y : -Infinity);
    }
    let extra = 0;
    for (let i = 1; i < n; i++) {
      const ground = Math.max(groundY[i], groundY[i + 1]);
      const deficit = ground + this.config.toeClearance - toeY[i];
      if (deficit > 0) extra = Math.max(extra, deficit / Math.max(swingArc(i / n, 1 - this.gait.blend), 0.05));
    }
    return base + Math.min(extra, this.config.maxExtraStepHeight);
  }

  /**
   * `swingHeight` over stairs: the same with the profile of the ground the StairPlanner already sampled
   * (without raycasts) and with the whole sole: the back of the heel, the toe joint and the tips of the
   * toes (on a step, the toes hit the nosing and the heel the edge behind). The tips of the toes are taken
   * horizontally ahead of the toe joint: the toes bend, so with the heel raised they don't go down with the
   * foot.
   */
  private stairSwingExtra(foot: FootTarget, base: number): number {
    const roll = this.legs[foot.side].roll;
    const profile = this.stairs.profile;
    const n = CLEARANCE_SAMPLES;
    const walk = 1 - this.gait.blend;
    const along = this.sampleAxis.subVectors(roll.toeLocal, roll.heelLocal);
    const toes = this.stairs.toeFront - along.length();
    along.normalize();
    // Puntos de la planta en el espacio del pie: detrás del talón, articulación de los dedos y (desde ella) punta.
    const points = this.solePoints;
    points[0].copy(roll.heelLocal).addScaledVector(along, -this.stairs.heelBack);
    points[1].copy(roll.toeLocal);
    points[2].copy(roll.toeLocal);
    let extra = 0;
    for (let k = 0; k < points.length; k++) {
      let previousU = Number.NaN;
      let previousY = 0;
      for (let i = 1; i <= n; i++) {
        evaluateSwing(foot.swing, i / n, base, this.samplePos, this.sampleRot, walk);
        const p = this.tmp.copy(points[k]).applyQuaternion(this.sampleRot).add(this.samplePos);
        let u = profile.along(p);
        if (k === 2) {
          const d = this.tipDirection.copy(along).applyQuaternion(this.sampleRot).setY(0);
          const length = d.length();
          if (length > 1e-6) u += (toes * (d.x * profile.direction.x + d.z * profile.direction.z)) / length;
        }
        if (!Number.isNaN(previousU)) {
          // La muestra anterior debe librar el suelo entre ella y esta (ningún borde se cuela entre las dos).
          const deficit = profile.maxHeight(previousU, u) + this.config.toeClearance - previousY;
          if (deficit > 0) extra = Math.max(extra, deficit / Math.max(swingArc((i - 1) / n, walk), 0.05));
        }
        previousU = u;
        previousY = p.y;
      }
    }
    return extra;
  }

  /**
   * Lead of the foot relative to its neutral position on landing (m): a fraction (`walkLandingLead`; when
   * running, `runLandingLead`) of half the advance of the body during the next stance. When running, it also
   * recovers the `ankleBack` of the neutral position: the stance ends up centered under the hips and the
   * trailing leg reaches toe-off without the hips sinking in the flight phase.
   */
  private landingLead(speed: number): number {
    const run = this.gait.runFactor(speed);
    // Caminando, el apoyo se corre hacia atrás en la medida en que el talón se levanta al despegar (es lo
    // que alarga la pierna de atrás): con los pies planos (talón sin levantar), centrado.
    const heel = Math.min(Math.max(this.config.heelLiftAngle / FULL_HEEL_LIFT, 0), 1);
    const walkLead = 1 - (1 - this.config.walkLandingLead) * heel;
    const leadFactor = walkLead + (this.config.runLandingLead - walkLead) * run;
    return (speed * this.gait.stanceDuration(speed) * leadFactor) / 2 + this.config.ankleBack * run;
  }

  /** Jump: stores the pose of the feet and the height of the hips at take-off (after solving that frame). */
  private beginAir(dt: number): void {
    this.airTime = 0;
    this.landingPrep = 0;
    // Sin la parte del agachado, que en el aire se sigue aplicando aparte.
    this.airStartOffset = this.pelvis.offset + smoothstep(this.crouch) * this.config.crouchDepth;
    for (const side of SIDES) {
      const air = this.air[side];
      air.start.copy(this.feet[side].position);
      air.startRotation.copy(this.feet[side].rotation);
      // Un pie en pleno swing (corriendo) sigue moviéndose; uno apoyado, no.
      air.velocity.subVectors(air.start, air.previous).divideScalar(Math.max(dt, 1e-6));
      air.velocity.y = Math.max(air.velocity.y, 0); // uno que bajaba no sigue bajando hacia el suelo
    }
  }

  /**
   * Jump, feet in the air:
   *  - after take-off, they tuck towards their neutral position raised by `jumpTuck`;
   *  - in the last `jumpLandingPrep` seconds they extend towards where they will land: the neutral position
   *    where the body will be when it touches the ground, placed on the terrain with the planner.
   */
  private updateAirFeet(dt: number): void {
    const cfg = this.config;
    const body = this.body.state;
    this.airTime += dt;
    const tLand = this.body.timeToLand();
    const lift = smoothstep(this.airTime / AIR_TUCK_TIME);
    this.landingPrep = smoothstep(1 - tLand / cfg.jumpLandingPrep);
    this.displacement.copy(body.velocity).multiplyScalar(tLand);
    const lead = this.landingLead(body.speed);

    for (const side of SIDES) {
      const foot = this.feet[side];
      const air = this.air[side];
      foot.phase = 'SWING';

      // Recogido: posición neutra (sigue a la raíz) elevada.
      this.planner.homePosition(side, this.tmp);
      this.tmp.y += cfg.jumpTuck;
      // Desde el despegue: sigue con su velocidad, que se desvanece mientras se recoge
      // (desplazamiento = v · ∫(1 − smoothstep)), para no frenar en seco.
      const x = Math.min(this.airTime / AIR_TUCK_TIME, 1);
      const drift = this.airTime > AIR_TUCK_TIME ? AIR_TUCK_TIME / 2 : this.airTime - AIR_TUCK_TIME * (x ** 3 - x ** 4 / 2);
      this.samplePos.copy(air.start).addScaledVector(air.velocity, drift);
      foot.position.lerpVectors(this.samplePos, this.tmp, lift);
      foot.rotation.copy(air.startRotation);

      // Preparación del aterrizaje: el punto de apoyo se calcula donde estará el cuerpo
      // al tocar el suelo, pero el pie va a esa pose *relativa al cuerpo* (restando lo
      // que al cuerpo le queda por avanzar y caer): así llega a él justo al aterrizar,
      // sin estirar la pierna más de lo que alcanza mientras el cuerpo aún está alto.
      this.planner.planLanding(side, this.displacement, body.velocity, lead, foot.swing.landing, foot.swing.landingRotation);
      this.samplePos.copy(foot.swing.landing).sub(this.displacement);
      this.samplePos.y += body.position.y - body.groundHeight;
      foot.position.lerp(this.samplePos, this.landingPrep);
      foot.rotation.slerp(foot.swing.landingRotation, this.landingPrep);
    }
  }

  /**
   * Jump: on touching the ground, the feet rest where they were prepared and the gait is re-phased to
   * continue from there (still, walking or running):
   *  - the foot further ahead has just landed (phase right after PLANT);
   *  - the other one starts taking off (start of LIFT), with a somewhat longer stance in this cycle so that,
   *    when running, it isn't left "in the air" without having taken off.
   */
  private land(): void {
    this.landingPrep = 0;
    for (const side of SIDES) {
      const foot = this.feet[side];
      foot.planted.copy(foot.swing.landing);
      foot.plantedRotation.copy(foot.swing.landingRotation);
      foot.position.copy(foot.planted);
      foot.rotation.copy(foot.plantedRotation);
      foot.phase = 'PLANTED';
    }

    const gait = this.gait;
    const cfg = this.config;
    gait.reset();
    gait.blend = gait.runFactor(this.speed);
    const duty = gait.dutyFor(gait.blend);
    const ahead = this.tmp.subVectors(this.feet.right.planted, this.feet.left.planted).dot(this.body.state.forward);
    // Saltando quieto los pies caen a la par (ahead ≈ ±1e-16): el signo sería ruido numérico y
    // decidiría al azar qué pie sale primero (distinto, p. ej., con otro tamaño). Empate → izquierdo.
    const lead: Side = ahead > TIE_TOLERANCE * this.config.stepLength ? 'right' : 'left';
    const trail: Side = lead === 'left' ? 'right' : 'left';
    gait.duty[lead] = duty;
    const plant = Math.min(cfg.plantFraction, duty * 0.25);
    // Apoyo del de atrás tal que su LIFT empiece justo ahora (fase 0,5 + plant): d = 0,5 + plant + lift,
    // con lift = min(liftFraction, d · tope).
    const start = 0.5 + plant;
    const share = gait.maxLiftShare();
    const trailDuty = cfg.liftFraction <= share * (start + cfg.liftFraction) ? start + cfg.liftFraction : start / (1 - share);
    gait.duty[trail] = Math.max(duty, trailDuty);
    gait.phase = fract(plant - gait.offsets[lead]);
  }

  private get heelLift(): number {
    return (this.gait.mix(this.config.heelLiftAngle, this.config.runHeelLiftAngle) * Math.PI) / 180;
  }

  private get heelStrike(): number {
    return (this.gait.mix(this.config.heelStrikeAngle, this.config.runHeelStrikeAngle) * Math.PI) / 180;
  }

  /**
   * Desired height of the hips when running (m, relative to rest): lower and with a bounce whose minimum
   * falls at mid-stance. 0 when walking.
   */
  private runHeight(): number {
    const r = this.gait.blend;
    if (r <= 0) return 0;
    const p = this.gait.footPhase('left');
    const midStance = this.gait.duty.left / 2;
    const bounce = -Math.cos(4 * Math.PI * (p - midStance)); // −1 a mitad de cada apoyo
    return r * (-this.config.runCrouch + this.config.runBounce * bounce);
  }

  /**
   * Desired height of the hips in the air (m, relative to rest): from the take-off height it goes back to 0
   * as the feet tuck and, when preparing the landing, moves towards the running height at that speed
   * (without the bounce), so as not to drop abruptly on touching the ground.
   */
  private airHeight(): number {
    const takeoff = this.airStartOffset * (1 - smoothstep(this.airTime / AIR_TUCK_TIME));
    const landing = -this.gait.runFactor(this.speed) * this.config.runCrouch;
    return takeoff + (landing - takeoff) * this.landingPrep;
  }

  /**
   * How much each leg limits the height of the hips:
   *  - walking, always (1);
   *  - running, on the ground (1); in the air it smoothly stops limiting after toe-off (push-off) and limits
   *    again in the second half of the swing, preparing the landing (without jumps of the hips).
   */
  /**
   * Desired knee bend of a planted foot (rad), according to the moment of the stance (u = 0 at landing, 1 at
   * toe-off): almost straight on landing, it cushions when taking the weight (maximum around 25 % of the
   * stance, ≈ 15 % of the cycle, as in human gait), straightens again at mid-stance and, at the end, bends
   * before toe-off (pre-swing): that way the trailing foot gives up the weight without the hips jerking.
   * The bend grows with speed (at `walkSpeed`, the configured one). Standing still: `standKneeBend`.
   */
  private stanceKnee(side: Side): number {
    const cfg = this.config;
    let bend = cfg.standKneeBend;
    if (this.gait.mode !== 'idle' && this.gait.isStance(side)) {
      const u = this.gait.footPhase(side) / this.gait.duty[side];
      const loading = u < KNEE_LOADING_PEAK ? smoothstep(u / KNEE_LOADING_PEAK) : 1 - smoothstep((u - KNEE_LOADING_PEAK) / (KNEE_LOADING_END - KNEE_LOADING_PEAK));
      const speed = Math.min(this.speed / cfg.walkSpeed, MAX_KNEE_SPEED_FACTOR);
      bend += (cfg.stanceKneeBend - cfg.standKneeBend + cfg.loadingKneeBend * loading) * speed;
      bend += PRE_SWING_BEND * smoothstep((u - PRE_SWING_START) / (1 - PRE_SWING_START));
    }
    return (bend * Math.PI) / 180;
  }

  /**
   * Desired lateral drop of the pelvis (−1…1, positive = lowers the right side). While stepping, a smooth
   * wave with the cycle, peaking shortly after loading the weight on one foot (the opposite side, in the
   * air, drops), as in human gait (~15–25 % of the cycle); not a switch that flips in double support.
   * Standing still, according to the weight distribution; in between (when braking and in the repositioning
   * steps) it goes from one to the other with speed (`pelvisWave`).
   */
  private pelvisObliquity(): number {
    const still = this.gait.supportWeight('left') - this.gait.supportWeight('right');
    if (this.gait.mode === 'idle') return still;
    const wave = Math.cos(2 * Math.PI * (this.gait.footPhase('left') - PELVIS_DROP_PEAK));
    return still + (wave - still) * this.pelvisWave();
  }

  /**
   * Desired rotation of the pelvis while stepping (−1…1, positive = brings the right side forward): a
   * smooth wave peaking at each heel strike (the side of the landing leg is ahead and helps it reach),
   * without staying still with the feet apart. When braking it switches to the standing one (towards the
   * foot that is ahead), so it reaches idle without an abrupt change.
   */
  private pelvisRotation(): number {
    const ahead = this.tmp.subVectors(this.feet.right.position, this.feet.left.position).dot(this.body.state.forward);
    const still = Math.min(Math.max(ahead / this.config.stepLength, -1), 1);
    const wave = -Math.cos(2 * Math.PI * (this.gait.footPhase('left') + PELVIS_ROTATION_LEAD));
    return still + (wave - still) * this.pelvisWave();
  }

  /**
   * How much the rotation and drop of the pelvis follow the gait wave (0–1): fully from
   * PELVIS_WAVE_SPEED × walkSpeed; standing still, not at all. The repositioning steps when stopping are
   * almost in place: a pelvis swaying as if walking and snapping back to the center when still shook the
   * trunk and the arms.
   */
  private pelvisWave(): number {
    return smoothstep(this.body.state.speed / (PELVIS_WAVE_SPEED * this.config.walkSpeed));
  }

  /**
   * Desired tilt oscillation of the pelvis (−1…1, positive = forward): two waves per stride, forward at
   * each heel strike and backward at mid-stance, as in the CMU captures. Only when walking.
   */
  private pelvisTiltWave(): number {
    if (this.gait.mode === 'idle') return 0;
    return Math.cos(4 * Math.PI * (this.gait.footPhase('left') - PELVIS_TILT_PEAK)) * (1 - this.gait.blend);
  }

  /**
   * How much the hips anticipate the landing of a foot in the air (0–1): it grows in the last 40 % of the
   * swing; only when walking.
   */
  private landingAnticipation(side: Side): number {
    const foot = this.feet[side];
    if (foot.phase !== 'SWING') return 0;
    return smoothstep((foot.swing.t - LANDING_ANTICIPATION_START) / (1 - LANDING_ANTICIPATION_START)) * (1 - this.gait.blend);
  }

  private reachWeight(side: Side): number {
    const foot = this.feet[side];
    if (foot.phase !== 'SWING') return 1;
    const t = foot.swing.t;
    const swingWeight = Math.max(1 - smoothstep(t / 0.35), smoothstep((t - 0.5) / 0.5));
    return 1 - this.gait.blend * (1 - swingWeight);
  }
}

interface AirFoot {
  start: Vector3;
  startRotation: Quaternion;
  velocity: Vector3;
  previous: Vector3;
}

function createAirFoot(): AirFoot {
  return { start: new Vector3(), startRotation: new Quaternion(), velocity: new Vector3(), previous: new Vector3() };
}

function smoothstep(x: number): number {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Landing pose of a foot from its flat pose: on the heel with the toes raised `angle` rad, or, if `angle` is
 * negative, on the ball of the foot with the heel raised.
 */
function strikeRoll(roll: FootRoll, position: Vector3, rotation: Quaternion, angle: number): void {
  if (angle >= 0) roll.roll(position, rotation, 'heel', -angle);
  else roll.roll(position, rotation, 'toe', -angle);
}

/** The `x` (0–1) at which `smoothstep(x)` is `y`. */
function inverseSmoothstep(y: number): number {
  return 0.5 - Math.sin(Math.asin(1 - 2 * Math.min(Math.max(y, 0), 1)) / 3);
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(Math.max(x, min), max);
}

function fract(x: number): number {
  return x - Math.floor(x);
}
