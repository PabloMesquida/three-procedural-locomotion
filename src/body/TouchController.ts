import { Matrix4, Quaternion, Vector3 } from 'three';

import { updateSubtree, worldPosition, worldQuaternion } from '../core/pose.ts';
import { TwoBoneIK } from '../ik/TwoBoneIK.ts';
import type { ArmBones, HumanRig, Side } from '../rig/HumanRig.ts';
import { createSurfaceHit, type SurfaceDetector, type SurfaceHit } from '../terrain/SurfaceDetector.ts';

const UP = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;

export interface TouchConfig {
  /**
   * Duration of the gesture of bringing the hand to the surface (s). In the CMU reaches (subject 144),
   * 0.65–0.8 s from the hanging arm, with a bell-shaped speed profile.
   */
  touchReachTime: number;
  /** Duration of the hand's return to its swing after letting go (s). CMU: ~0.7 s, symmetric bell. */
  touchReleaseTime: number;
  /**
   * Minimum time with the hand resting on the surface (s). When walking, it lets go once the point falls
   * behind.
   */
  touchHoldTime: number;
  /**
   * Maximum distance from shoulder to wrist when touching, predicted when the gesture starts (fraction of the
   * arm, 0–1). In CMU, reaching as far as possible, 0.94–0.99 (elbow at 140–165°); touching in passing does
   * not stretch as much, and the sway of walking (±3–4 cm at the shoulder) makes it arrive a little more
   * extended.
   */
  touchMaxReach: number;
  /** Pause after letting go before touching something again on its own (s). */
  touchCooldown: number;
}

/** What each hand is doing: nothing, moving towards the surface, resting on it or coming back. */
export type TouchPhase = 'none' | 'reach' | 'contact' | 'release';

/** Body data for the gesture. */
export interface TouchMotion {
  dt: number;
  /** Horizontal direction of travel (unit, world). */
  forward: Vector3;
  /** Velocity of the body (world, m/s). */
  velocity: Vector3;
  /** Can it touch now? Walking or standing, with the feet on the ground (not running or jumping). */
  allowed: boolean;
  /** Standing still: lets go as soon as the minimum time has passed. */
  still: boolean;
}

export interface TouchOptions {
  /**
   * Normal of the surface (world, towards the character). Without it, it is looked up with the detector or
   * assumed vertical.
   */
  normal?: Vector3;
  /** Hand; without it, the one on the side of the point. */
  side?: Side;
  /**
   * While walking, slide the hand along the surface while it stays alongside (by default, the controller's
   * `slide`). Without sliding, the hand stays still where it touched and is withdrawn when the point is left
   * behind.
   */
  slide?: boolean;
  /**
   * Keep the hand resting until `release` (or until it can't reach). Otherwise it is withdrawn as when
   * passing by.
   */
  hold?: boolean;
}

interface Hand {
  side: Side;
  /** +1 derecha, −1 izquierda. */
  sign: number;
  bones: ArmBones;
  /** Shoulder → elbow → wrist (m). */
  armLength: number;
  /** Wrist → center of the palm (m) and half the thickness of the hand. */
  palmLength: number;
  palmThickness: number;
  /** Direction of the fingers and normal of the palm (towards the palm side), in the hand's local space. */
  fingerLocal: Vector3;
  palmLocal: Vector3;
  phase: TouchPhase;
  /** How much the gesture overrides the swing (0–1) and its value when the phase started. */
  weight: number;
  from: number;
  /** Time in the current phase (s). */
  time: number;
  hold: boolean;
  /** Slides the hand along the surface while walking, its speed along it (m/s) and the smoothed normal. */
  slide: boolean;
  slideSpeed: number;
  /** How far it has slid (m). */
  slideDistance: number;
  slideVelocity: Vector3;
  slideNormal: Vector3;
  slideRawNormal: Vector3;
  /** Velocity of the hand when letting go (m/s, world): the one it really had. */
  releaseVelocity: Vector3;
  /**
   * Where the wrist really is (after IK) and its velocity (m/s, smoothed): when letting go, the way back
   * starts from there. If the point was already out of reach (a column left behind), starting from it
   * stopped the arm abruptly, fully stretched.
   */
  actualWrist: Vector3;
  actualVelocity: Vector3;
  hasActual: boolean;
  object: unknown;
  /** Point touched and normal of the surface (world). */
  point: Vector3;
  normal: Vector3;
  /** Wrist and orientation of the resting hand (world), decided when the gesture starts. */
  wrist: Vector3;
  rotation: Quaternion;
  /** When letting go, the hand relative to the forearm stays as it was (it comes off the surface with it). */
  releaseLocal: Quaternion;
  releaseLocalSet: boolean;
  /**
   * When letting go, where the hand comes back from: it starts still on the surface and then moves with
   * the body. With a fixed point, the body moved away from it while the hand came back and the arm whipped
   * backwards.
   */
  anchor: Vector3;
  /** Direction of the hand's rotation (±1), chosen when each phase starts. */
  pathSign: number;
  pathSet: boolean;
  /** Swinging and resting hand (relative to the forearm) of the last frame, with a continuous sign. */
  swingQ: Quaternion;
  contactQ: Quaternion;
  /** Direction the path curves towards (unit, world; decided when each phase starts). */
  bulge: Vector3;
  bulgeSet: boolean;
}

/** When touching, the hand opens: the fingers almost straight (fingerCurl). */
export const TOUCH_FINGER_CURL = 0.2;
/** Height at which it looks for walls and columns: somewhat below the shoulder (× arm; CMU: −0.5 to +0.4). */
const SEARCH_DROP = 0.3;
/** Search directions: from outwards (0°) to almost forward. */
const SEARCH_ANGLES = [0, 25, 50, 75].map((a) => a * DEG);
/** Railings: outward offset and forward lead of the downward rays (× arm). */
const RAIL_OUT = [0.3, 0.45, 0.6];
const RAIL_AHEAD = [0, 0.25];
/**
 * Preferred shoulder–wrist distance when touching (× arm): elbow bent, ~110°; with the bobbing of the
 * gait (±3–4 cm at the shoulder) it arrives somewhat more stretched.
 */
const PREFERRED_REACH = 0.75;
/** Preferred lead of the point relative to the shoulder when touching while walking (× arm). */
const PREFERRED_LEAD = 0.2;
/** The closest to the shoulder a surface is accepted (× arm): any closer, the elbow would be very bent. */
const MIN_REACH = 0.45;
/** Saturation of the IK shoulder → wrist distance (× arm): from where and up to how much. */
const SOFT_REACH_KNEE = 0.92;
const SOFT_REACH_MAX = 0.99;
/**
 * While resting, lets go if the arm would have to stretch more than this (× arm): the hand would come off.
 */
const MAX_STRETCH = 0.93;
/** While walking, lets go when the point is this far behind the shoulder (× arm). */
const RELEASE_BEHIND = 0.15;
/** How often it looks for surfaces (s). */
const SCAN_INTERVAL = 0.1;
/** Time without seeing the last object touched after which it can be touched again (s). */
const FORGET_TIME = 2;
/** While walking, it doesn't touch surfaces facing it head-on (normal · direction of travel < −FACING). */
const FACING = 0.6;
/**
 * Sliding: frequency of the spring that carries the hand (Hz; critical) and lead of its rest point
 * (× arm).
 */
const SLIDE_FREQUENCY = 1.5;
const SLIDE_LEAD = 0.1;
/**
 * Sliding: lets go if the arm would have to stretch more than this (× arm). More than when touching
 * (MAX_STRETCH): the distance changes slowly, and on a low railing the hand rests with the arm almost
 * straight.
 */
const MAX_SLIDE_STRETCH = 0.97;
/** Sliding: time over which the hand goes from still (it has just touched) to following the body (s). */
const SLIDE_START = 0.15;
/** Sliding along a wall: height the hand lowers to (× arm below the shoulder) and over how long (s). */
const SLIDE_DROP = 0.55;
const SLIDE_DROP_TIME = 0.6;
/** … after sliding this far (× arm). */
const SLIDE_DROP_AFTER = 0.1;
/** Sliding: where the ray that sticks the hand to the surface starts (× arm, outside the surface). */
const SLIDE_PROBE = 0.2;
/**
 * Sliding: the most the normal can turn per arm length traveled (rad): any more and it is too curved
 * (radius less than ~arm / SLIDE_MAX_BEND, ~0.5 m) and it stops sliding.
 */
const SLIDE_MAX_BEND = 1;
/** Sliding: the surface ends if the normal suddenly turns more than this (cosine: a corner). */
const SLIDE_MIN_NORMAL = 0.5;
/** Smoothing of the real velocity of the wrist (s). */
const ACTUAL_VELOCITY_TIME = 0.03;
/** Sliding: smoothing of the normal and of the hand's velocity (s). */
const SLIDE_NORMAL_TIME = 0.1;
const SLIDE_VELOCITY_TIME = 0.05;
/** Fraction of the way back over which the hand goes from still on the surface to moving with the body. */
const RELEASE_FOLLOW = 0.4;
/** Curvature of the hand's path (fraction of the distance, away from the shoulder). CMU: 0.14–0.17. */
const PATH_BULGE = 0.12;
/** Cost of exceeding the reach: more than any rotation of the hand (rad², at most 2·π²). */
const REACH_COST = 100;
/** Directions of the fingers on the surface that it tries when the gesture starts. */
const FINGER_CANDIDATES = 12;
/** To measure the reach: the fingers point like the forearm and a little upwards (weight of the vertical). */
const FINGER_LIFT = 0.4;
/** The elbow, down and back (and a little outwards). */
const POLE_BACK = 0.5;
const POLE_DOWN = 0.8;
const POLE_OUT = 0.2;
/**
 * How much the resting elbow keeps of the direction it was already bending towards (versus down and back).
 */
const SWING_BEND_KEEP = 0.5;

/**
 * Touching surfaces with the hand: a column or a wall when passing by, the railing of a bridge.
 *
 * The gesture, measured on the CMU reaches: the hand goes from its swing to the surface in ~0.75 s with a
 * bell-shaped speed profile (minimum jerk) along a slightly curved path (the elbow bends halfway and
 * straightens at the end), rests with the palm towards the surface and the fingers spread, stays still
 * while the body passes and hangs down again in ~0.7 s. The arm swing keeps going underneath: the gesture
 * is blended with it (`weight`), so it starts and ends without jumps.
 *
 * With a detector, it touches on its own (`auto`): it looks at where the shoulder will be when the
 * gesture ends and searches for a wall or column to the side (horizontal rays) or a railing (downward
 * rays) within reach of the hand. Each object, once while it stays close. It can also be requested with
 * `touch`.
 */
export class TouchController {
  /** Buscar superficies y tocarlas solo. */
  auto = true;
  /**
   * While walking, slide the hand along the surface while it stays alongside (otherwise, touch and let go).
   */
  slide = true;
  /** Contacts that started in the last update (for the `touch` event). */
  readonly touched: { side: Side; point: Vector3 }[] = [];

  private readonly config: TouchConfig;
  private readonly hands: Partial<Record<Side, Hand>> = {};
  private readonly ik = new TwoBoneIK();
  private cooldown = 0;
  private scanTimer = 0;
  /**
   * Objects touched on its own that are still close, with the time they have been out of sight (s): they
   * are not repeated until lost from sight (a long wall, once, even if it touches something else in
   * between). Without an object, the last point touched.
   */
  private readonly recent = new Map<unknown, number>();
  private readonly seenNow = new Set<unknown>();
  private readonly lastPoint = new Vector3();
  private hasLastPoint = false;

  private readonly hit: SurfaceHit = createSurfaceHit();
  private readonly shoulder = new Vector3();
  private readonly predicted = new Vector3();
  private readonly later = new Vector3();
  private readonly slideTangent = new Vector3();
  /** Time of the last update (s). */
  private dt = 0;
  private readonly origin = new Vector3();
  private readonly dir = new Vector3();
  private readonly out = new Vector3();
  private readonly candidate = { point: new Vector3(), normal: new Vector3(), object: undefined as unknown, side: 'right' as Side, score: Infinity };
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly target = new Vector3();
  private readonly pole = new Vector3();
  private readonly elbow = new Vector3();
  private readonly swingWrist = new Vector3();
  private readonly q = new Quaternion();
  private readonly contactPole = new Vector3();
  private readonly contactWrist = new Vector3();
  private readonly contactLocal = new Quaternion();
  private readonly qFollow = new Quaternion();
  private readonly e1 = new Vector3();
  private readonly e2 = new Vector3();
  private readonly fingerTry = new Vector3();
  private readonly wristTry = new Vector3();
  private readonly rotationTry = new Quaternion();
  private readonly swingLocal = new Quaternion();
  private readonly qInverse = new Quaternion();
  private readonly axisLocal = new Vector3();
  private readonly shoulderNow = new Vector3();
  private readonly swingBend = new Vector3();
  private readonly bendNow = new Vector3();
  private readonly axisFrom = new Vector3();
  private readonly axisTo = new Vector3();
  private readonly qTransport = new Quaternion();
  private readonly bendContact = new Vector3();
  private readonly hingeA = new Vector3();
  private readonly hingeB = new Vector3();
  private readonly hingeC = new Vector3();
  private readonly hingeAxis = new Vector3();
  private readonly hingeQ = new Quaternion();
  private readonly upperRest = new Quaternion();
  private readonly forearmRest = new Quaternion();
  private readonly forward = new Vector3(0, 0, 1);
  private readonly velocity = new Vector3();
  private readonly finger = new Vector3();
  private readonly lift = new Vector3();
  private readonly palm = new Vector3();
  private readonly across = new Vector3();
  private readonly localAcross = new Vector3();
  private readonly m0 = new Matrix4();
  private readonly m1 = new Matrix4();

  constructor(rig: HumanRig, config: TouchConfig) {
    this.config = config;
    rig.root.updateWorldMatrix(true, true);
    const add = (side: Side, bones: ArmBones | undefined, sign: number): void => {
      if (bones) this.hands[side] = createHand(side, bones, sign);
    };
    add('left', rig.leftArm, -1);
    add('right', rig.rightArm, 1);
  }

  /** Phase of the gesture of a hand. */
  phase(side: Side): TouchPhase {
    return this.hands[side]?.phase ?? 'none';
  }

  /** How much the gesture overrides the swing of each hand (0–1): so that the arm opens the fingers. */
  weight(side: Side): number {
    return this.hands[side]?.weight ?? 0;
  }

  /** Forgets the gestures in progress (the hand snaps back to its swing). */
  reset(): void {
    for (const hand of Object.values(this.hands)) {
      hand.phase = 'none';
      hand.weight = 0;
    }
    this.cooldown = 0;
    this.scanTimer = 0;
    this.recent.clear();
    this.hasLastPoint = false;
    this.touched.length = 0;
  }

  /** Shifts the stored points (change of world origin). */
  shift(offset: Vector3): void {
    for (const hand of Object.values(this.hands)) {
      hand.point.add(offset);
      hand.wrist.add(offset);
      hand.anchor.add(offset);
    }
    this.lastPoint.add(offset);
  }

  /**
   * Touch `point` (world). Returns false if it can't: no arm, or the point is out of the hand's reach
   * (taking into account where the body is going, if it is walking).
   */
  touch(point: Vector3, motion: TouchMotion, detector: SurfaceDetector | null, options: TouchOptions = {}): boolean {
    const side = options.side ?? this.sideOf(point, motion.forward);
    const hand = this.hands[side];
    if (!hand || !motion.allowed) return false;
    const normal = this.c;
    if (options.normal) normal.copy(options.normal).normalize();
    else this.estimateNormal(hand, point, detector, normal);
    // ¿Llegará? Desde donde estará el hombro al terminar el gesto.
    this.predictShoulder(hand, motion, this.predicted);
    this.contactPose(hand, point, normal, this.predicted, this.a, this.q);
    if (this.a.distanceTo(this.predicted) > this.config.touchMaxReach * hand.armLength) return false;
    this.begin(hand, point, normal, options.hold ?? false, undefined, options.slide ?? this.slide);
    return true;
  }

  /** Withdraws the hand (or both). */
  release(side?: Side): void {
    for (const hand of Object.values(this.hands)) {
      if (side && hand.side !== side) continue;
      if (hand.phase === 'reach' || hand.phase === 'contact') this.startRelease(hand);
    }
  }

  /**
   * Advances the gestures and, in `auto` mode, looks for surfaces. Before moving the arms (the fingers open
   * with `weight`).
   */
  update(motion: TouchMotion, detector: SurfaceDetector | null): void {
    this.touched.length = 0;
    this.forward.copy(motion.forward);
    this.velocity.copy(motion.velocity).setY(0);
    const c = this.config;
    const dt = motion.dt;
    this.dt = dt;
    this.cooldown = Math.max(this.cooldown - dt, 0);
    for (const hand of Object.values(this.hands)) {
      if (hand.phase === 'none') continue;
      hand.time += dt;
      worldPosition(hand.bones.upperArm, this.shoulder);
      // Acercándose, cuenta dónde estará el hombro al tocar.
      if (hand.phase === 'reach') this.shoulderAtContact(hand, this.shoulder);
      const away = hand.wrist.distanceTo(this.shoulder) / hand.armLength;
      if (!motion.allowed && hand.phase !== 'release') this.startRelease(hand);
      if (hand.phase === 'reach') {
        const k = Math.min(hand.time / c.touchReachTime, 1);
        hand.weight = hand.from + (1 - hand.from) * minimumJerk(k);
        // Ya no llega (el cuerpo cambió de rumbo o se paró antes): vuelve.
        if (k > 0.5 && away > 1) this.startRelease(hand);
        else if (k >= 1 && away > MAX_STRETCH) this.startRelease(hand);
        else if (k >= 1) {
          hand.phase = 'contact';
          hand.time = 0;
          hand.weight = 1;
          hand.slideNormal.copy(hand.normal);
          hand.slideRawNormal.copy(hand.normal);
          this.touched.push({ side: hand.side, point: hand.point });
        }
      } else if (hand.phase === 'contact') {
        // Caminando, la mano se desliza por la superficie mientras siga al lado; si se acaba (una columna ya
        // pasada, el final de la pared o de la baranda), suelta.
        const sliding = hand.slide && detector !== null && !motion.still;
        if (sliding && !this.slideAlong(hand, motion, detector, dt)) this.startRelease(hand);
        else {
          if (!sliding) hand.slideSpeed = 0;
          // (Deslizando, la mano va al lado del hombro: solo queda atrás si la superficie se le escapa, como una
          // columna ya pasada.)
          const behind = this.a.subVectors(hand.point, this.shoulder).dot(motion.forward) < -RELEASE_BEHIND * hand.armLength;
          const done = !hand.hold && hand.time >= c.touchHoldTime && (motion.still || behind);
          // Más estirado solo mientras la mano va al lado del hombro: de una columna que queda atrás (la mano
          // ya no la puede seguir) se suelta antes, sin llegar al brazo recto, donde el codo cambia deprisa.
          // (Y al principio del contacto: el vaivén de la marcha estira el brazo un poco más de lo previsto, y
          // soltar enseguida parecía un rebote.)
          const beside = sliding && (!behind || hand.time < c.touchHoldTime);
          if (done || away > (beside ? MAX_SLIDE_STRETCH : MAX_STRETCH)) this.startRelease(hand);
        }
      }
      if (hand.phase === 'release') {
        const k = Math.min(hand.time / c.touchReleaseTime, 1);
        // De la velocidad que llevaba la mano (quieta, o deslizándose) a la del cuerpo.
        this.a.lerpVectors(hand.releaseVelocity, this.velocity, smoothstep(k / RELEASE_FOLLOW));
        hand.anchor.addScaledVector(this.a, dt);
        hand.weight = hand.from * (1 - minimumJerk(k));
        if (k >= 1) {
          hand.phase = 'none';
          hand.weight = 0;
          hand.hasActual = false;
          if (!hand.hold) this.cooldown = c.touchCooldown;
        }
      }
    }
    if (this.auto && detector) {
      this.scanTimer -= dt;
      if (this.scanTimer <= 0) {
        this.scanTimer = SCAN_INTERVAL;
        this.scan(motion, detector);
      }
    }
  }

  /** Brings each active hand towards its surface (IK). After the arms and before the twist. */
  apply(): void {
    for (const hand of Object.values(this.hands)) {
      if (hand.phase === 'none' || hand.weight <= 0) continue;
      const { upperArm, forearm, hand: handBone } = hand.bones;
      const w = hand.weight;
      worldPosition(upperArm, this.shoulder);
      worldPosition(forearm, this.elbow);
      worldPosition(handBone, this.swingWrist);
      const hinge = this.elbowHinge(hand);

      // Muñeca: del balanceo a la superficie (o, al soltar, de vuelta), con el recorrido algo curvo:
      // hacia fuera del hombro, en la dirección que tenía al empezar (si no, podía cambiar de lado).
      const end = hand.phase === 'release' ? hand.anchor : hand.wrist;
      const line = this.a.subVectors(end, this.swingWrist);
      const length = line.length();
      if (!hand.bulgeSet && length > 1e-6) {
        hand.bulge.lerpVectors(this.swingWrist, end, 0.5).sub(this.shoulder);
        hand.bulge.addScaledVector(line, -hand.bulge.dot(line) / (length * length));
        if (hand.bulge.lengthSq() > 1e-10) hand.bulge.normalize();
        else hand.bulge.set(0, 0, 0);
        hand.bulgeSet = true;
      }
      this.target.lerpVectors(this.swingWrist, end, w).addScaledVector(hand.bulge, PATH_BULGE * length * Math.sin(Math.PI * w));
      // Codo: hacia donde ya está doblado (w = 0, el IK no cambia nada) → hacia abajo y atrás con la mano
      // apoyada. Cada dirección, perpendicular a su brazo: un punto fijo "abajo" quedaba casi sobre la línea
      // hombro–mano con el brazo colgando y el plano del codo giraba de golpe.
      const swingBend = perpendicular(this.swingBend.subVectors(this.elbow, this.shoulder), this.c.subVectors(this.swingWrist, this.shoulder));
      // Mano: respecto al antebrazo (como mueve la muñeca), de la del balanceo a la de apoyarse.
      //  - Acercándose: la que tendrá con el brazo ya en la superficie (un IK aparte). En world, o respecto
      //    al antebrazo aún colgando, podían separarlas casi 180° (palma hacia el muslo → hacia la pared) y
      //    el camino corto saltaba de lado.
      //  - Apoyada: la que la deja quieta en la superficie con el antebrazo de verdad.
      //  - Al soltar: de quieta en la superficie pasa poco a poco a ir con el antebrazo como estaba al
      //    soltar (con el hombro ya pasado, la de apoyarse se alejaría hasta dar la vuelta).
      if (hand.phase === 'reach') {
        const contactWrist = this.softened(hand, hand.wrist, this.contactWrist);
        const contactAxis = this.c.subVectors(contactWrist, this.shoulder);
        const contactBend = this.contactBend(hand, contactAxis, this.transport(swingBend, this.swingWrist, this.shoulder, contactAxis, this.bendNow), this.pole);
        const contactPole = this.contactPole.copy(this.shoulder).addScaledVector(contactAxis, 0.5).addScaledVector(contactBend, hand.armLength);
        this.upperRest.copy(upperArm.quaternion);
        this.forearmRest.copy(forearm.quaternion);
        this.ik.solve({ rootBone: upperArm, middleBone: forearm, endBone: handBone, target: contactWrist, poleTarget: contactPole, preserveEndRotation: false, hingeAxis: hinge });
        worldQuaternion(handBone.parent!, this.contactLocal).invert().multiply(hand.rotation);
        upperArm.quaternion.copy(this.upperRest);
        forearm.quaternion.copy(this.forearmRest);
      }
      // Sin llegar a estirar el brazo del todo: el hombro aún no está donde estará al tocar y el objetivo
      // puede quedar lejos; con el brazo recto, el codo cambia muy deprisa con la distancia y daba tirones.
      // El brazo colgando ya va casi recto: la saturación empieza en su extensión (con w = 0 no cambia
      // nada) y baja con el gesto.
      const toTarget = this.c.subVectors(this.target, this.shoulder);
      const distance = toTarget.length();
      const swingReach = this.a.subVectors(this.swingWrist, this.shoulder).length();
      // Apoyada (o soltando) la mano no se separa de la superficie hasta que se suelta (MAX_STRETCH).
      const knee = hand.phase === 'reach' ? SOFT_REACH_KNEE : hand.slide ? MAX_SLIDE_STRETCH : MAX_STRETCH;
      if (distance > 1e-9) toTarget.multiplyScalar(softReach(distance, swingReach, w, hand.armLength, knee) / distance);
      this.target.copy(this.shoulder).add(toTarget);
      // Codo, entre el del balanceo y el de apoyarse, los dos perpendiculares al brazo de ahora: con el brazo
      // aún colgando, el de apoyarse (abajo y atrás) es "atrás", como el del balanceo, y no cruza de lado.
      const now = this.transport(swingBend, this.swingWrist, this.shoulder, toTarget, this.bendNow);
      const toward = this.contactBend(hand, toTarget, now, this.bendContact);
      this.pole.lerpVectors(now, toward, w);
      if (this.pole.lengthSq() < 1e-8) this.pole.copy(toward);
      this.pole.normalize().multiplyScalar(hand.armLength).add(this.shoulder).addScaledVector(toTarget, 0.5);
      this.ik.solve({ rootBone: upperArm, middleBone: forearm, endBone: handBone, target: this.target, poleTarget: this.pole, preserveEndRotation: false, hingeAxis: hinge });
      if (hand.phase !== 'reach') {
        // La que deja la mano quieta en la superficie con este antebrazo.
        const parent = worldQuaternion(handBone.parent!, this.q);
        this.contactLocal.copy(parent).invert().multiply(hand.rotation);
        if (hand.phase === 'release') {
          if (!hand.releaseLocalSet) {
            hand.releaseLocal.copy(this.contactLocal);
            hand.releaseLocalSet = true;
          }
          // En world: de quieta (rotation) a ir con el antebrazo (parent · releaseLocal).
          const follow = smoothstep(hand.time / (RELEASE_FOLLOW * this.config.touchReleaseTime));
          this.qFollow.copy(parent).multiply(hand.releaseLocal);
          this.qFollow.slerpQuaternions(hand.rotation, this.qFollow, follow);
          this.contactLocal.copy(parent).invert().multiply(this.qFollow);
        }
      }
      // Por el mismo lado durante toda la fase: si la del balanceo y la de apoyarse quedan casi opuestas, el
      // camino corto cambiaba de lado de un frame a otro y la mano daba la vuelta.
      // (Con el signo de cada cuaternión continuo de un frame a otro: q y −q son el mismo giro y, sacados de
      // matrices, pueden cambiar de signo.)
      if (!hand.pathSet) {
        hand.swingQ.copy(handBone.quaternion);
        hand.contactQ.copy(this.contactLocal);
        hand.pathSign = hand.swingQ.dot(hand.contactQ) < 0 ? -1 : 1;
        hand.pathSet = true;
      }
      continueSign(hand.swingQ, handBone.quaternion);
      continueSign(hand.contactQ, this.contactLocal);
      handBone.quaternion.copy(hand.swingQ);
      slerpAlong(handBone.quaternion, hand.contactQ, w, hand.pathSign);
      updateSubtree(upperArm);
      worldPosition(handBone, this.a);
      if (hand.hasActual && this.dt > 0) {
        this.b.subVectors(this.a, hand.actualWrist).divideScalar(this.dt);
        hand.actualVelocity.lerp(this.b, 1 - Math.exp(-this.dt / ACTUAL_VELOCITY_TIME));
      } else hand.actualVelocity.set(0, 0, 0);
      hand.actualWrist.copy(this.a);
      hand.hasActual = true;
    }
  }

  // ---------- Búsqueda ----------

  private scan(motion: TouchMotion, detector: SurfaceDetector): void {
    const best = this.candidate;
    best.score = Infinity;
    this.seenNow.clear();
    const known = (): boolean => {
      const object = this.hit.object;
      if (object === undefined || !this.recent.has(object)) return false;
      this.seenNow.add(object);
      return true;
    };
    for (const hand of Object.values(this.hands)) {
      const arm = hand.armLength;
      this.predictShoulder(hand, motion, this.predicted);
      this.outward(hand, motion.forward, this.out);
      const consider = (normal: Vector3): void => {
        if (known() || hand.phase !== 'none') return;
        // Caminando, lo que queda al lado: no la cara que tiene de frente (el extremo de una pared).
        if (!motion.still && normal.dot(motion.forward) < -FACING) return;
        if (this.hit.object === undefined && this.hasLastPoint && this.hit.point.distanceTo(this.lastPoint) < 2 * arm) return;
        this.contactPose(hand, this.hit.point, normal, this.predicted, this.a, this.q);
        const reach = this.a.distanceTo(this.predicted) / arm;
        if (reach > this.config.touchMaxReach || reach < MIN_REACH) return;
        // Y que pueda quedarse apoyada el tiempo mínimo antes de tener que soltar por estirar el brazo.
        this.later.set(motion.velocity.x, 0, motion.velocity.z).multiplyScalar(this.config.touchHoldTime).add(this.predicted);
        if (this.a.distanceTo(this.later) / arm > MAX_STRETCH) return;
        const lead = this.b.subVectors(this.hit.point, this.predicted).dot(motion.forward) / arm;
        const score = Math.abs(reach - PREFERRED_REACH) + 0.5 * Math.abs(lead - PREFERRED_LEAD);
        if (score < best.score) {
          best.score = score;
          best.point.copy(this.hit.point);
          best.normal.copy(normal);
          best.object = this.hit.object;
          best.side = hand.side;
        }
      };
      // Paredes y columnas: rayos horizontales algo por debajo del hombro, de hacia fuera a casi delante.
      this.origin.copy(this.predicted).addScaledVector(UP, -SEARCH_DROP * arm);
      for (const angle of SEARCH_ANGLES) {
        this.dir.copy(this.out).multiplyScalar(Math.cos(angle)).addScaledVector(motion.forward, Math.sin(angle));
        if (!detector.cast(this.origin, this.dir, this.config.touchMaxReach * arm, this.hit)) continue;
        if (Math.abs(this.hit.normal.y) < 0.7 && this.hit.normal.dot(this.dir) < -0.3) consider(this.hit.normal);
        else known();
      }
      // Barandas: rayos hacia abajo al lado, desde la altura del hombro; su parte de arriba, plana.
      for (const outside of RAIL_OUT) {
        for (const ahead of RAIL_AHEAD) {
          this.origin.copy(this.predicted).addScaledVector(this.out, outside * arm).addScaledVector(motion.forward, ahead * arm);
          if (!detector.cast(this.origin, this.b.set(0, -1, 0), arm, this.hit)) continue;
          if (this.hit.normal.y > 0.8 && this.hit.distance > 0.2 * arm) consider(this.c.set(0, 1, 0));
          else known();
        }
      }
    }
    // Los tocados que ya no están cerca se podrán volver a tocar. Con margen: un rayo puede perder una
    // baranda estrecha por el vaivén del cuerpo.
    for (const [object, unseen] of this.recent) {
      if (this.seenNow.has(object)) this.recent.set(object, 0);
      else if (unseen + SCAN_INTERVAL > FORGET_TIME) this.recent.delete(object);
      else this.recent.set(object, unseen + SCAN_INTERVAL);
    }
    if (this.cooldown > 0 || !motion.allowed || best.score === Infinity) return;
    const hand = this.hands[best.side]!;
    this.begin(hand, best.point, best.normal, false, best.object);
    if (best.object !== undefined) this.recent.set(best.object, 0);
    this.lastPoint.copy(best.point);
    this.hasLastPoint = true;
  }

  // ---------- Geometría ----------

  private begin(hand: Hand, point: Vector3, normal: Vector3, hold: boolean, object: unknown, slide = this.slide): void {
    hand.point.copy(point);
    hand.normal.copy(normal);
    hand.hold = hold;
    hand.slide = slide;
    hand.slideSpeed = 0;
    hand.slideDistance = 0;
    hand.slideVelocity.set(0, 0, 0);
    hand.object = object;
    hand.from = hand.weight;
    hand.time = 0;
    hand.phase = 'reach';
    hand.bulgeSet = false;
    hand.pathSet = false;
    this.chooseHandPose(hand, this.shoulderAtContact(hand, this.predicted));
  }

  /**
   * Where the fingers point on the surface: the palm has to face it, but the fingers can point up, forward,
   * down… It tries several directions with the arm already on the surface (IK) and keeps the one that
   * rotates the hand least relative to how it is held now: little forearm twist (pronation, ±90° at most)
   * and little wrist flexion. With the fingers always pointing up, touching a wall to the side required
   * rotating the palm ~180° relative to the forearm (and the hand flipped over).
   */
  private chooseHandPose(hand: Hand, shoulder: Vector3): void {
    const { upperArm, forearm, hand: handBone } = hand.bones;
    const n = hand.normal;
    const e1 = this.e1.copy(UP).addScaledVector(n, -n.y);
    if (e1.lengthSq() < 1e-6) e1.copy(this.forward).addScaledVector(n, -this.forward.dot(n));
    e1.normalize();
    const e2 = this.e2.crossVectors(n, e1).normalize();
    this.upperRest.copy(upperArm.quaternion);
    this.forearmRest.copy(forearm.quaternion);
    this.swingLocal.copy(handBone.quaternion);
    // Eje del antebrazo visto desde la mano (para separar la torsión del resto).
    this.axisLocal.copy(handBone.position).normalize().applyQuaternion(this.qInverse.copy(this.swingLocal).invert());
    const now = worldPosition(upperArm, this.shoulderNow);
    this.outward(hand, this.forward, this.out);
    const hinge = this.elbowHinge(hand);
    const swingBend = perpendicular(worldPosition(forearm, this.swingBend).sub(now), worldPosition(handBone, this.swingWrist).sub(now));
    this.swingWrist.add(now);
    let best = Infinity;
    for (let i = 0; i < FINGER_CANDIDATES; i++) {
      const angle = (2 * Math.PI * i) / FINGER_CANDIDATES;
      this.fingerTry.copy(e1).multiplyScalar(Math.cos(angle)).addScaledVector(e2, Math.sin(angle));
      this.contactPose(hand, hand.point, n, shoulder, this.wristTry, this.rotationTry, this.fingerTry);
      // El brazo como quedará, desde el hombro de ahora (mismo vector hombro → muñeca).
      this.target.copy(this.wristTry).sub(shoulder).add(now);
      const axis = this.c.subVectors(this.target, now);
      const bend = this.contactBend(hand, axis, this.transport(swingBend, this.swingWrist, now, axis, this.bendNow), this.pole);
      this.contactPole.copy(now).addScaledVector(this.c, 0.5).addScaledVector(bend, hand.armLength);
      upperArm.quaternion.copy(this.upperRest);
      forearm.quaternion.copy(this.forearmRest);
      this.ik.solve({ rootBone: upperArm, middleBone: forearm, endBone: handBone, target: this.target, poleTarget: this.contactPole, preserveEndRotation: false, hingeAxis: hinge });
      // Giro de la mano respecto al antebrazo, desde el de ahora: torsión sobre su eje + el resto.
      const turn = worldQuaternion(handBone.parent!, this.q).invert().multiply(this.rotationTry).premultiply(this.qInverse);
      if (turn.w < 0) turn.set(-turn.x, -turn.y, -turn.z, -turn.w);
      const along = turn.x * this.axisLocal.x + turn.y * this.axisLocal.y + turn.z * this.axisLocal.z;
      const twist = 2 * Math.atan2(along, turn.w);
      const twistLength = Math.hypot(along, turn.w);
      // Resto (flexión y desviación de la muñeca): turn · torsión⁻¹, con torsión = (eje·along, w)/|·|.
      const restW = (turn.w * turn.w + along * along) / twistLength;
      const flex = 2 * Math.acos(Math.min(1, Math.abs(restW)));
      // Y que llegue: según hacia dónde apunten los dedos, la muñeca queda más cerca o más lejos del hombro
      // (hasta dos palmas); pasarse del alcance pesa más que cualquier giro de la mano.
      const over = Math.max(this.wristTry.distanceTo(shoulder) / hand.armLength - this.config.touchMaxReach, 0);
      const cost = twist * twist + flex * flex + (over > 0 ? REACH_COST + over : 0);
      if (cost < best) {
        best = cost;
        hand.wrist.copy(this.wristTry);
        hand.rotation.copy(this.rotationTry);
      }
    }
    upperArm.quaternion.copy(this.upperRest);
    forearm.quaternion.copy(this.forearmRest);
    updateSubtree(upperArm);
  }

  /**
   * Slides the resting hand along the surface, in the direction of travel: a (critical) spring carries the
   * point towards the side of the shoulder (somewhat ahead), only along the surface (the bobbing of the
   * body doesn't move it sideways or up and down), and a short ray sticks it back onto it. It starts still
   * (it has just touched) and accelerates until it moves with the body, beside the shoulder. Returns false
   * if the surface ended: the ray doesn't find it or hits a corner.
   */
  private slideAlong(hand: Hand, motion: TouchMotion, detector: SurfaceDetector, dt: number): boolean {
    const arm = hand.armLength;
    const n = hand.slideNormal;
    // Dirección del deslizamiento: la de la marcha sobre la superficie.
    const along = this.slideTangent.copy(motion.forward).addScaledVector(n, -motion.forward.dot(n));
    if (along.lengthSq() < 1e-4) return true; // camina hacia la superficie: no hay hacia dónde deslizar
    along.normalize();
    // Muelle crítico hacia el punto de reposo, que se mueve con el cuerpo: con su velocidad en el
    // amortiguador, la mano no se queda atrás (con un muelle simple, ~25 cm, y en una baranda baja eso
    // estiraba el brazo).
    const w = 2 * Math.PI * SLIDE_FREQUENCY;
    const error = this.a.copy(this.shoulder).addScaledVector(motion.forward, SLIDE_LEAD * arm).sub(hand.point).dot(along);
    // (Entra poco a poco: de golpe, al tocar, la mano arrancaba con un tirón.)
    const bodySpeed = (motion.velocity.x * along.x + motion.velocity.z * along.z) * smoothstep(hand.time / SLIDE_START);
    // Nunca hacia atrás: si tocó por delante del hombro, espera a que el cuerpo la alcance (si no, en el
    // extremo de una pared se salía por el borde).
    hand.slideSpeed = Math.max(hand.slideSpeed + (w * w * error + 2 * w * (bodySpeed - hand.slideSpeed)) * dt, 0);
    this.origin.copy(hand.point).addScaledVector(along, hand.slideSpeed * dt).addScaledVector(n, SLIDE_PROBE * arm);
    // En una pared, la mano baja poco a poco a una altura relajada (toca a la altura del pecho; apoyada
    // mientras camina, con el brazo a la altura del hombro parecía un ala). Cuando ya ha deslizado algo: en
    // una columna deja de deslizar antes (muy curva) y la mano no se mueve.
    if (Math.abs(n.y) < 0.7 && hand.slideDistance > SLIDE_DROP_AFTER * arm) {
      const drop = this.shoulder.y - SLIDE_DROP * arm - hand.point.y;
      this.origin.y += drop * (1 - Math.exp(-dt / SLIDE_DROP_TIME));
    }
    if (!detector.cast(this.origin, this.b.copy(n).negate(), 2 * SLIDE_PROBE * arm, this.hit)) return false;
    // Una esquina: la normal gira de golpe respecto a la del rayo anterior (sin suavizar: en una columna de
    // caras planas, deprisa, la suavizada se quedaba atrás y parecía una esquina).
    if (this.hit.normal.dot(hand.slideRawNormal) < SLIDE_MIN_NORMAL) return false;
    // Muy curva (una columna): no se desliza, se toca y se suelta al pasar. Rodeándola, la mano no podía seguir
    // al cuerpo y el brazo se estiraba de lado hasta soltar de golpe.
    const moved = this.hit.point.distanceTo(hand.point);
    if (moved > 1e-3 * arm && this.hit.normal.angleTo(hand.slideRawNormal) > (moved / arm) * SLIDE_MAX_BEND) {
      hand.slide = false;
      hand.slideSpeed = 0;
      hand.slideVelocity.set(0, 0, 0);
      return true;
    }
    hand.slideRawNormal.copy(this.hit.normal);
    // Normal suavizada (en una columna de caras planas cambia a saltos) y la mano girada con ella.
    const k = 1 - Math.exp(-dt / SLIDE_NORMAL_TIME);
    this.b.copy(n).lerp(this.hit.normal, k).normalize();
    hand.rotation.premultiply(this.q.setFromUnitVectors(n, this.b));
    n.copy(this.b);
    hand.normal.copy(n);
    // Velocidad real del punto (para soltar sin tirón), suavizada: en una columna de caras planas avanza a
    // saltos, y la del muelle no sirve (al volver a pegarla a la superficie apenas avanza).
    this.c.subVectors(this.hit.point, hand.point).divideScalar(Math.max(dt, 1e-6));
    hand.slideVelocity.lerp(this.c, 1 - Math.exp(-dt / SLIDE_VELOCITY_TIME));
    hand.slideDistance += this.hit.point.distanceTo(hand.point);
    hand.point.copy(this.hit.point);
    const finger = this.finger.copy(hand.fingerLocal).applyQuaternion(hand.rotation);
    hand.wrist.copy(hand.point).addScaledVector(n, hand.palmThickness).addScaledVector(finger, -hand.palmLength);
    return true;
  }

  private startRelease(hand: Hand): void {
    hand.phase = 'release';
    hand.releaseLocalSet = false;
    hand.anchor.copy(hand.hasActual ? hand.actualWrist : hand.wrist);
    hand.releaseVelocity.copy(hand.hasActual ? hand.actualVelocity : hand.slideVelocity);
    hand.slideVelocity.set(0, 0, 0);
    hand.slideSpeed = 0;
    hand.bulgeSet = false;
    hand.pathSet = false;
    hand.from = hand.weight;
    hand.time = 0;
  }

  /**
   * Wrist and orientation of the hand resting on `point` (palm towards the surface, center of the palm on
   * the point). The fingers, towards `fingers` (in the plane of the surface) or, without it, like the
   * direction shoulder (at `shoulder`) → point on the surface, a little upwards (to measure the reach).
   */
  private contactPose(hand: Hand, point: Vector3, normal: Vector3, shoulder: Vector3, outWrist: Vector3, outRotation: Quaternion, fingers?: Vector3): void {
    const finger = this.finger;
    if (fingers) finger.copy(fingers);
    else {
      finger.subVectors(point, shoulder).normalize();
      finger.addScaledVector(normal, -finger.dot(normal));
      const lift = this.lift.copy(UP).addScaledVector(normal, -normal.y);
      finger.addScaledVector(lift, FINGER_LIFT);
      if (finger.lengthSq() < 1e-6) finger.copy(lift).addScaledVector(normal, -lift.dot(normal));
      if (finger.lengthSq() < 1e-6) finger.set(normal.y, -normal.x, 0).addScaledVector(normal, -finger.dot(normal));
      finger.normalize();
    }
    outWrist.copy(point).addScaledVector(normal, hand.palmThickness).addScaledVector(finger, -hand.palmLength);
    // Orientación: (dedos, palma) del espacio de la mano → (finger, −normal).
    const palm = this.palm.copy(normal).negate();
    const side = this.across.crossVectors(finger, palm);
    this.m1.makeBasis(finger, palm, side);
    const localSide = this.localAcross.crossVectors(hand.fingerLocal, hand.palmLocal);
    this.m0.makeBasis(hand.fingerLocal, hand.palmLocal, localSide).transpose();
    outRotation.setFromRotationMatrix(this.m1.multiply(this.m0));
  }

  /**
   * Normal of the surface at `point`: with a ray from the shoulder towards it or, without a detector,
   * vertical towards the shoulder.
   */
  private estimateNormal(hand: Hand, point: Vector3, detector: SurfaceDetector | null, out: Vector3): void {
    worldPosition(hand.bones.upperArm, this.shoulder);
    const toward = this.a.subVectors(point, this.shoulder);
    const distance = toward.length();
    if (detector && distance > 1e-6) {
      toward.divideScalar(distance);
      if (detector.cast(this.shoulder, toward, distance + 0.1 * hand.armLength, this.hit) && this.hit.point.distanceTo(point) < 0.1 * hand.armLength) {
        out.copy(this.hit.normal);
        return;
      }
    }
    out.subVectors(this.shoulder, point).setY(0);
    if (out.lengthSq() < 1e-10) out.set(0, 1, 0);
    out.normalize();
  }

  /**
   * Where the shoulder will be when the hand has finished reaching (in `reach`), if the body carries on the
   * same.
   */
  private shoulderAtContact(hand: Hand, out: Vector3): Vector3 {
    worldPosition(hand.bones.upperArm, out);
    return out.addScaledVector(this.velocity, Math.max(this.config.touchReachTime - hand.time, 0));
  }

  /** Where the shoulder will be when the gesture ends, if the body keeps the same velocity. */
  private predictShoulder(hand: Hand, motion: TouchMotion, out: Vector3): Vector3 {
    worldPosition(hand.bones.upperArm, out);
    return out.addScaledVector(this.a.copy(motion.velocity).setY(0), this.config.touchReachTime);
  }

  /** Hand on the side of the point. */
  private sideOf(point: Vector3, forward: Vector3): Side {
    const right = this.a.crossVectors(forward, UP);
    const hand = this.hands.right ?? this.hands.left;
    if (!hand) return 'right';
    worldPosition(hand.bones.upperArm, this.b);
    const center = this.hands.left && this.hands.right ? worldPosition(this.hands.left.bones.upperArm, this.c).add(this.b).multiplyScalar(0.5) : this.b;
    return this.a.subVectors(point, center).dot(right) >= 0 ? (this.hands.right ? 'right' : 'left') : this.hands.left ? 'left' : 'right';
  }

  /**
   * Axis of the elbow hinge in the upper arm's local space, as the swing bends it (it always leaves it a
   * little bent). Without it, IK derived it from the point the elbow aims at and, if that wasn't in the
   * plane of the arm, the forearm twist changed from one frame to the next. Undefined if it is straight.
   */
  private elbowHinge(hand: Hand): Vector3 | undefined {
    const { upperArm, forearm, hand: handBone } = hand.bones;
    worldPosition(upperArm, this.hingeA);
    const upper = worldPosition(forearm, this.hingeB).sub(this.hingeA);
    const toWrist = worldPosition(handBone, this.hingeC).sub(this.hingeA);
    const axis = this.hingeAxis.crossVectors(toWrist, upper);
    if (axis.lengthSq() < 1e-6 * upper.lengthSq() * toWrist.lengthSq()) return undefined;
    return axis.normalize().applyQuaternion(worldQuaternion(upperArm, this.hingeQ).invert());
  }

  /**
   * Where the elbow points with the hand resting (unit, perpendicular to `axis` = shoulder → wrist): down
   * and back, keeping part of the direction it already bends towards. If the hand ends up low and behind (a
   * railing already passed), "down and back" runs almost along the arm and what is left pointed forward: the
   * blend with the swing's elbow (backward) went through zero and the elbow flipped abruptly.
   */
  private contactBend(hand: Hand, axis: Vector3, swingBend: Vector3, out: Vector3): Vector3 {
    this.outward(hand, this.forward, this.out);
    out.copy(this.forward).multiplyScalar(-POLE_BACK).addScaledVector(UP, -POLE_DOWN).addScaledVector(this.out, POLE_OUT);
    const length2 = Math.max(axis.lengthSq(), 1e-12);
    out.addScaledVector(axis, -out.dot(axis) / length2);
    out.addScaledVector(swingBend, SWING_BEND_KEEP).addScaledVector(axis, (-SWING_BEND_KEEP * swingBend.dot(axis)) / length2);
    if (out.lengthSq() < 1e-10) return perpendicular(out.copy(swingBend), axis);
    return out.normalize();
  }

  /** `wrist` with the distance to the shoulder saturated like that of the resting arm (w = 1). */
  private softened(hand: Hand, wrist: Vector3, out: Vector3): Vector3 {
    const reach = this.a.subVectors(wrist, this.shoulder).length();
    if (reach < 1e-9) return out.copy(wrist);
    return out.copy(this.shoulder).addScaledVector(this.a, softReach(reach, 0, 1, hand.armLength) / reach);
  }

  /**
   * The swing's elbow direction (`bend`, perpendicular to shoulder → `swingWrist`) carried with the arm to
   * `axis` by the shortest rotation: without twisting it about its axis.
   */
  private transport(bend: Vector3, swingWrist: Vector3, shoulder: Vector3, axis: Vector3, out: Vector3): Vector3 {
    this.axisFrom.subVectors(swingWrist, shoulder).normalize();
    this.axisTo.copy(axis).normalize();
    return perpendicular(out.copy(bend).applyQuaternion(this.qTransport.setFromUnitVectors(this.axisFrom, this.axisTo)), axis);
  }

  /** Outwards, on the side of the hand (horizontal). */
  private outward(hand: Hand, forward: Vector3, out: Vector3): Vector3 {
    return out.crossVectors(forward, UP).normalize().multiplyScalar(hand.sign);
  }
}

/** Hand at rest: lengths and axes of the palm (like HandFingers: left and right symmetric). */
function createHand(side: Side, bones: ArmBones, sign: number): Hand {
  const pos = (b: { getWorldPosition(v: Vector3): Vector3 }): Vector3 => b.getWorldPosition(new Vector3());
  const shoulder = pos(bones.upperArm);
  const elbow = pos(bones.forearm);
  const wrist = pos(bones.hand);
  const armLength = shoulder.distanceTo(elbow) + elbow.distanceTo(wrist);
  const fingers = bones.fingers ?? {};
  const bases = (['index', 'middle', 'ring', 'pinky'] as const).filter((n) => fingers[n]?.length).map((n) => pos(fingers[n]![0]));
  let along: Vector3;
  let palm: Vector3;
  let knuckles: number;
  if (bases.length >= 2) {
    const middle = fingers.middle?.length ? pos(fingers.middle[0]) : bases.reduce((a, b) => a.add(b), new Vector3()).divideScalar(bases.length);
    along = middle.clone().sub(wrist);
    knuckles = along.length();
    along.normalize();
    const lateral = bases[0].clone().sub(bases[bases.length - 1]);
    palm = sign > 0 ? new Vector3().crossVectors(lateral, along) : new Vector3().crossVectors(along, lateral);
  } else {
    // Sin dedos: la mano sigue al antebrazo y la palma mira hacia abajo en la pose de reposo (T o A).
    along = wrist.clone().sub(elbow).normalize();
    knuckles = 0.17 * armLength;
    palm = new Vector3(0, -1, 0).addScaledVector(along, along.y);
  }
  palm.addScaledVector(along, -palm.dot(along)).normalize();
  const inverse = bones.hand.getWorldQuaternion(new Quaternion()).invert();
  return {
    side,
    sign,
    bones,
    armLength,
    palmLength: 0.55 * knuckles,
    palmThickness: 0.025 * armLength,
    fingerLocal: along.applyQuaternion(inverse),
    palmLocal: palm.applyQuaternion(inverse),
    phase: 'none',
    weight: 0,
    from: 0,
    time: 0,
    hold: false,
    slide: false,
    slideSpeed: 0,
    slideDistance: 0,
    slideVelocity: new Vector3(),
    slideNormal: new Vector3(),
    slideRawNormal: new Vector3(),
    releaseVelocity: new Vector3(),
    actualWrist: new Vector3(),
    actualVelocity: new Vector3(),
    hasActual: false,
    object: undefined,
    point: new Vector3(),
    normal: new Vector3(),
    wrist: new Vector3(),
    rotation: new Quaternion(),
    releaseLocal: new Quaternion(),
    releaseLocalSet: false,
    anchor: new Vector3(),
    pathSign: 1,
    pathSet: false,
    swingQ: new Quaternion(),
    contactQ: new Quaternion(),
    bulge: new Vector3(),
    bulgeSet: false,
  };
}

/** `previous` ← `next`, with the sign that leaves it closest to `previous` (the same rotation). */
function continueSign(previous: Quaternion, next: Quaternion): void {
  const sign = previous.dot(next) < 0 ? -1 : 1;
  previous.set(next.x * sign, next.y * sign, next.z * sign, next.w * sign);
}

/**
 * `q` ← slerp(q, `target`·`sign`, `t`) without choosing the short path: with a fixed `sign`, the rotation
 * always goes the same way even if it exceeds 180°.
 */
function slerpAlong(q: Quaternion, target: Quaternion, t: number, sign: number): void {
  const bx = target.x * sign;
  const by = target.y * sign;
  const bz = target.z * sign;
  const bw = target.w * sign;
  const cos = q.x * bx + q.y * by + q.z * bz + q.w * bw;
  let a: number;
  let b: number;
  if (Math.abs(cos) > 1 - 1e-6) {
    a = 1 - t;
    b = t;
  } else {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    a = Math.sin((1 - t) * angle) / sin;
    b = Math.sin(t * angle) / sin;
  }
  q.set(q.x * a + bx * b, q.y * a + by * b, q.z * a + bz * b, q.w * a + bw * b).normalize();
}

/**
 * Shoulder → wrist distance for IK: unchanged up to a knee point (from the swing's extension, `swing`,
 * with w = 0, to `kneeFraction` of the arm with w = 1) and then it saturates (99 % at most).
 */
function softReach(distance: number, swing: number, w: number, arm: number, kneeFraction = SOFT_REACH_KNEE): number {
  const top = Math.max(SOFT_REACH_MAX * arm, swing);
  const knee = Math.min(swing, top) + (kneeFraction * arm - Math.min(swing, top)) * w;
  if (distance <= knee) return distance;
  const room = top - knee;
  if (room < 1e-9) return knee;
  return knee + room * Math.tanh((distance - knee) / room);
}

/**
 * Leaves in `v` its part perpendicular to `axis` (not unit), normalized; if it has none, the downward
 * one.
 */
function perpendicular(v: Vector3, axis: Vector3): Vector3 {
  const length2 = axis.lengthSq();
  if (length2 < 1e-12) return v.normalize();
  v.addScaledVector(axis, -v.dot(axis) / length2);
  if (v.lengthSq() < 1e-10) v.set(0, -1, 0).addScaledVector(axis, axis.y / length2);
  return v.normalize();
}

function smoothstep(x: number): number {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
}

/** Minimum jerk (0 → 1): bell-shaped speed, with no acceleration at the start or at the end. */
function minimumJerk(t: number): number {
  return t * t * t * (10 + t * (-15 + 6 * t));
}
