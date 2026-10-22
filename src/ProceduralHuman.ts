import { type Object3D, Vector3 } from 'three';

import {
  ConfigError,
  CONSTRUCTION_ONLY_PARAMS,
  defaultConfig,
  type ProceduralHumanConfig,
  type ProceduralHumanConfigInput,
  REFERENCE_LEG_LENGTH,
  resolveConfig,
  scaleConfig,
  validateConfig,
} from './config.ts';
import type { FootPhase } from './locomotion/FootTarget.ts';
import type { GaitMode } from './locomotion/GaitController.ts';
import type { JumpPhase } from './locomotion/JumpController.ts';
import { LocomotionController } from './locomotion/LocomotionController.ts';
import { defaultMoveToConfig, type MoveToConfig, MoveToController } from './navigation/MoveToController.ts';
import { estimateForward, type HumanRig, type HumanRigMapping, measureLegLength, type Side } from './rig/HumanRig.ts';
import { type StylePreset, stylePresets } from './presets.ts';
import { checkModel } from './rig/checkModel.ts';
import { mapHumanRig } from './rig/RigMapper.ts';
import { type GroundDetector, RaycastGroundDetector } from './terrain/GroundDetector.ts';
import { RaycastSurfaceDetector, type SurfaceDetector } from './terrain/SurfaceDetector.ts';
import type { TouchOptions, TouchPhase } from './body/TouchController.ts';

const SIDES: readonly Side[] = ['left', 'right'];

export interface ProceduralHumanOptions {
  /**
   * Root of the character (e.g. `gltf.scene`). The library moves and orients it: don't move it yourself
   * while the character is active.
   */
  model: Object3D;
  /** Names of the model's bones (see `mixamoMapping` for an example). */
  mapping: HumanRigMapping;
  /**
   * Ground it walks on: the meshes to raycast against, or your own detector implementing `GroundDetector`
   * (heightmap, physics…).
   */
  ground: GroundDetector | Object3D[];
  /**
   * What it can touch with its hand when passing by (columns, walls, railings): the meshes to raycast
   * against, or your own detector (`SurfaceDetector`). Without them, it only touches with `touch()`.
   */
  touchables?: SurfaceDetector | Object3D[];
  /** Direction (world, horizontal) the model faces at rest. Estimated from the rig by default. */
  forward?: Vector3;
  /**
   * Predefined walking style (see `stylePresets`): 'tired', 'sneaky', 'athletic' or 'heavy'.
   * Applied on top of the defaults; `config` is applied afterwards and takes precedence over it.
   */
  preset?: StylePreset;
  /**
   * Parameters to change; the rest take their default value (or the `preset`'s). Lengths are given for the
   * reference character (1.83 m) and scaled with `bodyScale`.
   */
  config?: ProceduralHumanConfigInput;
  /**
   * Factor the lengths in the configuration are multiplied by (step, heights, crouch…). 'auto' (the
   * default): the model's leg length / the reference character's, so that a shorter or taller character
   * keeps its proportions. 1 = use the lengths as they are, in meters.
   */
  bodyScale?: number | 'auto';
  /**
   * Speeds and rates according to size (dynamic similarity, as between a child and an adult).
   * 'auto' (the default): speeds × √bodyScale; rates (steps per second, turns, springs) ÷ √bodyScale;
   * durations × √bodyScale; accelerations and gravity, unchanged. That way a small character doesn't take
   * frantic little steps and a large one doesn't move in slow motion. At the reference size (bodyScale 1)
   * nothing changes. 'off': speeds and rates from the configuration, whatever the size (only lengths are
   * scaled).
   * `targetSpeed`, `speed`, `velocity` and events are always in real m/s.
   */
  speedScale?: 'auto' | 'off';
  /**
   * Maximum simulation step (s). If a frame lasts longer (e.g. 1/20 s), it is simulated in several steps
   * so that the result doesn't depend on the frame rate. 1/30 by default.
   */
  maxTimeStep?: number;
  /**
   * Maximum time simulated per call to `update` (s): after a long stall it doesn't "catch up" on all of it.
   * 0.25 by default.
   */
  maxFrameTime?: number;
  /**
   * Seed for the natural variation (integer). Characters with different seeds don't move the same way;
   * the same seed repeats exactly the same motion. 1 by default.
   */
  seed?: number;
}

/** Events of the character and the data they receive. */
export interface ProceduralHumanEventMap {
  /** A foot touches the ground (at the end of a step or when landing from a jump). */
  footstep: { side: Side; position: Vector3; speed: number };
  /** Leaves the ground in a jump. */
  liftoff: { speed: number };
  /** Touches the ground after a jump; `impactSpeed` = falling speed (m/s). */
  land: { impactSpeed: number };
  /** Reached the `moveTo` destination (not emitted if it is cancelled). */
  arrive: { position: Vector3 };
  /** A hand rests on a surface (`point`, world). */
  touch: { side: Side; point: Vector3 };
}

export type ProceduralHumanEvent = keyof ProceduralHumanEventMap;
type Listener<E extends ProceduralHumanEvent> = (data: ProceduralHumanEventMap[E]) => void;

/**
 * Human character with procedural locomotion (no baked animations).
 *
 * Usage:
 * ```ts
 * const human = createProceduralHuman({ model: gltf.scene, mapping: mixamoMapping, ground: [floor] });
 * human.moveTo(point, { run: true });
 * // every frame:
 * human.update(dt);
 * ```
 *
 * Control:
 *  - continuous: `targetSpeed` (m/s), `targetHeading` (rad, positive = to the left), `targetCrouch` (0–1);
 *  - actions: `moveTo()`, `stop()`, `jump()`, `touch()` (and, with `touchables`, it touches things on its own
 *    when passing by).
 * Setting the speed or heading by hand cancels the current `moveTo`.
 */
export class ProceduralHuman {
  /** Bones of the model found with the mapping. */
  readonly rig: HumanRig;
  /**
   * Non-blocking warnings: about the mapping (missing optional bones…) and the model (rest pose, scale,
   * origin, proportions outside what is tested; see `checkModel`). Show them during development.
   */
  readonly warnings: readonly string[];
  /**
   * Active configuration, with the lengths of the reference character (unscaled).
   * To change it at runtime use `setConfig` (it validates the values).
   */
  readonly config: Readonly<ProceduralHumanConfig>;
  /**
   * Configuration used for the simulation: `config` with lengths × `bodyScale`. With `speedScale: 'auto'`,
   * speeds and accelerations are also × `bodyScale` (leans per acceleration ÷), on the simulation's internal
   * clock (see `speedScale`).
   */
  readonly effectiveConfig: Readonly<ProceduralHumanConfig>;
  /** Factor applied to the lengths in the configuration. */
  readonly bodyScale: number;
  /** Factor applied to speeds: √bodyScale with `speedScale: 'auto'`; otherwise 1. */
  readonly speedScale: number;
  /** Average leg length of the model (m). */
  readonly legLength: number;
  /** Advanced access to the locomotion controller (internal state of the gait, feet, pelvis…). */
  readonly locomotion: LocomotionController;
  /** Acceso avanzado al point and click. */
  readonly navigation: MoveToController;

  private readonly mutableConfig: ProceduralHumanConfig;
  private readonly scaledConfig: ProceduralHumanConfig;
  private readonly maxTimeStep: number;
  private readonly maxFrameTime: number;
  /**
   * Simulation seconds per real second. With `speedScale: 'auto'`, the configuration is scaled as a
   * geometric copy of the character (lengths, speeds and accelerations × bodyScale), and the clock runs at
   * 1/√bodyScale: the result is dynamic similarity (speeds × √s, times × √s, accelerations unchanged), also
   * for the internal constants of the locomotion. Speeds are converted on the way in and out (× clock = real
   * m/s).
   */
  private readonly clock: number;
  /** Is the configuration scaled as a geometric copy (`speedScale: 'auto'`)? */
  private readonly geometric: boolean;
  private readonly velocityOut = new Vector3();
  private readonly listeners: { [E in ProceduralHumanEvent]: Set<Listener<E>> } = {
    footstep: new Set(),
    liftoff: new Set(),
    land: new Set(),
    arrive: new Set(),
    touch: new Set(),
  };
  private readonly previousPhase: Record<Side, FootPhase> = { left: 'PLANTED', right: 'PLANTED' };
  private previousJump: JumpPhase = 'GROUNDED';

  constructor(options: ProceduralHumanOptions) {
    this.mutableConfig = resolveConfig({ ...presetConfig(options.preset), ...options.config });
    this.config = this.mutableConfig;
    this.maxTimeStep = positiveOption('maxTimeStep', options.maxTimeStep, 1 / 30);
    this.maxFrameTime = positiveOption('maxFrameTime', options.maxFrameTime, 0.25);

    const { rig, warnings } = mapHumanRig(options.model, options.mapping);
    this.rig = rig;
    // Del mapping y del modelo (pose de reposo, escala, proporciones): ver checkModel.
    this.warnings = [...warnings, ...checkModel(rig, options.forward)];

    this.legLength = measureLegLength(rig);
    const bodyScale = options.bodyScale ?? 'auto';
    if (bodyScale === 'auto') {
      const ratio = this.legLength / REFERENCE_LEG_LENGTH;
      this.bodyScale = Math.abs(ratio - 1) < 1e-6 ? 1 : ratio; // el de referencia: exactamente 1
    } else {
      this.bodyScale = positiveOption('bodyScale', bodyScale, 1);
    }
    const speedScale = options.speedScale ?? 'auto';
    if (speedScale !== 'auto' && speedScale !== 'off') {
      throw new RangeError(`ProceduralHuman: "speedScale" must be 'auto' or 'off' (received: ${String(speedScale)})`);
    }
    this.geometric = speedScale === 'auto';
    this.speedScale = this.geometric ? Math.sqrt(this.bodyScale) : 1;
    this.clock = this.geometric ? this.speedScale / this.bodyScale : 1;
    this.scaledConfig = scaleConfig(this.mutableConfig, this.bodyScale, undefined, this.geometric);
    this.effectiveConfig = this.scaledConfig;

    const detector = Array.isArray(options.ground) ? new RaycastGroundDetector(options.ground) : options.ground;
    const forward = options.forward?.clone().setY(0).normalize() ?? estimateForward(rig, 'toes');

    this.locomotion = new LocomotionController(rig, forward, detector, this.scaledConfig, options.seed ?? 1);
    this.navigation = new MoveToController(this.locomotion, pickMoveToConfig(this.scaledConfig));
    if (options.touchables) this.touchables = options.touchables;
    this.reset();
  }

  // ---------- Control ----------

  /** Desired speed (m/s). Setting it cancels the current `moveTo`. */
  get targetSpeed(): number {
    return this.locomotion.targetSpeed * this.clock;
  }

  set targetSpeed(value: number) {
    this.navigation.cancel();
    this.locomotion.targetSpeed = value / this.clock;
  }

  /**
   * Desired heading (rad; 0 = initial orientation, positive = to the left). Setting it cancels the `moveTo`.
   */
  get targetHeading(): number {
    return this.locomotion.targetHeading;
  }

  set targetHeading(value: number) {
    this.navigation.cancel();
    this.locomotion.targetHeading = value;
  }

  /** Desired crouch (0 = standing, 1 = fully crouched). */
  get targetCrouch(): number {
    return this.locomotion.targetCrouch;
  }

  set targetCrouch(value: number) {
    this.locomotion.targetCrouch = Math.min(Math.max(value, 0), 1);
  }

  /** Walk (or run, with `run`) to a point on the ground (world), in a straight line. */
  moveTo(point: Vector3, options: { run?: boolean } = {}): void {
    this.navigation.setTarget(point, options.run ?? false);
  }

  /** Stop: cancels the `moveTo` and sets the desired speed to 0. */
  stop(): void {
    this.navigation.cancel();
    this.locomotion.targetSpeed = 0;
  }

  /**
   * What it can touch when passing by: meshes (raycast) or your own detector; null = nothing (only
   * `touch()`). Can be changed at any time (e.g. when loading another area).
   */
  get touchables(): SurfaceDetector | null {
    return this.locomotion.surfaces;
  }

  set touchables(value: SurfaceDetector | Object3D[] | null) {
    this.locomotion.surfaces = Array.isArray(value) ? new RaycastSurfaceDetector(value) : value;
  }

  /** Touch on its own whatever is within reach when passing by (with `touchables`). Yes by default. */
  get autoTouch(): boolean {
    return this.locomotion.touch.auto;
  }

  set autoTouch(value: boolean) {
    this.locomotion.touch.auto = value;
  }

  /**
   * While walking, slide the hand along what it touches while it stays alongside (a wall, a railing; a
   * column, until it is behind). Yes by default; with false, it touches and lets go.
   */
  get touchSlide(): boolean {
    return this.locomotion.touch.slide;
  }

  set touchSlide(value: boolean) {
    this.locomotion.touch.slide = value;
  }

  /**
   * Rest a hand on `point` (world): it brings the hand there, palm towards the surface; while walking, it
   * slides it along the surface (`slide`, `touchSlide` by default) and withdraws it as when passing by (or,
   * with `hold`, when `releaseTouch` is called). Returns false if it can't reach (taking into account where
   * it is walking), if it is running or in the air.
   */
  touch(point: Vector3, options: TouchOptions = {}): boolean {
    return this.locomotion.touch.touch(point, this.locomotion.touchMotion(), this.locomotion.surfaces, options);
  }

  /** Withdraws the hand (or both) from the surface. */
  releaseTouch(side?: Side): void {
    this.locomotion.touch.release(side);
  }

  /**
   * What a hand is doing: 'none', 'reach' (moving towards the surface), 'contact' (resting) or 'release'
   * (coming back).
   */
  touchPhase(side: Side): TouchPhase {
    return this.locomotion.touch.phase(side);
  }

  /** Jump. Returns false if it isn't possible right now (already in the air or preparing a jump). */
  jump(): boolean {
    return this.locomotion.requestJump();
  }

  /**
   * Advances the simulation by `dt` seconds. Call once per frame, after giving commands and before
   * rendering.
   */
  update(dt: number): void {
    if (!(dt > 0)) return;
    // En tiempo de simulación (ver `clock`): los pasos máximos se aplican a ese tiempo.
    const total = Math.min(dt, this.maxFrameTime) * this.clock;
    const steps = Math.ceil(total / this.maxTimeStep - 1e-9);
    const step = total / steps;
    for (let i = 0; i < steps; i++) {
      const navigating = this.navigation.active;
      this.navigation.update();
      this.locomotion.update(step);
      this.emitEvents(navigating);
    }
  }

  // ---------- Estado ----------

  /** Position of the character's root (world). Don't modify it: use `reset` after moving it. */
  get position(): Vector3 {
    return this.locomotion.body.state.position;
  }

  /** Velocidad horizontal actual (m/s). */
  get speed(): number {
    return this.locomotion.speed * this.clock;
  }

  /** Current velocity (world, m/s). The vector belongs to the character: copy it to keep it. */
  get velocity(): Vector3 {
    return this.velocityOut.copy(this.locomotion.velocity).multiplyScalar(this.clock);
  }

  /** Rumbo actual (rad). */
  get heading(): number {
    return this.locomotion.body.state.heading;
  }

  /** In the air (jumping)? */
  get airborne(): boolean {
    return this.locomotion.body.state.airborne;
  }

  /** Jump phase: GROUNDED, TAKEOFF, AIRBORNE or LANDING. */
  get jumpPhase(): JumpPhase {
    return this.locomotion.jumping.phase;
  }

  /** Agachado actual (0–1). */
  get crouch(): number {
    return this.locomotion.crouch;
  }

  /** idle (still, feet on the ground) or walk (taking steps, walking or running). */
  get gaitMode(): GaitMode {
    return this.locomotion.gait.mode;
  }

  /** How much it runs instead of walking (0 = walking, 1 = running). */
  get runBlend(): number {
    return this.locomotion.gait.blend;
  }

  /** Destination of the current `moveTo`, or null. */
  get moveTarget(): Vector3 | null {
    return this.navigation.active ? this.navigation.target : null;
  }

  /** State of a foot: PLANT, PLANTED, LIFT or SWING. */
  footPhase(side: Side): FootPhase {
    return this.locomotion.feet[side].phase;
  }

  // ---------- Configuración ----------

  /**
   * Changes parameters at runtime (they are validated; if any is invalid, none is applied).
   * See `CONSTRUCTION_ONLY_PARAMS` for those that only count when creating the character.
   */
  setConfig(changes: ProceduralHumanConfigInput): void {
    validateConfig(changes, this.mutableConfig);
    const ignored = CONSTRUCTION_ONLY_PARAMS.filter((key) => key in changes && changes[key] !== this.mutableConfig[key]);
    if (ignored.length > 0) {
      console.warn(`ProceduralHuman.setConfig: ${ignored.join(', ')} only takes effect when the character is created.`);
    }
    Object.assign(this.mutableConfig, changes);
    scaleConfig(this.mutableConfig, this.bodyScale, this.scaledConfig, this.geometric);
    this.locomotion.planner.syncStepWidth();
    Object.assign(this.navigation.config, pickMoveToConfig(this.scaledConfig));
  }

  /**
   * Switches to a walking style at runtime: the whole configuration goes back to the defaults + the style
   * (`'default'` = no style) + `overrides`. Anything changed earlier with `setConfig` is lost (pass it in
   * `overrides` to keep it).
   */
  applyPreset(preset: StylePreset | 'default', overrides: ProceduralHumanConfigInput = {}): void {
    this.setConfig({ ...defaultConfig, ...presetConfig(preset === 'default' ? undefined : preset), ...overrides });
  }

  // ---------- Eventos ----------

  /** Subscribes to an event. Returns a function that cancels the subscription. */
  on<E extends ProceduralHumanEvent>(event: E, listener: Listener<E>): () => void {
    this.listeners[event].add(listener);
    return () => this.off(event, listener);
  }

  off<E extends ProceduralHumanEvent>(event: E, listener: Listener<E>): void {
    this.listeners[event].delete(listener);
  }

  // ---------- Ciclo de vida ----------

  /**
   * Still (desired speed 0, no moveTo), with the feet on the ground under the character at its current
   * position and with the initial orientation. Use it after moving the model by hand (teleporting); the
   * ground is searched up to 50 m below.
   */
  reset(): void {
    this.navigation.cancel();
    this.locomotion.targetSpeed = 0;
    this.locomotion.reset();
    for (const side of SIDES) this.previousPhase[side] = this.locomotion.feet[side].phase;
    this.previousJump = this.locomotion.jumping.phase;
  }

  /**
   * Moves the character by `offset` (world) without changing its motion: it keeps walking, running or
   * flying through the air exactly the same, with the feet, the trajectories and the `moveTo` destination
   * shifted along with it (unlike moving the model and calling `reset`, which stops it).
   * Useful for:
   *  - walking in place (treadmill): every frame, shift it back by what it moved horizontally;
   *  - a floating origin in large worlds: shift the character and the ground together.
   * The ground doesn't move: at the new place it must be the same (flat, or shifted too).
   * With `StaticGroundDetector`, if you move the ground, call `rebuild()`.
   */
  shiftOrigin(offset: Vector3): void {
    this.locomotion.shift(offset);
    this.navigation.shift(offset);
  }

  /**
   * Stops controlling the skeleton and returns it to its rest pose (e.g. to hand the model over to another
   * system). To control it again: `reset()`.
   */
  restPose(): void {
    this.navigation.cancel();
    this.locomotion.restPose();
  }

  /** Returns the model to its rest pose and removes the subscriptions. */
  dispose(): void {
    this.restPose();
    for (const set of Object.values(this.listeners)) set.clear();
  }

  private emitEvents(wasNavigating: boolean): void {
    for (const side of SIDES) {
      const foot = this.locomotion.feet[side];
      if (this.previousPhase[side] === 'SWING' && foot.phase !== 'SWING') {
        this.emit('footstep', { side, position: foot.planted.clone(), speed: this.speed });
      }
      this.previousPhase[side] = foot.phase;
    }

    const jump = this.locomotion.jumping;
    if (jump.phase !== this.previousJump) {
      if (jump.phase === 'AIRBORNE') this.emit('liftoff', { speed: this.speed });
      if (jump.phase === 'LANDING') this.emit('land', { impactSpeed: jump.impactSpeed * this.clock });
      this.previousJump = jump.phase;
    }

    if (wasNavigating && !this.navigation.active) this.emit('arrive', { position: this.position.clone() });
    for (const { side, point } of this.locomotion.touch.touched) this.emit('touch', { side, point: point.clone() });
  }

  private emit<E extends ProceduralHumanEvent>(event: E, data: ProceduralHumanEventMap[E]): void {
    for (const listener of this.listeners[event]) listener(data);
  }
}

/**
 * Creates a procedural character. Throws `RigMappingError` or `ConfigError` if the mapping or the
 * configuration is invalid.
 */
export function createProceduralHuman(options: ProceduralHumanOptions): ProceduralHuman {
  return new ProceduralHuman(options);
}

function presetConfig(preset: StylePreset | undefined): ProceduralHumanConfigInput {
  if (preset === undefined) return {};
  if (!Object.hasOwn(stylePresets, preset)) {
    throw new ConfigError([`unknown preset "${String(preset)}" (available: ${Object.keys(stylePresets).join(', ')})`]);
  }
  return stylePresets[preset];
}

function positiveOption(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!(Number.isFinite(value) && value > 0)) throw new RangeError(`ProceduralHuman: "${name}" must be a number > 0 (received: ${value})`);
  return value;
}

function pickMoveToConfig(config: ProceduralHumanConfigInput): Partial<MoveToConfig> {
  const out: Partial<MoveToConfig> = {};
  for (const key of Object.keys(defaultMoveToConfig) as (keyof MoveToConfig)[]) {
    if (config[key] !== undefined) out[key] = config[key];
  }
  return out;
}
