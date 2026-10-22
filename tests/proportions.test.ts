import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Object3D, Vector3 } from 'three';

import { mapHumanRig, type ProceduralHuman, type Side } from '../src/index.ts';
import { type Proportions, PROPORTION_VARIANTS, reshape } from './helpers/proportions.ts';
import { createWorld, DEG, MODEL_MAPPING, MODEL_PATH, type Recorder, simulate } from './helpers/sim.ts';
import { loadSkeleton } from './helpers/skeleton.ts';

/**
 * Tirones de caderas (m/frame²). Caminando, el del modelo de los tests en este recorrido (que
 * incluye arrancar y girar) es ~6,3. Corriendo (incluida la transición desde caminar), ~18 en todas
 * las variantes (antes de redondear el despegue y el aterrizaje, 21–31 según la variante). Los
 * límites lo fijan para que no empeore.
 */
const WALK_JERK = 0.007;
const RUN_JERK = 0.025;

/** Flexión de la rodilla (grados). */
function kneeBend(human: ProceduralHuman, side: Side): number {
  const p = (o: { getWorldPosition(v: Vector3): Vector3 }) => o.getWorldPosition(new Vector3());
  const hip = p(human.rig[side].thigh);
  const knee = p(human.rig[side].shin);
  const ankle = p(human.rig[side].foot);
  return 180 - hip.sub(knee).angleTo(ankle.sub(knee)) / DEG;
}

// Cada variante cambia una proporción del esqueleto de los tests (o varias) y hace el mismo
// recorrido: parado, caminar, girar, correr, agacharse, parar, saltar e ir a un punto. Se exige lo
// mismo que al modelo de los tests: que la marcha sea limpia y que el cuerpo no se desplome.
describe('proporciones distintas (esqueletos generados)', () => {
  it('el generador cambia las proporciones pedidas y deja los pies en el suelo', () => {
    const measure = (proportions: Proportions) => {
      const model = loadSkeleton(MODEL_PATH);
      reshape(proportions)(model);
      const { rig } = mapHumanRig(model, MODEL_MAPPING);
      const p = (o: Object3D) => o.getWorldPosition(new Vector3());
      const L = rig.left;
      const arm = rig.leftArm!;
      return {
        thigh: p(L.thigh).distanceTo(p(L.shin)),
        shin: p(L.shin).distanceTo(p(L.foot)),
        torso: p(rig.hips).distanceTo(p(rig.neck!)),
        hips: p(rig.left.thigh).distanceTo(p(rig.right.thigh)),
        arm: p(arm.upperArm).distanceTo(p(arm.hand)),
        foot: Math.hypot(p(L.toe!).x - p(L.foot).x, p(L.toe!).z - p(L.foot).z),
        // Media de los dos tobillos: es lo que el generador mantiene (un rig asimétrico los deja algo distintos).
        ankleY: (p(L.foot).y + p(rig.right.foot).y) / 2,
      };
    };
    const base = measure({});
    const ratio = (proportions: Proportions, key: keyof typeof base) => measure(proportions)[key] / base[key];
    const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 0.02, `${what}: ${a.toFixed(3)} (esperado ${b})`);
    near(ratio({ legs: 1.2 }, 'thigh'), 1.2, 'muslo');
    near(ratio({ legs: 1.2 }, 'shin'), 1.2, 'tibia');
    near(ratio({ thigh: 0.87 }, 'thigh'), 0.87, 'muslo');
    near(ratio({ thigh: 0.87 }, 'shin'), 1, 'tibia sin tocar');
    // El torso medido va de las caderas al cuello: incluye el tramo (fijo) hasta la primera vértebra.
    assert.ok(ratio({ torso: 1.25 }, 'torso') > 1.2, 'torso');
    near(ratio({ hips: 1.5 }, 'hips'), 1.5, 'caderas');
    // Del hombro a la muñeca, en línea recta (codo casi recto en reposo).
    assert.ok(Math.abs(ratio({ arms: 1.2 }, 'arm') - 1.2) < 0.03, 'brazos');
    near(ratio({ feet: 1.25 }, 'foot'), 1.25, 'pie');
    for (const proportions of Object.values(PROPORTION_VARIANTS)) {
      const dy = measure(proportions).ankleY - base.ankleY;
      assert.ok(Math.abs(dy) < 1e-6, `tobillos fuera del suelo (${dy} m): ${JSON.stringify(proportions)}`);
    }
  });

  for (const [name, proportions] of Object.entries(PROPORTION_VARIANTS)) {
    it(name, () => {
      const world = createWorld({ prepare: reshape(proportions) });
      const h = world.human;
      // De pie, la rodilla queda con `standKneeBend`, o con la flexión de la pose de reposo si el
      // modelo la tiene más doblada (nunca se estira más allá de su reposo).
      const rest = (kneeBend(h, 'left') + kneeBend(h, 'right')) / 2;
      simulate(world, 2, []);
      const standing = (kneeBend(h, 'left') + kneeBend(h, 'right')) / 2;
      const expectedKnee = Math.max(h.config.standKneeBend, rest);

      const walk = simulate(world, 6, [[2, (x) => { x.targetSpeed = 1; }]], { start: 2 });
      const walkSteady = simulate(world, 3, [], { start: 8 });
      const turn = simulate(world, 4, [[11, (x) => { x.targetHeading = 90 * DEG; }]], { start: 11 });
      const run = simulate(world, 5, [[15, (x) => { x.targetSpeed = 3; }]], { start: 15 });
      const runSteady = simulate(world, 3, [], { start: 20 });
      const crouch = simulate(world, 5, [[23, (x) => { x.targetSpeed = 0.6; x.targetCrouch = 1; }]], { start: 23 });
      const stop = simulate(world, 4, [[28, (x) => { x.targetCrouch = 0; x.targetSpeed = 0; }]], { start: 28 });
      const jump = simulate(world, 3, [[32, (x) => x.jump()]], { start: 32 });
      let arrived = false;
      h.on('arrive', () => { arrived = true; });
      const move = simulate(world, 12, [[35, (x) => x.moveTo(new Vector3(x.position.x - 3, 0, x.position.z + 4))]], { start: 35 });
      const all: Recorder[] = [walk, walkSteady, turn, run, runSteady, crouch, stop, jump, move];

      assert.ok(all.every((r) => r.finiteOK && r.alternates), all.map((r) => r.liftoffs).join(' / '));
      assert.ok(Math.max(...all.map((r) => r.slip)) < 1e-6, 'un pie apoyado desliza');
      assert.ok(Math.max(...all.map((r) => r.stanceIK)) < 0.001, 'el IK no llega al pie apoyado');
      const toe = Math.min(...all.map((r) => r.toeClearance));
      assert.ok(toe > -0.005, `la punta roza el suelo: ${(toe * 1000).toFixed(1)} mm`);
      assert.ok(Math.abs(standing - expectedKnee) < 2, `de pie, rodillas a ${standing.toFixed(1)}° (esperado ${expectedKnee.toFixed(1)}°)`);
      assert.ok(walkSteady.hipDrop > -0.1, `caminando, caderas ${walkSteady.hipDrop.toFixed(3)} × pierna`);
      assert.ok(runSteady.hipDrop > -0.2, `corriendo, caderas ${runSteady.hipDrop.toFixed(3)} × pierna`);
      const walkJerk = Math.max(walk.hipJerk, walkSteady.hipJerk, turn.hipJerk);
      assert.ok(walkJerk < WALK_JERK, `caminando, tirón de caderas ${(walkJerk * 1000).toFixed(1)} mm/frame²`);
      const runJerk = Math.max(run.hipJerk, runSteady.hipJerk);
      assert.ok(runJerk < RUN_JERK, `corriendo, tirón de caderas ${(runJerk * 1000).toFixed(1)} mm/frame²`);
      assert.ok(arrived && h.gaitMode === 'idle', 'no llegó al destino o no quedó quieto');
    });
  }
});
