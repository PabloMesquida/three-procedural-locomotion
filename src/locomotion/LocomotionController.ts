import { Matrix4, Quaternion, Vector3 } from 'three';

import { ArmController } from '../body/ArmController.ts';
import { BodyController, wrapAngle } from '../body/BodyController.ts';
import { PelvisController } from '../body/PelvisController.ts';
import { TorsoController } from '../body/TorsoController.ts';
import { TouchController, type TouchMotion } from '../body/TouchController.ts';
import { TwistController } from '../body/TwistController.ts';
import { setWorldQuaternionNode, worldPosition, worldQuaternion } from '../core/pose.ts';
import { LegIK } from '../ik/LegIK.ts';
import type { TwoBoneIKResult } from '../ik/TwoBoneIK.ts';
import type { HumanRig, Side } from '../rig/HumanRig.ts';
import { backBands, measureBack } from '../rig/measureBack.ts';
import { measureFeet } from '../rig/measureFeet.ts';
import type { Colliders } from '../terrain/Colliders.ts';
import { Ledge, LEDGE_WALL } from '../terrain/Ledge.ts';
import { NARROW_DROP, NarrowPath } from '../terrain/NarrowPath.ts';
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
 * relative to walking on the flat: ≈ +7.5° going up (subject 83, `npm run mocap -- postura`) and ≈ +2.5° going
 * down on stairs of slope 0.6 (17 × 28 cm); the spine takes only part of the requested lean.
 */
const STAIR_LEAN_UP = 19;
const STAIR_LEAN_DOWN = 12;
/** Time constant with which the lean follows the slope (s): the slope of the line changes in corners. */
const STAIR_LEAN_TIME = 0.3;
/**
 * Before the first step of a flight (up or down) the head glances down at it: this much (rad), from when it sees
 * a step `GLANCE_AHEAD` ahead until it is on the stairs, and it looks ahead again once it is going up or down
 * them (`GLANCE_TIME`, s, smoothing). Going down, it also looks a little down all the way: `DOWN_GAZE` per unit
 * of slope (rad; ≈ 9° on stairs of 17 × 28 cm), besides what it follows of the trunk.
 */
const GLANCE = 15 * DEG;
const GLANCE_TIME = 0.3;
const DOWN_GAZE = 15 * DEG;
/**
 * It looks for the step ahead this far (× stepLength), every `GLANCE_INTERVAL` s and only walking (one ray: the
 * budget of rays per frame is tight); a change of level of more than `GLANCE_STEP` × maxStepUp is a step.
 */
const GLANCE_AHEAD = 1.75;
const GLANCE_INTERVAL = 0.25;
const GLANCE_STEP = 0.25;
/**
 * On stairs the head nods less (it is held to watch the steps): the nodding from `headInertia` is divided by
 * 1 + this × the slope (CMU, going up: ±0.8° against ±1° on the flat, with stronger jolts of the hips).
 */
const STAIR_HEAD_STEADY = 5;
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
/**
 * On stairs, while the body turns along an arc of radius below MAX (× stepLength), the ground is sampled along
 * that arc (curved and spiral stairs); above it, in a straight line. The radius used is never below MIN
 * (× stepLength).
 */
const MAX_STAIR_TURN_RADIUS = 40;
const MIN_STAIR_TURN_RADIUS = 0.4;
/**
 * Going down stairs, as in the mocap of stairs (CMU, steps of ~16 cm): steps per second (on the flat, the
 * same people walk at ~1.7), fraction of the cycle with the foot on the ground (the trailing foot takes off
 * earlier), and knee bend of the stance leg (°), which it keeps while bearing the weight. All of it in the
 * measure of `stairDescent`.
 */
const STAIR_DOWN_FREQUENCY = 1.57;
const STAIR_DOWN_DUTY = 0.56;
const STAIR_DOWN_KNEE = 33;
/** Slope of the stairs (rise / run) from which it is fully going down (`stairDescent` = 1). */
const STAIR_DOWN_SLOPE = 0.3;
/** How fast the speed limit of the stairs is released when they end (× acceleration, per second). */
const STAIR_RELEASE = 0.4;
/** Stopped (below this speed, m/s) too close to a wall, it moves back from it at this speed (m/s). */
const WALL_BACK_OFF_BELOW = 0.05;
const WALL_BACK_OFF_SPEED = 0.3;
/**
 * Room of the body round the root, from colliders (× stepLength; 24 cm with the default one: half the width of
 * the shoulders and a little), and height of the character for them (× stepLength): what is higher, it passes
 * under.
 */
const BODY_RADIUS = 0.3;
const BODY_HEIGHT = 2.2;
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
 * When jogging, with the elbows bent, the arm is almost always behind the body (mocap: ≈ 1.4 × the
 * amplitude). With the lag made up (`lead`) it reaches a little further, so 1 gives about the same range: at
 * 3 m/s, −50…0° (CMU, jogging at 3.1 m/s: −48…−8°).
 */
const JOG_ARM_SWING_BACK = 1;
/** Running, the arms swing further forward: the hand reaches the chest (centre of the swing, × amplitude). */
const RUN_ARM_SWING_BACK = 0.5;
/** Maximum of the increase of the arm swing with speed (×armSwing). */
const MAX_ARM_SWING_GAIN = 1.4;
/**
 * Running, the foot in the air limits the height of the hips (as a leg that has to reach it) during the first
 * SWING_REACH_EARLY of the swing and from SWING_REACH_LATE on. Running fast (pace 1), those windows shrink by
 * FAST_SWING_REACH (the late one, 0.6 of that towards the end).
 */
const SWING_REACH_EARLY = 0.35;
const SWING_REACH_LATE = 0.5;
const FAST_SWING_REACH = 0.7;
/**
 * Running, the foot in the air follows the shin (see swingAnkle) from SWING_ANKLE_IN of the swing on, and until
 * SWING_ANKLE_OUT it blends back to the swing's own orientation (that of landing). Right after toe-off the ankle is
 * extended SWING_ANKLE_EXTENSION beyond the rest pose (CMU jogging: ~25°), and it returns to neutral.
 */
const SWING_ANKLE_IN = 0.2;
const SWING_ANKLE_OUT = 0.7;
const SWING_ANKLE_EXTENSION = (25 * Math.PI) / 180;
/** Landing from a jump, the leading foot lifts off at least this much (cycle fraction) after the trailing one. */
const LANDING_LIFT_GAP = 0.03;
/** Running, the hands close into a loose fist: `fingerCurl` times this. */
const RUN_FINGER_CURL = 3.2;
/** Running blend from which it doesn't touch (and lets go): the hand doesn't rest on things while running. */
const TOUCH_MAX_RUN_BLEND = 0.3;
/** Smoothing of how fast the ground under the body rises or falls (s; for touching, see `climb`). */
const CLIMB_TIME = 0.2;
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
/**
 * Narrow paths (see NarrowPath): it measures the path this far ahead of the body (× stepLength), or where the
 * body will be in NARROW_LOOKAHEAD s if that is further (going fast, it slows down before reaching the path), every
 * NARROW_PROBE_INTERVAL s while moving and every NARROW_IDLE_INTERVAL s standing still; ground lower than the
 * body's by NARROW_DROP (see NarrowPath) is a drop.
 */
const NARROW_AHEAD = 0.5;
const NARROW_LOOKAHEAD = 0.5;
const NARROW_PROBE_INTERVAL = 0.25;
const NARROW_IDLE_INTERVAL = 1;
/**
 * Balancing, the foot in the air passes the planted ankle at least this far to its own side (× stepLength): with
 * the feet in line, the swing goes slightly round the stance leg instead of through it.
 */
const NARROW_SWING_CLEARANCE = 0.1;
/** Balancing and walking, how fast the body moves towards the middle of the path (1/s). */
const NARROW_CENTERING = 2;
/**
 * Width of the foot (× its length from the back of the heel to the toe joint): standing on a narrow path, the feet
 * are at least this far apart (they don't overlap).
 */
const FOOT_WIDTH = 0.5;
/** Balancing, the fingers almost straight (see `fingerCurl`): open hands, as people do. */
const NARROW_FINGER_CURL = 0.3;
/** How often the balance corrections of the arms change (≈ times per second). */
const NARROW_TILT_RATE = 0.6;
/** On a narrow path, the body is turned off it beyond this angle (cosine; 15°): see probeDirection. */
const NARROW_TURNED = Math.cos(Math.PI / 12);
/**
 * On a narrow path, the sides it can't step down from (looked for FOOT_WIDTH past the edge): going towards one (more
 * than NARROW_ALONG off the path: sine, 15°), the body stops NARROW_SIDE_ROOM from its edge (× foot length), and closer
 * to it, it goes back (see narrowRoom).
 */
const NARROW_ALONG = Math.sin((15 * Math.PI) / 180);
const NARROW_SIDE_ROOM = 0.25;
/**
 * Stopped facing such a side, it doesn't start again with less room than this (× foot length): each measure of the
 * path moves its middle a little, and with a few millimetres it took loose steps against the edge.
 */
const NARROW_RESTART = 0.1;
/** Steps that land this close to `standTarget` (× stepLength) land there as planned. */
const STAND_REACH = 0.5;
/** …and no further ahead of it or behind it than this (× stepLength): on the path, not past it. */
const STAND_OVERSHOOT = 0.06;
/**
 * Balancing, the feet are settled with this much less sideways error (fraction of idleStepThreshold), for the
 * first NARROW_SETTLE_STEPS steps without moving: then as usual (the middle of the path, measured again and again,
 * moves a little, and with the tighter limit it kept stepping on the spot).
 */
const NARROW_SETTLE = 0.6;
const NARROW_SETTLE_STEPS = 4;
/**
 * Along a ledge: fewest steps per second (short, quick steps), fraction of the cycle with each foot on the ground (long
 * double support: the weight goes from one foot to the other slowly), how much more the body goes over the stance
 * foot (× lateralShift), the swing height (× stepHeight) and how much the foot rolls (heel strike and lift, × theirs):
 * it barely lifts the feet.
 */
const LEDGE_STEP_FREQUENCY = 2.2;
const LEDGE_DUTY = 0.72;
const LEDGE_LATERAL_SHIFT = 1.8;
const LEDGE_STEP_HEIGHT = 0.6;
const LEDGE_ROLL = 0.15;
/**
 * It looks for the wall behind the body up to this far (× stepLength), behind the hips and this far to each side
 * (× stepLength; the back is ~30 cm wide: it sees a bump in the wall before the hips get to it, and keeps off it until
 * the whole back has passed it), and moves the body towards the distance at which its back touches it this fast (1/s).
 */
const LEDGE_WALL_REACH = 0.8;
const BACK_HALF_WIDTH = 0.18;
/**
 * Along a ledge, the palms rest on the wall behind: each one LEDGE_HAND_SPREAD to the side of the hips and
 * LEDGE_HAND_HEIGHT above them (× stepLength; negative = below), the fingers pointing down and LEDGE_FINGERS_OUT out
 * to the side (rad). The wall is looked for in a band of ±LEDGE_HAND_BAND (× stepLength) around that height.
 */
const LEDGE_HAND_SPREAD = 0.4;
const LEDGE_HAND_HEIGHT = -0.08;
const LEDGE_FINGERS_OUT = (25 * Math.PI) / 180;
const LEDGE_HAND_BAND = 0.1;
const LEDGE_CENTERING = 8;
/**
 * Against an irregular wall, how much the trunk leans (back or forward) to keep both the hips and the shoulder
 * blades on it (rad, at most), and how fast it follows the wall (s).
 */
const LEDGE_MAX_LEAN = 10 * DEG;
const LEDGE_LEAN_TIME = 0.2;
/** …and how far the hips go back to touch a wall that the chest touches first (× stepLength, at most). */
const LEDGE_MAX_HIP_BACK = 0.12;
/**
 * Asked to go in a direction less than this (cosine; 70°) along the ledge (into the wall or towards the drop), it
 * doesn't move.
 */
const LEDGE_MIN_ALONG = Math.cos((70 * Math.PI) / 180);
/**
 * Asked to go off a ledge, it looks for ground that way beyond the edge of the ledge, this much further (× stepLength):
 * in the middle of a ledge it finds the drop, and at its end the platform it leads to (see leavesLedge).
 */
const LEDGE_EXIT_PROBE = 0.3;
/** The most it looks for ground that way (× stepLength), asked to leave a ledge in a shallow diagonal. */
const LEDGE_EXIT_MAX = 2;
/**
 * Leaving a ledge, it keeps to ledgeMaxSpeed for this many steps, and then speeds up at this fraction of
 * `acceleration`. The foot on the ground had landed with the slow cadence and long stance of the ledge: speeding up at
 * once (and at the usual acceleration, in one step), it stayed behind and the next step was very long (1–1.2 m).
 */
const LEDGE_EXIT_STEPS = 2;
const LEDGE_EXIT_ACCELERATION = 1 / 3;
/**
 * Getting on a ledge, it turns its back to the wall only once it has slowed down to this many times ledgeMaxSpeed:
 * turning at walking speed, the foot on the side of the drop landed beyond the edge and, moved back onto the ledge,
 * crossed the other one, and the other one went into the wall.
 */
const LEDGE_TURN_SPEED = 1.3;
/** Along a ledge, asked to go less than this off it (rad), it goes the way asked instead of exactly along it. */
const LEDGE_ASKED_SNAP = (15 * Math.PI) / 180;
/** Getting on a ledge, the facing follows the measures of the wall with this time constant (s). */
const LEDGE_FACING_TIME = 0.4;
/** If the ledge turns more than this (cosine; 20°), the body turns with it; less, it keeps facing the same way. */
const LEDGE_REFACE = Math.cos((20 * Math.PI) / 180);
/** Along a ledge, the head looks this much down (rad), and the fingers are open (see `fingerCurl`). */
const LEDGE_GAZE_DOWN = 8 * DEG;
const LEDGE_FINGER_CURL = 0.45;
/** The ankle at least this far from the wall, from the back of the heel, and from the edge, from the toes (m). */
const LEDGE_FOOT_MARGIN = 0.01;
/**
 * Without the mesh, how far the back sticks out behind the hips bone: at the hips and at the chest (× height of the
 * hips; 13 and 12 cm in an adult: standing against a wall, the buttocks and the shoulder blades touch it).
 */
const BACK_HIPS = 0.14;
const BACK_CHEST = 0.13;
const UP = new Vector3(0, 1, 0);
/** Difference relative to the step length below which two measurements are considered equal. */
const TIE_TOLERANCE = 1e-9;

interface LegRuntime {
  ik: LegIK;
  roll: FootRoll;
  /** Angle between the shin (knee → ankle) and the foot (ankle → toes on the ground) in the rest pose (rad). */
  restAnkle: number;
  /** Height of the ankle above the ground in the rest pose (m). */
  ankleHeight: number;
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
  /**
   * How far the body will still travel (m; Infinity = no limit): with a `moveTo`, up to the destination. The
   * touch gesture predicts where the shoulder will be with it (see predictTravel).
   */
  travelLimit = Number.POSITIVE_INFINITY;
  /**
   * Where it is about to stand (world; NaN x = nowhere in particular): getting onto a low narrow path from its side
   * (see PathPlanner), the steps that land near it go there as planned. As a tread, the path is shallower than the
   * foot, and the stairs would put the foot past it, on the ground on the other side.
   */
  readonly standTarget = new Vector3(Number.NaN, 0, 0);
  /** Obstacles that aren't ground (see Colliders): it doesn't go through them; null = none. */
  colliders: Colliders | null = null;

  /** Desired crouch (0 = standing, 1 = fully crouched). */
  targetCrouch = 0;
  /** Agachado actual: sigue al deseado a velocidad limitada (config.crouchRate). */
  crouch = 0;
  /** Narrow paths: what it found under and ahead of the body (see NarrowPath). */
  readonly narrowPath: NarrowPath;
  /** How much it is balancing on a narrow path (0–1): follows the path at `narrowRate`. */
  balance = 0;
  /** Tilt of the arms balancing (degrees, + = right arm up), from the last update. */
  balanceTilt = 0;
  /** Ledges: what it found ahead of and beside the body (see Ledge). */
  readonly ledgePath: Ledge;
  /** How much it is going along a ledge with its back to the wall (0–1): follows the ledge at `ledgeRate`. */
  ledgeBlend = 0;

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
  /** Highest ground under the toes along the planned swing of each foot (m, world; see swingHeight). */
  private readonly swingGround: Record<Side, number> = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };
  private readonly ankleAxis = new Vector3();
  private readonly ankleShin = new Vector3();
  private readonly ankleFoot = new Vector3();
  private readonly ankleToe = new Vector3();
  private readonly ankleQ = new Quaternion();
  private readonly ankleRotation = new Quaternion();
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
  /** Slope of the stairs under the body (rise / run, smoothed like `stairLean`). */
  private stairSlope = 0;
  /** Glance down at the first step of a flight (rad, smoothed), the change of level ahead (m) and when to look again (s). */
  private glance = 0;
  private levelAhead = 0;
  private glanceProbe = 0;
  /** Time left until the next look at the path across (s; see NarrowPath). */
  private narrowProbe = 0;
  /** Steps in a row without moving (recolocating the feet); see NARROW_SETTLE_STEPS. */
  private stillSteps = 0;
  private readonly narrowAlong = new Vector3();
  /** Time left until the next look across for a ledge (s), and which way it looks standing still (see updateLedge). */
  private ledgeProbe = 0;
  /** On a ledge (or one detected ahead) this frame: it brakes to ledgeMaxSpeed at once, not as `ledgeBlend` rises. */
  private ledgeOn = false;
  /** Leaving a ledge: steps left at ledgeMaxSpeed, and the speed limit as it speeds up (see LEDGE_EXIT_STEPS). */
  private ledgeLeaving = 0;
  private ledgeExitLimit = Number.POSITIVE_INFINITY;
  private ledgeIdleAcross = false;
  /** Along a ledge: where the body faces (away from the wall; world, unit), and whether it is set. */
  private readonly ledgeFacing = new Vector3();
  private ledgeFaced = false;
  /** Bands of the back (height above the ground, m) and how far it sticks out behind the root there (m). */
  private readonly backBand: { hips: [number, number]; chest: [number, number] };
  private readonly backDepth: { hips: number; chest: number };
  /**
   * Where the wall is behind the hips (m along `ledgeFacing`, world; −Infinity = none within reach) in each band (hips,
   * chest), behind them and to each side (BACK_HALF_WIDTH): 6 samples, one measured each frame (`wallSample`, the next).
   */
  private readonly wallSamples: number[] = new Array<number>(6).fill(Number.NEGATIVE_INFINITY);
  private wallSample = 0;
  /** Where the wall is behind each hand along a ledge (m along `ledgeFacing`, like `wallSamples`); one measured per frame. */
  private readonly handWall: Record<Side, number> = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };
  private handWallSide: Side = 'left';
  private readonly handAt = new Vector3();
  private readonly handRight = new Vector3();
  private readonly handFingers = new Vector3();
  /** Along an irregular wall: lean of the trunk (rad, + forward) and how far the hips go back (m). */
  private ledgeLean = 0;
  private ledgeHipBack = 0;
  private readonly ledgeRays = { count: 0 };
  private readonly ledgeExit = new Vector3();
  private readonly ledgeTravel = new Vector3();
  private readonly ledgeExitAlong = new Vector3();
  private readonly ledgeExitProbe = new Vector3();
  private readonly ledgeAlong = new Vector3();
  private readonly wanted = new Vector3();
  /** How much it is going down stairs (0–1), following the slope (see STAIR_DOWN_FREQUENCY). */
  private stairDescent = 0;
  /** How fast the ground under the body rises (m/s, smoothed; − going down) and the root height last frame. */
  private climb = 0;
  private lastRootHeight = Number.NaN;
  /** Heel lift of each foot pushing off up some stairs (rad, 0 = none; see pushOffStairs). */
  private readonly pushOff: Record<Side, number> = { left: 0, right: 0 };
  /** Highest ankle of each foot for the reach limit of the hips (see pushOffStairs). */
  private readonly reachAnkles: Record<Side, Vector3> = { left: new Vector3(), right: new Vector3() };
  private readonly pushPosition = new Vector3();
  private readonly pushHip = new Vector3();
  private readonly stairCenter = new Vector3();
  private readonly turnDirection = new Vector3();
  private readonly landingDirection = new Vector3();
  private readonly backOff = new Vector3();
  private readonly away = new Vector3();
  private readonly stairTangent = new Vector3();
  private readonly pushRotation = new Quaternion();

  /** In the air: how far the legs have already extended towards the landing (0–1). */
  private landingPrep = 0;
  private readonly legs: Record<Side, LegRuntime>;
  private readonly qRoot = new Quaternion();
  private readonly tmp = new Vector3();
  private readonly footAxis = new Vector3();
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
      const roll = new FootRoll(leg, rig.root);
      const ankle = leg.foot.getWorldPosition(new Vector3());
      const shin = ankle.clone().sub(leg.shin.getWorldPosition(new Vector3()));
      const toe = roll.toeLocal.clone().applyQuaternion(leg.foot.getWorldQuaternion(new Quaternion()));
      return {
        ik: new LegIK(leg, forward),
        roll,
        restAnkle: shin.angleTo(toe),
        ankleHeight: -toe.y,
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
    // Hasta dónde llegan la punta y el talón, medidos en la malla del modelo (el más largo de los dos pies).
    const measured = measureFeet(rig, forward);
    const extent = measured.left && measured.right
      ? { front: Math.max(measured.left.front, measured.right.front), back: Math.max(measured.left.back, measured.right.back) }
      : (measured.left ?? measured.right);
    this.stairs = new StairPlanner(detector, config, (footLength('left') + footLength('right')) / 2, extent);
    this.narrowPath = new NarrowPath(detector);
    this.ledgePath = new Ledge(detector);
    this.backBand = backBands(rig);
    const hipsHeight = this.backBand.hips[1] / 1.1;
    this.backDepth = measureBack(rig, forward) ?? { hips: BACK_HIPS * hipsHeight, chest: BACK_CHEST * hipsHeight };
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
    this.narrowPath.shift(offset);
    this.ledgePath.shift(offset);
    this.lastRootHeight += offset.y;
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
    this.planner.widthOverride = null;
    this.planner.syncStepWidth();
    this.crouch = Math.min(Math.max(this.targetCrouch, 0), 1);
    this.jumping.reset();
    this.landingPrep = 0;
    this.settleBlend = 1;
    this.settleCheck.valid = false;
    this.lastFootDt = 0;
    this.stairs.reset();
    this.narrowPath.reset();
    this.standTarget.x = Number.NaN;
    this.narrowProbe = 0;
    this.stillSteps = 0;
    this.balance = 0;
    this.balanceTilt = 0;
    this.ledgePath.reset();
    this.ledgeBlend = 0;
    this.ledgeProbe = 0;
    this.ledgeFaced = false;
    this.ledgeOn = false;
    this.ledgeLeaving = 0;
    this.ledgeExitLimit = Number.POSITIVE_INFINITY;
    this.ledgeLean = 0;
    this.ledgeHipBack = 0;
    this.wallSamples.fill(Number.NEGATIVE_INFINITY);
    this.handWall.left = this.handWall.right = Number.NEGATIVE_INFINITY;
    this.planner.landingShift.set(0, 0, 0);
    this.stairLimit = Number.POSITIVE_INFINITY;
    this.stairLean = 0;
    this.stairSlope = 0;
    this.glance = 0;
    this.levelAhead = 0;
    this.glanceProbe = 0;
    this.stairDescent = 0;
    this.climb = 0;
    this.lastRootHeight = Number.NaN;
    this.gait.minFrequency = 0;
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
      const turning = this.body.state.turnRate;
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
    // Sobre un camino angosto, a su nivel: el suelo es el suyo (ver StairPlanner.level).
    this.stairs.level = this.onNarrowPath();
    this.stairs.update(dt);
    this.updateStairDescent(dt);
    this.syncPlacementConfig();
    this.updateNarrow(dt);
    const ledgeStop = this.updateLedge(dt);
    this.planner.syncStepWidth();

    // 0. Agachado: el nivel actual sigue al deseado; agachado se va más despacio.
    const crouchTarget = Math.min(Math.max(this.targetCrouch, 0), 1);
    const crouchStep = this.config.crouchRate * dt;
    this.crouch += Math.max(-crouchStep, Math.min(crouchStep, crouchTarget - this.crouch));
    const k = smoothstep(this.crouch);
    const kb = smoothstep(this.balance);
    const kl = smoothstep(this.ledgeBlend);
    this.body.speedLimit = Math.min(
      this.config.runSpeed + (this.config.crouchMaxSpeed - this.config.runSpeed) * k,
      this.config.runSpeed + (this.config.narrowMaxSpeed - this.config.runSpeed) * kb,
      // En cuanto ve la cornisa (por delante): frena ya, para llegar despacio y girar sin cruzar los pies.
      this.ledgeExitLimit,
      this.ledgeOn ? this.config.ledgeMaxSpeed : this.config.runSpeed + (this.config.ledgeMaxSpeed - this.config.runSpeed) * kl,
      ledgeStop ? 0 : Number.POSITIVE_INFINITY,
      this.stairSpeedLimit(dt),
    );
    this.centerOnPath(dt, kb);
    this.keepBackToWall(dt, kl);
    // De espaldas a la pared, el cuerpo ya está a la distancia de ella que toca la espalda (no se aparta).
    if (kl <= 0) this.backOffWall(dt);
    this.slideOffColliders();

    // 1–2. Cuerpo: velocidad y avance de la raíz sobre el suelo. Las caderas vuelven a su pose de
    //      reposo sin recalcular matrices: el cuerpo actualiza después todo el esqueleto.
    this.pelvis.reset(false);
    this.body.update(dt);
    // Lo paró un desnivel que no conocía: lo recuerda (para apartar los pies y retroceder de él).
    if (this.body.ledge.lengthSq() > 0) {
      this.stairs.noteLedge(this.body.state.position, this.body.ledge, this.body.state.groundHeight);
    }
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
      const angularSpeed = Math.abs(this.body.state.turnRate);
      for (const event of this.gait.update(dt, this.speed, angularSpeed)) {
        const foot = feet[event.side];
        if (event.type === 'touchdown') {
          this.ledgeLeaving = Math.max(this.ledgeLeaving - 1, 0);
          foot.planted.copy(foot.swing.landing);
          foot.plantedRotation.copy(foot.swing.landingRotation);
          this.pivotApplied[event.side] = 0;
          this.landed[event.side] = true;
          foot.steps++;
          // Sin moverse ni girar: girando en el sitio aún no está recolocando los pies.
          const still = this.speed < IDLE_SPEED * this.config.walkSpeed && !this.body.isTurning();
          this.stillSteps = still ? this.stillSteps + 1 : 0;
          // Apoyo según la mayor de la velocidad de ahora y la que habrá al despegar: acelerando a
          // través de la transición, un pie que aterriza caminando pero despegará corriendo no se queda
          // apoyado de más; frenando, tampoco uno colocado para la velocidad de ahora (en ambos casos la
          // pierna de atrás se estiraba y las caderas se hundían).
          this.body.predict(this.gait.stanceDuration(this.speed, angularSpeed), this.midStanceDisplacement, this.midStanceVelocity);
          const fastest = Math.max(this.speed, this.midStanceVelocity.length());
          const duty = this.gait.dutyAt(fastest);
          // Bajando una escalera, el pie de atrás despega antes (menos tiempo apoyado). De espaldas a la pared, más tiempo
          // con los dos pies apoyados: el peso pasa de uno a otro despacio.
          const stairDuty = duty + (Math.min(STAIR_DOWN_DUTY, duty) - duty) * this.stairDescent;
          this.gait.duty[event.side] = stairDuty + (Math.max(LEDGE_DUTY, stairDuty) - stairDuty) * smoothstep(this.ledgeBlend);
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
          evaluateSwing(foot.swing, foot.swing.t, foot.swing.height, foot.position, foot.rotation, 1 - this.gait.blend, this.gait.pace);
          // En una cornisa, el pie en el aire tampoco se acerca a la pared más que donde se apoya (ver keepOnLedge): su
          // desvío para rodear el pie de apoyo iba hacia ella, con los dos pies pegados, y la atravesaba.
          if (this.ledgeFaced && this.ledgeBlend > 0) {
            const min = this.stairs.heelBack + LEDGE_FOOT_MARGIN;
            const d = this.ledgePath.fromWall(foot.position);
            if (d < min) foot.position.addScaledVector(this.ledgePath.out, (min - d) * smoothstep(this.ledgeBlend));
          }
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
    // De espaldas a una pared irregular, las caderas hacia atrás si el pecho la toca antes (ver keepBackToWall).
    this.hipShift.copy(bodyState.shift).addScaledVector(bodyState.forward, -k * cfg.crouchHipBack - this.ledgeHipBack);
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
      // De espaldas a la pared, la pelvis no gira ni se balancea hacia delante (va de lado).
      rotation: this.gait.mode === 'idle' ? undefined : this.pelvisRotation() * (1 - kl),
      tilt: inAir ? 0 : this.pelvisTiltWave() * (1 - kl),
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
      if (foot.phase === 'SWING' && this.gait.blend > 0 && !inAir) this.swingAnkle(side);
      // En el aire tras un salto, los dedos vuelven a su reposo.
      if (inAir) this.toeBend[side] *= Math.exp(-dt / (TOE_RELAX * AIR_TUCK_TIME));
      leg.roll.bendToe(this.toeBend[side]);
    }
    // 8. Torso: contrarrotación, compensación, inclinación y cabeza estable.
    //    En escaleras, algo más inclinado (más subiendo que bajando).
    const slope = Math.min(Math.max(this.stairs.slope(bodyState.position, bodyState.travel), -1), 1);
    const stairLean = (slope > 0 ? STAIR_LEAN_UP * slope : -STAIR_LEAN_DOWN * slope) * DEG;
    this.stairLean += (stairLean - this.stairLean) * (1 - Math.exp(-dt / STAIR_LEAN_TIME));
    this.stairSlope += (slope - this.stairSlope) * (1 - Math.exp(-dt / STAIR_LEAN_TIME));
    // Mirar el primer escalón: un escalón por delante y todavía no en la escalera.
    const walking = !bodyState.airborne && bodyState.speed > 0.2 && this.gait.blend < 0.5;
    this.glanceProbe -= dt;
    if (!walking) this.levelAhead = 0;
    else if (this.glanceProbe <= 0) {
      this.glanceProbe = GLANCE_INTERVAL;
      const probe = this.tmp.copy(bodyState.position).addScaledVector(bodyState.travel, GLANCE_AHEAD * cfg.stepLength);
      probe.y = bodyState.groundHeight + cfg.groundProbeHeight;
      this.levelAhead = this.detector.castDown(probe, cfg.groundProbeHeight + cfg.groundProbeDepth, this.sampleHit)
        ? this.sampleHit.point.y - bodyState.groundHeight
        : 0;
    }
    const glance = walking && Math.abs(this.levelAhead) > GLANCE_STEP * cfg.maxStepUp && Math.abs(this.stairSlope) < 0.25 ? GLANCE : 0;
    this.glance += (glance - this.glance) * (1 - Math.exp(-dt / GLANCE_TIME));
    // De espaldas a la pared: el tronco no se inclina hacia delante (salvo para seguir una pared irregular, ledgeLean) y la
    // cabeza mira un poco hacia donde va y hacia abajo.
    const gaze = -Math.sign(bodyState.facingOffset) * kl * cfg.ledgeGaze * DEG;
    this.torso.update({
      forward: bodyState.forward,
      pelvis: this.pelvis.angles,
      acceleration: bodyState.acceleration * (1 - kl),
      turnRemaining: this.body.turnRemaining(),
      speed: bodyState.speed,
      angularVelocity: bodyState.angularVelocity,
      dt,
      extraLean: (((cfg.walkLean + (this.gait.run(cfg.jogLean, cfg.runLean) - cfg.walkLean) * this.gait.blend + k * cfg.crouchLean) * Math.PI) / 180 + this.jumping.lean() + this.variationNow.lean + this.stairLean) * (1 - kl) + this.ledgeLean,
      airborne: bodyState.airborne,
      headOffset: { yaw: this.variationNow.headYaw + gaze, pitch: this.variationNow.headPitch + this.glance + DOWN_GAZE * Math.max(-this.stairSlope, 0) + kb * cfg.narrowGaze * DEG + kl * LEDGE_GAZE_DOWN },
      headNod: 1 / (1 + STAIR_HEAD_STEADY * Math.abs(this.stairSlope)),
      running: this.gait.blend,
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
    // Tocar: caminando o parado, con los pies en el suelo. Subiendo o bajando (escaleras, rampas), lo que
    // sube el suelo bajo el cuerpo: dónde estará el hombro cuando llegue la mano (sin esto, subiendo una
    // escalera quedaba ~20 cm más arriba de lo previsto y la mano no llegaba a la baranda).
    const rootHeight = bodyState.position.y;
    if (bodyState.airborne) this.climb = 0;
    else if (dt > 0 && Number.isFinite(this.lastRootHeight)) {
      this.climb += ((rootHeight - this.lastRootHeight) / dt - this.climb) * (1 - Math.exp(-dt / CLIMB_TIME));
    }
    this.lastRootHeight = rootHeight;
    this.touch.update(this.touchMotion(dt), this.surfaces);
    this.braceOnWall(kl);
    // Haciendo equilibrio, con una mano apoyada en algo (una baranda, una pared) ya se sostiene: el otro brazo baja
    // casi a la pose normal (narrowTouchRelax) y deja de corregir.
    const steadied = Math.max(this.touch.weight('left'), this.touch.weight('right')) * c.narrowTouchRelax;
    const kArms = kb * (1 - steadied);
    // De espaldas a la pared: los brazos cuelgan junto al cuerpo, algo abiertos y hacia atrás (las manos en la pared), sin
    // balanceo.
    const balancing = (normal: number, narrow: number, ledge: number): number => {
      const value = normal + (narrow - normal) * kArms;
      return value + (ledge - value) * kl;
    };
    this.balanceTilt = kArms * c.narrowArmTilt * this.noise.sample(20, this.noiseTime * NARROW_TILT_RATE);
    this.arms.update({
      forward: bodyState.forward,
      feetAhead: this.tmp.subVectors(feet.right.position, feet.left.position).dot(bodyState.forward),
      // Corriendo del todo, la zancada a runSpeed (runStepLength es solo el máximo y la dejaría corta).
      stepLength: mix(c.walkSpeed / c.stepFrequency, this.gait.run(c.jogStepLength, Math.min(c.runSpeed / c.runStepFrequency, c.runStepLength))),
      dt,
      acceleration: bodyState.acceleration,
      swingScale: { left: this.variationNow.armLeft, right: this.variationNow.armRight },
      touch: { left: this.touch.weight('left'), right: this.touch.weight('right') },
      shoulderTilt: this.torso.shoulderLineTilt,
      // Corriendo, los brazos van a la par de la pierna contraria (caminando, algo detrás, como péndulos).
      lead: this.gait.blend,
      // Haciendo equilibrio: brazos abiertos, casi sin balanceo, con correcciones lentas (uno sube y el otro baja).
      pose: {
        armAbduction: balancing(relax(mix(c.armAbduction, c.runArmAbduction), c.idleArmAbduction), c.narrowArmAbduction, c.ledgeArmAbduction),
        elbowBend: balancing(relax(mix(c.elbowBend, c.runElbowBend), c.idleElbowBend), c.narrowElbowBend, c.ledgeElbowBend) + k * c.crouchElbowBend,
        armSwing: balancing(mix(walkSwing, this.gait.run(c.jogArmSwing, c.runArmSwing)), c.narrowArmSwing, 0),
        elbowSwingBend: balancing(mix(c.elbowSwingBend, c.runElbowSwingBend), 0, 0),
        armForward: balancing(relax(c.armForward, c.idleArmForward) - mix(ARM_SWING_BACK * walkSwing, this.gait.run(JOG_ARM_SWING_BACK * c.jogArmSwing, RUN_ARM_SWING_BACK * c.runArmSwing)), c.narrowArmForward, c.ledgeArmForward) + k * c.crouchArmForward + this.jumping.armForward(),
        abductionTilt: this.balanceTilt,
        fingerCurl: balancing(mix(c.fingerCurl, c.fingerCurl * RUN_FINGER_CURL), NARROW_FINGER_CURL, LEDGE_FINGER_CURL),
        armInward: balancing(mix(0, c.runArmInward), 0, 0),
      },
    });

    this.touch.apply();

    // 10. Torsión de brazos y piernas: reparte el giro axial que dejaron el IK y los brazos.
    this.twist.update();

    worldPosition(rig.hips, this.body.state.com);
  }

  /**
   * Stopped closer to a wall (or a drop) than the feet can stand from it (the guard of the body stopped it at
   * the edge, or it came along it): the root moves back away from it, slowly (WALL_BACK_OFF_SPEED), over the
   * feet, which keepOffWall already keeps that far. If not, the body leant over the edge and the feet,
   * which wanted to be under it, kept stepping.
   */
  /** Room of the body round the root, from colliders (m). */
  get bodyRadius(): number {
    return BODY_RADIUS * this.config.stepLength;
  }

  /** Height of the character for colliders (m): what is higher above its ground, it passes under. */
  get bodyHeight(): number {
    return BODY_HEIGHT * this.config.stepLength;
  }

  /**
   * Against colliders (see Colliders): if the root is closer to one than `bodyRadius`, it moves it out (the
   * next advance), so that it slides along it; and the more it goes towards it, the more it brakes (head-on, it
   * stops in front). What it can step on or pass under doesn't count.
   */
  private slideOffColliders(): void {
    const colliders = this.colliders;
    const s = this.body.state;
    if (!colliders || s.airborne) return;
    colliders.update();
    const ground = Number.isFinite(s.groundHeight) ? s.groundHeight : s.position.y;
    const room = this.bodyRadius;
    const away = this.away;
    const d = colliders.distance(s.position.x, s.position.z, ground + this.config.maxStepUp, ground + this.bodyHeight, away);
    if (d >= room) return;
    this.body.drift.addScaledVector(away, room - d);
    const into = -(s.travel.x * away.x + s.travel.z * away.z);
    if (into > 0) this.body.speedLimit = Math.min(this.body.speedLimit, this.config.walkSpeed * (1 - into));
  }

  private backOffWall(dt: number): void {
    const s = this.body.state;
    if (s.airborne || s.speed > WALL_BACK_OFF_BELOW) return;
    const ground = Number.isFinite(s.groundHeight) ? s.groundHeight : s.position.y;
    const push = this.stairs.wallPush(s.position, this.stairs.toeFront + this.stairs.heelBack, this.backOff, ground);
    if (push <= 0) return;
    this.body.drift.copy(this.backOff).multiplyScalar(Math.min(WALL_BACK_OFF_SPEED * dt, push) / push);
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
    // Hacia donde va y hacia donde está girando: girando hacia la pared muy cerca de ella, cuando la tenía de
    // frente ya no le daba para frenar.
    const s = this.body.state;
    // De espaldas a la pared de una cornisa que sigue por delante, sus bordes (la pared y el del vacío) los lleva la
    // cornisa (el cuerpo contra la pared, los pies en ella): esta guarda mide en perpendicular al borde que cruce la línea
    // de avance y, con ellos casi paralelos y a ~15 cm, unos grados de desvío lo paraban en seco, sin salida. Donde la
    // cornisa se acaba (o la cierra una pared), la guarda vuelve.
    if (this.onLedge() && this.ledgePath.ledge) return limit;
    const turning = this.turnDirection.copy(s.travel).applyAxisAngle(UP, this.body.headingTarget - s.heading);
    // Se para con los pies delante de la contrahuella: las puntas, a un talón de ella. Medido perpendicular al
    // borde: llegando en diagonal, la raíz quedaba más cerca de él de lo que pueden apoyar los pies, que se
    // quedaban atrás (el cuerpo, inclinado sobre el borde) y se recolocaban sin parar.
    const clearance = stairs.toeFront + stairs.heelBack;
    // Desde el suelo bajo la raíz (en una escalera, la raíz va por una línea entre los escalones).
    const ground = Number.isFinite(s.groundHeight) ? s.groundHeight : s.position.y;
    // En un camino angosto, también sus costados que no se pueden bajar: girando hacia uno, aún no lo conocía como
    // borde, iba hasta él y los pasos (por delante del cuerpo) caían fuera.
    const side = Math.min(this.narrowRoom(s.travel), this.narrowRoom(turning));
    const ahead = Math.min(stairs.wallAhead(s.position, s.travel, clearance, ground), stairs.wallAhead(s.position, turning, clearance, ground), side);
    if (Number.isFinite(ahead)) {
      // Con la mitad de la deceleración: la frenada tiene una rampa (speedEasing) y se pasaba.
      const room = Math.max(ahead, 0);
      limit = Math.min(limit, Math.sqrt(this.config.deceleration * room));
    }
    return limit;
  }

  /**
   * How much it is going down stairs (`stairDescent`, 0–1): from the slope of the line over the treads in
   * the direction of travel, followed smoothly. It sets the cadence, the stance and the knees of the descent.
   */
  private updateStairDescent(dt: number): void {
    const s = this.body.state;
    const target = Math.min(Math.max(-this.stairs.slope(s.position, s.travel) / STAIR_DOWN_SLOPE, 0), 1);
    this.stairDescent += (target - this.stairDescent) * (1 - Math.exp(-dt / STAIR_LEAN_TIME));
    this.gait.minFrequency = STAIR_DOWN_FREQUENCY * this.stairDescent;
  }

  private syncPlacementConfig(): void {
    this.placementConfig.castHeight = this.config.footProbeHeight;
    this.placementConfig.castDepth = this.config.footProbeDepth;
    this.placementConfig.toeTolerance = this.config.footProbeTolerance;
  }

  /**
   * The body's prediction (BodyController.predict) for the touch gesture: displacement in `t` s into `out`, up to
   * `travelLimit`, and the turn (rad).
   */
  private readonly predictTravel = (t: number, out: Vector3): number => {
    const yaw = this.body.predict(t, out, this.predictVelocity);
    const length = out.length();
    if (length > this.travelLimit) out.multiplyScalar(this.travelLimit / length);
    return yaw;
  };
  private readonly predictVelocity = new Vector3();

  /** What the touch gesture needs from the body at this moment. */
  touchMotion(dt = 0): TouchMotion {
    const state = this.body.state;
    return {
      dt,
      forward: state.forward,
      velocity: state.velocity,
      climb: this.climb,
      // De espaldas a la pared de una cornisa, no: las manos ya van en ella.
      allowed: !state.airborne && this.jumping.phase === 'GROUNDED' && this.gait.blend < TOUCH_MAX_RUN_BLEND && this.ledgeBlend <= 0,
      still: this.gait.mode === 'idle',
      position: state.position,
      turnRate: state.turnRate,
      predict: this.predictTravel,
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
    // Haciendo equilibrio, los pies se recolocan con menos desvío de lado: en un camino angosto, 2 cm sobran. Solo los
    // primeros pasos sin moverse (ver NARROW_SETTLE_STEPS).
    const tight = this.stillSteps < NARROW_SETTLE_STEPS ? NARROW_SETTLE * smoothstep(this.balance) : 0;
    const maxAcross = c.idleStepThreshold * (1 - tight);
    const onPath = this.onNarrowPath();
    let along = 0;
    for (const side of SIDES) {
      // Sobre una escalera, el sitio del pie es el de la huella (sin raycasts de más, ver StairPlanner); si
      // no es donde está, se recoloca aunque esté poco adelantado: estaría pisando un borde.
      let onTread = false;
      const e = this.planner.settleError(this.feet[side], this.settleOffset, (target, rotation) => {
        if (this.onLedge()) {
          if (this.keepOnLedge(target)) this.planner.placeLanding(side, target, 0, target, rotation);
        } else if (!onPath) onTread = this.planStairLanding(side, this.feet[side].planted, 0, target, rotation, false);
        else this.keepOnPath(target, 0);
      });
      const ahead = this.settleOffset.dot(forward);
      const across = Math.sqrt(Math.max(e.distance * e.distance - ahead * ahead, 0));
      const maxAhead = onTread ? c.idleStepThreshold : maxStagger;
      if (across >= maxAcross || Math.abs(ahead) >= maxAhead || e.angle >= maxAngle) return false;
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

    const angularSpeed = Math.abs(this.body.state.turnRate);
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
    // Ya sobre un camino angosto, no: el perfil del suelo, en diagonal a él (girando), lo veía como un escalón y
    // ponía el pie en el suelo de al lado. Subiendo a él, sí (si no, el paso podía saltar una viga baja).
    const stand = this.standTarget;
    const standing = !Number.isNaN(stand.x) && Math.hypot(swing.landing.x - stand.x, swing.landing.z - stand.z) < STAND_REACH * this.config.stepLength;
    if (standing) {
      // A no más de STAND_OVERSHOOT de él, por delante o por detrás: el paso adelantado caía al otro lado del camino,
      // y el de atrás, recolocándose, antes de su borde.
      const f = this.body.state.travel;
      const ahead = (swing.landing.x - stand.x) * f.x + (swing.landing.z - stand.z) * f.z;
      const limit = STAND_OVERSHOOT * this.config.stepLength;
      const past = ahead - clamp(ahead, -limit, limit);
      if (past !== 0) {
        this.tmp.copy(swing.landing).addScaledVector(f, -past);
        this.planner.placeLanding(foot.side, this.tmp, footYaw, swing.landing, swing.landingRotation);
      }
    } else if (this.onLedge()) {
      // De espaldas a la pared de una cornisa: el pie entero en ella (la escalera vería un escalón en el borde).
      if (this.keepOnLedge(swing.landing)) this.planner.placeLanding(foot.side, swing.landing, footYaw, swing.landing, swing.landingRotation);
    } else if (this.onNarrowPath()) {
      // Sobre él, con el pie entero dentro: girando hacia un costado, el paso (por delante del cuerpo) caía fuera, en el
      // aire. Bajando de él por un costado (una viga baja), como un escalón: al suelo de al lado.
      const on = this.keepOnPath(swing.landing, footYaw);
      if (on === 'moved') this.planner.placeLanding(foot.side, swing.landing, footYaw, swing.landing, swing.landingRotation);
      else if (on === 'off') this.planStairLanding(foot.side, swing.start, footYaw, swing.landing, swing.landingRotation);
    } else this.planStairLanding(foot.side, swing.start, footYaw, swing.landing, swing.landingRotation);
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
   * Direction the narrow path is looked at across: the one of travel or, on a narrow path with the body turned more
   * than NARROW_TURNED off it, the path itself (towards the side the body faces). Turning on the spot on it, across
   * the body was along the path: it stopped seeing it and, still on it, stopped balancing; walking at an angle to it,
   * the point ahead was off it and it took it for its end. Going along it, the direction of travel (its measure of the
   * path doesn't feed back on itself).
   */
  private probeDirection(): Vector3 {
    const f = this.body.state.travel;
    if (!this.narrowPath.narrow) return f;
    const a = this.narrowPath.across;
    const along = this.narrowAlong.set(a.z, 0, -a.x);
    if (along.dot(f) < 0) along.negate();
    return along.dot(f) > NARROW_TURNED ? f : along;
  }

  /** Balancing on a narrow path, with the body already at its level (not stepping onto it). */
  private onNarrowPath(): boolean {
    const s = this.body.state;
    if (this.balance < 0.5 || !this.narrowPath.narrow || !Number.isFinite(s.groundHeight)) return false;
    return Math.abs(s.groundHeight - this.narrowPath.center.y) < (NARROW_DROP / 2) * this.config.stepLength;
  }

  /** On side `side` of the narrow path (+1 towards `across`, −1 against it), it can't step down (see NarrowPath). */
  private narrowDropsAway(side: number): boolean {
    const foot = this.stairs.toeFront + this.stairs.heelBack;
    return this.narrowPath.dropsAway(side, this.config.maxStepDown, FOOT_WIDTH * foot, this.config.groundProbeHeight);
  }

  /** Farthest the body goes from the middle of the narrow path towards a side it can't step down from (m). */
  private narrowLine(): number {
    const foot = this.stairs.toeFront + this.stairs.heelBack;
    return Math.max(this.narrowPath.width / 2 - NARROW_SIDE_ROOM * foot, 0);
  }

  /**
   * On a narrow path, how far the body can go in `direction` (horizontal, unit) before it is further than
   * `narrowLine` from the middle, towards a side it can't step down from; Infinity going along the path (within
   * NARROW_ALONG), towards a side it can step down from (off a low beam, to the ground beside it) or off the path.
   */
  private narrowRoom(direction: Vector3): number {
    if (!this.onNarrowPath()) return Number.POSITIVE_INFINITY;
    const path = this.narrowPath;
    const c = direction.x * path.across.x + direction.z * path.across.z;
    if (Math.abs(c) < NARROW_ALONG) return Number.POSITIVE_INFINITY;
    const side = Math.sign(c);
    if (!this.narrowDropsAway(side)) return Number.POSITIVE_INFINITY;
    const s = this.body.state;
    const room = this.narrowLine() + side * path.offset(s.position);
    const foot = this.stairs.toeFront + this.stairs.heelBack;
    if (s.speed < IDLE_SPEED * this.config.walkSpeed && room < NARROW_RESTART * foot) return 0;
    return room / Math.abs(c);
  }

  /**
   * On a narrow path: moves `target` (where a foot lands, turned `yaw` from the body) across the path so that the
   * whole foot is on it, from the back of the heel to the toe joint; if it doesn't fit (turned across a beam), centred
   * on it. Never closer to the middle than half its width sideways: standing, the two feet together don't overlap
   * (on a path narrower than them, they stick out). Not towards a side it can step down from: stepping off a low beam
   * sideways, held on it, the foot was left behind and then took a very long step. Returns 'on' (it was on it),
   * 'moved' or 'off' (off it towards a side it can step down from; as it was).
   */
  private keepOnPath(target: Vector3, yaw: number): 'on' | 'moved' | 'off' {
    const path = this.narrowPath;
    const a = path.across;
    const f = this.footAxis.copy(this.body.state.forward).applyAxisAngle(UP, yaw);
    // El pie, a lo ancho del camino: su largo (del talón a la articulación de los dedos) y su ancho, proyectados.
    const fa = f.x * a.x + f.z * a.z;
    const sideways = (FOOT_WIDTH * (this.stairs.toeFront + this.stairs.heelBack) * Math.sqrt(Math.max(1 - fa * fa, 0))) / 2;
    const back = -this.stairs.heelBack * fa;
    const front = this.stairs.toeFront * fa;
    const lo = Math.min(back, front) - sideways;
    const hi = Math.max(back, front) + sideways;
    // Dónde puede ir el tobillo, respecto del medio (hacia `across`).
    const edge = path.width / 2;
    let min = -edge - lo;
    let max = edge - hi;
    if (min > max) min = max = (min + max) / 2;
    min = Math.min(min, -sideways);
    max = Math.max(max, sideways);
    const lateral = -path.offset(target);
    const move = clamp(lateral, min, max) - lateral;
    if (move === 0) return 'on';
    if (!this.narrowDropsAway(-Math.sign(move))) return 'off';
    target.addScaledVector(a, move);
    return 'moved';
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
    // Hasta dónde tiene que ver una pared (o un desnivel que no puede bajar) para frenar a tiempo delante de
    // ella: lo que avanza hasta el paso siguiente, lo que tarda en frenar (con el límite de stairSpeedLimit)
    // y el pie. Para buscarla, con la velocidad a la que va si es más que la de ahora (arrancando, la pared se
    // veía tarde); el perfil de la escalera, con la de ahora.
    const reachAt = (speed: number): number =>
      speed > 0 ? speed / this.gait.stepFrequencyFor(speed) + (speed * speed) / this.config.deceleration + this.stairs.toeFront + this.stairs.heelBack : 0;
    const now = this.body.state.speed;
    const speed = Math.max(now, now > 0 ? this.body.targetSpeed : 0);
    const stride = speed > 0 ? speed / this.gait.stepFrequencyFor(speed) : 0;
    const reach = reachAt(speed);
    const moved = this.stairs.planLanding(
      start,
      other.planted,
      other.planted.y - stanceAnkle,
      landing,
      placement.state,
      placement.ankleHeight,
      // Hacia donde apuntará el pie: arrancando hacia un lado, el cuerpo todavía mira hacia otro (y la punta del
      // pie, con la dirección de ahora, no se veía sobre el desnivel).
      this.landingDirection.copy(this.body.state.forward).applyAxisAngle(UP, footYaw),
      this.turnCenter(this.stairCenter),
      this.tmp,
      probe,
      reach,
      stride,
      reachAt(now),
    );
    if (moved) this.planner.placeLanding(side, this.tmp, footYaw, landing, landingRotation);
    return moved;
  }

  /**
   * Center of the turn of the body (world), if it is turning along an arc of less than MAX_STAIR_TURN_RADIUS
   * (curved or spiral stairs); null if it goes straight. Its radius is speed / turn rate, at least
   * MIN_STAIR_TURN_RADIUS.
   */
  private turnCenter(out: Vector3): Vector3 | null {
    const s = this.body.state;
    const curvature = s.angularVelocity / Math.max(s.speed, IDLE_SPEED * this.config.walkSpeed);
    const step = this.config.stepLength;
    if (Math.abs(curvature) * MAX_STAIR_TURN_RADIUS * step < 1) return null;
    const radius = Math.max(1 / Math.abs(curvature), MIN_STAIR_TURN_RADIUS * step) * Math.sign(curvature);
    // A la izquierda (giro positivo) o a la derecha del avance.
    return out.set(s.position.x + s.travel.z * radius, 0, s.position.z - s.travel.x * radius);
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
    const angularSpeed = Math.abs(this.body.state.turnRate);
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
      // Propio: pushOffPose usa `tmp` (al pivotar el pie).
      const hip = worldPosition(this.legs[side].ik.leg.thigh, this.pushHip);
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
    this.narrowDetour(foot, other);
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
    if (amount > swing.detour.length()) swing.detour.set(nx * amount, 0, nz * amount);
  }

  /**
   * Balancing on a narrow path, the feet go in line: the foot in the air would pass through the planted ankle.
   * It curves to its own side at mid-swing just enough to pass NARROW_SWING_CLEARANCE × stepLength from it.
   */
  private narrowDetour(foot: FootTarget, other: FootTarget): void {
    const kb = smoothstep(this.balance);
    if (kb <= 0) return;
    const swing = foot.swing;
    const ankle = other.planted;
    const ax = swing.end.x - swing.start.x;
    const az = swing.end.z - swing.start.z;
    const length2 = ax * ax + az * az;
    if (length2 < 1e-8) return;
    const u = clamp(((ankle.x - swing.start.x) * ax + (ankle.z - swing.start.z) * az) / length2, 0, 1);
    if (u < 0.2 || u > 0.8) return;
    const side = foot.side === 'left' ? -1 : 1;
    const forward = this.body.state.forward;
    const nx = -forward.z * side;
    const nz = forward.x * side;
    // Lo que la línea recta ya pasa hacia el lado de este pie.
    const along = (swing.start.x + ax * u - ankle.x) * nx + (swing.start.z + az * u - ankle.z) * nz;
    const needed = NARROW_SWING_CLEARANCE * this.config.stepLength - along;
    if (needed <= 0) return;
    const amount = kb * Math.min(needed / Math.sin(Math.PI * u) ** 2, MAX_DETOUR * this.config.stepLength);
    swing.detour.set(nx * amount, 0, nz * amount);
  }

  /**
   * Narrow paths: looks at the path across (see NarrowPath), the balance follows it at `narrowRate`, and the
   * feet come together: `narrowStepWidth` walking, and the width of the foot standing (they don't overlap).
   */
  private updateNarrow(dt: number): void {
    const cfg = this.config;
    const s = this.body.state;
    if (!(cfg.narrowWidth > 0)) {
      this.narrowPath.reset();
    } else if (!s.airborne) {
      this.narrowProbe -= dt;
      // También con escalones cerca (subiendo a una viga desde el suelo, el escalón de su extremo): en una escalera
      // ancha los lados están a la altura del medio y no cuentan como caída.
      if (this.narrowProbe <= 0) {
        const moving = this.gait.mode !== 'idle' || s.speed > IDLE_SPEED * cfg.walkSpeed;
        this.narrowProbe = moving ? NARROW_PROBE_INTERVAL : NARROW_IDLE_INTERVAL;
        const ground = Number.isFinite(s.groundHeight) ? s.groundHeight : s.position.y;
        const along = this.probeDirection();
        this.narrowPath.probe({
          forward: along,
          point: this.tmp.copy(s.position).addScaledVector(along, Math.max(NARROW_AHEAD * cfg.stepLength, NARROW_LOOKAHEAD * s.speed)),
          ground,
          width: cfg.narrowWidth,
          drop: NARROW_DROP * cfg.stepLength,
          rayHeight: cfg.groundProbeHeight,
          // Con un escalón por delante (el extremo de una viga más alta que el suelo), al nivel de lo de delante.
          levelAhead: this.stairs.active,
        });
      }
    }
    // Hasta pasar por donde acaba el camino (la sonda mira por delante del cuerpo).
    const target = this.narrowPath.onPath(s.position, this.probeDirection()) ? 1 : 0;
    const step = cfg.narrowRate * dt;
    this.balance += clamp(target - this.balance, -step, step);
    const kb = smoothstep(this.balance);
    if (kb <= 0) {
      this.planner.widthOverride = null;
      return;
    }
    const natural = this.planner.naturalStepWidth();
    const footWidth = FOOT_WIDTH * (this.stairs.toeFront + this.stairs.heelBack);
    // Parando (los últimos pasos ya se planean así) y parado, los pies a su anchura; arrancando, se juntan.
    const standing = 1 - smoothstep(Math.min(s.speed, this.body.targetSpeed) / (IDLE_ARMS_SPEED * cfg.walkSpeed));
    const narrow = cfg.narrowStepWidth + Math.max(footWidth - cfg.narrowStepWidth, 0) * standing;
    this.planner.widthOverride = natural + (narrow - natural) * kb;
  }

  /**
   * Balancing: the steps land along the middle of the path (`landingShift` of the planner) and, while walking,
   * the body moves towards it (NARROW_CENTERING).
   */
  private centerOnPath(dt: number, kb: number): void {
    const shift = this.planner.landingShift;
    const s = this.body.state;
    if (kb <= 0 || !this.narrowPath.narrow || s.airborne) {
      shift.set(0, 0, 0);
      return;
    }
    // A lo ancho del camino (como se midió), no del cuerpo: girado, lo de delante en el camino parecía a un lado.
    const right = this.narrowPath.across;
    const half = this.config.narrowWidth / 2;
    const offset = clamp(this.narrowPath.offset(s.position), -half, half);
    shift.copy(right).multiplyScalar(offset * kb);
    const moving = clamp(s.speed / this.config.narrowMaxSpeed, 0, 1);
    const drift = offset * kb * moving * (1 - Math.exp(-NARROW_CENTERING * dt));
    this.body.drift.addScaledVector(right, drift);
    // Hacia un costado que no se puede bajar, el cuerpo no pasa de narrowLine (el freno, ver narrowRoom, se pasaba:
    // la frenada tiene una rampa y el sitio es de centímetros), y más allá (llegó girando, o el camino se midió de
    // nuevo), vuelve, también parado o girando en el sitio: con el cuerpo sobre el vacío, las piernas iban en diagonal.
    if (!this.onNarrowPath()) return;
    const now = -this.narrowPath.offset(s.position);
    const next = now + this.body.drift.dot(right) + s.velocity.dot(right) * dt;
    const side = Math.sign(next);
    const line = this.narrowLine();
    if (Math.abs(next) <= line || !this.narrowDropsAway(side)) return;
    const away = Math.abs(now);
    const limit = away > line ? away - (away - line) * (1 - Math.exp(-NARROW_CENTERING * dt)) : line;
    if (Math.abs(next) > limit) this.body.drift.addScaledVector(right, -side * (Math.abs(next) - limit));
  }

  /**
   * Ledges: looks across for one (see Ledge) and `ledgeBlend` follows it at `ledgeRate`. Along it, the body faces
   * away from the wall (always the same way, unless the ledge turns more than LEDGE_REFACE) and goes sideways, the
   * way it is asked along the ledge (`headingOverride`, `facingTarget`); short, quick steps with the feet coming
   * together. Returns true if it has to stop: it is asked to go into the wall or towards the drop, or the other way
   * along the ledge (it turns its direction of travel round once stopped, without turning the body).
   */
  private updateLedge(dt: number): boolean {
    const cfg = this.config;
    const body = this.body;
    const s = body.state;
    if (!(cfg.ledgeWidth > 0) || this.balance > 0) {
      this.ledgePath.reset();
    } else if (!s.airborne) {
      this.ledgeProbe -= dt;
      if (this.ledgeProbe <= 0) {
        const moving = this.gait.mode !== 'idle' || s.speed > IDLE_SPEED * cfg.walkSpeed;
        this.ledgeProbe = moving ? NARROW_PROBE_INTERVAL : NARROW_IDLE_INTERVAL;
        const ground = Number.isFinite(s.groundHeight) ? s.groundHeight : s.position.y;
        // Parado fuera de una cornisa, mira alternando a lo largo y a lo ancho del cuerpo: puede estar ya de espaldas a
        // la pared.
        let along = s.travel;
        if (!moving && !this.ledgePath.ledge) {
          this.ledgeIdleAcross = !this.ledgeIdleAcross;
          if (this.ledgeIdleAcross) along = this.ledgeAlong.set(s.forward.z, 0, -s.forward.x);
        }
        const ahead = moving ? Math.max(NARROW_AHEAD * cfg.stepLength, NARROW_LOOKAHEAD * s.speed) : 0;
        this.ledgePath.probe({
          forward: along,
          point: this.tmp.copy(s.position).addScaledVector(along, ahead),
          ground,
          width: cfg.ledgeWidth,
          drop: cfg.maxStepDown,
          wall: Math.min(LEDGE_WALL * cfg.stepLength, cfg.groundProbeHeight),
          rayHeight: cfg.groundProbeHeight,
        });
      }
    }
    // Pedido a través de la cornisa, pero con suelo a su altura hacia allí (la plataforma donde termina): sale de ella.
    const on = this.ledgePath.onLedge(s.position, s.travel) && !(this.ledgeFaced && this.leavesLedge());
    // Saliendo de ella: unos pasos aún despacio, y luego acelera suave (ver LEDGE_EXIT_STEPS).
    if (this.ledgeOn && !on && this.ledgeFaced) {
      this.ledgeLeaving = LEDGE_EXIT_STEPS;
      this.ledgeExitLimit = cfg.ledgeMaxSpeed;
    } else if (on || this.ledgeExitLimit >= Math.max(body.targetSpeed, s.speed) + 0.01) {
      this.ledgeLeaving = 0;
      this.ledgeExitLimit = Number.POSITIVE_INFINITY;
    } else if (this.ledgeLeaving <= 0) this.ledgeExitLimit += LEDGE_EXIT_ACCELERATION * cfg.acceleration * dt;
    this.ledgeOn = on;
    const step = cfg.ledgeRate * dt;
    this.ledgeBlend += clamp((on ? 1 : 0) - this.ledgeBlend, -step, step);
    const kl = smoothstep(this.ledgeBlend);
    if (kl > 0) {
      // Pasos cortos y rápidos; los pies se juntan (ledgeStepWidth) y se separan lo que avanza en un ciclo.
      this.gait.minFrequency = Math.max(this.gait.minFrequency, LEDGE_STEP_FREQUENCY * kl);
      const natural = this.planner.widthOverride ?? this.planner.naturalStepWidth();
      const speed = Math.min(s.speed, cfg.ledgeMaxSpeed);
      const open = cfg.ledgeStepWidth + (speed > 0 ? speed / this.gait.cycleFrequency(speed) / 2 : 0);
      this.planner.widthOverride = natural + (open - natural) * kl;
    }
    body.shiftScale = 1 + (LEDGE_LATERAL_SHIFT - 1) * kl;
    if (!on) {
      body.headingOverride = Number.NaN;
      body.facingTarget = 0;
      if (s.facingOffset === 0) this.ledgeFaced = false;
      return false;
    }

    // De espaldas a la pared: mirando siempre hacia el mismo lado mientras la cornisa no gire.
    const out = this.ledgePath.out;
    if (!this.ledgeFaced || this.ledgeFacing.dot(out) < LEDGE_REFACE) {
      this.ledgeFacing.copy(out);
      this.wallSamples.fill(Number.NEGATIVE_INFINITY);
      this.ledgeFaced = true;
    } else if (this.ledgeBlend < 1) {
      // Al entrar, poco a poco hacia la última medida: la primera, en la esquina donde empieza la cornisa, puede salir
      // torcida (unos 8°). Ya en ella, no: en una pared irregular la medida varía y el cuerpo giraba con ella.
      this.ledgeFacing.lerp(out, 1 - Math.exp(-dt / LEDGE_FACING_TIME)).normalize();
    }
    const facing = this.ledgeFacing;
    // A lo largo de la cornisa, a la izquierda de donde mira; el sentido, el pedido (targetHeading).
    const along = this.ledgeAlong.set(facing.z, 0, -facing.x);
    const wanted = this.wanted.copy(s.travel).applyAxisAngle(UP, body.targetHeading - s.heading);
    const asked = wanted.dot(along);
    const going = s.travel.dot(along);
    const want = Math.abs(asked) < LEDGE_MIN_ALONG ? 0 : Math.sign(asked);
    let stop = want === 0;
    let sign = want !== 0 ? want : Math.sign(going) || 1;
    // Al otro lado de la cornisa: frena y, ya parado, da la vuelta a su dirección de avance (no al cuerpo).
    if (want !== 0 && Math.abs(going) > 0.7 && Math.sign(going) !== want) {
      if (s.speed > IDLE_SPEED * cfg.walkSpeed) {
        stop = true;
        sign = Math.sign(going);
      } else {
        body.reverseTravel();
      }
    }
    if (sign < 0) along.negate();
    // Avanza paralelo a la pared según la última medida (el cuerpo, de espaldas según `ledgeFacing`, que no gira con las
    // rocas): la medida de cuando se puso de espaldas, en la esquina donde empieza la cornisa, puede salir unos grados
    // torcida y, yendo por ella, a un metro se salía por el borde o iba contra la pared (y una guarda lo paraba en seco).
    const latest = this.ledgePath.out;
    const travelAlong = this.ledgeTravel.set(latest.z, 0, -latest.x);
    if (travelAlong.dot(along) < 0) travelAlong.negate();
    const travel = travelAlong.dot(along) > LEDGE_REFACE ? travelAlong : along;
    body.headingOverride = s.heading + signedAngle(s.travel, travel);
    // De espaldas a la pared (respecto a hacia donde avanza, para que el cuerpo no gire con la medida), ya frenado (si aún
    // va deprisa, sigue de frente unos pasos).
    if (s.facingOffset !== 0 || s.speed <= LEDGE_TURN_SPEED * cfg.ledgeMaxSpeed) body.facingTarget = signedAngle(travel, facing);
    return stop && this.ledgeBlend > 0.5;
  }

  /**
   * Along a ledge, asked to go off it (more than LEDGE_ASKED_SNAP away from the wall): is there ground to walk on that
   * way, beyond the edge of the ledge and at about its height (the platform where the ledge ends), instead of the drop?
   * Then it leaves the ledge and walks there. Without this, at the very end of a ledge, asked towards the platform beside it, it stood
   * still for ever: still "on the ledge", that way was the drop, and standing still it never got off it.
   */
  private leavesLedge(): boolean {
    const s = this.body.state;
    const cfg = this.config;
    if (!(this.body.targetSpeed > 0) || !Number.isFinite(s.groundHeight)) return false;
    const facing = this.ledgeFacing;
    const along = this.ledgeExitAlong.set(facing.z, 0, -facing.x);
    const wanted = this.ledgeExit.copy(s.travel).applyAxisAngle(UP, this.body.targetHeading - s.heading);
    // Hacia fuera de la cornisa (hacia la pared, nunca) y desviado de ella más que LEDGE_ASKED_SNAP: también en diagonal
    // (volviendo, una ruta sale de la cornisa hacia la plataforma a ~45°; a lo largo, moveTo frenaba hasta casi pararse).
    const across = Math.abs(wanted.x * along.z - wanted.z * along.x);
    if (wanted.dot(facing) <= 0 || across < Math.sin(LEDGE_ASKED_SNAP)) return false;
    // Tan lejos como haga falta para pasar el borde de una cornisa (en ella, la caída), y no más de LEDGE_EXIT_MAX.
    const width = Number.isFinite(this.ledgePath.width) ? this.ledgePath.width : cfg.ledgeWidth;
    const reach = Math.min((width + LEDGE_EXIT_PROBE * cfg.stepLength) / across, LEDGE_EXIT_MAX * cfg.stepLength);
    const ground = s.groundHeight;
    const probe = this.ledgeExitProbe.copy(s.position).addScaledVector(wanted, reach);
    probe.y = ground + cfg.groundProbeHeight;
    this.ledgeRays.count++;
    if (!this.detector.castDown(probe, cfg.groundProbeHeight + cfg.maxStepDown, this.sampleHit)) return false;
    const y = this.sampleHit.point.y;
    return y >= ground - cfg.maxStepDown && y <= ground + cfg.maxStepUp;
  }

  /** Going along a ledge with its back to the wall, with the body already turned (not still turning onto it). */
  private onLedge(): boolean {
    return this.ledgeBlend > 0.5 && this.ledgeFaced;
  }

  /**
   * Along a ledge, the back against the wall: it measures how far the wall is behind the hips (the bone, as they were
   * in the last frame, without `ledgeHipBack`) at the height of the hips and at that of the chest (one band each
   * frame; see Ledge.wallDistance) and moves the body towards the distance at which the back touches it where the
   * wall sticks out most (`backDepth`, measured on the mesh). Against an irregular wall the trunk leans back (or the
   * hips go back and it leans forward) to touch it at both heights.
   */
  private keepBackToWall(dt: number, kl: number): void {
    const s = this.body.state;
    const follow = 1 - Math.exp(-dt / LEDGE_LEAN_TIME);
    let lean = 0;
    let hipBack = 0;
    if (kl > 0 && this.ledgeFaced && !s.airborne) {
      const ground = Number.isFinite(s.groundHeight) ? s.groundHeight : s.position.y;
      const out = this.ledgeFacing;
      const k = this.wallSample;
      this.wallSample = (k + 1) % 6;
      const [lo, hi] = this.backBand[k < 3 ? 'hips' : 'chest'];
      const reach = LEDGE_WALL_REACH * this.config.stepLength;
      const at = worldPosition(this.rig.hips, this.wanted).addScaledVector(s.forward, this.ledgeHipBack);
      // Las muestras, como posición de la pared a lo largo de `out` (no como distancia a las caderas, que se mueven
      // entre una medida y la siguiente).
      const base = at.x * out.x + at.z * out.z;
      at.x += out.z * ((k % 3) - 1) * BACK_HALF_WIDTH * this.config.stepLength;
      at.z -= out.x * ((k % 3) - 1) * BACK_HALF_WIDTH * this.config.stepLength;
      const w = this.wallSamples;
      w[k] = base - this.ledgePath.wallDistance(at, out, ground + lo, ground + hi, reach, base - w[k], this.ledgeRays);
      const hips = base - Math.max(w[0], w[1], w[2]) - this.backDepth.hips;
      const chest = base - Math.max(w[3], w[4], w[5]) - this.backDepth.chest;
      const move = Math.min(hips, chest);
      if (Number.isFinite(move)) {
        // Hacia la pared (o apartándose, si la espalda la atraviesa), poco a poco, y a medida que se pone de espaldas a
        // ella: girando aún, de lado, las caderas (medidas como espalda) quedaban a ~7 cm de la pared y el pie de ese
        // lado se metía en ella. Apartándose, siempre.
        const turned = move > 0 ? smoothstep(Math.max(s.forward.dot(out), 0)) : 1;
        this.body.drift.addScaledVector(out, -move * kl * turned * (1 - Math.exp(-LEDGE_CENTERING * dt)));
        const rise = (this.backBand.chest[0] + this.backBand.chest[1] - this.backBand.hips[0] - this.backBand.hips[1]) / 2;
        const chestGap = Number.isFinite(chest) ? chest - move : 0;
        hipBack = Number.isFinite(hips) ? Math.min(hips - move, LEDGE_MAX_HIP_BACK * this.config.stepLength) : 0;
        lean = clamp(Math.atan2(hipBack - chestGap, rise), -LEDGE_MAX_LEAN, LEDGE_MAX_LEAN);
      }
    } else {
      this.wallSamples.fill(Number.NEGATIVE_INFINITY);
    }
    this.ledgeLean += (lean * kl - this.ledgeLean) * follow;
    this.ledgeHipBack += (hipBack * kl - this.ledgeHipBack) * follow;
  }

  /**
   * Along a ledge, the palms against the wall behind, on each side of the hips (see LEDGE_HAND_SPREAD), with the
   * fingers pointing down and out: the touch controller's `brace`, as much as the ledge blend. Where there is no
   * wall within reach behind a hand, that hand swings as usual.
   */
  private braceOnWall(kl: number): void {
    const s = this.body.state;
    const measured = this.handWallSide;
    this.handWallSide = measured === 'left' ? 'right' : 'left';
    const active = kl > 0 && this.ledgeFaced && !s.airborne;
    for (const side of SIDES) {
      if (!active) {
        this.handWall[side] = Number.NEGATIVE_INFINITY;
        this.touch.brace(side, this.handAt, UP, UP, 0);
        continue;
      }
      const out = this.ledgeFacing;
      const unit = this.config.stepLength;
      const sign = side === 'right' ? 1 : -1;
      const right = this.handRight.crossVectors(out, UP).normalize();
      const at = worldPosition(this.rig.hips, this.handAt).addScaledVector(right, sign * LEDGE_HAND_SPREAD * unit);
      at.y += LEDGE_HAND_HEIGHT * unit;
      const base = at.x * out.x + at.z * out.z;
      if (side === measured) {
        const band = LEDGE_HAND_BAND * unit;
        const reach = LEDGE_WALL_REACH * unit;
        this.handWall[side] = base - this.ledgePath.wallDistance(at, out, at.y - band, at.y + band, reach, base - this.handWall[side], this.ledgeRays);
      }
      const wall = this.handWall[side];
      if (!Number.isFinite(wall)) {
        this.touch.brace(side, at, out, UP, 0);
        continue;
      }
      at.addScaledVector(out, wall - base);
      const fingers = this.handFingers.copy(UP).multiplyScalar(-Math.cos(LEDGE_FINGERS_OUT)).addScaledVector(right, sign * Math.sin(LEDGE_FINGERS_OUT));
      this.touch.brace(side, at, out, fingers, kl);
    }
  }

  /**
   * Along a ledge: moves `target` (where a foot lands) across the ledge so that the whole foot, pointing away from
   * the wall, is on it: the back of the heel off the wall and the toes before the edge, as far as it fits (if not, off
   * the wall). Returns true if it moved it.
   */
  private keepOnLedge(target: Vector3): boolean {
    const path = this.ledgePath;
    const d = path.fromWall(target);
    const min = this.stairs.heelBack + LEDGE_FOOT_MARGIN;
    const max = Math.max(path.width - this.stairs.toeFront - LEDGE_FOOT_MARGIN, min);
    const kept = clamp(d, min, max);
    if (kept === d) return false;
    target.addScaledVector(path.out, kept - d);
    return true;
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
    const base = this.gait.mix(this.config.stepHeight, this.gait.run(this.config.jogStepHeight, this.config.runStepHeight)) * (1 - (1 - LEDGE_STEP_HEIGHT) * smoothstep(this.ledgeBlend));
    // Haciendo equilibrio y sin cambiar de altura, como en terreno normal: mirando hacia el costado de un camino angosto,
    // la escalera veía en él un escalón y cada paso subía la rodilla al máximo (maxExtraStepHeight).
    const level = (this.balance > 0.5 || this.narrowPath.narrow) && Math.abs(foot.swing.landing.y - foot.planted.y) < this.stairs.edgeHeight;
    this.swingGround[foot.side] = Math.max(foot.swing.start.y, foot.swing.landing.y) - this.legs[foot.side].ankleHeight;
    if (this.stairs.active && !level) return base + Math.min(this.stairSwingExtra(foot, base), this.config.maxExtraStepHeight);
    const roll = this.legs[foot.side].roll;
    const n = CLEARANCE_SAMPLES;
    const toeY: number[] = [];
    const groundY: number[] = [];
    // La muestra 0 (el pie aún en el suelo, al despegar) no se usa: sin raycast.
    toeY.push(0);
    groundY.push(-Infinity);
    for (let i = 1; i <= n; i++) {
      evaluateSwing(foot.swing, i / n, base, this.samplePos, this.sampleRot, 1 - this.gait.blend, this.gait.pace);
      const toe = this.tmp.copy(roll.toeLocal).applyQuaternion(this.sampleRot).add(this.samplePos);
      toeY.push(toe.y);
      toe.y += 1;
      groundY.push(this.detector.castDown(toe, 3, this.sampleHit) ? this.sampleHit.point.y : -Infinity);
    }
    this.swingGround[foot.side] = Math.max(this.swingGround[foot.side], ...groundY);
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
   * foot. On a step that doesn't change level, only the ground that rises an edge or more above that level counts
   * (something to step over in between): over the level itself the foot just takes off and lands.
   */
  private stairSwingExtra(foot: FootTarget, base: number): number {
    const roll = this.legs[foot.side].roll;
    const profile = this.stairs.profile;
    const n = CLEARANCE_SAMPLES;
    const walk = 1 - this.gait.blend;
    // Sin cambiar de nivel (junto a un borde, o al llegar al final de una escalera), sobre el suelo de ese nivel no se
    // pide holgura: el pie despega de él y se apoya en él. La muestra de justo antes de aterrizar, con el talón bajando
    // a apoyarse y el arco casi en 0, pedía holgura dividida por 0,05: cada paso subía maxExtraStepHeight.
    const edge = this.stairs.edgeHeight;
    const swing = foot.swing;
    const counts =
      Math.abs(swing.landing.y - foot.planted.y) < edge
        ? Math.max(swing.landing.y, foot.planted.y) - this.planner.placement(foot.side).ankleHeight + edge
        : Number.NEGATIVE_INFINITY;
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
        evaluateSwing(swing, i / n, base, this.samplePos, this.sampleRot, walk, this.gait.pace);
        const p = this.tmp.copy(points[k]).applyQuaternion(this.sampleRot).add(this.samplePos);
        let u = profile.along(p);
        if (k === 2) {
          const d = this.tipDirection.copy(along).applyQuaternion(this.sampleRot).setY(0);
          const length = d.length();
          const t = profile.tangent(u, this.stairTangent);
          if (length > 1e-6) u += (toes * (d.x * t.x + d.z * t.z)) / length / profile.pathScale(p);
        }
        if (!Number.isNaN(previousU)) {
          // La muestra anterior debe librar el suelo entre ella y esta (ningún borde se cuela entre las dos).
          const ground = profile.maxHeight(previousU, u);
          const deficit = ground + this.config.toeClearance - previousY;
          if (deficit > 0 && ground >= counts) extra = Math.max(extra, deficit / Math.max(swingArc((i - 1) / n, walk), 0.05));
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
    gait.pace = gait.paceFactor(this.speed);
    const duty = gait.dutyFor(gait.blend, gait.pace);
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
    // El de delante no despega antes que el de atrás: corriendo deprisa su apoyo (runDutyFactor) es más corto que lo
    // que le queda al de atrás para despegar, y despegaban en el orden equivocado (el mismo pie dos veces seguidas).
    gait.duty[lead] = Math.max(duty, plant + gait.duty[trail] - start + LANDING_LIFT_GAP);
    gait.phase = fract(plant - gait.offsets[lead]);
  }

  private get heelLift(): number {
    return ((this.gait.mix(this.config.heelLiftAngle, this.config.runHeelLiftAngle) * Math.PI) / 180) * this.ledgeRoll;
  }

  private get heelStrike(): number {
    return ((this.gait.mix(this.config.heelStrikeAngle, this.config.runHeelStrikeAngle) * Math.PI) / 180) * this.ledgeRoll;
  }

  /** How much the foot rolls (heel strike, heel lift): along a ledge, barely (LEDGE_ROLL). */
  private get ledgeRoll(): number {
    return 1 - (1 - LEDGE_ROLL) * smoothstep(this.ledgeBlend);
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
      // Bajando una escalera, la rodilla de apoyo va doblada todo el apoyo.
      bend += (Math.max(bend, STAIR_DOWN_KNEE) - bend) * this.stairDescent;
    }
    // De espaldas a la pared, con las rodillas algo dobladas (también parado).
    bend += cfg.ledgeKneeBend * smoothstep(this.ledgeBlend);
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

  /**
   * Running, the foot in the air follows the shin: the ankle keeps (relative to the rest pose) the angle of motion
   * capture, a little extended after toe-off (SWING_ANKLE_EXTENSION) and back to neutral before landing. Without it
   * the foot kept its orientation in the world while the knee bent and the shin rose behind: the foot stayed
   * horizontal, in line with the shin (up to 67° of flexion; CMU jogging: the foot points down, −56…−76°, with the
   * ankle within 30° of neutral). In the middle of the swing only: at toe-off and landing it is the swing's
   * orientation. The tips of the toes never go below the highest ground of the planned swing plus toeClearance.
   */
  private swingAnkle(side: Side): void {
    const foot = this.feet[side];
    const t = foot.swing.t;
    const weight = this.gait.blend * smoothstep(t / SWING_ANKLE_IN) * (1 - smoothstep((t - SWING_ANKLE_OUT) / (1 - SWING_ANKLE_OUT)));
    if (weight <= 0) return;
    const leg = this.legs[side];
    const bones = leg.ik.leg;
    const ankle = worldPosition(bones.foot, this.ankleFoot);
    const shin = this.ankleShin.subVectors(ankle, worldPosition(bones.shin, this.ankleToe)).normalize();
    const toeLocal = leg.roll.toeLocal;
    const footDir = this.ankleToe.copy(toeLocal).applyQuaternion(foot.rotation).normalize();
    const axis = this.ankleAxis.crossVectors(shin, footDir);
    if (axis.lengthSq() < 1e-10) return;
    axis.normalize();
    // Extendido al principio (punta abajo) y neutro hacia el final.
    const extension = SWING_ANKLE_EXTENSION * (1 - smoothstep((t - 0.15) / 0.6));
    const delta = (leg.restAnkle + extension - shin.angleTo(footDir)) * weight;
    // La punta, nunca más abajo que el suelo del recorrido + toeClearance (ni que donde iba, si ya iba más baja).
    const toeY = (k: number): number =>
      this.ankleToe.copy(toeLocal).applyQuaternion(this.ankleRotation.setFromAxisAngle(axis, delta * k).multiply(foot.rotation)).y + ankle.y;
    const limit = Math.min(this.swingGround[side] + this.config.toeClearance, toeY(0));
    let k = 1;
    if (toeY(1) < limit) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (toeY(mid) >= limit) lo = mid;
        else hi = mid;
      }
      k = lo;
    }
    if (k <= 0) return;
    setWorldQuaternionNode(bones.foot, this.ankleQ.setFromAxisAngle(axis, delta * k).multiply(foot.rotation));
  }

  private reachWeight(side: Side): number {
    const foot = this.feet[side];
    if (foot.phase !== 'SWING') return 1;
    const t = foot.swing.t;
    // Corriendo deprisa (pace), el pie en el aire limita las caderas menos tiempo tras despegar y antes de aterrizar: a
    // 5–6 m/s el de atrás se aleja mucho al despegar y el de delante se adelanta, y hundían las caderas en el vuelo
    // (cuando el cuerpo está más alto). La pierna se queda estirada sin llegar del todo, como al impulsarse.
    const pace = this.gait.pace;
    const early = SWING_REACH_EARLY * (1 - FAST_SWING_REACH * pace);
    const late = SWING_REACH_LATE + (1 - SWING_REACH_LATE) * FAST_SWING_REACH * 0.6 * pace;
    const swingWeight = Math.max(1 - smoothstep(t / early), smoothstep((t - late) / (1 - late)));
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

/** Angle (rad, about +Y; positive = to the left) from the horizontal direction `a` to `b`. */
function signedAngle(a: Vector3, b: Vector3): number {
  return Math.atan2(a.z * b.x - a.x * b.z, a.x * b.x + a.z * b.z);
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(Math.max(x, min), max);
}

function fract(x: number): number {
  return x - Math.floor(x);
}
