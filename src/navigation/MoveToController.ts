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
/**
 * Following a route, it heads for the point this far ahead along it (× stepLength): it turns at its corners
 * along a curve instead of going point to point. Shorter, it would follow it closer and turn more sharply.
 */
const PATH_LOOKAHEAD = 0.75;
/**
 * Narrow paths on the route (see PathPlanner): from this far before one (× stepLength, along the route) and while
 * on it, it heads for a closer point (NARROW_LOOKAHEAD × stepLength) and steps sideways towards the line of the
 * route (NARROW_ALIGN_RATE, 1/s, at most NARROW_ALIGN_SPEED × stepLength per s): it gets on it straight, along the
 * middle, even if turning round left it to one side.
 */
const NARROW_APPROACH = 1.5;
const NARROW_LOOKAHEAD = 0.3;
const NARROW_ALIGN_RATE = 3;
const NARROW_ALIGN_SPEED = 0.4;
/**
 * Before getting on a narrow path, the speed (× narrowMaxSpeed) falls with the cosine of the turn it still has to
 * make to be in line with it, down to this: turning less wide, it doesn't overshoot its end.
 */
const NARROW_TURN_SPEED = 0.35;
/** Turning to its final heading (see `arrival`), it has arrived within this much of it (rad). */
const FACE_TOLERANCE = (3 * Math.PI) / 180;

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
 *  - Along a route (`setTarget` with `path`, see PathPlanner): it heads for a point a little ahead on it
 *    (PATH_LOOKAHEAD), so it turns at its corners along curves, and it only brakes on its last stretch.
 */
export class MoveToController {
  readonly config: MoveToConfig;
  /** Destino actual (world), o null si no hay ninguno. */
  readonly target = new Vector3();
  active = false;
  /** Run (true) or walk towards the destination. */
  run = false;
  /**
   * Route to the destination (world; the last point is `target`), or empty if it goes in a straight line.
   * `pathIndex`: the point it is going to (the previous ones are behind).
   */
  readonly path: Vector3[] = [];
  pathIndex = 0;
  /** For each point of `path`, whether the stretch that ends at it goes along a narrow path. */
  readonly narrow: boolean[] = [];
  /**
   * Once there, it turns to face this direction (world, horizontal; NaN x = no): on a narrow path got on from its
   * side, along it.
   */
  readonly arrival = new Vector3(Number.NaN, 0, 0);
  /** Arrived, it is turning to `arrival`. */
  private facing = false;
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
  /** Where the route starts (world) and the point ahead on it it heads for. */
  private readonly pathStart = new Vector3();
  private readonly aim = new Vector3();

  constructor(controller: LocomotionController, config: Partial<MoveToConfig> = {}) {
    this.controller = controller;
    this.config = { ...defaultMoveToConfig, ...config };
  }

  /**
   * New destination. It already turns the heading towards it, even if it is very close. With `path` (world
   * points; the last one, the destination), it goes there along it.
   */
  setTarget(point: Vector3, run = false, path: readonly Vector3[] = [], narrow: readonly boolean[] = [], arrival?: Vector3): void {
    this.target.copy(point);
    this.run = run;
    this.active = true;
    this.braking = false;
    this.facing = false;
    if (arrival && !Number.isNaN(arrival.x)) this.arrival.copy(arrival);
    else this.arrival.x = Number.NaN;
    // Subiendo a un camino angosto por su costado: los últimos pasos, sobre él (ver standTarget).
    if (Number.isNaN(this.arrival.x)) this.controller.standTarget.x = Number.NaN;
    else this.controller.standTarget.copy(path.length > 0 ? path[path.length - 1] : point);
    this.pivoting = false;
    this.exiting = false;
    this.path.length = 0;
    this.narrow.length = 0;
    this.pathIndex = 0;
    // Un solo tramo, como ruta si va por un camino angosto (para entrar en él alineado).
    if (path.length > 1 || (path.length === 1 && narrow[0])) {
      for (const p of path) this.path.push(p.clone());
      for (let k = 0; k < path.length; k++) this.narrow.push(narrow[k] ?? false);
      this.target.copy(this.path[this.path.length - 1]);
      this.pathStart.copy(this.controller.body.state.position);
    }
    this.controller.targetHeading = this.headingTo(this.aimPoint());
  }

  /** The character was shifted by `offset` (world) without moving: the destination shifts with it. */
  shift(offset: Vector3): void {
    this.target.add(offset);
    this.pathStart.add(offset);
    for (const p of this.path) p.add(offset);
  }

  /**
   * Point it heads for: on a route, the one `PATH_LOOKAHEAD` ahead along it (or the destination, on its last
   * stretch); otherwise, the destination. It moves on along the route as it goes.
   */
  private aimPoint(): Vector3 {
    const path = this.path;
    if (path.length === 0) return this.target;
    const p = this.controller.body.state.position;
    const lookahead = (this.narrowAhead() >= 0 ? NARROW_LOOKAHEAD : PATH_LOOKAHEAD) * this.controller.config.stepLength;
    // El tramo en que está: el primero cuyo final aún no ha pasado.
    let from = this.pathIndex === 0 ? this.pathStart : path[this.pathIndex - 1];
    let t = 0;
    while (this.pathIndex < path.length) {
      const to = path[this.pathIndex];
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const length2 = dx * dx + dz * dz;
      t = length2 > 1e-12 ? ((p.x - from.x) * dx + (p.z - from.z) * dz) / length2 : 1;
      // Pasado el final del tramo, o ya cerca de él y con el siguiente por delante: al siguiente. También si ya está
      // más allá de él en el tramo siguiente (con la mira corta de los caminos angostos, se pasaba del punto un poco
      // de lado y daba vueltas alrededor de él); pasada la mitad del tramo: si la ruta vuelve sobre sí misma, antes
      // de llegar al punto ya parece estar más allá de él.
      const near = Math.hypot(to.x - p.x, to.z - p.z) < lookahead / 2 || (t > 0.5 && this.beyond(this.pathIndex, p));
      if ((t < 1 && !near) || this.pathIndex === path.length - 1) break;
      from = to;
      this.pathIndex++;
    }
    // Desde su proyección en el tramo, `lookahead` por el camino.
    const to = path[this.pathIndex];
    t = Math.min(Math.max(t, 0), 1);
    let x = from.x + (to.x - from.x) * t;
    let z = from.z + (to.z - from.z) * t;
    let left = lookahead;
    for (let k = this.pathIndex; k < path.length; k++) {
      const q = path[k];
      const d = Math.hypot(q.x - x, q.z - z);
      if (d >= left) {
        return this.aim.set(x + ((q.x - x) * left) / d, q.y, z + ((q.z - z) * left) / d);
      }
      left -= d;
      x = q.x;
      z = q.z;
    }
    return this.target;
  }

  /**
   * The stretch of the route along a narrow path it is on or about to get on (within NARROW_APPROACH along the
   * route): its index in `path`, or −1.
   */
  private narrowAhead(): number {
    const path = this.path;
    if (!this.narrow.includes(true)) return -1;
    const p = this.controller.body.state.position;
    const approach = NARROW_APPROACH * this.controller.config.stepLength;
    let from: Vector3 = p;
    let along = 0;
    for (let k = this.pathIndex; k < path.length && along <= approach; k++) {
      if (this.narrow[k]) return k;
      along += Math.hypot(path[k].x - from.x, path[k].z - from.z);
      from = path[k];
    }
    return -1;
  }

  /**
   * `p` is already past point `k` of the route, on the stretch after it (its projection on it is ahead of the
   * point), and close to that stretch (within PATH_LOOKAHEAD / 2).
   */
  private beyond(k: number, p: Vector3): boolean {
    if (k + 1 >= this.path.length) return false;
    const a = this.path[k];
    const b = this.path[k + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return true;
    const along = ((p.x - a.x) * dx + (p.z - a.z) * dz) / length;
    const off = Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / length;
    return along > 0 && off < (PATH_LOOKAHEAD * this.controller.config.stepLength) / 2;
  }

  /** Cosine of the angle between the heading and the stretch `k` of the route (1 = in line with it). */
  private alignment(k: number): number {
    const a = k === 0 ? this.pathStart : this.path[k - 1];
    const b = this.path[k];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-6) return 1;
    const f = this.controller.body.state.travel;
    return ((b.x - a.x) * f.x + (b.z - a.z) * f.z) / length;
  }

  /** From the stretch it is on to the destination, the route goes along a narrow path. */
  private narrowToEnd(): boolean {
    if (this.path.length === 0) return false;
    for (let k = this.pathIndex; k < this.path.length; k++) if (!this.narrow[k]) return false;
    return true;
  }

  /** Near or on a narrow stretch of the route, it steps sideways towards its line (see NARROW_APPROACH). */
  private alignToNarrow(dt: number): void {
    const k = this.narrowAhead();
    const state = this.controller.body.state;
    if (k < 0 || state.airborne) return;
    const a = k === 0 ? this.pathStart : this.path[k - 1];
    const b = this.path[k];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return;
    // Distancia con signo a la línea del tramo (hacia su izquierda, en planta) y lo que se acerca a ella.
    const nx = -dz / length;
    const nz = dx / length;
    const off = (state.position.x - a.x) * nx + (state.position.z - a.z) * nz;
    const most = NARROW_ALIGN_SPEED * this.controller.config.stepLength * dt;
    const move = Math.max(-most, Math.min(most, -off * (1 - Math.exp(-NARROW_ALIGN_RATE * dt))));
    this.controller.body.drift.x += nx * move;
    this.controller.body.drift.z += nz * move;
  }

  /** At the destination: done, or first it turns to `arrival`. */
  private arrive(): void {
    if (Number.isNaN(this.arrival.x)) {
      this.active = false;
      return;
    }
    this.facing = true;
    this.face();
  }

  /**
   * Turning on the spot to `arrival`: when it faces it and has stopped turning, it has arrived. Meanwhile it moves
   * onto the destination itself (it stopped within `arriveRadius` of it: on a narrow path, off its middle).
   */
  private face(dt = 0): void {
    const state = this.controller.body.state;
    this.controller.targetSpeed = 0;
    const dx = this.target.x - state.position.x;
    const dz = this.target.z - state.position.z;
    const off = Math.hypot(dx, dz);
    const move = Math.min(off, NARROW_ALIGN_SPEED * this.controller.config.stepLength * dt);
    if (off > 1e-6) {
      this.controller.body.drift.x += (dx / off) * move;
      this.controller.body.drift.z += (dz / off) * move;
    }
    this.controller.targetHeading = this.headingTo(this.toTarget.copy(state.position).add(this.arrival));
    const error = Math.abs(wrapAngle(this.controller.targetHeading - state.heading));
    if (error < FACE_TOLERANCE && !this.controller.body.isTurning()) {
      this.active = false;
      this.controller.standTarget.x = Number.NaN;
    }
  }

  /** Drops the destination and stops (the manual controls are in charge again). */
  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.controller.targetSpeed = 0;
    this.controller.standTarget.x = Number.NaN;
  }

  /** What is left to walk to the destination (m): along the route, if there is one; 0 without a destination. */
  remaining(): number {
    if (!this.active) return 0;
    const p = this.controller.body.state.position;
    if (this.path.length === 0) return this.distance();
    let from: Vector3 = p;
    let total = 0;
    for (let k = this.pathIndex; k < this.path.length; k++) {
      total += Math.hypot(this.path[k].x - from.x, this.path[k].z - from.z);
      from = this.path[k];
    }
    return total;
  }

  /** Horizontal distance to the destination (m); 0 without a destination. */
  distance(): number {
    if (!this.active) return 0;
    const p = this.controller.body.state.position;
    return Math.hypot(this.target.x - p.x, this.target.z - p.z);
  }

  /**
   * Decides the desired speed and heading. Call every frame before LocomotionController.update, with the time
   * of that frame (s; without it, it doesn't align itself with the narrow paths of the route).
   */
  update(dt = 0): void {
    this.updateTurnLimits();
    if (!this.active) return;
    if (this.facing) {
      this.face(dt);
      return;
    }
    if (dt > 0) this.alignToNarrow(dt);
    const c = this.config;
    const loco = this.controller.config;
    const distance = this.distance();

    const state = this.controller.body.state;
    // Por una ruta, hacia un punto por delante en ella; hasta que el destino queda a menos de eso: entonces,
    // como en línea recta (frena y llega).
    // En el último tramo, si va por un camino angosto (allí mira más cerca), también: frena a tiempo.
    const lastNarrow = this.pathIndex === this.path.length - 1 && this.narrow[this.pathIndex];
    const aim = lastNarrow ? this.target : this.aimPoint();
    const onRoute = aim !== this.target;
    // Por un camino angosto hasta el final: frena según lo que le queda por él (no sale de él para frenar).
    const narrowToEnd = this.narrowToEnd();
    const left = narrowToEnd ? this.remaining() : distance;
    if (this.braking) {
      this.controller.targetSpeed = 0;
      if (state.speed < 1e-3) {
        // Parado: si se quedó cerca, ha llegado; si no (p. ej. frenó al cambiar de destino), sigue.
        if (distance <= c.arriveRadius + c.stopTolerance) this.arrive();
        else this.braking = false;
      }
      return;
    }

    const bearing = this.headingTo(aim) - state.heading; // ángulo del destino respecto a la dirección actual
    const aimDistance = onRoute ? Math.hypot(aim.x - state.position.x, aim.z - state.position.z) : distance;
    const stopDistance = this.controller.body.stoppingDistance(state.speed);
    if ((!onRoute || narrowToEnd) && left - c.arriveRadius <= stopDistance && Math.cos(bearing) > BRAKE_MIN_COS) {
      this.braking = true;
      this.controller.targetSpeed = 0;
      return;
    }

    // Destino detrás: frena y pivota hacia él; con el destino ya delante, sale caminando.
    if (!this.pivoting && Math.abs(bearing) > PIVOT_START && aimDistance > c.headingLockRadius) {
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

    if (onRoute || distance > c.headingLockRadius) {
      this.controller.targetHeading = state.heading + bearing;
    } else if (distance * Math.cos(bearing) <= c.arriveRadius) {
      // Cerca y el destino ya no queda delante: está en el punto más cercano.
      this.controller.targetSpeed = 0;
      this.arrive();
      return;
    }

    // Error de rumbo respecto al deseado.
    const error = Math.abs(wrapAngle(this.controller.targetHeading - state.heading));
    const cosMax = Math.cos((c.maxWalkTurnAngle * Math.PI) / 180);
    const turnFactor = clamp01((Math.cos(error) - cosMax) / (1 - cosMax));

    // Llegando a un camino angosto de la ruta, ya a la velocidad de ir por él (no frena de golpe al subir), y más
    // despacio cuanto más tiene que girar para ponerse en línea con él: el giro se abre menos.
    const narrowStretch = this.narrowAhead();
    const cruise = narrowStretch >= 0
      ? Math.min(this.cruiseSpeed(), loco.narrowMaxSpeed * Math.max(NARROW_TURN_SPEED, this.alignment(narrowStretch)))
      : this.cruiseSpeed();
    const omega = (loco.turnSpeed * Math.PI) / 180;
    // Radio de la curva que alcanza el destino: r = d / (2·sen α). Girando a ω, v ≤ ω·r;
    // con la aceleración lateral limitada (ω ≤ a/v), además v ≤ √(a·r).
    const twoSin = 2 * Math.max(Math.abs(Math.sin(bearing)), 1e-3);
    const turnRadiusLimit = Math.min((omega * aimDistance) / twoSin, Math.sqrt((loco.maxLateralAcceleration * aimDistance) / twoSin));
    // Con el destino muy de lado (hasta PIVOT_START; más allá pivota) no se para a girar: sigue andando
    // por una curva. El cuerpo ya frena según el giro pendiente (turnSlowdown); aquí solo se
    // limita el radio de la curva (v/ω) a una fracción de la distancia para no rodear el
    // destino: si está muy cerca, casi gira en el sitio.
    const turnaroundLimit = omega * aimDistance * TURN_RADIUS_FRACTION;
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

  /** Cruising speed towards the destination (walking or jogging: around turns, stairs and narrow paths, not a full run). */
  private cruiseSpeed(): number {
    const loco = this.controller.config;
    return this.run ? Math.min(loco.jogSpeed, loco.runSpeed) : loco.walkSpeed;
  }

  /** Heading (rad, BodyController convention) pointing towards `point`. */
  private headingTo(point: Vector3): number {
    const state = this.controller.body.state;
    this.toTarget.subVectors(point, state.position).setY(0);
    if (this.toTarget.lengthSq() < 1e-8) return this.controller.targetHeading;
    // Respecto a la dirección de avance (de espaldas a la pared de una cornisa, el cuerpo mira hacia otro lado).
    const f = state.travel;
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
