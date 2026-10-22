import { Vector3 } from 'three';

import { loadMocap } from '../helpers/mocap.ts';

// Trayectoria de la muñeca respecto al hombro en el mocap (caminar normal): cuando el brazo va adelante,
// ¿se acerca a la línea media del cuerpo? Agrupa los frames por ángulo del brazo (sagital).
const DEG = 180 / Math.PI;
const bins = new Map<number, { lateral: number; ahead: number; elbow: number; n: number }>();
for (const id of ['35_01', '35_02', '35_03', '16_15']) {
  const series = loadMocap(`recursos/mocap-cmu/${id.split('_')[0]}.asf`, `recursos/mocap-cmu/${id}.amc`);
  const f = series.frames;
  const L = series.legLength;
  const fwd = f[f.length - 1].pelvis.clone().sub(f[0].pelvis).setY(0).normalize();
  const right = new Vector3().crossVectors(fwd, new Vector3(0, 1, 0));
  for (const frame of f) {
    for (const side of ['left', 'right'] as const) {
      const out = side === 'right' ? right : right.clone().negate();
      const s = frame.shoulder[side], e = frame.elbow[side], w = frame.wrist[side];
      const upper = e.clone().sub(s);
      const arm = Math.atan2(upper.dot(fwd), -upper.y) * DEG;
      const bin = Math.round(arm / 4) * 4;
      const b = bins.get(bin) ?? { lateral: 0, ahead: 0, elbow: 0, n: 0 };
      b.lateral += w.clone().sub(s).dot(out) / L;
      b.ahead += w.clone().sub(s).dot(fwd) / L;
      b.elbow += upper.angleTo(w.clone().sub(e)) * DEG;
      b.n++;
      bins.set(bin, b);
    }
  }
}
console.log('brazo°  muñeca hacia fuera (/pierna)  muñeca adelante  codo°  frames');
for (const [k, b] of [...bins].sort((a, c) => a[0] - c[0])) if (b.n > 20) console.log(String(k).padStart(5), (b.lateral / b.n).toFixed(3).padStart(10), (b.ahead / b.n).toFixed(3).padStart(14), (b.elbow / b.n).toFixed(1).padStart(10), String(b.n).padStart(7));

// Lo mismo en la librería (personaje de los tests, o PH_MODEL), caminando a 1,2 m/s.
import { analyzeHumanGait } from '../helpers/humanLandmarks.ts';
const lib = analyzeHumanGait(1.21 * Math.sqrt(1)).series;
const lbins = new Map<number, { lateral: number; ahead: number; elbow: number; twist: number; n: number }>();
const fr = lib.frames;
const fwdL = fr[fr.length - 1].pelvis.clone().sub(fr[0].pelvis).setY(0).normalize();
const rightL = new Vector3().crossVectors(fwdL, new Vector3(0, 1, 0));
for (const frame of fr) {
  for (const side of ['left', 'right'] as const) {
    const out = side === 'right' ? rightL : rightL.clone().negate();
    const s = frame.shoulder[side], e = frame.elbow[side], w = frame.wrist[side];
    const upper = e.clone().sub(s);
    const arm = Math.atan2(upper.dot(fwdL), -upper.y) * DEG;
    const bin = Math.round(arm / 4) * 4;
    const b = lbins.get(bin) ?? { lateral: 0, ahead: 0, elbow: 0, twist: 0, n: 0 };
    b.lateral += w.clone().sub(s).dot(out) / lib.legLength;
    b.ahead += w.clone().sub(s).dot(fwdL) / lib.legLength;
    b.elbow += upper.angleTo(w.clone().sub(e)) * DEG;
    b.n++;
    lbins.set(bin, b);
  }
}
console.log('\nlibrería:');
for (const [k, b] of [...lbins].sort((a, c) => a[0] - c[0])) if (b.n > 20) console.log(String(k).padStart(5), (b.lateral / b.n).toFixed(3).padStart(10), (b.ahead / b.n).toFixed(3).padStart(14), (b.elbow / b.n).toFixed(1).padStart(10), String(b.n).padStart(7));
