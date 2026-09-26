"""Write WeaponProfile_PopcornShotgun.json (same schema family as WeaponProfile_HexSniper.json)."""
import json, pickle
import numpy as np
from rig import Rig, trs
import weapon_def as wd
import author_fp as A

fp = pickle.load(open("fp_clips.pkl", "rb"))
tp = pickle.load(open("tp_clips.pkl", "rb"))
hexprof = json.load(open("WeaponProfile_HexSniper.json"))
M_FP = fp["_meta"]["mount"]
M_TP = tp["_meta"]["mount"]


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


# TP surface contacts (weapon-local, like the HexSniper's sourceSurfaceContactsByClip)
ch = Rig("Potato_TP_Character.glb")
S = trs(s=(wd.ROOT_SCALE,) * 3)


def contacts(clip, i=0):
    c = tp[clip]
    p = ch.rest_pose(); p.update(c["frames"][i])
    W = ch.world(p)
    G = W["Weapon_R"] @ M_TP @ S
    inv = np.linalg.inv(G)
    return {"R": [round(float(x), 5) for x in (inv @ W["Weapon_R"])[:3, 3]],
            "L": [round(float(x), 5) for x in (inv @ W["Weapon_L"])[:3, 3]]}


upper_mask = sorted(set(b for b, _ in tp["TP_Hold_PopcornShotgun"]["channels"]))
tank_x = json.load(open("popcorn_bake_ts.json"))

profile = {
    "schemaVersion": 1,
    "id": "PopcornShotgun",
    "compatibleRig": "Potato_Master_Clean_v1",
    "units": "meter",
    "assets": {"fpRig": "Potato_FP_CommonArms.glb", "fpPoses": "PopcornShotgun_FP_Poses.glb",
               "tpRig": "Potato_TP_Character.glb", "tpPoses": "PopcornShotgun_TP_Poses.glb",
               "weapon": "PopcornShotgun_Weapon.glb"},
    "camera": hexprof["camera"],
    "mounts": {
        "fp": mount_block(M_FP, "camera", fp, {
            "authoring": {"method": "IK per frame with soft joint limits (wrist swing<=72deg, twist<=32deg; forearm twist<=40deg): weapon placed in camera space, right arm solved on Weapon_R, left arm solved on the live OffhandSocket (pump grip fitted on the hand mesh) / button frames",
                          "holdGripCameraSpace": [float(x) for x in A.HOLD["grip"]], "holdYawPitchRollDeg": [A.HOLD["yaw"], A.HOLD["pitch"], A.HOLD["roll"]],
                          "sameChannelSetAsHexSniper": True}}),
        "tp": mount_block(M_TP, "character", tp, {
            "sourceSurfaceContactsByClip": {"Hold": contacts("TP_Hold_PopcornShotgun"), "Run": contacts("TP_Run_PopcornShotgun"),
                                            "Aim": contacts("TP_Aim_PopcornShotgun")},
            "animatedWeaponSocketCorrection": "Weapon_R translation is keyed at its rest value in every TP clip (resets the HexSniper offset).",
            "stance": {"alwaysAiming": True, "gunDirection": "straight ahead (character +Z), level, no roll, in hold / aim / run / fire",
                       "spineYawLeanDeg": json.load(open("tp_grip.json"))["spine_yaw_lean_deg"],
                       "leftHandSocket": "OffhandSocketTP (rear of the pump: the TP arms are short)",
                       "characterSkinRequired": "Potato_TP_Character.glb v5 (flank / armpit weights repaired, 506 vertices, no other change)"}}),
    },
    "fpClips": {"hold": "FP_PopcornShotgun_Hold", "run": "FP_PopcornShotgun_Run", "aim": "FP_Aim_PopcornShotgun",
                "raise": "FP_Raise_PopcornShotgun", "lower": "FP_Lower_PopcornShotgun", "inspect": "FP_Inspect_PopcornShotgun",
                "equip": "FP_Equip_PopcornShotgun", "unequip": "FP_Unequip_PopcornShotgun"},
    "fpActions": {"fire": {"clip": "FP_Fire_PopcornShotgun", "loop": False},
                  "fireLast": {"clip": "FP_FireLast_PopcornShotgun", "loop": False},
                  "reload": {"clip": "FP_Reload_PopcornShotgun", "loop": False}},
    "tpClips": {"hold": "TP_Hold_PopcornShotgun", "run": "TP_Run_PopcornShotgun", "aim": "TP_Aim_PopcornShotgun",
                "raise": "TP_Raise_PopcornShotgun", "lower": "TP_Lower_PopcornShotgun",
                "actions": {"fire": {"clip": "TP_Fire_PopcornShotgun", "loop": False},
                            "fireLast": {"clip": "TP_FireLast_PopcornShotgun", "loop": False},
                            "reload": {"clip": "TP_Reload_PopcornShotgun", "loop": False}}},
    "upperBodyMask": upper_mask,
    "weaponClips": {"idle": "Idle", "fire": "Fire", "fireLast": "Fire_Last", "reload": "Reload", "inspect": "Inspect", "equip": "Equip"},
    "actions": {
        "fire": {"fpClip": "FP_Fire_PopcornShotgun", "tpClip": "TP_Fire_PopcornShotgun", "weaponClip": "Fire", "duration": 0.9,
                 "recommendedFadeIn": 0.02,
                 "events": {"shot": 0.0, "pumpBack": 0.26, "pumpForward": 0.42, "readyToFire": 0.58}},
        "fireLast": {"fpClip": "FP_FireLast_PopcornShotgun", "tpClip": "TP_FireLast_PopcornShotgun", "weaponClip": "Fire_Last",
                     "duration": 0.55, "recommendedFadeIn": 0.02, "events": {"shot": 0.0, "readyToFire": 0.3},
                     "note": "Last popcorn load: no pump (nothing to chamber) - the rack happens at the end of the reload."},
        "reload": {"fpClip": "FP_Reload_PopcornShotgun", "tpClip": "TP_Reload_PopcornShotgun", "weaponClip": "Reload", "duration": A.RL["end"],
                   "recommendedFadeIn": 0.08,
                   "events": {"lidOpen": 0.28, "kernelsIn": [A.RL["spr0"], A.RL["spr1"]], "lidClose": A.RL["slam"],
                              "pops": [A.RL["pop0"], A.RL["pop1"]], "ammoRefilled": A.RL["pop1"], "pumpBack": A.RL["rack0"],
                              "pumpForward": A.RL["rack_h"], "readyToFire": round(A.RL["rack_f"] + 0.03, 2)},
                   "leftHand": {"releasePump": A.RL["lift0"], "flickLid": [A.RL["lift1"], A.RL["flick1"]], "sprinkle": [A.RL["spr0"], A.RL["spr1"]],
                                "pullLidShut": [A.RL["hook0"], A.RL["slam"]], "backOnPump": A.RL["ret1"]},
                   "note": "v4: the gun comes to the left hand; flick the lid open, sprinkle kernels, pull the lid shut, pops, rack."},
        "inspect": {"fpClip": "FP_Inspect_PopcornShotgun", "weaponClip": "Inspect", "duration": 3.6},
    },
    "inspection": {"armsClip": "FP_Inspect_PopcornShotgun", "weaponClip": "Inspect", "duration": 3.6, "loop": False,
                   "rightHandIsSoleSupport": True, "leftHandReleaseStarts": 0.12, "leftHandOffGun": [0.42, 3.02],
                   "leftRegripComplete": 3.38, "showcase": {"leftSide": [0.95, 1.6], "topAndRightTilt": [2.3, 2.75]},
                   "gameplayEvents": []},
    "popcorn": {
        "tankNode": "Tank", "dataIn": "Tank node extras (GLTFLoader -> userData)",
        "count": 72, "perShot": 36, "shots": 2, "fill": {"2": "full", "1": "half", "0": "empty"},
        "physics": {"firstPersonOnly": True, "fixedStepHz": 60, "maxSubsteps": 3, "iterations": 4, "drawCalls": 2,
                    "sleep": "positional drift < 0.002 units over 12 steps", "inertiaScale": 0.45, "maxInertiaG": 2.2},
        "remote": "No physics: baked full / half layouts + pop scale animation."},
    "assetLoading": dict(hexprof["assetLoading"]),
    "render": dict(hexprof["render"], **{"glassRenderOrder": 2, "runtimeDrawCalls": "6 meshes + 2 InstancedMesh (popcorn, kernels) + 1 optional muzzle burst"}),
    "presentationRules": {
        "straightPose": "Aim",
        "straightWhile": ["ADS"],
        "inspectionOnlyWhen": "Idle, not firing / reloading, no ADS, stationary",
        "useAuthoredRaiseLowerTransitionsForADS": True,
        "neverDelayGameplayToFinishVisualTransition": True,
        "aimNote": "Hip-level 'tight' aim: the popcorn tank would hide the crosshair in a true ADS, so the straight pose keeps the screen centre free.",
    },
    "sharedCharacterLocomotion": hexprof["sharedCharacterLocomotion"],
}
profile["assetLoading"]["preserveWeaponRootScale"] = wd.ROOT_SCALE
json.dump(profile, open("WeaponProfile_PopcornShotgun.json", "w"), indent=2)
print("ok; tp mask", upper_mask)
print("fp additionalScale", profile["mounts"]["fp"]["additionalScale"], "tp", profile["mounts"]["tp"]["additionalScale"])
