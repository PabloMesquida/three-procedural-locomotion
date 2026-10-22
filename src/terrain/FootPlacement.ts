import { Matrix4, type Object3D, Quaternion, Vector3 } from 'three';

import type { LegBones } from '../rig/HumanRig.ts';
import { createGroundHit, type GroundDetector, type GroundHit } from './GroundDetector.ts';

export interface FootPlacementConfig {
  /** Height above the desired ankle position from which the ray is cast (m). */
  castHeight: number;
  /** Distance the ray goes below the desired position (m). */
  castDepth: number;
  /** Maximum tilt of the foot relative to the vertical (rad). */
  maxFootTilt: number;
  /** How far the ground under the toes must be above the plane of the heel to tilt the foot (m). */
  toeTolerance: number;
}

export const defaultFootPlacementConfig: FootPlacementConfig = {
  castHeight: 0.5,
  castDepth: 0.6,
  maxFootTilt: (35 * Math.PI) / 180,
  toeTolerance: 0.002,
};

/** State of a foot after querying the ground. All in world space. */
export interface FootGroundState {
  /** There is ground under the heel (ankle). */
  grounded: boolean;
  hit: GroundHit;
  rayOrigin: Vector3;
  rayEnd: Vector3;
  /** Raycast under the toes (only if the rig has `toe`). */
  toeGrounded: boolean;
  toeHit: GroundHit;
  toeRayOrigin: Vector3;
  toeRayEnd: Vector3;
  /** The ground under the toes was higher than the plane of the heel and was used to tilt the foot. */
  usedToe: boolean;
  /** Where the ankle must end up (target for IK). */
  ankleTarget: Vector3;
  /** World rotation of the foot, resting on the ground. */
  footRotation: Quaternion;
}

const UP = new Vector3(0, 1, 0);
const IDENTITY = new Quaternion();
/** Margin for considering that the ground under the toes "sticks out" of the plane of the heel (m). */

/**
 * Places a foot on the terrain:
 *   desired ankle position → raycast under the heel (+ under the toes)
 *   → ground point + normal → ankle target + foot rotation.
 *
 * Orientation of the foot:
 *  - By default, the normal of the ground under the heel.
 *  - If the ground under the toes is higher than that plane (bump, step), the foot tilts about the
 *    heel→toes line so as not to go through it.
 *  - If it is lower (edge of a step), the foot stays resting on the heel and the toes stay in the air.
 *
 * It is calibrated in the rest pose, with the character standing on its origin:
 *  - height of the ankle above the ground,
 *  - position of the toes relative to the ankle,
 *  - rotation of the foot relative to the character's root.
 */
export class FootPlacement {
  readonly leg: LegBones;
  readonly config: FootPlacementConfig;
  readonly state: FootGroundState;

  /** Height of the ankle above the sole at rest (m). */
  readonly ankleHeight: number;

  private readonly detector: GroundDetector;
  private readonly characterRoot: Object3D;
  private readonly restAnkleLocal = new Vector3();
  /** Ankle→toes vector at rest, horizontal, in root space. */
  private readonly restToeOffsetLocal = new Vector3();
  private readonly hasToe: boolean;
  private readonly soleDir = new Vector3();
  private readonly v = new Vector3();
  private readonly n = new Vector3();
  private readonly m0 = new Matrix4();
  private readonly m1 = new Matrix4();
  private readonly restFootRelRotation = new Quaternion();
  private readonly tilt = new Quaternion();
  private readonly qRoot = new Quaternion();
  private readonly qYaw = new Quaternion();
  private readonly binormal0 = new Vector3();
  private readonly binormal1 = new Vector3();

  constructor(
    detector: GroundDetector,
    characterRoot: Object3D,
    leg: LegBones,
    config: FootPlacementConfig = defaultFootPlacementConfig,
  ) {
    this.detector = detector;
    this.characterRoot = characterRoot;
    this.leg = leg;
    this.config = config;

    characterRoot.updateWorldMatrix(true, true);
    const ankle = leg.foot.getWorldPosition(new Vector3());
    const rootPos = characterRoot.getWorldPosition(new Vector3());
    this.ankleHeight = ankle.y - rootPos.y;
    this.restAnkleLocal.copy(characterRoot.worldToLocal(ankle.clone()));

    this.hasToe = leg.toe !== undefined;
    if (leg.toe) {
      const toe = characterRoot.worldToLocal(leg.toe.getWorldPosition(new Vector3()));
      // Diferencia en el espacio local de la raíz, devuelta a metros: solo se le aplica la
      // rotación de la raíz al usarla, así que hay que quitarle la escala de la raíz.
      const rootScale = characterRoot.getWorldScale(new Vector3());
      this.restToeOffsetLocal.subVectors(toe, this.restAnkleLocal).multiply(rootScale).setY(0);
    }

    const rootQ = characterRoot.getWorldQuaternion(new Quaternion());
    const footQ = leg.foot.getWorldQuaternion(new Quaternion());
    this.restFootRelRotation.copy(rootQ.invert().multiply(footQ));

    this.state = {
      grounded: false,
      hit: createGroundHit(),
      rayOrigin: new Vector3(),
      rayEnd: new Vector3(),
      toeGrounded: false,
      toeHit: createGroundHit(),
      toeRayOrigin: new Vector3(),
      toeRayEnd: new Vector3(),
      usedToe: false,
      ankleTarget: new Vector3(),
      footRotation: new Quaternion(),
    };
  }

  /** Position of the ankle at rest, following the character's root (world). */
  restAnklePosition(out: Vector3): Vector3 {
    this.characterRoot.updateWorldMatrix(true, false);
    return this.characterRoot.localToWorld(out.copy(this.restAnkleLocal));
  }

  /**
   * Looks for the ground under `desiredAnkle` (world) and computes the target and rotation of the foot.
   * `yawOffset` (rad, about the vertical axis) orients the foot as if the character had already turned by
   * that angle (useful to plan a step during a turn).
   */
  update(desiredAnkle: Vector3, yawOffset = 0): FootGroundState {
    const { state, config, tilt } = this;
    const maxDistance = config.castHeight + config.castDepth;
    this.characterRoot.getWorldQuaternion(this.qRoot);
    if (yawOffset !== 0) this.qRoot.premultiply(this.qYaw.setFromAxisAngle(UP, yawOffset));

    // --- Raycast bajo el talón ---
    state.rayOrigin.copy(desiredAnkle);
    state.rayOrigin.y += config.castHeight;
    state.rayEnd.copy(state.rayOrigin);
    state.rayEnd.y -= maxDistance;
    state.grounded = this.detector.castDown(state.rayOrigin, maxDistance, state.hit);

    // --- Raycast bajo los dedos ---
    state.toeGrounded = false;
    state.usedToe = false;
    if (this.hasToe) {
      this.v.copy(this.restToeOffsetLocal).applyQuaternion(this.qRoot);
      state.toeRayOrigin.copy(state.rayOrigin).add(this.v);
      state.toeRayEnd.copy(state.toeRayOrigin);
      state.toeRayEnd.y -= maxDistance;
      state.toeGrounded = this.detector.castDown(state.toeRayOrigin, maxDistance, state.toeHit);
    }

    if (!state.grounded) {
      tilt.identity();
      state.ankleTarget.copy(desiredAnkle);
    } else {
      const heel = state.hit.point;
      const nHeel = state.hit.normal;

      if (state.toeGrounded && this.toeAboveHeelPlane()) {
        // Inclinar el pie sobre la línea talón→dedos.
        state.usedToe = true;
        this.soleDir.subVectors(state.toeHit.point, heel).normalize();
        this.n.addVectors(nHeel, state.toeHit.normal).normalize();
        this.n.addScaledVector(this.soleDir, -this.n.dot(this.soleDir)).normalize();

        // Marco en reposo (dirección del pie, arriba) → marco sobre el suelo.
        this.v.copy(this.restToeOffsetLocal).applyQuaternion(this.qRoot).normalize();
        this.m0.makeBasis(this.v, UP, this.binormal0.crossVectors(this.v, UP)).transpose();
        this.m1.makeBasis(this.soleDir, this.n, this.binormal1.crossVectors(this.soleDir, this.n)).multiply(this.m0);
        tilt.setFromRotationMatrix(this.m1);
      } else {
        tilt.setFromUnitVectors(UP, nHeel);
      }

      // Limitar la inclinación máxima del pie.
      const angle = 2 * Math.acos(Math.min(1, Math.abs(tilt.w)));
      if (angle > config.maxFootTilt) tilt.slerp(IDENTITY, 1 - config.maxFootTilt / angle);

      // El tobillo queda sobre el talón, a su altura, en la dirección "arriba" del pie.
      this.n.copy(UP).applyQuaternion(tilt);
      state.ankleTarget.copy(heel).addScaledVector(this.n, this.ankleHeight);
    }

    // rotación del pie = inclinación del suelo · orientación del personaje · pie en reposo
    state.footRotation.copy(tilt).multiply(this.qRoot).multiply(this.restFootRelRotation);

    return state;
  }

  /** Is the ground under the toes above the plane of the ground under the heel? */
  private toeAboveHeelPlane(): boolean {
    const { hit, toeHit } = this.state;
    const n = hit.normal;
    if (n.y < 1e-6) return true;
    const p = toeHit.point;
    const predictedY = hit.point.y - (n.x * (p.x - hit.point.x) + n.z * (p.z - hit.point.z)) / n.y;
    return p.y > predictedY + this.config.toeTolerance;
  }
}
