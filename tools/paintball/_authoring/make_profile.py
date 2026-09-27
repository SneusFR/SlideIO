"""Write WeaponProfile_PaintballRifle.json (same schema family as WeaponProfile_HexSniper / PopcornShotgun)."""
import json, pickle
import numpy as np
from rig import trs
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


upper_mask = sorted(set(b for b, _ in tp["TP_Hold_PaintballRifle"]["channels"]))
meta = tp["_meta"]
reload_events = {"hopperRelease": RL["press"], "hopperDrop": RL["release"], "hopperIn": RL["pick"], "hopperSeat": RL["seat"],
                 "slap": RL["slap"], "chargeBack": RL["ch1"], "chargeRelease": RL["ch2"], "readyToFire": round(RL["ch2"] + 0.07, 2)}

profile = {
    "schemaVersion": 1,
    "id": "PaintballRifle",
    "compatibleRig": "Potato_Master_Clean_v1",
    "units": "meter",
    "assets": {"fpRig": "Potato_FP_CommonArms.glb", "fpPoses": "PaintballRifle_FP_Poses.glb",
               "tpRig": "Potato_TP_Character.glb", "tpPoses": "PaintballRifle_TP_Poses.glb",
               "weapon": "PaintballRifle_Weapon.glb"},
    "camera": hexprof["camera"],
    "mounts": {
        "fp": mount_block(M_FP, "camera", fp, {
            "authoring": {"method": "IK per frame with soft joint limits: weapon placed in camera space, right arm solved on Weapon_R, "
                                    "left arm on the live OffhandSocket (foregrip fist fitted on the real hand mesh) / hopper / charging-handle frames",
                          "holdGripCameraSpace": [float(x) for x in A.HOLD["grip"]], "holdYawPitchRollDeg": [A.HOLD["yaw"], A.HOLD["pitch"], A.HOLD["roll"]],
                          "sameChannelSetAsHexSniper": True}}),
        "tp": mount_block(M_TP, "character", tp, {
            "animatedWeaponSocketCorrection": "Weapon_R translation is keyed at its rest value in every TP clip (resets the HexSniper offset).",
            "stance": {"alwaysAiming": True, "gunDirection": "straight ahead (character +Z), level, no roll, in hold / aim / run / fire",
                       "spineYawLeanDeg": [round(float(v), 2) for v in meta["spine"]],
                       "leftHandSocket": "OffhandSocketTP (the foregrip fist turned %.0f deg toward the back: the TP arms are short)" % meta["grip"]["yaw"],
                       "characterSkinRequired": "Potato_TP_Character.glb v5 (flank / armpit weights repaired — the file shipped with the Popcorn Shotgun)"}}),
    },
    "fpClips": {"hold": "FP_PaintballRifle_Hold", "run": "FP_PaintballRifle_Run", "aim": "FP_Aim_PaintballRifle",
                "raise": "FP_Raise_PaintballRifle", "lower": "FP_Lower_PaintballRifle", "inspect": "FP_Inspect_PaintballRifle",
                "equip": "FP_Equip_PaintballRifle", "unequip": "FP_Unequip_PaintballRifle"},
    "fpActions": {"fire": {"clip": "FP_Fire_PaintballRifle", "loop": True},
                  "fireEnd": {"clip": "FP_FireEnd_PaintballRifle", "loop": False},
                  "reload": {"clip": "FP_Reload_PaintballRifle", "loop": False}},
    "tpClips": {"hold": "TP_Hold_PaintballRifle", "run": "TP_Run_PaintballRifle", "aim": "TP_Aim_PaintballRifle",
                "raise": "TP_Raise_PaintballRifle", "lower": "TP_Lower_PaintballRifle",
                "actions": {"fire": {"clip": "TP_Fire_PaintballRifle", "loop": True},
                            "fireEnd": {"clip": "TP_FireEnd_PaintballRifle", "loop": False},
                            "reload": {"clip": "TP_Reload_PaintballRifle", "loop": False}}},
    "upperBodyMask": upper_mask,
    "weaponClips": {"idle": "Idle", "fire": "Fire", "fireEnd": "Fire_End", "reload": "Reload", "reloadTP": "Reload_TP",
                    "inspect": "Inspect", "equip": "Equip"},
    "actions": {
        "fire": {"fpClip": "FP_Fire_PaintballRifle", "tpClip": "TP_Fire_PaintballRifle", "weaponClip": "Fire", "loop": True,
                 "interval": A.FIRE_PERIOD, "roundsPerMinute": round(60 / A.FIRE_PERIOD), "endDuration": 0.30,
                 "endClips": {"fp": "FP_FireEnd_PaintballRifle", "tp": "TP_FireEnd_PaintballRifle", "weapon": "Fire_End"},
                 "recommendedFadeIn": 0.03,
                 "note": "Automatic: the 0.1 s loop (one kick per cycle) runs while shots keep coming; fireEnd settles when they stop."},
        "reload": {"fpClip": "FP_Reload_PaintballRifle", "tpClip": "TP_Reload_PaintballRifle", "weaponClip": "Reload",
                   "weaponClipTP": "Reload_TP", "duration": RL["end"], "recommendedFadeIn": 0.08, "events": reload_events,
                   "leftHand": {"leaveForegrip": RL["off0"], "onHopper": [RL["reach"], RL["seat"]], "slap": [RL["slap0"], RL["slap1"]],
                                "chargingHandle": [RL["ch0"], RL["ch2"]], "backOnForegrip": RL["ret"]},
                   "note": "Hopper swap: release button, the empty hopper is pulled off and dropped (cosmetic falling copy), "
                           "a full one comes from off screen (FP) / the belt (TP), clicks in, slap, charging handle racked."},
        "inspect": {"fpClip": "FP_Inspect_PaintballRifle", "weaponClip": "Inspect", "duration": 3.6},
    },
    "inspection": {"armsClip": "FP_Inspect_PaintballRifle", "weaponClip": "Inspect", "duration": 3.6, "loop": False,
                   "rightHandIsSoleSupport": True, "leftHandReleaseStarts": 0.12, "leftHandOffGun": [0.42, 3.02],
                   "leftRegripComplete": 3.38, "showcase": {"leftSide": [0.95, 1.6], "topAndHopper": [2.3, 2.75]},
                   "gameplayEvents": []},
    "paintball": {
        "hopperNode": "Hopper", "dataIn": "Hopper node extras (GLTFLoader -> userData)",
        "capacity": 32, "perShot": 1, "colors": "3 paint colours (red / yellow / teal) mixed in the hopper, each ball keeps its colour",
        "physics": {"firstPersonOnly": True, "fixedStepHz": 60, "maxSubsteps": 3, "iterations": 8, "drawCalls": 1,
                    "shape": "horizontal cylinder + V floor toward the feed", "sleep": "positional drift < 0.002 units over 12 steps",
                    "inertiaScale": 0.5, "maxInertiaG": 2.5},
        "remote": "No physics: 33 baked layouts (one per ball count) + feed suction animation."},
    "assetLoading": dict(hexprof["assetLoading"]),
    "render": dict(hexprof["render"], **{"glassRenderOrder": 2, "runtimeDrawCalls": "5 meshes + 1 InstancedMesh (balls)"}),
    "presentationRules": {
        "straightPose": "Aim",
        "straightWhile": ["ADS"],
        "inspectionOnlyWhen": "Idle, not firing / reloading, no ADS, stationary",
        "useAuthoredRaiseLowerTransitionsForADS": True,
        "neverDelayGameplayToFinishVisualTransition": True,
        "aimNote": "Hip-level 'tight' aim (like the Popcorn Shotgun): the hopper would hide the crosshair in a true ADS.",
    },
    "sharedCharacterLocomotion": hexprof["sharedCharacterLocomotion"],
}
profile["assetLoading"]["preserveWeaponRootScale"] = wd.ROOT_SCALE
json.dump(profile, open("WeaponProfile_PaintballRifle.json", "w"), indent=2)
print("ok; tp mask", upper_mask)
print("fp additionalScale", profile["mounts"]["fp"]["additionalScale"], "tp", profile["mounts"]["tp"]["additionalScale"])
