import { defaultLocomotionConfig, type LocomotionConfig } from './locomotion/LocomotionConfig.ts';
import { defaultMoveToConfig, type MoveToConfig } from './navigation/MoveToController.ts';

/**
 * All the parameters of the character: locomotion (steps, running, turning, body, crouching, jumping)
 * and point and click. Units: meters, seconds and degrees.
 */
export type ProceduralHumanConfig = LocomotionConfig & MoveToConfig;

/** What is passed when creating or reconfiguring: only the parameters to change. */
export type ProceduralHumanConfigInput = Partial<ProceduralHumanConfig>;

/**
 * Leg length (hip → knee → ankle, m) of the reference character (a 1.83 m human) the default values are
 * meant for.
 */
export const REFERENCE_LEG_LENGTH = 0.8789660528788095;

/**
 * Parameters that are body lengths (m): multiplied by `bodyScale` (the character's leg length /
 * REFERENCE_LEG_LENGTH). Speeds, accelerations, times, angles and fractions are not scaled.
 */
export const LENGTH_PARAMS = [
  'stepLength', 'stepWidth', 'stepHeight', 'ankleBack', 'runStepLength', 'runStepHeight',
  'runCrouch', 'runBounce', 'crouchDepth', 'crouchHipBack',
  'jumpCrouch', 'jumpTuck', 'maxLandingDip', 'idleStepThreshold',
  'toeClearance', 'maxExtraStepHeight', 'groundProbeHeight', 'groundProbeDepth',
  'footProbeHeight', 'footProbeDepth', 'footProbeTolerance', 'kneePoleDistance', 'shoulderForward',
  'arriveRadius', 'headingLockRadius', 'stopTolerance',
] as const satisfies readonly (keyof ProceduralHumanConfig)[];

/**
 * Parameters with meters in their units that are not lengths: speeds and accelerations (m/s, m/s²;
 * multiplied by the scale, like lengths) and leans per unit of acceleration (degrees per m/s²; divided).
 * With `speedScale: 'auto'` the configuration is scaled this way (geometric similarity) and the internal
 * clock runs slower or faster: see ProceduralHuman.
 */
export const SPEED_PARAMS = [
  'walkSpeed', 'runSpeed', 'runStartSpeed', 'runTransition', 'crouchMaxSpeed', 'jumpSpeed',
] as const satisfies readonly (keyof ProceduralHumanConfig)[];
export const ACCELERATION_PARAMS = [
  'acceleration', 'deceleration', 'gravity', 'maxLateralAcceleration',
] as const satisfies readonly (keyof ProceduralHumanConfig)[];
export const PER_ACCELERATION_PARAMS = [
  'leanPerAcceleration', 'armInertia', 'trunkInertia',
] as const satisfies readonly (keyof ProceduralHumanConfig)[];

/** Default values (calibrated for an adult human of ~1.8 m). */
export const defaultConfig: Readonly<ProceduralHumanConfig> = Object.freeze({
  ...defaultLocomotionConfig,
  ...defaultMoveToConfig,
});

/** Thrown when the configuration has unknown parameters or invalid values. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Key = keyof ProceduralHumanConfig;

/** Must be > 0 (used as divisors, times or speeds). */
const POSITIVE: readonly Key[] = [
  'walkSpeed', 'runSpeed', 'runStartSpeed', 'acceleration', 'deceleration',
  'stepFrequency', 'minStepFrequency', 'runStepFrequency', 'stepLength', 'runStepLength',
  'turnSpeed', 'turnAcceleration', 'maxTurnPerStep', 'maxLateralAcceleration',
  'crouchMaxSpeed', 'crouchRate',
  'gravity', 'jumpSpeed', 'jumpCrouch', 'landingTime',
  'touchReachTime', 'touchReleaseTime',
  'armSwingFrequency', 'armSwingDamping', 'trunkFrequency', 'trunkDamping', 'forearmFrequency', 'handFrequency', 'fingerFrequency', 'pelvisFrequency', 'pelvisDamping',
];

/** Fractions of the step cycle. */
const OPEN_FRACTION: readonly Key[] = ['dutyFactor', 'runDutyFactor']; // (0, 1)
const FRACTION: readonly Key[] = ['liftFraction', 'plantFraction']; // [0, 1)

/** Parameters that are only read when the character is created (changing them later has no effect). */
export const CONSTRUCTION_ONLY_PARAMS: readonly Key[] = ['kneePoleDistance'];

/**
 * Checks some partial parameters on top of a base configuration: known names (avoids silent typos),
 * finite numbers, ranges that would break the computation and consistency between related parameters.
 */
export function validateConfig(input: ProceduralHumanConfigInput, base: ProceduralHumanConfig = defaultConfig): void {
  const problems: string[] = [];
  const merged = { ...base, ...input } as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!(key in defaultConfig)) problems.push(`unknown parameter "${key}"`);
  }
  for (const [key, value] of Object.entries(input)) {
    if (!(key in defaultConfig)) continue;
    if (key === 'stepWidth' && value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`"${key}" must be a finite number (received: ${String(value)})`);
  }
  if (problems.length > 0) throw new ConfigError(problems);

  const num = (key: Key): number => merged[key] as number;
  for (const key of POSITIVE) if (!(num(key) > 0)) problems.push(`"${key}" must be > 0 (got ${num(key)})`);
  for (const key of OPEN_FRACTION) if (!(num(key) > 0 && num(key) < 1)) problems.push(`"${key}" must be between 0 and 1, exclusive (got ${num(key)})`);
  for (const key of FRACTION) if (!(num(key) >= 0 && num(key) < 1)) problems.push(`"${key}" must be in [0, 1) (got ${num(key)})`);
  if (num('variation') < 0) problems.push(`"variation" must be ≥ 0 (got ${num('variation')})`);
  if (num('turnSlowdown') < 0 || num('turnSlowdown') > 1) problems.push(`"turnSlowdown" must be between 0 and 1 (got ${num('turnSlowdown')})`);
  if (num('chestRollShare') < 0 || num('chestRollShare') > 1) problems.push(`"chestRollShare" must be between 0 and 1 (got ${num('chestRollShare')})`);
  if (num('fingerCurl') < 0) problems.push(`"fingerCurl" must be ≥ 0 (got ${num('fingerCurl')})`);
  if (!(num('touchMaxReach') > 0 && num('touchMaxReach') <= 1)) problems.push(`"touchMaxReach" must be in (0, 1] (got ${num('touchMaxReach')})`);
  for (const key of ['touchHoldTime', 'touchCooldown'] as const) if (num(key) < 0) problems.push(`"${key}" must be ≥ 0 (got ${num(key)})`);
  if (num('speedEasing') < 0) problems.push(`"speedEasing" must be ≥ 0 (got ${num('speedEasing')})`);
  if (merged.stepWidth !== null && num('stepWidth') < 0) problems.push(`"stepWidth" must be ≥ 0 or null (got ${num('stepWidth')})`);
  if (num('runSpeed') < num('walkSpeed')) problems.push(`"runSpeed" (${num('runSpeed')}) cannot be less than "walkSpeed" (${num('walkSpeed')})`);
  if (num('runStartSpeed') > num('runSpeed')) problems.push(`"runStartSpeed" (${num('runStartSpeed')}) cannot be greater than "runSpeed" (${num('runSpeed')})`);
  if (num('minStepFrequency') > num('stepFrequency')) {
    problems.push(`"minStepFrequency" (${num('minStepFrequency')}) cannot be greater than "stepFrequency" (${num('stepFrequency')})`);
  }
  if (problems.length > 0) throw new ConfigError(problems);
}

/**
 * Copies `config` into `out` with the lengths (LENGTH_PARAMS) multiplied by `scale`.
 * With `geometric`, also speeds and accelerations (× `scale`) and leans per acceleration (÷ `scale`): the
 * same motion at another scale, with the same clock. Returns `out`.
 */
export function scaleConfig(
  config: Readonly<ProceduralHumanConfig>,
  scale: number,
  out: ProceduralHumanConfig = { ...config },
  geometric = false,
): ProceduralHumanConfig {
  Object.assign(out, config);
  for (const key of LENGTH_PARAMS) {
    const value = config[key];
    if (value !== null) out[key] = value * scale;
  }
  if (geometric) {
    for (const key of [...SPEED_PARAMS, ...ACCELERATION_PARAMS]) out[key] = config[key] * scale;
    for (const key of PER_ACCELERATION_PARAMS) out[key] = config[key] / scale;
  }
  return out;
}

/** Full configuration: the default values with the given changes (validated). */
export function resolveConfig(input: ProceduralHumanConfigInput = {}): ProceduralHumanConfig {
  validateConfig(input);
  return { ...defaultConfig, ...input };
}
