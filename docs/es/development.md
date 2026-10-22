# Desarrollo de la librería

[English](../en/development.md)

## Scripts

| Comando | Qué hace |
|---|---|
| `npm test` | Tests automáticos (≈ 1 min). `npm test -- jump`: solo los archivos cuyo nombre contiene "jump". |
| `npm run typecheck` | Comprueba los tipos de la librería y de los ejemplos (`tsconfig.json`). |
| `npm run build` | Compila la librería a `dist/` (JavaScript ESM + `.d.ts` + source maps). |
| `npm run build:watch` | Igual, recompilando al guardar. |
| `npm run bench` | Benchmark de rendimiento (ver [Rendimiento](#rendimiento)). |
| `npm run docs` | Regenera la referencia de parámetros (`docs/en/parameters.md`, `docs/es/parameters.md`) y `docs/parameters.json` (grupos y descripciones en los dos idiomas, para paneles de ajustes) desde el código; el español sale de `docs/i18n/parameters.es.json`. |
| `npm run mocap` | Compara la marcha con capturas de movimiento de CMU (y, con `-- sfu`, de SFU; ver [Naturalidad](naturalness.md)). |
| `npm pack` | Compila y genera `three-procedural-locomotion-<versión>.tgz` para instalar en otro proyecto. |

Requiere Node 20.19+ o 22.12+.

## Cómo funciona

Cada frame, de arriba abajo:

```text
intención     targetSpeed / targetHeading / targetCrouch / jump()   ← o MoveToController (moveTo)
  ↓
cuerpo        BodyController: velocidad con aceleración, giro limitado (frena según el giro pendiente),
              altura sobre el suelo, salto balístico
  ↓
ritmo         GaitController: fase del ciclo de cada pie, caminar ↔ correr, idle
  ↓
pasos         FootstepPlanner: dónde aterriza cada pie (predicción del cuerpo, giro, anchura)
              FootTarget + FootRoll: trayectoria del swing, talón → planta → punta
              FootPlacement: suelo bajo talón y dedos, inclinación del pie
  ↓
cuerpo        PelvisController (altura, rotación, caída), TorsoController (contrarrotación, inclinación,
              cabeza estable), ArmController (balanceo en oposición)
  ↓
huesos        LegIK (Two-Bone IK analítico, rodilla hacia delante) → rotaciones de los bones
              TwistController: reparte la torsión en los huesos twist (si el rig los tiene)
```

Las formas y los ritmos (cadencia según la velocidad, trayectoria del pie en el aire, rodado del pie,
rodillas, brazos) están medidos con capturas de movimiento reales: ver [Naturalidad](naturalness.md).

El cuerpo es cinemático (sin física): se calculan velocidad, giro y salto, y solo se consulta el suelo.

## Estructura

```text
src/          LIBRERÍA (lo único que se publica, junto con dist/ y docs/)
  index.ts            punto de entrada público (`three-procedural-locomotion`)
  ProceduralHuman.ts  API principal: control, estado, eventos, configuración, ciclo de vida
  config.ts           configuración por defecto, validación (ConfigError), escala (LENGTH_PARAMS)
  presets.ts          estilos de marcha
  i18n.ts             idiomas de los textos de interfaz (Language, LocalizedText)
  rig/        HumanRig (tipos, forward, largo de pierna), RigMapper (mapping + validación),
              inspectSkeleton, checkModel, presets/mixamo, presets/rigify
  ik/         TwoBoneIK (solver analítico), LegIK (pierna del rig)
  terrain/    GroundDetector (interfaz + raycast), StaticGroundDetector (suelo estático indexado),
              SurfaceDetector, FootPlacement
  locomotion/ LocomotionConfig, GaitController, FootstepPlanner, FootTarget, FootRoll,
              JumpController, LocomotionController (lo coordina todo)
  body/       BodyController, PelvisController, TorsoController, ArmController, TouchController,
              HandFingers, TwistController
  navigation/ MoveToController (point and click)
  tuning/     basicControls (controles de alto nivel)
  core/       pose (lectura/escritura world de los huesos, sin recálculos de más), transformaciones
  debug/      ayudas visuales (`three-procedural-locomotion/debug`)
examples/     ejemplos de integración (se comprueban con `npm run typecheck`)
docs/         documentación en en/ y es/ (en/parameters.md, es/parameters.md y parameters.json se generan)
scripts/      build-lib.mjs, run-tests.mjs, gen-docs.mjs, bench.mjs, mocap.mjs
bench/        benchmark de rendimiento (bench/results/ se genera)
tests/        tests automáticos (helpers/, golden/, reference/: medias del mocap; tools/: comparación con mocap)
recursos/     archivos de trabajo sin versionar (p. ej. recursos/mocap-cmu/ y recursos/mocap-sfu/, ver naturalness.md)
modelos/      modelos de los tests (human_mix_propio.glb: nombres de Mixamo; human.glb: Rigify)
dist/         librería compilada (generada, no se versiona)
```

## Tests

Usan el test runner de Node (sin dependencias extra) y el esqueleto de `modelos/human_mix_propio.glb` (solo la
jerarquía de huesos, leída igual que GLTFLoader: no hace falta navegador). Otro modelo: `PH_MODEL=ruta npm test` (y `PH_MAPPING=rigify` para un metarig de Rigify; ver [esqueletos](skeletons.md)).
Los tests giran y escalan el modelo (sea cual sea) para que mire hacia −Z y su largo de pierna sea el de
referencia: prueban el movimiento con sus proporciones, no cómo se exportó.

- **Propiedades** (`tests/*.test.ts`): configuración, rig, IK, caminar (llano, giros, pendientes, pista
  irregular), correr, agacharse, saltar, point and click, API (eventos, varios personajes, padres
  transformados, fps irregulares, teletransporte), tamaños, estilos y documentación. Comprueban cosas físicas con
  márgenes: los pies apoyados no deslizan, el IK llega, la punta no roza, las caderas no se desploman, llega al
  destino sin pasarse, alterna pies, queda quieto a tiempo… Cada error corregido tiene su test de regresión.
- **Proporciones** (`tests/proportions.test.ts`): el esqueleto de los tests con otras proporciones, generadas en
  código (`tests/helpers/proportions.ts`): piernas largas y cortas, muslo o tibia más largos, torso largo y
  corto, caderas anchas y estrechas, brazos y pies largos y cortos, y combinaciones. Cada variante hace un
  recorrido completo (parado, caminar, girar, correr, agacharse, saltar, ir a un punto) con las mismas
  exigencias que el modelo de los tests. Un test comprueba que el generador cambia de verdad cada proporción.
- **Referencias exactas** (`tests/golden/`): 4 recorridos grabados cada 0,1 s (raíz, caderas, pies, cabeza).
  Cualquier cambio de movimiento, por pequeño que sea, se señala con el instante y el punto. Si el cambio es
  intencionado: `UPDATE_GOLDEN=1 npm test` (PowerShell: `$env:UPDATE_GOLDEN=1; npm test; Remove-Item Env:UPDATE_GOLDEN`).
- **Naturalidad** (`tests/naturalness.test.ts`): la marcha a 1,2 m/s frente a las medias de capturas de
  movimiento reales (`tests/reference/cmu-caminar.json`): cadencia, zancada, apoyo, holgura de la punta y
  error de las curvas de muslo, rodilla, tobillo, pie, posición del tobillo, pelvis, hombros, brazo y codo
  (ver [Naturalidad](naturalness.md)). `npm run mocap` muestra la comparación completa.
- **Documentación**: un test falla si la referencia de parámetros o `docs/parameters.json` no coinciden con el código → `npm run docs`, o si a `docs/i18n/parameters.es.json` le falta, le sobra o tiene desactualizada (su `en` ya no es el TSDoc) alguna traducción.
- Conocido y fijado como límite para que no empeore: caminando las caderas no pasan de ≈ 4 mm/frame² de
  tirón (a paso vivo, ~1,7 m/s, ≈ 6; en la transición a correr, ≈ 3–6), y corriendo el impacto al aterrizar
  tras la fase de vuelo es mayor (≈ 11–16, también con otras proporciones; límite 25). Las caderas suben
  siguiendo un muelle (bajar, en cambio, es inmediato si las piernas lo exigen) y, al aterrizar, cada pie
  fija su apoyo según la mayor de la velocidad actual y la que habrá al despegar: sin eso, acelerando o
  frenando a través de la transición la pierna trasera se estiraba y las caderas se hundían.
  Tests "las caderas no dan tirones…", de correr y de proporciones. Corriendo, el despegue empieza donde
  estaba el pie en el instante real del despegue (no en el frame anterior) y la esquina entre la altura
  deseada de las caderas y el límite de las piernas se redondea: sin eso, la pierna trasera estirada tiraba
  de las caderas al despegar (hasta ≈ 31 según las proporciones).
- Conocido: corriendo por encima de ~4 m/s (más que `runSpeed` por defecto), al frenar se acentúa la bajada
  de caderas en la fase de vuelo (hasta ≈ 0,45 × pierna). A la velocidad de carrera por defecto no ocurre.
- **CI** (`.github/workflows/ci.yml`): en cada push a `main` y en cada pull request, GitHub Actions ejecuta el
  typecheck, los tests con los dos rigs de prueba y `npm pack` (que compila la librería) con Node 20, 22 y 24.

## Rendimiento

Diagnóstico completo, qué se optimizó y qué queda: [auditoría de rendimiento](performance-audit.md).

`npm run bench` mide `human.update` sin navegador con 1, 10, 50 y 100 personajes, parados, caminando,
corriendo y girando, sobre suelo plano y sobre una malla de 51.200 triángulos (esta, solo con 1 y 10). Por
escenario: tiempo por frame (media, p50, p99, máximo), tiempo por personaje, matrices de Three recalculadas,
raycasts y memoria asignada por frame. `--quick` hace solo 1 y 10 personajes caminando.

Antes de optimizar: `npm run bench -- --save-baseline` guarda la línea base (`bench/baseline.json`) y las
ejecuciones siguientes muestran la diferencia con ella. Los tiempos dependen de la máquina y varían de una
ejecución a otra (un 20–30 % en los escenarios pesados): compara siempre en la misma máquina y, ante una
diferencia dudosa, mide las dos versiones una tras otra. Las matrices y los raycasts no dependen de la máquina.

Los controladores leen y escriben la pose world de los huesos solo a través de `src/core/pose.ts`:

- leer (`worldPosition`, `worldQuaternion`) toma la matriz world tal como está, sin recalcular nada: quien lee
  se asegura antes de que está al día (`updateNode`, o `updateDown(antepasado, hueso)` para la cadena entre ambos);
- escribir (`setWorldQuaternionNode`, `setWorldPositionNode`) actualiza solo ese hueso; lo que cuelga de él
  queda pendiente hasta que la etapa termina con `updateSubtree`.

No usar `getWorldPosition`/`getWorldQuaternion` ni `updateWorldMatrix(true, true)` en el código por frame:
recalculan todos los antepasados o todo lo que cuelga, y llamados hueso a hueso multiplicaban por 6 las
matrices de cada frame (2.148 → 351 por personaje). Las matrices resultantes son idénticas; los tests de
referencias exactas lo comprueban.

Raycasts por personaje: 1 por frame (sonda de la raíz, que además detecta cambios del suelo bajo el cuerpo) y
~14 al empezar cada paso (aterrizaje: talón y punta; altura del arco: 12 muestras de la punta). Parado, la
comprobación de si los pies están recolocados (4 raycasts) se reutiliza mientras la matriz de la raíz no cambie
y se repite cada `IDLE_RECHECK_TIME` (0,25 s) para notar cambios de configuración o del terreno bajo los pies.
`tests/raycasts.test.ts` fija el presupuesto (parado ≤ 1,3/frame, caminando ≤ 1,5, corriendo ≤ 1,75).

Lo que cuesta cada consulta depende del detector. `RaycastGroundDetector` usa el raycast de Three, que prueba
todos los triángulos (~2 ms cada uno con 50.000: los ~14 del inicio de un paso dan un frame de ~25 ms).
`StaticGroundDetector` indexa los triángulos que un rayo vertical puede tocar en un árbol por su huella en planta
(XZ, división por la mediana, hojas de 8) con su rango de alturas: 2–5 µs por consulta. Replica lo que hace el
raycast de Three r186 (cara del material, grupos, `drawRange`, capa 0, escalas negativas, normal de los vértices
interpolada); `tests/ground.test.ts` lo compara rayo a rayo y con un recorrido completo. Toda la suite puede
correr con él: `PH_GROUND=static npm test`. El benchmark mide los dos (`malla`, `malla-static`).

## Añadir o cambiar un parámetro

1. Añádelo a la interfaz de su controlador (`LocomotionConfig`, `PelvisConfig`, `TorsoConfig`, `ArmConfig`,
   `TouchConfig` o `MoveToConfig`) con un comentario en inglés `/** … (unit). */`, y su valor en el objeto de
   valores por defecto.
2. Si es una longitud del cuerpo, añádelo a `LENGTH_PARAMS` (`src/config.ts`); si debe ser > 0, a `POSITIVE`;
   si solo se lee al crear el personaje, a `CONSTRUCTION_ONLY_PARAMS`.
3. Ponlo en una sección de `scripts/gen-docs.mjs` (si no, el script falla diciendo cuál falta), añade su
   traducción en `docs/i18n/parameters.es.json` (`en`: el texto del TSDoc, `es`: la traducción) y ejecuta
   `npm run docs`. Si cambias un comentario que ya existía, actualiza su traducción y copia el `en` nuevo.
4. `npm test`. Si el valor por defecto cambia el movimiento, las referencias exactas lo señalarán.
