/**
 * SHARED GIVRE 01 map collision descriptors — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from src/assets/MAP/Givre/givre_01.physics.json
 * by scripts/generate-givre-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * One box = [x, y, z, sx, sy, sz] (center + FULL sizes, world AABB). The
 * frontend builds its Rapier world from the exact physics JSON
 * (171 cuboids + 14 convex hulls + 2 player-only clips, see
 * src/world/GivreMap.ts); the backend raycasts THIS list so walls occlude
 * shots. The playerClips are deliberately ABSENT: they block characters
 * only, never shots.
 *
 * NOTE: the 3 movement-ramp convex hulls are approximated here by
 * 6 stacked step slabs each; the remaining solid hulls use their AABB.
 */
import type { ColliderBox } from "./MapColliders";

export const GIVRE_COLLIDER_BOXES: ColliderBox[] = [
  // ---- Fixed cuboids (171) ----
  [-36.95, 4.5, 72.75, 48.6, 9, 19.5], // COL_BAT_CS1_00
  [35.7, 4.25, 72.75, 51.6, 8.5, 19.5], // COL_BAT_CS2_00
  [123.525, 7, -52.975, 32.95, 14, 16.55], // COL_BAT_E_MID1_00
  [129.55, 7.75, -9.9, 20.9, 15.5, 69.6], // COL_BAT_E_MID2_00
  [123.525, 7, 43.2, 32.95, 14, 36.6], // COL_BAT_E_MID3_00
  [0.125, 7.25, -115.9, 122.75, 14.5, 18.2], // COL_BAT_N_MID_00
  [-36.95, 2, -68.975, 48.6, 4, 28.55], // COL_BAT_P1_00
  [-55.475, 4.75, -43.95, 19.55, 9.5, 34.6], // COL_BAT_P3_00
  [133.5, 7.5, -93.125, 13, 15, 63.75], // COL_BAT_PE1_00
  [133.5, 7.5, 93.25, 13, 15, 63.5], // COL_BAT_PE3_00
  [-100.625, 8, -132.5, 78.75, 16, 15], // COL_BAT_PN1_00
  [0.125, 9, -132.5, 122.75, 18, 15], // COL_BAT_PN2_00
  [100.75, 8.25, -132.5, 78.5, 16.5, 15], // COL_BAT_PN3_00
  [-100.625, 8, 132.5, 78.75, 16, 15], // COL_BAT_PS1_00
  [-30.625, 6.75, 122.525, 61.25, 13.5, 34.95], // COL_BAT_PS2A_00
  [30.75, 7.5, 122.525, 61.5, 15, 34.95], // COL_BAT_PS2B_00
  [100.75, 8.25, 132.5, 78.5, 16.5, 15], // COL_BAT_PS3_00
  [-133.5, 7.5, -93.125, 13, 15, 63.75], // COL_BAT_PW1_00
  [-133.5, 7.5, 93.25, 13, 15, 63.5], // COL_BAT_PW3_00
  [35.7, 2, -68.975, 51.6, 4, 28.55], // COL_BAT_Q1_00
  [73.025, 5.25, -52.975, 23.05, 10.5, 16.55], // COL_BAT_Q3_00
  [53.75, 4.75, -43.95, 15.5, 9.5, 34.6], // COL_BAT_Q4_00
  [53.75, 4.5, 18.675, 15.5, 9, 45.65], // COL_BAT_R1_00
  [73.025, 5, 33.2, 23.05, 10, 16.6], // COL_BAT_R2_00
  [-74, 4, 51.75, 22.5, 8, 19.5], // COL_BAT_SB_00
  [-31.375, 3.3, 39.25, 37.45, 6.6, 4.5], // COL_BAT_T1_00
  [27.95, 3.3, 39.25, 36.1, 6.6, 4.5], // COL_BAT_T2_00
  [-64, 2.5, 37.5, 2.5, 5, 9], // COL_BAT_TW_00
  [-55.475, 4, 3.625, 19.55, 8, 15.55], // COL_BAT_WB_00
  [-123.375, 6.25, 40.45, 33.25, 12.5, 42.1], // COL_BAT_W_LOW_00
  [-113.375, 7, -20.925, 53.25, 14, 80.65], // COL_BAT_W_MID_00
  [-69.608, 1.2, 113.604, 4.816, 2.4, 4.992], // COL_COUV_Atelier_Caisses_00
  [-70.984, 0.6, 108.036, 7.568, 1.2, 3.072], // COL_COUV_Atelier_Caisses_01
  [-74.51, 0.65, 114.372, 2.58, 1.3, 3.456], // COL_COUV_Atelier_Caisses_02
  [-108.6, 0.5, 79.05, 16, 1, 3.3], // COL_COUV_Atelier_Etablis_00
  [-110.3, 1.91, 79.05, 3, 1.58, 2.7], // COL_COUV_Atelier_Etablis_01
  [-110.3, 3.05, 79.05, 1.4, 0.7, 1.5], // COL_COUV_Atelier_Etablis_02
  [-108.6, 0.5, 72.45, 16, 1, 3.3], // COL_COUV_Atelier_Etablis_03
  [-105.18, 1.91, 72.45, 3, 1.58, 2.7], // COL_COUV_Atelier_Etablis_04
  [-105.18, 3.05, 72.45, 1.4, 0.7, 1.5], // COL_COUV_Atelier_Etablis_05
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
  [-74, 1.3, -113.6, 8.9, 2.6, 8], // COL_COUV_Stock_Bloc_00
  [-113.812, 1.2, -87.77, 8.176, 2.4, 4.94], // COL_COUV_Stock_Caisses_00
  [-111.476, 0.6, -93.28, 12.848, 1.2, 3.04], // COL_COUV_Stock_Caisses_01
  [-105.49, 0.65, -87.01, 4.38, 1.3, 3.42], // COL_COUV_Stock_Caisses_02
  [-114, 2.1, -123, 14.2, 4.2, 1.8], // COL_COUV_Stock_Etageres_00
  [-96, 2.1, -123, 14.2, 4.2, 1.8], // COL_COUV_Stock_Etageres_01
  [90.148, 1.2, 107.256, 9.296, 2.4, 5.512], // COL_COUV_Transit_Caisses_00
  [92.804, 0.6, 113.404, 14.608, 1.2, 3.392], // COL_COUV_Transit_Caisses_01
  [99.61, 0.65, 106.408, 4.98, 1.3, 3.816], // COL_COUV_Transit_Caisses_02
  [115.8, 1.45, 77.75, 8, 2.9, 11.9], // COL_COUV_Transit_Guerite_00
  [115.8, 3.025, 77.75, 8.8, 0.25, 12.7], // COL_COUV_Transit_Guerite_01
  [20.65, 1.2, 58.85, 9.9, 2.4, 8.3], // COL_COUV_Traverse_Bloc_00
  [0.15, 3, -95.025, 67.9, 6, 23.55], // COL_GALERIE_Nord_00
  [-23.225, 6.25, -83.5, 21.15, 0.5, 0.5], // COL_GALERIE_Nord_01
  [22, 6.25, -83.5, 24.2, 0.5, 0.5], // COL_GALERIE_Nord_02
  [-45.7, 0.6, 24.2, 1, 1.2, 25.6], // COL_MURET_CourOuest_00
  [-102.6, 2.5, 61.5, 0.8, 5, 1.7], // COL_SALLE_Atelier_Cadres_00
  [-89.4, 2.5, 61.5, 0.8, 5, 1.7], // COL_SALLE_Atelier_Cadres_01
  [-96, 5.4, 61.5, 14, 0.8, 1.7], // COL_SALLE_Atelier_Cadres_02
  [-61.25, 2.5, 100.4, 1.7, 5, 0.8], // COL_SALLE_Atelier_Cadres_03
  [-61.25, 2.5, 87.2, 1.7, 5, 0.8], // COL_SALLE_Atelier_Cadres_04
  [-61.25, 5.4, 93.8, 1.7, 0.8, 14], // COL_SALLE_Atelier_Cadres_05
  [-115.3, 4, 61.5, 24.6, 8, 1.2], // COL_SALLE_Atelier_Murs_00
  [-96, 6.9, 61.5, 14, 2.2, 1.2], // COL_SALLE_Atelier_Murs_01
  [-74.825, 4, 61.5, 28.35, 8, 1.2], // COL_SALLE_Atelier_Murs_02
  [-94.125, 4, 125, 66.95, 8, 1.2], // COL_SALLE_Atelier_Murs_03
  [-127, 4, 93.25, 1.2, 8, 62.3], // COL_SALLE_Atelier_Murs_04
  [-61.25, 4, 112.6, 1.2, 8, 23.6], // COL_SALLE_Atelier_Murs_05
  [-61.25, 6.9, 93.8, 1.2, 2.2, 14], // COL_SALLE_Atelier_Murs_06
  [-61.25, 4, 74.45, 1.2, 8, 24.7], // COL_SALLE_Atelier_Murs_07
  [-105, 4, 87, 1.1, 8, 1.1], // COL_SALLE_Atelier_Murs_08
  [-83.5, 4, 87, 1.1, 8, 1.1], // COL_SALLE_Atelier_Murs_09
  [-105, 4, 105, 1.1, 8, 1.1], // COL_SALLE_Atelier_Murs_10
  [-83.5, 4, 105, 1.1, 8, 1.1], // COL_SALLE_Atelier_Murs_11
  [-94.125, 8.4, 93.25, 66.95, 0.8, 64.7], // COL_SALLE_Atelier_Toit_00
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
  [66.4, 2.5, 61.5, 0.8, 5, 1.7], // COL_SALLE_Transit_Cadres_00
  [79.6, 2.5, 61.5, 0.8, 5, 1.7], // COL_SALLE_Transit_Cadres_01
  [73, 5.4, 61.5, 14, 0.8, 1.7], // COL_SALLE_Transit_Cadres_02
  [89.2, 2.5, 61.5, 0.8, 5, 1.7], // COL_SALLE_Transit_Cadres_03
  [102.4, 2.5, 61.5, 0.8, 5, 1.7], // COL_SALLE_Transit_Cadres_04
  [95.8, 5.4, 61.5, 14, 0.8, 1.7], // COL_SALLE_Transit_Cadres_05
  [61.5, 2.5, 100.4, 1.7, 5, 0.8], // COL_SALLE_Transit_Cadres_06
  [61.5, 2.5, 87.2, 1.7, 5, 0.8], // COL_SALLE_Transit_Cadres_07
  [61.5, 5.4, 93.8, 1.7, 0.8, 14], // COL_SALLE_Transit_Cadres_08
  [63.45, 4, 61.5, 5.1, 8, 1.2], // COL_SALLE_Transit_Murs_00
  [73, 6.9, 61.5, 14, 2.2, 1.2], // COL_SALLE_Transit_Murs_01
  [84.4, 4, 61.5, 8.8, 8, 1.2], // COL_SALLE_Transit_Murs_02
  [95.8, 6.9, 61.5, 14, 2.2, 1.2], // COL_SALLE_Transit_Murs_03
  [115.2, 4, 61.5, 24.8, 8, 1.2], // COL_SALLE_Transit_Murs_04
  [94.25, 4, 125, 66.7, 8, 1.2], // COL_SALLE_Transit_Murs_05
  [61.5, 4, 112.6, 1.2, 8, 23.6], // COL_SALLE_Transit_Murs_06
  [61.5, 6.9, 93.8, 1.2, 2.2, 14], // COL_SALLE_Transit_Murs_07
  [61.5, 4, 74.45, 1.2, 8, 24.7], // COL_SALLE_Transit_Murs_08
  [127, 4, 93.25, 1.2, 8, 62.3], // COL_SALLE_Transit_Murs_09
  [83, 4, 82, 1.1, 8, 1.1], // COL_SALLE_Transit_Murs_10
  [104, 4, 82, 1.1, 8, 1.1], // COL_SALLE_Transit_Murs_11
  [83, 4, 98, 1.1, 8, 1.1], // COL_SALLE_Transit_Murs_12
  [104, 4, 98, 1.1, 8, 1.1], // COL_SALLE_Transit_Murs_13
  [94.25, 8.4, 93.25, 66.7, 0.8, 64.7], // COL_SALLE_Transit_Toit_00
  [0, -0.5, 0, 280, 1, 280], // COL_SOL_Neige_00
  [-12.25, 2.35, 39.25, 0.8, 4.7, 5], // COL_TRAVERSE_Cadres_00
  [9.5, 2.35, 39.25, 0.8, 4.7, 5], // COL_TRAVERSE_Cadres_01
  [-1.375, 5.1, 39.25, 22.55, 0.8, 5], // COL_TRAVERSE_Cadres_02
  [-12.25, 2.35, 62.3, 0.8, 4.7, 1.9], // COL_TRAVERSE_Cadres_03
  [9.5, 2.35, 62.3, 0.8, 4.7, 1.9], // COL_TRAVERSE_Cadres_04
  [-1.375, 5.1, 62.3, 22.55, 0.8, 1.9], // COL_TRAVERSE_Cadres_05
  [-49.4, 2.35, 62.6, 1.9, 4.7, 0.8], // COL_TRAVERSE_Cadres_06
  [-49.4, 2.35, 41.9, 1.9, 4.7, 0.8], // COL_TRAVERSE_Cadres_07
  [-49.4, 5.1, 52.25, 1.9, 0.8, 21.5], // COL_TRAVERSE_Cadres_08
  [83.85, 2.35, 61.1, 1.9, 4.7, 0.8], // COL_TRAVERSE_Cadres_09
  [83.85, 2.35, 41.9, 1.9, 4.7, 0.8], // COL_TRAVERSE_Cadres_10
  [83.85, 5.1, 51.5, 1.9, 0.8, 20], // COL_TRAVERSE_Cadres_11
  [-1.375, 5.9, 39.25, 22.55, 0.8, 4.5], // COL_TRAVERSE_Toit_01
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
  // ---- Solid convex hulls as AABBs (11) ----
  [112.1, 6.35, -105.5, 1.2, 3.9, 1.2], // COL_COUV_Chaufferie_Chaudiere_04 (hull AABB)
  [114.5, 5.5, -96.1, 1, 2.2, 1], // COL_COUV_Chaufferie_Chaudiere_05 (hull AABB)
  [120.45, 6.6, -96.1, 11.9, 1, 1], // COL_COUV_Chaufferie_Chaudiere_06 (hull AABB)
  [0.6, 1.45, -5.9, 16.6, 2.9, 15.6], // COL_COUV_CourCentrale_BlocCentral_00 (hull AABB)
  [-23.225, 6.95, -83.5, 20.75, 0.6, 0.2], // COL_GALERIE_GardeCorps_00 (hull AABB)
  [22, 6.95, -83.5, 23.8, 0.6, 0.2], // COL_GALERIE_GardeCorps_01 (hull AABB)
  [-41.15, 4.944, -83.6, 14.7, 4.313, 0.2], // COL_GALERIE_GardeCorps_02 (hull AABB)
  [41.4, 4.951, -83.6, 14.6, 4.297, 0.2], // COL_GALERIE_GardeCorps_03 (hull AABB)
  [-12.3, 4.948, -75.625, 0.2, 4.305, 15.25], // COL_GALERIE_GardeCorps_04 (hull AABB)
  [9.55, 4.948, -75.625, 0.2, 4.305, 15.25], // COL_GALERIE_GardeCorps_05 (hull AABB)
  [17.225, 5.8, 52.25, 134.65, 0.6, 21.5], // COL_TRAVERSE_Toit_00 (hull AABB)
];
