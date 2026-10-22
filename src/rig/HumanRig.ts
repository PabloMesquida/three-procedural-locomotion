import { type Bone, type Object3D, Vector3 } from 'three';

/**
 * Abstraction of the human rig.
 * The rest of the system (IK, locomotion…) works with this structure and never with specific bone names.
 */

export type Side = 'left' | 'right';

export interface LegBones {
  thigh: Bone;
  shin: Bone;
  foot: Bone;
  toe?: Bone;
  /** Twist bone (optional) of the upper half of the thigh: child of `thigh`, outside the chain. */
  thighTwist?: Bone;
  /** Twist bone (optional) of the lower half of the shin: child of `shin`, outside the chain. */
  shinTwist?: Bone;
}

/** Fingers of a hand. */
export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
export const FINGER_NAMES: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/** Phalanges of each finger, from the base to the tip (each one a child of the previous one). */
export type FingerBones = Partial<Record<FingerName, Bone[]>>;

export interface ArmBones {
  shoulder?: Bone;
  upperArm: Bone;
  forearm: Bone;
  hand: Bone;
  /** Fingers (optional): if present, the hand relaxes instead of staying in the model's rest pose. */
  fingers?: FingerBones;
  /** Twist bone (optional) of the upper half of the upper arm: child of `upperArm`, outside the chain. */
  upperArmTwist?: Bone;
  /** Twist bone (optional) of the lower half of the forearm: child of `forearm`, outside the chain. */
  forearmTwist?: Bone;
}

export interface HumanRig {
  /** Root of the loaded model (for example, gltf.scene). */
  root: Object3D;
  hips: Bone;
  left: LegBones;
  right: LegBones;
  spine?: Bone;
  chest?: Bone;
  neck?: Bone;
  head?: Bone;
  leftArm?: ArmBones;
  rightArm?: ArmBones;
}

/** Explicit mapping: the same shape as HumanRig, but with bone names. */
export interface LegMapping {
  thigh: string;
  shin: string;
  foot: string;
  toe?: string;
  /** Twist bone of the thigh (optional): direct child of `thigh`, in its upper half. */
  thighTwist?: string;
  /** Twist bone of the shin (optional): direct child of `shin`, in its lower half. */
  shinTwist?: string;
}

/** Names of the phalanges of each finger, from the base to the tip (usually 3). */
export type FingerMapping = Partial<Record<FingerName, string[]>>;

export interface ArmMapping {
  shoulder?: string;
  upperArm: string;
  forearm: string;
  hand: string;
  /** Fingers (optional). Without them, the fingers stay as in the model's rest pose. */
  fingers?: FingerMapping;
  /** Twist bone of the upper arm (optional): direct child of `upperArm`, in its upper half. */
  upperArmTwist?: string;
  /** Twist bone of the forearm (optional): direct child of `forearm`, in its lower half. */
  forearmTwist?: string;
}

export interface HumanRigMapping {
  hips: string;
  left: LegMapping;
  right: LegMapping;
  spine?: string;
  chest?: string;
  neck?: string;
  head?: string;
  leftArm?: ArmMapping;
  rightArm?: ArmMapping;
}

const UP = new Vector3(0, 1, 0);

/**
 * Estimates the character's "forward" direction in world space (horizontal), from the rig and without
 * assuming the model's axes.
 *  - 'toes':    average of (toes − ankle) of both feet.
 *  - 'lateral': UP × (right hip − left hip).
 */
export function estimateForward(
  rig: HumanRig,
  source: 'toes' | 'lateral',
  out = new Vector3(),
): Vector3 {
  out.set(0, 0, 0);
  const a = new Vector3();
  const b = new Vector3();

  if (source === 'toes') {
    for (const leg of [rig.left, rig.right]) {
      if (!leg.toe) continue;
      leg.toe.getWorldPosition(a);
      leg.foot.getWorldPosition(b);
      out.add(a.sub(b));
    }
  } else {
    rig.right.thigh.getWorldPosition(a);
    rig.left.thigh.getWorldPosition(b);
    out.crossVectors(UP, a.sub(b));
  }

  out.y = 0;
  return out.lengthSq() > 1e-12 ? out.normalize() : out;
}

/**
 * Average leg length (hip → knee → ankle, m, in world space) in the current pose. Used to scale
 * parameters to the character's size.
 */
export function measureLegLength(rig: HumanRig): number {
  rig.root.updateWorldMatrix(true, true);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const length = (side: Side): number => {
    rig[side].thigh.getWorldPosition(a);
    rig[side].shin.getWorldPosition(b);
    rig[side].foot.getWorldPosition(c);
    return a.distanceTo(b) + b.distanceTo(c);
  };
  return (length('left') + length('right')) / 2;
}
