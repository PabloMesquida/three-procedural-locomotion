import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, Mesh, MeshBasicMaterial, Vector3 } from 'three';

import { type GroundDetector, RaycastGroundDetector, StaticGroundDetector } from '../src/index.ts';
import { createWorld, simulate, type World } from './helpers/sim.ts';

const DT = 1 / 60;

/** Consultas al suelo por frame del personaje (solo las suyas: sin el Recorder), con cualquiera de los dos detectores. */
function raycastsPerFrame(world: World, drive: (frame: number) => void, warmup = 120, frames = 600): number {
  const { human } = world;
  let frame = 0;
  const step = (): void => {
    drive(frame++);
    human.update(DT);
  };
  for (let i = 0; i < warmup; i++) step();
  const protos = [RaycastGroundDetector.prototype, StaticGroundDetector.prototype] as GroundDetector[];
  const originals = protos.map((proto) => proto.castDown);
  let calls = 0;
  protos.forEach((proto, i) => {
    proto.castDown = function (this: GroundDetector, ...args: Parameters<GroundDetector['castDown']>) {
      calls++;
      return originals[i].apply(this, args);
    };
  });
  try {
    for (let i = 0; i < frames; i++) step();
  } finally {
    protos.forEach((proto, i) => { proto.castDown = originals[i]; });
  }
  return calls / frames;
}

describe('raycasts', () => {
  // Presupuesto (regresión de rendimiento): 1 por frame es la sonda de la raíz; caminando y
  // corriendo se suman los del inicio de cada paso. Parado, la comprobación de si los pies
  // están recolocados (4 raycasts) se hacía cada frame: ahora solo si se mueve la raíz o cada 0,25 s.
  it('por frame: parado ≤ 1,3, caminando ≤ 1,5, corriendo ≤ 1,75', () => {
    const budget = { parado: [0, 1.3], caminando: [1, 1.5], corriendo: [3, 1.75] } as const;
    for (const [mode, [speed, max]] of Object.entries(budget)) {
      const world = createWorld();
      const perFrame = raycastsPerFrame(world, () => { world.human.targetSpeed = speed; });
      assert.ok(perFrame <= max, `${mode}: ${perFrame.toFixed(2)} raycasts/frame (máx. ${max})`);
    }
  });

  it('parado, si aparece un escalón bajo la punta de un pie, se recoloca', () => {
    // Suelo que cambia: con el raycast de Three (StaticGroundDetector necesitaría rebuild()).
    const world = createWorld({ staticGround: false });
    simulate(world, 1);
    assert.equal(world.human.gaitMode, 'idle');
    // Escalón de 6 cm solo bajo la punta izquierda (no bajo la raíz: el cuerpo no se mueve).
    const toe = world.human.rig.left.toe!.getWorldPosition(new Vector3());
    const step = new Mesh(new BoxGeometry(0.1, 0.06, 0.12), new MeshBasicMaterial());
    step.position.set(toe.x, 0.03, toe.z);
    world.terrain.add(step);
    world.terrain.updateMatrixWorld(true);
    const r = simulate(world, 1.5, [], { start: 1 });
    assert.ok(r.liftoffs.includes('L'), `no dio un paso con el pie izquierdo (despegues: "${r.liftoffs}")`);
  });

  it('parado, cambiar stepWidth en ejecución lo recoloca', () => {
    const world = createWorld();
    simulate(world, 1);
    assert.equal(world.human.gaitMode, 'idle');
    const r = simulate(world, 1.5, [[1, (h) => h.setConfig({ stepWidth: 0.45 })]], { start: 1 });
    assert.ok(r.liftoffs.length > 0, 'no se recolocó');
  });
});
