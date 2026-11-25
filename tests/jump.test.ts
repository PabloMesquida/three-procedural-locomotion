import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoxGeometry, Mesh, MeshBasicMaterial, Quaternion } from 'three';

import { computeJumpProfile, defaultConfig } from '../src/index.ts';
import { humanLandmarks } from './helpers/humanLandmarks.ts';
import { createWorld, DEG, simulate } from './helpers/sim.ts';

const g = defaultConfig.gravity;
const v = defaultConfig.jumpSpeed;

describe('saltar', () => {
  it('quieto: altura y tiempo en el aire balísticos, eventos y vuelta a quieto', () => {
    const world = createWorld();
    const { human } = world;
    const events: string[] = [];
    let impact = 0;
    human.on('liftoff', () => events.push('liftoff'));
    human.on('land', (e) => { events.push('land'); impact = e.impactSpeed; });
    let apex = 0;
    let air = 0;
    const r = simulate(world, 3, [[0.5, (h) => assert.ok(h.jump())]], {
      onFrame: () => {
        if (human.airborne) { air += 1 / 60; apex = Math.max(apex, human.position.y); }
      },
    });
    assert.deepEqual(events, ['liftoff', 'land']);
    // Altura v²/2g y tiempo 2v/g, con el margen de la fracción de frame del despegue.
    assert.ok(Math.abs(apex - (v * v) / (2 * g)) < 0.04, `altura ${apex.toFixed(3)} m`);
    assert.ok(Math.abs(air - (2 * v) / g) < 0.04, `en el aire ${air.toFixed(3)} s`);
    assert.ok(Math.abs(impact - v) < 0.1, `impacto ${impact} m/s`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
    assert.equal(human.gaitMode, 'idle');
    assert.equal(human.jumpPhase, 'GROUNDED');
    assert.ok(Math.hypot(human.position.x, human.position.z) < 0.05, 'se desplazó al saltar quieto');
  });

  it('corriendo: salta ~2 m y sigue corriendo sin desplomarse (regresión: re-fasado del gait al aterrizar)', () => {
    const world = createWorld();
    const { human } = world;
    let takeoffZ = 0;
    let landZ = 0;
    human.on('liftoff', () => { takeoffZ = human.position.z; });
    human.on('land', () => { landZ = human.position.z; });
    const r = simulate(world, 6, [[0, (h) => { h.targetSpeed = 3; }], [3, (h) => h.jump()]]);
    // Distancia = velocidad horizontal × tiempo en el aire (el del perfil: corriendo sube menos que jumpSpeed).
    const flight = human.locomotion.jumping.profile.flight;
    const distance = Math.abs(landZ - takeoffZ);
    assert.ok(Math.abs(distance - 3 * flight) < 0.12, `distancia ${distance.toFixed(2)} m (3 m/s × ${flight.toFixed(2)} s)`);
    assert.ok(flight < (2 * v) / g, 'corriendo, jump() sube como parado');
    assert.ok(Math.abs(human.speed - 3) < 1e-6, 'no siguió corriendo');
    assert.ok(r.hipDrop > -0.4, `caderas ${r.hipDrop.toFixed(3)} × pierna (el error antiguo llegaba a -0,88)`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
  });

  it('agachado: salta y vuelve a quedar agachado', () => {
    const world = createWorld();
    const { human } = world;
    const r = simulate(world, 5, [[0, (h) => { h.targetCrouch = 1; }], [1.5, (h) => assert.ok(h.jump())]]);
    assert.equal(human.jumpPhase, 'GROUNDED');
    assert.equal(human.gaitMode, 'idle');
    assert.ok(Math.abs(human.crouch - 1) < 1e-9);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
  });

  it('acepta un salto durante la amortiguación (encadenar) y lo rechaza durante la preparación o en el aire', () => {
    const world = createWorld();
    const { human } = world;
    let lands = 0;
    human.on('land', () => lands++);
    const results: string[] = [];
    simulate(world, 6, [[0.5, (h) => assert.ok(h.jump())]], {
      onFrame: () => {
        const phase = human.jumpPhase;
        if (phase === 'TAKEOFF' && !results.some((x) => x.startsWith('TAKEOFF'))) results.push(`TAKEOFF:${human.jump()}`);
        if (phase === 'AIRBORNE' && !results.some((x) => x.startsWith('AIRBORNE'))) results.push(`AIRBORNE:${human.jump()}`);
        if (phase === 'LANDING' && lands === 1 && !results.some((x) => x.startsWith('LANDING'))) results.push(`LANDING:${human.jump()}`);
      },
    });
    assert.deepEqual(results, ['TAKEOFF:false', 'AIRBORNE:false', 'LANDING:true']);
    assert.equal(lands, 2, 'el segundo salto no se completó');
    assert.equal(human.gaitMode, 'idle');
  });

  it('con otro perfil, sube lo que dice el perfil y se agacha menos (el salto sale del perfil)', () => {
    const measure = (height?: number): { apex: number; crouch: number; air: number } => {
      const world = createWorld();
      const { human } = world;
      const loco = human.locomotion;
      let apex = 0;
      let crouch = 0;
      let air = 0;
      const y0 = human.position.y;
      simulate(world, 3, [[0.5, () => { assert.ok(loco.jumping.request(Number.NaN, computeJumpProfile(defaultConfig, { speed: 0, intent: { height } }))); }]], {
        onFrame: () => {
          if (human.airborne) { air += 1 / 60; apex = Math.max(apex, human.position.y - y0); }
          if (human.jumpPhase === 'TAKEOFF') crouch = Math.min(crouch, loco.jumping.hipOffset());
        },
      });
      return { apex, crouch: -crouch, air };
    };
    const low = measure(0.2);
    const ref = measure();
    const p = computeJumpProfile(defaultConfig, { speed: 0, intent: { height: 0.2 } });
    assert.ok(Math.abs(low.apex - 0.2) < 0.03, `subió ${low.apex.toFixed(3)} m`);
    assert.ok(Math.abs(low.air - p.flight) < 0.04, `en el aire ${low.air.toFixed(3)} s`);
    assert.ok(Math.abs(low.crouch - p.crouch) < 0.005 && low.crouch < 0.6 * ref.crouch, `agachado ${low.crouch.toFixed(3)} / ${ref.crouch.toFixed(3)} m`);
  });
});

/** Un salto desde parado con `intent`, frame a frame: rodillas, brazo izquierdo (y a dónde lo lleva el salto), raíz. */
/** Una tarima de STEP m de alto de z = 0 a z = 6, con el personaje a STEP_EDGE m de su borde, mirando hacia él (−Z). */
const STEP = 0.8;
const STEP_EDGE = 0.15;
function stepWorld(): ReturnType<typeof createWorld> {
  const world = createWorld({
    buildTerrain: (g) => {
      const box = new Mesh(new BoxGeometry(4, STEP, 6), new MeshBasicMaterial());
      box.position.set(0, STEP / 2, 3);
      g.add(box);
    },
  });
  world.model.position.set(0, STEP, STEP_EDGE);
  world.model.updateMatrixWorld(true);
  world.human.reset();
  return world;
}

function standingJump(intent?: { distance?: number; height?: number }, speed = 0, world = createWorld()) {
  const { human } = world;
  const loco = human.locomotion;
  const L = human.legLength;
  const chest = human.rig.chest ?? human.rig.spine ?? human.rig.hips;
  const frames: { phase: string; knee: number; kneeL: number; kneeR: number; footYR: number; arm: number; armR: number; ahead: number; target: number; z: number; feet: string; leg: number; trunk: number; footY: number; head: Quaternion; pitch: number; spread: number; t: number }[] = [];
  let liftoff = -1;
  let land = -1;
  human.on('liftoff', () => { liftoff = frames.length; });
  human.on('land', () => { land = frames.length; });
  const at = speed > 0 ? 3 : 0.5;
  const r = simulate(world, at + 2.5, [[0, (h) => { h.targetSpeed = speed; }], [at, (h) => assert.ok(h.jump(intent))]], {
    onFrame: () => {
      const m = humanLandmarks(human);
      const knee = Math.max(...(['left', 'right'] as const).map((s) => m.knee[s].clone().sub(m.hip[s]).angleTo(m.ankle[s].clone().sub(m.knee[s]))));
      const u = m.elbow.left.clone().sub(m.shoulder.left);
      frames.push({
        phase: human.jumpPhase,
        knee: knee / DEG,
        kneeL: m.knee.left.clone().sub(m.hip.left).angleTo(m.ankle.left.clone().sub(m.knee.left)) / DEG,
        kneeR: m.knee.right.clone().sub(m.hip.right).angleTo(m.ankle.right.clone().sub(m.knee.right)) / DEG,
        footYR: m.ankle.right.y,
        // Hacia −Z, adelante (grados).
        arm: Math.atan2(-u.z, -u.y) / DEG,
        armR: Math.atan2(-(m.elbow.right.z - m.shoulder.right.z), -(m.elbow.right.y - m.shoulder.right.y)) / DEG,
        // El tobillo izquierdo por delante del derecho (m, hacia −Z).
        ahead: m.ankle.right.z - m.ankle.left.z,
        target: loco.jumping.armReach(),
        z: human.position.z,
        feet: `${human.footPhase('left')}/${human.footPhase('right')}`,
        leg: (m.pelvis.distanceTo(m.ankle.left) + m.pelvis.distanceTo(m.ankle.right)) / (2 * L),
        trunk: Math.atan2(-(m.chest.z - m.pelvis.z), m.chest.y - m.pelvis.y) / DEG,
        footY: m.ankle.left.y,
        // La cabeza respecto al pecho.
        head: chest.getWorldQuaternion(new Quaternion()).invert().multiply(human.rig.head!.getWorldQuaternion(new Quaternion())),
        // Del tobillo a los dedos, hacia arriba (× pierna: + punta arriba) y los codos separados del cuerpo (m).
        pitch: (m.toe.left.y - m.ankle.left.y) / L,
        spread: Math.abs(m.elbow.left.x - m.pelvis.x) + Math.abs(m.elbow.right.x - m.pelvis.x),
        t: frames.length / 60,
      });
    },
  });
  return { frames, liftoff, land, r, human };
}

/** El tramo más largo de frames seguidos en que la señal casi no cambia (|Δ| < eps). */
function longestStill(values: number[], eps: number): number {
  let run = 0;
  let longest = 0;
  for (let i = 1; i < values.length; i++) {
    run = Math.abs(values[i] - values[i - 1]) < eps ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

describe('en el aire', () => {
  for (const [name, intent, speed] of [['quieto', undefined, 0], ['alto', { height: 0.65 }, 0], ['largo', { distance: 1.5 }, 0], ['caminando', undefined, 1]] as const) {
    it(`${name}: rodillas y tronco sin quedarse quietos, el tuck cerca de lo más alto y los pies sin saltos`, () => {
      const { frames, liftoff, land } = standingJump(intent, speed);
      const air = frames.slice(liftoff + 1, land);
      // Antes: rodillas quietas hasta 16 frames (el tuck sostenido) y el tronco hasta 33 (sin inclinación en el aire).
      assert.ok(longestStill(air.map((f) => f.knee), 0.1) <= 5, `rodillas quietas ${longestStill(air.map((f) => f.knee), 0.1)} frames`);
      assert.ok(longestStill(air.map((f) => f.trunk), 0.05) <= 10, `tronco quieto ${longestStill(air.map((f) => f.trunk), 0.05)} frames`);
      // Desde parado (caminando, de un pie a otro, las piernas van abiertas: ver 'en movimiento').
      if (speed === 0) {
        const shortest = air.reduce((best, f, i) => (f.leg < air[best].leg ? i : best), 0);
        const share = shortest / air.length;
        assert.ok(share > 0.28 && share < 0.65, `el tuck llega al ${(share * 100).toFixed(0)} % del vuelo`);
      }
      // Antes: el pie saltaba hasta 0,26 m en un frame al alcanzar su rayo el suelo (salto alto).
      const y = air.map((f) => f.footY);
      const jerk = Math.max(...y.slice(2).map((v, i) => Math.abs(v - 2 * y[i + 1] + y[i])));
      assert.ok(jerk < 0.06, `el pie saltó ${jerk.toFixed(3)} m/frame²`);
    });
  }

  it('mira hacia donde va a caer y el tronco se inclina hacia el aterrizaje', () => {
    const { frames, liftoff, land } = standingJump();
    const turned = frames[land - 1].head.angleTo(frames[liftoff].head) / DEG;
    assert.ok(turned > 6, `la cabeza giró ${turned.toFixed(1)}° respecto al pecho en el aire`);
    const top = Math.floor((liftoff + land) / 2);
    assert.ok(frames[land - 1].trunk > frames[top].trunk + 2, `tronco ${frames[top].trunk.toFixed(1)}° → ${frames[land - 1].trunk.toFixed(1)}°`);
  });
});

describe('al caer', () => {
  const landing = (frames: ReturnType<typeof standingJump>['frames'], land: number) => frames.slice(land).filter((f) => f.phase === 'LANDING');

  it('las rodillas llegan dobladas y el pico y la amortiguación crecen con la velocidad de caída', () => {
    const cases = [standingJump({ height: 0.1 }), standingJump(), standingJump({ distance: 1 }, 0, stepWorld())];
    const measured = cases.map(({ frames, land, human }) => ({
      contact: frames[land - 1].knee,
      peak: Math.max(...landing(frames, land).map((f) => f.knee)),
      time: landing(frames, land).length / 60,
      impact: human.locomotion.jumping.impactSpeed,
    }));
    // Cayendo en vertical, 15–35°; hacia delante (los pies por delante, con el talón), algo más.
    for (const [i, m] of measured.entries()) assert.ok(m.contact > 15 && m.contact < (i < 2 ? 35 : 55), `rodillas al tocar ${m.contact.toFixed(0)}° (antes ~6°, rectas)`);
    const text = measured.map((m) => `${m.impact.toFixed(1)} m/s: pico ${m.peak.toFixed(0)}°, ${m.time.toFixed(2)} s`).join(' / ');
    assert.ok(measured[0].impact < measured[1].impact && measured[1].impact < measured[2].impact, text);
    assert.ok(measured[0].peak < measured[1].peak && measured[1].peak <= measured[2].peak + 1, text);
    assert.ok(measured[0].time < measured[1].time && measured[1].time < measured[2].time, text);
    // Un saltito, 30–45°; el de referencia (cae a ~3 m/s), 60–90°.
    assert.ok(measured[0].peak > 30 && measured[0].peak < 50 && measured[1].peak > 60 && measured[1].peak < 90, text);
  });

  it('saltando hacia arriba cae con la punta; lejos, con el talón; y enseguida apoya plano', () => {
    const pitchAt = (intent: { distance?: number; height?: number }) => {
      const { frames, land } = standingJump(intent);
      const flat = landing(frames, land).at(-1)!.pitch;
      return { contact: frames[land - 1].pitch - flat, later: frames[land + 12].pitch - flat };
    };
    const up = pitchAt({ height: 0.5 });
    const far = pitchAt({ distance: 1.5 });
    assert.ok(up.contact < -0.005, `saltando alto, la punta ${(up.contact * 100).toFixed(1)} cm·L respecto al pie plano`);
    assert.ok(far.contact > 0.005, `saltando lejos, la punta ${(far.contact * 100).toFixed(1)} cm·L respecto al pie plano`);
    assert.ok(Math.abs(up.later) < 0.003 && Math.abs(far.later) < 0.003, 'no apoyó plano');
  });

  it('saltando hacia abajo, sabe dónde cae: el vuelo y la preparación del aterrizaje son los de esa caída', () => {
    const world = stepWorld();
    const { frames, liftoff, land, human, r } = standingJump({ distance: 1 }, 0, world);
    const p = human.locomotion.jumping.profile;
    assert.ok(Math.abs(p.rise + STEP) < 0.05, `altura del aterrizaje ${p.rise.toFixed(2)} m`);
    assert.ok(Math.abs((land - liftoff) / 60 - p.flight) < 0.04, `vuelo ${((land - liftoff) / 60).toFixed(2)} s (perfil ${p.flight.toFixed(2)} s)`);
    const air = frames.slice(liftoff + 1, land);
    const shortest = air.reduce((best, f, i) => (f.leg < air[best].leg ? i : best), 0);
    assert.ok(shortest / air.length > 0.25 && shortest / air.length < 0.65, `el tuck llega al ${((100 * shortest) / air.length).toFixed(0)} % del vuelo`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
  });

  it('los brazos al caer van por su péndulo y se abren un poco', () => {
    const { frames, land } = standingJump();
    const landed = landing(frames, land);
    const before = frames[land - 1].spread;
    assert.ok(Math.max(...landed.map((f) => f.spread)) > before + 0.02, 'los brazos no se abren al caer');
    const da = landed.slice(1).map((f, i) => f.arm - landed[i].arm);
    const dt = landed.slice(1).map((f, i) => f.target - landed[i].target);
    let best = -Infinity;
    let lag = 0;
    for (let k = 0; k <= 8; k++) {
      let c = 0;
      for (let i = 0; i + k < da.length; i++) c += dt[i] * da[i + k];
      if (c > best) { best = c; lag = k; }
    }
    assert.ok(lag >= 2, `retraso de los brazos al caer: ${lag} frames (escritos de golpe: 0)`);
  });
});

describe('en movimiento', () => {
  it('corriendo, despega siempre con un pie apoyado, se le pida cuando se le pida (espera al próximo apoyo)', () => {
    const results: string[] = [];
    for (let k = 0; k < 8; k++) {
      const world = createWorld();
      const { human } = world;
      let feet = '';
      simulate(world, 4.5, [[0, (h) => { h.targetSpeed = 3; }], [3 + k * 0.04, (h) => assert.ok(h.jump())]], {
        onFrame: () => {
          if (!feet && human.jumpPhase === 'AIRBORNE') feet = `${human.footPhase('left')}/${human.footPhase('right')}`;
        },
      });
      results.push(feet);
    }
    // Antes, pedido con los dos pies en el aire despegaba desde el aire (SWING/SWING): 4 de 12.
    assert.ok(results.every((f) => f.includes('PLANTED') || f.includes('LIFT')), results.join(' '));
  });

  for (const speed of [1, 3]) {
    it(`a ${speed} m/s, de un pie a otro: la rodilla libre arriba, los brazos contra las piernas, y cae sobre la libre y sigue`, () => {
      const { frames, liftoff, land, human, r } = standingJump(undefined, speed);
      const lift = frames[liftoff];
      // Al despegar, un pie apoyado (el de impulso) y el otro en el aire.
      assert.ok(/(PLANTED|LIFT)\/SWING|SWING\/(PLANTED|LIFT)/.test(lift.feet), `pies al despegar: ${lift.feet}`);
      const takeoffLeft = lift.feet.startsWith('PLANTED') || lift.feet.startsWith('LIFT');
      // En el aire, el pie libre por delante y el brazo de su lado, atrás: no en espejo.
      const mid = frames[Math.floor((liftoff + land) / 2)];
      const freeAhead = takeoffLeft ? -mid.ahead : mid.ahead;
      assert.ok(freeAhead > 0.3, `pie libre ${freeAhead.toFixed(2)} m por delante`);
      const freeArm = takeoffLeft ? mid.armR : mid.arm;
      const pushArm = takeoffLeft ? mid.arm : mid.armR;
      assert.ok(pushArm > freeArm + 20, `brazos: el del lado del pie libre ${freeArm.toFixed(0)}°, el otro ${pushArm.toFixed(0)}°`);
      // Cae sobre el libre y sigue andando a su velocidad.
      const touch = frames[land];
      assert.ok(touch.feet.startsWith(takeoffLeft ? 'SWING' : 'PLANTED') || touch.feet.endsWith(takeoffLeft ? 'PLANTED' : 'SWING'), `pies al caer: ${touch.feet}`);
      assert.ok(Math.abs(human.speed - speed) < 0.05 && human.gaitMode === 'walk', `después: ${human.speed.toFixed(2)} m/s, ${human.gaitMode}`);
      assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
    });
  }
});

describe('variación y asimetría', () => {
  const sides = (frames: ReturnType<typeof standingJump>['frames'], from: number, to: number) => {
    const window = frames.slice(from, to);
    return {
      arms: Math.max(...window.map((f) => Math.abs(f.arm - f.armR))),
      knees: Math.max(...window.map((f) => Math.abs(f.kneeL - f.kneeR))),
    };
  };

  it('desde parado no va en espejo: un pie toca el suelo 20–50 ms antes que el otro, y brazos y rodillas difieren', () => {
    const { frames, liftoff, land } = standingJump();
    // Desde la caída, cuántos frames uno de los tobillos sigue más de 2 mm por encima del otro (el que aún no apoyó).
    let late = 0;
    while (Math.abs(frames[land + late].footY - frames[land + late].footYR) > 0.002) late++;
    const gap = late / 60;
    assert.ok(gap >= 0.015 && gap <= 0.06, `un pie toca ${(gap * 1000).toFixed(0)} ms después que el otro (antes, a la vez)`);
    const d = sides(frames, liftoff - 20, land + 20);
    assert.ok(d.arms > 2 && d.knees > 3, `izquierda–derecha: brazos ${d.arms.toFixed(1)}°, rodillas ${d.knees.toFixed(1)}° (antes, 0)`);
  });

  it('con variation 0, en espejo; con la misma semilla, el mismo salto; y cada salto, distinto', () => {
    const still = standingJump(undefined, 0, createWorld({ human: { config: { variation: 0 } } }));
    const d0 = sides(still.frames, still.liftoff - 20, still.land + 20);
    assert.ok(d0.arms < 1e-3 && d0.knees < 1e-3, `sin variación: brazos ${d0.arms}°, rodillas ${d0.knees}°`);
    const a = standingJump();
    const b = standingJump();
    assert.deepEqual(a.frames.map((f) => f.knee), b.frames.map((f) => f.knee), 'la misma semilla no repite el salto');
    // Dos saltos seguidos del mismo personaje: distintos.
    const world = createWorld();
    const { human } = world;
    const diffs: number[] = [];
    let arm = 0;
    // En el aire de cada uno.
    human.on('liftoff', () => { arm = 0; });
    human.on('land', () => { diffs.push(arm); });
    simulate(world, 4, [[0.5, (h) => assert.ok(h.jump())], [2, (h) => assert.ok(h.jump())]], {
      onFrame: () => {
        if (!human.airborne) return;
        const m = humanLandmarks(human);
        const l = m.elbow.left.clone().sub(m.shoulder.left);
        const r = m.elbow.right.clone().sub(m.shoulder.right);
        arm = Math.max(arm, Math.abs(Math.atan2(-l.z, -l.y) - Math.atan2(-r.z, -r.y)) / DEG);
      },
    });
    assert.ok(diffs.length === 2 && Math.abs(diffs[0] - diffs[1]) > 0.5, `izquierda–derecha en cada salto: ${diffs.map((x) => x.toFixed(1)).join(' / ')}°`);
  });
});

describe('saltar desde parado', () => {
  it('con los brazos por encima de la cabeza, las manos no cruzan por delante del pecho ni se sacuden', () => {
    const world = createWorld();
    const { human } = world;
    const arm = human.rig.rightArm!;
    const lateral: number[] = [];
    const turns: number[] = [];
    let previous: Quaternion | null = null;
    let rate: Quaternion | null = null;
    simulate(world, 2, [[0.5, (h) => assert.ok(h.jump({ height: 0.65 }))]], {
      onFrame: () => {
        if (!human.airborne) return;
        const m = humanLandmarks(human);
        lateral.push(Math.abs(m.wrist.right.x - m.pelvis.x));
        const q = arm.hand.getWorldQuaternion(new Quaternion());
        if (previous) {
          const w = previous.clone().invert().premultiply(q);
          if (rate) turns.push(w.angleTo(rate) / DEG);
          rate = w;
        }
        previous = q;
      },
    });
    // Antes, al pasar el brazo por la horizontal la bisagra del codo cambiaba de signo: la mano iba de ~28 a ~9 cm
    // del centro y volvía (15–30°/frame² de sacudida).
    assert.ok(lateral.length > 20, `${lateral.length} frames en el aire`);
    assert.ok(Math.min(...lateral) > 0.7 * lateral[0], `la mano se acercó al centro: ${(Math.min(...lateral) * 100).toFixed(1)} cm (al despegar, ${(lateral[0] * 100).toFixed(1)})`);
    assert.ok(Math.max(...turns) < 8, `la mano se sacudió ${Math.max(...turns).toFixed(1)}°/frame²`);
  });

  it('más alto: más flexión de rodillas al prepararse y los brazos más arriba al despegar', () => {
    const measure = (height?: number) => {
      const { frames, liftoff } = standingJump(height === undefined ? undefined : { height });
      return {
        knee: Math.max(...frames.filter((f) => f.phase === 'TAKEOFF').map((f) => f.knee)),
        arm: Math.max(...frames.slice(liftoff - 5, liftoff + 10).map((f) => f.arm)),
      };
    };
    const [hop, ref, high] = [measure(0.1), measure(), measure(0.65)];
    assert.ok(hop.knee + 10 < ref.knee && ref.knee < high.knee, `rodillas ${hop.knee.toFixed(0)}° / ${ref.knee.toFixed(0)}° / ${high.knee.toFixed(0)}°`);
    assert.ok(hop.arm + 30 < ref.arm && ref.arm < high.arm, `brazos ${hop.arm.toFixed(0)}° / ${ref.arm.toFixed(0)}° / ${high.arm.toFixed(0)}°`);
    // Un saltito, con las rodillas a ~30° (no un agachado grande); el más alto, por encima de la cabeza.
    assert.ok(hop.knee < 45 && high.arm > 120);
  });

  it('los brazos van por su péndulo: con retraso respecto a donde los lleva el salto, y sin saltos', () => {
    const { frames, r } = standingJump();
    const da = frames.slice(1).map((f, i) => f.arm - frames[i].arm);
    const dt = frames.slice(1).map((f, i) => f.target - frames[i].target);
    let best = -Infinity;
    let lag = 0;
    for (let k = 0; k <= 10; k++) {
      let c = 0;
      for (let i = 0; i + k < da.length; i++) c += dt[i] * da[i + k];
      if (c > best) { best = c; lag = k; }
    }
    assert.ok(lag >= 2, `retraso ${lag} frames (escritos de golpe sobre la pose: 0)`);
    const jerk = Math.max(...da.slice(1).map((d, i) => Math.abs(d - da[i])));
    assert.ok(jerk < 8, `brusquedad ${jerk.toFixed(1)}°/frame²`);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
  });

  it('largo: avanza lo pedido, acelera empujando (sin saltos de velocidad) y cae clavado, sin dar pasos', () => {
    const { frames, liftoff, land, r, human } = standingJump({ distance: 1.5 });
    const dz = frames.slice(1).map((f, i) => (frames[i].z - f.z) * 60);
    const flight = frames[liftoff].z - frames[land].z;
    assert.ok(Math.abs(flight - 1.5) < 0.25, `en el aire ${flight.toFixed(2)} m`);
    // Antes del despegue ya se mueve hacia delante (empujando), y la velocidad no salta de golpe.
    assert.ok(dz[liftoff - 2] > 1, `empujando, a ${dz[liftoff - 2].toFixed(2)} m/s`);
    const jump = Math.max(...dz.slice(1).map((v, i) => Math.abs(v - dz[i])));
    assert.ok(jump < 1.2, `la velocidad saltó ${jump.toFixed(2)} m/s en un frame`);
    // Al caer: los dos pies apoyados mientras frena, y frena en poco espacio.
    const landing = frames.slice(land + 1).filter((f) => f.phase === 'LANDING');
    assert.ok(landing.every((f) => f.feet === 'PLANTED/PLANTED'), `pies al caer: ${[...new Set(landing.map((f) => f.feet))].join(', ')}`);
    const slide = frames[land].z - frames.at(-1)!.z;
    assert.ok(slide < 0.6, `se deslizó ${slide.toFixed(2)} m al caer`);
    assert.equal(human.jumpPhase, 'GROUNDED');
    assert.ok(human.speed < 1e-3);
    assert.ok(r.slip < 1e-6 && r.stanceIK < 0.001);
  });
});

describe('con una configuración extrema', () => {
  // La del Laboratorio con la que se sentaba en el suelo (test_03): recogida, hundimiento y amortiguación de 2–4 veces.
  const config = { jumpToeOff: 16, jumpTuck: 0.955, jumpLandingPrep: 0.875, landingAbsorb: 0.12, maxLandingDip: 0.87, landingTime: 1.92 };

  it('no pasa de lo que pueden las piernas: en el aire rodillas hasta ~120° y al caer hasta ~100° (antes 180° y 120°)', () => {
    const { frames, land } = standingJump(undefined, 0, createWorld({ human: { config } }));
    const air = Math.max(...frames.slice(0, land).filter((f) => f.phase === 'AIRBORNE').map((f) => f.knee));
    const landing = frames.slice(land).filter((f) => f.phase === 'LANDING');
    const knee = Math.max(...landing.map((f) => f.knee));
    const leg = Math.min(...landing.map((f) => f.leg));
    assert.ok(air < 130, `en el aire, rodillas a ${air.toFixed(0)}°`);
    assert.ok(knee < 115 && leg > 0.55, `al caer, rodillas a ${knee.toFixed(0)}° y piernas al ${(leg * 100).toFixed(0)} %`);
  });

  it('queriendo seguir, se levanta mientras echa a andar (antes caminaba ~2 s agachado hasta sentarse)', () => {
    const world = createWorld({ human: { config } });
    const { human } = world;
    let landing = 0;
    let low = 1;
    simulate(world, 4, [[0.5, (h) => assert.ok(h.jump())], [0.9, (h) => { h.targetSpeed = 1; }]], {
      onFrame: () => {
        if (human.jumpPhase !== 'LANDING') return;
        landing += 1 / 60;
        const m = humanLandmarks(human);
        low = Math.min(low, (m.pelvis.distanceTo(m.ankle.left) + m.pelvis.distanceTo(m.ankle.right)) / (2 * human.legLength));
      },
    });
    assert.ok(landing > 0.3 && landing < 0.75, `amortigua ${landing.toFixed(2)} s`);
    assert.ok(low > 0.55, `piernas al ${(low * 100).toFixed(0)} %`);
    assert.ok(human.speed > 0.5, `a ${human.speed.toFixed(2)} m/s`);
  });
});
