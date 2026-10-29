# three-procedural-locomotion

[![CI](https://github.com/PabloMesquida/three-procedural-locomotion/actions/workflows/ci.yml/badge.svg)](https://github.com/PabloMesquida/three-procedural-locomotion/actions/workflows/ci.yml)

[English](README.md)

Locomoción humana procedural para Three.js: camina, corre, gira, se agacha, salta y va hasta un punto sobre
cualquier suelo, **sin animaciones bakeadas**. Todo se calcula cada frame a partir de una velocidad y un rumbo:
ritmo de los pasos (gait), dónde apoyar cada pie (footstep planning), piernas con Two-Bone IK, foot placement
sobre el terreno y postura del cuerpo (pelvis, torso, cabeza, brazos, manos).

<!-- Añadir aquí un GIF o una captura, y el enlace a la demo en vivo cuando la web esté publicada. -->

## Qué hace

- **Marcha medida contra personas reales**: cadencia, zancada, rodado del pie (talón → punta), trayectoria del
  pie en el aire, rodillas y brazos ajustados con capturas de movimiento de CMU
  ([naturalidad](docs/es/naturalness.md)); un test lo comprueba.
- **Caminar y correr sin modos aparte**: camina hasta ~1,7 m/s y por encima (`runStartSpeed`) pasa gradualmente
  a carrera, como una persona hacia los 2 m/s, con fase de vuelo, rebote de caderas e inclinación del torso.
- **Giros creíbles**: frena según el giro pendiente, cierra la curva, la cabeza y el pecho anticipan el nuevo
  rumbo y los pies aterrizan ya orientados (o pivotan sobre la punta).
- **Pies sobre el terreno**: talón → planta → punta, inclinación sobre baches y pendientes, escalones bajos,
  margen de la punta durante el swing.
- **Agacharse, saltar y aterrizar** con preparación, impulso, recogida de pies y amortiguación.
- **Torsión gradual** de brazos y piernas si el rig tiene huesos `twist` (opcionales): la muñeca y el tobillo
  no se retuercen de golpe ([esqueletos](docs/es/skeletons.md#huesos-de-torsión)).
- **Point and click**: `moveTo(punto, { run })` llega al destino (±5–10 cm); si queda detrás, frena y gira
  hacia él en 2–3 pasos, como una persona, y sale en línea recta.
- **Tocar al pasar**: con `touchables` (columnas, paredes, la baranda de un puente) acerca la mano y la apoya
  con la palma al pasar a su lado, sin dejar de caminar; por una pared o una baranda la va deslizando mientras
  siga al lado; o a mano con `touch(punto)` ([guía](docs/es/guide.md#tocar-superficies)).
- **Cuerpo vivo**: contrarrotación de pelvis y hombros, reparto del peso, brazos y dedos como péndulos
  amortiguados, variación natural determinista por semilla (dos personajes nunca se mueven igual).
- **Estilos y ajustes en dos niveles**: estilos `tired`, `sneaky`, `athletic`, `heavy`; once controles básicos (ritmo, zancada, braceo, intensidad…) que mueven varios parámetros a la vez; y los 116 parámetros uno a uno, ajustables en ejecución y validados.
- **Caminar en el sitio**: `shiftOrigin` desplaza al personaje sin cambiar su movimiento (cinta de correr para ajustar viendo el efecto, u origen flotante en mundos grandes).
- **Cualquier tamaño y proporción**: las longitudes se escalan con el largo de pierna del modelo (de un niño a un gigante) y también las velocidades y el ritmo de los pasos, como en una persona de ese tamaño. Probado con esqueletos de proporciones distintas (piernas, torso, caderas, brazos, pies).
- **Rigs**: Mixamo y metarig de Rigify incluidos; cualquier otro con un mapping de huesos.
- **Rápido**: ~0,1–0,2 ms por personaje y frame en CPU; `StaticGroundDetector` consulta terrenos de cientos de
  miles de triángulos en microsegundos.
- **Renderer**: `WebGPURenderer` (`three/webgpu`) o `WebGLRenderer`: la librería solo mueve huesos.

## Ejemplo

```ts
import { createProceduralHuman, mixamoMapping } from 'three-procedural-locomotion';

const human = createProceduralHuman({
  model: gltf.scene,      // modelo humanoide con esqueleto
  mapping: mixamoMapping, // qué bone es cada parte del cuerpo (o rigifyMapping, o uno propio)
  ground: [floorMesh],    // suelo (o new StaticGroundDetector([...]) para terrenos grandes estáticos)
  preset: 'athletic',     // opcional: estilo de marcha
});

human.moveTo(point, { run: true });                 // ir a un punto…
human.targetSpeed = 1.2; human.targetHeading = 0.5; // …o control continuo (m/s, rad)
human.targetCrouch = 1;                             // agacharse (0–1)
human.jump();
human.on('footstep', ({ side, position }) => playStep(side, position));

// cada frame
human.update(dt);
```

Requisitos de la escena: metros (1 unidad = 1 m) y eje Y hacia arriba. El modelo, en T-pose o A-pose con el
origen a la altura de las plantas ([detalles](docs/es/skeletons.md#requisitos-del-modelo)).

## Documentación

- **[Guía de uso](docs/es/guide.md)**: crear el personaje, control, estado, eventos, configuración, estilos,
  tamaño, suelo propio, fps, teletransporte, varios personajes, limitaciones.
- **[Referencia de parámetros](docs/es/parameters.md)**: todos los parámetros con unidad, valor por defecto y estilos
  (generada desde el código).
- **[Usar otro esqueleto](docs/es/skeletons.md)**: escribir un rig mapping y requisitos del modelo.
- **[Naturalidad](docs/es/naturalness.md)**: cómo se compara la marcha con capturas de movimiento reales (CMU) y resultados.
- **[Inventario de huesos](docs/es/bone-inventory.md)**: qué huesos mueve la marcha, quién y cuánto, frente a una persona; qué falta.
- **[Desarrollo](docs/es/development.md)**: scripts, arquitectura, estructura, tests, rendimiento (`npm run bench`).
- **[Auditoría de rendimiento](docs/es/performance-audit.md)**: dónde se va el tiempo, qué se optimizó y qué queda.
- **[Ejemplo completo](examples/basic.ts)**: escena, clic para moverse, WASD respecto a la cámara, saltar, agacharse.

## Instalar en otro proyecto

`three` es una *peer dependency*: la pone tu proyecto (probada de la r150 a la r186).

**Versión fija (recomendada):**

```bash
# en esta carpeta
npm pack                      # compila y genera three-procedural-locomotion-0.1.0.tgz

# en tu proyecto
npm install three
npm install ../ruta/a/three-procedural-locomotion/three-procedural-locomotion-0.1.0.tgz
```

Para actualizarla: sube `version` en `package.json`, `npm pack` y vuelve a instalar el `.tgz`.

**Enlazada (para desarrollar la librería y probarla a la vez):** en tu proyecto
`npm install ../ruta/a/three-procedural-locomotion`, y aquí `npm run build:watch`. Para que Vite no cargue dos copias de
three, en el `vite.config.ts` de tu proyecto: `resolve: { dedupe: ['three'] }`.

Entradas públicas: `three-procedural-locomotion` y `three-procedural-locomotion/debug` (ayudas visuales). Las rutas internas están
bloqueadas a propósito.

## Desarrollo

```bash
npm install
npm test           # tests automáticos
npm run typecheck  # tipos de la librería y de los ejemplos
npm run build      # librería → dist/
npm run bench      # benchmark de rendimiento
```

Requiere Node 20.19+ o 22.12+. Los tests usan `modelos/human_mix_propio.glb` (esqueleto con los nombres de
Mixamo, por defecto) o `modelos/human.glb` (metarig de Rigify). Más en [Desarrollo](docs/es/development.md).

Las mallas de los dos modelos son de [Human Base Meshes](https://www.blender.org/download/demo-files/#assets)
(Blender Studio, CC0). El esqueleto con nombres de Mixamo es propio (no está hecho con Mixamo): lo genera
`scripts/blender/rig-mixamo-names.py` a partir del de Rigify.

## Limitaciones

- Cuerpo cinemático: sin colisiones ni física; `moveTo` va en línea recta, sin pathfinding.
- Sin escaleras ni saltos a otra altura planificados (solo baches y escalones bajos).
- Rigs verificados: Mixamo y metarig de Rigify. Otros deberían funcionar con su mapping, sin verificar.

## Cómo citar

Si esta librería forma parte de algo que publiques, por favor cítala. Ver [CITATION.cff](CITATION.cff), o:

Mesquida, Pablo. (2026). three-procedural-locomotion: procedural human locomotion for Three.js.
https://github.com/PabloMesquida/three-procedural-locomotion

## Licencia

Este proyecto está licenciado bajo la licencia MIT. Ver [LICENSE](LICENSE).
