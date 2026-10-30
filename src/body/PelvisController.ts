import { Quaternion, Vector3 } from 'three';

import { createSpring, snapSpring, stepSpring } from '../core/spring.ts';
import { setWorldPositionNode, setWorldQuaternionNode, updateDown, updateSubtree, worldPosition, worldQuaternion } from '../core/pose.ts';
import type { HumanRig, Side } from '../rig/HumanRig.ts';

const UP = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;

export interface PelvisConfig {
  /** Maximum rotation of the pelvis towards the leading foot (degrees). */
  pelvisRotation: number;
  /** Maximum lateral drop of the pelvis on the side of the leg in the air (degrees). */
  pelvisObliquity: number;
  /** Forward tilt of the pelvis at walking speed (degrees). */
  pelvisTilt: number;
  /**
   * Tilt oscillation of the pelvis with each step at walking speed (degrees, ±): forward at each heel strike
   * and backward at mid-stance, twice per stride (±1.8° in the CMU captures).
   */
  pelvisTiltSwing: number;
  /** Front-to-back distance between the feet at which the maximum rotation is reached (m). */
  stepLength: number;
  /**
   * Normal walking speed (m/s; see `LocomotionConfig.walkSpeed`): the tilt of the pelvis reaches `pelvisTilt`
   * at this speed.
   */
  walkSpeed: number;
  /**
   * Natural frequency of the pelvis (Hz): how quickly its rotation and drop follow the steps. Lower = more
   * damped motion with more lag; very high = follows the feet instantly.
   */
  pelvisFrequency: number;
  /** Damping of the pelvis (1 = no overshoot; less = it overshoots a little and comes back, looser). */
  pelvisDamping: number;
}

/** Motion data that orients the pelvis. */
export interface PelvisMotion {
  /** Horizontal direction of travel (unit, world). */
  forward: Vector3;
  /** Fraction of the weight on each foot (sums to 1). */
  supportWeights: Record<Side, number>;
  /** Speed of the body (m/s). */
  speed: number;
  /** Maximum desired height of the hips relative to the standing height (m, ≤ 0). 0 by default. */
  targetHeight?: number;
  /**
   * Standing height of the hips relative to the rest height (m, ≥ 0): the rest height, or a little more if,
   * with the feet in their neutral position, the legs end up more vertical than at rest. 0 by default.
   */
  standHeight?: number;
  /** Additional forward tilt of the pelvis (rad), e.g. when crouching. */
  extraPitch?: number;
  /**
   * How much each leg must be able to reach its ankle (0–1). 1 for both by default.
   * 0 = that leg doesn't limit the height (e.g., in the air while running).
   */
  reachWeights?: Record<Side, number>;
  /**
   * Desired knee bend (rad) of each supporting leg: the height of the hips comes from the knees (they
   * cushion when taking the weight and straighten at mid-stance).
   */
  kneeBend?: Record<Side, number>;
  /**
   * How much each leg decides the height with its `kneeBend` (0–1, e.g. its share of the weight). 0 = it
   * doesn't decide it.
   */
  kneeWeights?: Record<Side, number>;
  /** Fraction of the leg length that is never exceeded (hard limit). `reachFactor` by default. */
  maxReach?: number;
  /**
   * How much the corner between the desired height and the limit of the legs is rounded (0–1; e.g. how
   * much it runs). 0 = exact minimum. Rounding lowers the hips a little near the corner.
   */
  limitRounding?: number;
  /**
   * Frame time (s): with it, the rotation and drop of the pelvis follow the steps with damping; without it,
   * instantly.
   */
  dt?: number;
  /**
   * Desired lateral drop (−1…1, positive = lowers the right side), e.g. a smooth wave with the step cycle.
   * By default, according to the weight distribution (left − right).
   */
  obliquity?: number;
  /**
   * Desired rotation (−1…1, positive = brings the right side forward), e.g. a wave with the cycle that peaks
   * at each heel strike. By default, according to which foot is ahead.
   */
  rotation?: number;
  /**
   * Desired tilt oscillation (−1…1, positive = forward), e.g. a wave with the cycle that peaks at each heel
   * strike. 0 by default.
   */
  tilt?: number;
  /**
   * Landing anticipation: where the ankle of each foot in the air will be when it lands (world) and how
   * much it is already taken into account (0–1). The hips start lowering in time for that leg to reach the
   * ground, instead of dropping abruptly in the last frames of the step.
   */
  landings?: Record<Side, Vector3>;
  landingWeights?: Record<Side, number>;
  /**
   * Ankle of each leg for the height of the hips (reach limit and knees; world), if not the one given: e.g.
   * a foot that can still raise its heel further (pushing off on stairs) only needs the hips within reach
   * of its highest ankle.
   */
  reachAnkles?: Record<Side, Vector3>;
}

/**
 * Procedural pelvis: position, height and orientation of the hips.
 *
 *  - Position: the horizontal shift it receives (weight distribution).
 *  - Orientation (about the character's axes, in world space):
 *      rotation  → turns towards the leading foot;
 *      drop      → lowers on the side of the leg that doesn't bear weight;
 *      forward tilt proportional to the speed, oscillating with each step.
 *  - Height: the desired one (`targetHeight`, 0 = standing: the rest height + `standHeight`), lowering just
 *    enough for the legs that must support to reach their ankles (`maxReach` or `reachFactor` of the leg
 *    length). If knees are given (`kneeBend`), the supporting legs also set the height at which their knee
 *    has that bend, blended according to `kneeWeights` (their share of the weight): the knee cushions and
 *    straightens as in real walking, instead of always being bent the same. Never above the standing
 *    height.
 *    When the limiting leg changes (in double support), the height would make a corner (the vertical
 *    velocity reverses in one frame): it is rounded with a smooth minimum, which never ends up above the
 *    exact minimum (IK still reaches both feet).
 */
export class PelvisController {
  /** Fraction of the leg length it is allowed to stretch (0–1). */
  reachFactor = 0.97;
  /** Vertical offset applied in the last update relative to the standing height (m, negative = down). */
  offset = 0;
  /**
   * Angles applied in the last update (rad): rotation, drop and forward tilt (`tilt`: the part of the
   * forward tilt that oscillates with the steps).
   */
  readonly angles = { yaw: 0, roll: 0, pitch: 0, tilt: 0 };

  private readonly rig: HumanRig;
  private readonly config: PelvisConfig;
  private readonly restLocal: Vector3;
  private readonly restRotation: Quaternion;
  private readonly legLength: Record<Side, number>;
  /** Largos de muslo (cadera → rodilla) y tibia (rodilla → tobillo) (m). */
  private readonly segments: Record<Side, { upper: number; lower: number }>;
  private readonly hip = new Vector3();
  private readonly tmp = new Vector3();
  private readonly right = new Vector3();
  private readonly q = new Quaternion();
  private readonly qAxis = new Quaternion();
  private readonly qWorld = new Quaternion();
  /** Rotation and drop of the pelvis: springs that chase what the steps ask for. */
  private readonly yawSpring = createSpring();
  private readonly rollSpring = createSpring();
  /**
   * Tilt oscillation with the steps: a spring so that it fades in and out smoothly (when stopping, when
   * jumping).
   */
  private readonly tiltSpring = createSpring();
  private springsReady = false;
  /**
   * Height (relative to rest) and vertical velocity of the hips in the previous frame, to smooth the rises.
   */
  private riseReady = false;
  private lastHeight = 0;
  private lastRiseSpeed = 0;

  constructor(rig: HumanRig, config: PelvisConfig) {
    this.rig = rig;
    this.config = config;
    this.restLocal = rig.hips.position.clone();
    this.restRotation = rig.hips.quaternion.clone();
    rig.root.updateWorldMatrix(true, true);
    const length = (side: Side): number => {
      const { thigh, shin, foot } = rig[side];
      const a = thigh.getWorldPosition(new Vector3());
      const b = shin.getWorldPosition(new Vector3());
      const c = foot.getWorldPosition(new Vector3());
      return a.distanceTo(b) + b.distanceTo(c);
    };
    this.legLength = { left: length('left'), right: length('right') };
    const segments = (side: Side): { upper: number; lower: number } => {
      const { thigh, shin, foot } = rig[side];
      const a = thigh.getWorldPosition(new Vector3());
      const b = shin.getWorldPosition(new Vector3());
      const c = foot.getWorldPosition(new Vector3());
      return { upper: a.distanceTo(b), lower: b.distanceTo(c) };
    };
    this.segments = { left: segments('left'), right: segments('right') };
  }

  /** Hip → ankle distance at the reach limit of a leg (m): its length × `maxReach`. */
  maxLegReach(side: Side, maxReach = this.reachFactor): number {
    return this.legLength[side] * maxReach;
  }

  /** Hip → ankle distance of a leg with the knee bent `bend` rad (0 = straight). */
  private reachWithKnee(side: Side, bend: number): number {
    const { upper, lower } = this.segments[side];
    return Math.sqrt(upper * upper + lower * lower + 2 * upper * lower * Math.cos(bend));
  }

  /** Forgets the damped motion (after a teleport or when returning to the rest pose). */
  forgetMotion(): void {
    this.springsReady = false;
    this.riseReady = false;
  }

  /**
   * Returns the hips to their rest pose (local). With `updateMatrices` false it doesn't recompute their
   * matrices (whoever moves the root or the hips afterwards will).
   */
  reset(updateMatrices = true): void {
    this.rig.hips.position.copy(this.restLocal);
    this.rig.hips.quaternion.copy(this.restRotation);
    if (updateMatrices) this.rig.hips.updateWorldMatrix(true, true);
    this.offset = 0;
    this.angles.yaw = 0;
    this.angles.roll = 0;
    this.angles.pitch = 0;
    this.angles.tilt = 0;
  }

  /**
   * The hips drop as much and as fast as the legs require, but rise following the requested height with a
   * critically damped spring: all the height limits are maxima, so rising a little more slowly never
   * breaks them, and it prevents them from jumping up (and stopping abruptly) when a straight leg stops
   * limiting at toe-off.
   */
  private smoothRise(height: number, dt: number | undefined): number {
    if (dt === undefined || !(dt > 0) || !this.riseReady) {
      this.riseReady = dt !== undefined && dt > 0;
      this.lastHeight = height;
      this.lastRiseSpeed = 0;
      return height;
    }
    const w = 2 * Math.PI * RISE_FREQUENCY;
    // Semi-implícito, en pasos cortos (w·h ≤ 0,5): estable con cualquier dt.
    const steps = Math.max(1, Math.ceil((dt * w) / 0.5));
    const h = dt / steps;
    let y = this.lastHeight;
    let v = this.lastRiseSpeed;
    for (let i = 0; i < steps; i++) {
      v += (w * w * (height - y) - 2 * w * v) * h;
      y += v * h;
    }
    // Nunca por encima de lo que permiten las piernas (si limitan, baja con ellas).
    if (y > height) {
      y = height;
      v = Math.min(v, (height - this.lastHeight) / dt);
    }
    this.lastHeight = y;
    this.lastRiseSpeed = v;
    return y;
  }

  /**
   * Places and orients the hips so that they reach the given ankles (world).
   * `shift` moves the hips horizontally (world); `motion` orients them.
   * Must be called with the character's root already placed (and with it the skeleton's matrices, with the
   * hips at rest: `reset` and then move the root) and before IK.
   */
  update(ankles: Record<Side, Vector3>, shift?: Vector3, motion?: PelvisMotion): void {
    // Desde la pose de reposo; sus matrices ya están al día (la raíz se movió después del reset).
    this.reset(false);
    const hips = this.rig.hips;
    // Solo se recalcula la matriz de las caderas (y la de cada muslo al leerlo); lo que cuelga, una
    // vez al final.
    if (shift) {
      worldPosition(hips, this.tmp).add(shift);
      setWorldPositionNode(hips, this.tmp);
    }
    if (motion) this.orient(ankles, motion);

    // Desde aquí, alturas respecto al reposo.
    const stand = Math.max(motion?.standHeight ?? 0, 0);
    const target = Math.min(motion?.targetHeight ?? 0, 0) + stand;
    // Anchura del redondeo entre los límites de las dos piernas: proporcional al tamaño y a
    // la velocidad (parado no hace falta: la altura no cambia de golpe y la pose no varía).
    const speedFactor = Math.min(Math.max((motion?.speed ?? 0) / this.config.walkSpeed, 0), 1);
    const smoothing = LEG_LIMIT_SMOOTHING * ((this.legLength.left + this.legLength.right) / 2) * speedFactor;
    const maxReach = motion?.maxReach ?? this.reachFactor;
    let legs = Number.POSITIVE_INFINITY;
    /**
     * What the legs that don't bear weight require (e.g. the one about to land), to round it off with the
     * knees.
     */
    let reaching = Number.POSITIVE_INFINITY;
    let kneeHeight = 0;
    let kneeWeight = 0;
    for (const side of ['left', 'right'] as const) {
      updateDown(hips, this.rig[side].thigh);
      worldPosition(this.rig[side].thigh, this.hip);
      // Para la altura, el tobillo más alto al que puede llegar ese pie (si no se da, el suyo).
      const ankle = motion?.reachAnkles?.[side] ?? ankles[side];
      const dh = Math.hypot(this.hip.x - ankle.x, this.hip.z - ankle.z);
      /** Vertical offset of the hips at which the ankle ends up at `reach` from the hip. */
      const heightFor = (reach: number): number => ankle.y + Math.sqrt(Math.max(reach * reach - dh * dh, 0)) - this.hip.y;

      const kw = motion?.kneeBend ? (motion.kneeWeights?.[side] ?? 0) : 0;
      if (kw > 0) {
        kneeHeight += kw * heightFor(Math.min(this.reachWithKnee(side, motion!.kneeBend![side]), this.legLength[side] * maxReach));
        kneeWeight += kw;
      }

      const weight = motion?.reachWeights?.[side] ?? 1;
      if (weight <= 0) continue;
      const limit = heightFor(this.legLength[side] * maxReach);
      // Peso 1: la pierna limita del todo; peso 0: no influye; entre medias, mezcla continua.
      const term = target + (limit - target) * weight;
      legs = legs === Number.POSITIVE_INFINITY ? term : smoothMin(legs, term, smoothing);
      const free = target + (limit - target) * weight * (1 - Math.min(kw, 1));
      reaching = reaching === Number.POSITIVE_INFINITY ? free : Math.min(reaching, free);
      const lw = motion?.landings ? (motion.landingWeights?.[side] ?? 0) : 0;
      if (lw > 0) {
        const landing = motion!.landings![side];
        const dhLanding = Math.hypot(this.hip.x - landing.x, this.hip.z - landing.z);
        const reachLanding = this.legLength[side] * maxReach;
        const limitLanding = landing.y + Math.sqrt(Math.max(reachLanding * reachLanding - dhLanding * dhLanding, 0)) - this.hip.y;
        reaching = Math.min(reaching, target + (limitLanding - target) * lw);
      }
    }
    // Rodillas: la altura que piden las piernas de apoyo; con peso total < 1 (p. ej. corriendo)
    // se mezcla con la deseada, así que solo manda del todo al caminar.
    const fromKnees = kneeWeight > 0 ? target + (kneeHeight / kneeWeight - target) * Math.min(kneeWeight, 1) : target;
    // La pierna que va a aterrizar baja las caderas para alcanzar el suelo: en vez de una esquina
    // (pasar de golpe de las rodillas a ese límite) se redondea, solo con las piernas sin peso
    // (con la de apoyo bajaría las caderas sin motivo). Los límites duros siguen mandando.
    // El redondeo solo actúa en la medida en que esas piernas exigen bajar de la altura deseada
    // (si no exigen nada, su valor neutro es `target` y no debe bajar las caderas).
    const demand = Number.isFinite(reaching) && smoothing > 0 ? Math.min(Math.max((target - reaching) / smoothing, 0), 1) : 0;
    const kneesAndReach = Number.isFinite(reaching) ? smoothMin(fromKnees, reaching, smoothing * Math.min(kneeWeight, 1) * demand) : fromKnees;
    // Entre la altura deseada y el límite de las piernas, el mismo redondeo que entre las dos piernas
    // (en la medida de `limitRounding`): con un mínimo exacto, cuando una pierna empieza o deja de
    // limitar (corriendo: al despegar estirada, al aterrizar) la velocidad vertical de las caderas
    // cambiaría de golpe.
    const rounding = smoothing * Math.min(Math.max(motion?.limitRounding ?? 0, 0), 1);
    // Y entre los límites de las piernas y la altura de las rodillas, también redondeado: al despegar,
    // la pierna de atrás (estirada) deja de limitar y las caderas pasaban de golpe de seguirla a
    // seguir a las rodillas.
    const dy = this.smoothRise(smoothMin(smoothMin(target, legs, rounding), kneesAndReach, smoothing * KNEE_LIMIT_ROUNDING), motion?.dt);
    this.offset = dy - stand;
    worldPosition(hips, this.tmp);
    this.tmp.y += dy;
    setWorldPositionNode(hips, this.tmp);
    updateSubtree(hips);
  }

  /**
   * Orientation of the pelvis. Character axes: F = forward, R = F × UP (right).
   *  - yaw  (about UP): a positive angle brings the right side forward.
   *  - roll (about F):  a positive angle lowers the right side.
   *  - pitch (about R): a negative angle tilts forward.
   */
  private orient(ankles: Record<Side, Vector3>, motion: PelvisMotion): void {
    const c = this.config;
    const F = motion.forward;
    const R = this.right.crossVectors(F, UP).normalize();

    const ahead = this.tmp.subVectors(ankles.right, ankles.left).dot(F); // > 0: pie derecho delante
    // Lo que piden los pasos (cambia a saltos: la caída sigue al reparto del peso, que solo
    // cambia en el doble apoyo; el giro se satura con los pies separados)…
    this.yawSpring.target = c.pelvisRotation * DEG * (motion.rotation ?? clamp(ahead / c.stepLength, -1, 1));
    this.rollSpring.target = c.pelvisObliquity * DEG * (motion.obliquity ?? motion.supportWeights.left - motion.supportWeights.right);
    const pace = clamp(motion.speed / c.walkSpeed, 0, 1);
    this.tiltSpring.target = -c.pelvisTiltSwing * DEG * pace * (motion.tilt ?? 0);
    // …y la pelvis lo sigue con amortiguación: un balanceo continuo en vez de un interruptor.
    if (this.springsReady && motion.dt !== undefined && motion.dt > 0) {
      const w = 2 * Math.PI * c.pelvisFrequency;
      // La rotación no debe ir retrasada (adelanta la pierna que aterriza): muelle más rápido.
      stepSpring(this.yawSpring, 2 * w, c.pelvisDamping, motion.dt);
      stepSpring(this.rollSpring, w, c.pelvisDamping, motion.dt);
      // Dos ondas por zancada: muelle más rápido aún (y sin rebote) para no retrasarla.
      stepSpring(this.tiltSpring, 4 * w, 1, motion.dt);
    } else {
      snapSpring(this.yawSpring);
      snapSpring(this.rollSpring);
      snapSpring(this.tiltSpring);
    }
    this.springsReady = motion.dt !== undefined;
    const yaw = this.yawSpring.value;
    const roll = this.rollSpring.value;
    const tilt = this.tiltSpring.value;
    const pitch = -c.pelvisTilt * DEG * pace + tilt - (motion.extraPitch ?? 0);

    this.q.setFromAxisAngle(UP, yaw);
    this.q.multiply(this.qAxis.setFromAxisAngle(F, roll));
    this.q.multiply(this.qAxis.setFromAxisAngle(R, pitch));

    worldQuaternion(this.rig.hips, this.qWorld);
    setWorldQuaternionNode(this.rig.hips, this.qWorld.premultiply(this.q));

    this.angles.yaw = yaw;
    this.angles.roll = roll;
    this.angles.pitch = pitch;
    this.angles.tilt = tilt;
  }
}

/**
 * Width of the rounding between the height limits of the legs, in leg lengths (at walkSpeed or above). In
 * double support it lowers the hips below what both legs need: with 0.05 the trailing knee was bent ~23° when
 * the other heel struck (CMU: ~18°; a person, 5–10°).
 */
const LEG_LIMIT_SMOOTHING = 0.025;
/** Frequency (Hz) of the spring with which the hips follow the requested height when rising. */
const RISE_FREQUENCY = 5;
/**
 * Rounding between the limits of the legs and the height the knees ask for, as a fraction of the
 * previous one.
 */
const KNEE_LIMIT_ROUNDING = 0.5;

/**
 * Smooth minimum (polynomial): equal to min(a, b) when they differ by more than `k`; otherwise a little
 * less, with a continuous derivative. Never greater than min(a, b).
 */
function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
