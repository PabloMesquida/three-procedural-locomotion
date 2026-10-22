import { Quaternion, Vector3 } from 'three';

import { createWorld, DEG, simulate } from '../helpers/sim.ts';

// Flexión de la muñeca: ángulo entre el antebrazo (codo → muñeca) y el eje Y del hueso de la mano
// (el que va a lo largo del hueso en Blender), y su componente hacia delante/atrás y lateral.
const world = createWorld();
const h = world.human;
const arm = h.rig.leftArm!;
const measure = (label: string): void => {
  h.rig.root.updateMatrixWorld(true);
  const elbow = arm.forearm.getWorldPosition(new Vector3());
  const wrist = arm.hand.getWorldPosition(new Vector3());
  const fore = wrist.clone().sub(elbow).normalize();
  const hand = new Vector3(0, 1, 0).applyQuaternion(arm.hand.getWorldQuaternion(new Quaternion()));
  const F = h.locomotion.body.state.forward;
  const side = new Vector3().crossVectors(F, new Vector3(0, 1, 0)).normalize();
  console.log(label.padEnd(18), 'muñeca', (fore.angleTo(hand) / DEG).toFixed(1).padStart(5), '°',
    ' antebrazo (adelante, lado, arriba)', [fore.dot(F), fore.dot(side), fore.y].map((x) => x.toFixed(2)).join(' '),
    ' mano', [hand.dot(F), hand.dot(side), hand.y].map((x) => x.toFixed(2)).join(' '));
};
h.restPose();
measure('reposo');
h.reset();
simulate(world, 1);
measure('de pie');
simulate(world, 4, [[1, (x) => { x.targetSpeed = 1.4; }]], { start: 1, onFrame: (t) => { if (Math.abs(t - 4.5) < 0.009 || Math.abs(t - 4.85) < 0.009) measure(`caminando ${t.toFixed(2)}`); } });
