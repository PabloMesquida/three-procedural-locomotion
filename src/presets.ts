import type { ProceduralHumanConfigInput } from './config.ts';

/**
 * Ready-to-use walking styles: sets of parameters on top of the default values. Lengths are those of the
 * reference character (scaled with `bodyScale` like the rest of the configuration).
 *
 *   createProceduralHuman({ ..., preset: 'tired' })            // at creation
 *   human.applyPreset('athletic')                               // at runtime
 *   createProceduralHuman({ ..., preset: 'heavy', config: { walkSpeed: 1 } })  // config wins
 */
export const stylePresets = {
  /** Tired: short, low steps (shuffling), leaning trunk, arms nearly still, slow to react. */
  tired: {
    walkSpeed: 0.8,
    runSpeed: 2.2,
    acceleration: 0.8,
    deceleration: 1.8,
    stepFrequency: 1.7,
    minStepFrequency: 1.2,
    stepLength: 0.55,
    stepHeight: 0.023,
    heelLiftAngle: 15,
    heelStrikeAngle: 6,
    walkLean: 15,
    pelvisTilt: 5,
    lateralShift: 0.35,
    armSwing: 6,
    armAbduction: 8,
    elbowBend: 8,
    idleArmAbduction: 5,
    idleElbowBend: 6,
    elbowSwingBend: 5,
    headStabilization: 0.5,
    turnSpeed: 45,
    jumpSpeed: 2.4,
  },
  /**
   * Sneaky: slow, short and high steps with long stance, trunk forward, arms close to the body, very steady
   * head.
   */
  sneaky: {
    walkSpeed: 0.7,
    runSpeed: 2.5,
    acceleration: 1.2,
    deceleration: 3,
    stepFrequency: 1.5,
    minStepFrequency: 1.1,
    stepLength: 0.5,
    stepHeight: 0.059,
    dutyFactor: 0.68,
    heelLiftAngle: 30,
    heelStrikeAngle: 3,
    walkLean: 18,
    lateralShift: 0.15,
    armSwing: 4,
    armAbduction: 16,
    elbowBend: 45,
    idleArmAbduction: 12,
    idleElbowBend: 40,
    elbowSwingBend: 5,
    headStabilization: 0.95,
    crouchDepth: 0.4,
  },
  /**
   * Athletic: faster and more responsive, long strides, leaning run with lots of arm swing, jumps higher and
   * turns quickly.
   */
  athletic: {
    walkSpeed: 1.3,
    runSpeed: 4.5,
    acceleration: 3,
    deceleration: 4,
    stepFrequency: 2.1,
    stepLength: 0.85,
    stepHeight: 0.054,
    runStepFrequency: 3.2,
    runStepHeight: 0.28,
    runLean: 12,
    armSwing: 18,
    runArmSwing: 45,
    jumpSpeed: 4,
    // Gira rápido de pie o despacio; a toda velocidad lo limita maxLateralAcceleration (curvas más abiertas).
    turnSpeed: 120,
    turnAcceleration: 360,
    crouchMaxSpeed: 1.2,
  },
  /**
   * Heavy: wide stance, marked side-to-side sway, slow and low steps, arms held out, starts and stops slowly.
   */
  heavy: {
    walkSpeed: 0.9,
    runSpeed: 2.4,
    acceleration: 0.9,
    deceleration: 1.5,
    stepFrequency: 1.6,
    minStepFrequency: 1.2,
    stepLength: 0.6,
    stepWidth: 0.3,
    stepHeight: 0.032,
    heelStrikeAngle: 8,
    lateralShift: 0.5,
    pelvisObliquity: 7,
    pelvisRotation: 8,
    armAbduction: 22,
    idleArmAbduction: 18,
    armSwing: 11,
    jumpSpeed: 2.4,
    turnSpeed: 45,
  },
} as const satisfies Record<string, ProceduralHumanConfigInput>;

/** Name of a predefined walking style. */
export type StylePreset = keyof typeof stylePresets;
