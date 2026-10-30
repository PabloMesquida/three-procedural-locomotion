/**
 * Parameters of the locomotion. They can be changed without touching the implementation.
 * (Fields will be added as the phases progress: turning, running…)
 */
import type { ArmConfig } from '../body/ArmController.ts';
import type { PelvisConfig } from '../body/PelvisController.ts';
import type { TorsoConfig } from '../body/TorsoController.ts';
import type { TouchConfig } from '../body/TouchController.ts';

export interface LocomotionConfig extends PelvisConfig, TorsoConfig, ArmConfig, TouchConfig {
  /**
   * Normal walking speed (m/s): the cruise speed when navigating on foot, at which it takes `stepFrequency`
   * steps per second. It can walk faster, up to `runStartSpeed`.
   */
  walkSpeed: number;
  /** Maximum running speed (m/s). */
  runSpeed: number;
  /**
   * Speed at which the transition to running begins (m/s). A person starts running at about 2 m/s (Froude
   * number v²/(g·leg) ≈ 0.5); below that they walk, even at a brisk pace.
   */
  runStartSpeed: number;
  /** Speed range (m/s) above runStartSpeed over which walking gradually turns into running. */
  runTransition: number;
  /** Acceleration when starting to move (m/s²). */
  acceleration: number;
  /** Deceleration when braking (m/s²). */
  deceleration: number;
  /**
   * Smoothing of speed changes (s): the time over which acceleration or braking ramps up to its maximum and
   * back to zero (S-curve). 0 = constant rate, no smoothing.
   */
  speedEasing: number;

  /**
   * Steps per second (counting both feet) at `walkSpeed`. When walking, cadence grows with the square root of
   * speed (as in motion capture); step length provides the rest.
   */
  stepFrequency: number;
  /** Steps per second at near-zero speed (when starting, stopping or repositioning the feet). */
  minStepFrequency: number;
  /** Maximum step length (m): if more were needed, the step frequency increases instead. */
  stepLength: number;
  /**
   * Lateral distance between the feet (m). `null` = 80 % of the rig's hip width (distance between the
   * thighs), as in walking.
   */
  stepWidth: number | null;
  /** Maximum foot height during the swing (m). */
  stepHeight: number;

  /** Fraction of the cycle each foot spends on the ground when walking (> 0.5: double support). */
  dutyFactor: number;
  /**
   * Walking: fraction of the normal lead at which the foot lands (0–1). With 1, the stance is centred on the
   * neutral position; with less, further back: the trailing leg extends with the heel raised before lifting
   * off and the leading foot lands closer, as in motion capture. It applies in full when the heel lifts 45°
   * or more at toe-off (`heelLiftAngle`); with less, the stance moves towards centred (with flat feet the
   * trailing leg cannot extend as far).
   */
  walkLandingLead: number;

  /** Running: steps per second at runSpeed. */
  runStepFrequency: number;
  /** Running: maximum step length (m). */
  runStepLength: number;
  /** Running: fraction of the cycle with the foot on the ground (< 0.5: flight phase). */
  runDutyFactor: number;
  /** Running: foot height in the air (m). */
  runStepHeight: number;
  /** Running: heel angle at toe-off (degrees). */
  runHeelLiftAngle: number;
  /** Running: toe angle at landing (degrees; small = midfoot strike). */
  runHeelStrikeAngle: number;
  /** Running: how much the hips drop on average (m). */
  runCrouch: number;
  /** Running: amplitude of the vertical bounce of the hips (m). */
  runBounce: number;
  /**
   * Running: fraction of the normal lead at which the foot lands (0–1). When walking the foot lands half a
   * stance ahead of the hip; when running, closer to the body (and it lifts off further back, pushing).
   */
  runLandingLead: number;
  /** Running: forward lean of the torso (degrees). */
  runLean: number;
  /** Forward lean of the torso when standing and walking (degrees; when running it changes to `runLean`). */
  walkLean: number;
  /**
   * How far the ankle sits behind the hip in the neutral foot position (m): when standing, the weight falls
   * on the middle of the foot, ahead of the ankle. It is not taken from the model's rest pose, which may have
   * the feet forward or back.
   */
  ankleBack: number;
  /** Standing still: arm angle away from the vertical (degrees; arms hang lower than when walking). */
  idleArmAbduction: number;
  /** Standing still: elbow bend (degrees). */
  idleElbowBend: number;
  /**
   * Standing still: upper arm angle in front of the vertical (degrees; negative = back). A little back, with
   * the elbow a little bent, the hand stays beside the thigh instead of in front of it.
   */
  idleArmForward: number;
  /** Running: arm angle away from the vertical (degrees). */
  runArmAbduction: number;
  /** Running: elbow bend (degrees). */
  runElbowBend: number;
  /** Running: maximum arm swing (degrees). */
  runArmSwing: number;
  /** Running: extra elbow bend when the arm swings forward (degrees). */
  runElbowSwingBend: number;

  /** Crouching: how much the hips drop (m). */
  crouchDepth: number;
  /** Crouching: how far the hips move back to keep balance (m). */
  crouchHipBack: number;
  /** Crouching: forward tilt of the pelvis (degrees). */
  crouchPelvisTilt: number;
  /** Crouching: additional forward lean of the torso (degrees). */
  crouchLean: number;
  /** Crouching: additional elbow bend (degrees). */
  crouchElbowBend: number;
  /** Crouching: how far forward the arms move (degrees). */
  crouchArmForward: number;
  /** Crouching: maximum speed (m/s). */
  crouchMaxSpeed: number;
  /** How fast it crouches or stands up (fraction of a full crouch per second). */
  crouchRate: number;

  /** Gravity (m/s²). */
  gravity: number;
  /** Jump: vertical speed at takeoff (m/s). */
  jumpSpeed: number;
  /**
   * Jump: how far the hips sink while preparing (m). The duration of the preparation follows from this and
   * jumpSpeed: the hips go down from rest and up again, taking off exactly at the jump speed.
   */
  jumpCrouch: number;
  /** Jump: heel raise at the end of the preparation (pushing off with the toes, degrees). */
  jumpToeOff: number;
  /** Jump: how much the feet tuck up in the air (m). */
  jumpTuck: number;
  /** Jump: time before touching the ground in which the legs extend towards the landing (s). */
  jumpLandingPrep: number;
  /** Landing: hip drop for each m/s of falling speed (m per m/s). */
  landingAbsorb: number;
  /** Landing: maximum hip drop (m). */
  maxLandingDip: number;
  /** Landing: duration of the cushioning (s). */
  landingTime: number;
  /**
   * Fraction of the cycle, at the end of the stance, in which the heel rises (LIFT; at most 30 % of the
   * stance). It starts before the other foot lands, as in real walking.
   */
  liftFraction: number;
  /** Fraction of the cycle, at the start of the stance, in which the foot settles flat (PLANT). */
  plantFraction: number;
  /** Maximum heel angle at toe-off, pivoting on the toes (degrees). */
  heelLiftAngle: number;
  /** Angle of the raised toes at heel strike (degrees). */
  heelStrikeAngle: number;
  /**
   * Natural variation (0 = every step identical; 1 = that of a person): cadence, trunk lean, gaze and the
   * swing of each arm change slightly and slowly, differently for each character (according to its `seed`).
   */
  variation: number;
  /** Knee bend when standing (degrees; if the model has its knees more bent at rest, the rest bend). */
  standKneeBend: number;
  /**
   * Bend of the supporting knee at landing and mid-stance, walking at `walkSpeed` (degrees). It grows with
   * speed (from `standKneeBend` when still), as in motion capture: at a brisk pace the knees cushion more and
   * the hips rise and fall less.
   */
  stanceKneeBend: number;
  /**
   * Extra knee bend when taking the weight after landing (cushioning), walking at `walkSpeed` (degrees; grows
   * with speed).
   */
  loadingKneeBend: number;

  /**
   * Distance to the neutral position below which a foot counts as repositioned (m). More is allowed forwards
   * and backwards: a foot slightly ahead when stopping is not corrected with another step.
   */
  idleStepThreshold: number;
  /** Orientation difference below which a foot counts as repositioned (degrees). */
  idleTurnThreshold: number;

  /** Maximum turning speed (degrees/s). */
  turnSpeed: number;
  /** Maximum angular acceleration (degrees/s²). */
  turnAcceleration: number;
  /**
   * Maximum lateral acceleration in curves (m/s²): the faster it goes, the slower it turns (ω ≤ a / v), like
   * a runner who cannot turn sharply at full speed.
   */
  maxLateralAcceleration: number;
  /**
   * Maximum turn of a foot between two of its steps (degrees): turning faster takes more steps per second.
   */
  maxTurnPerStep: number;
  /**
   * How much it slows down to turn (0–1): fraction of the speed it loses with a 180° turn left to go. The
   * smaller the remaining turn, the less it slows (none up to 20°), and it regains speed as it completes the
   * turn: large changes of direction happen in a tighter curve.
   */
  turnSlowdown: number;

  /** Fraction (0–1) of the way to the centre of support that the body shifts sideways. */
  lateralShift: number;
  /** How fast the body shifts sideways (rad/s of the damped spring). */
  lateralShiftResponse: number;

  // ---------- Avanzado: márgenes y sondas (m) ----------
  /** Minimum clearance between the toes and the terrain during the swing (m). */
  toeClearance: number;
  /** Maximum extra swing height to clear obstacles (m). */
  maxExtraStepHeight: number;
  /** Highest step it climbs (m): a higher riser is a wall, and the character stops in front of it. */
  maxStepUp: number;
  /** Deepest step it goes down (m): from a deeper drop it doesn't step down, it stops at the edge. */
  maxStepDown: number;
  /** Height above the root from which the ground under the body is searched (m). */
  groundProbeHeight: number;
  /** Depth below the root down to which the ground is searched when walking (m). */
  groundProbeDepth: number;
  /** Height above the target ankle from which the ground under each foot is searched (m). */
  footProbeHeight: number;
  /** Depth below the target ankle down to which the ground under each foot is searched (m). */
  footProbeDepth: number;
  /**
   * Minimum height difference of the ground under the toes relative to the heel plane for the foot to tilt
   * (m).
   */
  footProbeTolerance: number;
  /** Distance ahead of the knee of the point it bends towards (IK pole) (m). Only at creation. */
  kneePoleDistance: number;
}

export const defaultLocomotionConfig: LocomotionConfig = {
  walkSpeed: 1.4,
  runSpeed: 3.0,
  runStartSpeed: 1.7,
  runTransition: 0.6,
  acceleration: 1.5,
  deceleration: 2.5,
  speedEasing: 0.35,

  stepFrequency: 1.9,
  minStepFrequency: 1.4,
  stepLength: 0.8,
  stepWidth: null,
  stepHeight: 0.045,

  dutyFactor: 0.61,
  walkLandingLead: 0.8,

  runStepFrequency: 2.9,
  runStepLength: 1.2,
  runDutyFactor: 0.35,
  runStepHeight: 0.15,
  runHeelLiftAngle: 45,
  runHeelStrikeAngle: 2,
  runCrouch: 0.08,
  runBounce: 0.03,
  runLandingLead: 0.6,
  runLean: 10,
  walkLean: 0,
  ankleBack: 0.03,
  idleArmAbduction: 10,
  idleElbowBend: 14,
  idleArmForward: -4,
  runArmAbduction: 9,
  runElbowBend: 95,
  runArmSwing: 25,
  runElbowSwingBend: 10,

  crouchDepth: 0.32,
  crouchHipBack: 0.06,
  crouchPelvisTilt: 15,
  crouchLean: 20,
  crouchElbowBend: 35,
  crouchArmForward: 15,
  crouchMaxSpeed: 0.8,
  crouchRate: 1.8,

  gravity: 9.81,
  jumpSpeed: 3.2,
  jumpCrouch: 0.12,
  jumpToeOff: 30,
  jumpTuck: 0.22,
  jumpLandingPrep: 0.22,
  landingAbsorb: 0.05,
  maxLandingDip: 0.25,
  landingTime: 0.45,
  liftFraction: 0.22,
  plantFraction: 0.08,
  heelLiftAngle: 55,
  heelStrikeAngle: 20,
  variation: 1,
  standKneeBend: 5,
  stanceKneeBend: 12,
  loadingKneeBend: 14,

  idleStepThreshold: 0.03,
  idleTurnThreshold: 8,

  turnSpeed: 60,
  turnAcceleration: 240,
  maxLateralAcceleration: 3.2,
  maxTurnPerStep: 60,
  turnSlowdown: 0.45,

  lateralShift: 0.25,
  lateralShiftResponse: 20,

  toeClearance: 0.02,
  maxExtraStepHeight: 0.3,
  maxStepUp: 0.35,
  maxStepDown: 0.35,
  groundProbeHeight: 1.5,
  groundProbeDepth: 2.5,
  footProbeHeight: 0.5,
  footProbeDepth: 0.6,
  footProbeTolerance: 0.002,
  kneePoleDistance: 0.6,

  pelvisRotation: 5,
  pelvisObliquity: 4,
  pelvisTilt: 3,
  pelvisTiltSwing: 2,
  pelvisFrequency: 2.5,
  pelvisDamping: 0.7,

  spineCounterRotation: 0.6,
  chestCounterRotation: 0.6,
  chestRollShare: 0.35,
  leanPerAcceleration: 4,
  maxLean: 6,
  headStabilization: 0.8,
  headTurnLead: 0.6,
  maxHeadTurn: 45,
  chestTurnLead: 0.3,
  maxChestTurn: 20,
  maxTurnLean: 8,
  trunkFrequency: 4,
  trunkDamping: 0.6,
  trunkInertia: 0.5,

  armAbduction: 6,
  armForward: 0,
  elbowBend: 22,
  armSwing: 15,
  elbowSwingBend: 12,
  armSwingFrequency: 3.5,
  armSwingDamping: 0.7,
  armInertia: 2,
  shoulderSwing: 0.25,
  shoulderDrop: 3,
  shoulderForward: 0,
  forearmFrequency: 3,
  handFrequency: 4,
  fingerCurl: 1,
  fingerFrequency: 3.5,

  touchReachTime: 0.75,
  touchReleaseTime: 0.65,
  touchHoldTime: 0.25,
  touchMaxReach: 0.82,
  touchCooldown: 0.3,
};
