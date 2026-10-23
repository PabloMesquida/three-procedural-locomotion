import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Bone, type Object3D, Quaternion, Vector3 } from 'three';

import type { FingerBones } from '../src/index.ts';
import { createWorld, simulate } from './helpers/sim.ts';

const DEG = 180 / Math.PI;

/** El dedo vecino del índice: el corazón, o el anular en rigs sin corazón (Mixamo de 3 dedos). */
const neighborFinger = (fingers: FingerBones): Bone[] => (fingers.middle ?? fingers.ring)!;

/** Balanceo del brazo derecho (pedido por las piernas y real) frame a frame mientras camina a `speed`. */
function walkSwing(speed: number, dt = 1 / 60) {
  const world = createWorld();
  const arms = world.human.locomotion.arms;
  simulate(world, 3, [[0, (h) => { h.targetSpeed = speed; }]], { dt });
  const real: number[] = [];
  const target: number[] = [];
  simulate(world, 2, [], { start: 3, dt, onFrame: () => { real.push(arms.swing * DEG); target.push(arms.swingTarget * DEG); } });
  return { world, real, target };
}

/** Media de los dos brazos (grados, positivo = hacia delante): lo que no es balanceo opuesto. */
function meanArm(world: ReturnType<typeof createWorld>): number {
  const arms = (world.human.locomotion.arms as unknown as { arms: { angle: number }[] }).arms;
  return ((arms[0].angle + arms[1].angle) / 2) * DEG;
}

describe('brazos', () => {
  it('se balancean de forma continua, sin quedarse quietos en los extremos (regresión: mesetas de 0,2 s)', () => {
    const { real } = walkSwing(1);
    const velocity = real.slice(1).map((x, i) => x - real[i]);
    const acceleration = velocity.slice(1).map((x, i) => x - velocity[i]);
    const still = velocity.filter((v) => Math.abs(v) < 0.05).length;
    // Antes: ~24 de 119 frames parados y cambios de 0,6°/frame².
    assert.ok(still <= 8, `frames con el brazo parado: ${still}/${velocity.length}`);
    assert.ok(Math.max(...acceleration.map(Math.abs)) < 0.4, `cambio brusco ${Math.max(...acceleration.map(Math.abs)).toFixed(2)}°/frame²`);
  });

  it('siguen a las piernas con su amplitud y un pequeño retraso (peso)', () => {
    const { real, target } = walkSwing(1);
    assert.ok(Math.max(...real) > 0.85 * Math.max(...target), `amplitud ${Math.max(...real).toFixed(1)}° de ${Math.max(...target).toFixed(1)}°`);
    let best = -Infinity;
    let lag = 0;
    for (let l = 0; l < 30; l++) {
      let c = 0;
      for (let i = 0; i + l < real.length; i++) c += target[i] * real[i + l];
      if (c > best) [best, lag] = [c, l];
    }
    const ms = (lag / 60) * 1000;
    assert.ok(ms >= 30 && ms <= 120, `retraso ${ms.toFixed(0)} ms`);
  });

  it('por inercia se quedan atrás al acelerar y se adelantan al frenar', () => {
    const world = createWorld();
    simulate(world, 1.5, [[0, (h) => { h.targetSpeed = 3; }]]);
    assert.ok(meanArm(world) < -1, `acelerando: ${meanArm(world).toFixed(1)}°`);
    simulate(world, 2, [], { start: 1.5 });
    simulate(world, 0.5, [[3.5, (h) => { h.targetSpeed = 0; }]], { start: 3.5 });
    assert.ok(meanArm(world) > 1, `frenando: ${meanArm(world).toFixed(1)}°`);
    simulate(world, 3, [], { start: 4 });
    assert.ok(Math.abs(meanArm(world)) < 0.5, `parado: ${meanArm(world).toFixed(1)}°`);
  });

  it('el movimiento no depende de los fps y es estable con cualquier frecuencia', () => {
    const a = walkSwing(1, 1 / 60).real;
    const b = walkSwing(1, 1 / 20).real;
    // Mismo instante final (2 s): 120 frames a 60 fps y 40 a 20 fps.
    assert.ok(Math.abs(a[a.length - 1] - b[b.length - 1]) < 1, `60 fps ${a[a.length - 1].toFixed(2)}° vs 20 fps ${b[b.length - 1].toFixed(2)}°`);
    const world = createWorld({ human: { config: { armSwingFrequency: 1000 } } });
    simulate(world, 2, [[0, (h) => { h.targetSpeed = 1; }]], { dt: 1 / 20 });
    assert.ok(Number.isFinite(world.human.locomotion.arms.swing), 'balanceo no finito');
  });

  it('hombro, antebrazo, mano y dedos forman una cadena: el hombro se adelanta y los dedos llegan los últimos', () => {
    const world = createWorld();
    const arm = (world.human.locomotion.arms as unknown as { arms: ArmState[] }).arms.find((a) => a.sign > 0)!;
    simulate(world, 3, [[0, (h) => { h.targetSpeed = 1; }]]);
    const upper: number[] = [];
    const shoulder: number[] = [];
    const forearm: number[] = [];
    const hand: number[] = [];
    const fingers: number[] = [];
    simulate(world, 2, [], {
      start: 3,
      onFrame: () => {
        upper.push(arm.angle * DEG);
        shoulder.push(arm.shoulder.value * DEG);
        forearm.push(arm.forearm.value * DEG);
        hand.push(arm.hand.value * DEG);
        // Ángulo real (en el plano del balanceo) de la primera falange del corazón: la que gira el retraso.
        const middle = neighborFinger(world.human.rig.rightArm!.fingers!);
        const d = middle[1].getWorldPosition(new Vector3()).sub(middle[0].getWorldPosition(new Vector3()));
        const F = world.human.locomotion.body.state.forward;
        fingers.push(Math.atan2(d.dot(F), -d.y) * DEG);
      },
    });
    const lagMs = (a: number[], b: number[]): number => {
      const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
      const [ma, mb] = [mean(a), mean(b)];
      let best = -Infinity;
      let lag = 0;
      for (let l = -15; l < 20; l++) {
        let c = 0;
        for (let i = Math.max(0, -l); i < a.length && i + l < b.length; i++) c += (a[i] - ma) * (b[i + l] - mb);
        if (c > best) [best, lag] = [c, l];
      }
      return (lag / 60) * 1000;
    };
    assert.ok(lagMs(upper, shoulder) < 0, `el hombro debería ir por delante del brazo: ${lagMs(upper, shoulder).toFixed(0)} ms`);
    assert.ok(Math.max(...shoulder) > 2, `el hombro apenas se mueve: ${Math.max(...shoulder).toFixed(1)}°`);
    const forearmLag = lagMs(upper, forearm);
    const handLag = lagMs(upper, hand);
    assert.ok(forearmLag > 0 && handLag > forearmLag, `retrasos: antebrazo ${forearmLag.toFixed(0)} ms, mano ${handLag.toFixed(0)} ms`);
    const fingerLag = lagMs(upper, fingers);
    assert.ok(fingerLag > handLag, `los dedos deberían ir detrás de la mano: ${fingerLag.toFixed(0)} ms (mano ${handLag.toFixed(0)} ms)`);
    const elbow = forearm.map((f, i) => f - upper[i]);
    const wrist = hand.map((h, i) => h - forearm[i]);
    assert.ok(Math.min(...elbow) >= 0 && Math.max(...elbow) - Math.min(...elbow) > 5, `codo ${Math.min(...elbow).toFixed(1)}…${Math.max(...elbow).toFixed(1)}°`);
    assert.ok(Math.max(...wrist.map(Math.abs)) <= 35 && Math.max(...wrist.map(Math.abs)) > 2, `muñeca hasta ${Math.max(...wrist.map(Math.abs)).toFixed(1)}°`);
  });

  it('la mano no da latigazos al correr (regresión: eje de la muñeca mal definido con el codo a 90°)', () => {
    const world = createWorld();
    simulate(world, 3, [[0, (h) => { h.targetSpeed = 3; }]]);
    // Aceleración angular world de cada mano (cambio de su giro entre frames, °/frame²).
    const hands = [world.human.rig.leftArm!.hand, world.human.rig.rightArm!.hand];
    const previous = hands.map((b) => b.getWorldQuaternion(new Quaternion()));
    const spin: (Quaternion | null)[] = [null, null];
    let worst = 0;
    simulate(world, 3, [], {
      start: 3,
      onFrame: () => hands.forEach((b, i) => {
        const q = b.getWorldQuaternion(new Quaternion());
        const w = previous[i].clone().invert().premultiply(q);
        if (spin[i]) worst = Math.max(worst, w.angleTo(spin[i]!) * DEG);
        spin[i] = w;
        previous[i].copy(q);
      }),
    });
    // Antes: picos de ~18°/frame² en cada zancada (la mano giraba de golpe un frame y volvía).
    assert.ok(worst < 5, `aceleración angular de la mano ${worst.toFixed(1)}°/frame²`);
  });

  it('la mano acompaña al antebrazo: la muñeca solo se dobla un poco por el retraso (regresión: mano colgando)', () => {
    const world = createWorld();
    const arm = world.human.rig.leftArm!;
    // Rotación de la mano respecto al antebrazo, en reposo y caminando.
    const relative = (): Quaternion =>
      arm.forearm.getWorldQuaternion(new Quaternion()).invert().multiply(arm.hand.getWorldQuaternion(new Quaternion()));
    world.human.restPose();
    world.model.updateMatrixWorld(true);
    const rest = relative();
    world.human.reset();
    let worst = 0;
    simulate(world, 6, [[0, (h) => { h.targetSpeed = 1.4; }]], {
      onFrame: (t) => { if (t > 3) worst = Math.max(worst, relative().angleTo(rest) * DEG); },
    });
    // Antes: la muñeca se calculaba sobre la orientación de la mano previa a doblar el codo y la mano
    // quedaba colgando, doblada 20–30° respecto al antebrazo.
    assert.ok(worst < 10, `muñeca a ${worst.toFixed(1)}° de su reposo`);
  });

  it('mano relajada: los dedos se doblan hacia la palma (hacia el cuerpo) y se juntan', () => {
    // Modelo con los dedos abiertos en reposo (como el metarig de Rigify): el índice se separa 15°
    // del corazón en el plano de la palma.
    const splay = (model: Object3D, scene: Object3D): void => {
      scene.add(model);
      model.updateMatrixWorld(true);
      if (!model.getObjectByName('mixamorigLeftHandIndex1')) return; // otro modelo (PH_MODEL): se usa tal cual
      for (const side of ['Left', 'Right']) {
        const index = model.getObjectByName(`mixamorig${side}HandIndex1`)!;
        // Rig de Mixamo de 3 dedos (pulgar, índice y anular): el anular hace de vecino del índice.
        const middle = (model.getObjectByName(`mixamorig${side}HandMiddle1`) ?? model.getObjectByName(`mixamorig${side}HandRing1`))!;
        const dirOf = (b: Object3D): Vector3 => b.children[0].getWorldPosition(new Vector3()).sub(b.getWorldPosition(new Vector3())).normalize();
        const before = dirOf(index).angleTo(dirOf(middle));
        // En la T-pose de Mixamo la palma mira hacia abajo: abrir = girar sobre la vertical.
        for (const sign of [1, -1]) {
          const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), sign * 15 * DEG2RAD);
          const world = index.getWorldQuaternion(new Quaternion()).premultiply(q);
          const saved = index.quaternion.clone();
          index.quaternion.copy(index.parent!.getWorldQuaternion(new Quaternion()).invert().multiply(world));
          model.updateMatrixWorld(true);
          if (dirOf(index).angleTo(dirOf(middle)) > before + 10 * DEG2RAD) break;
          index.quaternion.copy(saved);
          model.updateMatrixWorld(true);
        }
      }
    };
    const pose = (fingerCurl: number) => {
      const world = createWorld({ place: splay, human: { config: { fingerCurl, variation: 0 } } });
      simulate(world, 1, []);
      const h = world.human;
      const F = h.locomotion.body.state.forward;
      const R = new Vector3().crossVectors(F, new Vector3(0, 1, 0));
      const out: { medial: number; spread: number }[] = [];
      for (const [arm, sign] of [[h.rig.leftArm!, -1], [h.rig.rightArm!, 1]] as const) {
        const f = arm.fingers!;
        const tipOf = (chain: Bone[]): Vector3 => (chain.at(-1)!.children[0] ?? chain.at(-1)!).getWorldPosition(new Vector3());
        // Separación: dirección de la primera falange de cada dedo.
        const dir = (chain: Bone[]): Vector3 => chain[1].getWorldPosition(new Vector3()).sub(chain[0].getWorldPosition(new Vector3())).normalize();
        // Hacia el cuerpo: −R con la mano derecha, +R con la izquierda.
        const middle = neighborFinger(f);
        out.push({ medial: -tipOf(middle).sub(arm.hand.getWorldPosition(new Vector3())).dot(R) * sign, spread: dir(f.index!).angleTo(dir(middle)) / DEG2RAD });
      }
      return out;
    };
    const open = pose(0);
    const relaxed = pose(1);
    for (let i = 0; i < 2; i++) {
      assert.ok(relaxed[i].medial - open[i].medial > 0.03, `la punta del corazón se acercó ${((relaxed[i].medial - open[i].medial) * 100).toFixed(1)} cm al cuerpo`);
      assert.ok(open[i].spread > 10 && relaxed[i].spread < open[i].spread - 5, `separación índice–corazón ${open[i].spread.toFixed(1)}° → ${relaxed[i].spread.toFixed(1)}°`);
    }
  });

  it('fingerCurl = 0: los dedos quedan como en la pose de reposo del modelo', () => {
    const world = createWorld({ human: { config: { fingerCurl: 0, variation: 0 } } });
    const fingers = Object.values(world.human.rig.rightArm!.fingers!).flat();
    const rest = fingers.map((b) => b.quaternion.clone());
    simulate(world, 1, []);
    // Quieto (sin balanceo), ni la base se mueve: la pose es la del modelo.
    // Componente a componente (angleTo da ~0,02° de ruido con cuaterniones exportados no unitarios).
    fingers.forEach((b, i) => {
      const diff = Math.max(...b.quaternion.toArray().map((x, j) => Math.abs(x - rest[i].toArray()[j])));
      assert.ok(diff < 1e-9, `${b.name}: diferencia ${diff}`);
    });
  });

  it('parado, los brazos cuelgan relajados (idleArmAbduction, idleElbowBend, idleArmForward) y al caminar pasan a su pose', () => {
    const world = createWorld({ human: { config: { variation: 0 } } });
    const c = world.human.config;
    simulate(world, 2, []);
    const still = armAngles(world);
    assert.ok(Math.abs(still.abduction - c.idleArmAbduction) < 0.5 && Math.abs(still.elbow - c.idleElbowBend) < 0.5, `parado: ${JSON.stringify(still)}`);
    assert.ok(Math.abs(still.forward - c.idleArmForward) < 0.5, `parado, brazo ${still.forward.toFixed(1)}° hacia delante`);
    simulate(world, 3, [[2, (h) => { h.targetSpeed = c.walkSpeed; }]], { start: 2 });
    // Caminando el codo oscila con el balanceo: su media está por encima de elbowBend.
    let sum = 0;
    let n = 0;
    simulate(world, 1, [], { start: 5, onFrame: () => { sum += armAngles(world).elbow; n++; } });
    assert.ok(sum / n > c.elbowBend, `caminando, codo medio ${(sum / n).toFixed(1)}°`);
  });

  it('la flexión del codo no depende de cómo esté el codo en la pose de reposo del modelo (regresión: Rigify, +22°)', () => {
    // Modelo con el codo doblado 22° en reposo (como el metarig de Rigify).
    const bent = (model: Object3D, scene: Object3D): void => {
      scene.add(model);
      model.updateMatrixWorld(true);
      for (const side of ['Left', 'Right']) {
        const forearm = model.getObjectByName(`mixamorig${side}ForeArm`);
        if (!forearm) return; // otro modelo (PH_MODEL): se usa tal cual
        forearm.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 22 * DEG2RAD));
      }
      model.updateMatrixWorld(true);
    };
    const world = createWorld({ place: bent, human: { config: { variation: 0 } } });
    simulate(world, 2, []);
    const { elbow } = armAngles(world);
    assert.ok(Math.abs(elbow - world.human.config.idleElbowBend) < 0.5, `codo ${elbow.toFixed(1)}°`);
  });
});

/**
 * Brazo derecho: separación hacia fuera respecto a la vertical, inclinación hacia delante (negativa = hacia
 * atrás) y flexión del codo (grados). El personaje de los tests mira hacia −Z.
 */
function armAngles(world: ReturnType<typeof createWorld>): { abduction: number; forward: number; elbow: number } {
  const arm = world.human.rig.rightArm!;
  const p = (b: Bone): Vector3 => b.getWorldPosition(new Vector3());
  const upper = p(arm.forearm).sub(p(arm.upperArm)).normalize();
  const fore = p(arm.hand).sub(p(arm.forearm)).normalize();
  return { abduction: Math.atan2(Math.abs(upper.x), -upper.y) / DEG2RAD, forward: Math.atan2(-upper.z, -upper.y) / DEG2RAD, elbow: upper.angleTo(fore) / DEG2RAD };
}

const DEG2RAD = Math.PI / 180;

interface ArmState {
  sign: number;
  angle: number;
  shoulder: { value: number };
  forearm: { value: number };
  hand: { value: number };
}
