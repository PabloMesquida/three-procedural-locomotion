# Usar otro esqueleto (rig mapping)

[English](../en/skeletons.md)

La librería nunca adivina nombres de huesos: recibe un **mapping** que dice qué bone del modelo es cada parte
del cuerpo. `mixamoMapping` es el de los rigs de Mixamo; para cualquier otro rig se escribe uno igual.

## 1. Ver los nombres de los huesos

```ts
import { inspectSkeleton } from 'three-procedural-locomotion';

const gltf = await new GLTFLoader().loadAsync('/mi-modelo.glb');
console.log(inspectSkeleton(gltf.scene).tree); // jerarquía de bones, indentada
```

Usa los nombres **tal como salen ahí**: GLTFLoader los sanea (quita
`[ ] . : /` y cambia espacios por `_`), así que `mixamorig:Hips` pasa a ser `mixamorigHips`. El mapper acepta
ambas formas.

## 2. Escribir el mapping

```ts
import type { HumanRigMapping } from 'three-procedural-locomotion';

export const miMapping: HumanRigMapping = {
  hips: 'pelvis',
  left: { thigh: 'thigh_l', shin: 'calf_l', foot: 'foot_l', toe: 'ball_l' },
  right: { thigh: 'thigh_r', shin: 'calf_r', foot: 'foot_r', toe: 'ball_r' },
  spine: 'spine_01',
  chest: 'spine_03',
  neck: 'neck_01',
  head: 'head',
  leftArm: {
    shoulder: 'clavicle_l', upperArm: 'upperarm_l', forearm: 'lowerarm_l', hand: 'hand_l',
    // opcional: falanges de cada dedo, de la base a la punta
    fingers: { thumb: ['thumb_01_l', 'thumb_02_l', 'thumb_03_l'], index: ['index_01_l', 'index_02_l', 'index_03_l'] /* … */ },
  },
  rightArm: { shoulder: 'clavicle_r', upperArm: 'upperarm_r', forearm: 'lowerarm_r', hand: 'hand_r' },
};
```

(Nombres de ejemplo: cópialos del paso 1, no de aquí.) `left` y `right` son los del **personaje** (su pierna
izquierda), no los de la pantalla.

| Parte | ¿Obligatoria? | Si falta |
|---|---|---|
| `hips` | Sí | Error |
| `left` / `right`: `thigh`, `shin`, `foot` | Sí | Error |
| `left` / `right`: `toe` | No (muy recomendable) | La punta del pie se supone 15 cm delante del tobillo (sin verificar), el pie no se inclina sobre baches, los dedos no se doblan al levantar el talón y **hay que pasar `forward`** |
| `spine`, `chest` | No | Sin contrarrotación de hombros ni inclinación del tronco |
| `neck`, `head` | No | Sin estabilización ni anticipación de la cabeza |
| `leftArm` / `rightArm` (`upperArm`, `forearm`, `hand`; `shoulder` opcional) | No | El brazo queda en su pose de reposo |
| `fingers` de cada brazo (`thumb`, `index`, `middle`, `ring`, `pinky`: falanges de la base a la punta) | No | Los dedos quedan como en la pose de reposo del modelo (a menudo abiertos). Si faltan las últimas falanges se usan las que haya; un dedo sin base se ignora |
| Huesos de torsión: `thighTwist`, `shinTwist` (piernas), `upperArmTwist`, `forearmTwist` (brazos) | No | Cada segmento gira entero: al girar la mano o el pie sobre el eje del antebrazo o la tibia, la muñeca o el tobillo se retuercen de golpe (ver [Huesos de torsión](#huesos-de-torsión)) |

Si falta un bone opcional, o un brazo está incompleto, no es un error: queda un aviso en `human.warnings`.

## 3. Comprobar

`createProceduralHuman` lanza `RigMappingError` (con la lista en `error.problems`) si falta un bone
obligatorio o si la cadena de la pierna no es directa. Además avisa (`human.warnings`; los mensajes, como todos los
de la librería, están en inglés) de:

- nombres de bone duplicados;
- un muslo que no cuelga de las caderas, o dedos que no son hijos directos del pie;
- pies que apuntan al lado contrario del esperado (probablemente `left`/`right` intercambiados).

Y del modelo (`checkModel`, también exportada), con qué revisar en cada caso:

- **escala**: un largo de pierna fuera de 0,1–5 m (casi seguro, exportado en centímetros);
- **pose de reposo**: rodillas dobladas más de 20°, piernas a más de 25° de la vertical (¿eje Y hacia arriba?,
  ¿de pie?), dedos de los pies que no están a la altura del suelo (pies no planos), piernas de distinto largo;
- **origen**: tobillos por debajo del origen del modelo o muy por encima (el origen debe estar en las plantas);
- **proporciones fuera de lo probado**: muslo/tibia fuera de 0,7–1,5, caderas fuera de 0,12–0,4 × el largo de
  pierna, pies (tobillo → dedos) fuera de 0,1–0,25 ×;
- **hacia delante**: sin el bone de los dedos y sin `forward`, o un `forward` que contradice a los pies.

Los modelos probados (Mixamo, Rigify) no dan ninguno, ni las proporciones que generan los tests.

Muestra siempre los avisos durante el desarrollo:

```ts
for (const warning of human.warnings) console.warn(warning);
```

## Requisitos del modelo

- **Cadena de pierna directa**: `shin` es hijo directo de `thigh` y `foot` de `shin` (lo necesita el Two-Bone IK).
  Los huesos de torsión van **en paralelo** (hijos del segmento, fuera de la cadena), no intercalados: ver
  [Huesos de torsión](#huesos-de-torsión).
- **Pose de reposo de pie**: piernas rectas y pies planos en el suelo (T-pose o A-pose). En esa pose se miden
  la altura del tobillo, la posición de los dedos y el largo de pierna. Las piernas pueden estar algo abiertas
  y los pies algo adelantados o retrasados: al caminar, los pies van a la anchura de las caderas
  (`stepWidth`) y `ankleBack` por detrás de ellas, y las caderas suben lo justo para que las piernas
  conserven la extensión que tenían en reposo.
- **Origen a la altura de las plantas**: la raíz del modelo (`gltf.scene`) está en el suelo, entre los pies.
- **Escala en metros y eje Y hacia arriba** (como exporta glTF). Un modelo más grande o más pequeño funciona
  (`bodyScale: 'auto'`), pero debe ser un humano en proporciones normales.
- **Hacia delante**: se estima con los dedos de los pies (tobillo → dedos). Sin `toe` en el mapping no se puede
  estimar, y si el personaje camina de lado o hacia atrás la estimación falla: en ambos casos pasa `forward` (la dirección world en la que mira el modelo en reposo, p. ej.
  `new Vector3(0, 0, 1)`).

## Huesos de torsión

Un segmento con un solo hueso gira entero: si la mano gira 80° sobre el eje del antebrazo, la malla del
antebrazo no gira nada y toda la torsión se concentra en la muñeca (efecto "envoltorio de caramelo"). Los
huesos de torsión reparten ese giro, como los `twist` de los esqueletos de juego (p. ej. el de Unreal):

| Hueso | Hijo de | Cubre | Cada frame |
|---|---|---|---|
| `forearmTwist` | `forearm` | mitad inferior del antebrazo | recibe la mitad del giro de la mano alrededor del eje del antebrazo |
| `shinTwist` | `shin` | mitad inferior de la tibia | recibe la mitad del giro del pie alrededor del eje de la tibia |
| `upperArmTwist` | `upperArm` | mitad superior del brazo | deshace la mitad del giro del brazo sobre su eje (el hombro no se retuerce) |
| `thighTwist` | `thigh` | mitad superior del muslo | deshace la mitad del giro del muslo sobre su eje (la cadera no se retuerce) |

- Son **hijos directos** del segmento y **no** forman parte de la cadena (la mano sigue siendo hija del
  antebrazo): el IK y los brazos no los ven. Uno con otro padre se ignora con un aviso.
- Solo se toca su giro alrededor del eje del segmento; su orientación de reposo puede ser cualquiera.
- La malla se pesa entre el segmento y su twist (en la mitad que indica la tabla).
- Si el mapping los nombra y el modelo no tiene ninguno (p. ej. `rigifyMapping` con un metarig sin twist),
  queda un único aviso y todo funciona igual, sin torsión gradual.

## Rigify (Blender)

`rigifyMapping` sirve para el **metarig** de Rigify: la malla pesada directamente a sus huesos (`spine`,
`thigh.L`, `shin.L`, `foot.L`, `toe.L`, `spine.003`, `upper_arm.L`…). Es la forma sencilla de exportar a
Three.js: el metarig es un esqueleto limpio, sin controles.

```ts
import { rigifyMapping } from 'three-procedural-locomotion';
createProceduralHuman({ model: gltf.scene, mapping: rigifyMapping, ground: [suelo] });
```

- El rig **generado** por Rigify (`rig`, con huesos `DEF-*`, `ORG-*`, `MCH-*`) no sirve tal cual: sus piernas
  tienen huesos de torsión intermedios (`DEF-thigh.L.001`) y la cadena no es directa. Además, exportado con
  "solo huesos deform", muslos, hombros y brazos quedan colgando de la raíz y no de la columna.
- **Torsión** (opcional): `rigifyMapping` busca `thigh_twist.L`, `shin_twist.L`, `upper_arm_twist.L` y
  `forearm_twist.L` (y `.R`). Se añaden al metarig en Edit Mode, sin conectar, con el segmento como padre y
  la posición del DEF equivalente del rig generado: `thigh_twist` = `DEF-thigh`, `shin_twist` = `DEF-shin.001`,
  `upper_arm_twist` = `DEF-upper_arm`, `forearm_twist` = `DEF-forearm.001`. Si la malla ya estaba pesada
  al rig generado, sus grupos de vértices se renombran así y los demás `DEF-x` / `DEF-x.001` pasan a `x`.
- En Blender, antes de exportar: une la malla al metarig (selecciona la malla, luego el metarig,
  **Ctrl+P → With Automatic Weights**), aplica escala y rotación a los dos (**Ctrl+A → All Transforms**) y
  exporta a glTF con **Skinning** activado.

## Estado de verificación

- **Mixamo** (`modelos/human_mix_propio.glb`: malla de Human Base Meshes con un esqueleto propio con la
  jerarquía y los nombres de Mixamo, cinco dedos, A-pose y la raíz girada 90° y a escala 0,01 como un Mixamo
  importado; lo genera `scripts/blender/rig-mixamo-names.py`): modelo por defecto de todos los tests, que
  pasan. El que había antes, riggeado con el auto-rig de Mixamo (3 dedos, T-pose), también los pasaba.
- **Rigify, metarig** (`modelos/human.glb`, A-pose): todos los tests pasan
  (`PH_MODEL=modelos/human.glb PH_MAPPING=rigify npm test`). Las referencias exactas (golden) y el test de
  torsión al caminar se saltan: están hechos con el modelo por defecto.
- El modelo Mixamo anterior a estos (`humanoid.glb`, de otras proporciones: pies 3 cm por detrás de la
  cadera y piernas verticales en reposo) también pasa todos los tests de movimiento.
- **Otras proporciones**: los tests generan, a partir de cada modelo, variantes con piernas, muslos, tibias,
  torso, caderas, brazos y pies más largos o más cortos (±15–50 %) y combinaciones; todas caminan, corren,
  saltan y llegan a su destino con las mismas exigencias (`tests/proportions.test.ts`).
- Otros rigs deberían funcionar con su mapping si cumplen los requisitos, pero no están verificados: pruébalos
  con los tests (`PH_MODEL=ruta/al/modelo.glb`; para
  un mapping propio, añádelo en `tests/helpers/sim.ts`). Los tests giran y escalan cualquier modelo para
  que mire hacia −Z y tenga el tamaño de referencia: prueban sus proporciones y su rig.
