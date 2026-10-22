import { type Bone, type Object3D, Quaternion, Vector3 } from 'three';

import { createSpring, snapSpring, stepSpring } from '../core/spring.ts';
import { setWorldQuaternionNode, updateDown, updateSubtree, worldPosition, worldQuaternion } from '../core/pose.ts';
import type { HumanRig } from '../rig/HumanRig.ts';

const UP = new Vector3(0, 1, 0);
/** Time constant (s) used to smooth the acceleration of the hips for the inertia of the trunk. */
const HIP_ACCELERATION_SMOOTHING = 0.06;
const DEG = Math.PI / 180;

export interface TorsoConfig {
  /** Fraction of the pelvis rotation that the spine counteracts. */
  spineCounterRotation: number;
  /** Additional fraction counteracted by the chest (sum > 1 → shoulders opposite to the pelvis). */
  chestCounterRotation: number;
  /**
   * Share of the compensation for the pelvic drop done by the chest instead of the lower spine (0–1): the
   * back curves instead of bending at one point. The shoulders stay just as level. About 1/3 in the CMU
   * captures.
   */
  chestRollShare: number;
  /** Torso lean per unit of acceleration (degrees per m/s²). */
  leanPerAcceleration: number;
  /** Maximum torso lean from accelerating/braking (degrees). */
  maxLean: number;
  /** How much the head is stabilized towards its rest orientation (0–1). */
  headStabilization: number;
  /** Fraction of the remaining turn the head looks ahead. */
  headTurnLead: number;
  /** Maximum anticipatory turn of the head (degrees). */
  maxHeadTurn: number;
  /** Fraction of the remaining turn the chest turns ahead. */
  chestTurnLead: number;
  /** Maximum anticipatory turn of the chest (degrees). */
  maxChestTurn: number;
  /** Maximum lean into a curve (degrees). */
  maxTurnLean: number;
  /**
   * Natural frequency of the trunk (Hz): how quickly spine and chest follow the pelvis. Lower = heavier trunk
   * that arrives later (the chest a bit more than the spine).
   */
  trunkFrequency: number;
  /** Damping of the trunk (1 = no overshoot; less = it overshoots a little and comes back). */
  trunkDamping: number;
  /**
   * Trunk inertia: how much it leans from the accelerations of the hips (degrees per m/s²): forward when
   * their descent stops at each step, sideways against the sway.
   */
  trunkInertia: number;
}

/** Motion data that orients the torso. */
export interface TorsoMotion {
  /** Horizontal direction of travel (unit, world). */
  forward: Vector3;
  /**
   * Angles of the pelvis (rad), as published by PelvisController (`tilt`: its tilt oscillation with the
   * steps).
   */
  pelvis: { yaw: number; roll: number; pitch: number; tilt?: number };
  /** Acceleration of the body in the direction of travel (m/s², smoothed). */
  acceleration: number;
  /** Turn remaining to reach the desired heading (rad, positive = left). */
  turnRemaining: number;
  /** Linear (m/s) and angular (rad/s) velocity of the body, for leaning into curves. */
  speed: number;
  angularVelocity: number;
  /** Frame time (s), to smooth the anticipation and move the trunk with inertia. */
  dt: number;
  /** Additional forward lean (rad), e.g. when running. 0 by default. */
  extraLean?: number;
  /** In the air (jump): in free fall the whole body falls together and there is no vertical inertia. */
  airborne?: boolean;
  /** Gaze offset (rad): turn (positive = left) and tilt (positive = down), e.g. natural variation. */
  headOffset?: { yaw: number; pitch: number };
}

/**
 * Procedural torso (spine, chest, head):
 *  - counter-rotation: the spine and chest rotate opposite to the pelvis;
 *  - lateral compensation: spine and chest undo the drop of the pelvis (upright torso);
 *  - lean: forward when accelerating, backward when braking;
 *  - stabilization: the head tends to its rest orientation relative to the character;
 *  - turn anticipation: head and chest look towards the desired heading first;
 *  - lean into curves: the trunk leans towards the inside (atan(v·ω/g)).
 *
 * The rotations are applied about the character's axes in world space, so it doesn't depend on how the
 * local axes of each bone are oriented.
 *
 * Weight and lag: the spine and chest angles are not applied instantly; each one chases its own like a
 * damped spring (the chest more slowly than the spine), so the trunk arrives a little after the pelvis
 * instead of moving with it as a block. It also leans by inertia with the accelerations of the hips.
 */
export class TorsoController {
  /** Lean applied in the last update (rad, positive = forward). */
  lean = 0;
  /** Lateral lean into curves (rad, positive = to the left). */
  turnLean = 0;
  /** Turn anticipation, smoothed (rad, positive = left). */
  turnLead = 0;

  private readonly config: TorsoConfig;
  private readonly root: Object3D;
  private readonly bones: { bone: Bone; rest: Quaternion }[] = [];
  private readonly spine?: Bone;
  private readonly chest?: Bone;
  private readonly head?: Bone;
  /** World rotation of the head at rest, relative to the character's root. */
  private readonly headRestRelative = new Quaternion();

  private readonly right = new Vector3();
  private readonly q = new Quaternion();
  private readonly qAxis = new Quaternion();
  private readonly qWorld = new Quaternion();
  private readonly qTarget = new Quaternion();

  private readonly hips: Bone;
  /** State of the springs: spine (turn, side, forward) and chest (turn). */
  private readonly springs = {
    spineYaw: createSpring(),
    spineRoll: createSpring(),
    spinePitch: createSpring(),
    chestYaw: createSpring(),
  };
  private initialized = false;
  private readonly hipPosition = new Vector3();
  private readonly hipVelocity = new Vector3();
  private readonly hipAcceleration = new Vector3();
  private readonly tmp = new Vector3();
  private readonly velocity = new Vector3();
  private hipSamples = 0;
  /** Filtered acceleration of the hips (m/s²): what the trunk "feels", without one-frame spikes. */
  private readonly hipAccelerationSmooth = new Vector3();

  constructor(rig: HumanRig, config: TorsoConfig) {
    this.config = config;
    this.root = rig.root;
    this.hips = rig.hips;
    this.spine = rig.spine;
    this.chest = rig.chest;
    this.head = rig.head;
    for (const bone of [rig.spine, rig.chest, rig.neck, rig.head]) {
      if (bone) this.bones.push({ bone, rest: bone.quaternion.clone() });
    }
    if (rig.head) {
      rig.root.updateWorldMatrix(true, true);
      const rootQ = rig.root.getWorldQuaternion(new Quaternion());
      this.headRestRelative.copy(rootQ.invert().multiply(rig.head.getWorldQuaternion(new Quaternion())));
    }
  }

  /** Devuelve columna, pecho, cuello y cabeza a su pose de reposo (local). */
  reset(): void {
    this.resetPose();
    this.turnLead = 0;
    this.initialized = false;
    this.hipSamples = 0;
    this.hipAcceleration.set(0, 0, 0);
    this.hipAccelerationSmooth.set(0, 0, 0);
  }

  /**
   * The character was shifted by `offset` (world) without moving: the acceleration of the hips must not
   * notice it.
   */
  shift(offset: Vector3): void {
    this.hipPosition.add(offset);
  }

  /** World acceleration of the hips (m/s²), from differences between updates. */
  private trackHips(dt: number): void {
    worldPosition(this.hips, this.tmp);
    if (this.hipSamples > 0 && dt > 0) {
      const velocity = this.velocity.copy(this.tmp).sub(this.hipPosition).divideScalar(dt);
      if (this.hipSamples > 1) this.hipAcceleration.subVectors(velocity, this.hipVelocity).divideScalar(dt);
      this.hipVelocity.copy(velocity);
    }
    this.hipPosition.copy(this.tmp);
    this.hipSamples = Math.min(this.hipSamples + 1, 2);
    // Media exponencial (≈ 60 ms): en el doble apoyo la aceleración frame a frame oscila
    // ±10 m/s² aunque el cambio neto de velocidad es pequeño.
    if (dt > 0) this.hipAccelerationSmooth.lerp(this.hipAcceleration, 1 - Math.exp(-dt / HIP_ACCELERATION_SMOOTHING));
  }

  /** Only the pose (without forgetting the smoothed state). */
  private resetPose(): void {
    for (const { bone, rest } of this.bones) bone.quaternion.copy(rest);
    this.lean = 0;
    this.turnLean = 0;
  }

  /** Must be called after orienting the pelvis. */
  update(motion: TorsoMotion): void {
    this.resetPose();
    const c = this.config;
    const F = motion.forward;
    const R = this.right.crossVectors(F, UP).normalize();
    const { yaw, roll } = motion.pelvis;

    this.lean = clamp(c.leanPerAcceleration * motion.acceleration, -c.maxLean, c.maxLean) * DEG + (motion.extraLean ?? 0);
    // Inclinación hacia el interior de la curva (izquierda si gira a la izquierda).
    this.turnLean = clamp(Math.atan((motion.speed * motion.angularVelocity) / 9.81), -c.maxTurnLean * DEG, c.maxTurnLean * DEG);
    // Anticipación: sigue suavemente al giro pendiente.
    this.turnLead += (motion.turnRemaining - this.turnLead) * (1 - Math.exp(-6 * motion.dt));

    // Inercia: al frenar la bajada de las caderas (aceleración hacia arriba, al recibir el peso)
    // el tronco sigue bajando y se inclina hacia delante; al acelerar de lado se queda atrás.
    this.trackHips(motion.dt);
    const inertia = c.trunkInertia * DEG;
    const maxInertia = c.maxLean * DEG;
    const pitchInertia = motion.airborne ? 0 : clamp(inertia * this.hipAccelerationSmooth.y, -maxInertia, maxInertia);
    const rollInertia = clamp(inertia * this.hipAccelerationSmooth.dot(R), -maxInertia, maxInertia);

    // Ángulos deseados (como si el tronco fuese rígido)…
    const chestLead = clamp(this.turnLead * c.chestTurnLead, -c.maxChestTurn * DEG, c.maxChestTurn * DEG);
    const s = this.springs;
    s.spineYaw.target = -yaw * c.spineCounterRotation;
    // La compensación de la caída de la pelvis es postural e inmediata (el tronco sigue
    // erguido); con retraso solo va lo demás (inclinación en curva e inercia).
    s.spineRoll.target = -this.turnLean + rollInertia;
    s.spinePitch.target = -this.lean - pitchInertia;
    s.chestYaw.target = -yaw * c.chestCounterRotation + chestLead;
    // …que columna y pecho siguen con retraso (el pecho, a 3/4 de la frecuencia de la columna).
    const w = 2 * Math.PI * c.trunkFrequency;
    if (!this.initialized || !(motion.dt > 0)) {
      for (const spring of Object.values(s)) snapSpring(spring);
      this.initialized = true;
    } else {
      stepSpring(s.spineYaw, w, c.trunkDamping, motion.dt);
      stepSpring(s.spineRoll, w, c.trunkDamping, motion.dt);
      stepSpring(s.spinePitch, w, c.trunkDamping, motion.dt);
      stepSpring(s.chestYaw, 0.75 * w, c.trunkDamping, motion.dt);
    }

    // Columna: contrarrotación parcial, deshace la caída de la pelvis, se inclina
    // según la aceleración (sobre R; ángulo negativo = hacia delante) y hacia dentro de la curva
    // (sobre F; ángulo negativo = hacia la izquierda).
    // Cada hueso se actualiza solo (con lo que hay entre él y el anterior, en reposo); lo que
    // cuelga de la columna, una vez al final.
    // Sin pecho (o sin columna) la compensación la hace entera el hueso que haya.
    const chestShare = this.spine && this.chest ? c.chestRollShare : this.chest ? 1 : 0;
    let above: Object3D = this.hips;
    if (this.spine) {
      this.q.setFromAxisAngle(UP, s.spineYaw.value);
      this.q.multiply(this.qAxis.setFromAxisAngle(F, -roll * (1 - chestShare) + s.spineRoll.value));
      // La columna baja absorbe la basculación de la pelvis con los pasos: el tronco no cabecea con ella.
      this.q.multiply(this.qAxis.setFromAxisAngle(R, s.spinePitch.value - (motion.pelvis.tilt ?? 0)));
      this.rotateWorld(above, this.spine, this.q);
      above = this.spine;
    }

    // Pecho: completa la contrarrotación (hombros opuestos a la pelvis), se adelanta al giro y
    // termina de deshacer la caída de la pelvis.
    if (this.chest) {
      this.q.setFromAxisAngle(UP, s.chestYaw.value);
      this.q.multiply(this.qAxis.setFromAxisAngle(F, -roll * chestShare));
      this.rotateWorld(above, this.chest, this.q);
      above = this.chest;
    }

    // Cabeza: se acerca a su orientación de reposo respecto al personaje y mira hacia el giro.
    if (this.head) {
      const headLead = clamp(this.turnLead * c.headTurnLead, -c.maxHeadTurn * DEG, c.maxHeadTurn * DEG);
      worldQuaternion(this.root, this.qTarget).premultiply(this.q.setFromAxisAngle(UP, headLead + (motion.headOffset?.yaw ?? 0)));
      if (motion.headOffset?.pitch) this.qTarget.premultiply(this.q.setFromAxisAngle(R, -motion.headOffset.pitch));
      this.qTarget.multiply(this.headRestRelative);
      updateDown(above, this.head);
      worldQuaternion(this.head, this.qWorld);
      this.qWorld.slerp(this.qTarget, c.headStabilization);
      setWorldQuaternionNode(this.head, this.qWorld);
    }
    const top = this.spine ?? this.chest ?? this.head;
    if (top) updateSubtree(top);
  }

  /**
   * Rotates `bone` in world space, with its chain from `above` (up to date) updated; only recomputes `bone`.
   */
  private rotateWorld(above: Object3D, bone: Bone, delta: Quaternion): void {
    updateDown(above, bone);
    worldQuaternion(bone, this.qWorld);
    setWorldQuaternionNode(bone, this.qWorld.premultiply(delta));
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
