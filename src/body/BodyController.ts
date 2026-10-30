import { type Object3D, Quaternion, Vector3 } from 'three';

import { setWorldPosition } from '../core/transforms.ts';
import type { LocomotionConfig } from '../locomotion/LocomotionConfig.ts';
import type { Side } from '../rig/HumanRig.ts';
import { createGroundHit, type GroundDetector } from '../terrain/GroundDetector.ts';

/**
 * State of the body, in world space.
 * It is the starting point for future phases (center of mass, balance, momentum…).
 */
export interface BodyState {
  /** Position of the character's root (on the ground). */
  position: Vector3;
  /** Velocidad horizontal actual (m/s). */
  velocity: Vector3;
  /** Magnitude of the velocity (m/s). */
  speed: number;
  /** Acceleration in the direction of travel (m/s², smoothed). */
  acceleration: number;
  /** Horizontal direction of travel (unit). */
  forward: Vector3;
  /** Current heading relative to the initial orientation (rad, positive = turning left). */
  heading: number;
  /** Velocidad angular (rad/s). */
  angularVelocity: number;
  /** There is ground under the root. */
  grounded: boolean;
  /** Height of the ground under the root (m, world). */
  groundHeight: number;
  /** In the air (jump): the height follows gravity. */
  airborne: boolean;
  /** Vertical velocity in the air (m/s, positive = up). */
  verticalVelocity: number;
  /** Falling speed in the frame in which it lands (m/s); 0 the rest of the time. */
  landingSpeed: number;
  /** In the frame in which it lands: time elapsed since contact (s); 0 otherwise. */
  timeSinceLanding: number;
  /** Fraction of the weight on each foot (sums to 1). */
  supportWeights: Record<Side, number>;
  /** Center of support: average of the contact points of the feet, weighted by their load. */
  supportCenter: Vector3;
  /** Horizontal offset of the body (hips) relative to the root, towards the support. */
  shift: Vector3;
  /** Estimated center of mass (for now, the position of the hips). */
  com: Vector3;
}

const UP = new Vector3(0, 1, 0);
/** In the air: how far below it looks for the ground to land on (m). */
const AIR_PROBE_DISTANCE = 50;
/** Remaining turn above which it starts braking to turn (rad). */
const TURN_SLOWDOWN_START = (20 * Math.PI) / 180;

/**
 * Motion of the body (kinematic version):
 *  - speed that accelerates/brakes towards the desired one,
 *  - heading that turns towards the desired one with limited angular velocity and acceleration,
 *  - advance of the root in the character's direction,
 *  - height of the root that smoothly follows the ground,
 *  - prediction of the future advance (to plan the steps),
 *  - weight distribution between the feet and lateral shift of the body towards the supporting foot
 *    (damped spring),
 *  - kinematic jump: initial vertical velocity + gravity, keeping the horizontal velocity; it lands when it
 *    reaches whatever ground is below.
 *    (It doesn't detect walls or ceilings: that would be a physics engine's job.)
 */
export class BodyController {
  /** Velocidad deseada (m/s), entre 0 y config.runSpeed. */
  targetSpeed = 0;
  /** Desired heading (rad, relative to the initial orientation; positive = left). */
  targetHeading = 0;
  /** Additional speed limit (m/s), e.g. when crouching. */
  speedLimit = Number.POSITIVE_INFINITY;
  /**
   * Multiplier of the turn speed and turn acceleration (`turnSpeed`, `turnAcceleration`), e.g. to turn
   * around pivoting towards a destination behind (set by MoveToController). 1 = the configuration.
   */
  turnRateScale = 1;
  /**
   * Multiplier of the braking (`deceleration`, and it shortens its `speedEasing` ramp by the same amount),
   * e.g. when braking to turn around (set by MoveToController). 1 = the configuration.
   */
  brakeScale = 1;
  /**
   * Same for the acceleration (`acceleration`, and it lengthens or shortens its ramp), e.g. when coming out
   * of a turn.
   */
  accelerationScale = 1;
  /**
   * Height the root follows when walking, from the ground under it (world; NaN if there is none) and its
   * position: by default, that ground. Over stairs, a smooth line over the treads (see StairPlanner), also
   * where there is no ground under the root (over the gap between two treads without a riser).
   */
  groundLine: ((position: Vector3, ground: number) => number) | null = null;
  /** Turn rate (rad/s) at the end of the last prediction (`predict`). */
  predictedAngularVelocity = 0;
  readonly state: BodyState;

  private readonly root: Object3D;
  private readonly detector: GroundDetector;
  private readonly config: LocomotionConfig;
  private readonly forwardLocal: Vector3;
  /** World orientation of the root with heading 0. */
  private readonly baseRotation: Quaternion;
  /** World position of the root used during an update. */
  private readonly pos = new Vector3();
  private readonly rootHit = createGroundHit();
  private readonly q = new Quaternion();
  private readonly qParent = new Quaternion();
  private readonly qHeading = new Quaternion();
  private readonly tmp = new Vector3();
  private readonly lateral = new Vector3();
  /** Current lateral shift (m) and its velocity (m/s), along the lateral axis. */
  private shiftAmount = 0;
  private shiftVelocity = 0;
  /**
   * Current rate of change of the speed (m/s²): with `speedEasing` the acceleration grows and shrinks
   * gradually.
   */
  private speedRate = 0;

  /**
   * @param root     Root of the character (the one that moves). It can hang from any parent: position and
   *                 orientation are computed in world space and converted to the parent's space.
   * @param forward  "Forward" direction of the character in world space, in the initial pose.
   */
  constructor(root: Object3D, forward: Vector3, detector: GroundDetector, config: LocomotionConfig) {
    this.root = root;
    this.detector = detector;
    this.config = config;

    root.updateWorldMatrix(true, false);
    this.baseRotation = root.getWorldQuaternion(new Quaternion());
    this.forwardLocal = forward.clone().applyQuaternion(root.getWorldQuaternion(new Quaternion()).invert());

    this.state = {
      position: new Vector3(),
      velocity: new Vector3(),
      speed: 0,
      acceleration: 0,
      forward: new Vector3(),
      heading: 0,
      angularVelocity: 0,
      grounded: true,
      groundHeight: 0,
      airborne: false,
      verticalVelocity: 0,
      landingSpeed: 0,
      timeSinceLanding: 0,
      supportWeights: { left: 0.5, right: 0.5 },
      supportCenter: new Vector3(),
      shift: new Vector3(),
      com: new Vector3(),
    };
    this.refreshState();
  }

  /** Stops the body, restores the initial orientation and rests it on the ground. */
  reset(): void {
    this.state.speed = 0;
    this.state.acceleration = 0;
    this.speedRate = 0;
    this.state.heading = 0;
    this.state.angularVelocity = 0;
    this.state.airborne = false;
    this.state.verticalVelocity = 0;
    this.state.landingSpeed = 0;
    this.state.timeSinceLanding = 0;
    this.targetHeading = 0;
    this.applyHeading();
    this.shiftAmount = 0;
    this.shiftVelocity = 0;
    this.state.shift.set(0, 0, 0);
    this.readRoot();
    this.snapToGround(1, AIR_PROBE_DISTANCE); // tras un teletransporte el suelo puede estar lejos
    this.writeRoot();
    this.refreshState();
  }

  /**
   * Moves the body by `offset` (world) without changing its motion: the root (and with it the whole
   * skeleton) and whatever the state stores in world space. See `ProceduralHuman.shiftOrigin`.
   */
  shift(offset: Vector3): void {
    this.readRoot();
    this.pos.add(offset);
    this.writeRoot();
    const s = this.state;
    s.supportCenter.add(offset);
    s.com.add(offset);
    s.groundHeight += offset.y;
  }

  /** Takes off with a vertical velocity (m/s). */
  jump(verticalVelocity: number, elapsed = 0): void {
    if (this.state.airborne) return;
    this.state.airborne = true;
    this.state.angularVelocity = 0;
    // Parte de este frame ya transcurrió en el aire: la raíz ya subió algo.
    const g = this.config.gravity;
    this.state.verticalVelocity = verticalVelocity - g * elapsed;
    this.readRoot();
    this.pos.y += verticalVelocity * elapsed - 0.5 * g * elapsed * elapsed;
    this.writeRoot();
  }

  /** Time until touching the ground under the root (s); 0 if it isn't in the air. */
  timeToLand(): number {
    const s = this.state;
    if (!s.airborne) return 0;
    const g = this.config.gravity;
    const height = Math.max(s.position.y - s.groundHeight, 0);
    return (s.verticalVelocity + Math.sqrt(s.verticalVelocity ** 2 + 2 * g * height)) / g;
  }

  /** Advances the body by `dt` seconds. */
  update(dt: number): void {
    this.state.landingSpeed = 0;
    this.state.timeSinceLanding = 0;
    if (this.state.airborne) {
      this.updateAirborne(dt);
      return;
    }

    // Giro
    const turn = this.nextTurn(this.state.heading, this.state.angularVelocity, dt, this.state.speed);
    this.state.heading = turn.heading;
    this.state.angularVelocity = turn.angularVelocity;
    this.applyHeading();

    // Velocidad lineal
    const previous = this.state.speed;
    const next = this.nextSpeed(previous, this.speedRate, dt);
    this.state.speed = next.speed;
    this.speedRate = next.rate;
    if (dt > 0) {
      const raw = (this.state.speed - previous) / dt;
      this.state.acceleration += (raw - this.state.acceleration) * (1 - Math.exp(-8 * dt));
    }
    this.refreshState();
    this.readRoot();
    this.pos.addScaledVector(this.state.velocity, dt);
    this.snapToGround(1 - Math.exp(-10 * dt));
    this.writeRoot();
  }

  /** In the air: constant horizontal advance, gravity and landing. */
  private updateAirborne(dt: number): void {
    const s = this.state;
    const p = this.pos;
    this.refreshState();
    this.readRoot();
    p.addScaledVector(s.velocity, dt);
    s.verticalVelocity -= this.config.gravity * dt;
    p.y += s.verticalVelocity * dt;
    s.acceleration = 0;
    this.speedRate = 0;

    this.tmp.set(p.x, p.y + this.config.groundProbeHeight, p.z);
    s.grounded = this.detector.castDown(this.tmp, AIR_PROBE_DISTANCE, this.rootHit);
    if (s.grounded) s.groundHeight = this.rootHit.point.y;
    if (s.grounded && s.verticalVelocity <= 0 && p.y <= s.groundHeight) {
      // Parte de este frame ya transcurrió tras el contacto (lo que el cuerpo se hundió).
      s.timeSinceLanding = Math.min((s.groundHeight - p.y) / Math.max(-s.verticalVelocity, 1e-6), dt);
      p.y = s.groundHeight;
      s.landingSpeed = -s.verticalVelocity;
      s.verticalVelocity = 0;
      s.airborne = false;
    }
    this.writeRoot();
  }

  /**
   * Weight distribution and lateral shift of the body towards the support.
   *
   *   center of support = Σ weight(foot) · contact point(foot) / Σ weight
   *                       (in flight, with no feet on the ground: the position of the body)
   *   target            = lateral component of (center of support − root) · lateralShift
   *
   * The shift follows the target with a critically damped spring, so that the sway is continuous even if
   * the support switches feet abruptly.
   */
  updateWeightShift(dt: number, contacts: Record<Side, Vector3>, weights: Record<Side, number>): void {
    const s = this.state;
    s.supportWeights.left = weights.left;
    s.supportWeights.right = weights.right;
    const total = weights.left + weights.right;
    if (total > 1e-6) {
      s.supportCenter
        .copy(contacts.left)
        .multiplyScalar(weights.left / total)
        .addScaledVector(contacts.right, weights.right / total);
    } else {
      // En vuelo (corriendo) no hay apoyo hacia el que desplazarse: centro = el propio cuerpo.
      s.supportCenter.copy(s.position);
    }

    this.lateral.crossVectors(UP, s.forward).normalize();
    const target = this.tmp.subVectors(s.supportCenter, s.position).dot(this.lateral) * this.config.lateralShift;

    const w = this.config.lateralShiftResponse;
    const accel = w * w * (target - this.shiftAmount) - 2 * w * this.shiftVelocity;
    this.shiftVelocity += accel * dt;
    this.shiftAmount += this.shiftVelocity * dt;
    s.shift.copy(this.lateral).multiplyScalar(this.shiftAmount);
  }

  /** Is it turning, or does it still have turning to do? */
  isTurning(): boolean {
    return Math.abs(wrapAngle(this.targetHeading - this.state.heading)) > 0.01 || Math.abs(this.state.angularVelocity) > 0.01;
  }

  /**
   * Predicts the motion of the body over `duration` seconds, taking into account acceleration, braking and
   * turning: displacement (it can be a curve), final velocity and how much it will have turned (rad).
   * Returns the turn.
   */
  predict(duration: number, outDisplacement: Vector3, outVelocity: Vector3): number {
    const substeps = 10;
    const h = duration / substeps;
    let speed = this.state.speed;
    let rate = this.speedRate;
    let heading = this.state.heading;
    let angularVelocity = this.state.angularVelocity;
    outDisplacement.set(0, 0, 0);
    for (let i = 0; i < substeps; i++) {
      const next = this.nextSpeed(speed, rate, h, this.cappedTargetSpeed(heading));
      const turn = this.nextTurn(heading, angularVelocity, h, speed);
      const midHeading = (heading + turn.heading) / 2;
      this.dirAt(midHeading - this.state.heading, this.tmp);
      outDisplacement.addScaledVector(this.tmp, ((speed + next.speed) / 2) * h);
      speed = next.speed;
      rate = next.rate;
      heading = turn.heading;
      angularVelocity = turn.angularVelocity;
    }
    const yaw = heading - this.state.heading;
    this.dirAt(yaw, outVelocity).multiplyScalar(speed);
    this.predictedAngularVelocity = angularVelocity;
    return yaw;
  }

  /** Direction of travel after turning `yaw` rad relative to the current one. */
  private dirAt(yaw: number, out: Vector3): Vector3 {
    return out.copy(this.state.forward).applyAxisAngle(UP, yaw);
  }

  /**
   * One integration step of the turn: the desired angular velocity is limited by the maximum turn speed, by
   * the maximum lateral acceleration at this speed (ω ≤ a / v: the faster it moves, the wider the curve)
   * and by what still allows braking in time; the actual angular velocity approaches it with limited
   * acceleration.
   */
  private nextTurn(heading: number, angularVelocity: number, dt: number, speed: number): { heading: number; angularVelocity: number } {
    const maxSpeed = Math.min((this.config.turnSpeed * this.turnRateScale * Math.PI) / 180, this.config.maxLateralAcceleration / speed);
    const maxAccel = (this.config.turnAcceleration * this.turnRateScale * Math.PI) / 180;
    const error = wrapAngle(this.targetHeading - heading);
    const desired = Math.sign(error) * Math.min(maxSpeed, Math.sqrt(2 * maxAccel * Math.abs(error)), 6 * Math.abs(error));
    const w = moveTowards(angularVelocity, desired, maxAccel * dt);
    return { heading: heading + w * dt, angularVelocity: w };
  }

  /**
   * Orients the root (world) according to the current heading. Only updates the root's matrix: whatever
   * hangs from it is updated once, when its position is written (`writeRoot`), which always follows.
   */
  private applyHeading(): void {
    this.root.updateWorldMatrix(true, false);
    const worldQuat = this.q.copy(this.baseRotation).premultiply(this.qHeading.setFromAxisAngle(UP, this.state.heading));
    if (this.root.parent) this.root.quaternion.copy(this.root.parent.getWorldQuaternion(this.qParent).invert().multiply(worldQuat));
    else this.root.quaternion.copy(worldQuat);
    this.root.updateWorldMatrix(false, false);
  }

  /** Reads the world position of the root (respects it if it was moved from outside). */
  private readRoot(): void {
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldPosition(this.pos);
  }

  /** Writes the working world position to the root (converted to the parent's space). */
  private writeRoot(): void {
    // Actualiza los antepasados, la raíz y todo lo que cuelga de ella (una sola pasada).
    setWorldPosition(this.root, this.pos);
    this.state.position.copy(this.pos);
  }

  /**
   * Speed after `dt` seconds, accelerating or braking towards the desired one, and its rate of change.
   * With `speedEasing` > 0 it follows an S-curve: the acceleration (or braking) grows gradually up to
   * `acceleration` (or `deceleration`) and goes back to zero on arrival, so the speed never starts or stops
   * changing abruptly. With 0, a constant rate.
   */
  private nextSpeed(speed: number, rate: number, dt: number, target = this.cappedTargetSpeed()): { speed: number; rate: number } {
    const dv = target - speed;
    const scale = dv > 0 ? this.accelerationScale : this.brakeScale;
    const maxRate = (dv > 0 ? this.config.acceleration : this.config.deceleration) * scale;
    // Con más (o menos) aceleración, la rampa también es más corta (o más larga): misma forma.
    const easing = this.config.speedEasing / scale;
    if (!(easing > 0) || !(dt > 0)) {
      const next = moveTowards(speed, target, maxRate * dt);
      return { speed: next, rate: dt > 0 ? (next - speed) / dt : 0 };
    }
    // Ritmo deseado: el máximo, salvo cerca del objetivo, donde baja lo justo para llegar con
    // ritmo 0 (|ritmo| ≤ √(2·j·|dv|)) y, al final, de forma exponencial (≤ k·|dv|) para que la
    // aceleración se apague sin salto; el ritmo real se acerca a él con cambio limitado (j).
    const jerk = maxRate / easing;
    const tail = 6 / easing;
    const desired = Math.sign(dv) * Math.min(maxRate, Math.sqrt(2 * jerk * Math.abs(dv)), tail * Math.abs(dv));
    // Al crecer la aceleración, cambio limitado a j; al apagarla (cola exponencial), hasta 2·j.
    const easingOff = Math.sign(desired) === Math.sign(rate) && Math.abs(desired) < Math.abs(rate);
    const nextRate = moveTowards(rate, desired, (easingOff ? 2 : 1) * jerk * dt);
    const next = speed + nextRate * dt;
    // Al cruzar el objetivo (o quedarse a una diezmilésima del cambio que da la rampa), quedarse en él.
    // Umbral relativo (no en m/s fijos) para que un personaje escalado se mueva exactamente igual.
    if ((target - next) * dv <= 0 || Math.abs(target - next) < 1e-4 * maxRate * easing) return { speed: target, rate: 0 };
    return { speed: Math.max(next, 0), rate: nextRate };
  }

  /**
   * Desired speed within the limits (0 … runSpeed, speedLimit), reduced according to the turn it still has
   * to make from `heading` (intended direction): to change direction a lot it brakes and the curve
   * tightens; once the turn is complete it regains its speed.
   */
  private cappedTargetSpeed(heading = this.state.heading): number {
    const capped = Math.min(Math.max(this.targetSpeed, 0), this.config.runSpeed, this.speedLimit);
    return capped * this.turnSpeedFactor(wrapAngle(this.targetHeading - heading));
  }

  /**
   * Fraction of the desired speed with a remaining turn `error` (rad): 1 up to 20°, 1 − turnSlowdown at
   * 180°.
   */
  private turnSpeedFactor(error: number): number {
    const x = Math.min(Math.max((Math.abs(error) - TURN_SLOWDOWN_START) / (Math.PI - TURN_SLOWDOWN_START), 0), 1);
    return 1 - this.config.turnSlowdown * x * x * (3 - 2 * x);
  }

  /**
   * Distance it would travel before stopping if speed 0 were requested now, with the same braking curve the
   * body uses (including the `speedEasing` smoothing and the current rate). It is computed by simulating
   * that curve, so it always matches the real motion.
   */
  stoppingDistance(speed = this.state.speed): number {
    if (!(this.config.speedEasing > 0)) return (speed * speed) / (2 * this.config.deceleration);
    const h = 1 / 120;
    let v = speed;
    let rate = speed === this.state.speed ? this.speedRate : 0;
    let distance = 0;
    for (let i = 0; i < 2400 && v > 0; i++) {
      const next = this.nextSpeed(v, rate, h, 0);
      distance += ((v + next.speed) / 2) * h;
      v = next.speed;
      rate = next.rate;
    }
    return distance;
  }

  /** Recomputes direction, velocity and position from the root and the scalar speed. */
  private refreshState(): void {
    const s = this.state;
    this.root.getWorldQuaternion(this.q);
    s.forward.copy(this.forwardLocal).applyQuaternion(this.q).setY(0).normalize();
    s.velocity.copy(s.forward).multiplyScalar(s.speed);
    this.root.getWorldPosition(s.position);
  }

  /**
   * Brings the height of the working position towards the ground below it (blend 0–1), looking for it up to
   * `depth` m below the root (groundProbeDepth by default).
   */
  private snapToGround(blend: number, depth = this.config.groundProbeDepth): void {
    const p = this.pos;
    const { groundProbeHeight } = this.config;
    this.tmp.set(p.x, p.y + groundProbeHeight, p.z);
    const hit = this.detector.castDown(this.tmp, groundProbeHeight + depth, this.rootHit);
    // Sin suelo bajo la raíz (sobre el hueco de una escalera sin contrahuella), la línea de la escalera si la sigue.
    const ground = hit ? this.rootHit.point.y : Number.NaN;
    const target = this.groundLine ? this.groundLine(p, ground) : ground;
    this.state.grounded = Number.isFinite(target);
    if (this.state.grounded) {
      this.state.groundHeight = hit ? ground : target;
      p.y += (target - p.y) * blend;
    }
  }
}

/** Equivalent angle in (−π, π]. */
export function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

function moveTowards(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}
