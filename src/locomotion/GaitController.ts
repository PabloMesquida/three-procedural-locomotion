import type { Side } from '../rig/HumanRig.ts';
import type { FootPhase } from './FootTarget.ts';
import type { LocomotionConfig } from './LocomotionConfig.ts';

export type GaitMode = 'idle' | 'walk';

export interface GaitEvent {
  side: Side;
  /** liftoff: the foot takes off (the swing starts). touchdown: it lands. */
  type: 'liftoff' | 'touchdown';
}

const SIDES: readonly Side[] = ['left', 'right'];

/**
 * Phase-based procedural gait, from walking to running.
 *
 * A global phase φ ∈ [0, 1) advances at the frequency of the cycle (one cycle = one step of each foot).
 * Each foot has its own phase p = φ + offset (left 0, right 0.5).
 * Within each foot's cycle:
 *
 *   p: 0 ── plant ── PLANTED ── β−lift ── LIFT ── β ── SWING ── 1
 *        (landing)   (on the ground)      (heel)        (in the air)
 *
 * where β is the duty factor (fraction of the cycle with the foot on the ground):
 *  - walking: β > 0.5 → there is double support;
 *  - running: β < 0.5 → there are flight phases (no foot on the ground).
 *
 * Walking ↔ running is gradual: the running factor `blend` (0 → 1) grows with speed and interpolates the
 * parameters. Each foot fixes its β when it lands and keeps it during its cycle, so that a change of β
 * doesn't make it change state abruptly (for example, "landing" in the air).
 *
 * Modes:
 *  - walk: the phase advances (walking or running).
 *  - idle: the phase stops (only in double support) and both feet are PLANTED.
 */
/** Maximum change of the cadence (cycles/s per second). */
const MAX_FREQUENCY_RATE = 1.5;
/** Maximum fraction of the stance that LIFT lasts, walking and running. */
const WALK_MAX_LIFT = 0.45;
const RUN_MAX_LIFT = 0.3;

export class GaitController {
  mode: GaitMode = 'idle';
  /** Global phase of the cycle, 0 → 1. */
  phase = 0;
  /** Current frequency of the cycle (cycles/s). */
  frequency = 0;
  /** Factor de carrera actual: 0 = caminar, 1 = correr. */
  blend = 0;
  /** Duty factor of each foot, fixed at its last landing. */
  readonly duty: Record<Side, number> = { left: 0, right: 0 };
  readonly offsets: Record<Side, number> = { left: 0, right: 0.5 };
  readonly config: LocomotionConfig;

  private readonly events: GaitEvent[] = [];

  constructor(config: LocomotionConfig) {
    this.config = config;
    this.reset();
  }

  /** Idle mode with the phase in the middle of a double support. */
  reset(): void {
    this.mode = 'idle';
    this.frequency = 0;
    this.blend = 0;
    this.duty.left = this.config.dutyFactor;
    this.duty.right = this.config.dutyFactor;
    this.phase = (this.config.dutyFactor - 0.5) / 2; // centro del primer doble apoyo
  }

  /** Running factor (0–1) for a speed: rises from 0 to 1 above runStartSpeed. */
  runFactor(speed: number): number {
    const { runStartSpeed, runTransition } = this.config;
    return smoothstep((speed - runStartSpeed) / Math.max(runTransition, 1e-6));
  }

  /** Interpolates a parameter between its walking value and its running value with the current factor. */
  mix(walkValue: number, runValue: number): number {
    return walkValue + (runValue - walkValue) * this.blend;
  }

  /** Duty factor for a running factor. */
  dutyFor(blend: number): number {
    const { dutyFactor, runDutyFactor } = this.config;
    return dutyFactor + (runDutyFactor - dutyFactor) * blend;
  }

  /** Phase of the foot, 0 → 1 (0 = landing). */
  footPhase(side: Side): number {
    return fract(this.phase + this.offsets[side]);
  }

  isStance(side: Side): boolean {
    return this.mode === 'idle' || this.footPhase(side) < this.duty[side];
  }

  /** Duration (in phase) of a foot's LIFT. */
  liftPhase(side: Side): number {
    return this.liftAndPlant(side).lift;
  }

  /** Maximum fraction of the stance that LIFT can last with the current running factor. */
  maxLiftShare(): number {
    return WALK_MAX_LIFT + (RUN_MAX_LIFT - WALK_MAX_LIFT) * this.blend;
  }

  /**
   * Durations (in phase) of LIFT and PLANT for a foot, adjusted to its stance. When walking, the heel can
   * start rising earlier (in motion capture, around mid-stance).
   */
  private liftAndPlant(side: Side): { lift: number; plant: number } {
    const b = this.duty[side];
    return {
      lift: Math.min(this.config.liftFraction, b * this.maxLiftShare()),
      plant: Math.min(this.config.plantFraction, b * 0.25),
    };
  }

  footState(side: Side): FootPhase {
    if (this.mode === 'idle') return 'PLANTED';
    const p = this.footPhase(side);
    const b = this.duty[side];
    const { lift, plant } = this.liftAndPlant(side);
    if (p < plant) return 'PLANT';
    if (p < b - lift) return 'PLANTED';
    if (p < b) return 'LIFT';
    return 'SWING';
  }

  /** Progress of the swing (0 → 1); 0 if the foot is on the ground. */
  swingProgress(side: Side): number {
    const p = this.footPhase(side);
    const b = this.duty[side];
    return p < b ? 0 : (p - b) / (1 - b);
  }

  /** Progress within a specific state (0 → 1), useful for LIFT and PLANT. */
  stateProgress(side: Side): number {
    const p = this.footPhase(side);
    const b = this.duty[side];
    const { lift, plant } = this.liftAndPlant(side);
    switch (this.footState(side)) {
      case 'PLANT':
        return p / plant;
      case 'LIFT':
        return (p - (b - lift)) / lift;
      case 'SWING':
        return this.swingProgress(side);
      default:
        return 0;
    }
  }

  /**
   * Steps per second for a speed:
   *  - walking: stepFrequency at walkSpeed, proportional to √speed (the relation motion capture follows:
   *    at higher speed, steps a little faster and quite a lot longer), never below minStepFrequency;
   *  - running: from the walking one at the start of the transition up to runStepFrequency (at runSpeed),
   *    according to the running factor;
   *  - never fewer than needed so as not to exceed the maximum step length (interpolated between
   *    stepLength and runStepLength), nor to turn more than maxTurnPerStep degrees per step.
   */
  stepFrequencyFor(speed: number, angularSpeed = 0): number {
    const c = this.config;
    const walkFrequency = (v: number): number => Math.max(c.minStepFrequency, c.stepFrequency * Math.sqrt(Math.max(v, 0) / c.walkSpeed));
    const walkF = walkFrequency(speed);
    const runStart = Math.min(c.runStartSpeed, c.runSpeed);
    const kRun = clamp01((speed - runStart) / Math.max(c.runSpeed - runStart, 1e-6));
    const startF = walkFrequency(runStart);
    const runF = startF + (c.runStepFrequency - startF) * kRun;
    const r = this.runFactor(speed);
    const f = walkF + (runF - walkF) * r;
    const maxStep = c.stepLength + (c.runStepLength - c.stepLength) * r;
    // Cada pie da un paso por ciclo (= 2 pasos): gira ω·2/f entre dos apoyos suyos.
    const turnLimit = (2 * Math.abs(angularSpeed)) / ((c.maxTurnPerStep * this.turnPerStepScale * Math.PI) / 180);
    return Math.max(f, speed / maxStep, turnLimit, this.minFrequency);
  }

  /** Swing duration (s) of a foot with duty factor `duty`. */
  swingDuration(speed: number, angularSpeed: number, duty: number): number {
    return (1 - duty) / this.cycleFrequency(speed, angularSpeed);
  }

  /** Stance duration (s) a foot landing at this speed would have. */
  stanceDuration(speed: number, angularSpeed = 0): number {
    return this.dutyFor(this.runFactor(speed)) / this.cycleFrequency(speed, angularSpeed);
  }

  /**
   * Multiplier of the cadence (1 = the configuration's). The natural variation moves it a little, slowly;
   * it affects everything that uses the cadence (including where each step is planned), so the steps still
   * add up.
   */
  frequencyScale = 1;
  /** Multiplier of `maxTurnPerStep` (e.g. when pivoting to turn around, set by MoveToController). */
  turnPerStepScale = 1;
  /** Fewest steps per second (e.g. going down stairs, set by LocomotionController); 0 = no minimum. */
  minFrequency = 0;

  /** Cycles per second (each cycle contains one step of each foot). */
  cycleFrequency(speed: number, angularSpeed = 0): number {
    return (this.stepFrequencyFor(speed, angularSpeed) / 2) * this.frequencyScale;
  }

  /**
   * Fraction of the weight a foot bears (0–1).
   *  - still: 0.5 each;
   *  - only one foot on the ground: 1 for it;
   *  - double support: the weight shifts from the back foot to the one that just landed;
   *  - flight (running): 0 for both.
   */
  supportWeight(side: Side): number {
    if (this.mode === 'idle') return 0.5;
    const other: Side = side === 'left' ? 'right' : 'left';
    if (!this.isStance(side)) return 0;
    if (!this.isStance(other)) return 1;

    const p = this.footPhase(side);
    const q = this.footPhase(other);
    const leading = p < q; // el que aterrizó más recientemente
    const trailing: Side = leading ? other : side;
    const doubleSupport = this.duty[trailing] - 0.5;
    if (doubleSupport <= 0) return 0.5;
    const k = smoothstep(Math.min((leading ? p : q) / doubleSupport, 1));
    return leading ? k : 1 - k;
  }

  /** Are both feet on the ground right now? */
  doubleSupport(): boolean {
    return this.footPhase('left') < this.duty.left && this.footPhase('right') < this.duty.right;
  }

  /** Advances the phase (only in walk mode) and returns the take-offs/landings that happened. */
  update(dt: number, speed: number, angularSpeed = 0): readonly GaitEvent[] {
    this.events.length = 0;
    this.blend = this.runFactor(speed);
    if (this.mode !== 'walk') {
      this.frequency = 0;
      return this.events;
    }

    // La cadencia cambia de forma continua: al terminar un giro (que la sube para no girar demasiado
    // por paso) no cae de golpe, lo que daba un tirón a los pies en el aire y a las caderas.
    const target = this.cycleFrequency(speed, angularSpeed);
    const maxChange = MAX_FREQUENCY_RATE * dt;
    this.frequency = this.frequency > 0 ? this.frequency + Math.min(Math.max(target - this.frequency, -maxChange), maxChange) : target;
    const before = { left: this.footPhase('left'), right: this.footPhase('right') };
    this.phase = fract(this.phase + this.frequency * dt);

    for (const side of SIDES) {
      const p0 = before[side];
      const p1 = this.footPhase(side);
      const b = this.duty[side];
      if (p0 < b && p1 >= b) this.events.push({ side, type: 'liftoff' });
      if (p1 < p0) {
        // Dio la vuelta (1 → 0): aterriza y fija su duty factor para este ciclo.
        this.events.push({ side, type: 'touchdown' });
        this.duty[side] = this.dutyFor(this.blend);
      }
    }
    return this.events;
  }
}

function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

function smoothstep(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

function fract(x: number): number {
  return x - Math.floor(x);
}
