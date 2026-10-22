import { Quaternion, Vector3 } from 'three';

import type { Side } from '../rig/HumanRig.ts';

/**
 * State of a foot in the locomotion (decided by the GaitController):
 *  - PLANT:   has just landed
 *  - PLANTED: on the ground
 *  - LIFT:    at the end of the stance, about to take off
 *  - SWING:   in the air
 */
export type FootPhase = 'PLANT' | 'PLANTED' | 'LIFT' | 'SWING';

export interface SwingState {
  start: Vector3;
  end: Vector3;
  startRotation: Quaternion;
  endRotation: Quaternion;
  /** Planted pose (flat foot) where the foot will be at the end of PLANT. */
  landing: Vector3;
  landingRotation: Quaternion;
  /**
   * Velocity of the ankle at toe-off, in meters per unit of `t` (velocity × swing duration): when walking,
   * the swing starts with it (the heel rises faster and faster until toe-off).
   */
  startTangent: Vector3;
  /** Progress of the swing, 0 → 1. */
  t: number;
  /** Height of the arc for this step (m): stepHeight, or more if there is an obstacle. */
  height: number;
  /** Angle at which it lands on the heel (rad): the one used for `end`; PLANT lowers the toes from it. */
  heelStrike: number;
  /**
   * Horizontal deviation of the path at mid-swing (m, world; added × sin²(π·t), which starts and ends with
   * no velocity, so toe-off and landing don't change): to go around the planted foot if the straight line
   * passes over it (when turning around). Usually zero.
   */
  detour: Vector3;
  /**
   * Change of landing point mid-swing (when braking): from `retargetFrom` (progress; ≥ 1 = none) the end
   * smoothly goes from `previousEnd`/`previousEndRotation` to `end`/`endRotation`, without changing either
   * the position or the velocity of the foot at that moment.
   */
  retargetFrom: number;
  previousEnd: Vector3;
  previousEndRotation: Quaternion;
}

/** Where a foot is (or where it is going). All in world space; the position is that of the ankle. */
export interface FootTarget {
  side: Side;
  phase: FootPhase;
  /** Current pose of the ankle (the one IK uses). */
  position: Vector3;
  rotation: Quaternion;
  /** Pose of the flat foot at its last stance (basis for LIFT / PLANT). */
  planted: Vector3;
  plantedRotation: Quaternion;
  swing: SwingState;
  /** Steps completed by this foot. */
  steps: number;
}

export function createFootTarget(side: Side): FootTarget {
  return {
    side,
    phase: 'PLANTED',
    position: new Vector3(),
    rotation: new Quaternion(),
    planted: new Vector3(),
    plantedRotation: new Quaternion(),
    swing: {
      start: new Vector3(),
      end: new Vector3(),
      startRotation: new Quaternion(),
      endRotation: new Quaternion(),
      landing: new Vector3(),
      landingRotation: new Quaternion(),
      startTangent: new Vector3(),
      t: 0,
      height: 0,
      heelStrike: 0,
      detour: new Vector3(),
      retargetFrom: 1,
      previousEnd: new Vector3(),
      previousEndRotation: new Quaternion(),
    },
    steps: 0,
  };
}

/**
 * Running or stepping up: initial (and final) fraction of the swing in which the foot rises (or lowers)
 * barely moving forward.
 */
const LIFT_DELAY = 0.12;
/**
 * Walking: fraction of the swing at which the arc reaches its maximum height (mocap: shortly after
 * toe-off).
 */
const ARC_PEAK = 0.25;
/**
 * Walking: initial fraction of the swing in which the foot stays extended before it starts raising the
 * toes.
 */
const TOE_UP_DELAY = 0.15;

/**
 * Procedural swing trajectory. `walk` (0–1) blends the walking shape (1) with the running one (0).
 *
 * When walking, the shape from motion capture (CMU):
 *  - the foot leaves with the velocity it had at toe-off (`startTangent`) and moves forward from the
 *    start, without first rising in place (Hermite curve: continuous position and velocity);
 *  - the base height goes from that of toe-off (heel raised) to that of landing over the swing: the foot
 *    reaches its highest point shortly after toe-off and then glides down;
 *  - on top, an arc of height `height` is added, peaking shortly after toe-off;
 *  - the toes rise gradually, after a short delay: it lands on the heel with the toes up.
 * When running, the foot first rises and then moves forward, with the arc at mid-swing and the toes
 * raised early. When stepping up, it always rises first (so as not to hit the edge).
 * When running it starts with no velocity; in every case it lands with none (see `swingArc`).
 */
export function evaluateSwing(
  swing: SwingState,
  t: number,
  height: number,
  outPosition: Vector3,
  outRotation: Quaternion,
  walk = 1,
): void {
  const goingUp = swing.end.y > swing.start.y;
  // Hermite con la velocidad del despegue y llegada sin velocidad: smoothstep + h10·tangente.
  const h10 = t * (1 - t) * (1 - t);
  const tangent = goingUp ? 0 : walk;
  const { s, k, turn } = swingBlend(swing, t, walk);
  // Final efectivo: con un cambio de aterrizaje en marcha, del anterior al nuevo con un smoothstep que
  // empieza sin pendiente (ni salto de posición ni de velocidad).
  let end = swing.end;
  let endRotation = swing.endRotation;
  if (swing.retargetFrom < 1 && t < 1) {
    const g = smoothstep((t - swing.retargetFrom) / (1 - swing.retargetFrom));
    end = retargetEnd.lerpVectors(swing.previousEnd, swing.end, g);
    endRotation = retargetRotation.slerpQuaternions(swing.previousEndRotation, swing.endRotation, g);
  }
  outPosition.lerpVectors(swing.start, end, s).addScaledVector(swing.startTangent, h10 * tangent);
  outPosition.addScaledVector(swing.detour, Math.sin(Math.PI * t) ** 2);
  outPosition.y = swing.start.y + (end.y - swing.start.y) * k + swing.startTangent.y * h10 * tangent + height * swingArc(t, walk);
  outRotation.slerpQuaternions(swing.startRotation, endRotation, turn);
}

const retargetEnd = new Vector3();
const retargetRotation = new Quaternion();

/**
 * End of the swing as the foot is following it at `t`: with a landing change in progress, between the
 * previous one and the new one (see `retargetFrom`). For whoever anticipates the landing (the hips): with
 * the new one all at once, they would jerk.
 */
export function effectiveSwingEnd(swing: SwingState, t: number, out: Vector3): Vector3 {
  if (swing.retargetFrom >= 1 || t >= 1) return out.copy(swing.end);
  return out.lerpVectors(swing.previousEnd, swing.end, smoothstep((t - swing.retargetFrom) / (1 - swing.retargetFrom)));
}

/**
 * How much of the path from start to end the swing has covered at `t`: horizontally (`s`), vertically
 * (`k`) and in orientation (`turn`).
 */
function swingBlend(swing: SwingState, t: number, walk: number): { s: number; k: number; turn: number } {
  const goingUp = swing.end.y > swing.start.y;
  const delayed = smoothstep((t - LIFT_DELAY) / (1 - 2 * LIFT_DELAY));
  return {
    s: goingUp ? delayed : mix(delayed, smoothstep(t), walk),
    k: goingUp ? smoothstep(t / 0.6) : mix(smoothstep((t - 0.4) / 0.6), smoothstep(t), walk),
    turn: mix(smoothstep(t / 0.5), smoothstep((t - TOE_UP_DELAY) / (1 - TOE_UP_DELAY)), walk),
  };
}

/**
 * Shape of the swing arc (0 → 1 → 0). When running, it rises like a sine (quick toe-off, the toes don't
 * scrape) up to the middle; when walking, smoothly up to ARC_PEAK (the heel is already raised at toe-off).
 * It goes down with a smoothstep that reaches the ground with no vertical velocity: with the full sine the
 * foot landed at ~0.8 m/s and, since the leg about to land limits the height of the hips, it dragged them
 * down just before contact.
 */
export function swingArc(t: number, walk = 1): number {
  const peak = 0.5 + (ARC_PEAK - 0.5) * walk;
  if (t >= peak) return 1 - smoothstep((t - peak) / (1 - peak));
  return mix(Math.sin((Math.PI / 2) * (t / peak)), smoothstep(t / peak), walk);
}

function mix(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function smoothstep(x: number): number {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
}
