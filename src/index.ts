/**
 * three-procedural-locomotion — procedural human locomotion for Three.js.
 *
 * Main API: `createProceduralHuman` / `ProceduralHuman`.
 * The rest (rig, ground, IK, controllers) is exported for advanced uses.
 * The visual debugging helpers are in `three-procedural-locomotion/debug`.
 */

// ---------- API principal ----------
export {
  createProceduralHuman,
  ProceduralHuman,
  type ProceduralHumanEvent,
  type ProceduralHumanEventMap,
  type ProceduralHumanOptions,
} from './ProceduralHuman.ts';
export { type StylePreset, stylePresets } from './presets.ts';
export type { Language, LocalizedText } from './i18n.ts';
export {
  applyBasicControls,
  type BasicControlInfo,
  type BasicControlName,
  type BasicControls,
  basicControls,
  neutralBasicControls,
} from './tuning/basicControls.ts';
export {
  ACCELERATION_PARAMS,
  CONSTRUCTION_ONLY_PARAMS,
  ConfigError,
  defaultConfig,
  LENGTH_PARAMS,
  PER_ACCELERATION_PARAMS,
  REFERENCE_LEG_LENGTH,
  SPEED_PARAMS,
  scaleConfig,
  type ProceduralHumanConfig,
  type ProceduralHumanConfigInput,
  resolveConfig,
  validateConfig,
} from './config.ts';

// ---------- Rig ----------
export {
  type ArmBones,
  type ArmMapping,
  estimateForward,
  FINGER_NAMES,
  type FingerBones,
  type FingerMapping,
  type FingerName,
  type HumanRig,
  type HumanRigMapping,
  type LegBones,
  type LegMapping,
  measureLegLength,
  type Side,
} from './rig/HumanRig.ts';
export { mapHumanRig, RigMappingError, type RigMappingResult } from './rig/RigMapper.ts';
export { checkModel } from './rig/checkModel.ts';
export { type BoneInfo, inspectSkeleton, type SkeletonReport } from './rig/inspectSkeleton.ts';
export { mixamoMapping } from './rig/presets/mixamo.ts';
export { rigifyMapping } from './rig/presets/rigify.ts';

// ---------- Suelo ----------
export { createGroundHit, type GroundDetector, type GroundHit, RaycastGroundDetector } from './terrain/GroundDetector.ts';
export { StaticGroundDetector } from './terrain/StaticGroundDetector.ts';
export { createSurfaceHit, RaycastSurfaceDetector, type SurfaceDetector, type SurfaceHit } from './terrain/SurfaceDetector.ts';
export type { TouchOptions, TouchPhase } from './body/TouchController.ts';

// ---------- Avanzado: bloques internos ----------
export { LocomotionController } from './locomotion/LocomotionController.ts';
export { defaultLocomotionConfig, type LocomotionConfig } from './locomotion/LocomotionConfig.ts';
export { defaultMoveToConfig, type MoveToConfig, MoveToController } from './navigation/MoveToController.ts';
export type { FootPhase, FootTarget } from './locomotion/FootTarget.ts';
export type { GaitMode } from './locomotion/GaitController.ts';
export type { JumpPhase } from './locomotion/JumpController.ts';
export type { BodyState } from './body/BodyController.ts';
export { LegIK } from './ik/LegIK.ts';
export { TwoBoneIK, type TwoBoneIKInput, type TwoBoneIKResult } from './ik/TwoBoneIK.ts';
export {
  defaultFootPlacementConfig,
  FootPlacement,
  type FootPlacementConfig,
  type FootGroundState,
} from './terrain/FootPlacement.ts';
export { setWorldPosition, setWorldQuaternion } from './core/transforms.ts';
