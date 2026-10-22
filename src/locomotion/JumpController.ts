import type { BodyState } from '../body/BodyController.ts';
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
  /**
   * Pose of the previous jump when a new one is requested during the cushioning (hips, arms, torso): it
   * fades out during the take-off, without jumps.
   */
  private readonly carry = { hip: 0, arm: 0, lean: 0 };

  private readonly config: LocomotionConfig;

  constructor(config: LocomotionConfig) {
    this.config = config;
  }

  reset(): void {
    this.phase = 'GROUNDED';
    this.time = 0;
    this.impactSpeed = 0;
    this.carry.hip = 0;
    this.carry.arm = 0;
    this.carry.lean = 0;
  }

  /** Requests a jump. Only accepted if there isn't another one in progress. */
  request(): boolean {
    if (this.phase !== 'GROUNDED' && this.phase !== 'LANDING') return false;
    this.carry.hip = this.hipOffset();
    this.carry.arm = this.armForward();
    this.carry.lean = this.lean();
    this.phase = 'TAKEOFF';
    this.time = 0;
    return true;
  }

  /**
   * Advances the state machine. Returns 'liftoff' in the frame in which it has to take off and 'landed' in
   * the one in which the body has touched the ground.
   */
  update(dt: number, body: BodyState): JumpEvent {
    this.time += dt;
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
          this.impactSpeed = body.landingSpeed;
          this.enter('LANDING');
          this.time = body.timeSinceLanding; // la amortiguación empezó al contacto, dentro de este frame
          return 'landed';
        }
        return null;
      case 'LANDING':
        if (this.time >= this.config.landingTime) this.enter('GROUNDED');
        return null;
      default:
        return null;
    }
  }

  /** Offset of the hips relative to their normal height (m, ≤ 0). */
  hipOffset(): number {
    const c = this.config;
    if (this.phase === 'TAKEOFF') {
      // −k·u²(1−u): parte en reposo, baja hasta jumpCrouch (en u = 2/3) y sube
      // terminando a la velocidad del salto (k = jumpSpeed · duración).
      const u = this.progress(this.takeoffTime());
      return -c.jumpSpeed * this.takeoffTime() * u * u * (1 - u) + this.carried('hip');
    }
    if (this.phase === 'LANDING') {
      const dip = Math.min(c.maxLandingDip, c.landingAbsorb * this.impactSpeed);
      return -dip * this.landingCurve();
    }
    return 0;
  }

  /**
   * Push-off with the toes (0–1): the heels rise in the second half of the preparation and are still
   * raised in the take-off frame.
   */
  toeOff(): number {
    if (this.phase === 'TAKEOFF') {
      const x = Math.min(Math.max((this.progress(this.takeoffTime()) - 0.5) / 0.5, 0), 1);
      return x * x * (3 - 2 * x);
    }
    return this.phase === 'AIRBORNE' && this.time === 0 ? 1 : 0;
  }

  /** Forward movement of the arms (degrees; negative = backward). */
  armForward(): number {
    switch (this.phase) {
      case 'TAKEOFF':
        return -35 * Math.sin(Math.PI * this.progress(this.takeoffTime())) + this.carried('arm');
      case 'AIRBORNE':
        return 40 * Math.sin(Math.PI * Math.min(this.time / 0.5, 1));
      case 'LANDING':
        return 20 * this.landingCurve();
      default:
        return 0;
    }
  }

  /** Extra forward lean of the torso (rad). */
  lean(): number {
    if (this.phase === 'TAKEOFF') {
      return 12 * DEG * Math.sin(Math.PI * this.progress(this.takeoffTime())) + this.carried('lean');
    }
    if (this.phase === 'LANDING') return Math.min(15, 4 * this.impactSpeed) * DEG * this.landingCurve();
    return 0;
  }

  /** Cushioning curve: 0 when touching the ground, maximum around 30 %, 0 at the end. */
  private landingCurve(): number {
    return Math.sin(Math.PI * Math.pow(this.progress(this.config.landingTime), 0.6));
  }

  /**
   * Duration of the preparation (s): that of the curve −k·u²(1−u), whose depth is k·4/27, with
   * k = jumpSpeed · duration → duration = 27·jumpCrouch / (4·jumpSpeed).
   */
  takeoffTime(): number {
    return (27 * this.config.jumpCrouch) / (4 * Math.max(this.config.jumpSpeed, 1e-6));
  }

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
