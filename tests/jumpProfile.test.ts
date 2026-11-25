import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeJumpProfile, defaultConfig, JUMP_MAX_EFFORT, type JumpProfile } from '../src/index.ts';

const c = defaultConfig;
const g = c.gravity;
const DEG = Math.PI / 180;
const profile = (speed: number, intent?: { distance?: number; height?: number }, rise?: number): JumpProfile =>
  computeJumpProfile(c, { speed, intent, rise });
const increasing = (values: number[], what: string): void => {
  for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1], `${what} no crece: ${values.map((x) => x.toFixed(3)).join(', ')}`);
};

describe('perfil del salto', () => {
  it('el de referencia (jump() sin intención, en llano) es el de la configuración, a cualquier velocidad', () => {
    for (const speed of [0]) {
      // El de un pie a otro (los saltos sobre huecos) conserva las curvas de la configuración también en el aire.
      const p = computeJumpProfile(c, { speed, standing: false, stride: true });
      assert.equal(p.vy, c.jumpSpeed);
      assert.equal(p.vx, speed);
      assert.equal(p.effort, 1);
      assert.equal(p.crouch, c.jumpCrouch);
      assert.equal(p.takeoffTime, (27 * c.jumpCrouch) / (4 * c.jumpSpeed));
      assert.equal(p.tuck, c.jumpTuck);
      assert.equal(p.landingPrep, c.jumpLandingPrep);
      assert.equal(p.landingTime, c.landingTime);
      assert.equal(p.toeOff, c.jumpToeOff);
      assert.equal(p.lean, 12 * DEG);
      assert.deepEqual([p.armBack, p.armForward, p.armLanding, p.armAirTime, p.tuckTime], [35, 40, 20, 0.5 * p.flight / ((2 * c.jumpSpeed) / g), 0.15]);
      assert.ok(p.reachable);
    }
    // Desde parado, el de referencia sigue siendo el caso intermedio: la flexión y los brazos hacia atrás de la
    // configuración, y una preparación de duración parecida (bajar + empujar).
    const p = profile(0);
    assert.ok(p.standing && p.effort === 1 && p.crouch === c.jumpCrouch && p.armBack === 35 && p.vy === c.jumpSpeed);
    assert.ok(Math.abs(p.takeoffTime - (27 * c.jumpCrouch) / (4 * c.jumpSpeed)) < 0.02, `preparación ${p.takeoffTime.toFixed(3)} s`);
    assert.ok(Math.abs(p.pushTime - (2 * p.crouch) / p.vy) < 1e-12, 'el empuje no termina a vy');
  });

  it('en movimiento, jump() sin intención sube menos cuanto más rápido va: largo y bajo', () => {
    const ps = [0, 1, 3, 5].map((speed) => profile(speed));
    for (let i = 2; i < ps.length; i++) assert.ok(ps[i].vy < ps[i - 1].vy, ps.map((p) => p.vy.toFixed(2)).join(' / '));
    assert.ok(ps[1].vy <= c.jumpSpeed && ps[3].vy >= 0.4 * c.jumpSpeed);
    for (let i = 2; i < ps.length; i++) assert.ok(ps[i].distance > ps[i - 1].distance, 'más rápido, no más lejos');
    // Corriendo, más tendido que caminando.
    assert.ok(Math.atan2(ps[3].vy, ps[3].vx) < Math.atan2(ps[2].vy, ps[2].vx));
  });

  it('balístico: vuelo, distancia, altura e impacto, también cayendo más abajo o más arriba', () => {
    for (const rise of [-0.5, 0, 0.2]) {
      const p = profile(2, undefined, rise);
      // y(t) = vy·t − g·t²/2 llega a `rise` al final del vuelo.
      assert.ok(Math.abs(p.vy * p.flight - (g * p.flight ** 2) / 2 - rise) < 1e-9, `rise ${rise}`);
      assert.ok(Math.abs(p.distance - p.vx * p.flight) < 1e-9);
      assert.ok(Math.abs(p.height - p.vy ** 2 / (2 * g)) < 1e-9);
      assert.ok(Math.abs(p.impact - (p.vy - g * p.flight)) < 1e-9 || Math.abs(p.impact + (p.vy - g * p.flight)) < 1e-9);
    }
    assert.ok(profile(0, undefined, -0.5).flight > profile(0).flight);
    assert.ok(profile(0, undefined, -0.5).impact > profile(0).impact);
  });

  it('más alto: más esfuerzo, más flexión, preparación más larga, más brazos, más tuck', () => {
    const ps = [0.1, 0.25, 0.4, 0.6].map((height) => profile(0, { height }));
    for (const p of ps) assert.ok(Math.abs(p.height - [0.1, 0.25, 0.4, 0.6][ps.indexOf(p)]) < 1e-9 && p.reachable);
    for (const key of ['effort', 'crouch', 'takeoffTime', 'descentTime', 'armBack', 'armUp', 'armForward', 'lean', 'tuck', 'landingPrep', 'landingTime'] as const) {
      increasing(ps.map((p) => p[key]), key);
    }
    // Un saltito casi no se agacha (menos de la mitad de la referencia); el de referencia, en medio.
    assert.ok(ps[0].crouch < c.jumpCrouch / 2 && ps[3].crouch > c.jumpCrouch);
    // Y la flexión le alcanza para empujar hasta vy en un tiempo humano (no en un frame).
    for (const p of ps) assert.ok(p.pushTime >= 0.06 - 1e-9, `empuje ${p.pushTime.toFixed(3)} s`);
  });

  it('más lejos desde parado: con el ángulo de un salto de longitud, y más esfuerzo cuanto más lejos', () => {
    const ds = [0.5, 1, 1.5, 2];
    const ps = ds.map((distance) => profile(0, { distance }));
    for (const [i, p] of ps.entries()) {
      assert.ok(p.reachable && Math.abs(p.distance - ds[i]) < 1e-3, `${ds[i]} m: ${p.distance.toFixed(3)}`);
      const angle = Math.atan2(p.vy, p.vx) / DEG;
      assert.ok(angle > 20 && angle < 30, `ángulo ${angle.toFixed(1)}°`);
    }
    for (const key of ['effort', 'crouch', 'armBack', 'armForward'] as const) increasing(ps.map((p) => p[key]), key);
    // Saltando lejos los brazos van hacia delante (no por encima de la cabeza) y el tronco se queda inclinado.
    const up = profile(0, { height: ps[2].height });
    assert.ok(ps[2].armUp / ps[2].effort < up.armUp / up.effort && ps[2].leanTakeoff > 0 && up.leanTakeoff === 0);
  });

  it('más de lo que puede: hace lo que puede (esfuerzo máximo) y lo dice', () => {
    const far = profile(0, { distance: 5 });
    assert.equal(far.reachable, false);
    assert.ok(Math.abs(far.effort - JUMP_MAX_EFFORT) < 1e-9 && far.distance < 5);
    const high = profile(0, { height: 2 });
    assert.equal(high.reachable, false);
    assert.ok(Math.abs(high.effort - JUMP_MAX_EFFORT) < 1e-9);
    // Un escalón más alto de lo que sube saltando.
    assert.equal(profile(0, undefined, 1).reachable, false);
  });

  it('corriendo: conserva la velocidad; la misma distancia le cuesta menos que parado y, subiendo lo mismo, llega más lejos', () => {
    const run = profile(3, { distance: 1.5 });
    const stand = profile(0, { distance: 1.5 });
    assert.ok(run.reachable && Math.abs(run.vx - 3) < 1e-9 && Math.abs(run.distance - 1.5) < 1e-9);
    // La velocidad horizontal ya la trae: las piernas solo dan la vertical.
    assert.ok(run.effort < stand.effort && run.crouch < stand.crouch && run.armBack < stand.armBack);
    const low = profile(3, { height: 0.15 });
    assert.ok(Math.abs(low.vx - 3) < 1e-9 && low.distance > 3 * profile(0, { height: 0.15 }).distance + 1);
    assert.ok(Math.atan2(low.vy, low.vx) / DEG < 30, 'un salto bajo corriendo es tendido');
  });

  it('el tuck, la preparación del aterrizaje y los brazos en el aire van con el vuelo; la amortiguación, con el impacto', () => {
    const ps = [0.1, 0.3, 0.6].map((height) => profile(0, { height }));
    increasing(ps.map((p) => p.flight), 'vuelo');
    // Fracciones fijas del vuelo: se quedan estiradas un instante, se recogen hasta cerca de lo más alto y desde ahí van
    // hacia el aterrizaje, sin pausa entre las dos (antes: recogidas a 0,15 s y quietas hasta 0,22 s antes de caer).
    for (const p of [...ps, profile(1), profile(3)]) {
      for (const [key, share] of [['tuckDelay', ps[0].tuckDelay / ps[0].flight], ['tuckTime', ps[0].tuckTime / ps[0].flight], ['landingPrep', ps[0].landingPrep / ps[0].flight], ['armAirTime', 1]] as const) {
        assert.ok(Math.abs(p[key] / p.flight - share) < 1e-9, `${key} no es una fracción fija del vuelo`);
      }
      assert.ok(p.tuckDelay > 0 && p.tuckDelay < 0.1 * p.flight, 'las piernas se quedan estiradas demasiado (o nada)');
      assert.ok(p.tuckTime > 0.35 * p.flight && p.tuckTime < 0.55 * p.flight, 'el tuck no llega cerca de lo más alto');
      assert.ok(p.tuckTime + p.landingPrep >= p.flight - 1e-9, 'pausa entre el tuck y la preparación del aterrizaje');
    }
    // El tronco se inclina hacia el aterrizaje, más cuanto más fuerte y saltando lejos; la cabeza mira hacia abajo.
    increasing(ps.map((p) => p.airLean), 'tronco en el aire');
    const far = profile(0, { distance: 1.5 });
    assert.ok(far.airLean / far.effort > ps[1].airLean / ps[1].effort && ps[1].gaze > 0);
    // Tuck: proporcional, con tope.
    assert.ok(profile(0, { height: 3 }, -2).tuck <= 1.5 * c.jumpTuck + 1e-9);
    increasing([profile(0, { height: 0.1 }), profile(0), profile(0, undefined, -0.5)].map((p) => p.landingTime), 'amortiguación');
  });
});
