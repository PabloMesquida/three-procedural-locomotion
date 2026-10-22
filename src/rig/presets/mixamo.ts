import type { HumanRigMapping } from '../HumanRig.ts';

/**
 * Mapping for rigs with Mixamo naming (`mixamorig:*`).
 * It uses the names as GLTFLoader leaves them (without `:`), which are the ones `inspectSkeleton` shows.
 */
export const mixamoMapping: HumanRigMapping = {
  hips: 'mixamorigHips',
  left: {
    thigh: 'mixamorigLeftUpLeg',
    shin: 'mixamorigLeftLeg',
    foot: 'mixamorigLeftFoot',
    toe: 'mixamorigLeftToeBase',
  },
  right: {
    thigh: 'mixamorigRightUpLeg',
    shin: 'mixamorigRightLeg',
    foot: 'mixamorigRightFoot',
    toe: 'mixamorigRightToeBase',
  },
  spine: 'mixamorigSpine',
  chest: 'mixamorigSpine2',
  neck: 'mixamorigNeck',
  head: 'mixamorigHead',
  leftArm: {
    shoulder: 'mixamorigLeftShoulder',
    upperArm: 'mixamorigLeftArm',
    forearm: 'mixamorigLeftForeArm',
    hand: 'mixamorigLeftHand',
    fingers: {
      thumb: ['mixamorigLeftHandThumb1', 'mixamorigLeftHandThumb2', 'mixamorigLeftHandThumb3'],
      index: ['mixamorigLeftHandIndex1', 'mixamorigLeftHandIndex2', 'mixamorigLeftHandIndex3'],
      middle: ['mixamorigLeftHandMiddle1', 'mixamorigLeftHandMiddle2', 'mixamorigLeftHandMiddle3'],
      ring: ['mixamorigLeftHandRing1', 'mixamorigLeftHandRing2', 'mixamorigLeftHandRing3'],
      pinky: ['mixamorigLeftHandPinky1', 'mixamorigLeftHandPinky2', 'mixamorigLeftHandPinky3'],
    },
  },
  rightArm: {
    shoulder: 'mixamorigRightShoulder',
    upperArm: 'mixamorigRightArm',
    forearm: 'mixamorigRightForeArm',
    hand: 'mixamorigRightHand',
    fingers: {
      thumb: ['mixamorigRightHandThumb1', 'mixamorigRightHandThumb2', 'mixamorigRightHandThumb3'],
      index: ['mixamorigRightHandIndex1', 'mixamorigRightHandIndex2', 'mixamorigRightHandIndex3'],
      middle: ['mixamorigRightHandMiddle1', 'mixamorigRightHandMiddle2', 'mixamorigRightHandMiddle3'],
      ring: ['mixamorigRightHandRing1', 'mixamorigRightHandRing2', 'mixamorigRightHandRing3'],
      pinky: ['mixamorigRightHandPinky1', 'mixamorigRightHandPinky2', 'mixamorigRightHandPinky3'],
    },
  },
};
