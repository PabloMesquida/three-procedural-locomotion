import { Quaternion, Vector3 } from 'three';

import { setWorldQuaternionNode, updateSubtree } from '../core/pose.ts';
import type { LegBones } from '../rig/HumanRig.ts';
import { TwoBoneIK, type TwoBoneIKResult } from './TwoBoneIK.ts';

/**
 * IK for one leg of the HumanRig (thigh → shin → foot).
 *
 * - Stores the rest pose: each solve starts from the same state (deterministic result, no error
 *   accumulation between frames).
 * - Computes once the knee's hinge axis (in the thigh's local space) from the rest pose and the
 *   character's "forward" direction. That way the knee always bends like a hinge and, if the pole moves to
 *   one side, it is the whole thigh that rotates.
 */
export class LegIK {
  readonly leg: LegBones;
  private readonly solver = new TwoBoneIK();
  private readonly restThigh: Quaternion;
  private readonly restShin: Quaternion;
  private readonly restFoot: Quaternion;
  private readonly hingeAxis = new Vector3();

  /**
   * @param leg      Bones of the leg, in their rest pose.
   * @param forward  "Forward" direction of the character in world space (where the knees bend towards).
   */
  constructor(leg: LegBones, forward: Vector3) {
    this.leg = leg;
    this.restThigh = leg.thigh.quaternion.clone();
    this.restShin = leg.shin.quaternion.clone();
    this.restFoot = leg.foot.quaternion.clone();

    // Eje de bisagra = perpendicular al plano (eje de la pierna, forward), en espacio del muslo.
    leg.thigh.updateWorldMatrix(true, true);
    const hip = leg.thigh.getWorldPosition(new Vector3());
    const chain = leg.foot.getWorldPosition(new Vector3()).sub(hip).normalize();
    const front = forward.clone().addScaledVector(chain, -forward.dot(chain)).normalize();
    const thighWorld = leg.thigh.getWorldQuaternion(new Quaternion());
    this.hingeAxis.crossVectors(chain, front).normalize().applyQuaternion(thighWorld.invert());
  }

  /** Returns the leg to the pose it had when the LegIK was created. */
  resetToRest(): void {
    this.leg.thigh.quaternion.copy(this.restThigh);
    this.leg.shin.quaternion.copy(this.restShin);
    this.leg.foot.quaternion.copy(this.restFoot);
  }

  /**
   * Places the ankle at `target` with the knee oriented towards `pole` (both in world space).
   * If `footRotation` (world) is given, the foot takes that orientation; otherwise it keeps its rest one.
   */
  solve(target: Vector3, pole: Vector3, footRotation?: Quaternion): TwoBoneIKResult {
    this.resetToRest();
    const result = this.solver.solve({
      rootBone: this.leg.thigh,
      middleBone: this.leg.shin,
      endBone: this.leg.foot,
      target,
      poleTarget: pole,
      hingeAxis: this.hingeAxis,
    });
    if (footRotation) {
      setWorldQuaternionNode(this.leg.foot, footRotation);
      updateSubtree(this.leg.foot);
    }
    return result;
  }
}
