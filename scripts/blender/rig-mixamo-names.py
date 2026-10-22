"""
Genera el modelo de pruebas con nombres de Mixamo (modelos/human_mix_propio.glb) sin usar Mixamo.

Parte de recursos/human.blend: la malla femenina realista de Human Base Meshes (Blender Studio, CC0) con
su metarig de Rigify, que ya la deforma (un grupo de vértices por hueso). Crea un esqueleto nuevo con la
jerarquía y los nombres de un rig de Mixamo (mixamorig:Hips, …:LeftArm, cinco dedos con su punta "4",
HeadTop_End, Toe_End), con cada hueso sobre su equivalente del metarig, y le pasa los pesos: cada grupo
del metarig va al hueso de Mixamo equivalente o, si no tiene (cara, palmas, pelvis, pecho, talón), al de
su antepasado más cercano que lo tenga. Como en un modelo de Mixamo importado en Blender, el esqueleto
queda girado 90° en X y a escala 0,01 (centímetros): así los tests siguen cubriendo raíces con rotación y
escala.

Uso (no modifica human.blend; escribe el .glb y, al lado de la fuente, una copia .blend del resultado):

    blender -b recursos/human.blend --python scripts/blender/rig-mixamo-names.py -- modelos/human_mix_propio.glb
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

SOURCE_RIG = 'metarig'
PREFIX = 'mixamorig:'

# Metarig → Mixamo (sin prefijo). Los huesos del metarig que no están aquí ceden sus pesos al antepasado
# más cercano que sí esté.
MAP = {
    'spine': 'Hips',
    'spine.001': 'Spine',
    'spine.002': 'Spine1',
    'spine.003': 'Spine2',
    'spine.004': 'Neck',
    'spine.005': 'Neck',  # el cuello de Mixamo es un solo hueso
    'spine.006': 'Head',
}
for s, side in (('L', 'Left'), ('R', 'Right')):
    MAP.update({
        f'shoulder.{s}': f'{side}Shoulder',
        f'upper_arm.{s}': f'{side}Arm',
        f'forearm.{s}': f'{side}ForeArm',
        f'hand.{s}': f'{side}Hand',
        f'thigh.{s}': f'{side}UpLeg',
        f'shin.{s}': f'{side}Leg',
        f'foot.{s}': f'{side}Foot',
        f'toe.{s}': f'{side}ToeBase',
    })
    for meta, mix in (('thumb', 'Thumb'), ('f_index', 'Index'), ('f_middle', 'Middle'), ('f_ring', 'Ring'), ('f_pinky', 'Pinky')):
        for i in (1, 2, 3):
            MAP[f'{meta}.0{i}.{s}'] = f'{side}Hand{mix}{i}'

# Jerarquía de Mixamo: hueso → padre.
PARENT = {'Spine': 'Hips', 'Spine1': 'Spine', 'Spine2': 'Spine1', 'Neck': 'Spine2', 'Head': 'Neck', 'HeadTop_End': 'Head'}
for side in ('Left', 'Right'):
    PARENT.update({
        f'{side}Shoulder': 'Spine2', f'{side}Arm': f'{side}Shoulder', f'{side}ForeArm': f'{side}Arm', f'{side}Hand': f'{side}ForeArm',
        f'{side}UpLeg': 'Hips', f'{side}Leg': f'{side}UpLeg', f'{side}Foot': f'{side}Leg', f'{side}ToeBase': f'{side}Foot',
        f'{side}Toe_End': f'{side}ToeBase',
    })
    for mix in ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky'):
        PARENT[f'{side}Hand{mix}1'] = f'{side}Hand'
        for i in (2, 3, 4):
            PARENT[f'{side}Hand{mix}{i}'] = f'{side}Hand{mix}{i - 1}'


def main():
    out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'human_mix_propio.glb'
    out = os.path.abspath(out)
    meta = bpy.data.objects[SOURCE_RIG]
    meshes = [ob for ob in bpy.data.objects if ob.type == 'MESH' and any(m.type == 'ARMATURE' and m.object == meta for m in ob.modifiers)]
    mw = meta.matrix_world
    bones = meta.data.bones

    def world(v):
        return mw @ v

    # Cabeza, cola y roll (world) de cada hueso de Mixamo, tomados del metarig.
    spec = {}
    for name, mix in MAP.items():
        b = bones[name]
        if mix == 'Neck' and name == 'spine.005':
            continue
        spec[mix] = [world(b.head_local), world(b.tail_local), name]
    spec['Neck'][1] = world(bones['spine.005'].tail_local)  # cuello: de spine.004 a spine.005
    # Puntas: un hueso más allá del último, en la misma dirección (sin pesos, como en Mixamo).
    spec['HeadTop_End'] = [spec['Head'][1], spec['Head'][1] + (spec['Head'][1] - spec['Head'][0]) * 0.3, 'spine.006']
    for side in ('Left', 'Right'):
        h, t, src = spec[f'{side}ToeBase']
        spec[f'{side}Toe_End'] = [t, t + (t - h), src]
        for mix in ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky'):
            h, t, src = spec[f'{side}Hand{mix}3']
            spec[f'{side}Hand{mix}4'] = [t, t + (t - h), src]

    # Esqueleto nuevo, en el sitio del metarig.
    for ob in bpy.context.view_layer.objects:
        ob.select_set(False)
    data = bpy.data.armatures.new('Armature')
    rig = bpy.data.objects.new('Armature', data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    meta_roll = {}
    # Roll del metarig: se lee de sus edit bones (en otra pasada no se puede editar dos armatures a la vez).
    for b in bones:
        # Eje Z local del hueso en reposo: lo que define su roll.
        meta_roll[b.name] = (mw.to_3x3() @ b.matrix_local.to_3x3()).col[2].normalized()
    edit = {}
    order = ['Hips'] + [n for n in PARENT]  # padres antes que hijos (PARENT está en orden)
    for name in order:
        head, tail, src = spec[name]
        eb = data.edit_bones.new(PREFIX + name)
        eb.head = head
        eb.tail = tail
        eb.align_roll(meta_roll[src])
        eb.use_connect = False
        eb.use_deform = not name.endswith(('_End', '4'))
        edit[name] = eb
    for name, parent in PARENT.items():
        edit[name].parent = edit[parent]
    bpy.ops.object.mode_set(mode='OBJECT')

    # Como un Mixamo importado: girado 90° en X y a escala 0,01, con los huesos donde estaban.
    m = Matrix.Rotation(math.radians(90), 4, 'X') @ Matrix.Diagonal((0.01, 0.01, 0.01, 1))
    data.transform(m.inverted())
    rig.matrix_world = m

    # Pesos: cada grupo del metarig al hueso de Mixamo equivalente o al de su antepasado más cercano.
    def target(bone_name):
        b = bones.get(bone_name)
        while b is not None and b.name not in MAP:
            b = b.parent
        return PREFIX + MAP[b.name] if b is not None else None

    for ob in meshes:
        old = {vg.index: vg.name for vg in ob.vertex_groups}
        sums = {}
        for v in ob.data.vertices:
            for g in v.groups:
                t = target(old.get(g.group, ''))
                if t is None or g.weight <= 0:
                    continue
                sums.setdefault(t, {}).setdefault(v.index, 0.0)
                sums[t][v.index] += g.weight
        for vg in list(ob.vertex_groups):
            ob.vertex_groups.remove(vg)
        for name, weights in sums.items():
            vg = ob.vertex_groups.new(name=name)
            for i, w in weights.items():
                vg.add([i], min(w, 1.0), 'REPLACE')
        for mod in ob.modifiers:
            if mod.type == 'ARMATURE':
                mod.object = rig
        world_matrix = ob.matrix_world.copy()
        ob.parent = rig
        ob.matrix_world = world_matrix

    # La malla base, como en modelos/human.glb (el Multires la exportaba subdividida: 42 340 vértices).
    # (Desactivarlo no bastaba: se quita de la copia; human.blend no se toca.) Y sombreado suave: con el
    # plano, cada cara lleva sus vértices y la malla salía con 42 340 en vez de 12 010.
    for ob in meshes:
        for mod in list(ob.modifiers):
            if mod.type == 'MULTIRES':
                ob.modifiers.remove(mod)
        ob.data.shade_smooth()

    # Material como el de modelos/human.glb (la malla de human.blend no tiene: sin él, three.js le pone uno
    # metálico que, sin luz de entorno, se ve negro).
    material = bpy.data.materials.new('Material.001')
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (0.8, 0.8, 0.8, 1.0)
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 0.7447
    material.use_backface_culling = False
    for ob in meshes:
        ob.data.materials.clear()
        ob.data.materials.append(material)

    # Fuera el metarig, el rig de Rigify y sus formas de control: solo queda lo que se exporta.
    keep = set(meshes) | {rig}
    for ob in list(bpy.data.objects):
        if ob not in keep:
            bpy.data.objects.remove(ob, do_unlink=True)

    bpy.ops.wm.save_as_mainfile(filepath=os.path.splitext(out)[0].replace(os.sep + 'modelos' + os.sep, os.sep + 'recursos' + os.sep) + '.blend', copy=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_skins=True, export_animations=False, use_selection=False)
    print(f'Escrito {out}: {len(PARENT) + 1} huesos, {len(meshes)} mallas')


main()
