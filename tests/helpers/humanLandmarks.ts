import { Vector3 } from 'three';

import type { ArmBones, ProceduralHuman, Side } from '../../src/index.ts';
import { analyzeGait, type GaitAnalysis, type Landmarks, type LandmarkSeries } from './gaitAnalysis.ts';
import { createWorld, simulate, type WorldOptions } from './sim.ts';

const pos = (o: { getWorldPosition(v: Vector3): Vector3 }): Vector3 => o.getWorldPosition(new Vector3());
const sides = <T>(f: (side: Side) => T): Record<Side, T> => ({ left: f('left'), right: f('right') });

/** Extremo de la mano: la media de las bases de los dedos (sin el pulgar), o su primer hijo. */
function handEnd(arm: ArmBones): Vector3 {
  const bases = Object.entries(arm.fingers ?? {})
    .filter(([name, bones]) => name !== 'thumb' && bones.length > 0)
    .map(([, bones]) => pos(bones[0]));
  if (bases.length > 0) return bases.reduce((sum, p) => sum.add(p), new Vector3()).divideScalar(bases.length);
  const child = arm.hand.children[0];
  return child ? pos(child) : pos(arm.hand);
}

/** Los puntos del análisis de marcha en la pose actual del personaje. */
export function humanLandmarks(human: ProceduralHuman): Landmarks {
  const rig = human.rig;
  const arm = (side: Side) => (side === 'left' ? rig.leftArm : rig.rightArm)!;
  return {
    pelvis: pos(rig.hips),
    chest: pos(rig.neck ?? rig.chest ?? rig.hips),
    head: pos(rig.head ?? rig.neck ?? rig.hips),
    hip: sides((s) => pos(rig[s].thigh)),
    knee: sides((s) => pos(rig[s].shin)),
    ankle: sides((s) => pos(rig[s].foot)),
    toe: sides((s) => pos(rig[s].toe ?? rig[s].foot)),
    shoulder: sides((s) => pos(arm(s).upperArm)),
    elbow: sides((s) => pos(arm(s).forearm)),
    wrist: sides((s) => pos(arm(s).hand)),
    hand: sides((s) => handEnd(arm(s))),
  };
}

/** Simula al personaje de los tests caminando (o corriendo) en línea recta a `speed` (m/s) y analiza su marcha. */
export function analyzeHumanGait(
  speed: number,
  options: WorldOptions = {},
  seconds = 8,
): { series: LandmarkSeries; analysis: GaitAnalysis; legLength: number } {
  const world = createWorld(options);
  const human = world.human;
  human.restPose();
  const rest = humanLandmarks(human);
  human.reset();
  const dt = 1 / 120;
  simulate(world, 4, [[0, (h) => { h.targetSpeed = speed; }]], { dt });
  const frames = [humanLandmarks(human)];
  simulate(world, seconds, [], { dt, start: 4, onFrame: () => frames.push(humanLandmarks(human)) });
  const series: LandmarkSeries = { dt, legLength: human.legLength, rest, frames };
  return { series, analysis: analyzeGait(series), legLength: human.legLength };
}
