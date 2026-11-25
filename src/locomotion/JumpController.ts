import type { BodyState } from '../body/BodyController.ts';
import { computeJumpProfile, type JumpProfile, landingTimeFor } from './JumpProfile.ts';
import type { LocomotionConfig } from './LocomotionConfig.ts';

/**
 * Phases of the jump:
 *  - GROUNDED: no jump in progress.
 *  - TAKEOFF:  preparation (the hips sink, the arms go back);
 *              the steps continue if it was walking or running.
 *  - AIRBORNE: in the air (ballistic trajectory of the BodyController).
 *  - LANDING:  cushioning after touching the ground (the locomotion already continues).
 */
export type JumpPhase = 'GROUNDED' | 'TAKEOFF' | 'AIRBORNE' | 'LANDING';

export type JumpEvent = 'liftoff' | 'landed' | null;

const DEG = Math.PI / 180;
/**
 * From standing (JumpProfile.standing): the arms go back during the first STANDING_ARM_TURN of the going down and swing
 * forward and up from there to take-off, overlapping with the push (they arrive a little after it: they go through
 * the arm's pendulum). The toes push off from STANDING_TOE_START of the push on: the ankle, last.
 */
const STANDING_ARM_TURN = 0.7;
/** From standing, the arms start coming down after this share of the flight. */
const STANDING_ARM_HOLD = 0.2;
/** On landing, the foot rolls flat (from the ball or the heel) in this share of the cushioning. */
const LANDING_ROLL_SHARE = 0.25;
/**
 * Wanting to move on (moveTo, a speed), the cushioning lasts at most this (s): it stands up as it starts walking, and
 * with a long `landingTime` it no longer walks crouched. Above the longest with the defaults (0.45 × 1.5).
 */
const LANDING_MOVING_ON = 0.7;
const STANDING_TOE_START = 0.4;

const smoothstep = (x: number): number => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * State machine of the jump and its effect on the pose:
 * sinking of the hips, forward movement of the arms and lean of the torso.
 * The motion in the air is integrated by the BodyController (kinematic).
 */
export class JumpController {
  phase: JumpPhase = 'GROUNDED';
  /** Time within the current phase (s). */
  time = 0;
  /** Falling speed on landing (m/s). */
  impactSpeed = 0;
  /** In the take-off frame: time elapsed since take-off (s). */
  liftoffElapsed = 0;
  /** How much the hips go down on landing, × the usual (landing on one foot, less: see LocomotionController). */
  dipScale = 1;
  /**
   * The lowest the hips go on landing (m): what the legs can take (LocomotionController sets it from their length), so
   * that no `maxLandingDip` or `landingAbsorb` sits it on the ground.
   */
  maxDip = Number.POSITIVE_INFINITY;
  /** Landing stuck from a jump forward: the trunk goes forward this much more (rad; see LocomotionController.land). */
  stopLean = 0;
  /** How long this cushioning lasts (s): with the impact it really had (dropping lower than expected, more). */
  private landingDuration = 0;
  /** Hips already down when touching the ground (m; see JumpProfile.preflex). */
  private contactFlex = 0;
  /** How much they go down in the preparation, × the usual (running, a jump in stride: less). */
  crouchScale = 1;
  /**
   * Pose of the previous jump when a new one is requested during the cushioning (hips, arms, torso): it
   * fades out during the take-off, without jumps.
   */
  private readonly carry = { hip: 0, arm: 0, lean: 0 };
  /** Profile of the jump in progress (or of the last one): its physics and the parameters of its pose. */
  profile: JumpProfile;

  private readonly config: LocomotionConfig;

  constructor(config: LocomotionConfig) {
    this.config = config;
    this.profile = computeJumpProfile(config, { speed: 0 });
  }

  reset(): void {
    this.phase = 'GROUNDED';
    this.time = 0;
    this.impactSpeed = 0;
    this.carry.hip = 0;
    this.carry.arm = 0;
    this.carry.lean = 0;
  }

  /**
   * Requests a jump with `profile` (by default, the reference one: `jumpSpeed` up), with a preparation of
   * `preparation` s (by default, the profile's). Only accepted if there isn't another one in progress.
   */
  request(preparation = Number.NaN, profile?: JumpProfile): boolean {
    if (this.phase !== 'GROUNDED' && this.phase !== 'LANDING') return false;
    this.preparation = preparation;
    // Lo que queda del anterior, con su perfil.
    this.carry.hip = this.hipOffset();
    this.carry.arm = this.armForward();
    this.carry.lean = this.lean();
    // Sin perfil, el de referencia; con una preparación dada, el de un salto de un pie a otro (ver JumpProfile.stride).
    this.profile = profile ?? computeJumpProfile(this.config, { speed: 0, stride: preparation > 0 });
    this.stopLean = 0;
    this.phase = 'TAKEOFF';
    this.time = 0;
    return true;
  }

  /**
   * Advances the state machine. Returns 'liftoff' in the frame in which it has to take off and 'landed' in
   * the one in which the body has touched the ground.
   */
  update(dt: number, body: BodyState, movingOn = false): JumpEvent {
    // Queriendo seguir, el resto de la amortiguación pasa más deprisa (sin saltos: cambia el ritmo, no la pose).
    const rate = this.phase === 'LANDING' && movingOn ? Math.max(1, this.landingDuration / LANDING_MOVING_ON) : 1;
    this.time += dt * rate;
    switch (this.phase) {
      case 'TAKEOFF':
        if (this.time >= this.takeoffTime()) {
          this.liftoffElapsed = this.time - this.takeoffTime();
          this.enter('AIRBORNE');
          return 'liftoff';
        }
        return null;
      case 'AIRBORNE':
        if (!body.airborne) {
          this.contactFlex = this.airFlex();
          this.impactSpeed = body.landingSpeed;
          this.landingDuration = this.profile.stride ? this.profile.landingTime : landingTimeFor(this.config, this.impactSpeed);
          this.enter('LANDING');
          this.time = body.timeSinceLanding; // la amortiguación empezó al contacto, dentro de este frame
          return 'landed';
        }
        return null;
      case 'LANDING':
        if (this.time >= this.landingDuration) this.enter('GROUNDED');
        return null;
      default:
        return null;
    }
  }

  /** Offset of the hips relative to their normal height (m, ≤ 0). */
  hipOffset(): number {
    const c = this.config;
    const p = this.profile;
    if (this.phase === 'TAKEOFF' && this.standing) {
      // Desde parado: baja hasta la flexión (suave, parando abajo) y empuja acelerando parejo hasta vy: −d·(1 − s²).
      const d = p.crouch * this.crouchScale;
      const down = this.time < p.descentTime;
      const hip = down ? -d * smoothstep(this.time / p.descentTime) : -d * (1 - Math.min((this.time - p.descentTime) / p.pushTime, 1) ** 2);
      return hip + this.carried('hip');
    }
    if (this.phase === 'TAKEOFF') {
      // −k·u²(1−u): parte en reposo, baja hasta la flexión del perfil (en u = 2/3) y sube
      // terminando a la velocidad del salto (k = vy · duración).
      const u = this.progress(this.takeoffTime());
      return -p.vy * this.takeoffTime() * u * u * (1 - u) * this.crouchScale + this.carried('hip');
    }
    if (this.phase === 'LANDING') {
      const dip = Math.min(c.maxLandingDip, c.landingAbsorb * this.impactSpeed, Math.max(this.maxDip - this.contactFlex, 0)) * this.dipScale;
      // Desde lo que ya había bajado al tocar el suelo (ver airFlex), sin saltos.
      return -dip * this.landingCurve() - this.contactFlex * (1 - smoothstep(this.progress(this.landingDuration)));
    }
    return -this.airFlex();
  }

  /**
   * In the air, preparing the landing: the hips go down towards the profile's `preflex` (m, ≥ 0), so that the knees
   * touch the ground already bent.
   */
  private airFlex(): number {
    if (this.phase !== 'AIRBORNE') return 0;
    const p = this.profile;
    return p.preflex * smoothstep((this.time - (p.flight - p.landingPrep)) / p.landingPrep);
  }

  /**
   * Push-off with the toes (0–1): the heels rise in the second half of the preparation and are still
   * raised in the take-off frame.
   */
  toeOff(): number {
    if (this.phase === 'TAKEOFF' && this.standing) {
      const p = this.profile;
      return smoothstep((this.time - p.descentTime - STANDING_TOE_START * p.pushTime) / ((1 - STANDING_TOE_START) * p.pushTime));
    }
    if (this.phase === 'TAKEOFF') {
      const x = Math.min(Math.max((this.progress(this.takeoffTime()) - 0.5) / 0.5, 0), 1);
      return x * x * (3 - 2 * x);
    }
    return this.phase === 'AIRBORNE' && this.time === 0 ? 1 : 0;
  }

  /**
   * Forward movement of the arms written straight onto the pose (degrees; negative = backward): that of a jump in stride.
   * From standing, 0 (they go through the arm's pendulum: see `armReach`), but for what is left of the previous jump.
   */
  armForward(): number {
    if (this.standing) return this.phase === 'TAKEOFF' ? this.carried('arm') : 0;
    switch (this.phase) {
      case 'TAKEOFF':
        return -this.profile.armBack * Math.sin(Math.PI * this.progress(this.takeoffTime())) + this.carried('arm');
      case 'AIRBORNE':
        return this.profile.armForward * Math.sin(Math.PI * Math.min(this.time / this.profile.armAirTime, 1));
      case 'LANDING':
        // Al caer, por el péndulo (ver armReach), salvo de un pie a otro.
        return this.profile.stride ? this.profile.armLanding * this.landingCurve() : 0;
      default:
        return 0;
    }
  }

  /** Arms opening to the sides on landing (degrees): for balance, more the harder it lands. */
  armSpread(): number {
    return this.phase === 'LANDING' ? this.profile.armSpread * this.landingCurve() : 0;
  }

  /**
   * From standing, where the arms go (degrees forward; negative = backward): a target for the arm's pendulum, which
   * follows it with its weight and lag. Back while going down, forward and up to take-off (JumpProfile.armUp), down to
   * forward in the air (`armForward`) and, on landing, forward a little more and back to rest. 0 in a jump in stride.
   */
  armReach(): number {
    const p = this.profile;
    // Al caer, también en carrera: hacia delante, por el péndulo (rebota amortiguado, no una curva fija).
    if (this.phase === 'LANDING' && !p.stride && !this.standing) return p.armLanding * this.landingCurve();
    if (!this.standing) return 0;
    switch (this.phase) {
      case 'TAKEOFF': {
        const turn = STANDING_ARM_TURN * p.descentTime;
        if (this.time < turn) return -p.armBack * smoothstep(this.time / turn);
        return -p.armBack + (p.armUp + p.armBack) * smoothstep((this.time - turn) / (p.takeoffTime - turn));
      }
      case 'AIRBORNE':
        // Arriba aún un rato, y bajan hacia delante para caer.
        return p.armUp + (p.armForward - p.armUp) * smoothstep((this.time - STANDING_ARM_HOLD * p.flight) / ((1 - STANDING_ARM_HOLD) * p.flight));
      case 'LANDING':
        return p.armForward * (1 - smoothstep(this.progress(this.landingDuration))) + p.armLanding * this.landingCurve();
      default:
        return 0;
    }
  }

  /** Extra forward lean of the torso (rad). */
  lean(): number {
    const p = this.profile;
    if (this.phase === 'TAKEOFF' && this.standing) {
      // Desde parado: se inclina al bajar y al empujar se endereza (saltando lejos, no del todo).
      const lean = this.time < p.descentTime
        ? p.lean * smoothstep(this.time / p.descentTime)
        : p.lean + (p.leanTakeoff - p.lean) * smoothstep((this.time - p.descentTime) / p.pushTime);
      return lean + this.carried('lean');
    }
    if (this.phase === 'AIRBORNE') {
      // Lo del despegue se va en la primera mitad del vuelo y en la segunda se inclina hacia el aterrizaje.
      const half = p.flight / 2;
      return (this.standing ? p.leanTakeoff * (1 - smoothstep(this.time / half)) : 0) + p.airLean * smoothstep((this.time - half) / half);
    }
    if (this.phase === 'TAKEOFF') {
      return this.profile.lean * Math.sin(Math.PI * this.progress(this.takeoffTime())) + this.carried('lean');
    }
    if (this.phase === 'LANDING') {
      const settle = 1 - smoothstep(this.progress(this.landingDuration));
      return (Math.min(15, 4 * this.impactSpeed) * DEG + this.stopLean) * this.landingCurve() + p.airLean * settle;
    }
    return 0;
  }

  /** Head looking down at the landing (rad): more and more in the air, and back on landing. */
  gaze(): number {
    const p = this.profile;
    if (this.phase === 'AIRBORNE') return p.gaze * smoothstep(this.time / p.flight);
    if (this.phase === 'LANDING') return p.gaze * (1 - smoothstep(this.progress(this.landingDuration)));
    return 0;
  }

  /** On landing, on what part of the foot it rests (rad, see JumpProfile.landingRoll): all on contact, flat in a moment. */
  landingRoll(): number {
    if (this.phase === 'AIRBORNE') return this.profile.landingRoll;
    if (this.phase !== 'LANDING') return 0;
    return this.profile.landingRoll * (1 - smoothstep(this.time / (LANDING_ROLL_SHARE * this.landingDuration)));
  }

  /** Progress of the preparation (0–1; 0 outside it). */
  get takeoffProgress(): number {
    return this.phase === 'TAKEOFF' ? this.progress(this.takeoffTime()) : 0;
  }

  /** Cushioning curve: 0 when touching the ground, maximum around 30 %, 0 at the end. */
  private landingCurve(): number {
    return Math.sin(Math.PI * Math.pow(this.progress(this.landingDuration), 0.6));
  }

  /** From standing (see JumpProfile.standing): with its own curves; if not, those of a jump in stride. */
  get standingTakeoff(): boolean {
    return this.profile.standing && !(this.preparation > 0);
  }

  private get standing(): boolean {
    return this.standingTakeoff;
  }

  /** Duration of the preparation (s): the one requested, or the profile's (see JumpProfile.takeoffTime). */
  takeoffTime(): number {
    return this.preparation > 0 ? this.preparation : this.profile.takeoffTime;
  }

  /** Duration of the preparation of this jump (s; NaN: the usual one). */
  private preparation = Number.NaN;

  /** Value carried over from the previous jump, fading out during the take-off. */
  private carried(key: 'hip' | 'arm' | 'lean'): number {
    const u = this.progress(this.takeoffTime());
    return this.carry[key] * (1 - u * u * (3 - 2 * u));
  }

  private progress(duration: number): number {
    return Math.min(Math.max(this.time / duration, 0), 1);
  }

  private enter(phase: JumpPhase): void {
    this.phase = phase;
    this.time = 0;
  }
}
