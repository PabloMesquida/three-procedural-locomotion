# Guía de uso

[English](../en/guide.md)

`three-procedural-locomotion` mueve un modelo humanoide de Three.js sin animaciones: a partir de una velocidad y un rumbo
deseados calcula el ritmo de los pasos (gait), dónde apoyar cada pie (footstep planning), la pierna con IK y
la postura del cuerpo (pelvis, torso, cabeza, brazos). Camina, corre, gira, se agacha, salta y va hasta un
punto, sobre cualquier suelo que pueda consultar con un rayo.

Ejemplo completo y comprobado: [`examples/basic.ts`](../../examples/basic.ts).

## Crear el personaje

```ts
import { createProceduralHuman, mixamoMapping } from 'three-procedural-locomotion';

const gltf = await new GLTFLoader().loadAsync('/humanoid.glb');
gltf.scene.position.set(2, 0, -3); // dónde empieza (opcional): queda de pie ahí, sobre el suelo de debajo
scene.add(gltf.scene);

const human = createProceduralHuman({
  model: gltf.scene,          // la librería lo mueve y lo orienta
  mapping: mixamoMapping,     // nombres de los bones (otros rigs: docs/es/skeletons.md)
  ground: [floorMesh],        // mallas del suelo, o un GroundDetector propio
  preset: 'tired',            // opcional: estilo de marcha
  config: { walkSpeed: 0.9 }, // opcional: solo lo que quieras cambiar
});

// cada frame, después de dar las órdenes y antes de renderizar
human.update(dt);
```

| Opción | Por defecto | Qué hace |
|---|---|---|
| `model` | — | Raíz del personaje (`gltf.scene`). Puede colgar de cualquier objeto movido, girado o escalado uniformemente. |
| `mapping` | — | Qué bone es cada parte del cuerpo (`mixamoMapping`, `rigifyMapping` o uno propio). Si falta uno obligatorio lanza `RigMappingError`; los avisos (del mapping y del modelo: escala, pose de reposo, origen, proporciones; ver [esqueletos](skeletons.md#3-comprobar)) quedan en `human.warnings`. |
| `ground` | — | `Object3D[]` (raycast contra esas mallas y sus hijos) o un `GroundDetector` (p. ej. `StaticGroundDetector`, ver [Suelo](#suelo)). |
| `colliders` | — | Lo que no es suelo y no debe atravesar (troncos, columnas, paredes, barandas, muebles): mallas o cilindros verticales `{ center, radius, height? }`. `moveTo` los rodea; con tus controles se desliza a lo largo de ellos (de frente, se para delante). Una malla cuenta por la caja de su geometría, girada como ella: dale formas simples (un cilindro invisible para un tronco; un árbol detallado bloquearía toda la caja de su copa). Solo cuenta lo que está entre el escalón que puede subir y su altura (pasa por debajo de una viga). Pueden ser las mismas mallas que `touchables`. También `human.colliders = […] | null`. |
| `forward` | estimado | Dirección (world, horizontal) hacia la que mira el modelo en reposo. Se estima con los dedos de los pies. |
| `preset` | — | `'tired'`, `'sneaky'`, `'athletic'` o `'heavy'`. |
| `config` | — | Parámetros a cambiar ([referencia](parameters.md)). Mandan sobre el `preset`. |
| `bodyScale` | `'auto'` | Factor de las longitudes de la configuración (ver *Tamaño*). |
| `speedScale` | `'auto'` | Velocidades y ritmos según el tamaño, como entre un niño y un adulto; `'off'`: los de la configuración (ver *Tamaño*). |
| `maxTimeStep` | 1/30 s | Paso máximo de simulación (ver *Frames irregulares*). |
| `maxFrameTime` | 0,25 s | Tiempo máximo simulado por llamada a `update`. |
| `seed` | 1 | Semilla de la variación natural: personajes con semillas distintas no se mueven igual; la misma semilla repite el mismo movimiento. |

Requisitos de la escena: metros (1 unidad = 1 m) y eje Y hacia arriba.

**Renderer: WebGPU o WebGL.** La librería solo mueve huesos (en la CPU, unos microsegundos por personaje) y
consulta el suelo con raycasts: no depende del renderer. `examples/basic.ts` usa
`WebGPURenderer` (`three/webgpu`), que cae a WebGL 2 si el navegador no tiene WebGPU; con `WebGLRenderer`
funciona igual. Se puede importar Three desde `three/webgpu` en tu aplicación aunque la librería importe de
`three`: los dos comparten las mismas clases (`three.core.js`). El skinning de la malla lo hace el renderer en la GPU.

## Control

Dos formas, que se pueden mezclar:

- **Continua** (teclado, mando, IA propia): `targetSpeed` (m/s) y `targetHeading` (rad). El cuerpo acelera,
  frena y gira hacia ellos con sus límites (aceleración, velocidad de giro, aceleración lateral).
- **Por destino**: `moveTo(punto, { run })` va hasta un punto del suelo (con `run`, trotando, a `jogSpeed`); si queda de lado gira caminando, en
  una curva más cerrada cuanto más cerca está; si queda detrás (más de 120°) frena y gira hacia él en 2–3
  pasos grandes que ya se desplazan hacia la nueva dirección (~1 s para 180°, como una persona) y sale en
  línea recta. Ajusta la velocidad para no
  rodearlo y frena para detenerse en él (±5–10 cm). Emite `arrive`.
  Dar `targetSpeed` o `targetHeading` a mano lo cancela; `stop()` también.
  Si en el camino hay algo que no puede pisar (una contrahuella más alta que `maxStepUp`, un desnivel más hondo
  que `maxStepDown`, un hueco), al recibir el destino planea una ruta que lo rodea y la sigue desde el principio,
  girando en curvas, sin acercarse antes a chocar; a una plataforma sube por su escalera. Si no puede llegar al
  punto, va al más cercano que alcanza (`moveTarget`). Planea sobre el suelo que pisa, con las mismas reglas que
  los pasos, y rodea los `colliders` (un tronco, columnas, paredes) con el cuerpo fuera de ellos. Con
  `avoid: false`, en línea recta.
- **Clic para ir**: raycast contra el suelo en `click` y el punto a `moveTo`. Con OrbitControls (o cualquier control de
  cámara con el ratón), no uses solo `pointerdown`: también salta al empezar cada arrastre de la cámara. Guarda
  dónde fue el `pointerdown` y, en `click`, ignóralo si el puntero se movió más de unos píxeles (ver
  [`examples/basic.ts`](../../examples/basic.ts)).
- **Por una ruta**: `followPath(puntos, { run })` (con `run`, trotando) sigue los puntos que le das (por ejemplo, de tu navmesh) con
  curvas y se para en el último; no los comprueba.

Además: `targetCrouch` (0 = de pie, 1 = agachado), `jump()` (devuelve `false` si ya está saltando).

**Rumbo**: `0` = la orientación del modelo al crearlo; positivo = a la izquierda (visto desde arriba, sentido
antihorario). Para girar hacia una dirección del mundo `dir` (horizontal, normalizada):

```ts
const current = human.locomotion.body.state.forward; // dirección actual (world)
const turn = Math.atan2(new Vector3().crossVectors(current, dir).y, current.dot(dir));
human.targetHeading = human.heading + turn;
```

**Cambios de dirección**: no gira en el sitio ni de golpe. Cuanto mayor es el giro que le queda por hacer, más
frena (`turnSlowdown`: con 180° pendientes va a ~0,55 × la velocidad; con 15°, igual) y la curva se cierra; al
completar el giro recupera la velocidad. La cabeza y el pecho miran antes hacia el nuevo rumbo, y cada pie
aterriza ya orientado hacia donde irá el cuerpo, sin acelerar el ritmo de los pasos; si aun así la pierna se
torcería más de 20° (el pie que ya estaba apoyado al empezar el giro), ese pie pivota sobre la punta. La rapidez del giro la
marcan `turnSpeed` y `maxLateralAcceleration`.

Correr no es un modo aparte: `walkSpeed` (1,4 m/s) es la velocidad normal de caminar, pero se sigue caminando, a
paso vivo, hasta `runStartSpeed` (1,7 m/s); por encima la marcha pasa gradualmente a carrera (`runBlend`) en
`runTransition` (completa hacia 2,3 m/s; una persona cambia hacia los 2 m/s). Hasta `jogSpeed` (3 m/s) trota, con los
parámetros `jog*`; por encima el trote pasa gradualmente a carrera, completa en `runSpeed` (5 m/s, la máxima), con los
`run*`: más pasos por segundo y más largos, un vuelo más largo con la rodilla arriba y el talón hacia el glúteo, más
inclinación y más braceo (`runPace`, 0 → 1).
Agachado la velocidad se limita a `crouchMaxSpeed`, en un camino angosto a `narrowMaxSpeed` y en una cornisa a
`ledgeMaxSpeed`.

## Estado

| Lectura | Qué es |
|---|---|
| `position` | Posición de la raíz (world). Es de solo lectura: para moverlo, ver *Teletransportar*. |
| `speed`, `velocity` | Velocidad horizontal (m/s) y vector velocidad (world). |
| `heading` | Rumbo actual (rad, misma convención que `targetHeading`). |
| `gaitMode` | `'idle'` (quieto, pies apoyados) o `'walk'` (dando pasos, caminando o corriendo). |
| `runBlend` | 0 = caminar, 1 = correr (trotar o correr). |
| `runPace` | Corriendo: 0 = trote (hasta `jogSpeed`), 1 = carrera (en `runSpeed`). |
| `crouch` | Agachado actual (0–1). |
| `balance` | Cuánto hace equilibrio en un camino angosto (0–1, ver [Caminos angostos](#caminos-angostos)). |
| `ledge` | Cuánto va por una cornisa de espaldas a la pared (0–1, ver [Cornisas](#cornisas)). |
| `airborne`, `jumpPhase` | En el aire; fase del salto: `GROUNDED`, `TAKEOFF`, `AIRBORNE`, `LANDING`. |
| `moveTarget` | Destino del `moveTo` (o `followPath`) en curso, o `null`. |
| `movePath` | Lo que queda de su ruta (puntos, una copia; el último es `moveTarget`), o `null` si va en línea recta. |
| `footPhase(lado)` | `PLANT` (aterriza de talón), `PLANTED`, `LIFT` (levanta el talón) o `SWING`. |
| `footGround(lado)` | Lo que encontró la colocación del pie bajo él (para `FootDebug`, ver *Avanzado*). |
| `legLength`, `bodyScale`, `speedScale` | Largo de pierna del modelo (m), factor de las longitudes y de las velocidades. |
| `config`, `effectiveConfig` | Configuración sin escalar / la que se usa (longitudes × `bodyScale`). |

## Eventos

```ts
const off = human.on('footstep', ({ side, position, speed }) => playStep(side, position, speed));
human.on('liftoff', ({ speed }) => {});        // despega en un salto
human.on('land', ({ impactSpeed }) => {});     // aterriza (velocidad de caída, m/s)
human.on('arrive', ({ position }) => {});      // llegó al destino de moveTo (no si se cancela)
human.on('touch', ({ side, point }) => {});     // apoyó una mano en una superficie
off();                                         // o human.off('footstep', listener)
```

`footstep` se emite cuando un pie toca el suelo, también al aterrizar de un salto (uno por pie).
Las posiciones que llegan en los eventos son copias: se pueden guardar.

## Configuración

Todos los parámetros son opcionales y están, con nombre, unidad y valor por defecto, en la
**[referencia de parámetros](parameters.md)**. Se validan: un nombre mal escrito, un valor no numérico o fuera
de rango lanza `ConfigError` con la lista de problemas (`error.problems`, en inglés) y no se aplica nada.

```ts
human.setConfig({ stepHeight: 0.07, armSwing: 22 }); // en ejecución, se aplica en el siguiente frame
```

Todos se pueden cambiar en ejecución salvo los marcados ⚑ en la referencia (hoy solo `kneePoleDistance`),
que avisan por consola. `setConfig` acumula cambios sobre la configuración actual.

## Estilos (presets)

`tired` (cansado), `sneaky` (sigiloso), `athletic` (atlético) y `heavy` (pesado). Son solo conjuntos de
parámetros (`stylePresets`); la referencia muestra qué cambia cada uno.

```ts
createProceduralHuman({ ..., preset: 'sneaky', config: { walkSpeed: 0.8 } }); // config manda sobre el estilo
human.applyPreset('heavy');                       // en ejecución
human.applyPreset('heavy', { runSpeed: 2.8 });    // con cambios propios encima
human.applyPreset('default');                     // sin estilo
```

`applyPreset` reinicia **toda** la configuración (por defecto + estilo + `overrides`): lo cambiado antes con
`setConfig` se pierde salvo que lo pases en `overrides`. Para un estilo propio, crea un objeto con los
parámetros y pásalo como `config` o con `setConfig`.

## Controles básicos

Para cambiar cómo camina sin entrar en los 152 parámetros: trece controles de alto nivel (`basicControls`), cada
uno mueve a la vez varios parámetros. Son una capa sobre la configuración, como los estilos:
`applyBasicControls(base, valores)` devuelve los parámetros resultantes para `setConfig`.

```ts
import { applyBasicControls, defaultConfig, stylePresets } from 'three-procedural-locomotion';

human.setConfig(applyBasicControls(defaultConfig, { tempo: 1.2, armSwing: 0.6, intensity: 1.3 }));
// sobre un estilo:
const base = { ...defaultConfig, ...stylePresets.tired };
human.setConfig({ ...base, ...applyBasicControls(base, { lean: 5 }) });
```

| Control | Rango (neutro) | Qué hace |
|---|---|---|
| `tempo` (Ritmo) | 0,6–1,6 (1) | más rápido o más lento, con pasos del mismo tamaño |
| `stride` (Zancada) | 0,7–1,2 (1) | pasos más largos y más lentos a la misma velocidad |
| `stepHeight` (Altura del paso) | 0,3–2 (1) | cuánto levanta los pies y articula el pie |
| `knees` (Flexión de rodillas) | 0–2 (1) | marcha más elástica o más rígida |
| `hipSway` (Balanceo de cadera) | 0–2,5 (1) | movimiento de la pelvis y del peso |
| `armSwing` (Braceo) | 0–2,5 (1) | amplitud del balanceo de los brazos |
| `armSpread` (Separación de brazos) | −5–20° (0) | cuánto se separan los brazos del cuerpo, parado, caminando y corriendo |
| `armForward` (Posición de brazos) | −15–15° (0) | brazos más adelante o más atrás, parado y como centro del balanceo |
| `lean` (Inclinación) | −10–25° (0) | postura hacia delante o erguida |
| `looseness` (Soltura) | 0,5–2 (1) | cuerpo suelto, con inercia, o rígido |
| `agility` (Reactividad) | 0,4–2,5 (1) | arranca, frena y gira más rápido o más despacio |
| `naturalness` (Naturalidad) | 0–3 (1) | variación entre pasos |
| `intensity` (Intensidad) | 0–1,75 (1) | escala a la vez altura del paso, rodillas, balanceo y braceo |

Qué parámetros mueve cada uno: `basicControls[i].params`; para una interfaz, `label` y `description` traen el
nombre y una frase en inglés y en español (`label.es` = "Ritmo"…). Los valores fuera de rango se recortan, y todo el
rango de cada control está probado (marcha limpia con los tres modelos de los tests). Los parámetros técnicos
(fracciones del ciclo, sondas, salto, cabeza, point and click…) solo se ajustan uno a uno.

Para combinar con ajustes a mano, aplícalos después: `{ ...base, ...applyBasicControls(base, valores),
...ajustesAMano }`; así un parámetro ajustado a mano no lo mueve un control básico.

## Manos

Si el mapping incluye los dedos (`mixamoMapping` y `rigifyMapping` los incluyen), la mano se relaja en vez de
quedarse como en la pose de reposo del modelo (que suele tener los dedos rectos y separados): cada falange algo
doblada hacia la palma, los dedos juntos y el pulgar hacia el índice, y siguen al balanceo de la mano con un pequeño
retraso. `fingerCurl` (1 por defecto) dice cuánto: 0 = como en el modelo, más de 1 = mano más cerrada.

## Tocar superficies

Al pasar junto a una columna, una pared o la baranda de un puente, el personaje puede acercar la mano y
tocarla, sin dejar de caminar. Se le dice qué se puede tocar, igual que el suelo:

```ts
const human = createProceduralHuman({ model, mapping, ground: [floor], touchables: [columns, wall, railing] });
human.touchables = [otherZone];   // se puede cambiar en cualquier momento (null = nada)
human.autoTouch = false;          // no tocar solo (por defecto, sí)
human.touchSlide = false;         // tocar y soltar, sin deslizar la mano (por defecto, desliza)
```

Con `touchables` busca solo, con rayos cortos desde donde estará el hombro al terminar el gesto (también
subiendo o bajando una escalera o una rampa): paredes y columnas al lado o algo por delante (rayos horizontales a
la altura del pecho), con sitio para la palma (no un poste fino ni el costado de un pasamanos), y barandas a la
altura de la cadera (rayos hacia abajo) que sigan por delante (no la cabeza de un pilar), y no las caras que tiene
de frente. Toca cada objeto una vez mientras siga cerca
(una pared larga no la toca a cada paso; pararse y volver a andar es otra pasada, y puede volver a tocarlo), con cada mano por su lado (puede ir con una en la pared y tocar
columnas con la otra), caminando o parado; corriendo o en el aire, no. Lo que queda lejos de la mano no lo
intenta: no estira el brazo de más.

Pasando junto a una columna o un tronco, el camino tiene que llevar su superficie a entre ~0,2 y ~0,55 m del centro
del cuerpo (medido con el personaje de referencia: un tronco de 15 o 30 cm de radio): más cerca, el brazo quedaría
demasiado doblado; más lejos, no llega (`touchMaxReach`). Con el tronco también como collider, `moveTo` ya lo
rodea a esa distancia.

Dale formas simples. Caminando lanza unos 150 rayos por segundo (más mientras desliza la mano), y el `Raycaster`
de three no tiene estructura de aceleración: prueba cada triángulo de cada malla cuya esfera envolvente cruce el
rayo, así que una malla detallada (un árbol de 60 000 triángulos) es cara. Pon en su lugar una malla simple
invisible (`visible = false`: los rayos la encuentran igual) y dale esa: un cilindro para un tronco, cajas para una
pared. La misma malla puede ser un collider. La mano se apoya en esa forma: que coincida con la superficie visible.

El gesto, medido en los alcances de CMU (ver [naturalidad](naturalness.md#tocar-al-pasar)): la mano va de su
balanceo a la superficie en ~0,75 s con la velocidad en campana, por un recorrido algo curvo (el codo se dobla a
mitad y se estira al final); se apoya con la palma hacia la superficie y los dedos abiertos (hacia donde menos
gira la muñeca: arriba en una pared al lado, hacia fuera en una baranda). Caminando junto a una pared o una
baranda, la desliza por ella mientras siga al lado: arranca quieta, se pone a la velocidad del cuerpo y va junto
al hombro, pegada a la superficie (en una pared, bajando poco a poco a la altura de la cintura); cuando la
superficie se acaba (el final de la pared, una esquina) o deja de ser lisa (un escalón, o algo que sobresale por
delante, como una pilastra, antes de que lleguen los dedos) la suelta, y pasado el saliente la vuelve a apoyar.
Una columna es demasiado curva para deslizar: la toca y, cuando queda atrás, la suelta, igual que con
`touchSlide = false`. Parado, suelta tras un momento.

Para mantener la mano en una columna, un tronco o una pared curva al rodearlos, dale el radio más pequeño que
debe seguir: `config: { touchCurveRadius: 0.05 }` (m; 0 por defecto). Entonces además busca la superficie donde
estará el hombro siguiendo el giro del cuerpo, la mano va al lado del hombro (por dentro de la curva recorre menos
que el cuerpo: ~0,17 de lo que recorre él alrededor de un tronco de 10 cm) con la palma girando con la superficie,
la suelta cuando la superficie se acaba, el brazo no llega o el cuerpo se aleja, y puede volver a apoyarla en el
mismo objeto en la misma vuelta. La palma gira suave con las normales de la malla: con normales suaves (vértices
compartidos, como `CylinderGeometry`), de forma continua; con normales planas (una por cara) la normal se suaviza
en 0,1 s para que la mano no salte entre caras. Cuesta un rayo más por frame mientras desliza (~60 por segundo).
La mano vuelve a colgar en ~0,7 s, partiendo de donde estaba y con la velocidad que llevaba. El brazo del otro
lado sigue balanceándose.

A mano:

```ts
human.touch(point);                         // la apoya (y desliza, caminando) y la retira como al pasar; false si no llega
human.touch(point, { slide: false });       // sin deslizar
human.touch(point, { hold: true });         // la deja apoyada…
human.releaseTouch();                       // …hasta soltarla (o hasta que no llegue)
human.touch(point, { side: 'left', normal }); // mano y normal de la superficie (si no, la busca con touchables)
human.touchPhase('right');                  // 'none' | 'reach' | 'contact' | 'release'
```

Los tiempos y el alcance están en la sección *Tocar superficies* de la [referencia](parameters.md#tocar-superficies).
Si el rig no tiene dedos, la palma se toma como la cara de abajo de la mano en la pose de reposo (en T).
Un detector propio (física, BVH…) implementa `SurfaceDetector` (`cast(origen, dirección, distancia, out)`).

## Variación natural

Una persona nunca da dos pasos iguales. Con `variation` (1 por defecto; 0 = todos los pasos idénticos)
la cadencia, la inclinación del tronco, la mirada y el balanceo de cada brazo cambian un poco y despacio,
con un ruido suave que depende de la semilla (`seed`) del personaje. Es determinista: la misma semilla
repite exactamente el mismo movimiento (útil para tests o repeticiones). Para una multitud, da a cada
personaje su propia semilla.

## Tamaño del personaje

Las longitudes de la configuración (marcadas ↔ en la referencia: largo, ancho y altura de paso, cuánto
bajan las caderas, márgenes…) están pensadas para un humano de 1,83 m. Con `bodyScale: 'auto'` (por defecto)
se multiplican por *largo de pierna del modelo / 0,879 m*: un personaje de 1,1 m o de 2,7 m conserva sus
proporciones sin tocar nada. Y con `speedScale: 'auto'` (por defecto) también sus velocidades y su ritmo se
adaptan al tamaño (ver abajo).

- `bodyScale: 1`: las longitudes se usan tal cual, en metros.
- Los valores que pasas en `config` / `setConfig` son siempre los del personaje de referencia;
  `human.effectiveConfig` muestra los escalados.
- Escalar el modelo (`gltf.scene.scale.setScalar(0.6)`) o un padre funciona: el largo de pierna se mide en
  world space.

**Velocidades según el tamaño** (`speedScale: 'auto'`, por defecto). Con solo las longitudes escaladas, un
personaje pequeño que corre a 3 m/s da pasitos frenéticos y uno grande que camina a 1 m/s parece ir a cámara
lenta. Con `speedScale: 'auto'` se mueven como lo harían de verdad (semejanza dinámica, la que relaciona la
marcha de un niño con la de un adulto): con *s* = `bodyScale`,

- velocidades × √s (`walkSpeed`, `runStartSpeed`, `jogSpeed`, `runSpeed`, `crouchMaxSpeed`, la de salto…): un niño
  de 1,1 m (s ≈ 0,6) camina a ~1,1 m/s, empieza a correr a ~1,3 m/s, trota a ~2,3 m/s y corre como mucho a ~3,9 m/s;
- ritmos ÷ √s (pasos por segundo, velocidad de giro, frecuencias de los muelles) y duraciones × √s;
- aceleraciones y gravedad, iguales; los saltos son de altura proporcional a su tamaño.

```ts
human.targetSpeed = human.config.walkSpeed * human.speedScale; // su velocidad de marcha
createProceduralHuman({ model, mapping, ground, speedScale: 'off' }); // velocidades sin adaptar
```

Con el tamaño de referencia (`bodyScale` 1) no cambia nada. Con `'off'`, velocidades, aceleraciones, gravedad,
tiempos y ángulos no se escalan: un niño y un gigante a 1 m/s van a 1 m/s, cada uno con pasos de su tamaño.

`targetSpeed`, `speed`, `velocity` y las velocidades de los eventos son siempre m/s reales; `config` sigue con los
valores del personaje de referencia. Es exacto: el mismo movimiento a otra escala, con el tiempo × √s (lo prueban
los tests). Por dentro, la simulación usa una copia geométrica de la configuración (velocidades y aceleraciones
× s, que es lo que muestra `effectiveConfig`) y un reloj que corre a 1/√s.

## Suelo

Con `ground: [mallas]` se hace raycast vertical contra esas mallas (y sus hijos). Conviene pasar solo el suelo
(no paredes ni el propio personaje). Sirve para suelo que se mueve, pero el raycast de Three recorre todos los
triángulos: con mallas de miles de triángulos cada personaje cuesta milisegundos.

**Suelo estático grande** (terrenos, escaleras, ciudades): usa `StaticGroundDetector`. Precalcula un índice de
los triángulos (una vez: ~0,1 s por 50.000, ~0,6 s por 500.000) y cada consulta cuesta microsegundos, sea cual sea
el tamaño. Devuelve el mismo suelo que el raycast. Crea uno y compártelo entre todos los personajes:

```ts
import { StaticGroundDetector } from 'three-procedural-locomotion';

const ground = new StaticGroundDetector([terrainMesh, stairs]);
const a = createProceduralHuman({ model: modelA, mapping, ground });
const b = createProceduralHuman({ model: modelB, mapping, ground });

// Si el suelo cambia (se mueve, se edita, otra lista): ground.targets = [...]; ground.rebuild();
```

Solo lee mallas normales (`Mesh`); `InstancedMesh`, `SkinnedMesh` y `BatchedMesh` se ignoran con un aviso. Para
suelo que se mueve cada frame (plataformas, ascensores), usa el raycast (`ground: [mallas]`), o combina los dos
con un `GroundDetector` propio que consulte ambos y se quede con el más alto.

**Bloques altos.** El suelo se busca desde `groundProbeHeight` (1,5 m) por encima de los pies, pero un bloque
más alto (una tarima, una roca grande, un cerro del terreno) sigue siendo una pared, no algo en lo que el personaje
se mete: si el rayo empieza dentro de él (lo más cercano por encima es su cara de arriba, vista desde dentro, y no
un techo visto desde abajo), los dos detectores devuelven su cara de arriba. Para eso el bloque necesita un
material de un solo lado (`FrontSide`, el de por defecto, o `BackSide`): una cara `DoubleSide` no tiene dentro.
Una superficie que mira hacia arriba sin nada en medio cuenta como la cara de arriba de lo que tiene debajo (como
en una malla de terreno): un piso de arriba o un puente por debajo del que pasa el personaje, con algo de grosor
(una caja), no como un plano suelto. Por debajo de algo cuya cara de abajo está más alta que `groundProbeHeight`,
pasa.

Para otro sistema (heightmap, motor de física) implementa `GroundDetector`:

```ts
const heightmapGround: GroundDetector = {
  castDown(origin, maxDistance, out) {
    const y = heightAt(origin.x, origin.z);
    if (origin.y - y > maxDistance) return false;
    out.point.set(origin.x, y, origin.z);
    out.normal.copy(normalAt(origin.x, origin.z)); // unitaria, hacia arriba
    out.distance = origin.y - y; // negativa si el suelo está por encima del origen (dentro de un cerro): una pared
    return true;
  },
};
```

El cuerpo es cinemático: solo se busca el suelo bajo el cuerpo
y bajo cada pie (obstáculos que no son suelo, solo si se los das como `colliders`). Escalones bajos y pendientes
moderadas sí: los pies se apoyan en su altura y se inclinan. También el terreno irregular sin escalones, como un
montón de rocas: cada pie se apoya en lo más alto que tiene debajo (sobre un hueco entre rocas la planta puede
quedar unos centímetros por encima del suelo bajo el tobillo), y el cuerpo sigue el suelo (probado en montículos de
rocas de hasta 0,8 m: `tests/rocks.test.ts`).

### Escaleras

Las escaleras y los escalones se detectan en la geometría, sin marcar nada: cuando un paso aterrizaría en un
cambio de nivel, el personaje mide el suelo por delante en su dirección de avance, encuentra los bordes y:

- apoya cada pie en una huella, entero (el talón sobresale solo si la huella es más corta que el pie), sin
  saltarse ninguna: un paso por escalón, subiendo o bajando;
- frena para que cada paso avance un escalón, y vuelve a acelerar poco a poco cuando la escalera termina;
- el cuerpo sigue una línea suave sobre las huellas en vez del suelo justo debajo y se inclina algo hacia
  delante (más al subir que al bajar), y el pie en el aire libra los bordes con toda la planta (talón y punta
  de los dedos): al subir, sube primero; al bajar, primero avanza por encima del borde y luego baja; en un
  escalón el pie no apoya de talón: plano al subir, de antepié al bajar; al subir, el pie de atrás levanta el
  talón lo que haga falta para empujar;
- una contrahuella más alta que `maxStepUp` es una pared: se para delante; de un desnivel más hondo que
  `maxStepDown` no baja: se para en el borde (los dos, 0,35 m por defecto, escalados con el tamaño). Mira lo
  bastante lejos para frenar a tiempo, también corriendo, y recuerda los bordes mientras está cerca (hacia
  dónde van y dónde acaban; los dos de una esquina), así que también frena delante cuando llega en diagonal,
  gira hacia ellos o vuelve a arrancar hacia ellos (varios `moveTo` seguidos a su lado), y camina a lo largo
  de ellos o rodea una esquina sin pararse. Se para con los pies delante del borde, también llegando en
  diagonal, y si quedó más cerca (venía a lo largo de él), retrocede sobre los pies. El cuerpo nunca lo cruza
  (un `moveTo` planea una ruta que lo rodea; con `avoid: false`, o con tus controles, se para delante).

Sirve cualquier medida de escalón hasta esos límites (probado de 10 × 40 cm a 30 × 30 cm, subiendo y bajando).
La forma del paso, la inclinación y el apoyo se comparan con capturas de movimiento de personas en escaleras
(CMU).

Para que la punta de los pies no entre en una contrahuella ni el talón quede colgando de un borde, al crear el
personaje mide en la malla del modelo hasta dónde llegan sus pies por delante del tobillo y por detrás (la
planta y el zapato: los vértices que mueven el pie, los dedos o la pierna, por debajo del tobillo). Los modelos
varían mucho: con la articulación de los dedos muy atrás, la punta puede quedar a 25 cm del tobillo. Sin mallas
(solo el esqueleto) supone las proporciones habituales.

También valen las escaleras sin contrahuella (huellas sueltas con un hueco entre ellas), con suelo debajo o sobre
el vacío: un hueco más corto que el pie, más bajo que las huellas de los dos lados, se salta, y el escalón se mide
de huella a huella. Donde no hay suelo bajo la raíz (sobre un hueco), el cuerpo sigue la línea sobre las huellas.
Un hueco sin suelo más ancho es un desnivel más hondo que `maxStepDown`: se para en el borde.

También valen las escaleras en curva y de caracol, subiendo y bajando, hacia los dos lados: mientras el cuerpo
gira, el suelo se mide a lo largo del arco que sigue el pie (alrededor del centro del giro) en vez de en línea
recta, el aterrizaje se mueve por ese arco, y la profundidad de las huellas se toma por donde va el cuerpo (por
dentro son más estrechas). Para seguir una escalera curva, hazlo girar por ella
(`targetHeading`) o dale la ruta con `followPath`. En un caracol cerrado tiene que ir despacio: `turnSpeed`
limita lo cerrado que puede girar (a 1 m/s y 60°/s, un radio de 1 m más o menos). Probado en caracoles de
1–1,4 m y curvas de 5 m.

Consultas al suelo por personaje: una por frame (bajo el cuerpo) y unas 15 al empezar cada paso (dónde aterriza
y por dónde pasa la punta del pie), más una cada dos pasos bastante más adelante (una pared o un desnivel ante el
que frenar a tiempo; unas 10 más si ahí el suelo queda fuera del alcance de un escalón, o unas 35 la primera vez que encuentra una pared, y unas 25 por paso mientras camina a lo largo de una). En
una escalera, unas 50–90 por paso (el perfil del suelo por delante).
Parado, si el suelo bajo los pies cambia sin que se mueva el cuerpo (un objeto que aparece, un cambio de
`setConfig`), se recoloca en como mucho 0,25 s.

### Caminos angostos

Una viga, lo alto de un muro, un riel, un bordillo alto: los caminos angostos también se detectan en la geometría,
sin marcar nada. Mientras se mueve (y cada segundo parado) el personaje mira el suelo a lo ancho de su dirección de
avance, un poco por delante del cuerpo (más lejos cuanto más rápido va, para frenar a tiempo): si el suelo a la
altura del cuerpo cae (10 cm o más, escalado con el tamaño) a los dos lados en menos de `narrowWidth` (30 cm por
defecto), el camino es angosto y camina haciendo equilibrio (`balance`, 0–1, cambia en `1 / narrowRate` s):

- un pie delante del otro por el medio del camino (`narrowStepWidth` entre ellos); el pie en el aire rodea un poco
  el tobillo de apoyo en vez de atravesarlo, y el cuerpo vuelve al medio si iba desviado;
- más despacio (`narrowMaxSpeed`, 0,6 m/s);
- con los brazos abiertos en A (`narrowArmAbduction`, `narrowElbowBend`, `narrowArmForward`), casi sin
  balanceo (`narrowArmSwing`) y con correcciones lentas e irregulares, subiendo uno y bajando el otro
  (`narrowArmTilt`); los hombros suben un poco con los brazos. Mira hacia abajo, al camino (`narrowGaze`).

Girado hacia uno de sus costados, o dando la vuelta en el sitio, sigue en el camino: los pies se apoyan en él (el
pie entero, si cabe) y, hacia un costado que no puede bajar (más de `maxStepDown`, como lo alto de un muro), el
cuerpo se para antes del borde, sobre el camino. Hacia uno que sí puede bajar (una viga baja sobre el suelo), baja
de él.

Parado sobre él, los pies quedan uno al lado del otro, lo más juntos que pueden sin superponerse. Cuando el camino
se ensancha o se acaba, vuelve a caminar normal al llegar ahí. Con `narrowWidth: 0` nunca hace equilibrio. Una
línea pintada en el suelo no es un camino: hace falta un desnivel a los dos lados. Cuesta una consulta al suelo
cada 0,25 s en marcha (cada segundo parado) y, en un camino angosto, unas 20 cada vez (mide los dos bordes y la dirección del camino).

Con [tocar superficies](#tocar-superficies) activado, una baranda o una pared junto al camino se tocan como en
cualquier otro sitio: la mano se apoya en ella (y se desliza) y, como ya se sostiene, el otro brazo baja casi a
su pose normal y deja de corregir (`narrowTouchRelax`); los pies siguen en línea.

Una ruta de `moveTo` va por un camino angosto solo si el destino está en él o no puede rodearlo (un tablón hasta un
pedestal, el único muro entre dos plataformas): cuesta mucho más que el suelo abierto. Uno bajo que se cruza en el
camino (una viga a la que puede subir) lo pasa por encima. Si el destino está en uno bajo, sube a él ahí mismo por
su costado (se acerca de frente y sube de un paso) y, ya arriba, se gira en el sitio hasta quedar a lo largo de él,
en el punto exacto del destino; o por su extremo, si por ahí es más corto. A uno más alto (lo alto de un muro) sube
solo por su extremo, en línea con él: si llega en ángulo, la ruta pasa antes por un punto delante del extremo. De
camino frena hasta `narrowMaxSpeed`, apunta a
un punto más cercano de la ruta y se corrige de lado hacia su línea, así que entra recto y por el medio aunque
acabe de dar la vuelta.

### Cornisas

Una cornisa en un acantilado, el saliente de un edificio: con una pared a un lado y al otro una caída que no puede
bajar (más honda que `maxStepDown`), más estrecha que `ledgeWidth` (45 cm por defecto), el personaje la recorre de
lado con la espalda pegada a la pared, como una persona. También se detecta en la geometría, con una sonda como la de
los caminos angostos: la pared es suelo al menos 1,1 m (escalado con el tamaño) más alto que la cornisa; una más baja
(un pretil) no cuenta. `ledge` (0–1) dice cuánto lo está haciendo, y cambia en `1 / ledgeRate` s.

- En cuanto ve la cornisa por delante frena hasta `ledgeMaxSpeed` y, ya despacio, se pone de espaldas a la pared sin
  cambiar su dirección de avance (si aún llega deprisa, da antes unos pasos de frente: girando a velocidad de caminar,
  los pies se cruzaban). Mira siempre hacia el mismo lado a lo largo de ella (solo gira con la cornisa si esta tuerce
  más de 20°). Cuando la cornisa se ensancha o se acaba, vuelve a girarse hacia donde va y sigue caminando: dos pasos
  más a `ledgeMaxSpeed` y luego acelera suave, a un tercio de `acceleration` (de golpe, el pie aún apoyado con los
  pasos lentos de la cornisa se quedaba atrás y el paso siguiente era muy largo).
- Va de lado: abre el pie del lado hacia el que va, pasa el peso a él y acerca el otro, sin cruzarlos
  (`ledgeStepWidth` entre los tobillos con los pies juntos; se separan más o menos lo que avanza en un paso), con
  pasos cortos y rápidos que apenas despegan del suelo, un doble apoyo largo y las rodillas algo dobladas
  (`ledgeKneeBend`). Despacio: `ledgeMaxSpeed` (0,35 m/s).
- La espalda sigue en la pared, también si es irregular: mide a qué distancia está la pared a la altura de la cadera y
  de los omóplatos, a lo ancho de la espalda, y mantiene el cuerpo donde la espalda toca lo que más sobresale; si la
  pared sobresale más a una altura que a la otra, el tronco se inclina hacia atrás (o la cadera va hacia atrás) hasta
  10° para tocarla en las dos. Lo que sobresale la espalda detrás de la cadera se mide en la malla del modelo (sin
  malla, las proporciones habituales).
- Las palmas se apoyan en la pared a cada lado de la cadera, algo más abajo, con los dedos hacia abajo y un poco hacia
  fuera; se deslizan por ella con el cuerpo y siguen sus irregularidades. Donde no hay pared detrás de una mano (pasado
  su final), ese brazo cuelga al costado, algo abierto y hacia atrás (`ledgeArmAbduction`, `ledgeArmForward`,
  `ledgeElbowBend`). La cabeza mira un poco hacia abajo y hacia donde va (`ledgeGaze`). Mientras, no toca otras
  superficies con las manos (`locomotion.touch.brace` es lo que mantiene una mano apoyada en una superficie que sigues).

Se controla como siempre: el sentido de `targetHeading` (o de `moveTo`) a lo largo de la cornisa dice hacia dónde
va. Si se le pide ir hacia el otro lado, se para y vuelve sin darse la vuelta; hacia la pared o hacia el vacío (a más
de 70° de la cornisa), se queda quieto, salvo que hacia allí haya suelo a su altura (al final de la cornisa, la
plataforma de al lado): entonces sale de la cornisa y camina hasta allí. En ella, `heading` y `velocity` son hacia donde va, y el cuerpo mira
`locomotion.body.state.facingOffset` rad (±90°) desde ahí. Una ruta de `moveTo` puede ir por una cornisa, cerca de la
pared: cada metro cuenta como dos de suelo abierto (va más despacio), así que la toma salvo que rodearla mida menos
del doble. Entra desde un punto antes de ella, en su línea y algo separado de la pared, para llegar yendo a lo largo de
la pared y no en diagonal.

Con `ledgeWidth: 0` no lo hace nunca. Cuesta una consulta al suelo cada 0,25 s en marcha (cada segundo parado), como
los caminos angostos, unas 20 al encontrar una cornisa, y 5–9 por frame en ella (la pared detrás de la espalda).

## Frames irregulares

`update(dt)` divide los frames largos en pasos de como mucho `maxTimeStep` y nunca simula más de
`maxFrameTime` por llamada: el movimiento no depende de los fps y un parón (cambiar de pestaña) no provoca un
salto. Pasa el `dt` real, en segundos: el tiempo desde el frame anterior, por ejemplo a partir del `time` que
`renderer.setAnimationLoop` pasa a cada frame. `dt ≤ 0` no hace nada.

## Caminar en el sitio y origen flotante

`human.shiftOrigin(offset)` desplaza al personaje sin cambiar su movimiento: sigue caminando, corriendo o en el
aire exactamente igual, con los pies, las trayectorias y el destino de `moveTo` desplazados con él (a
diferencia de moverlo y llamar a `reset()`, que lo detiene).

```ts
// En el sitio (cinta de correr): cada frame, lo que avanzó en horizontal, de vuelta.
human.update(dt);
const p = human.position;
human.shiftOrigin(new Vector3(anchor.x - p.x, 0, anchor.z - p.z));

// Origen flotante (mundos grandes): desplazar a la vez el suelo y el personaje.
world.position.add(offset);
human.shiftOrigin(offset);
```

El suelo no se mueve con él: en el sitio nuevo tiene que ser el mismo (llano para caminar en el sitio, o el
mismo suelo desplazado). Con `StaticGroundDetector`, si mueves el suelo, llama a `rebuild()`.

## Teletransportar, pausar, eliminar

- **Dónde empieza**: coloca el modelo (`gltf.scene.position`, o su padre) antes de `createProceduralHuman`: empieza
  de pie ahí, con los pies sobre el suelo que haya debajo (el constructor llama a `reset()`).
- **Teletransportar**: mueve `gltf.scene` (o su padre) y llama a `human.reset()`: lo deja quieto, con los pies
  apoyados en el suelo que haya debajo (hasta 50 m) y cancela `moveTo`.
- **Dejar de controlarlo** (p. ej. para otra animación): `human.restPose()` devuelve el esqueleto a su pose de
  reposo; `reset()` vuelve a tomar el control.
- **Eliminar**: `human.dispose()` (pose de reposo y sin suscripciones). El modelo sigue siendo tuyo.
- Mientras esté activo, no muevas ni gires el modelo ni sus huesos de piernas, caderas, torso o brazos.

## Varios personajes

Cada `createProceduralHuman` es independiente (configuración, estado y eventos propios). Se pueden mezclar
tamaños, estilos y rigs en la misma escena; cada uno necesita su propio modelo (`SkeletonUtils.clone` para
copiar uno cargado). El detector de suelo sí se comparte: un mismo `StaticGroundDetector` (o `GroundDetector`)
para todos. Coste orientativo de `update` por personaje: ~0,1–0,2 ms (con `StaticGroundDetector`, también sobre
mallas grandes); `npm run bench` lo mide en tu máquina.

## Avanzado

- `human.locomotion` y `human.navigation`: controladores internos (gait, pies, pelvis, cuerpo, point and
  click). Útiles para depurar; su forma puede cambiar entre versiones.
- Se exportan también los bloques (`TwoBoneIK`, `LegIK`, `FootPlacement`, `mapHumanRig`, `inspectSkeleton`…).
- `three-procedural-locomotion/debug`: ayudas visuales. Cada una tiene un `group` (o, `GaitDiagram`, un `element`
  HTML) que añadir, y un `update()` que llamar después de `human.update(dt)`:

  ```ts
  import { FootDebug, GaitDiagram, LocomotionDebug, NavigationDebug, RigDebug } from 'three-procedural-locomotion/debug';

  const debug = new LocomotionDebug(human.locomotion); // posiciones neutras, aterrizajes, trayectorias, centro de masa
  const feet = (['left', 'right'] as const).map((side) => new FootDebug(human.footGround(side))); // rayos de los pies
  const bones = new RigDebug(human.rig); // los huesos mapeados
  const route = new NavigationDebug(human); // moveTo / followPath: el destino y lo que queda de la ruta
  const gait = new GaitDiagram(human.locomotion.gait, { language: 'es' }); // fases de la marcha
  scene.add(debug.group, bones.group, route.group, ...feet.map((f) => f.group));
  document.body.append(gait.element);

  // cada frame, después de human.update(dt)
  debug.update(); bones.update(); route.update(); gait.update();
  for (const f of feet) f.update();
  ```

  `NavigationDebug` dibuja el destino de `moveTo` / `followPath` (`moveTarget`) como un aro plano en el suelo,
  mientras lo hay, y una línea desde los pies por lo que queda de la ruta planificada (`movePath`), por encima de
  todo. Opciones: `color` (`0x66ff99` por defecto), `straightLine: true` (la línea también cuando va en línea
  recta, de los pies al destino: por defecto, solo con una ruta planificada) y `maxPoints` (256). `dispose()`
  libera sus geometrías y materiales. `IKDebug` muestra el IK de una pierna con un objetivo puesto a mano
  (`new IKDebug(human.rig.left, objetivo, pole, color)`). `LocomotionDebug`, `RigDebug`, `IKDebug` y
  `NavigationDebug` se ocultan con `visible = false`.

## Limitaciones actuales

- Sin física: el cuerpo es cinemático. Solo evita lo que no puede pisar en el suelo y los `colliders` que le das
  (vistos desde arriba, entre su escalón y su altura). Planear una ruta cuesta unos miles de consultas al suelo
  una vez, al recibir el destino (unas 1.500–10.000; hasta ~18.000 si no se puede llegar), solo si la línea recta
  no está libre: con `StaticGroundDetector`, unos milisegundos.
- Escaleras: solo caminando (todavía no corriendo). Al bajar, la pierna de delante apoya casi estirada
  (una persona apoya con la rodilla doblada; ver [naturalidad](naturalness.md#escaleras)). Tampoco saltos
  planificados a otra altura.
- Rigs probados: Mixamo y el metarig de Rigify. Otros rigs deben funcionar con su mapping, pero no están
  verificados (ver [esqueletos](skeletons.md)).
