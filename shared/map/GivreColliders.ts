/**
 * SHARED GIVRE 01 map collision descriptors — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from src/assets/MAP/Givre/givre_01.physics.json
 * by scripts/generate-givre-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * One box = [x, y, z, sx, sy, sz] (center + FULL sizes, world AABB). The
 * frontend builds its Rapier world from the exact physics JSON
 * (307 cuboids + 209 convex hulls + 10 player-only clips, see
 * src/world/GivreMap.ts); the backend raycasts THIS list so walls occlude
 * shots. The playerClips are deliberately ABSENT: they block characters
 * only, never shots.
 *
 * NOTE: the 3 movement-ramp convex hulls are approximated here by
 * 6 stacked step slabs each; the remaining solid hulls use their AABB.
 */
import type { ColliderBox } from "./MapColliders";

export const GIVRE_COLLIDER_BOXES: ColliderBox[] = [
  // ---- Fixed cuboids (307) ----
  [123.525, 7, -52.975, 32.95, 14, 16.55], // COL_BAT_E_MID1_00
  [129.55, 7.75, -9.9, 20.9, 15.5, 69.6], // COL_BAT_E_MID2_00
  [123.525, 7, 44.95, 32.95, 14, 40.1], // COL_BAT_E_MID3_00
  [0.125, 7.25, -115.9, 122.75, 14.5, 18.2], // COL_BAT_N_MID_00
  [-36.95, 2, -68.975, 48.6, 4, 28.55], // COL_BAT_P1_00
  [-55.475, 4.75, -43.95, 19.55, 9.5, 34.6], // COL_BAT_P3_00
  [133.5, 7.5, -93.125, 13, 15, 63.75], // COL_BAT_PE1_00
  [-100.625, 8, -132.5, 78.75, 16, 15], // COL_BAT_PN1_00
  [0.125, 9, -132.5, 122.75, 18, 15], // COL_BAT_PN2_00
  [100.75, 8.25, -132.5, 78.5, 16.5, 15], // COL_BAT_PN3_00
  [-102.625, 7.5, 72.5, 74.75, 15, 15], // COL_BAT_PS1_00
  [-38.2, 6.25, 72.5, 54.1, 12.5, 15], // COL_BAT_PS2A_00
  [-1.375, 7, 69.525, 19.55, 14, 20.95], // COL_BAT_PS2B_00
  [46.475, 6.75, 72.5, 76.15, 13.5, 15], // COL_BAT_PS2C_00
  [112.275, 8, 72.5, 55.45, 16, 15], // COL_BAT_PS3_00
  [-133.5, 7.5, -93.125, 13, 15, 63.75], // COL_BAT_PW1_00
  [35.7, 2, -68.975, 51.6, 4, 28.55], // COL_BAT_Q1_00
  [73.025, 5.25, -52.975, 23.05, 10.5, 16.55], // COL_BAT_Q3_00
  [53.75, 4.75, -43.95, 15.5, 9.5, 34.6], // COL_BAT_Q4_00
  [53.75, 4.5, 20.65, 15.5, 9, 49.6], // COL_BAT_R1_00
  [73.025, 5, 35.175, 23.05, 10, 20.55], // COL_BAT_R2_00
  [-38.2, 3.3, 41.225, 15, 6.6, 8.45], // COL_BAT_T1A_00
  [-21.675, 3.3, 38.225, 18.05, 6.6, 2.45], // COL_BAT_T1B_00
  [36.975, 3.3, 41.225, 18.05, 6.6, 8.45], // COL_BAT_T2A_00
  [18.925, 3.3, 38.225, 18.05, 6.6, 2.45], // COL_BAT_T2B_00
  [-64, 3.3, 39.225, 2.5, 6.6, 12.45], // COL_BAT_TW_00
  [-55.475, 4, 3.625, 19.55, 8, 15.55], // COL_BAT_WB_00
  [-123.375, 6.25, 42.2, 33.25, 12.5, 45.6], // COL_BAT_W_LOW_00
  [-113.375, 7, -20.925, 53.25, 14, 80.65], // COL_BAT_W_MID_00
  [75.9, 0.475, -62.25, 4.6, 0.95, 0.8], // COL_CHAUFF_Atelier_00
  [94.2, 1.05, -124.125, 3.6, 2.1, 0.55], // COL_CHAUFF_Atelier_04
  [94.2, 0.225, -122.65, 3, 0.45, 0.4], // COL_CHAUFF_Atelier_05
  [106.775, 0.275, -100.4, 0.35, 0.55, 1.2], // COL_CHAUFF_Charbon_00
  [105.25, 0.65, -100.4, 2.18, 1.3, 1.32], // COL_CHAUFF_Charbon_01
  [99.4, 0.65, -78.9, 1.32, 1.3, 2.18], // COL_CHAUFF_Charbon_02
  [62.25, 0.475, -112.1, 0.3, 0.95, 4.8], // COL_CHAUFF_Details_00
  [82.65, 0.45, -104.35, 1.3, 0.9, 1.3], // COL_CHAUFF_Details_01
  [91.98, 1.45, -109.8, 11.64, 2.9, 2.6], // COL_CHAUFF_Machines_00
  [99, 6.15, -110, 0.7, 3.7, 0.7], // COL_CHAUFF_Machines_02
  [102.5, 1.05, -107.45, 2.6, 2.1, 1.3], // COL_CHAUFF_Machines_03
  [72.3, 3.05, -64.675, 20.4, 0.3, 5.65], // COL_CHAUFF_Mezzanine_00
  [66.3, 1.325, -67.3, 0.3, 2.65, 0.3], // COL_CHAUFF_Mezzanine_01
  [72.3, 1.325, -67.3, 0.3, 2.65, 0.3], // COL_CHAUFF_Mezzanine_02
  [77.9, 1.325, -67.3, 0.3, 2.65, 0.3], // COL_CHAUFF_Mezzanine_03
  [82.3, 1.325, -67.3, 0.3, 2.65, 0.3], // COL_CHAUFF_Mezzanine_04
  [68.25, 1.2, -68.45, 2.5, 2.4, 1.9], // COL_CHAUFF_Mezzanine_12
  [68.25, 0.6, -70.6, 2.5, 1.2, 2.4], // COL_CHAUFF_Mezzanine_13
  [65, 4.525, -64.4, 5.2, 2.65, 4.6], // COL_CHAUFF_Mezzanine_14
  [108.3, 0.625, -75.4, 2.6, 1.25, 3.2], // COL_CHAUFF_Reserve_00
  [108.3, 0.625, -72.2, 2.6, 1.25, 3.2], // COL_CHAUFF_Reserve_01
  [108.3, 0.625, -69.05, 2.6, 1.25, 3.1], // COL_CHAUFF_Reserve_02
  [108.3, 1.875, -75.8, 2.4, 1.25, 2.2], // COL_CHAUFF_Reserve_03
  [108.3, 1.875, -72.9, 2.4, 1.25, 3.6], // COL_CHAUFF_Reserve_04
  [108.3, 1.85, -69.35, 2.4, 1.2, 3.5], // COL_CHAUFF_Reserve_05
  [111.1, 0.625, -76.2, 3, 1.25, 2.6], // COL_CHAUFF_Reserve_06
  [114.1, 0.625, -76.2, 3, 1.25, 2.6], // COL_CHAUFF_Reserve_07
  [117.05, 0.625, -76.2, 2.9, 1.25, 2.6], // COL_CHAUFF_Reserve_08
  [110.75, 1.875, -76.2, 2.3, 1.25, 2.4], // COL_CHAUFF_Reserve_09
  [113.5, 1.85, -76.2, 3.2, 1.2, 2.4], // COL_CHAUFF_Reserve_10
  [116.75, 1.875, -76.2, 3.3, 1.25, 2.4], // COL_CHAUFF_Reserve_11
  [94.25, 0.8, -93.1, 6, 1.6, 5], // COL_CHAUFF_Station_00
  [94, 4, -94.8, 0.6, 4.8, 0.6], // COL_CHAUFF_Station_01
  [94, 4, -93.4, 0.6, 4.8, 0.6], // COL_CHAUFF_Station_02
  [92.55, 2.075, -91.6, 1.5, 0.95, 0.9], // COL_CHAUFF_Station_03
  [95.05, 2.075, -91.6, 1.5, 0.95, 0.9], // COL_CHAUFF_Station_04
  [96.75, 2.9, -93.1, 0.7, 2.6, 4.4], // COL_CHAUFF_Station_05
  [90.675, 0.4, -93.1, 1.15, 0.8, 1.4], // COL_CHAUFF_Station_06
  [-59.2, 0.5, 63.715, 3, 1, 0.73], // COL_COULOIR_Bancs_00
  [78.5, 0.5, 63.715, 3, 1, 0.73], // COL_COULOIR_Bancs_05
  [16.05, 0.5, 40.2, 1.2, 1, 1.2], // COL_COULOIR_Details_03
  [21.95, 0.6, 40.2, 1.2, 1.2, 1.2], // COL_COULOIR_Details_04
  [-50.8, 0.6, 59.55, 1.2, 1.2, 1.2], // COL_COULOIR_Details_05
  [58.9, 0.6, 64.1, 1.2, 1.2, 1.2], // COL_COULOIR_Details_06
  [73.2, 0.5, 51.8, 1.2, 1, 1.2], // COL_COULOIR_Details_07
  [-53.9, 1.25, 54.4, 4.2, 2.5, 2.8], // COL_COULOIR_Etals_00
  [-53.9, 0.52, 52.75, 3.84, 1.04, 0.5], // COL_COULOIR_Etals_01
  [-53.9, 1.25, 57.2, 4.2, 2.5, 2.8], // COL_COULOIR_Etals_04
  [-53.9, 0.52, 58.85, 3.84, 1.04, 0.5], // COL_COULOIR_Etals_05
  [-32.3, 1.25, 47.55, 2.8, 2.5, 4.2], // COL_COULOIR_Etals_08
  [-33.95, 0.52, 47.55, 0.5, 1.04, 3.84], // COL_COULOIR_Etals_09
  [-32.3, 1.25, 51.75, 2.8, 2.5, 4.2], // COL_COULOIR_Etals_12
  [-30.65, 0.52, 51.75, 0.5, 1.04, 3.84], // COL_COULOIR_Etals_13
  [-26.9, 1.25, 40.85, 4.2, 2.5, 2.8], // COL_COULOIR_Etals_16
  [-26.9, 0.52, 42.5, 3.84, 1.04, 0.5], // COL_COULOIR_Etals_17
  [13.1, 1.25, 40.85, 4.2, 2.5, 2.8], // COL_COULOIR_Etals_20
  [13.1, 0.52, 42.5, 3.84, 1.04, 0.5], // COL_COULOIR_Etals_21
  [19, 1.25, 40.85, 4.2, 2.5, 2.8], // COL_COULOIR_Etals_24
  [19, 0.52, 42.5, 3.84, 1.04, 0.5], // COL_COULOIR_Etals_25
  [24.9, 1.25, 40.85, 4.2, 2.5, 2.8], // COL_COULOIR_Etals_28
  [24.9, 0.52, 42.5, 3.84, 1.04, 0.5], // COL_COULOIR_Etals_29
  [56.4, 1.25, 58.7, 2.8, 2.5, 4.2], // COL_COULOIR_Etals_32
  [54.75, 0.52, 58.7, 0.5, 1.04, 3.84], // COL_COULOIR_Etals_33
  [56.4, 1.25, 62.9, 2.8, 2.5, 4.2], // COL_COULOIR_Etals_36
  [58.05, 0.52, 62.9, 0.5, 1.04, 3.84], // COL_COULOIR_Etals_37
  [70.1, 1.25, 53.4, 4.2, 2.5, 2.8], // COL_COULOIR_Etals_40
  [70.1, 0.52, 51.75, 3.84, 1.04, 0.5], // COL_COULOIR_Etals_41
  [70.1, 1.25, 56.2, 4.2, 2.5, 2.8], // COL_COULOIR_Etals_44
  [70.1, 0.52, 57.85, 3.84, 1.04, 0.5], // COL_COULOIR_Etals_45
  [-1.4, 4.3, 46.2, 1.2, 1.2, 1.2], // COL_COULOIR_Horloge_00
  [-22.149, 1.725, 55.5, 0.21, 0.95, 2.784], // COL_COULOIR_Kiosque_03
  [-14.851, 1.725, 55.5, 0.21, 0.95, 2.784], // COL_COULOIR_Kiosque_06
  [-14.851, 2.7, 53.988, 0.26, 2.9, 0.26], // COL_COULOIR_Kiosque_07
  [-16.988, 2.7, 51.851, 0.26, 2.9, 0.26], // COL_COULOIR_Kiosque_08
  [-20.012, 2.7, 51.851, 0.26, 2.9, 0.26], // COL_COULOIR_Kiosque_09
  [-22.149, 2.7, 53.988, 0.26, 2.9, 0.26], // COL_COULOIR_Kiosque_10
  [-22.149, 2.7, 57.012, 0.26, 2.9, 0.26], // COL_COULOIR_Kiosque_11
  [-20.012, 2.7, 59.149, 0.26, 2.9, 0.26], // COL_COULOIR_Kiosque_12
  [-16.988, 2.7, 59.149, 0.26, 2.9, 0.26], // COL_COULOIR_Kiosque_13
  [-14.851, 2.7, 57.012, 0.26, 2.9, 0.26], // COL_COULOIR_Kiosque_14
  [-61.2, 0.21, 48.6, 0.56, 0.42, 0.56], // COL_COULOIR_Lampadaires_00
  [-61.2, 1.885, 48.6, 0.2, 2.93, 0.2], // COL_COULOIR_Lampadaires_01
  [-61.2, 0.21, 61.8, 0.56, 0.42, 0.56], // COL_COULOIR_Lampadaires_02
  [-61.2, 1.885, 61.8, 0.2, 2.93, 0.2], // COL_COULOIR_Lampadaires_03
  [-6.6, 0.21, 57.6, 0.56, 0.42, 0.56], // COL_COULOIR_Lampadaires_04
  [-6.6, 1.885, 57.6, 0.2, 2.93, 0.2], // COL_COULOIR_Lampadaires_05
  [4.6, 0.21, 57.6, 0.56, 0.42, 0.56], // COL_COULOIR_Lampadaires_06
  [4.6, 1.885, 57.6, 0.2, 2.93, 0.2], // COL_COULOIR_Lampadaires_07
  [16, 0.21, 46.8, 0.56, 0.42, 0.56], // COL_COULOIR_Lampadaires_08
  [16, 1.885, 46.8, 0.2, 2.93, 0.2], // COL_COULOIR_Lampadaires_09
  [30, 0.21, 46.8, 0.56, 0.42, 0.56], // COL_COULOIR_Lampadaires_10
  [30, 1.885, 46.8, 0.2, 2.93, 0.2], // COL_COULOIR_Lampadaires_11
  [80.5, 0.21, 48.6, 0.56, 0.42, 0.56], // COL_COULOIR_Lampadaires_12
  [80.5, 1.885, 48.6, 0.2, 2.93, 0.2], // COL_COULOIR_Lampadaires_13
  [80.5, 0.21, 61.8, 0.56, 0.42, 0.56], // COL_COULOIR_Lampadaires_14
  [80.5, 1.885, 61.8, 0.2, 2.93, 0.2], // COL_COULOIR_Lampadaires_15
  [25.864, 2.14, 51.814, 0.12, 3.48, 0.12], // COL_COULOIR_Manege_03
  [21.814, 2.14, 50.136, 0.12, 3.48, 0.12], // COL_COULOIR_Manege_06
  [20.136, 2.14, 54.186, 0.12, 3.48, 0.12], // COL_COULOIR_Manege_09
  [24.186, 2.14, 55.864, 0.12, 3.48, 0.12], // COL_COULOIR_Manege_12
  [-1, 0.425, 58.55, 0.9, 0.85, 0.8], // COL_COULOIR_Sapin_08
  [-85.25, 0.65, -59.15, 3, 1.3, 3], // COL_COULO_Caisses_00
  [-85, 1.3, 17.2, 3.5, 2.6, 4.4], // COL_COULO_Caisses_01
  [-81.75, 0.65, 17.2, 3, 1.3, 3.2], // COL_COULO_Caisses_02
  [-84.4, 3.881, -60.182, 0.572, 1.118, 0.936], // COL_COULO_Lanternes_00
  [-67.6, 3.881, -60.182, 0.572, 1.118, 0.936], // COL_COULO_Lanternes_01
  [-85.5, 2.39, -50.025, 2.5, 0.42, 15.25], // COL_COULO_Passerelles_00
  [-85.5, 3.69, -22.25, 2.5, 0.42, 14.5], // COL_COULO_Passerelles_07
  [-85.5, 3.69, 3, 2.5, 0.42, 24], // COL_COULO_Passerelles_14
  [-66.65, 0.75, -48.5, 2.8, 1.5, 3], // COL_COULO_Sel_00
  [-66.65, 1.67, -49.24, 2.72, 0.34, 1.44], // COL_COULO_Sel_01
  [113.3, 0.25, -100.55, 11, 0.5, 15.9], // COL_COUV_Chaufferie_Chaudiere_00
  [113.3, 2.25, -100.55, 10, 3.5, 14.9], // COL_COUV_Chaufferie_Chaudiere_01
  [113.3, 4.3, -100.55, 10, 0.6, 14.9], // COL_COUV_Chaufferie_Chaudiere_02
  [108.075, 2, -100.55, 0.45, 1.6, 2.6], // COL_COUV_Chaufferie_Chaudiere_03
  [78.275, 1.4, -113.6, 12.95, 2.8, 8], // COL_COUV_Chaufferie_Cuve_00
  [-82.15, 1.3, -35.95, 9.2, 2.6, 12.9], // COL_COUV_CouloirOuest_Bloc1_00
  [-69.85, 1.3, 6.65, 9.2, 2.6, 11.9], // COL_COUV_CouloirOuest_Bloc2_00
  [-22.4, 1.2, -28.4, 12, 2.4, 6], // COL_COUV_CourCentrale_Bloc_00
  [33.752, 1.2, -43.97, 6.496, 2.4, 5.46], // COL_COUV_CourCentrale_CaissesNE_00
  [31.896, 0.6, -37.88, 10.208, 1.2, 3.36], // COL_COUV_CourCentrale_CaissesNE_01
  [27.14, 0.65, -44.81, 3.48, 1.3, 3.78], // COL_COUV_CourCentrale_CaissesNE_02
  [-28.452, 1.2, 25.17, 6.496, 2.4, 5.46], // COL_COUV_CourCentrale_CaissesSO_00
  [-26.596, 0.6, 19.08, 10.208, 1.2, 3.36], // COL_COUV_CourCentrale_CaissesSO_01
  [-21.84, 0.65, 26.01, 3.48, 1.3, 3.78], // COL_COUV_CourCentrale_CaissesSO_02
  [110.692, 1.2, -17.336, 4.816, 2.4, 4.472], // COL_COUV_CourLivraison_Caisses1_00
  [109.316, 0.6, -22.324, 7.568, 1.2, 2.752], // COL_COUV_CourLivraison_Caisses1_01
  [105.79, 0.65, -16.648, 2.58, 1.3, 3.096], // COL_COUV_CourLivraison_Caisses1_02
  [84.748, 1.2, -9.684, 6.496, 2.4, 6.032], // COL_COUV_CourLivraison_Caisses2_00
  [86.604, 0.6, -2.956, 10.208, 1.2, 3.712], // COL_COUV_CourLivraison_Caisses2_01
  [91.36, 0.65, -10.612, 3.48, 1.3, 4.176], // COL_COUV_CourLivraison_Caisses2_02
  [47.7, 1.2, 48.725, 8.6, 2.4, 6.55], // COL_COUV_Liaison_BlocEst_00
  [-41.45, 1.2, 61.7, 8.7, 2.4, 6.6], // COL_COUV_Liaison_BlocOuest_00
  [-74, 1.3, -113.6, 8.9, 2.6, 8], // COL_COUV_Stock_Bloc_00
  [-114, 2.1, -123, 14.2, 4.2, 1.8], // COL_COUV_Stock_Etageres_00
  [-96, 2.1, -123, 14.2, 4.2, 1.8], // COL_COUV_Stock_Etageres_01
  [-93.35, 1.7, 40.75, 0.2, 3.4, 0.2], // COL_CSO_Arche_00
  [-90.95, 1.7, 40.75, 0.2, 3.4, 0.2], // COL_CSO_Arche_01
  [-66.5, 3.69, 39.25, 2.5, 0.42, 11.5], // COL_CSO_Balcon_00
  [-66.75, 1.3, 47.1, 3, 2.6, 3], // COL_CSO_Balcon_06
  [-69.75, 0.65, 47.3, 3, 1.3, 2.6], // COL_CSO_Balcon_07
  [-91.25, 1.35, 58.35, 5.5, 2.7, 5.7], // COL_CSO_Cabane_00
  [-85.95, 0.75, 57.8, 3.2, 1.5, 1.2], // COL_CSO_Emballeuse_00
  [-82.5, 0.225, 47.5, 0.6, 0.45, 0.6], // COL_CSO_Lanternes_00
  [-82.5, 2.425, 47.5, 0.24, 3.95, 0.24], // COL_CSO_Lanternes_01
  [-72.5, 0.225, 59.5, 0.6, 0.45, 0.6], // COL_CSO_Lanternes_02
  [-72.5, 2.425, 59.5, 0.24, 3.95, 0.24], // COL_CSO_Lanternes_03
  [-90.4, 1.6, 32.1, 1, 3.2, 16.8], // COL_CSO_Rateliers_00
  [-93.9, 1.6, 45, 1, 3.2, 21], // COL_CSO_Rateliers_01
  [-99.7, 1.6, 43.9, 5.8, 3.2, 1], // COL_CSO_Rateliers_02
  [-93.45, 1.6, 24.2, 5.1, 3.2, 1], // COL_CSO_Rateliers_03
  [-103.6, 0.85, 31, 0.7, 1.7, 0.7], // COL_CSO_Sapins_00
  [-96, 0.85, 32.2, 0.7, 1.7, 0.7], // COL_CSO_Sapins_01
  [-100.5, 0.85, 37.6, 0.7, 1.7, 0.7], // COL_CSO_Sapins_02
  [-104.2, 0.85, 49.6, 0.7, 1.7, 0.7], // COL_CSO_Sapins_03
  [-96.6, 0.85, 50.6, 0.7, 1.7, 0.7], // COL_CSO_Sapins_04
  [-79.4, 1.15, 42.4, 2.4, 2.3, 2.4], // COL_CSO_Sapins_05
  [0.15, 3, -95.025, 67.9, 6, 23.55], // COL_GALERIE_Nord_00
  [-23.225, 6.25, -83.5, 21.15, 0.5, 0.5], // COL_GALERIE_Nord_01
  [22, 6.25, -83.5, 24.2, 0.5, 0.5], // COL_GALERIE_Nord_02
  [-12.25, 2.35, 38.225, 0.8, 4.7, 2.95], // COL_LIAISON_Cadres_00
  [9.5, 2.35, 38.225, 0.8, 4.7, 2.95], // COL_LIAISON_Cadres_01
  [-1.375, 5.1, 38.225, 22.55, 0.8, 2.95], // COL_LIAISON_Cadres_02
  [-63.2, 2.35, 46.15, 0.8, 4.7, 1.9], // COL_LIAISON_Cadres_03
  [-46.1, 2.35, 46.15, 0.8, 4.7, 1.9], // COL_LIAISON_Cadres_04
  [-54.65, 5.1, 46.15, 17.9, 0.8, 1.9], // COL_LIAISON_Cadres_05
  [-64.55, 2.35, 64.6, 1.9, 4.7, 0.8], // COL_LIAISON_Cadres_06
  [-64.55, 2.35, 45.85, 1.9, 4.7, 0.8], // COL_LIAISON_Cadres_07
  [-64.55, 5.1, 55.225, 1.9, 0.8, 19.55], // COL_LIAISON_Cadres_08
  [83.85, 2.35, 64.6, 1.9, 4.7, 0.8], // COL_LIAISON_Cadres_09
  [83.85, 2.35, 45.85, 1.9, 4.7, 0.8], // COL_LIAISON_Cadres_10
  [83.85, 5.1, 55.225, 1.9, 0.8, 19.55], // COL_LIAISON_Cadres_11
  [9.65, 5.8, 52.25, 149.8, 0.6, 13.6], // COL_LIAISON_Toit_00
  [-38.2, 5.8, 62.025, 54.1, 0.6, 5.95], // COL_LIAISON_Toit_01
  [46.475, 5.8, 62.025, 76.15, 0.6, 5.95], // COL_LIAISON_Toit_02
  [-1.375, 5.8, 42.45, 58.65, 0.6, 6], // COL_LIAISON_Toit_03
  [-1.375, 5.8, 38.225, 22.55, 0.6, 2.45], // COL_LIAISON_Toit_04
  [117.85, 3.69, -7.5, 2.5, 0.42, 10], // COL_LIVRAISON_Balcons_00
  [117.85, 4.99, 5.75, 2.5, 0.42, 11.5], // COL_LIVRAISON_Balcons_06
  [117.85, 4.99, 21.2, 2.5, 0.42, 7.4], // COL_LIVRAISON_Balcons_12
  [113.55, 3.69, 23.65, 6.1, 0.42, 2.5], // COL_LIVRAISON_Balcons_17
  [62.75, 3.69, 18.7, 2.5, 0.42, 12.4], // COL_LIVRAISON_Balcons_21
  [66.25, 3.69, 23.65, 4.5, 0.42, 2.5], // COL_LIVRAISON_Balcons_27
  [73.95, 4.99, 23.65, 5.1, 0.42, 2.5], // COL_LIVRAISON_Balcons_31
  [117.78, 1.3, -21.9, 2.44, 2.6, 12.2], // COL_LIVRAISON_Conteneurs_00
  [100.95, 1.3, 31.72, 12.2, 2.6, 2.44], // COL_LIVRAISON_Conteneurs_01
  [63.05, 1.95, 7.75, 3.1, 1.3, 3.5], // COL_LIVRAISON_Conteneurs_02
  [86.6, 3.881, -60.182, 0.572, 1.118, 0.936], // COL_LIVRAISON_Lanternes_00
  [105, 3.881, -60.182, 0.572, 1.118, 0.936], // COL_LIVRAISON_Lanternes_01
  [61.968, 3.881, -27.1, 0.936, 1.118, 0.572], // COL_LIVRAISON_Lanternes_02
  [61.968, 3.881, -3.7, 0.936, 1.118, 0.572], // COL_LIVRAISON_Lanternes_03
  [84.1, 3.881, 24.432, 0.572, 1.118, 0.936], // COL_LIVRAISON_Lanternes_04
  [107.5, 3.881, 24.432, 0.572, 1.118, 0.936], // COL_LIVRAISON_Lanternes_05
  [113.3, 0.65, -42.95, 11.6, 1.3, 3.5], // COL_LIVRAISON_Quais_00
  [117.35, 0.65, -35.6, 3.5, 1.3, 11.2], // COL_LIVRAISON_Quais_01
  [63.25, 0.65, 3.25, 3.5, 1.3, 12.5], // COL_LIVRAISON_Quais_02
  [106.9, 0.217, -42.95, 0.4, 0.434, 3.5], // COL_LIVRAISON_Quais_03
  [107.3, 0.433, -42.95, 0.4, 0.866, 3.5], // COL_LIVRAISON_Quais_04
  [63.25, 0.217, -3.6, 3.5, 0.434, 0.4], // COL_LIVRAISON_Quais_05
  [63.25, 0.433, -3.2, 3.5, 0.866, 0.4], // COL_LIVRAISON_Quais_06
  [-45.7, 0.6, 24.2, 1, 1.2, 25.6], // COL_MURET_CourOuest_00
  [21.5, 1.3, 20.4, 4, 2.6, 2.8], // COL_PLACE_Chalets_00
  [27.5, 1.3, 20.4, 4, 2.6, 2.8], // COL_PLACE_Chalets_02
  [27.2, 0.6, 23.4, 2.4, 1.2, 1.6], // COL_PLACE_Chalets_04
  [11.814, 0.225, 4.814, 0.6, 0.45, 0.6], // COL_PLACE_Lampadaires_00
  [11.814, 2.425, 4.814, 0.24, 3.95, 0.24], // COL_PLACE_Lampadaires_01
  [-10.814, 0.225, 4.814, 0.6, 0.45, 0.6], // COL_PLACE_Lampadaires_02
  [-10.814, 2.425, 4.814, 0.24, 3.95, 0.24], // COL_PLACE_Lampadaires_03
  [-10.814, 0.225, -17.814, 0.6, 0.45, 0.6], // COL_PLACE_Lampadaires_04
  [-10.814, 2.425, -17.814, 0.24, 3.95, 0.24], // COL_PLACE_Lampadaires_05
  [11.814, 0.225, -17.814, 0.6, 0.45, 0.6], // COL_PLACE_Lampadaires_06
  [11.814, 2.425, -17.814, 0.24, 3.95, 0.24], // COL_PLACE_Lampadaires_07
  [24.5, 0.225, 17, 0.6, 0.45, 0.6], // COL_PLACE_Lampadaires_08
  [24.5, 2.425, 17, 0.24, 3.95, 0.24], // COL_PLACE_Lampadaires_09
  [18, 0.45, -32, 2.6, 0.9, 2.6], // COL_PLACE_Sapins_00
  [-32, 0.45, -45, 2.6, 0.9, 2.6], // COL_PLACE_Sapins_02
  [-36, 0.45, 10, 2.6, 0.9, 2.6], // COL_PLACE_Sapins_04
  [36, 0.45, 11, 2.6, 0.9, 2.6], // COL_PLACE_Sapins_06
  [89.2, 2.5, -61.25, 0.8, 5, 1.7], // COL_SALLE_Chaufferie_Cadres_00
  [102.4, 2.5, -61.25, 0.8, 5, 1.7], // COL_SALLE_Chaufferie_Cadres_01
  [95.8, 5.4, -61.25, 14, 0.8, 1.7], // COL_SALLE_Chaufferie_Cadres_02
  [61.5, 2.5, -88.4, 1.7, 5, 0.8], // COL_SALLE_Chaufferie_Cadres_03
  [61.5, 2.5, -101.6, 1.7, 5, 0.8], // COL_SALLE_Chaufferie_Cadres_04
  [61.5, 5.4, -95, 1.7, 0.8, 14], // COL_SALLE_Chaufferie_Cadres_05
  [94.25, 4, -125, 66.7, 8, 1.2], // COL_SALLE_Chaufferie_Murs_00
  [74.85, 4, -61.25, 27.9, 8, 1.2], // COL_SALLE_Chaufferie_Murs_01
  [95.8, 6.9, -61.25, 14, 2.2, 1.2], // COL_SALLE_Chaufferie_Murs_02
  [115.2, 4, -61.25, 24.8, 8, 1.2], // COL_SALLE_Chaufferie_Murs_03
  [61.5, 4, -74.925, 1.2, 8, 26.15], // COL_SALLE_Chaufferie_Murs_04
  [61.5, 6.9, -95, 1.2, 2.2, 14], // COL_SALLE_Chaufferie_Murs_05
  [61.5, 4, -113.2, 1.2, 8, 22.4], // COL_SALLE_Chaufferie_Murs_06
  [127, 4, -93.125, 1.2, 8, 62.55], // COL_SALLE_Chaufferie_Murs_07
  [81, 4, -103, 1.1, 8, 1.1], // COL_SALLE_Chaufferie_Murs_08
  [101, 4, -103, 1.1, 8, 1.1], // COL_SALLE_Chaufferie_Murs_09
  [81, 4, -82.5, 1.1, 8, 1.1], // COL_SALLE_Chaufferie_Murs_10
  [101, 4, -82.5, 1.1, 8, 1.1], // COL_SALLE_Chaufferie_Murs_11
  [94.25, 8.4, -93.125, 66.7, 0.8, 64.95], // COL_SALLE_Chaufferie_Toit_00
  [-82.6, 2.5, -61.25, 0.8, 5, 1.7], // COL_SALLE_Stock_Cadres_00
  [-69.4, 2.5, -61.25, 0.8, 5, 1.7], // COL_SALLE_Stock_Cadres_01
  [-76, 5.4, -61.25, 14, 0.8, 1.7], // COL_SALLE_Stock_Cadres_02
  [-61.25, 2.5, -88.4, 1.7, 5, 0.8], // COL_SALLE_Stock_Cadres_03
  [-61.25, 2.5, -101.6, 1.7, 5, 0.8], // COL_SALLE_Stock_Cadres_04
  [-61.25, 5.4, -95, 1.7, 0.8, 14], // COL_SALLE_Stock_Cadres_05
  [-94.125, 4, -125, 66.95, 8, 1.2], // COL_SALLE_Stock_Murs_00
  [-105.3, 4, -61.25, 44.6, 8, 1.2], // COL_SALLE_Stock_Murs_01
  [-76, 6.9, -61.25, 14, 2.2, 1.2], // COL_SALLE_Stock_Murs_02
  [-64.825, 4, -61.25, 8.35, 8, 1.2], // COL_SALLE_Stock_Murs_03
  [-127, 4, -93.125, 1.2, 8, 62.55], // COL_SALLE_Stock_Murs_04
  [-61.25, 4, -74.925, 1.2, 8, 26.15], // COL_SALLE_Stock_Murs_05
  [-61.25, 6.9, -95, 1.2, 2.2, 14], // COL_SALLE_Stock_Murs_06
  [-61.25, 4, -113.2, 1.2, 8, 22.4], // COL_SALLE_Stock_Murs_07
  [-105, 4, -103.5, 1.1, 8, 1.1], // COL_SALLE_Stock_Murs_08
  [-83.5, 4, -103.5, 1.1, 8, 1.1], // COL_SALLE_Stock_Murs_09
  [-105, 4, -81.5, 1.1, 8, 1.1], // COL_SALLE_Stock_Murs_10
  [-83.5, 4, -81.5, 1.1, 8, 1.1], // COL_SALLE_Stock_Murs_11
  [-94.125, 8.4, -93.125, 66.95, 0.8, 64.95], // COL_SALLE_Stock_Toit_00
  [0, -0.5, -30, 280, 1, 220], // COL_SOL_Neige_00
  [-116.6, 1.2, -86.2, 3.6, 2.4, 3.6], // COL_STOCK_Caisses_00
  [-112.9, 0.6, -86.2, 3.8, 1.2, 3.6], // COL_STOCK_Caisses_01
  [-72.2, 0.675, -94.2, 2.4, 1.35, 1.24], // COL_STOCK_Chariot_00
  [-72.375, 2.26, -94.2, 1.75, 0.12, 1.24], // COL_STOCK_Chariot_01
  [-73.59, 1.5, -94.2, 0.22, 3, 1], // COL_STOCK_Chariot_02
  [-74.41, 1.55, -94.2, 1.18, 1.2, 1.2], // COL_STOCK_Chariot_03
  [-108.775, 1.3, -71.9, 2.45, 2.6, 12.2], // COL_STOCK_Conteneur_00
  [-111.2, 0.625, -68.8, 2.4, 1.25, 2.4], // COL_STOCK_Conteneur_01
  [-92.1, 1.1, -62.15, 2.8, 2.2, 0.6], // COL_STOCK_Details_00
  [-125.4, 1.2, -93, 1.8, 2.4, 24.2], // COL_STOCK_Etageres_Basses_00
  [-122.4, 3.05, -93, 8, 0.3, 27], // COL_STOCK_Mezzanine_00
  [-118.6, 1.325, -105.8, 0.3, 2.65, 0.3], // COL_STOCK_Mezzanine_01
  [-118.6, 1.325, -93.5, 0.3, 2.65, 0.3], // COL_STOCK_Mezzanine_02
  [-118.6, 1.325, -80.2, 0.3, 2.65, 0.3], // COL_STOCK_Mezzanine_03
  [-124.5, 3.8, -95.2, 2.4, 1.2, 2.4], // COL_STOCK_Mezzanine_09
  [-109.8, 1.2, -108.1, 2.6, 2.4, 2.6], // COL_STOCK_Palettes_00
  [-86.25, 0.6, -69.75, 2.5, 1.2, 2.5], // COL_STOCK_Palettes_01
  [-83.75, 1.2, -69.75, 2.5, 2.4, 2.5], // COL_STOCK_Palettes_02
  [-108.625, 0.45, -110.2, 0.25, 0.9, 1.7], // COL_STOCK_Rayonnage_00
  [-92.375, 0.45, -110.2, 0.25, 0.9, 1.7], // COL_STOCK_Rayonnage_01
  [-100.5, 2.1, -110.2, 16.2, 4.2, 1.8], // COL_STOCK_Rayonnage_02
  // ---- Movement ramps as step slabs (18) ----
  [-58.962, 0.125, -95.025, 4.595, 0.75, 23.55], // RAMPE_Ouest (6 slabs)
  [-54.387, 0.625, -95.025, 4.595, 1.75, 23.55],
  [-49.812, 1.125, -95.025, 4.595, 2.75, 23.55],
  [-45.237, 1.625, -95.025, 4.595, 3.75, 23.55],
  [-40.662, 2.125, -95.025, 4.595, 4.75, 23.55],
  [-36.087, 2.625, -95.025, 4.595, 5.75, 23.55],
  [59.217, 0.125, -95.025, 4.587, 0.75, 23.55], // RAMPE_Est (6 slabs)
  [54.65, 0.625, -95.025, 4.587, 1.75, 23.55],
  [50.083, 1.125, -95.025, 4.587, 2.75, 23.55],
  [45.517, 1.625, -95.025, 4.587, 3.75, 23.55],
  [40.95, 2.125, -95.025, 4.587, 4.75, 23.55],
  [36.383, 2.625, -95.025, 4.587, 5.75, 23.55],
  [-1.375, 0.125, -57.079, 22.55, 0.75, 4.778], // RAMPE_Sud (6 slabs)
  [-1.375, 0.625, -61.838, 22.55, 1.75, 4.778],
  [-1.375, 1.125, -66.596, 22.55, 2.75, 4.778],
  [-1.375, 1.625, -71.354, 22.55, 3.75, 4.778],
  [-1.375, 2.125, -76.112, 22.55, 4.75, 4.778],
  [-1.375, 2.625, -80.871, 22.55, 5.75, 4.778],
  // ---- Solid convex hulls as AABBs (206) ----
  [69.925, 1.824, -63.957, 0.602, 0.38, 0.549], // COL_CHAUFF_Atelier_01 (hull AABB)
  [70.628, 1.784, -64.68, 0.526, 0.3, 0.526], // COL_CHAUFF_Atelier_02 (hull AABB)
  [70.542, 1.33, -64.3, 3.515, 2.66, 1.9], // COL_CHAUFF_Atelier_03 (hull AABB)
  [106.439, 0.375, -97.368, 2.015, 0.75, 1.772], // COL_CHAUFF_Chaudiere_Decor_00 (hull AABB)
  [99, 2.15, -110, 3.696, 4.3, 3.696], // COL_CHAUFF_Machines_01 (hull AABB)
  [64.65, 3.75, -67.38, 4.7, 1.1, 0.2], // COL_CHAUFF_Mezzanine_05 (hull AABB)
  [74.05, 3.75, -67.38, 9.1, 1.1, 0.2], // COL_CHAUFF_Mezzanine_06 (hull AABB)
  [82, 3.75, -67.38, 0.8, 1.1, 0.2], // COL_CHAUFF_Mezzanine_07 (hull AABB)
  [82.38, 3.75, -64.675, 0.2, 1.1, 5.45], // COL_CHAUFF_Mezzanine_08 (hull AABB)
  [80.1, 1.6, -70.7, 3, 3.2, 6.4], // COL_CHAUFF_Mezzanine_09 (hull AABB)
  [78.7, 2.288, -70.325, 0.2, 3.675, 5.35], // COL_CHAUFF_Mezzanine_10 (hull AABB)
  [81.5, 2.288, -70.325, 0.2, 3.675, 5.35], // COL_CHAUFF_Mezzanine_11 (hull AABB)
  [-26.812, 0.5, 62.61, 2.505, 1, 2.754], // COL_COULOIR_Bancs_01 (hull AABB)
  [-23.607, 0.5, 47.287, 2.933, 1, 2.204], // COL_COULOIR_Bancs_02 (hull AABB)
  [16.992, 0.5, 61.913, 2.895, 1, 2.283], // COL_COULOIR_Bancs_03 (hull AABB)
  [29.008, 0.5, 61.913, 2.895, 1, 2.283], // COL_COULOIR_Bancs_04 (hull AABB)
  [-22.4, 0.475, 42.6, 0.84, 0.95, 0.84], // COL_COULOIR_Details_00 (hull AABB)
  [-18.5, 0.475, 41.3, 0.84, 0.95, 0.84], // COL_COULOIR_Details_01 (hull AABB)
  [-14.7, 0.475, 42.7, 0.84, 0.95, 0.84], // COL_COULOIR_Details_02 (hull AABB)
  [27.45, 0.525, 40, 0.84, 1.05, 0.84], // COL_COULOIR_Details_08 (hull AABB)
  [-50.6, 0.525, 61, 0.84, 1.05, 0.84], // COL_COULOIR_Details_09 (hull AABB)
  [73.4, 0.525, 58.7, 0.84, 1.05, 0.84], // COL_COULOIR_Details_10 (hull AABB)
  [-53.9, 2.21, 52.45, 4.4, 0.58, 1.1], // COL_COULOIR_Etals_02 (hull AABB)
  [-53.9, 2.875, 54.4, 4.8, 0.85, 3.4], // COL_COULOIR_Etals_03 (hull AABB)
  [-53.9, 2.21, 59.15, 4.4, 0.58, 1.1], // COL_COULOIR_Etals_06 (hull AABB)
  [-53.9, 2.875, 57.2, 4.8, 0.85, 3.4], // COL_COULOIR_Etals_07 (hull AABB)
  [-34.25, 2.21, 47.55, 1.1, 0.58, 4.4], // COL_COULOIR_Etals_10 (hull AABB)
  [-32.3, 2.875, 47.55, 3.4, 0.85, 4.8], // COL_COULOIR_Etals_11 (hull AABB)
  [-30.35, 2.21, 51.75, 1.1, 0.58, 4.4], // COL_COULOIR_Etals_14 (hull AABB)
  [-32.3, 2.975, 51.75, 3.4, 1.05, 4.8], // COL_COULOIR_Etals_15 (hull AABB)
  [-26.9, 2.21, 42.8, 4.4, 0.58, 1.1], // COL_COULOIR_Etals_18 (hull AABB)
  [-26.9, 2.925, 40.85, 4.8, 0.95, 3.4], // COL_COULOIR_Etals_19 (hull AABB)
  [13.1, 2.21, 42.8, 4.4, 0.58, 1.1], // COL_COULOIR_Etals_22 (hull AABB)
  [13.1, 2.875, 40.85, 4.8, 0.85, 3.4], // COL_COULOIR_Etals_23 (hull AABB)
  [19, 2.21, 42.8, 4.4, 0.58, 1.1], // COL_COULOIR_Etals_26 (hull AABB)
  [19, 2.95, 40.85, 4.8, 1, 3.4], // COL_COULOIR_Etals_27 (hull AABB)
  [24.9, 2.21, 42.8, 4.4, 0.58, 1.1], // COL_COULOIR_Etals_30 (hull AABB)
  [24.9, 2.875, 40.85, 4.8, 0.85, 3.4], // COL_COULOIR_Etals_31 (hull AABB)
  [54.45, 2.21, 58.7, 1.1, 0.58, 4.4], // COL_COULOIR_Etals_34 (hull AABB)
  [56.4, 2.975, 58.7, 3.4, 1.05, 4.8], // COL_COULOIR_Etals_35 (hull AABB)
  [58.35, 2.21, 62.9, 1.1, 0.58, 4.4], // COL_COULOIR_Etals_38 (hull AABB)
  [56.4, 2.875, 62.9, 3.4, 0.85, 4.8], // COL_COULOIR_Etals_39 (hull AABB)
  [70.1, 2.21, 51.45, 4.4, 0.58, 1.1], // COL_COULOIR_Etals_42 (hull AABB)
  [70.1, 2.875, 53.4, 4.8, 0.85, 3.4], // COL_COULOIR_Etals_43 (hull AABB)
  [70.1, 2.21, 58.15, 4.4, 0.58, 1.1], // COL_COULOIR_Etals_46 (hull AABB)
  [70.1, 2.875, 56.2, 4.8, 0.85, 3.4], // COL_COULOIR_Etals_47 (hull AABB)
  [-18.5, 0.625, 55.5, 7.76, 1.25, 7.76], // COL_COULOIR_Kiosque_00 (hull AABB)
  [-15.92, 1.725, 52.92, 2.117, 0.95, 2.117], // COL_COULOIR_Kiosque_01 (hull AABB)
  [-21.08, 1.725, 52.92, 2.117, 0.95, 2.117], // COL_COULOIR_Kiosque_02 (hull AABB)
  [-21.08, 1.725, 58.081, 2.117, 0.95, 2.117], // COL_COULOIR_Kiosque_04 (hull AABB)
  [-15.92, 1.725, 58.081, 2.117, 0.95, 2.117], // COL_COULOIR_Kiosque_05 (hull AABB)
  [-18.5, 4.625, 55.5, 8.5, 0.95, 8.5], // COL_COULOIR_Kiosque_15 (hull AABB)
  [-18.5, 0.625, 50.27, 2.4, 1.25, 2.7], // COL_COULOIR_Kiosque_16 (hull AABB)
  [-19.76, 1.138, 50.295, 0.2, 2.025, 2.55], // COL_COULOIR_Kiosque_17 (hull AABB)
  [-17.24, 1.138, 50.295, 0.2, 2.025, 2.55], // COL_COULOIR_Kiosque_18 (hull AABB)
  [-18.5, 0.625, 60.73, 2.4, 1.25, 2.7], // COL_COULOIR_Kiosque_19 (hull AABB)
  [-19.76, 1.138, 60.705, 0.2, 2.025, 2.55], // COL_COULOIR_Kiosque_20 (hull AABB)
  [-17.24, 1.138, 60.705, 0.2, 2.025, 2.55], // COL_COULOIR_Kiosque_21 (hull AABB)
  [-20.185, 1.725, 54.086, 0.62, 0.95, 0.62], // COL_COULOIR_Kiosque_22 (hull AABB)
  [-20.625, 1.725, 54.931, 0.538, 0.95, 0.539], // COL_COULOIR_Kiosque_23 (hull AABB)
  [-20.666, 1.725, 55.882, 0.509, 0.95, 0.51], // COL_COULOIR_Kiosque_24 (hull AABB)
  [-20.302, 1.725, 56.762, 0.612, 0.95, 0.612], // COL_COULOIR_Kiosque_25 (hull AABB)
  [-19.8, 1.75, 57.752, 0.4, 0.76, 0.76], // COL_COULOIR_Kiosque_26 (hull AABB)
  [23.001, 0.2, 53.001, 8.827, 0.4, 8.827], // COL_COULOIR_Manege_00 (hull AABB)
  [23, 2.14, 53, 4, 3.48, 4], // COL_COULOIR_Manege_01 (hull AABB)
  [23, 4.54, 53, 9.612, 1.32, 9.612], // COL_COULOIR_Manege_02 (hull AABB)
  [25.778, 1.955, 51.606, 1.132, 1.15, 1.808], // COL_COULOIR_Manege_04 (hull AABB)
  [24.117, 1.1, 50.107, 2.092, 1.4, 1.632], // COL_COULOIR_Manege_05 (hull AABB)
  [21.606, 1.775, 50.222, 1.808, 1.15, 1.132], // COL_COULOIR_Manege_07 (hull AABB)
  [20.107, 1.1, 51.883, 1.632, 1.4, 2.092], // COL_COULOIR_Manege_08 (hull AABB)
  [20.222, 1.955, 54.394, 1.132, 1.15, 1.808], // COL_COULOIR_Manege_10 (hull AABB)
  [21.883, 1.1, 55.893, 2.092, 1.4, 1.632], // COL_COULOIR_Manege_11 (hull AABB)
  [24.394, 1.775, 55.778, 1.808, 1.15, 1.132], // COL_COULOIR_Manege_13 (hull AABB)
  [25.893, 1.1, 54.117, 1.632, 1.4, 2.092], // COL_COULOIR_Manege_14 (hull AABB)
  [-32.3, 1.44, 54.65, 1.5, 2.88, 1.5], // COL_COULOIR_Morris_00 (hull AABB)
  [56.4, 1.44, 55.8, 1.5, 2.88, 1.5], // COL_COULOIR_Morris_01 (hull AABB)
  [-1, 0.31, 56.5, 2.956, 0.62, 2.956], // COL_COULOIR_Sapin_00 (hull AABB)
  [-1, 2.85, 56.5, 5, 4.2, 5], // COL_COULOIR_Sapin_01 (hull AABB)
  [-3.4, 0.35, 54.9, 1, 0.7, 1], // COL_COULOIR_Sapin_02 (hull AABB)
  [1.3, 0.275, 54.7, 0.816, 0.55, 1.012], // COL_COULOIR_Sapin_03 (hull AABB)
  [-2, 0.21, 54.2, 0.678, 0.42, 0.678], // COL_COULOIR_Sapin_04 (hull AABB)
  [0.2, 0.3, 53.95, 0.746, 0.6, 0.568], // COL_COULOIR_Sapin_05 (hull AABB)
  [-4, 0.25, 57.6, 0.708, 0.5, 0.708], // COL_COULOIR_Sapin_06 (hull AABB)
  [2.101, 0.325, 57.501, 0.747, 0.65, 0.879], // COL_COULOIR_Sapin_07 (hull AABB)
  [-1, 1.15, 58.55, 0.832, 0.6, 0.774], // COL_COULOIR_Sapin_09 (hull AABB)
  [-1, 1.675, 58.55, 0.586, 0.45, 0.57], // COL_COULOIR_Sapin_10 (hull AABB)
  [-74.375, 0.521, -21.343, 2.289, 1.041, 1.622], // COL_COULO_Citerne_00 (hull AABB)
  [-76.5, 1.15, -20, 6.31, 2.289, 5.374], // COL_COULO_Citerne_01 (hull AABB)
  [-66.665, 0.4, -54.832, 2.872, 0.8, 2.027], // COL_COULO_Congeres_00 (hull AABB)
  [-66.546, 0.45, -2.385, 2.924, 0.9, 2.142], // COL_COULO_Congeres_01 (hull AABB)
  [-85.875, 1.69, -57.15, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_01 (hull AABB)
  [-85.875, 1.69, -54.3, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_02 (hull AABB)
  [-85.875, 1.69, -51.45, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_03 (hull AABB)
  [-85.875, 1.69, -48.6, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_04 (hull AABB)
  [-85.875, 1.69, -45.75, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_05 (hull AABB)
  [-85.875, 1.69, -42.9, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_06 (hull AABB)
  [-85.875, 2.99, -29, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_08 (hull AABB)
  [-85.875, 2.99, -26.3, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_09 (hull AABB)
  [-85.875, 2.99, -23.6, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_10 (hull AABB)
  [-85.875, 2.99, -20.9, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_11 (hull AABB)
  [-85.875, 2.99, -18.2, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_12 (hull AABB)
  [-85.875, 2.99, -15.5, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_13 (hull AABB)
  [-85.875, 2.99, -8.5, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_15 (hull AABB)
  [-85.875, 2.99, -5.625, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_16 (hull AABB)
  [-85.875, 2.99, -2.75, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_17 (hull AABB)
  [-85.875, 2.99, 0.125, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_18 (hull AABB)
  [-85.875, 2.99, 3, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_19 (hull AABB)
  [-85.875, 2.99, 5.875, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_20 (hull AABB)
  [-85.875, 2.99, 8.75, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_21 (hull AABB)
  [-85.875, 2.99, 11.625, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_22 (hull AABB)
  [-85.875, 2.99, 14.5, 1.75, 0.98, 0.2], // COL_COULO_Passerelles_23 (hull AABB)
  [112.1, 6.35, -105.5, 1.2, 3.9, 1.2], // COL_COUV_Chaufferie_Chaudiere_04 (hull AABB)
  [114.5, 5.5, -96.1, 1, 2.2, 1], // COL_COUV_Chaufferie_Chaudiere_05 (hull AABB)
  [120.45, 6.6, -96.1, 11.9, 1, 1], // COL_COUV_Chaufferie_Chaudiere_06 (hull AABB)
  [-66.125, 2.99, 34, 1.75, 0.98, 0.2], // COL_CSO_Balcon_01 (hull AABB)
  [-66.125, 2.99, 36.625, 1.75, 0.98, 0.2], // COL_CSO_Balcon_02 (hull AABB)
  [-66.125, 2.99, 39.25, 1.75, 0.98, 0.2], // COL_CSO_Balcon_03 (hull AABB)
  [-66.125, 2.99, 41.875, 1.75, 0.98, 0.2], // COL_CSO_Balcon_04 (hull AABB)
  [-66.125, 2.99, 44.5, 1.75, 0.98, 0.2], // COL_CSO_Balcon_05 (hull AABB)
  [-91.25, 3.25, 58.35, 6.2, 1.2, 6.4], // COL_CSO_Cabane_01 (hull AABB)
  [-82.5, 0.65, 30.6, 2.6, 1.3, 1.8], // COL_CSO_Sapins_06 (hull AABB)
  [-75.3, 0.65, 55.2, 2.6, 1.3, 1.8], // COL_CSO_Sapins_07 (hull AABB)
  [-23.225, 6.95, -83.5, 20.75, 0.6, 0.2], // COL_GALERIE_GardeCorps_00 (hull AABB)
  [22, 6.95, -83.5, 23.8, 0.6, 0.2], // COL_GALERIE_GardeCorps_01 (hull AABB)
  [-41.15, 4.944, -83.6, 14.7, 4.313, 0.2], // COL_GALERIE_GardeCorps_02 (hull AABB)
  [41.4, 4.951, -83.6, 14.6, 4.297, 0.2], // COL_GALERIE_GardeCorps_03 (hull AABB)
  [-12.3, 4.948, -75.625, 0.2, 4.305, 15.25], // COL_GALERIE_GardeCorps_04 (hull AABB)
  [9.55, 4.948, -75.625, 0.2, 4.305, 15.25], // COL_GALERIE_GardeCorps_05 (hull AABB)
  [118.225, 2.99, -12, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_01 (hull AABB)
  [118.225, 2.99, -9.75, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_02 (hull AABB)
  [118.225, 2.99, -7.5, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_03 (hull AABB)
  [118.225, 2.99, -5.25, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_04 (hull AABB)
  [118.225, 2.99, -3, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_05 (hull AABB)
  [118.225, 4.29, 0.5, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_07 (hull AABB)
  [118.225, 4.29, 3.125, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_08 (hull AABB)
  [118.225, 4.29, 5.75, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_09 (hull AABB)
  [118.225, 4.29, 8.375, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_10 (hull AABB)
  [118.225, 4.29, 11, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_11 (hull AABB)
  [118.225, 4.29, 18, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_13 (hull AABB)
  [118.225, 4.29, 20.133, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_14 (hull AABB)
  [118.225, 4.29, 22.267, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_15 (hull AABB)
  [118.225, 4.29, 24.4, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_16 (hull AABB)
  [111, 2.99, 24.025, 0.2, 0.98, 1.75], // COL_LIVRAISON_Balcons_18 (hull AABB)
  [113.55, 2.99, 24.025, 0.2, 0.98, 1.75], // COL_LIVRAISON_Balcons_19 (hull AABB)
  [116.1, 2.99, 24.025, 0.2, 0.98, 1.75], // COL_LIVRAISON_Balcons_20 (hull AABB)
  [62.375, 2.99, 13, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_22 (hull AABB)
  [62.375, 2.99, 15.85, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_23 (hull AABB)
  [62.375, 2.99, 18.7, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_24 (hull AABB)
  [62.375, 2.99, 21.55, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_25 (hull AABB)
  [62.375, 2.99, 24.4, 1.75, 0.98, 0.2], // COL_LIVRAISON_Balcons_26 (hull AABB)
  [64.5, 2.99, 24.025, 0.2, 0.98, 1.75], // COL_LIVRAISON_Balcons_28 (hull AABB)
  [66.25, 2.99, 24.025, 0.2, 0.98, 1.75], // COL_LIVRAISON_Balcons_29 (hull AABB)
  [68, 2.99, 24.025, 0.2, 0.98, 1.75], // COL_LIVRAISON_Balcons_30 (hull AABB)
  [71.9, 4.29, 24.025, 0.2, 0.98, 1.75], // COL_LIVRAISON_Balcons_32 (hull AABB)
  [73.95, 4.29, 24.025, 0.2, 0.98, 1.75], // COL_LIVRAISON_Balcons_33 (hull AABB)
  [76, 4.29, 24.025, 0.2, 0.98, 1.75], // COL_LIVRAISON_Balcons_34 (hull AABB)
  [64.15, 0.55, -41.859, 4.075, 1.1, 2.781], // COL_LIVRAISON_Congeres_00 (hull AABB)
  [104.481, 3.19, 31.709, 3.784, 0.9, 1.834], // COL_LIVRAISON_Conteneurs_04 (hull AABB)
  [10.271, 0.5, 3.271, 2.637, 1, 2.637], // COL_PLACE_Bancs_00 (hull AABB)
  [-9.27, 0.5, 3.271, 2.637, 1, 2.637], // COL_PLACE_Bancs_01 (hull AABB)
  [-9.27, 0.5, -16.27, 2.637, 1, 2.637], // COL_PLACE_Bancs_02 (hull AABB)
  [10.271, 0.5, -16.27, 2.637, 1, 2.637], // COL_PLACE_Bancs_03 (hull AABB)
  [-18, 1.375, 11, 1.36, 2.75, 1.36], // COL_PLACE_Bonhomme_00 (hull AABB)
  [21.5, 3.05, 20.4, 4.7, 1, 3.5], // COL_PLACE_Chalets_01 (hull AABB)
  [27.5, 3.05, 20.4, 4.7, 1, 3.5], // COL_PLACE_Chalets_03 (hull AABB)
  [-23.886, 0.6, 32.481, 5.303, 1.2, 3.101], // COL_PLACE_Congeres_00 (hull AABB)
  [20.919, 0.6, 32.474, 4.928, 1.2, 3.038], // COL_PLACE_Congeres_01 (hull AABB)
  [33.471, 0.5, 25.554, 3.395, 1, 4.018], // COL_PLACE_Congeres_02 (hull AABB)
  [-35.932, 0.65, -14.059, 3.357, 1.3, 5.056], // COL_PLACE_Congeres_03 (hull AABB)
  [-24, 1.21, -33.7, 5.2, 2.42, 4.6], // COL_PLACE_Congeres_04 (hull AABB)
  [9.384, 0.525, -11.696, 3.483, 1.05, 5.164], // COL_PLACE_Fontaine_00 (hull AABB)
  [5.696, 0.525, -15.383, 5.164, 1.05, 3.483], // COL_PLACE_Fontaine_01 (hull AABB)
  [0.5, 0.525, -16.69, 5.694, 1.05, 0.869], // COL_PLACE_Fontaine_02 (hull AABB)
  [-4.696, 0.525, -15.383, 5.164, 1.05, 3.483], // COL_PLACE_Fontaine_03 (hull AABB)
  [-8.383, 0.525, -11.696, 3.483, 1.05, 5.164], // COL_PLACE_Fontaine_04 (hull AABB)
  [-9.69, 0.525, -6.5, 0.869, 1.05, 5.694], // COL_PLACE_Fontaine_05 (hull AABB)
  [-8.383, 0.525, -1.304, 3.483, 1.05, 5.164], // COL_PLACE_Fontaine_06 (hull AABB)
  [-4.696, 0.525, 2.384, 5.164, 1.05, 3.483], // COL_PLACE_Fontaine_07 (hull AABB)
  [0.5, 0.525, 3.691, 5.694, 1.05, 0.869], // COL_PLACE_Fontaine_08 (hull AABB)
  [5.696, 0.525, 2.384, 5.164, 1.05, 3.483], // COL_PLACE_Fontaine_09 (hull AABB)
  [9.384, 0.525, -1.304, 3.483, 1.05, 5.164], // COL_PLACE_Fontaine_10 (hull AABB)
  [10.691, 0.525, -6.5, 0.869, 1.05, 5.694], // COL_PLACE_Fontaine_11 (hull AABB)
  [0.5, 0.11, -6.499, 19.473, 0.22, 19.473], // COL_PLACE_Fontaine_12 (hull AABB)
  [0.5, 0.91, -6.5, 6.568, 1.38, 6.568], // COL_PLACE_Fontaine_13 (hull AABB)
  [0.5, 2.18, -6.5, 11.592, 1.16, 11.592], // COL_PLACE_Fontaine_14 (hull AABB)
  [6.926, 0.835, -10.28, 1.931, 1.23, 2.038], // COL_PLACE_Fontaine_15 (hull AABB)
  [-5.971, 0.835, -2.773, 1.933, 1.23, 1.963], // COL_PLACE_Fontaine_16 (hull AABB)
  [-1.472, 3.21, -9.889, 1.166, 0.9, 1.278], // COL_PLACE_Fontaine_17 (hull AABB)
  [2.446, 3.21, -3.161, 1.223, 0.9, 1.234], // COL_PLACE_Fontaine_18 (hull AABB)
  [0.5, 4.85, -6.5, 1.756, 4.3, 1.756], // COL_PLACE_Fontaine_19 (hull AABB)
  [0.5, 5.675, -6.5, 5.216, 0.75, 5.216], // COL_PLACE_Fontaine_20 (hull AABB)
  [18, 3.975, -32, 4.4, 4.85, 4.4], // COL_PLACE_Sapins_01 (hull AABB)
  [-32, 3.975, -45, 4.4, 4.85, 4.4], // COL_PLACE_Sapins_03 (hull AABB)
  [-36, 3.975, 10, 4.4, 4.85, 4.4], // COL_PLACE_Sapins_05 (hull AABB)
  [36, 3.975, 11, 4.4, 4.85, 4.4], // COL_PLACE_Sapins_07 (hull AABB)
  [-115.2, 1.6, -101, 6.4, 3.2, 4], // COL_STOCK_Escalier_00 (hull AABB)
  [-115.3, 2.15, -102.88, 6, 4, 0.2], // COL_STOCK_Escalier_01 (hull AABB)
  [-115.3, 2.15, -99.12, 6, 4, 0.2], // COL_STOCK_Escalier_02 (hull AABB)
  [-86.7, 0.525, -120.8, 0.84, 1.05, 0.84], // COL_STOCK_Futs_00 (hull AABB)
  [-85.7, 0.525, -119.4, 0.84, 1.05, 0.84], // COL_STOCK_Futs_01 (hull AABB)
  [-84.5, 0.525, -120.7, 0.84, 1.05, 0.84], // COL_STOCK_Futs_02 (hull AABB)
  [-118.5, 3.75, -104.7, 0.2, 1.1, 3.4], // COL_STOCK_Mezzanine_04 (hull AABB)
  [-118.5, 3.75, -93.5, 0.2, 1.1, 11], // COL_STOCK_Mezzanine_05 (hull AABB)
  [-118.5, 3.75, -82, 0.2, 1.1, 4.8], // COL_STOCK_Mezzanine_06 (hull AABB)
  [-122.4, 3.75, -106.4, 7.8, 1.1, 0.2], // COL_STOCK_Mezzanine_07 (hull AABB)
  [-122.4, 3.75, -79.6, 7.8, 1.1, 0.2], // COL_STOCK_Mezzanine_08 (hull AABB)
];
