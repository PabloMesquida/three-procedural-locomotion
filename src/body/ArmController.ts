import { type Bone, Quaternion, Vector3 } from 'three';

import { createSpring, snapSpring, type Spring, stepSpring } from '../core/spring.ts';
import { setWorldQuaternionNode, updateDown, updateNode, updateSubtree, worldPosition, worldQuaternion } from '../core/pose.ts';
import type { ArmBones, HumanRig } from '../rig/HumanRig.ts';
import { HandFingers } from './HandFingers.ts';
import { TOUCH_FINGER_CURL } from './TouchController.ts';

const UP = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;

export interface ArmConfig {
  /** Arm angle away from the vertical, outwards (degrees). */
  armAbduction: number;
  /** Elbow bend at rest (degrees). */
  elbowBend: number;
  /**
   * Forward/backward arm swing when walking at `walkSpeed` (degrees); it grows with speed. The centre of the
   * swing sits slightly behind the vertical, as in real walking.
   */
  armSwing: number;
  /** Extra elbow bend when the arm swings forward (degrees). */
  elbowSwingBend: number;
  /** Front-to-back distance between the feet at which the maximum swing is reached (m). */
  stepLength: number;
  /**
   * Natural frequency of the arm (Hz): how quickly it follows the swing driven by the legs. Lower = heavier
   * arm with more lag.
   */
  armSwingFrequency: number;
  /** Damping of the swing (1 = no overshoot; less = the arm overshoots a little, like a pendulum). */
  armSwingDamping: number;
  /**
   * Inertia: how much the arms lag behind when accelerating (and swing ahead when braking) (degrees per
   * m/s²).
   */
  armInertia: number;
  /** How much the shoulder (clavicle) follows the arm swing, forward and back (fraction of the arm angle). */
  shoulderSwing: number;
  /** Shoulder drop from the weight of the relaxed arm (degrees). */
  shoulderDrop: number;
  /**
   * How far the shoulder joint sits in front of the base of the neck, horizontally (m; negative = behind):
   * the clavicle turns back or forward (up to 30°) to put it there, whatever the model's rest pose (some
   * have the shoulders hunched forward). Less = shoulders further back. Needs the neck and shoulder bones.
   */
  shoulderForward: number;
  /**
   * Natural frequency of the forearm (Hz): it follows the arm like a pendulum hanging from the elbow. Lower =
   * looser forearm (it lags when the arm accelerates and carries on when it brakes).
   */
  forearmFrequency: number;
  /** Natural frequency of the hand (Hz): it follows the forearm with a little more lag (loose wrist). */
  handFrequency: number;
  /**
   * How much the fingers close (if the rig has them): 0 = as in the model's rest pose, 1 = relaxed hand
   * (fingers slightly bent and together, thumb towards the index finger), more = more closed.
   */
  fingerCurl: number;
  /** Natural frequency of the fingers (Hz): they follow the swing of the hand with a small lag. */
  fingerFrequency: number;
}

/** Pose of the arms (degrees); allows varying it, e.g. between walking and running. */
export interface ArmPose {
  armAbduction: number;
  elbowBend: number;
  armSwing: number;
  elbowSwingBend: number;
  /** Adelanto fijo de ambos brazos (grados), p. ej. al agacharse. */
  armForward?: number;
}

/** Motion data that swings the arms. */
export interface ArmMotion {
  /** Horizontal direction of travel (unit, world). */
  forward: Vector3;
  /** How far the right foot is ahead of the left one in the direction of travel (m). */
  feetAhead: number;
  /** Pose to use instead of the configuration's. */
  pose?: ArmPose;
  /** Distance between the feet at which the swing reaches `armSwing` (m), instead of config.stepLength. */
  stepLength?: number;
  /** Frame time (s). Without it, the arms go straight to the requested pose (no inertia). */
  dt?: number;
  /** Acceleration of the body in the direction of travel (m/s²). */
  acceleration?: number;
  /** Scale of each arm's swing (1 = the pose's), e.g. natural variation: they are not an exact mirror. */
  swingScale?: { left: number; right: number };
  /**
   * How much the touch gesture controls each hand (0–1, see TouchController): the fingers open and don't
   * swing.
   */
  touch?: { left: number; right: number };
}

interface ArmRuntime {
  bones: ArmBones;
  restUpper: Quaternion;
  restForearm: Quaternion;
  /** +1 right arm, −1 left (direction of the swing relative to the legs). */
  sign: number;
  /** Current swing of the arm (rad, positive = forward) and its velocity (rad/s). */
  angle: number;
  velocity: number;
  /**
   * Forward shift of the shoulder (rad), absolute angle of the forearm and of the hand in the swing plane
   * (rad).
   */
  shoulder: Spring;
  forearm: Spring;
  hand: Spring;
  restShoulder?: Quaternion;
  restHand: Quaternion;
  /** Fingers (if the rig has them) and their absolute angle in the swing plane (rad). */
  fingers?: HandFingers;
  fingerSwing: Spring;
}

/** Joint limits (rad): the elbow doesn't hyperextend and the wrist doesn't bend too far. */
const MAX_ELBOW = (150 * Math.PI) / 180;
const MAX_WRIST = (35 * Math.PI) / 180;
/** Swing (degrees) below which the extra elbow bend is no longer distributed in proportion to it. */
const MIN_SWING_FOR_BEND = 5;
/** How much the arm opens for each degree of forward swing (and closes going backward). */
const ARM_SWING_ABDUCTION = 0.2;
/** The most the fingers lag behind the hand (rad). */
const MAX_FINGER_LAG = (20 * Math.PI) / 180;
/** The most the clavicle turns, back or forward, to put the shoulder at `shoulderForward` (rad). */
const MAX_SHOULDER_PLACEMENT = (30 * Math.PI) / 180;
/** Damping of forearm and hand: some overshoot, like a loose segment. */
const LIMB_DAMPING = 0.55;

/** Maximum integration step of the swing (s): stable and independent of the frame rate. */
const MAX_ARM_STEP = 1 / 120;
/** Maximum distance between the feet, in `stepLength`, that still increases the swing of the arms. */
const MAX_SWING_RATIO = 1.3;

/**
 * Procedural arms:
 *  - relaxed pose: the arm hangs slightly away from the body with the elbow a little bent (instead of the
 *    model's T-pose);
 *  - swing opposite to the legs: the right arm goes forward when the left foot is ahead, and vice versa.
 *    That is the intention; the arm follows it with weight: each one is a damped pendulum (spring +
 *    damper) that chases the requested angle, so it moves continuously (without stopping at the ends
 *    while the feet are still), arrives with a small delay and, by inertia, lags behind when accelerating
 *    and runs ahead when braking;
 *  - the elbow bends a little more when the arm goes forward;
 *  - chain from proximal to distal: the shoulder (clavicle) follows the intention of the swing before the
 *    arm and drops a little under its weight; the forearm and hand are pendulums hanging from the elbow
 *    and wrist: they lag behind when the arm accelerates and carry on when it brakes (the elbow opens and
 *    closes by itself, the hand arrives last).
 *
 * It doesn't assume local axes: it measures the real direction of each bone and rotates it in world
 * space about the character's axes.
 */
export class ArmController {
  /** Swing applied in the last update (rad, positive = right arm forward). */
  swing = 0;
  /** Swing requested by the legs in the last update (rad, right arm), before inertia. */
  swingTarget = 0;

  private readonly config: ArmConfig;
  private readonly arms: ArmRuntime[] = [];
  private readonly neck?: Bone;
  private readonly neckPosition = new Vector3();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly dir = new Vector3();
  private readonly target = new Vector3();
  private readonly side = new Vector3();
  private readonly right = new Vector3();
  private readonly axis = new Vector3();
  private readonly q = new Quaternion();
  private readonly qWorld = new Quaternion();

  constructor(rig: HumanRig, config: ArmConfig) {
    this.config = config;
    this.neck = rig.neck;
    const add =(bones: ArmBones | undefined, sign: number): void => {
      if (!bones) return;
      this.arms.push({
        bones,
        restUpper: bones.upperArm.quaternion.clone(),
        restForearm: bones.forearm.quaternion.clone(),
        sign,
        angle: 0,
        velocity: 0,
        shoulder: createSpring(),
        forearm: createSpring(),
        hand: createSpring(),
        restShoulder: bones.shoulder?.quaternion.clone(),
        restHand: bones.hand.quaternion.clone(),
        fingers: bones.fingers ? new HandFingers(bones.hand, bones.fingers, sign) : undefined,
        fingerSwing: createSpring(),
      });
    };
    add(rig.leftArm, -1);
    add(rig.rightArm, 1);
  }

  /** Returns the arms to the model's rest pose and forgets their motion. */
  reset(): void {
    this.resetPose();
    this.initialized = false;
    this.swing = 0;
    this.swingTarget = 0;
  }

  private initialized = false;

  /** Only the pose (keeps the state of the swing). */
  private resetPose(): void {
    for (const arm of this.arms) {
      arm.bones.upperArm.quaternion.copy(arm.restUpper);
      arm.bones.forearm.quaternion.copy(arm.restForearm);
      arm.bones.hand.quaternion.copy(arm.restHand);
      if (arm.bones.shoulder && arm.restShoulder) arm.bones.shoulder.quaternion.copy(arm.restShoulder);
      arm.fingers?.resetPose();
    }
  }

  /**
   * Advances each arm's pendulum towards its requested angle. Inertia is modeled as a shift of the
   * equilibrium proportional to the acceleration of the body (what a pendulum whose pivot accelerates
   * feels).
   */
  private integrate(target: number, dt: number | undefined, acceleration: number, scale?: { left: number; right: number }): void {
    const scaleOf = (arm: ArmRuntime): number => (scale ? (arm.sign > 0 ? scale.right : scale.left) : 1);
    const c = this.config;
    const inertia = -c.armInertia * DEG * acceleration;
    if (!this.initialized || dt === undefined || !(dt > 0)) {
      for (const arm of this.arms) {
        arm.angle = target * arm.sign * scaleOf(arm) + (dt === undefined ? 0 : inertia);
        arm.velocity = 0;
      }
      this.initialized = dt !== undefined;
      return;
    }
    const w = 2 * Math.PI * c.armSwingFrequency;
    // Pasos de como mucho 1/120 s y lo bastante cortos para la frecuencia (w·h ≤ 0,5): estable siempre.
    const steps = Math.max(Math.ceil(dt / MAX_ARM_STEP - 1e-9), Math.ceil((dt * w) / 0.5));
    const h = dt / steps;
    for (const arm of this.arms) {
      const goal = target * arm.sign * scaleOf(arm) + inertia;
      for (let i = 0; i < steps; i++) {
        // Semi-implícito: primero la velocidad, luego el ángulo (estable con estos pasos).
        arm.velocity += (w * w * (goal - arm.angle) - 2 * c.armSwingDamping * w * arm.velocity) * h;
        arm.angle += arm.velocity * h;
      }
    }
  }

  /** Must be called after the torso (the arms hang from the chest). */
  update(motion: ArmMotion): void {
    this.resetPose();
    const c: ArmPose = motion.pose ?? this.config;
    const F = motion.forward;
    const R = this.right.crossVectors(F, UP).normalize();

    // Brazo derecho adelante cuando el pie izquierdo va delante (feetAhead < 0).
    const k = clamp(-motion.feetAhead / (motion.stepLength ?? this.config.stepLength), -MAX_SWING_RATIO, MAX_SWING_RATIO);
    this.swingTarget = c.armSwing * DEG * k;
    // Antebrazo, mano y hombro solo se mueven con inercia si el balanceo ya estaba en marcha.
    const dynamic = this.initialized && motion.dt !== undefined && motion.dt > 0;
    this.integrate(this.swingTarget, motion.dt, motion.acceleration ?? 0, motion.swingScale);
    this.swing = this.arms.find((arm) => arm.sign > 0)?.angle ?? this.swingTarget;

    const cfg = this.config;
    for (const arm of this.arms) {
      const { shoulder, upperArm, forearm, hand } = arm.bones;
      const swing = arm.angle;
      const touch = motion.touch ? (arm.sign > 0 ? motion.touch.right : motion.touch.left) : 0;
      // Mano relajada (en el espacio local de los dedos: el brazo los lleva después); tocando, abierta.
      arm.fingers?.pose(cfg.fingerCurl + (TOUCH_FINGER_CURL - cfg.fingerCurl) * touch);
      const forward = (c.armForward ?? 0) * DEG;

      // 0. Hombro: en su sitio (shoulderForward), sigue la intención del balanceo (más rápido que el brazo:
      //    llega antes) y cae un poco por el peso del brazo.
      arm.shoulder.target = this.swingTarget * arm.sign * cfg.shoulderSwing * (motion.swingScale ? (arm.sign > 0 ? motion.swingScale.right : motion.swingScale.left) : 1);
      if (dynamic) stepSpring(arm.shoulder, 2 * 2 * Math.PI * cfg.armSwingFrequency, cfg.armSwingDamping, motion.dt!);
      else snapSpring(arm.shoulder);
      // Cada hueso se recalcula solo al leerlo o girarlo (su padre ya está al día); lo que cuelga
      // del brazo, una vez al final.
      if (shoulder) {
        updateNode(shoulder);
        this.boneDirection(shoulder, upperArm, this.dir); // clavícula: del pecho hacia el hombro
        // Adelantar el hombro: giro sobre la vertical en el sentido que lleva su extremo hacia delante.
        const forwardSign = Math.sign(this.axis.crossVectors(UP, this.dir).dot(F)) || 1;
        const placement = this.shoulderPlacement(shoulder, F);
        this.rotateWorld(shoulder, this.q.setFromAxisAngle(UP, (placement + arm.shoulder.value) * forwardSign));
        // Bajarlo: giro sobre el eje de avance en el sentido que baja su extremo.
        this.boneDirection(shoulder, upperArm, this.dir);
        const downSign = -Math.sign(this.axis.crossVectors(F, this.dir).dot(UP)) || 1;
        this.rotateWorld(shoulder, this.q.setFromAxisAngle(F, cfg.shoulderDrop * DEG * downSign));
      }

      // 1. Brazo: de su dirección actual a colgar con una pequeña separación hacia fuera…
      if (shoulder) updateDown(shoulder, upperArm);
      else updateNode(upperArm);
      this.boneDirection(upperArm, forearm, this.dir);
      this.side.copy(R).multiplyScalar(Math.sign(this.dir.dot(R)) || arm.sign);
      // El balanceo no es un plano: hacia delante el brazo se abre un poco y hacia atrás se cierra
      // (en las capturas de movimiento la muñeca se separa ~3 cm más del cuerpo adelante que atrás).
      const abduction = Math.max(c.armAbduction * DEG + ARM_SWING_ABDUCTION * swing, 0);
      this.target
        .copy(UP)
        .multiplyScalar(-Math.cos(abduction))
        .addScaledVector(this.side, Math.sin(abduction));
      this.q.setFromUnitVectors(this.dir, this.target);
      this.rotateWorld(upperArm, this.q);

      // …y balanceo hacia delante/atrás sobre el eje lateral (ángulo positivo = hacia delante).
      this.rotateWorld(upperArm, this.q.setFromAxisAngle(R, swing + forward));

      // 2. Codo: el antebrazo es un péndulo cuyo ángulo absoluto (en el plano del balanceo)
      //    persigue el del brazo + la flexión pedida; la diferencia es la flexión del codo.
      const upperAngle = swing + forward;
      // Fracción del balanceo pedido que lleva el brazo hacia delante. Al frenar, el balanceo pedido se
      // apaga con la velocidad mientras el brazo aún oscila: sin el mínimo, el cociente se disparaba (el
      // codo se doblaba de más) y al llegar a 0 caía de golpe (latigazo del antebrazo al quedar parado).
      const swingShare = clamp(swing / (Math.max(c.armSwing, MIN_SWING_FOR_BEND) * DEG), 0, 1);
      const bendTarget = (c.elbowBend + c.elbowSwingBend * swingShare) * DEG;
      arm.forearm.target = upperAngle + bendTarget;
      if (dynamic) stepSpring(arm.forearm, 2 * Math.PI * cfg.forearmFrequency, LIMB_DAMPING, motion.dt!);
      else snapSpring(arm.forearm);
      const bend = clamp(arm.forearm.value - upperAngle, 0, MAX_ELBOW);
      // Antebrazo recto respecto al brazo antes de doblarlo: la flexión pedida es absoluta, aunque el
      // modelo tenga el codo doblado en reposo (el metarig de Rigify, ~22°; Mixamo, recto).
      this.boneDirection(upperArm, forearm, this.target);
      this.boneDirection(forearm, hand, this.dir);
      this.rotateWorld(forearm, this.q.setFromUnitVectors(this.dir, this.target));
      // Eje de bisagra del codo: perpendicular al plano del balanceo, calculado con el antebrazo aún
      // alineado con el brazo (que cuelga), así que está bien definido. Lo usan también muñeca y dedos.
      this.boneDirection(forearm, hand, this.dir);
      this.axis.crossVectors(this.dir, F);
      const hinge = this.axis.lengthSq() > 1e-8;
      if (hinge) {
        this.rotateWorld(forearm, this.q.setFromAxisAngle(this.axis.normalize(), bend));
      }

      // 3. Muñeca: la mano sigue al antebrazo con algo más de retraso.
      const forearmAngle = upperAngle + bend;
      arm.hand.target = forearmAngle;
      if (dynamic) stepSpring(arm.hand, 2 * Math.PI * cfg.handFrequency, LIMB_DAMPING, motion.dt!);
      else snapSpring(arm.hand);
      const wrist = clamp(arm.hand.value - forearmAngle, -MAX_WRIST, MAX_WRIST);
      // Mismo eje que el codo (sigue perpendicular al antebrazo tras doblarlo). Antes se calculaba como
      // antebrazo × adelante, que con el codo a ~90° (corriendo) es casi cero: su dirección la decidía
      // el ruido y la mano daba latigazos de un frame.
      // La mano, al día tras doblar el codo (rotateWorld parte de su orientación world actual).
      updateDown(forearm, hand);
      if (hinge) this.rotateWorld(hand, this.q.setFromAxisAngle(this.axis, wrist));

      // 4. Dedos: siguen a la mano con un pequeño retraso (sobre el mismo eje que la muñeca).
      if (arm.fingers?.active) {
        const handAngle = forearmAngle + wrist;
        arm.fingerSwing.target = handAngle;
        if (dynamic) stepSpring(arm.fingerSwing, 2 * Math.PI * cfg.fingerFrequency, LIMB_DAMPING, motion.dt!);
        else snapSpring(arm.fingerSwing);
        const lag = clamp(arm.fingerSwing.value - handAngle, -MAX_FINGER_LAG, MAX_FINGER_LAG) * (1 - touch);
        if (hinge) arm.fingers.sway(this.axis, lag);
      }
      updateSubtree(shoulder ?? upperArm);
    }
  }

  /**
   * Turn of the clavicle about the vertical (rad, positive = its end forward) that leaves the shoulder
   * joint `shoulderForward` in front of the base of the neck. Right after `boneDirection(shoulder, upperArm)`:
   * reads the positions it left in `a` (clavicle) and `b` (shoulder joint).
   */
  private shoulderPlacement(shoulder: Bone, F: Vector3): number {
    if (!this.neck) return 0;
    if (shoulder.parent) updateDown(shoulder.parent, this.neck);
    else updateNode(this.neck);
    const front = -worldPosition(this.neck, this.neckPosition).sub(this.b).dot(F);
    // Extremo de la clavícula en el plano horizontal: su componente hacia delante es horizontal·sen(ángulo).
    const clavicle = this.b.sub(this.a);
    const ahead = clavicle.dot(F);
    const horizontal = Math.hypot(clavicle.x, clavicle.z);
    if (horizontal < 1e-6) return 0;
    const from = Math.asin(clamp(ahead / horizontal, -1, 1));
    const to = Math.asin(clamp((ahead + this.config.shoulderForward - front) / horizontal, -1, 1));
    return clamp(to - from, -MAX_SHOULDER_PLACEMENT, MAX_SHOULDER_PLACEMENT);
  }

  /** World direction (unit) from `from` (up to date) to `to`, which hangs from it (updated here). */
  private boneDirection(from: Bone, to: Bone, out: Vector3): Vector3 {
    updateDown(from, to);
    worldPosition(from, this.a);
    worldPosition(to, this.b);
    return out.subVectors(this.b, this.a).normalize();
  }

  /** Rotates `bone` (up to date) in world space; only recomputes its matrix. */
  private rotateWorld(bone: Bone, delta: Quaternion): void {
    worldQuaternion(bone, this.qWorld);
    setWorldQuaternionNode(bone, this.qWorld.premultiply(delta));
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
