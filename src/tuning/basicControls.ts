import type { ProceduralHumanConfig, ProceduralHumanConfigInput } from '../config.ts';
import type { LocalizedText } from '../i18n.ts';

type Key = keyof ProceduralHumanConfig;

/**
 * Basic controls: a few high-level settings ("tempo", "arm swing"…) that move several parameters of the
 * configuration at once. They are a layer on top of the configuration, like the presets: the locomotion
 * knows nothing about them. `applyBasicControls` turns them into parameters for `human.setConfig`.
 */
export type BasicControlName =
  | 'tempo'
  | 'stride'
  | 'stepHeight'
  | 'knees'
  | 'hipSway'
  | 'armSwing'
  | 'armSpread'
  | 'armForward'
  | 'lean'
  | 'looseness'
  | 'agility'
  | 'naturalness'
  | 'intensity';

export interface BasicControlInfo {
  name: BasicControlName;
  /** Name for a UI, in English and Spanish. */
  label: LocalizedText;
  /** What it does, in one sentence, in English and Spanish. */
  description: LocalizedText;
  /** 'factor': multiplica (neutro 1); 'degrees': suma grados (neutro 0). */
  kind: 'factor' | 'degrees';
  min: number;
  max: number;
  /** Value that leaves the configuration as it is. */
  neutral: number;
  /** Parameters of the configuration that it moves. */
  params: readonly Key[];
}

/**
 * Maximum angles of the foot (degrees) that the heel at toe-off and the toes at landing approach when the
 * foot roll is increased: with rigid toes, beyond that the toes would dig into the ground.
 */
const MAX_HEEL_LIFT = 70;
const MAX_HEEL_STRIKE = 35;

/**
 * Foot angle scaled by `k`: proportional when reducing it; when increasing it, it approaches `max`
 * without exceeding it.
 */
function rollAngle(angle: number, k: number, max: number): number {
  if (k <= 1 || angle >= max) return angle * Math.min(k, 1);
  return max - (max - angle) / k;
}

/** Amplitudes that `intensity` also scales. */
const INTENSITY_CONTROLS: readonly BasicControlName[] = ['stepHeight', 'knees', 'hipSway', 'armSwing'];

const individualControls: readonly BasicControlInfo[] = [
  {
    name: 'tempo',
    label: { en: 'Tempo', es: 'Ritmo' },
    description: {
      en: 'Faster or slower, with steps of the same size (speeds and steps per second).',
      es: 'Más rápido o más lento, con pasos del mismo tamaño (velocidades y pasos por segundo).',
    },
    kind: 'factor', min: 0.6, max: 1.6, neutral: 1,
    params: ['walkSpeed', 'runSpeed', 'runStartSpeed', 'runTransition', 'crouchMaxSpeed', 'stepFrequency', 'minStepFrequency', 'runStepFrequency'],
  },
  {
    name: 'stride',
    label: { en: 'Stride', es: 'Zancada' },
    description: {
      en: 'Longer and slower steps (or shorter and quicker ones) at the same speed.',
      es: 'Pasos más largos y más lentos (o más cortos y rápidos) a la misma velocidad.',
    },
    kind: 'factor', min: 0.7, max: 1.2, neutral: 1,
    params: ['stepLength', 'runStepLength', 'stepFrequency', 'minStepFrequency', 'runStepFrequency'],
  },
  {
    name: 'stepHeight',
    label: { en: 'Step height', es: 'Altura del paso' },
    description: {
      en: 'How high the feet lift and how much the foot rolls (heel and toes).',
      es: 'Cuánto levanta los pies y cuánto articula el pie (talón y punta).',
    },
    kind: 'factor', min: 0.3, max: 2, neutral: 1,
    params: ['stepHeight', 'runStepHeight', 'heelLiftAngle', 'runHeelLiftAngle', 'heelStrikeAngle', 'runHeelStrikeAngle'],
  },
  {
    name: 'knees',
    label: { en: 'Knee bend', es: 'Flexión de rodillas' },
    description: {
      en: 'Springier gait (knees that cushion) or stiffer.',
      es: 'Marcha más elástica (rodillas que amortiguan) o más rígida.',
    },
    kind: 'factor', min: 0, max: 2, neutral: 1,
    params: ['stanceKneeBend', 'loadingKneeBend', 'runCrouch'],
  },
  {
    name: 'hipSway',
    label: { en: 'Hip sway', es: 'Balanceo de cadera' },
    description: {
      en: 'How much the pelvis moves and the weight shifts from one foot to the other.',
      es: 'Cuánto se mueven la pelvis y el peso de un pie al otro.',
    },
    kind: 'factor', min: 0, max: 2.5, neutral: 1,
    params: ['lateralShift', 'pelvisRotation', 'pelvisObliquity', 'pelvisTiltSwing', 'runBounce'],
  },
  {
    name: 'armSwing',
    label: { en: 'Arm swing', es: 'Braceo' },
    description: {
      en: 'Amplitude of the arm swing, walking and running.',
      es: 'Amplitud del balanceo de los brazos, caminando y corriendo.',
    },
    kind: 'factor', min: 0, max: 2.5, neutral: 1,
    params: ['armSwing', 'runArmSwing', 'elbowSwingBend', 'runElbowSwingBend', 'shoulderSwing'],
  },
  {
    name: 'armSpread',
    label: { en: 'Arm spread', es: 'Separación de brazos' },
    description: {
      en: 'How far the arms hang away from the body, standing, walking and running (degrees added).',
      es: 'Cuánto se separan los brazos del cuerpo, parado, caminando y corriendo (grados que se suman).',
    },
    kind: 'degrees', min: -5, max: 20, neutral: 0,
    params: ['idleArmAbduction', 'armAbduction', 'runArmAbduction'],
  },
  {
    name: 'armForward',
    label: { en: 'Arm position', es: 'Posición de brazos' },
    description: {
      en: 'Arms further forward (positive) or back (negative), standing and as the centre of the swing (degrees added).',
      es: 'Brazos más adelante (positivo) o más atrás (negativo), parado y como centro del balanceo (grados que se suman).',
    },
    kind: 'degrees', min: -15, max: 15, neutral: 0,
    params: ['idleArmForward', 'armForward'],
  },
  {
    name: 'lean',
    label: { en: 'Lean', es: 'Inclinación' },
    description: {
      en: 'Posture leaning forward (positive) or more upright (negative), in degrees.',
      es: 'Postura hacia delante (positivo) o más erguida (negativo), en grados.',
    },
    kind: 'degrees', min: -10, max: 25, neutral: 0,
    params: ['walkLean', 'runLean'],
  },
  {
    name: 'looseness',
    label: { en: 'Looseness', es: 'Soltura' },
    description: {
      en: 'Loose body, with inertia and lag (more), or stiff (less).',
      es: 'Cuerpo suelto, con inercia y retraso (más), o rígido (menos).',
    },
    kind: 'factor', min: 0.5, max: 2, neutral: 1,
    params: ['pelvisFrequency', 'trunkFrequency', 'armSwingFrequency', 'forearmFrequency', 'handFrequency', 'fingerFrequency', 'armInertia', 'trunkInertia'],
  },
  {
    name: 'agility',
    label: { en: 'Agility', es: 'Reactividad' },
    description: {
      en: 'Starts, brakes and turns faster (more) or slower (less).',
      es: 'Arranca, frena y gira más rápido (más) o más despacio (menos).',
    },
    kind: 'factor', min: 0.4, max: 2.5, neutral: 1,
    params: ['acceleration', 'deceleration', 'turnSpeed', 'turnAcceleration', 'speedEasing'],
  },
  {
    name: 'naturalness',
    label: { en: 'Naturalness', es: 'Naturalidad' },
    description: {
      en: 'Variation from one step to the next (0 = all identical).',
      es: 'Variación entre un paso y el siguiente (0 = todos iguales).',
    },
    kind: 'factor', min: 0, max: 3, neutral: 1,
    params: ['variation'],
  },
];

/** All the basic controls, in the order in which it makes sense to show them. */
export const basicControls: readonly BasicControlInfo[] = [
  ...individualControls,
  {
    name: 'intensity',
    label: { en: 'Intensity', es: 'Intensidad' },
    description: {
      en: 'Overall amplitude of the motion: scales step height, knees, sway and arm swing together.',
      es: 'Amplitud general del movimiento: escala a la vez altura del paso, rodillas, balanceo y braceo.',
    },
    kind: 'factor', min: 0, max: 1.75, neutral: 1,
    params: [...new Set(individualControls.filter((c) => INTENSITY_CONTROLS.includes(c.name)).flatMap((c) => c.params))],
  },
];

/** Values of the basic controls; any missing ones, at their neutral value. */
export type BasicControls = Partial<Record<BasicControlName, number>>;

/** All the controls at their neutral value (they change nothing). */
export const neutralBasicControls: Readonly<Record<BasicControlName, number>> = Object.freeze(
  Object.fromEntries(basicControls.map((c) => [c.name, c.neutral])) as Record<BasicControlName, number>,
);

/**
 * Parameters resulting from applying the basic controls on top of `base` (e.g. the default values or
 * those of a preset). Returns only the parameters the controls move, with their final value, to pass to
 * `setConfig` (or merge with other changes). Out-of-range values are clamped to the range of the control:
 * the result is always a valid configuration.
 *
 * ```ts
 * human.setConfig(applyBasicControls(human.config, { tempo: 1.2, armSwing: 0.5 }));
 * ```
 * Careful: applied on top of `human.config`, it accumulates with whatever was already there; to compute
 * from scratch, apply it on top of `defaultConfig` (or on top of a preset:
 * `{ ...defaultConfig, ...stylePresets.tired }`).
 */
export function applyBasicControls(base: Readonly<ProceduralHumanConfig>, values: BasicControls): ProceduralHumanConfigInput {
  const v = (name: BasicControlName): number => {
    const info = controlInfo(name);
    const value = values[name];
    return value === undefined || !Number.isFinite(value) ? info.neutral : Math.min(Math.max(value, info.min), info.max);
  };
  const intensity = v('intensity');
  // Con la intensidad, cada amplitud sigue dentro del rango de su control (el que está probado).
  const amplitude = (name: BasicControlName): number => Math.min(v(name) * intensity, controlInfo(name).max);
  const tempo = v('tempo');
  const stride = v('stride');
  const stepHeight = amplitude('stepHeight');
  const footRoll = Math.sqrt(stepHeight);
  const knees = amplitude('knees');
  const hipSway = amplitude('hipSway');
  const armSwing = amplitude('armSwing');
  const armSpread = v('armSpread');
  const armForward = v('armForward');
  const lean = v('lean');
  const looseness = v('looseness');
  const agility = v('agility');

  return {
    // Ritmo: velocidades y frecuencias a la par (mismo tamaño de paso). Zancada: pasos más largos
    // con menos frecuencia (misma velocidad).
    walkSpeed: base.walkSpeed * tempo,
    runSpeed: base.runSpeed * tempo,
    runStartSpeed: base.runStartSpeed * tempo,
    runTransition: base.runTransition * tempo,
    crouchMaxSpeed: base.crouchMaxSpeed * tempo,
    stepFrequency: (base.stepFrequency * tempo) / stride,
    minStepFrequency: (base.minStepFrequency * tempo) / stride,
    runStepFrequency: (base.runStepFrequency * tempo) / stride,
    stepLength: base.stepLength * stride,
    runStepLength: base.runStepLength * stride,

    stepHeight: base.stepHeight * stepHeight,
    runStepHeight: base.runStepHeight * stepHeight,
    // El pie se articula más, pero menos que la altura (√): con el talón muy levantado al despegar
    // la punta apuntaría al suelo.
    heelLiftAngle: rollAngle(base.heelLiftAngle, footRoll, MAX_HEEL_LIFT),
    runHeelLiftAngle: rollAngle(base.runHeelLiftAngle, footRoll, MAX_HEEL_LIFT),
    heelStrikeAngle: rollAngle(base.heelStrikeAngle, footRoll, MAX_HEEL_STRIKE),
    runHeelStrikeAngle: rollAngle(base.runHeelStrikeAngle, footRoll, MAX_HEEL_STRIKE),

    stanceKneeBend: base.stanceKneeBend * knees,
    loadingKneeBend: base.loadingKneeBend * knees,
    runCrouch: base.runCrouch * knees,

    lateralShift: Math.min(base.lateralShift * hipSway, 1),
    pelvisRotation: base.pelvisRotation * hipSway,
    pelvisObliquity: base.pelvisObliquity * hipSway,
    pelvisTiltSwing: base.pelvisTiltSwing * hipSway,
    runBounce: base.runBounce * hipSway,

    armSwing: base.armSwing * armSwing,
    runArmSwing: base.runArmSwing * armSwing,
    elbowSwingBend: base.elbowSwingBend * armSwing,
    runElbowSwingBend: base.runElbowSwingBend * armSwing,
    shoulderSwing: base.shoulderSwing * armSwing,
    // Separación: los mismos grados parado, caminando y corriendo (nunca hacia dentro del cuerpo).
    idleArmAbduction: Math.max(base.idleArmAbduction + armSpread, 0),
    armAbduction: Math.max(base.armAbduction + armSpread, 0),
    runArmAbduction: Math.max(base.runArmAbduction + armSpread, 0),
    idleArmForward: base.idleArmForward + armForward,
    armForward: base.armForward + armForward,

    walkLean: base.walkLean + lean,
    runLean: base.runLean + lean,

    // Soltura: muelles más lentos (frecuencia ÷) y más inercia (×).
    pelvisFrequency: base.pelvisFrequency / looseness,
    trunkFrequency: base.trunkFrequency / looseness,
    armSwingFrequency: base.armSwingFrequency / looseness,
    forearmFrequency: base.forearmFrequency / looseness,
    handFrequency: base.handFrequency / looseness,
    fingerFrequency: base.fingerFrequency / looseness,
    armInertia: base.armInertia * looseness,
    trunkInertia: base.trunkInertia * looseness,

    acceleration: base.acceleration * agility,
    deceleration: base.deceleration * agility,
    turnSpeed: base.turnSpeed * agility,
    turnAcceleration: base.turnAcceleration * agility,
    speedEasing: base.speedEasing / agility,

    variation: base.variation * v('naturalness'),
  };
}

function controlInfo(name: BasicControlName): BasicControlInfo {
  return basicControls.find((c) => c.name === name)!;
}
