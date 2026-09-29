"""Frisbee Launcher — build the model in a BACKGROUND Blender (the file open in the Blender window is never touched):
    blender -b --factory-startup --python fl_build.py
Builds the 'Model' scene (fl_model.build), renders check views (EEVEE) into shots/m_*.png, dumps fl_dump.json and
saves FrisbeeLauncher.blend next to this script."""
import bpy, sys, os, math, time, traceback
from mathutils import Vector

D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, D)
os.makedirs(os.path.join(D, "shots"), exist_ok=True)
LOG = open(os.path.join(D, "shots", "build_log.txt"), "w")


def log(*a):
    LOG.write(" ".join(str(x) for x in a) + "\n"); LOG.flush()


def g2b(p):
    return Vector((p[0], -p[2], p[1]))


try:
    t0 = time.time()
    import importlib, fl_model as M
    importlib.reload(M)
    # clean factory scene
    for ob in list(bpy.data.objects): bpy.data.objects.remove(ob, do_unlink=True)
    sc = bpy.context.scene
    sc.name = "Model"
    root, objs = M.build()
    log("built in %.1fs" % (time.time() - t0), len(objs))
    M.dump(os.path.join(D, "fl_dump.json"))
    # --- render setup
    r = sc.render
    r.engine = "BLENDER_EEVEE_NEXT"
    r.resolution_x, r.resolution_y, r.resolution_percentage = 900, 600, 100
    sc.eevee.taa_render_samples = 24
    sc.view_settings.view_transform = "Standard"
    w = bpy.data.worlds.new("FL_World"); w.use_nodes = True
    bg = w.node_tree.nodes["Background"]; bg.inputs[0].default_value = (0.62, 0.62, 0.64, 1); bg.inputs[1].default_value = 0.9
    sc.world = w
    ld = bpy.data.lights.new("FL_Key", "SUN"); ld.energy = 3.2; ld.angle = math.radians(8)
    lo = bpy.data.objects.new("FL_Key", ld); sc.collection.objects.link(lo)
    lo.rotation_euler = (math.radians(40), math.radians(-12), math.radians(-35))
    cd = bpy.data.cameras.new("FL_Cam"); cam = bpy.data.objects.new("FL_Cam", cd); sc.collection.objects.link(cam)
    sc.camera = cam
    cd.lens = 50

    def shoot(name, eye_g, tgt_g, lens=50):
        eye, tgt = g2b(eye_g), g2b(tgt_g)
        cam.location = eye
        cam.rotation_mode = "QUATERNION"; cam.rotation_quaternion = (tgt - eye).to_track_quat("-Z", "Y")
        cd.lens = lens
        r.filepath = os.path.join(D, "shots", "m_" + name + ".png")
        bpy.ops.render.render(write_still=True)
        log("render", name)

    C = (-0.5, -0.35, 0.0)
    shoot("34", (-10.5, 7.0, 10.5), C, 60)
    shoot("side", (-0.5, -0.1, 17.0), C, 55)
    shoot("top", (-0.5, 17.0, 0.4), C, 55)
    shoot("back34", (9.5, 6.0, -9.0), C, 60)
    shoot("front", (-17.0, 2.0, 0.0), C, 55)
    shoot("under", (-3.0, -12.0, 8.0), (-1.5, -0.8, 0.0), 60)
    # fired state: sled at the front stop, limbs relaxed, deck empty, top cage disc in the hand
    M.set_state(objs, M.SLED_FRONT_X, 0.0)
    objs["DiscDeck"].scale = (0, 0, 0)
    shoot("fired34", (-10.5, 7.0, 10.5), C, 60)
    shoot("firedtop", (-0.5, 17.0, 0.4), C, 55)
    M.set_state(objs)
    objs["DiscDeck"].scale = (1, 1, 1)
    # keep only the model in the saved file (no check camera / light)
    for ob in (cam, lo): bpy.data.objects.remove(ob, do_unlink=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(D, "FrisbeeLauncher.blend"))
    log("saved", bpy.data.filepath, "%.1fs" % (time.time() - t0))
    log("DONE")
except Exception:
    log("ERROR"); log(traceback.format_exc())
LOG.close()
