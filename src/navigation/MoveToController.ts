import { Vector3 } from 'three';

import { wrapAngle } from '../body/BodyController.ts';
import type { LocomotionController } from '../locomotion/LocomotionController.ts';

const UP = new Vector3(0, 1, 0);
/**
 * Maximum radius of the curve to turn around towards a destination behind, as a fraction of the distance
 * (v ≤ ω·d·fraction).
 */
const TURN_RADIUS_FRACTION = 0.25;
/** It only brakes to stop if the destination is ahead (±30°); otherwise, it turns first. */
const BRAKE_MIN_COS = Math.cos(Math.PI / 6);
/**
 * With the destination beyond this angle (behind), instead of the curve it turns around by pivoting: it
 * brakes and turns in two large steps, like a person. In the CMU captures, turns of up to ~120° are made
 * without stopping walking; 180° turns, braking, in 2–3 steps of ~100–120°.
 */
const PIVOT_START = (120 * Math.PI) / 180;
/** When pivoting, once the destination is within this angle it sets off walking towards it. */
const PIVOT_RELEASE = (30 * Math.PI) / 180;
/**
 * When pivoting: turn speed and turn acceleration (× turnSpeed, turnAcceleration). CMU: up to 120–165 °/s.
 */
const PIVOT_TURN_RATE = 2.5;
/**
 * When pivoting: maximum turn per step (× maxTurnPerStep): 180° in 2–3 steps. Any more and the planted
 * foot had to pivot too much.
 */
const PIVOT_TURN_PER_STEP = 2.5;
/**
 * Speed while pivoting (× walkSpeed; 0.45 m/s with the default one): it doesn't stop completely, so each
 * step already moves in the new direction (when stopped, the steps landed in the same place and stepped on
 * each other). CMU: 0.3–0.5 m/s.
 */
const PIVOT_SPEED = 0.32;
/** Al pivotar: frenada (× deceleration). */
const PIVOT_BRAKE = 1.6;
/** When coming out of the turn: acceleration (× acceleration) up to cruising speed. CMU: 2–3 steps. */
const PIVOT_EXIT_ACCELERATION = 0.45;
/**
 * With the destination almost straight behind (beyond this angle) it makes no difference which way it
 * turns: it turns towards the side of the foot that takes off next, which opens the turn (the outer one
 * would cross in front of the supporting leg and the knees would collide).
 */
const PIVOT_EITHER_WAY = (150 * Math.PI) / 180;
/**
 * Maximum remaining turn requested from the body when pivoting (below 180°, so that it doesn't pick the
 * other direction).
 */
const PIVOT_MAX_STEER = (170 * Math.PI) / 180;

export interface MoveToConfig {
  /** Distance to the target at which it counts as arrived (m). */
  arriveRadius: number;
  /**
   * Heading error from which the target counts as well off to the side: it stops going at its normal speed
   * and turns while walking, along a curve whose radius is limited by the distance (it does not stop to turn)
   * (degrees). Beyond 120° (behind) it no longer curves: it brakes and turns towards the target in 2–3 steps.
   */
  maxWalkTurnAngle: number;
  /** Near the target it stops correcting its heading (avoids circling around the point) (m). */
  headingLockRadius: number;
  /** Extra distance to the target within which, once stopped after braking, it counts as arrived (m). */
  stopTolerance: number;
}

export const defaultMoveToConfig: MoveToConfig = {
  arriveRadius: 0.05,
  maxWalkTurnAngle: 75,
  headingLockRadius: 0.4,
  stopTolerance: 0.1,
};

/**
 * Point and click: takes the character to a point on the ground.
 *
 * It is a layer of intention above the locomotion: every frame it reads the state of the body (position,
 * direction, heading) and decides the desired speed and heading, the same two commands the manual
 * controls give. It doesn't touch the gait, the steps or IK.
 *
 *  - Heading: towards the destination (angle measured from the current direction, without assuming where
 *    the model faces). Close to the destination it stays fixed.
 *  - Speed: walking or running, limited by
 *      · the heading error: if the destination is far to the side, it turns while walking in a curve of
 *        radius ≤ ¼ of the distance (the body also brakes according to the remaining turn);
 *      · the turning radius: to reach a point at distance d and angle α turning at ω (rad/s) it needs
 *        v ≤ ω·d / (2·sin α); otherwise it would circle around it without arriving;
 *  - Turning around: with the destination behind (beyond PIVOT_START) it brakes (without stopping
 *    completely) and turns towards it in 2–3 large steps (it raises the turn limits of the body and of
 *    each step while turning, more the slower it goes), and sets off walking with the destination ahead.
 *  - Braking: when the remaining distance is the braking distance (v²/2a, with the body's deceleration),
 *    it requests speed 0 just once. The body brakes at a constant rate and stops at the destination, and
 *    its prediction (which assumes a constant desired speed) places the last steps correctly. Gradual
 *    braking, changing the desired speed every frame, would make the last foot land too far.
 *  - It arrives when it stops after braking or, once close, when the destination is no longer ahead (it
 *    has passed the closest point).
 *  - In a straight line: no obstacles or pathfinding yet.
 */
export class MoveToController {
  readonly config: MoveToConfig;
  /** Destino actual (world), o null si no hay ninguno. */
  readonly target = new Vector3();
  active = false;
  /** Run (true) or walk towards the destination. */
  run = false;
  /** Braking to stop at the destination (it stays on until stopped). */
  private braking = false;
  /** Turning around by pivoting towards a destination behind (see PIVOT_START). */
  private pivoting = false;
  /**
   * Coming out of the turn: it accelerates more gently up to cruising speed (see PIVOT_EXIT_ACCELERATION).
   */
  private exiting = false;
  /** Direction of the turn (+1 left, −1 right), chosen when it starts pivoting. */
  private pivotDirection = 1;

  private readonly controller: LocomotionController;
  private readonly toTarget = new Vector3();
  private readonly cross = new Vector3();

  constructor(controller: LocomotionController, config: Partial<MoveToConfig> = {}) {
    this.controller = controller;
    this.config = { ...defaultMoveToConfig, ...config };
  }

  /** New destination. It already turns the heading towards it, even if it is very close. */
  setTarget(point: Vector3, run = false): void {
    this.target.copy(point);
    this.run = run;
    this.active = true;
    this.braking = false;
    this.pivoting = false;
    this.exiting = false;
    this.controller.targetHeading = this.headingTo(this.target);
  }

  /** The character was shifted by `offset` (world) without moving: the destination shifts with it. */
  shift(offset: Vector3): void {
    this.target.add(offset);
  }

  /** Drops the destination and stops (the manual controls are in charge again). */
  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.controller.targetSpeed = 0;
  }

  /** Horizontal distance to the destination (m); 0 without a destination. */
  distance(): number {
    if (!this.active) return 0;
    const p = this.controller.body.state.position;
    return Math.hypot(this.target.x - p.x, this.target.z - p.z);
  }

  /** Decides the desired speed and heading. Call every frame before LocomotionController.update. */
  update(): void {
    this.updateTurnLimits();
    if (!this.active) return;
    const c = this.config;
    const loco = this.controller.config;
    const distance = this.distance();

    const state = this.controller.body.state;
    if (this.braking) {
      this.controller.targetSpeed = 0;
      if (state.speed < 1e-3) {
        // Parado: si se quedó cerca, ha llegado; si no (p. ej. frenó al cambiar de destino), sigue.
        if (distance <= c.arriveRadius + c.stopTolerance) this.active = false;
        else this.braking = false;
      }
      return;
    }

    const bearing = this.headingTo(this.target) - state.heading; // ángulo del destino respecto a la dirección actual
    const stopDistance = this.controller.body.stoppingDistance(state.speed);
    if (distance - c.arriveRadius <= stopDistance && Math.cos(bearing) > BRAKE_MIN_COS) {
      this.braking = true;
      this.controller.targetSpeed = 0;
      return;
    }

    // Destino detrás: frena y pivota hacia él; con el destino ya delante, sale caminando.
    if (!this.pivoting && Math.abs(bearing) > PIVOT_START && distance > c.headingLockRadius) {
      this.pivoting = true;
      // Lanzado (más deprisa que caminando) la vuelta empieza siendo una curva: por el lado más corto.
      const either = Math.abs(bearing) > PIVOT_EITHER_WAY && state.speed <= loco.walkSpeed;
      this.pivotDirection = either ? this.openStepDirection() : Math.sign(bearing) || 1;
    } else if (this.pivoting && Math.abs(bearing) < PIVOT_RELEASE) {
      this.pivoting = false;
      this.exiting = true;
    }
    if (this.pivoting) {
      // En el sentido elegido aunque el destino quede un poco más corto por el otro lado (el cuerpo
      // gira por el camino más corto hacia su rumbo deseado: se le pide como mucho PIVOT_MAX_STEER).
      const remaining = Math.sign(bearing) === this.pivotDirection || Math.abs(bearing) < Math.PI / 2 ? bearing : bearing + 2 * Math.PI * this.pivotDirection;
      this.controller.targetHeading = state.heading + this.pivotDirection * Math.min(Math.abs(remaining), PIVOT_MAX_STEER);
      this.controller.targetSpeed = PIVOT_SPEED * loco.walkSpeed;
      this.updateTurnLimits();
      return;
    }

    if (distance > c.headingLockRadius) {
      this.controller.targetHeading = state.heading + bearing;
    } else if (distance * Math.cos(bearing) <= c.arriveRadius) {
      // Cerca y el destino ya no queda delante: está en el punto más cercano.
      this.active = false;
      this.controller.targetSpeed = 0;
      return;
    }

    // Error de rumbo respecto al deseado.
    const error = Math.abs(wrapAngle(this.controller.targetHeading - state.heading));
    const cosMax = Math.cos((c.maxWalkTurnAngle * Math.PI) / 180);
    const turnFactor = clamp01((Math.cos(error) - cosMax) / (1 - cosMax));

    const cruise = this.cruiseSpeed();
    const omega = (loco.turnSpeed * Math.PI) / 180;
    // Radio de la curva que alcanza el destino: r = d / (2·sen α). Girando a ω, v ≤ ω·r;
    // con la aceleración lateral limitada (ω ≤ a/v), además v ≤ √(a·r).
    const twoSin = 2 * Math.max(Math.abs(Math.sin(bearing)), 1e-3);
    const turnRadiusLimit = Math.min((omega * distance) / twoSin, Math.sqrt((loco.maxLateralAcceleration * distance) / twoSin));
    // Con el destino muy de lado (hasta PIVOT_START; más allá pivota) no se para a girar: sigue andando
    // por una curva. El cuerpo ya frena según el giro pendiente (turnSlowdown); aquí solo se
    // limita el radio de la curva (v/ω) a una fracción de la distancia para no rodear el
    // destino: si está muy cerca, casi gira en el sitio.
    const turnaroundLimit = omega * distance * TURN_RADIUS_FRACTION;
    this.controller.targetSpeed = Math.min(cruise, turnRadiusLimit) * turnFactor + Math.min(cruise, turnaroundLimit) * (1 - turnFactor);
  }

  /**
   * Turn limits: higher while pivoting and until the turn rate it carried drops to the normal turn speed
   * (if they were cut abruptly on leaving the pivot, the body would overshoot the heading).
   */
  private updateTurnLimits(): void {
    const body = this.controller.body;
    const config = this.controller.config;
    const normal = (config.turnSpeed * Math.PI) / 180;
    const boost = this.active && (this.pivoting || Math.abs(body.state.angularVelocity) > normal);
    // Entero ya casi parado; a velocidad de marcha, nada: llegando deprisa, primero frena y luego
    // pivota (girar 150 °/s todavía lanzado cruzaba las piernas en una curva muy cerrada).
    const slow = boost ? 1 - smoothstep(body.state.speed / config.walkSpeed) : 0;
    body.turnRateScale = 1 + (PIVOT_TURN_RATE - 1) * slow;
    // Al recibir la vuelta caminando deprisa, frena más decidido que al pararse: si no, el paso que
    // ya estaba en el aire aterrizaba casi con la zancada entera.
    body.brakeScale = this.active && this.pivoting ? PIVOT_BRAKE : 1;
    // Saliendo de la vuelta acelera más suave, hasta su velocidad de crucero: de golpe, el pie que
    // pivotó se quedaba muy atrás con la pierna estirada y el paso siguiente salía largo.
    if (this.exiting && (!this.active || this.pivoting || body.state.speed >= 0.95 * this.cruiseSpeed())) this.exiting = false;
    body.accelerationScale = this.exiting ? PIVOT_EXIT_ACCELERATION : 1;
    this.controller.gait.turnPerStepScale = 1 + (PIVOT_TURN_PER_STEP - 1) * slow;
  }

  /**
   * Direction of the turn (+1 left, −1 right) towards the side of the foot that takes off next: the planted
   * one that has been in stance longer (if one is in the air, the other one).
   */
  private openStepDirection(): number {
    const gait = this.controller.gait;
    const next = (['left', 'right'] as const)
      .filter((side) => gait.isStance(side))
      .sort((a, b) => gait.footPhase(b) - gait.footPhase(a))[0] ?? 'right';
    return next === 'left' ? 1 : -1;
  }

  /** Cruising speed towards the destination (walking or running). */
  private cruiseSpeed(): number {
    const loco = this.controller.config;
    return this.run ? loco.runSpeed : loco.walkSpeed;
  }

  /** Heading (rad, BodyController convention) pointing towards `point`. */
  private headingTo(point: Vector3): number {
    const state = this.controller.body.state;
    this.toTarget.subVectors(point, state.position).setY(0);
    if (this.toTarget.lengthSq() < 1e-8) return this.controller.targetHeading;
    const f = state.forward;
    const sin = this.cross.crossVectors(f, this.toTarget).dot(UP);
    const cos = f.dot(this.toTarget);
    return state.heading + Math.atan2(sin, cos);
  }
}

function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

function smoothstep(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
