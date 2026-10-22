# Inventario de huesos al caminar

[English](../en/bone-inventory.md)

Qué huesos mueve hoy la librería, quién los mueve y cuánto, frente a lo que hacen esos huesos en una
persona. Es el punto de partida para que la marcha mueva **todos** los huesos que deforman el cuerpo.

```bash
node scripts/run-tests.mjs zzz && node .test-build/tests/tools/boneInventory.js
# otro modelo: PH_MODEL=modelos/human.glb PH_MAPPING=rigify (en PowerShell, con $env:PH_MODEL=…)
```

## Cómo se mide

- El personaje camina en recta a 1,2 m/s durante 8 s. Para cada hueso se mide **cuánto oscila
  alrededor de su pose media**, no de la de reposo (cada esqueleto tiene la suya: T-pose, A-pose…).
- El giro se expresa en los ejes del personaje: **flexión** (eje lateral), **giro** (eje vertical) e
  **inclinación** (eje de avance). Rango = percentil 95 − percentil 5, en grados. La pelvis se mide
  respecto al rumbo.
- **Personas**, medidas igual:
  - **CMU**: las cuatro tomas de caminar normal del test de naturalidad (sujetos 35 y 16, ~1,2 m/s).
    Es la referencia: su licencia permite usarla para ajustar.
  - **SFU**: el sujeto 0018 en sus tramos rectos (1,1–1,4 m/s). Solo en local
    ([naturalidad](naturalness.md#capturas-de-sfu)): confirma o desempata, pero ningún valor sale solo
    de SFU. Es una sola persona, con la pelvis y la cabeza mucho más móviles que en CMU.
- Límites del mocap:
  - La rodilla de SFU gira en un solo eje: su "inclinación" es el eje de la rodilla girado con el muslo.
  - Las clavículas de CMU no se mueven en estas tomas (canales constantes).
  - En los dos, la articulación de los dedos del pie está poco medida con marcadores.
  - El esqueleto de CMU tiene las piernas abiertas 20° en reposo, así que su pie no se puede comparar
    en valores absolutos, solo en rangos.

## Lo que mueve cada parte

Lado izquierdo (el derecho es simétrico). Flexión / giro / inclinación, en grados. Librería: modelo
Mixamo; en Rigify da igual salvo donde se indica.

| Segmento | Mixamo | Rigify | Lo mueve | Librería | CMU | SFU |
|---|---|---|---|---|---|---|
| Pelvis | `Hips` | `spine` | PelvisController | 3,3 / 9,8 / 7,8 (antes 0,2 de flexión) | 4,2 / 10,3 / 10,6 | 6,7 / 9,0 / 16,6 |
| Columna baja | `Spine` | `spine.001` | TorsoController | 4,2 / 5,9 / 6,2 (antes 3,1 / 5,9 / 8,7) | 3,0 / 4,7 / 11,4 | 3,0 / 4,3 / 3,7 |
| Columna media | `Spine1` | `spine.002` | **nadie** | quieto | 1,2 / 6,6 / 2,6 | (incluida en el pecho) |
| Pecho | `Spine2` | `spine.003` | TorsoController | 0,0 / 6,0 / 2,7 (antes 0 de inclinación) | 1,7 / 3,9 / 6,0 | 4,6 / 3,6 / 13,9 |
| Cuello | `Neck` | `spine.004` | TorsoController (solo lo resetea) | **quieto** | 3,1 / 1,6 / 2,0 | 7,4 / 6,4 / 3,6 |
| Cuello alto | — | `spine.005` | **nadie** | quieto | 4,9 / 2,2 / 2,8 | — |
| Cabeza | `Head` | `spine.006` | TorsoController | 3,3 / 3,8 / 1,4 | 1,7 / 1,0 / 1,0 | 15,0 / 4,7 / 6,6 |
| Clavícula | `LeftShoulder` | `shoulder.L` | ArmController | 0,4 / 5,7 / 0,0 | (no se mueve) | 5,9 / 7,1 / 4,1 |
| Brazo | `LeftArm` | `upper_arm.L` | ArmController | 21,9 / 0,7 / 3,5 | 15,3 / 19,6 / 7,5 | 42,0 / 25,6 / 12,4 |
| Antebrazo | `LeftForeArm` | `forearm.L` | ArmController | 14,7 / 1,4 / 2,6 | 14,8 / 2,3 / 3,2 | 23,7 / 10,2 / 8,2 |
| Giro del antebrazo | — | `forearm_twist.L` (opcional) | TwistController | no oscila | 1,5 / 10,0 / 3,5 | — |
| Mano | `LeftHand` | `hand.L` | ArmController | 8,5 / 1,0 / 0,0 | 13,9 / 4,6 / 5,1 | 8,4 / 3,5 / 6,7 |
| Dedos, 1.ª falange | `LeftHandIndex1`… | `f_index.01.L`… | HandFingers | 10 / 1 / 0 (+ pose relajada) | — | — |
| Dedos, 2.ª y 3.ª | `LeftHandIndex2-3`… | `f_index.02-03.L`… | HandFingers | pose fija, no oscilan | — | — |
| Muslo | `LeftUpLeg` | `thigh.L` | LegIK | 44,9 / 13,8 / 15,0 | 44,5 / 10,2 / 16,2 | 45,1 / 19,5 / 26,6 |
| Pierna | `LeftLeg` | `shin.L` | LegIK | 48,8 / 2,2 / 3,4 (Rigify: 40,4) | 52,5 / 2,5 / 4,3 | 69,7 / 4,9 / 11,9 |
| Pie | `LeftFoot` | `foot.L` | LegIK + FootRoll | 31,6 / 7,9 / 19,3 (Rigify: 36,7 / 2,2 / 2,4) | 30,8 / 22,0 / 9,8 | 34,1 / 17,3 / 25,9 |
| Dedos del pie | `LeftToeBase` | `toe.L` | FootRoll | 42,8 / 0,0 / 12,4 | 23,6 / 3,3 / 3,2 | 19,0 / 3,5 / 5,3 |
| Torsión (opcional) | — | `upper_arm_twist.L`… | TwistController | brazo 9,6 de giro, muslo 6,1 | — | — |

## Huesos que no mueve nadie

| Modelo | Huesos | Qué son |
|---|---|---|
| Mixamo | `Spine1` | columna media: sin mapping, la curva de la espalda se dobla solo en `Spine` y `Spine2` |
| Mixamo | `*_End`, `*Index4`, `*Ring4`, `*Thumb4`, `HeadTop_End` | puntas: no deforman la malla |
| Rigify | `spine.002`, `spine.005` | columna media y cuello alto, como `Spine1` |
| Rigify | `pelvis.L/R`, `breast.L/R` | pelvis y pecho de la malla: siguen a su padre; podrían rebotar un poco |
| Rigify | `palm.01–04.L/R` | palma: abrirla o ahuecarla con la mano relajada |
| Rigify | `forearm.L.001` | segundo segmento del antebrazo de este modelo |
| Rigify | `heel.02.L/R` | ayuda del metarig para el talón: no deforma |
| Rigify | cara (`jaw`, `eye.L/R`, `lid.*`, `brow.*`, `lip.*`…, ~90) | fuera de la marcha: mirada, parpadeo, mandíbula |

## El pie de Mixamo no se tuerce

En el inventario, el pie de Mixamo parece inclinarse 19° hacia los lados y el de Rigify 2°. No es un
fallo del rodado del pie:

- El modelo Mixamo tiene **la punta del pie 16° hacia fuera en reposo** (Rigify: 2°), y la librería
  conserva ese ángulo al caminar (16,2° en el apoyo).
- El pie se dobla sobre **su propio eje lateral**, que está girado esos 16°. Visto en los ejes del
  personaje, parte de esa flexión aparece como inclinación hacia los lados (en world, el eje lateral
  del personaje se inclina de −5° a 13°).
- Medida sobre el eje propio del pie, la inclinación lateral es **exactamente 0°** en los dos modelos,
  en el apoyo y en el vuelo.

Dos cosas que sí salen de esto:

- **La punta del pie depende del modelo**: 16° en Mixamo, 2° en Rigify, 0° en `base_pbr_test_03`. La
  literatura clínica da unos 5–7° hacia fuera al caminar. Un parámetro de ángulo de la punta, separado
  del modelo, haría que todos caminaran igual.
- **El pie nunca se tuerce hacia los lados** sobre suelo llano (inversión y eversión). En las personas
  se tuerce unos grados: hacia dentro al despegar, hacia fuera al recibir el peso.

## Qué le falta a la marcha

Ordenado por cuánto lo respaldan los datos que se pueden usar (CMU y literatura) y por lo que se nota.

1. **El brazo gira poco sobre su propio eje.** Librería: 0,7° de giro; CMU: 19,6°; SFU: 25,6°. En un
   brazo que cuelga, el giro sobre la vertical es sobre todo la rotación del húmero sobre su eje (hacia
   dentro y hacia fuera), no un balanceo fuera del plano: medido con puntos, el brazo de CMU se abre
   hacia fuera al ir adelante (±4,7°; la librería, ±2,3°, en el mismo sentido), y **la trayectoria de la
   muñeca ya coincide** con la de CMU (`tests/tools/mocapArm.ts`). Falta la rotación del húmero, que se
   nota en la torsión de la malla del brazo y en el plano del codo. El tamaño del braceo no se toca: CMU
   bracea menos que la librería y SFU más.
2. ~~**La pelvis no bascula hacia delante y atrás.**~~ Hecho (`pelvisTiltSwing`): ±1,8° dos veces por
   zancada; error frente a CMU de 1,3° a 0,2°; rango del hueso de 0,2° a 3,3° (CMU: 4,2°). Su caída
   lateral sigue algo corta (7,8° frente a 10,6° en CMU; ver [naturalidad](naturalness.md#lo-que-el-mocap-de-cmu-no-decide)).
3. ~~**El pecho solo gira.**~~ Hecho (`chestRollShare`): el pecho hace ~1/3 de la compensación de la
   caída de la pelvis (inclinación lateral de 0° a 2,7°; CMU: 6°) y la columna baja el resto (de 8,7° a
   6,2°). La proporción entre los dos es la de CMU, pero en CMU los dos se mueven más (11,4° y 6°) y
   con desfases: eso necesita la columna media (punto 4). Los hombros quedan igual de rectos (error
   frente a CMU: 1,0° → 1,1°).
4. **La columna media no se mueve.** En CMU se lleva parte de la contrarrotación (6,6° de giro). Hay
   que repartir el giro y la inclinación entre todos los segmentos de la columna.
5. **El cuello no se mueve.** En CMU sus dos segmentos se doblan 3–5° en cada paso y la cabeza casi
   nada (1–2°). La cabeza de la librería se mueve algo más (3–4°): habría que pasar parte de ese
   movimiento al cuello. SFU mueve cabeza y cuello mucho más (15°), pero ese sujeto es la excepción.
6. **La muñeca: sin datos para decidir.** El hueso `lhand` de CMU mide ~1 cm (la mano casi entera es
   `lwrist`, que solo gira sobre el antebrazo), así que CMU no mide la muñeca: medida con puntos, su mano
   apenas se aparta del antebrazo (±1°). SFU sí la mide: algo más hacia el cuerpo que la librería
   (rango 6° frente a 3,4°) y menos hacia delante y atrás (±1,4° frente a ±5°). Con una sola fuente
   (y solo local), no se toca.
7. **El antebrazo no gira** (pronación y supinación): CMU, 10°. Solo se vería en rigs con hueso de torsión
   del antebrazo.
8. **Los dedos de la mano son una pose fija**: solo la primera falange oscila (10°). Como cadena de
   péndulos, cada falange seguiría a la anterior con algo de retraso. No hay mocap de dedos: esto se
   ajusta a ojo.
9. **El pie es rígido hacia los lados** y su punta depende del modelo (ver arriba).

Sin cambios:
- **Clavícula**: solo SFU la mueve más (CMU no la mide). Por la regla de SFU, no se toca sin respaldo de
  la literatura.
- **Dedos del pie**: la librería los dobla 43° y los dos mocaps ~20°, pero los marcadores miden mal esa
  articulación y la literatura clínica da bastante más que el mocap.
- **Bien como está**: el giro de la pelvis, la columna baja, el muslo, el antebrazo y la flexión del pie
  dan como en CMU.
- **A mirar más adelante**: en Rigify la rodilla se dobla menos al caminar (40° frente a 49° en Mixamo
  y 52° en CMU), seguramente por las proporciones del modelo.

## Propuesta de mapeo

Sin romper los mappings actuales:

- **Huesos intermedios de la columna y del cuello, automáticos**: los huesos que hay en la cadena de
  padres entre `spine` y `chest` (`Spine1`, `spine.002`) y entre `neck` y `head` (`spine.005`) se
  detectan solos al crear el personaje, y el giro se reparte entre todos los segmentos. La herramienta
  del inventario ya los encuentra así. No hace falta tocar el mapping. Un campo opcional (por ejemplo
  `spineChain: string[]`) permitiría fijarlos a mano.
- **Cuello**: TorsoController reparte el movimiento de la cabeza entre `neck`, el cuello alto (si
  existe) y `head`.
- **Palma** (`palm.*`): campo opcional `palm` en los dedos de cada mano, para ahuecarla con la mano
  relajada. Prioridad baja.
- **Huesos de la malla de Rigify** (`pelvis.L/R`, `breast.L/R`): no se mapean. Siguen a su padre, que
  ya se mueve. El rebote es un efecto secundario que puede venir más tarde.
- **Cara**: fuera de esta etapa.

Esto cambia la API pública (campos opcionales nuevos en `HumanRigMapping`): primero hay que aprobarlo.
Los puntos 1 y 9 de la lista anterior no necesitan huesos nuevos: se pueden hacer con el mapping de hoy
(los 2 y 3 ya están hechos así).
