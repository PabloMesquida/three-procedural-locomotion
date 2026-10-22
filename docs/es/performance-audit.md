# Auditoría de rendimiento — three-procedural-locomotion

[English](../en/performance-audit.md)

*La demo que se menciona en esta auditoría es hoy el laboratorio de la web del proyecto, fuera de este repositorio.*

Auditoría: 6 oct 2026 · Actualizada el mismo día con las optimizaciones #1, #2 y #3 (ver *Estado actual*). El diagnóstico original se conserva debajo tal cual se escribió; los números de esas secciones son los de ANTES de optimizar.

**Diagnóstico original (antes de optimizar):** la librería estaba limitada por la CPU, y casi todo ese tiempo no es locomoción: el 71 % se va en recalcular matrices de huesos que ya estaban calculadas (unas 2.150 por frame y personaje para un esqueleto de 68 nodos). En un terreno con muchos triángulos manda otro coste: cada raycast tarda 1,8 ms y un personaje parado lanza 5 por frame. El garbage collector (0,2 %) y la GPU no son hoy el problema. Con un suelo simple caben unos 50 personajes en un frame de 60 fps; con 100 se pasa (22–31 ms solo en locomoción).

## Estado actual (tras las optimizaciones)

| # | Hallazgo | Estado | Resultado medido |
| --- | --- | --- | --- |
| — | Benchmark y línea base | ✅ Hecho | `npm run bench` (`bench/bench.ts`, `scripts/bench.mjs`); `--quick`, `--save-baseline` → `bench/baseline.json` |
| 1 | Matrices en cascada | ✅ Hecho (pasos 1–3) | 2.148 → 351 matrices/frame/personaje (Mixamo). Suelo plano −56 % a −82 %: 10 personajes caminando 3,14 → 0,79 ms; 100 ≈ 10 ms. Golden idénticos |
| 3 | Raycasts repetidos | ✅ Hecho | Parado 5 → 1,25 raycasts/frame; caminando 1,50 → 1,47; corriendo 1,73 → 1,68 |
| 2 | Raycast por fuerza bruta | ✅ Hecho (`StaticGroundDetector`) | Consulta ~1,8 ms → 2–5 µs. Malla de 51.200 tri, 1 personaje caminando: 8,2 → 0,11 ms (p99 85 → 0,24 ms); 100 personajes ≈ igual que en plano |
| — | Telemetría `human.stats` / página de estrés | ⏳ Pendiente | — |
| 4 | Niveles de detalle (LOD) | ⏳ Pendiente | — |
| 1b | Una sola cascada final por frame | ⏳ Opcional | 351 → ~170 matrices; con 100 personajes las matrices vuelven a ser lo principal |
| 5 | Pose propia fuera del grafo de Three | 🔮 Futuro | `src/core/pose.ts` ya es el único punto de acceso: es la costura para hacerlo |
| 6 | Subpasos al bajar los fps | ⏳ Pendiente (🟡) | — |
| 7, 8, 9 | Huesos no usados, GC, matemática | — No tocar | #7 desapareció casi entero con #1 |

### Qué se cambió

**#1 — Matrices (`src/core/pose.ts`).** Todos los controladores leen y escriben la pose world de los huesos solo a través de este módulo:

- leer (`worldPosition`, `worldQuaternion`) toma la matriz world tal como está, sin recalcular: quien lee garantiza que está al día (`updateNode`, o `updateDown(antepasado, hueso)` para la cadena entre ambos);
- escribir (`setWorldQuaternionNode`, `setWorldPositionNode`) actualiza solo ese hueso; lo que cuelga queda pendiente hasta que la etapa termina con `updateSubtree`;
- no usar `getWorldPosition` / `getWorldQuaternion` ni `updateWorldMatrix(true, true)` en el código por frame.

Lo usan `BodyController` (rumbo y raíz sin cascada completa), `PelvisController` (`reset(false)` en `update`), `TwoBoneIK`, `LegIK`, `TorsoController`, `ArmController`, `HandFingers` y `LocomotionController`. Las matrices resultantes son idénticas (mismas operaciones, una sola vez).

**#3 — Raycasts repetidos (`LocomotionController`).** Parado, `feetSettledIdle` reutiliza la comprobación de pies recolocados mientras `root.matrixWorld` no cambie y la repite cada `IDLE_RECHECK_TIME` (0,25 s) para notar cambios de configuración o de terreno. Al frenar, `settleError` solo en doble apoyo (único momento en que se usa). `swingHeight` ya no lanza el raycast de la muestra 0 (no se usaba). La sonda bajo la raíz (1/frame) se mantiene: detecta cambios del suelo bajo el cuerpo.

**#2 — Suelo indexado (`src/terrain/StaticGroundDetector.ts`, exportado).** npm estaba bloqueado en el entorno, así que no se pudo instalar ni verificar `three-mesh-bvh`; se hizo un detector propio sin dependencias, solo para rayos verticales (lo único que usa la librería). Copia en world los triángulos que un rayo vertical puede tocar y los ordena en un árbol por su huella en planta (XZ; mediana con quickselect, hojas de 8, cajas por unión de hijos) con su rango de alturas. Replica el raycast de Three r186: cara del material (Front/Back/Double), escala negativa, grupos, `drawRange`, capa 0 y normal de los vértices interpolada (o la de la cara si no hay normales). Es una foto: `rebuild()` si el suelo cambia; `InstancedMesh`, `SkinnedMesh` y `BatchedMesh` se ignoran con aviso. Construcción: 51.200 tri ≈ 0,1 s, 500.000 ≈ 0,6 s, 2 M ≈ 2,3 s. Uso: un detector compartido por todos los personajes; `ground: [mallas]` (raycast) sigue siendo la opción para suelo que se mueve.

### Tests añadidos

- `tests/raycasts.test.ts`: presupuesto de consultas al suelo por frame (parado ≤ 1,3, caminando ≤ 1,5, corriendo ≤ 1,75); parado + escalón que aparece bajo la punta → se recoloca; parado + `setConfig({ stepWidth })` → se recoloca.
- `tests/ground.test.ts`: `StaticGroundDetector` contra el raycast de Three rayo a rayo (terrenos de la demo y casos raros: 0 discrepancias, error < 1e-6), `rebuild()`, y un recorrido completo por la pista irregular con el mismo movimiento.
- `PH_GROUND=static npm test` corre toda la suite con el detector nuevo (112/112, golden incluidos).
- Estado de la suite: 112/112 con Mixamo; Rigify 107/108 (el fallo conocido de correr a 4,5 m/s con giros rápidos, mismo valor −0,391 que antes de estos cambios).

### Nota sobre las medidas

Las medidas de *Estado actual* se tomaron en la máquina compartida de la nube: entre ejecuciones las medias varían un 30–60 %. Las comparaciones válidas son dentro de una misma ejecución o midiendo las dos versiones una tras otra; los recuentos (matrices, raycasts) son exactos. En la máquina de desarrollo: `npm run bench -- --save-baseline` una vez y comparar contra eso.

### Siguiente

1. Telemetría opcional `human.stats` (tiempos por etapa, matrices, consultas al suelo, subpasos), sin coste apagada; página de estrés en la demo.
2. LOD por distancia (#4).
3. Si con muchos personajes hace falta: una sola cascada final por frame (#1b).

---

# Diagnóstico original (antes de optimizar)

## Cómo se midió

Todo sale del código actual (105 tests en verde) sin tocar ningún archivo del proyecto: los benchmarks son scripts temporales que corren la librería en Node, igual que los tests. Cada afirmación lleva su etiqueta: **HECHO** (se ve en el código o se midió), **HIPÓTESIS** (probable, falta confirmarlo) o **RECOMENDACIÓN** (propuesta).

- **Máquina:** Xeon 2,8 GHz, 2 vCPU, Node 22, Three r186. Un escritorio actual será probablemente 1,5–2× más rápido (HIPÓTESIS); las proporciones entre partes no cambian.
- **Modelos:** Mixamo `humanoid.glb` (68 nodos, 49 huesos) y tu Rigify `human06.glb` (165 nodos, 161 huesos).
- **Escenarios:** parado, caminando a 1 m/s y corriendo a 3 m/s, sobre un plano (2 triángulos) y sobre la pista irregular de la demo (23.520 triángulos), con 1, 10, 50 y 100 personajes.
- **Herramientas:** cronómetro por frame tras 300 frames de calentamiento del JIT; contadores sobre los métodos de Three (matrices, raycasts); perfil de CPU de V8 por muestreo; observador de GC de Node y perfil de memoria de V8.
- **Límites:** la máquina comparte CPU, así que las medias varían ±30 % entre ejecuciones; los recuentos (matrices, raycasts) son exactos. La GPU no se pudo medir aquí: el navegador de la nube usa render por software.

## Mapa de coste por frame

Un personaje cuesta 0,22–0,35 ms por frame sobre suelo simple (HECHO, medido). Tres cuartas partes de ese tiempo son Three recalculando matrices que la librería le pide recalcular una y otra vez; la locomoción en sí (gait, pasos, IK, muelles) es el 14 %.

**Perfil de CPU de V8** (10 personajes caminando sobre el plano, 11.862 muestras):

| Dónde se va la CPU | % |
| --- | --- |
| Three: `updateWorldMatrix` (componer matrices locales y recorrer árboles) | 40,8 |
| Three: `multiplyMatrices` (matriz world = padre × local) | 30,6 |
| Three: otras operaciones de matrices, cuaterniones y vectores (`setFromRotationMatrix`, `decompose`, `copy`…) | 8,1 |
| Código propio de la librería (gait, pasos, IK, muelles, pelvis, torso, brazos) | 14,0 |
| Raycasts (suelo de 2 triángulos) | ≈ 1 |
| Garbage collector | 0,2 |

**Matrices recalculadas y tiempo por subsistema** (un personaje caminando; el tiempo es con instrumentación, sirve para comparar partes, no como valor absoluto):

| Subsistema | Matrices/frame Mixamo (68 nodos) | Matrices/frame Rigify (165 nodos) | % del tiempo (Mixamo) |
| --- | --- | --- | --- |
| Brazos y dedos (`ArmController`, `HandFingers`) | 1.188 | 1.206 | 44 |
| Pelvis (`PelvisController`) | 300 | 684 | 12 |
| Cuerpo: raíz, rumbo y raycast del suelo (`BodyController`) | 221 | 512 | 14 |
| IK de las dos piernas (`LegIK`/`TwoBoneIK`) | 202 | 202 | 10 |
| Torso y cabeza (`TorsoController`) | 153 | 434 | 6 |
| Pies, pivote y resto de `LocomotionController` | 84 | 180 | 11 |
| Planificar pasos, gait, point and click | < 1 | < 1 | 4 |
| **Total** | **2.148** | **3.218** | 100 |

Para comparar: el propio renderer recalcula una vez cada nodo por frame (68 y 165). La librería hace el equivalente a 32 y 20 pasadas completas por el esqueleto en cada frame (HECHO, contado).

**Raycasts por frame y personaje** (HECHO, contados): caminando 1,5 (uno bajo la raíz cada frame y 15 en cada paso: 13 para la altura del arco y 2 para el aterrizaje); corriendo 1,8; **parado 5** (la raíz y 4 para comprobar si los pies están asentados). Coste de un raycast: 8,7 µs contra el plano y **1.783 µs contra la pista de 23.520 triángulos**.

## Hallazgos priorizados

Dos problemas explican casi todo el coste: las matrices recalculadas en cascada (suelo simple) y los raycasts por fuerza bruta (suelo detallado). El resto son mejoras de escala o no merecen el cambio.

### 🔴 1. Matrices recalculadas en cascada — ✅ resuelto

| Campo | Detalle |
| --- | --- |
| Dónde | `core/transforms.ts` (`setWorldQuaternion`, `setWorldPosition`); `ArmController.rotateWorld` y `boneDirection`; `TorsoController` (columna, pecho, cabeza); `PelvisController.reset` + 2 `setWorldPosition` + `setWorldQuaternion`; `BodyController.applyHeading`/`writeRoot`; `TwoBoneIK.solve` |
| Qué ocurre (HECHO) | Cada giro de un hueso recalcula todo lo que cuelga de él (`updateWorldMatrix(false, true)`), y cada lectura de posición o rotación world recalcula todos sus antepasados (`getWorldPosition`/`getWorldQuaternion` llaman a `updateWorldMatrix(true, false)`). Un brazo hace 7 giros y unas 25 lecturas world; girar la columna recalcula brazos, dedos y cabeza. `writeRoot` recalcula el árbol entero dos veces seguidas. Resultado: 2.148 matrices por frame (Mixamo) y 3.218 (Rigify) para 68 y 165 nodos |
| Por qué afecta | Es el 71 % de la CPU de la librería (perfil de V8) y crece con el número de huesos, no con lo que hace la locomoción |
| Impacto estimado | HIPÓTESIS: bajar a unas 6 pasadas por frame (\~400 matrices) haría la librería 2–3× más rápida en CPU: 100 personajes pasarían de \~25 ms a \~9 ms |
| Cómo medirlo | Contador de `Object3D.updateMatrix` por frame y personaje (hoy 2.148) y tiempo por etapa; las referencias exactas (golden) deben seguir idénticas |
| Solución (RECOMENDACIÓN) | Por etapas, sin cambiar el resultado: 1) quitar las pasadas duplicadas (`writeRoot`, `PelvisController.reset` seguido de otra pasada); 2) leer posiciones y rotaciones world de `matrixWorld` ya actualizada, sin volver a recorrer los antepasados; 3) en brazos, torso e IK, escribir los cuaterniones locales de toda la cadena y actualizar su subárbol una sola vez al final de la etapa |
| Riesgo | Medio-alto: todos los controladores leen la pose que dejó el anterior; un orden mal hecho da una pose de un frame antes. Lo cubren las referencias exactas y los 105 tests |

### 🔴 2. Raycasts por fuerza bruta contra mallas detalladas — ✅ resuelto (`StaticGroundDetector`)

| Campo | Detalle |
| --- | --- |
| Dónde | `RaycastGroundDetector.castDown` → `Raycaster.intersectObjects(targets, true)` |
| Qué ocurre (HECHO) | Three prueba el rayo contra cada triángulo de cada malla del suelo (sin estructura de aceleración), recorre los hijos de forma recursiva, ordena todos los impactos y crea un objeto por impacto. Medido: 8,7 µs contra 2 triángulos y 1.783 µs contra 23.520 |
| Por qué afecta | En un suelo real (terreno, ciudad) domina todo: un personaje parado en la pista gasta 7,3 ms por frame, el 95 % en raycasts; 10 personajes caminando dan picos de 53 ms (p99) |
| Impacto estimado | HIPÓTESIS: con un BVH el raycast baja a microsegundos y el coste vuelve a ser el del suelo plano |
| Cómo medirlo | Raycasts por frame, µs por raycast y triángulos del suelo, en el mismo escenario con plano, malla de 25k y malla de 250k triángulos |
| Solución (RECOMENDACIÓN) | El suelo ya es intercambiable (`GroundDetector`, HECHO), así que no hace falta tocar el resto: añadir un detector con BVH (p. ej. la librería `three-mesh-bvh`, a verificar su API y versión antes de usarla) y otro por mapa de alturas; documentar que el raycast de serie es para suelos sencillos |
| Riesgo | Bajo: es un detector nuevo opcional; el actual queda igual |

### 🟠 3. Raycasts que se repiten sin necesidad — ✅ resuelto

| Campo | Detalle |
| --- | --- |
| Dónde | `LocomotionController.updateGaitMode` → `FootstepPlanner.settleError` (parado, cada frame); `BodyController` (sonda bajo la raíz, cada frame); `LocomotionController.swingHeight` (`CLEARANCE_SAMPLES` = 12 tramos: 13 raycasts por paso) |
| Qué ocurre (HECHO) | Parado se lanzan 5 raycasts por frame aunque nada se mueva: 4 para saber si los pies ya están asentados. Cada paso lanza 15 de golpe en un solo frame |
| Por qué afecta | Con suelo detallado, una multitud parada paga 5 × 1,8 ms por personaje, y los 15 rayos de un paso crean picos (≈ 27 ms en un frame) |
| Impacto estimado | HIPÓTESIS: parado, de 5 a 0–1 raycasts por frame; picos de paso, de 15 a 3–4 |
| Cómo medirlo | Raycasts por frame en parado, caminando y al arrancar; frame más lento (máx, p99) con 10 personajes |
| Solución (RECOMENDACIÓN) | Guardar el resultado de `settleError` mientras raíz y pies no se muevan; sondear bajo la raíz solo si se movió; altura del arco con menos muestras o solo cuando el suelo entre despegue y aterrizaje no es plano |
| Riesgo | Bajo-medio: los tests de quedarse quieto y de la pista irregular lo vigilan |

### 🟠 4. Sin niveles de detalle: todo se calcula siempre — ⏳ pendiente

| Campo | Detalle |
| --- | --- |
| Dónde | `ProceduralHuman.update` ejecuta el pipeline completo (dedos, muelles de brazos y torso, variación) para cada personaje |
| Qué ocurre (HECHO) | No hay forma de decirle a un personaje lejano que haga menos |
| Por qué afecta | 100 personajes cuestan 22–31 ms aunque la mayoría ocupe pocos píxeles |
| Impacto estimado | HIPÓTESIS: un nivel lejano (solo raíz, gait, pies e IK, a 30 Hz) costaría un cuarto o menos |
| Cómo medirlo | Coste por personaje en cada nivel; "pop" visual al cambiar de nivel |
| Solución (RECOMENDACIÓN) | Una propiedad `lod` (completo / medio sin dedos ni muelles finos / lejano a menor frecuencia) que decide la aplicación según distancia o visibilidad |
| Riesgo | Medio: saltos visibles al cambiar de nivel y pies que resbalan a menos frecuencia |

### 🟠 5. Simulación acoplada al grafo de escena de Three

| Campo | Detalle |
| --- | --- |
| Dónde | Todos los controladores leen y escriben directamente los huesos de Three |
| Qué ocurre (HECHO) | La pose solo existe en los objetos de Three: cada lectura obliga a tener sus matrices al día (causa de #1), y la simulación no puede salir del hilo principal |
| Por qué afecta | Limita la escala: impide Web Workers, WASM o procesar muchos personajes en bloque |
| Impacto estimado | HIPÓTESIS: con un buffer de pose propio, cientos de personajes en un worker |
| Cómo medirlo | Coste por personaje con 100–500 personajes; tiempo del hilo principal |
| Solución (RECOMENDACIÓN) | Versión futura: pose interna (arrays de cuaterniones y matrices por personaje) calculada de una pasada y copiada a los huesos al final |
| Riesgo | Alto: toca todos los controladores. No antes de #1–#3 |

### 🟡 6. Subpasos cuando bajan los fps

| Campo | Detalle |
| --- | --- |
| Dónde | `ProceduralHuman.update` (`maxTimeStep` 1/30 s, `maxFrameTime` 0,25 s) |
| Qué ocurre (HECHO) | Por debajo de 30 fps cada `update` simula 2 o más pasos (hasta 8): el coste se duplica justo cuando ya va lento |
| Por qué afecta | Con muchos personajes puede entrar en espiral: más lento → más pasos → más lento |
| Impacto estimado | 2× a 20 fps, 3× a 10 fps |
| Cómo medirlo | Subpasos por frame en la telemetría |
| Solución (RECOMENDACIÓN) | Documentarlo y permitir `maxTimeStep` mayor para multitudes, o un límite de subpasos por presupuesto de tiempo |
| Riesgo | Bajo |

### 🟡 7. El coste crece con huesos que la locomoción no usa

| Campo | Detalle |
| --- | --- |
| Dónde | Las cascadas de #1 incluyen huesos de cara, dedos y extras |
| Qué ocurre (HECHO) | Rigify (161 huesos, con cara) recalcula un 50 % más de matrices que Mixamo; solo en el torso, 434 frente a 153 |
| Por qué afecta | Un rig con cara completa paga por huesos que no mueve |
| Impacto estimado | Desaparece casi entero al corregir #1 |
| Cómo medirlo | Matrices por frame con distintos rigs |
| Solución (RECOMENDACIÓN) | Corregir #1; mientras tanto, exportar sin los huesos de cara si no se usan |
| Riesgo | Ninguno |

### 🟢 8. Objetos temporales por frame

HECHO: 7–8 KB por frame y personaje (objetos de parámetros, closures, resultados pequeños); el GC es el 0,2 % de la CPU y su pausa más larga con 100 personajes fue 1,2 ms. No compensa tocarlo ahora: el detalle está en *Garbage collection*.

### 🟢 9. Matemática de la locomoción

HECHO: gait, planificación de pasos, predicción del cuerpo, muelles, ruido y la IK analítica suman menos del 15 %; la planificación solo corre al despegar cada pie (0,03 veces por frame). Optimizarla no se notaría.

## GPU / Three.js

La librería no añade trabajo a la GPU: un personaje procedural cuesta en el render lo mismo que uno animado con clips.

- **HECHO:** fuera de `three-procedural-locomotion/debug`, la librería no crea geometrías, materiales ni texturas, ni marca nada con `needsUpdate`. Solo escribe posición y rotación de huesos y recalcula sus matrices.
- **HECHO:** el trabajo de GPU por personaje es el skinning normal de Three: la deformación en el shader y la subida de las matrices de huesos de cada malla con esqueleto. Mixamo son 2 mallas (2 draw calls); tu Rigify, 3 (cuerpo y ojos).
- **HECHO, medido:** lo que el renderer hace en CPU antes de dibujar (`scene.updateMatrixWorld` y `skeleton.update`) cuesta 0,35 ms con 10 personajes y 4,6 ms con 100. Es aparte de la locomoción y no depende de ella; el renderer vuelve a recalcular todas las matrices una vez, aunque la librería ya lo hizo.
- **HIPÓTESIS:** con 100 personajes la GPU estará limitada por los draw calls (200–300) y los vértices con skinning, no por nada de la librería. Hay que medirlo en tu equipo con `renderer.info` y los timestamps de WebGPU (ver *Qué medir*).

**¿Llevar la locomoción a la GPU (compute shaders)?** No tiene sentido ahora (RECOMENDACIÓN). Cada personaje hace unos cientos de operaciones pequeñas y encadenadas (gait → pasos → caderas → IK → torso → brazos), con ramas, que la GPU ejecuta mal en paralelo. Además, Three lee las matrices de los huesos desde la CPU para dibujar: llevar el cálculo a la GPU obligaría a devolverlo cada frame (1–2 frames de retraso) o a reescribir el skinning por completo. Solo compensaría con cientos o miles de personajes, y antes se gana más con #1–#4. Lo que sí puede ir a la GPU en el futuro es del render, no de la librería: instanciar mallas con esqueleto para multitudes.

## Garbage collection

El GC no es un problema hoy (HECHO, medido): 7–8 KB por frame y personaje, todos objetos pequeños de vida corta que mueren en la generación joven. Con 100 personajes son unos 45 MB/s, una recolección menor cada \~20 frames de 0,7–1,2 ms y en total el 0,1 % del tiempo de frame; el perfil de V8 le da el 0,2 % de la CPU.

Casi no hay `new Vector3()`, `new Quaternion()` ni `new Matrix4()` en el camino de cada frame (HECHO): los vectores y cuaterniones de trabajo se crean una vez en los constructores. La excepción es un `Vector3` por frame en `TorsoController.trackHips` (`this.tmp.clone()`). Lo que se crea cada frame es esto:

| Dónde | Qué crea | Por frame | ¿Importa? |
| --- | --- | --- | --- |
| `LocomotionController.update` | Objetos de parámetros para pelvis, torso y brazos (con sus pares izquierda/derecha) y 2 closures (`mix`, `relax`) | \~15 objetos + 2 closures | No |
| `GaitController.update`, `liftAndPlant` | `before`, un evento por despegue o aterrizaje, `{lift, plant}` en cada consulta de fase | 5–10 | No |
| `BodyController.nextTurn`, `nextSpeed` | `{heading, angularVelocity}`, `{speed, rate}` | 2 (20 al predecir un paso) | No |
| `TwoBoneIK.solve` | Resultado `{reachable, error}` | 2 | No |
| `updateVariation`, `ArmController.integrate`, `updateGaitMode` | Closures (`n`, `scaleOf`, el de `every`) y 2 resultados de `settleError` parado | 2–5 | No |
| `RaycastGroundDetector.castDown` (dentro de Three) | Array de impactos y un objeto por impacto (punto, cara, normal) | 1,5–5 raycasts | Solo con suelo detallado: 42 KB/frame parado en la pista; se arregla con #2 |
| `ProceduralHuman` evento `footstep` | Copia de la posición y el objeto del evento | \~2 por segundo | No |

Tocar esto ahora sería micro-optimización (🟢). Solo valdría la pena después de #1, si con cientos de personajes el GC pasara del \~1 %: los objetos de parámetros pueden ser campos reutilizados sin cambiar nada más.

## Escalabilidad

El coste crece en línea recta con el número de personajes (HECHO): no hay nada compartido que se sature, cada personaje paga lo suyo. El techo lo pone qué suelo se usa.

*(Gráfico original no exportable: coste por frame según el número de personajes, medido en Node con la librería de entonces — Xeon 2,8 GHz, 2 vCPU, modelo Mixamo, 300 frames de calentamiento; render = scene.updateMatrixWorld + skeleton.update.)*

Con suelo detallado el límite llega mucho antes, porque manda el raycast (pista de 23.520 triángulos, sin BVH):

| Personajes | Suelo detallado | Cuello de botella |
| --- | --- | --- |
| 1 | Parado: 7,3 ms por frame. Caminando: un pico de \~27 ms en cada paso (15 raycasts de 1,8 ms) | Raycasts (#2, #3) |
| 10 | Caminando: media 8 ms, p99 53 ms, máximo 71 ms (al menos: parte del recorrido salía de la pista) | Raycasts; los pasos de varios personajes coinciden en el mismo frame |
| 50 | No viable (HIPÓTESIS: \~40 ms de media y picos constantes) | Raycasts |
| 100 | No viable | Raycasts |

Sobre suelo simple, el cuello de botella con 50 y 100 personajes son las matrices de #1 (71 % de la CPU). Con 100 se suma el render en CPU (4,6 ms) y, HIPÓTESIS, los 200–300 draw calls en la GPU. El GC no es el límite en ningún escenario.

## Qué medir

Hoy no hay instrumentación en la librería ni en la demo (HECHO): todo lo de este documento salió de scripts externos que envuelven métodos de Three y de la librería. Antes de optimizar hay que poder repetir estas medidas con un comando y compararlas.

| Métrica | Para qué | Cómo obtenerla |
| --- | --- | --- |
| Tiempo de frame (CPU) y FPS: media, p50, p99, máximo | Lo que nota el usuario; los picos importan tanto como la media | `performance.now()` alrededor de `update` y de `render` en la demo |
| Tiempo de `human.update` por personaje | Coste de la librería separado del render | Igual, por personaje |
| Tiempo por etapa: cuerpo, gait, pasos, pelvis, IK, torso, brazos, dedos | Saber dónde va cada mejora | Telemetría opcional en `LocomotionController` (p. ej. `human.stats`), apagada por defecto para que no cueste |
| Matrices recalculadas por frame | Indicador directo de #1 (hoy 2.148 Mixamo, 3.218 Rigify) | Contador en la misma telemetría |
| Raycasts por frame y µs por raycast | #2 y #3 | Contador en el `GroundDetector` (un envoltorio) |
| Subpasos por `update` | #6 | `ProceduralHuman.update` |
| Allocations y GC | Vigilar que siga siendo despreciable | DevTools → Memory (allocation sampling) y Performance (eventos de GC); en Node, `PerformanceObserver` de tipo `gc` |
| Tiempo de GPU | Saber si con muchos personajes el límite pasa a la GPU | `WebGPURenderer` con `trackTimestamp: true` y `renderer.resolveTimestampsAsync()` (existe en r186) |
| Draw calls y triángulos | Coste del render por personaje | `renderer.info.render.drawCalls` y `triangles` |

RECOMENDACIÓN, en este orden:

1. `npm run bench` en Node, determinista: personajes {1, 10, 50, 100} × suelo {plano, malla de 25k, malla de 250k triángulos} × {parado, caminando, corriendo, giro de 180°, moveTo} × {Mixamo, Rigify}. Salida en JSON con media, p99, máximo, matrices, raycasts y KB por frame, guardada como línea base.
2. Telemetría opcional `human.stats` (tiempos por etapa y contadores), sin coste cuando está apagada.
3. Una página de estrés en la demo: control de N personajes y un panel con FPS, ms de CPU (librería y render), ms de GPU, draw calls y raycasts.
4. Que cada optimización compare contra la línea base y mantenga las referencias exactas idénticas.

## Ranking

Primero medir, luego atacar las matrices y los raycasts: explican casi todo el coste (71 % de la CPU en suelo simple, 95 % en suelo detallado) y se pueden arreglar sin cambiar el movimiento.

**1. Primero**

1. `npm run bench` y su línea base (*Qué medir*, paso 1): sin ella no se puede demostrar ninguna mejora.
2. Matrices en cascada (#1), en tres pasos verificados cada uno con las referencias exactas: quitar pasadas duplicadas, leer de `matrixWorld` sin recorrer antepasados, una actualización por cadena al final de cada etapa. Objetivo: de 2.148 a \~400 matrices por frame.
3. Raycasts repetidos (#3): `settleError` parado y la sonda de la raíz sin movimiento. Cambio pequeño y de riesgo bajo.

**2. Después**

1. Detector de suelo rápido (#2): BVH o mapa de alturas como `GroundDetector` opcional, y documentar cuándo usar cada uno.
2. Menos raycasts por paso (#3): altura del arco con menos muestras o solo en suelo no plano.
3. Telemetría `human.stats` y página de estrés en la demo.
4. Niveles de detalle (#4), cuando lo anterior esté medido.

**3. No tocar** (el coste/beneficio no lo justifica)

- Los objetos temporales y closures por frame (#8): 0,2 % de la CPU.
- La matemática de gait, pasos, predicción, muelles, ruido y la IK analítica (#9): menos del 15 % entre todo.
- Llevar la locomoción a la GPU: más lento por la vuelta de datos, y no es donde está el coste.
- Las ayudas de depuración: no están en el camino de la librería.

**4. Para una versión futura**

- Pose interna separada de los huesos de Three (#5): habilita Web Workers, WASM y procesar muchos personajes en bloque.
- Subpasos limitados por presupuesto de tiempo (#6).
- Multitudes de cientos: instanciado de mallas con esqueleto en el render y animación simplificada a distancia.

Los benchmarks de esta auditoría son scripts temporales del entorno de trabajo, no están en el proyecto; el paso 1 de *Primero* los convierte en parte de él.
