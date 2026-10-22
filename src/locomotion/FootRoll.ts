import { type Bone, type Object3D, Quaternion, Vector3 } from 'three';

import type { LegBones } from '../rig/HumanRig.ts';

const UP = new Vector3(0, 1, 0);

/**
 * Rolling the foot over the heel or over the toes.
 *
 * It is calibrated in the rest pose (foot flat on the ground) and stores, in the foot's space (rotation
 * only, no scale):
 *  - heel contact point (under the ankle),
 *  - toe contact point (under the toes),
 *  - toe joint (the base of the `toe` bone): the heel rises about it, as in a real foot (the toes stay on
 *    the ground and bend, see `bendToe`),
 *  - lateral axis the foot pivots about.
 *
 * Positive angle = the toes go down / the heel goes up.
 */
export class FootRoll {
  /** Heel contact point, relative to the ankle, in foot space. */
  readonly heelLocal = new Vector3();
  /** Toe contact point, relative to the ankle, in foot space. */
  readonly toeLocal = new Vector3();
  /** Pivot axis (unit), in foot space. */
  readonly axisLocal = new Vector3();
  /**
   * Point the heel rises about, relative to the ankle, in foot space: the toe joint if the rig has `toe`
   * (otherwise, the toe contact point).
   */
  readonly ballLocal = new Vector3();

  /** Toe bone (if it is a direct child of the foot), its rest rotation and the lateral axis in its space. */
  private readonly toe?: Bone;
  private readonly toeRest = new Quaternion();
  private readonly toeAxis = new Vector3();
  private readonly qToe = new Quaternion();

  private readonly pivot = new Vector3();
  private readonly axis = new Vector3();
  private readonly q = new Quaternion();

  constructor(leg: LegBones, characterRoot: Object3D) {
    characterRoot.updateWorldMatrix(true, true);
    const ankle = leg.foot.getWorldPosition(new Vector3());
    const rootY = characterRoot.getWorldPosition(new Vector3()).y;
    const invFoot = leg.foot.getWorldQuaternion(new Quaternion()).invert();

    // Talón: en el suelo, justo bajo el tobillo.
    this.heelLocal.set(0, rootY - ankle.y, 0).applyQuaternion(invFoot);

    // Punta: en el suelo, bajo los dedos (o 15 cm delante si el rig no tiene `toe`).
    const forward = new Vector3();
    if (leg.toe) {
      const toe = leg.toe.getWorldPosition(new Vector3());
      forward.subVectors(toe, ankle).setY(0);
      this.toeLocal.set(toe.x - ankle.x, rootY - ankle.y, toe.z - ankle.z).applyQuaternion(invFoot);
    } else {
      forward.set(0, 0, -1).applyQuaternion(leg.foot.getWorldQuaternion(new Quaternion())).setY(0);
      forward.normalize().multiplyScalar(0.15);
      this.toeLocal.set(forward.x, rootY - ankle.y, forward.z).applyQuaternion(invFoot);
    }

    // Eje lateral, orientado para que un ángulo positivo baje la punta (y suba el talón).
    const axisWorld = new Vector3().crossVectors(UP, forward).normalize();
    const heelAfter = new Vector3(0, rootY - ankle.y, 0).sub(new Vector3(forward.x, rootY - ankle.y, forward.z));
    heelAfter.applyAxisAngle(axisWorld, 0.1);
    if (heelAfter.y < 0) axisWorld.negate();
    this.axisLocal.copy(axisWorld).applyQuaternion(invFoot);

    this.ballLocal.copy(this.toeLocal);
    if (leg.toe) {
      this.ballLocal.copy(leg.toe.getWorldPosition(new Vector3())).sub(ankle).applyQuaternion(invFoot);
      if (leg.toe.parent === leg.foot) {
        this.toe = leg.toe;
        this.toeRest.copy(leg.toe.quaternion);
        // Eje lateral en el espacio local del hueso de los dedos (hijo del pie).
        this.toeAxis.copy(this.axisLocal).applyQuaternion(this.toeRest.clone().invert());
      }
    }
  }

  /**
   * Bends the toes `angle` rad upwards relative to the foot (from their rest pose): with the heel raised
   * `angle` about its joint, the toes stay on the ground instead of digging into it.
   * Must be called after posing the foot (IK), every frame (0 = rest).
   */
  bendToe(angle: number): void {
    if (!this.toe) return;
    this.toe.quaternion.copy(this.toeRest).multiply(this.qToe.setFromAxisAngle(this.toeAxis, -angle));
  }

  /**
   * Rotates the pose of the foot (ankle + world rotation) by an angle about a contact point, which stays
   * fixed. Modifies `position` and `rotation`.
   */
  roll(position: Vector3, rotation: Quaternion, about: 'heel' | 'toe', angle: number): void {
    if (angle === 0) return;
    this.pivot.copy(about === 'heel' ? this.heelLocal : this.ballLocal).applyQuaternion(rotation).add(position);
    this.axis.copy(this.axisLocal).applyQuaternion(rotation);
    this.q.setFromAxisAngle(this.axis, angle);

    position.sub(this.pivot).applyQuaternion(this.q).add(this.pivot);
    rotation.premultiply(this.q);
  }
}
