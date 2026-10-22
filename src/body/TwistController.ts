import { type Bone, Quaternion, Vector3 } from 'three';

import type { HumanRig } from '../rig/HumanRig.ts';

/** Fraction of the axial rotation given to each twist bone. */
export const TWIST_SHARE = 0.5;

interface TwistLink {
  /** Twist bone: child of the segment, outside the chain. */
  bone: Bone;
  rest: Quaternion;
  /** Axis of the segment in the twist bone's local space. */
  axis: Vector3;
  /** Bone whose axial rotation (relative to its rest pose) is distributed. */
  source: Bone;
  sourceRest: Quaternion;
  /** Axis of the segment in the local rest space of `source`. */
  sourceAxis: Vector3;
  /**
   * + receives part of the rotation of the distal bone; − compensates part of the rotation of the segment
   * itself.
   */
  share: number;
}

/**
 * Distributes the twist along arms and legs, like the `twist` bones of game rigs.
 *
 * Twist bones are children of the segment (they are not part of the chain, so IK doesn't see them).
 * Every frame, after the skeleton has been posed:
 *  - distal (`forearmTwist`, `shinTwist`): they receive `TWIST_SHARE` of the axial rotation of the hand or
 *    foot relative to the segment, so that the wrist or ankle doesn't twist abruptly;
 *  - proximal (`upperArmTwist`, `thighTwist`): they undo `TWIST_SHARE` of the axial rotation of the
 *    segment itself relative to its parent, so that the shoulder or hip doesn't twist.
 */
export class TwistController {
  private readonly links: TwistLink[] = [];
  private readonly delta = new Quaternion();
  private readonly q = new Quaternion();

  constructor(rig: HumanRig) {
    for (const leg of [rig.left, rig.right]) {
      this.add(leg.thighTwist, leg.thigh, leg.shin, -TWIST_SHARE);
      this.add(leg.shinTwist, leg.shin, leg.foot, TWIST_SHARE);
    }
    for (const arm of [rig.leftArm, rig.rightArm]) {
      if (!arm) continue;
      this.add(arm.upperArmTwist, arm.upperArm, arm.forearm, -TWIST_SHARE);
      this.add(arm.forearmTwist, arm.forearm, arm.hand, TWIST_SHARE);
    }
  }

  /** Number of active twist bones. */
  get count(): number {
    return this.links.length;
  }

  /**
   * @param segment  Bone the twist bone hangs from (thigh, shin, upper arm, forearm).
   * @param child    Next bone in the chain: it defines the axis of the segment.
   * @param share    > 0: the rotation comes from `child`; < 0: it comes from `segment` itself.
   */
  private add(bone: Bone | undefined, segment: Bone, child: Bone, share: number): void {
    if (!bone || child.position.lengthSq() < 1e-12) return;
    const segmentAxis = child.position.clone().normalize();
    const rest = bone.quaternion.clone();
    const source = share > 0 ? child : segment;
    const sourceRest = source.quaternion.clone();
    // Distal: el eje del segmento visto desde el reposo de la mano/pie. Proximal: el propio eje.
    const sourceAxis = share > 0 ? segmentAxis.clone().applyQuaternion(sourceRest.clone().invert()) : segmentAxis.clone();
    this.links.push({
      bone,
      rest,
      axis: segmentAxis.clone().applyQuaternion(rest.clone().invert()),
      source,
      sourceRest,
      sourceAxis,
      share,
    });
  }

  /** Applies the twist according to the current pose. Call after everything else has posed the skeleton. */
  update(): void {
    for (const link of this.links) {
      // Giro de `source` respecto a su reposo, en su propio espacio local; nos quedamos con su
      // componente alrededor del eje del segmento (descomposición swing-twist).
      this.delta.copy(link.sourceRest).invert().multiply(link.source.quaternion);
      const angle = twistAngle(this.delta, link.sourceAxis);
      this.q.setFromAxisAngle(link.axis, angle * link.share);
      link.bone.quaternion.copy(link.rest).multiply(this.q);
    }
  }

  /** Returns the twist bones to their rest pose. */
  reset(): void {
    for (const link of this.links) link.bone.quaternion.copy(link.rest);
  }
}

/** Angle (rad, in [−π, π]) of the component of `q` that rotates about `axis` (unit). */
export function twistAngle(q: Quaternion, axis: Vector3): number {
  const p = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const sign = q.w < 0 ? -1 : 1;
  return 2 * Math.atan2(p * sign, q.w * sign);
}
