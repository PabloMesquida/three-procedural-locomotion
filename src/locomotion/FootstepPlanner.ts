import { Quaternion, Vector3 } from 'three';

import type { HumanRig, Side } from '../rig/HumanRig.ts';
import type { FootPlacement } from '../terrain/FootPlacement.ts';
import type { FootTarget } from './FootTarget.ts';
import type { LocomotionConfig } from './LocomotionConfig.ts';

const UP = new Vector3(0, 1, 0);

/**
 * Natural distance between the feet, in hip widths (between the thighs): when walking the feet go
 * somewhat closer together than the hips (CMU motion capture: ≈ 0.8).
 */
const NATURAL_STEP_WIDTH = 0.8;

/**
 * Decides WHERE each foot lands:
 *  - neutral ("home") position of each foot: under the hip (at the height of the ankle at rest);
 *  - landing point of a step, placed on the terrain with FootPlacement.
 *
 * WHEN is decided by the GaitController.
 */
export class FootstepPlanner {
  readonly config: LocomotionConfig;

  private readonly rig: HumanRig;
  private readonly placements: Record<Side, FootPlacement>;
  /** Ankles at rest, in the space of the character's root. */
  private readonly homeLocal: Record<Side, Vector3>;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly zero = new Vector3();
  private readonly rootWorld = new Vector3();
  private readonly settleTarget = new Vector3();
  private readonly settleRotation = new Quaternion();
  /** Neutral positions of the rig at rest (root local space). */
  private readonly restHomeLocal: Record<Side, Vector3>;
  private appliedStepWidth: number | null | undefined = undefined;
  /** Hip width of the rig (root local space): default distance between the feet. */
  private readonly hipWidthLocal: number;
  /** Thighs (hip joint) at rest, in root local space. */
  private readonly thighLocal: Record<Side, Vector3>;
  /** Hip → ankle distance at rest (root local space): the extension of the leg at rest. */
  private readonly restReachLocal: Record<Side, number>;
  /** See `standHeight` (root local space). */
  private standLiftLocal = 0;
  /** Forward direction of the model at rest (root local space), if known. */
  private readonly forwardLocal: Vector3 | null = null;
  private appliedAnkleBack: number | undefined = undefined;

  /**
   * `forward`: direction (world, horizontal) the model faces at rest. With it, the neutral position of the
   * ankles ends up `ankleBack` behind the hips in the direction of travel, even if in the rest pose the feet
   * are forward or back (with the feet far back, when running the trailing leg can't reach and the hips
   * sink). Without it, the rest one.
   */
  constructor(rig: HumanRig, placements: Record<Side, FootPlacement>, config: LocomotionConfig, forward?: Vector3) {
    this.rig = rig;
    this.placements = placements;
    this.config = config;

    rig.root.updateWorldMatrix(true, true);
    const local = (side: Side): Vector3 =>
      rig.root.worldToLocal(rig[side].foot.getWorldPosition(new Vector3()));
    this.homeLocal = { left: local('left'), right: local('right') };
    this.restHomeLocal = { left: this.homeLocal.left.clone(), right: this.homeLocal.right.clone() };
    const thigh = (side: Side): Vector3 => rig.root.worldToLocal(rig[side].thigh.getWorldPosition(new Vector3()));
    this.thighLocal = { left: thigh('left'), right: thigh('right') };
    // Extensión de la pierna en reposo, con el pie donde está en la pose de reposo.
    this.restReachLocal = {
      left: this.thighLocal.left.distanceTo(this.restHomeLocal.left),
      right: this.thighLocal.right.distanceTo(this.restHomeLocal.right),
    };
    if (forward) {
      const inverse = rig.root.getWorldQuaternion(new Quaternion()).invert();
      this.forwardLocal = forward.clone().applyQuaternion(inverse);
      this.forwardLocal.addScaledVector(UP, -this.forwardLocal.dot(UP)).normalize();
      // Los dos tobillos a la altura (en la dirección de avance) del centro de las caderas: igual
      // para los dos pies, para que los pasos sean simétricos aunque el rig no lo sea del todo.
      const hips = this.tmp2.addVectors(this.thighLocal.left, this.thighLocal.right).multiplyScalar(0.5);
      for (const side of ['left', 'right'] as const) {
        const home = this.restHomeLocal[side];
        home.addScaledVector(this.forwardLocal, -this.tmp.subVectors(home, hips).dot(this.forwardLocal));
      }
    }
    // Anchura de las caderas (separación lateral de los muslos), en espacio local de la raíz.
    const lateral = this.tmp.subVectors(this.restHomeLocal.right, this.restHomeLocal.left);
    lateral.addScaledVector(UP, -lateral.dot(UP)).normalize();
    this.hipWidthLocal = Math.abs(this.tmp2.subVectors(this.thighLocal.right, this.thighLocal.left).dot(lateral));
    this.syncStepWidth();
  }

  /**
   * How much higher than at rest the hips are when standing (m, world, ≥ 0). With the feet in their
   * neutral position (at hip width, not at that of the rest pose), the legs can end up more vertical than at
   * rest: many rigs in A-pose have their legs apart or the feet a little back. At the rest height they would
   * have leg to spare and the knees would bend too much; at this height they recover the extension they had
   * at rest.
   */
  standHeight(): number {
    if (this.standLiftLocal === 0) return 0;
    // Escala de la raíz leída de su matriz world, sin recalcularla (la pone al día quien la mueve).
    return this.standLiftLocal * this.tmp.setFromMatrixScale(this.rig.root.matrixWorld).y;
  }

  /**
   * Applies `config.stepWidth` and `config.ankleBack` to the neutral positions if they changed. With
   * `stepWidth` null, the feet go at a fraction (`NATURAL_STEP_WIDTH`) of the rig's hip width (not that of
   * its rest pose: many rigs are in A-pose with their legs apart). It is called every update, so they can
   * be changed at runtime.
   */
  syncStepWidth(): void {
    const width = this.config.stepWidth;
    const back = this.config.ankleBack;
    if (width === this.appliedStepWidth && back === this.appliedAnkleBack) return;
    this.appliedStepWidth = width;
    this.appliedAnkleBack = back;
    this.homeLocal.left.copy(this.restHomeLocal.left);
    this.homeLocal.right.copy(this.restHomeLocal.right);
    // homeLocal está en el espacio local de la raíz (con su escala): las longitudes en metros se dividen por ella.
    const scale = this.rig.root.getWorldScale(this.tmp).x;
    this.applyStepWidth(width === null ? this.hipWidthLocal * NATURAL_STEP_WIDTH : width / scale);
    if (this.forwardLocal) {
      this.homeLocal.left.addScaledVector(this.forwardLocal, -back / scale);
      this.homeLocal.right.addScaledVector(this.forwardLocal, -back / scale);
    }
    this.standLiftLocal = Math.max(0, Math.min(this.standLift('left'), this.standLift('right')));
  }

  /**
   * Rise of the hips (root local space) at which that leg, with the foot in its neutral position, has its
   * rest extension.
   */
  private standLift(side: Side): number {
    const thigh = this.thighLocal[side];
    const home = this.homeLocal[side];
    const dh = Math.hypot(thigh.x - home.x, thigh.z - home.z);
    const reach = this.restReachLocal[side];
    return Math.sqrt(Math.max(reach * reach - dh * dh, 0)) - (thigh.y - home.y);
  }

  /**
   * Neutral position of the ankle (world). The height is the rest height; FootPlacement decides the ground.
   */
  homePosition(side: Side, out: Vector3): Vector3 {
    return this.rig.root.localToWorld(out.copy(this.homeLocal[side]));
  }

  /** Horizontal distance between the foot and its neutral position. */
  homeError(foot: FootTarget): number {
    this.homePosition(foot.side, this.tmp);
    return Math.hypot(foot.position.x - this.tmp.x, foot.position.z - this.tmp.z);
  }

  /**
   * Difference between the planted pose of the foot (where it rests, without the heel/toe roll of the
   * current step) and where it would rest if it took a step to its neutral position right now (including
   * the adaptation to the terrain): horizontal offset (m, world: from the neutral spot to the foot) and
   * difference in orientation (rad).
   * Used to know whether a foot is already "settled" when stopping. Does a raycast. `adjust` can change
   * that pose (e.g. onto a tread of some stairs).
   */
  settleError(
    foot: FootTarget,
    outOffset: Vector3,
    adjust?: (target: Vector3, rotation: Quaternion) => void,
  ): { distance: number; angle: number } {
    this.planLanding(foot.side, this.zero, this.zero, 0, this.settleTarget, this.settleRotation);
    adjust?.(this.settleTarget, this.settleRotation);
    outOffset.set(foot.planted.x - this.settleTarget.x, 0, foot.planted.z - this.settleTarget.z);
    return { distance: outOffset.length(), angle: foot.plantedRotation.angleTo(this.settleRotation) };
  }

  /**
   * Where the foot will land:
   *   current neutral position, rotated `yaw` rad about the root (expected turn)
   *   + how far the body will move until landing (`bodyDisplacement`)
   *   + `lead` meters in the direction of motion (`direction`, can be zero)
   * and placed on the ground with FootPlacement, oriented with `footYaw` (by default, that same turn).
   */
  planLanding(
    side: Side,
    bodyDisplacement: Vector3,
    direction: Vector3,
    lead: number,
    outPosition: Vector3,
    outRotation: Quaternion,
    yaw = 0,
    footYaw = yaw,
  ): void {
    this.homePosition(side, outPosition);
    if (yaw !== 0) {
      const root = this.rig.root.getWorldPosition(this.rootWorld);
      outPosition.sub(root).applyAxisAngle(UP, yaw).add(root);
    }
    outPosition.add(bodyDisplacement);
    this.tmp2.set(direction.x, 0, direction.z);
    if (this.tmp2.lengthSq() > 1e-8) outPosition.addScaledVector(this.tmp2.normalize(), lead);

    this.placeLanding(side, outPosition, footYaw, outPosition, outRotation);
  }

  /** Places the foot on the ground under `desired` (world ankle), oriented with `footYaw`. */
  placeLanding(side: Side, desired: Vector3, footYaw: number, outPosition: Vector3, outRotation: Quaternion): void {
    const ground = this.placements[side].update(desired, footYaw);
    outPosition.copy(ground.ankleTarget);
    outRotation.copy(ground.footRotation);
  }

  /** Foot placement of a side: its last query of the ground and the height of its ankle. */
  placement(side: Side): FootPlacement {
    return this.placements[side];
  }

  /** Adjusts the lateral distance between the neutral feet. */
  private applyStepWidth(width: number): void {
    const { left, right } = this.homeLocal;
    const center = this.tmp.addVectors(left, right).multiplyScalar(0.5);
    const lateral = this.tmp2.subVectors(right, left);
    lateral.addScaledVector(UP, -lateral.dot(UP)).normalize();
    const yL = left.y;
    const yR = right.y;
    left.copy(center).addScaledVector(lateral, -width / 2).setY(yL);
    right.copy(center).addScaledVector(lateral, width / 2).setY(yR);
  }
}
