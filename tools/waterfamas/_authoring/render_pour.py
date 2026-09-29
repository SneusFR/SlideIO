"""Write WeaponProfile_WaterFamas.json (same schema family as WeaponProfile_HexSniper / PaintballRifle)."""
import json, pickle
import numpy as np
import weapon_def as wd
import author_fp as A
import author_tp as T

fp = pickle.load(open("fp_clips.pkl", "rb"))
tp = pickle.load(open("tp_clips.pkl", "rb"))
hexprof = json.load(open("WeaponProfile_HexSniper.json"))
M_FP = fp["_meta"]["mount"]
M_TP = tp["_meta"]["mount"]
RL = A.RL


def mount_block(M, pose_space, clips, extra=None):
    b = {
        "poseSpace": pose_space,
        "bone": "Weapon_R",
        "matrixColumnMajor": [float(x) for x in M.T.reshape(-1)],
        "matrixRows": [[float(x) for x in row] for row in M],
        "weaponRootScalePreserved": wd.ROOT_SCALE,
        "additionalScale": float(np.linalg.norm(M[:3, 0])),
        "clips": [],
    }
    for name, c in clips.items():
        if name.startswith("_"): continue
        chans = c.get("channels", fp["_meta"]["channels"])
        b["clips"].append({"name": name, "frames": len(c["frames"]), "sampleFps": c["fps"], "duration": c["duration"],
                           "loop": c["loop"], "channels": len(chans),
                           "maxLeftHandContactErrorMm": round(float(c["errors"][:, 2].max() * 1000), 3)})
    if extra: b.update(extra)
    return b


upper_mask = sorted(set(b for b, _ in tp["TP_Hold_WaterFamas"]["channels"]))
reload_events = {"capGrab": RL["grab"], "capOff": RL["uns1"], "hingeOpen": RL["open0"], "bottleIn": RL["bottle_in"],
                 "pourStart": RL["pour0"], "pourEnd": RL["pour1"], "bottleOut": RL["bottle_out"], "hingeClose": RL["close1"],
                 "capScrewed": RL["screw1"], "readyToFire": 2.95}
jets = [float(x) for x in A.JET_TIMES]

profile = {
    "schemaVersion": 1,
    "id": "WaterFamas",
    "compatibleRig": "Potato_Master_Clean_v1",
    "units": "meter",
    "assets": {"fpRig": "Potato_FP_CommonArms.glb", "fpPoses": "WaterFamas_FP_Poses.glb",
               "tpRig": "Potato_TP_Character.glb", "tpPoses": "WaterFamas_TP_Poses.glb",
               "weapon": "WaterFamas_Weapon.glb"},
    "camera": hexprof["camera"],
    "mounts": {
        "fp": mount_block(M_FP, "camera", fp, {
            "authoring": {"method": "IK per frame with soft joint limits: weapon placed in camera space, right arm solved on Weapon_R "
                                    "(pistol grip, one-handed), left arm hanging off screen except in the reload (claw on the cap in "
                                    "2 wrist strokes with a re-grip, fist on the bottle)",
                          "holdGripCameraSpace": [float(x) for x in A.HOLD["grip"]], "holdYawPitchRollDeg": [A.HOLD["yaw"], A.HOLD["pitch"], A.HOLD["roll"]],
                          "sameChannelSetAsHexSniper": True}}),
        "tp": mount_block(M_TP, "character", tp, {
            "animatedWeaponSocketCorrection": "Weapon_R translation is keyed at its rest value in every TP clip (resets the HexSniper offset).",
            "stance": {"oneHanded": True, "gunDirection": "straight ahead (character +Z), level, in hold / aim / run / fire",
                       "gripCharacterSpace": [round(float(v), 4) for v in T.KEY["p"]],
                       "spineYawLeanDeg": [float(v) for v in T.KEY["spine"]],
                       "leftArm": "hangs relaxed against the belly (swings in the run); comes to the gun only in the reload",
                       "bottleScaleTP": round(float(T.BOTTLE_SCALE_TP), 4),
                       "characterSkinRequired": "Potato_TP_Character.glb v5 (flank / armpit weights repaired — the file shipped with the Popcorn Shotgun)"}}),
    },
    "fpClips": {"hold": "FP_WaterFamas_Hold", "run": "FP_WaterFamas_Run", "aim": "FP_Aim_WaterFamas",
                "raise": "FP_Raise_WaterFamas", "lower": "FP_Lower_WaterFamas", "inspect": "FP_Inspect_WaterFamas",
                "equip": "FP_Equip_WaterFamas", "unequip": "FP_Unequip_WaterFamas"},
    "fpActions": {"fire": {"clip": "FP_Fire_WaterFamas", "loop": False},
                  "fireAim": {"clip": "FP_FireAim_WaterFamas", "loop": False},
                  "reload": {"clip": "FP_Reload_WaterFamas", "loop": False}},
    "tpClips": {"hold": "TP_Hold_WaterFamas", "run": "TP_Run_WaterFamas", "aim": "TP_Aim_WaterFamas",
                "raise": "TP_Raise_WaterFamas", "lower": "TP_Lower_WaterFamas",
                "actions": {"fire": {"clip": "TP_Fire_WaterFamas", "loop": False},
                            "reload": {"clip": "TP_Reload_WaterFamas", "loop": False}}},
    "upperBodyMask": upper_mask,
    "weaponClips": {"idle": "Idle", "fire": "Fire", "reload": "Reload", "reloadTP": "Reload_TP", "inspect": "Inspect", "equip": "Equip"},
    "actions": {
        "fire": {"fpClip": "FP_Fire_WaterFamas", "fpClipAim": "FP_FireAim_WaterFamas", "tpClip": "TP_Fire_WaterFamas", "weaponClip": "Fire",
                 "loop": False, "mode": "burst", "jetsPerBurst": 3, "jets": jets, "burstDuration": A.BURST_DUR, "burstInterval": 0.45,
                 "recommendedFadeIn": 0.03,
                 "note": "One trigger pull = one FAMAS burst of 3 water jets (0 / 0.075 / 0.15 s). Each jet is a hitscan raycast done "
                         "when the controller emits it (onJet). Next burst allowed after burstInterval."},
        "reload": {"fpClip": "FP_Reload_WaterFamas", "tpClip": "TP_Reload_WaterFamas", "weaponClip": "Reload", "weaponClipTP": "Reload_TP",
                   "duration": RL["end"], "recommendedFadeIn": 0.08, "events": reload_events,
                   "leftHand": {"onCap": [RL["grab"], RL["open1"]], "unscrewStrokes": [[RL["grab"], 0.45], [0.52, RL["uns1"]]],
                                "bottle": [RL["bottle_in"], RL["bottle_out"]], "closeAndScrew": [RL["back"], RL["screw1"]],
                                "screwStrokes": [[RL["close1"], 2.72], [2.78, RL["screw1"]]], "backDown": RL["leave"] + 0.2},
                   "note": "Unscrew the rear cap (half a turn, 2 wrist strokes), swing it aside on its retainer, pour a water bottle "
                           "(off screen then in view in FP, from the belt in TP), close, screw back. Ammo is full at pourEnd."},
        "inspect": {"fpClip": "FP_Inspect_WaterFamas", "weaponClip": "Inspect", "duration": 3.6, "sloshKicks": [2.28, 2.42, 2.55]},
    },
    "inspection": {"armsClip": "FP_Inspect_WaterFamas", "weaponClip": "Inspect", "duration": 3.6, "loop": False,
                   "rightHandIsSoleSupport": True, "leftHandStaysDown": True,
                   "showcase": {"leftSide": [0.95, 1.55], "tankFromAbove": [2.2, 2.7], "sloshShakes": [2.25, 2.65]},
                   "gameplayEvents": []},
    "waterTank": {
        "node": "Tank", "dataIn": "Tank node extras (GLTFLoader -> userData)", "capacity": 9, "jetsPerShot": 3,
        "liquid": "Water mesh redrawn by WaterTank.ts: world-space free surface (always level), height solved from the fill, "
                  "slosh spring 1.6 Hz on the effective gravity, ripples; 2 draw calls + the glass",
        "level": "emptyLevel + (1 - emptyLevel) * ammo / 9 ; rises during the pour (pourStart -> pourEnd)",
        "pourStream": "BottleNozzle -> FillPoint during the pour"},
    "assetLoading": dict(hexprof["assetLoading"]),
    "render": dict(hexprof["render"], **{"glassRenderOrder": 3, "waterRenderOrder": [1, 2],
                                         "runtimeDrawCalls": "7 meshes + water surface + pour stream"}),
    "presentationRules": {
        "straightPose": "Aim",
        "straightWhile": ["ADS"],
        "inspectionOnlyWhen": "Idle, not firing / reloading, no ADS, stationary",
        "useAuthoredRaiseLowerTransitionsForADS": True,
        "neverDelayGameplayToFinishVisualTransition": True,
        "aimNote": "Raised hip aim (one-handed pistol-style): the nozzle comes near the crosshair, the tank stays visible.",
    },
    "sharedCharacterLocomotion": hexprof["sharedCharacterLocomotion"],
}
profile["assetLoading"]["preserveWeaponRootScale"] = wd.ROOT_SCALE
json.dump(profile, open("WeaponProfile_WaterFamas.json", "w"), indent=2)
print("ok; tp mask", upper_mask)
print("fp additionalScale", profile["mounts"]["fp"]["additionalScale"], "tp", profile["mounts"]["tp"]["additionalScale"])
for side in ("fp", "tp"):
    for c in profile["mounts"][side]["clips"]:
        print(side, c["name"], c["frames"], c["maxLeftHandContactErrorMm"])
