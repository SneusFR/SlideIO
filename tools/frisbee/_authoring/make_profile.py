"""Write WeaponProfile_FrisbeeLauncher.json (same schema family as WeaponProfile_HexSniper / PaintballRifle / WaterFamas)."""
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
CY, RL, SHOT = A.CY, A.RL, A.SHOT
c0 = SHOT["end"]
c0e = RL["rel"] + 0.20 - CY["h1"]              # cycle start inside ReloadEmpty


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
        b["clips"].append({"name": name, "frames": len(c["frames"]), "sampleFps": c["fps"], "duration": round(c["duration"], 4),
                           "loop": c["loop"], "channels": len(chans),
                           "maxLeftHandContactErrorMm": round(float(c["errors"][:, 2].max() * 1000), 3)})
    if extra: b.update(extra)
    return b


r3 = lambda x: round(float(x), 3)
fire_ev = {"shot": 0.0, "cocked": r3(c0 + CY["pull"]), "discTaken": r3(c0 + CY["take"]), "discSeated": r3(c0 + CY["seat"]),
           "readyToFire": r3(c0 + CY["back"] - 0.04)}
fire_dur = r3(c0 + CY["end"])
reload_ev = {"cageOut": r3(RL["down"]), "cageDrop": r3(RL["release"]), "cageSwap": r3(0.5 * (RL["hide0"] + RL["hide1"])), "cageIn": r3(RL["seat"]),
             "readyToFire": r3(RL["ret"] - 0.06)}
rle_ev = {"cageOut": r3(RL["down"]), "cageDrop": r3(RL["release"]), "cageSwap": r3(0.5 * (RL["hide0"] + RL["hide1"])), "cageIn": r3(RL["seat"]),
          "cocked": r3(c0e + CY["pull"]), "discTaken": r3(c0e + CY["take"]), "discSeated": r3(c0e + CY["seat"]),
          "readyToFire": r3(c0e + CY["back"] - 0.04)}
upper_mask = sorted(set(b for b, _ in tp["TP_Hold_FrisbeeLauncher"]["channels"]))

profile = {
    "schemaVersion": 1,
    "id": "FrisbeeLauncher",
    "compatibleRig": "Potato_Master_Clean_v1",
    "units": "meter",
    "assets": {"fpRig": "Potato_FP_CommonArms.glb", "fpPoses": "FrisbeeLauncher_FP_Poses.glb",
               "tpRig": "Potato_TP_Character.glb", "tpPoses": "FrisbeeLauncher_TP_Poses.glb",
               "weapon": "FrisbeeLauncher_Weapon.glb"},
    "camera": hexprof["camera"],
    "mounts": {
        "fp": mount_block(M_FP, "camera", fp, {
            "authoring": {"method": "IK per frame: weapon placed in camera space, right arm solved on Weapon_R (pistol grip), left "
                                    "arm on the vertical foregrip (Paintball Rifle fitted fist); off the grip (re-cocking, cage swap) "
                                    "the left arm is solved under natural limits (skin-seen twists, elbows down/out, shoulder slide) "
                                    "and its free-air moves are joint-space blends between contact poses; the launcher placements "
                                    "at the contact keys were searched for a natural arm + the action on screen (opt/search_keys.py)",
                          "holdGripCameraSpace": [float(x) for x in A.HOLD["grip"]],
                          "holdYawPitchRollDeg": [A.HOLD["yaw"], A.HOLD["pitch"], A.HOLD["roll"]],
                          "sameChannelSetAsHexSniper": True}}),
        "tp": mount_block(M_TP, "character", tp, {
            "animatedWeaponSocketCorrection": "Weapon_R translation is keyed at its rest value in every TP clip (resets the HexSniper offset).",
            "stance": {"twoHanded": True, "alwaysAiming": True, "gunDirection": "straight ahead (character +Z), level, in hold / aim / run",
                       "gripCharacterSpace": [round(float(v), 4) for v in tp["_meta"]["p0"]],
                       "spineYawLeanDeg": [round(float(v), 2) for v in tp["_meta"]["spine"]],
                       "foregripHandYawSlide": [round(float(v), 3) for v in tp["_meta"]["grip"].values()],
                       "characterSkinRequired": "Potato_TP_Character.glb v5 (flank / armpit weights repaired — the file shipped with the Popcorn Shotgun)"}}),
    },
    "fpClips": {"hold": "FP_FrisbeeLauncher_Hold", "run": "FP_FrisbeeLauncher_Run", "aim": "FP_Aim_FrisbeeLauncher",
                "raise": "FP_Raise_FrisbeeLauncher", "lower": "FP_Lower_FrisbeeLauncher", "inspect": "FP_Inspect_FrisbeeLauncher",
                "equip": "FP_Equip_FrisbeeLauncher", "unequip": "FP_Unequip_FrisbeeLauncher"},
    "fpActions": {"fire": {"clip": "FP_Fire_FrisbeeLauncher", "loop": False},
                  "fireAim": {"clip": "FP_FireAim_FrisbeeLauncher", "loop": False},
                  "fireLast": {"clip": "FP_FireLast_FrisbeeLauncher", "loop": False},
                  "fireLastAim": {"clip": "FP_FireLastAim_FrisbeeLauncher", "loop": False},
                  "reload": {"clip": "FP_Reload_FrisbeeLauncher", "loop": False},
                  "reloadEmpty": {"clip": "FP_ReloadEmpty_FrisbeeLauncher", "loop": False}},
    "tpClips": {"hold": "TP_Hold_FrisbeeLauncher", "run": "TP_Run_FrisbeeLauncher", "aim": "TP_Aim_FrisbeeLauncher",
                "raise": "TP_Raise_FrisbeeLauncher", "lower": "TP_Lower_FrisbeeLauncher",
                "actions": {"fire": {"clip": "TP_Fire_FrisbeeLauncher", "loop": False},
                            "fireLast": {"clip": "TP_FireLast_FrisbeeLauncher", "loop": False},
                            "reload": {"clip": "TP_Reload_FrisbeeLauncher", "loop": False},
                            "reloadEmpty": {"clip": "TP_ReloadEmpty_FrisbeeLauncher", "loop": False}}},
    "upperBodyMask": upper_mask,
    "weaponClips": {"idle": "Idle", "idleEmpty": "IdleEmpty", "fire": "Fire", "fireLast": "FireLast", "reload": "Reload",
                    "reloadEmpty": "ReloadEmpty", "reloadTP": "Reload_TP", "reloadEmptyTP": "ReloadEmpty_TP",
                    "inspect": "Inspect", "inspectEmpty": "InspectEmpty", "equip": "Equip", "equipEmpty": "EquipEmpty"},
    "actions": {
        "fire": {"fpClip": "FP_Fire_FrisbeeLauncher", "fpClipAim": "FP_FireAim_FrisbeeLauncher", "tpClip": "TP_Fire_FrisbeeLauncher",
                 "weaponClip": "Fire", "loop": False, "duration": fire_dur, "events": fire_ev, "recommendedFadeIn": 0.03,
                 "note": "The loaded disc is thrown at t=0 (projectile), then the automatic re-cock: the left hand pulls the sled back "
                         "(cocked), takes the next disc out of the cage (discTaken) and lays it on the deck (discSeated). Next shot "
                         "allowed from readyToFire (the end of the clip is the hand going back to the foregrip)."},
        "fireLast": {"fpClip": "FP_FireLast_FrisbeeLauncher", "fpClipAim": "FP_FireLastAim_FrisbeeLauncher",
                     "tpClip": "TP_FireLast_FrisbeeLauncher", "weaponClip": "FireLast", "loop": False, "duration": 0.5,
                     "events": {"shot": 0.0, "readyToReload": 0.25},
                     "note": "The cage is empty: the last disc is thrown, the launcher stays uncocked and empty."},
        "reload": {"fpClip": "FP_Reload_FrisbeeLauncher", "tpClip": "TP_Reload_FrisbeeLauncher", "weaponClip": "Reload",
                   "weaponClipTP": "Reload_TP", "duration": r3(RL["end"]), "events": reload_ev, "recommendedFadeIn": 0.08,
                   "note": "Deck loaded: the empty cage is pulled down and thrown away (cageDrop: FP it falls out of the view in the "
                           "clip; TP the Cage node is handed to a world-space copy, DroppedCages), a full cage (5 discs) comes out "
                           "of the belt pouch (off screen in FP) and is pushed in (click)."},
        "reloadEmpty": {"fpClip": "FP_ReloadEmpty_FrisbeeLauncher", "tpClip": "TP_ReloadEmpty_FrisbeeLauncher",
                        "weaponClip": "ReloadEmpty", "weaponClipTP": "ReloadEmpty_TP", "duration": r3(c0e + CY["end"]),
                        "events": rle_ev, "recommendedFadeIn": 0.08,
                        "note": "Deck empty: cage swap, then the re-cock (sled pulled back, a disc from the new cage laid on the deck)."},
        "inspect": {"fpClip": "FP_Inspect_FrisbeeLauncher", "weaponClip": "Inspect", "weaponClipEmpty": "InspectEmpty", "duration": 3.6},
    },
    "inspection": {"armsClip": "FP_Inspect_FrisbeeLauncher", "weaponClip": "Inspect", "duration": 3.6, "loop": False,
                   "twoHanded": True, "showcase": {"leftSide": [0.95, 1.6], "deckFromAbove": [2.25, 2.75]}, "gameplayEvents": []},
    "droppedCage": {"event": "cageDrop", "fpFallsOutOfViewInClip": True, "fpHiddenAt": r3(RL["gone"]),
                    "tpHandOverAt": r3(RL["release"]), "tpNodeHiddenAt": r3(RL["release"] + 1 / 60), "newCageAppearsAtFP": r3(A.RL_ARM["appear"]),
                    "newCageAppearsAtTP": r3(RL["hide1"]), "fpLeftArmOutOfView": [r3(A.RL_ARM["letgo"] + 0.03), r3(A.RL_ARM["pick"] - 0.07)],
                    "newCageGrowSeconds": A.GROW,
                    "note": "The weapon Cage node never vanishes in view: FP it leaves the screen before it is hidden and the new "
                            "one appears off screen; TP the thrown cage becomes a world prop (DroppedCages) that falls, lies on "
                            "the ground and sinks after a few seconds."},
    "discs": {"deckNode": "DiscDeck", "handNode": "DiscHand", "cageNode": "Cage", "cageDiscNodes": [f"CageDisc{k}" for k in range(wd.CAGE_SLOTS)],
              "cageCapacity": wd.CAGE_SLOTS, "capacity": 1 + wd.CAGE_SLOTS, "launchSocket": "LaunchSocket",
              "projectileTemplate": "DiscDeck (mesh, weapon units: radius %.2f)" % wd.DISC_R},
    "assetLoading": dict(hexprof["assetLoading"]),
    "render": dict(hexprof["render"], **{"runtimeDrawCalls": "9 meshes + 5 cage discs + the flying discs (1 each + trail)"}),
    "presentationRules": {
        "straightPose": "Aim",
        "straightWhile": ["ADS"],
        "inspectionOnlyWhen": "Idle, not firing / reloading, no ADS, stationary",
        "useAuthoredRaiseLowerTransitionsForADS": True,
        "neverDelayGameplayToFinishVisualTransition": True,
        "aimNote": "ADS = crossbow sight picture: the deck and the disc under the crosshair, the limbs across the screen.",
    },
    "sharedCharacterLocomotion": hexprof["sharedCharacterLocomotion"],
}
profile["assetLoading"]["preserveWeaponRootScale"] = wd.ROOT_SCALE
json.dump(profile, open("WeaponProfile_FrisbeeLauncher.json", "w"), indent=2)
print("ok; tp mask", upper_mask)
print("actions", {k: v.get("duration") for k, v in profile["actions"].items()})
for side in ("fp", "tp"):
    for c in profile["mounts"][side]["clips"]:
        print(side, c["name"], c["frames"], c["maxLeftHandContactErrorMm"])
