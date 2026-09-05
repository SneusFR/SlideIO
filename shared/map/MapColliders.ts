/**
 * SHARED map collision descriptors — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from src/assets/MAP/ancient_jungle_city.physics.json
 * by scripts/generate-map-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * One box = [x, y, z, sx, sy, sz] (center + FULL sizes). The frontend
 * builds its Rapier world from the exact physics JSON (cuboids + convex
 * hulls, see src/world/JungleMap.ts); the backend raycasts THIS list so
 * walls occlude shots.
 *
 * NOTE: the 12 convex-hull stair ramps are approximated here by
 * 6 stacked step slabs each — close enough for bullet occlusion.
 */
export type ColliderBox = [number, number, number, number, number, number];

export const MAP_COLLIDER_BOXES: ColliderBox[] = [
  // ---- Fixed cuboids (111) ----
  [0, -2.3, 0, 120, 1.6, 120], // Foundation
  [0, -0.77, 59, 120, 1.5, 2], // Ground slab 01
  [-40, -0.77, 55, 40, 1.5, 6], // Ground slab 02
  [40, -0.77, 55, 40, 1.5, 6], // Ground slab 03
  [-46, -0.77, 48, 28, 1.5, 8], // Ground slab 04
  [46, -0.77, 48, 28, 1.5, 8], // Ground slab 05
  [-40, -0.77, 39, 40, 1.5, 10], // Ground slab 06
  [40, -0.77, 39, 40, 1.5, 10], // Ground slab 07
  [-35, -0.77, 28, 50, 1.5, 12], // Ground slab 08
  [35, -0.77, 28, 50, 1.5, 12], // Ground slab 09
  [0, -0.77, -19, 120, 1.5, 82], // Ground slab 10
  [-40, 0.68, -26, 24, 1.64, 24], // Golden Lane raised walk
  [40, 1.43, -18, 24, 3.14, 12], // East Ridge south deck
  [40, 1.43, -34.25, 24, 3.14, 11.5], // East Ridge north deck
  [0, 1.43, -51, 44, 3.14, 14], // Sun Gate dais
  [-21, 2.9, -25, 14, 5.8, 22], // West sun ruins core
  [20, 3.4, -25, 12, 6.8, 22], // East sun ruins core
  [-22, 2.4, 25, 14, 4.8, 22], // West root ruins core
  [20, 2.7, 25, 12, 5.4, 22], // East terrace ruins core
  [0, 4, 61, 124, 12, 2], // Boundary south
  [0, 4, -61, 124, 12, 2], // Boundary north
  [-61, 4, 0, 2, 12, 120], // Boundary west
  [61, 4, 0, 2, 12, 120], // Boundary east
  [-9.3, 9, -52, 2.8, 12, 3.7], // Sun Gate | Great Solar Arch pier -1
  [9.3, 9, -52, 2.8, 12, 3.7], // Sun Gate | Great Solar Arch pier 1
  [0, 16, -52, 20.5, 2.5, 3.75], // Sun Gate | Great Solar Arch lintel
  [-16.5, 8.5, -56, 8.1, 11, 3.1], // Sun Gate wing
  [-18, 8, -45.8, 2.73, 10.1, 2.73], // Sun Gate obelisk
  [16.5, 8.5, -56, 8.1, 11, 3.1], // Sun Gate wing
  [18, 8, -45.8, 2.73, 10.1, 2.73], // Sun Gate obelisk
  [-46.3, 4, -10, 2.8, 6, 2.7], // Golden Lane entry pier -1
  [-33.7, 4, -10, 2.8, 6, 2.7], // Golden Lane entry pier 1
  [-40, 8, -10, 14.5, 2.5, 2.75], // Golden Lane entry lintel
  [33.7, 5.75, -10, 2.8, 6.5, 2.7], // East Ridge entry pier -1
  [46.3, 5.75, -10, 2.8, 6.5, 2.7], // East Ridge entry pier 1
  [40, 10, -10, 14.5, 2.5, 2.75], // East Ridge entry lintel
  [-47.3, 2.5, 10, 2.8, 5, 2.5], // Ruin Walk entry pier -1
  [-34.7, 2.5, 10, 2.8, 5, 2.5], // Ruin Walk entry pier 1
  [-41, 6, 10, 14.5, 2.5, 2.55], // Ruin Walk entry lintel
  [33.7, 3.75, 10, 2.8, 5, 2.5], // Terrace Path entry pier -1
  [46.3, 3.75, 10, 2.8, 5, 2.5], // Terrace Path entry pier 1
  [40, 7.25, 10, 14.5, 2.5, 2.55], // Terrace Path entry lintel
  [-10, 2.25, 9, 2.34, 4.6, 2.34], // Crossing square pillar
  [10, 2.25, 9, 2.34, 4.6, 2.34], // Crossing square pillar
  [-10, 2.25, -9, 2.34, 4.6, 2.34], // Crossing square pillar
  [10, 2.25, -9, 2.34, 4.6, 2.34], // Crossing square pillar
  [-7, 0.587, 4, 2.2, 1.175, 2.2], // Crossing relic 00
  [7, 0.587, -4, 2.2, 1.175, 2.2], // Crossing relic 01
  [-7, 0.587, -5, 2.2, 1.175, 2.2], // Crossing relic 02
  [7, 0.587, 5, 2.2, 1.175, 2.2], // Crossing relic 03
  [-15, 1.113, 0, 2.2, 2.225, 2.2], // Crossing relic 04
  [15, 1.113, 0, 2.2, 2.225, 2.2], // Crossing relic 05
  [-22, 1.35, 0, 3.1, 2.7, 5.1], // Crossing cover wall
  [22, 1.35, 0, 3.1, 2.7, 5.1], // Crossing cover wall
  [-4, 0.575, -14, 7.1, 1.15, 1.2], // Crossing cover wall
  [4, 0.575, 14, 7.1, 1.15, 1.2], // Crossing cover wall
  [-48, 2.537, -19, 2.2, 2.075, 2.2], // 02 Golden Lane relic 0
  [-32, 2.088, -32, 2.2, 1.175, 2.2], // 02 Golden Lane relic 1
  [-47, 2.537, -36, 2.2, 2.075, 2.2], // 02 Golden Lane relic 2
  [32, 4.037, -16, 2.2, 2.075, 2.2], // 03 East Ridge relic 0
  [48, 3.588, -35, 2.2, 1.175, 2.2], // 03 East Ridge relic 1
  [32, 2.537, 18, 2.2, 2.075, 2.2], // 04 Terrace Path relic 0
  [48, 2.088, 33, 2.2, 1.175, 2.2], // 04 Terrace Path relic 1
  [-34, 1.037, 20, 2.2, 2.075, 2.2], // 05 Ruin Walk relic 0
  [-48, 0.587, 35, 2.2, 1.175, 2.2], // 05 Ruin Walk relic 1
  [-34, 1.037, 40, 2.2, 2.075, 2.2], // 05 Ruin Walk relic 2
  [-13, -0.463, 52, 2.2, 2.075, 2.2], // 07 Lower Court relic 0
  [13, -0.913, 43, 2.2, 1.175, 2.2], // 07 Lower Court relic 1
  [-13, -0.463, 39, 2.2, 2.075, 2.2], // 07 Lower Court relic 2
  [13, -0.913, 54, 2.2, 1.175, 2.2], // 07 Lower Court relic 3
  [-34, 2.075, -24, 7.1, 1.15, 1.2], // Lane parapet
  [-47, 2.075, -31, 7.1, 1.15, 1.2], // Lane parapet
  [47, 3.575, -18, 6.1, 1.15, 1.2], // Lane parapet
  [32, 3.575, -34, 5.1, 1.15, 1.2], // Lane parapet
  [33, 2.075, 30, 6.1, 1.15, 1.2], // Lane parapet
  [47, 2.075, 21, 6.1, 1.15, 1.2], // Lane parapet
  [-36, 1.35, 29, 7.1, 2.7, 1.4], // Lane parapet
  [-49, 0.575, 22, 6.1, 1.15, 1.4], // Lane parapet
  [-8, -0.925, 56, 6.1, 1.15, 1.2], // Lane parapet
  [8, -0.925, 37, 6.1, 1.15, 1.2], // Lane parapet
  [-32, 3.4, -17, 2.08, 3.9, 2.08], // Broken lane column
  [-48, 1.3, 27, 2.08, 2.7, 2.08], // Broken lane column
  [-33, 1.9, 34, 2.08, 3.9, 2.08], // Broken lane column
  [48, 3, 14, 2.08, 3.1, 2.08], // Broken lane column
  [32, 5, -39, 2.08, 4.1, 2.08], // Broken lane column
  [-17, 0.5, 36, 2.08, 4.1, 2.08], // Broken lane column
  [17, 0.5, 56, 2.08, 4.1, 2.08], // Broken lane column
  [-55.5, 0.095, 48, 6, 0.19, 5], // Canal slab bridge
  [56, 0.095, 48, 6, 0.19, 5], // Canal slab bridge
  [-55.5, 0.095, 8, 6, 0.19, 5], // Canal slab bridge
  [56, 0.095, 8, 6, 0.19, 5], // Canal slab bridge
  [-55.5, 0.095, -18, 6, 0.19, 5], // Canal slab bridge
  [56, 0.095, -18, 6, 0.19, 5], // Canal slab bridge
  [-55.5, 0.095, -42, 6, 0.19, 5], // Canal slab bridge
  [56, 0.095, -42, 6, 0.19, 5], // Canal slab bridge
  [-55.5, 0.24, -48, 4, 0.48, 3], // Western water guardian basin
  [-55.5, 3.8, -48.5, 3.4, 3.6, 1.9], // Western water guardian mask
  [56, 0.24, -47, 4, 0.48, 3], // Eastern water guardian basin
  [56, 3.8, -47.5, 3.4, 3.6, 1.9], // Eastern water guardian mask
  [-16.5, 3.24, -53.2, 4, 0.48, 3], // Sun Gate wall fountain basin
  [-16.5, 6.8, -53.7, 3.4, 3.6, 1.9], // Sun Gate wall fountain mask
  [16.5, 3.24, -53.2, 4, 0.48, 3], // Sun Gate wall fountain basin
  [16.5, 6.8, -53.7, 3.4, 3.6, 1.9], // Sun Gate wall fountain mask
  [-35, 1.45, 35, 3.8, 2.9, 3.2], // Ruin Walk guardian fragment
  [-49, 2.95, -24, 3.8, 2.9, 3.2], // Golden Lane guardian fragment
  [49, 4.45, -39, 3.8, 2.9, 3.2], // East Ridge guardian fragment
  [-12, 0.55, -14, 1.2, 1.1, 1.2], // Route brazier
  [12, 0.55, 14, 1.2, 1.1, 1.2], // Route brazier
  [-17, -0.95, 55, 1.2, 1.1, 1.2], // Route brazier
  [17, -0.95, 35, 1.2, 1.1, 1.2], // Route brazier
  [40, 0.68, 24, 24, 1.64, 24], // Terrace Path walk
  // ---- Stair ramps as step slabs (72) ----
  [0, -1.562, 33, 20, 0.375, 2.02], // Lower Court north stair (6 slabs)
  [0, -1.437, 31, 20, 0.625, 2.02],
  [0, -1.312, 29, 20, 0.875, 2.02],
  [0, -1.187, 27, 20, 1.125, 2.02],
  [0, -1.062, 25, 20, 1.375, 2.02],
  [0, -0.937, 23, 20, 1.625, 2.02],
  [-21, -1.562, 48, 2.02, 0.375, 8], // Lower Court west stair (6 slabs)
  [-23, -1.437, 48, 2.02, 0.625, 8],
  [-25, -1.312, 48, 2.02, 0.875, 8],
  [-27, -1.187, 48, 2.02, 1.125, 8],
  [-29, -1.062, 48, 2.02, 1.375, 8],
  [-31, -0.937, 48, 2.02, 1.625, 8],
  [21, -1.562, 48, 2.02, 0.375, 8], // Lower Court east stair (6 slabs)
  [23, -1.437, 48, 2.02, 0.625, 8],
  [25, -1.312, 48, 2.02, 0.875, 8],
  [27, -1.187, 48, 2.02, 1.125, 8],
  [29, -1.062, 48, 2.02, 1.375, 8],
  [31, -0.937, 48, 2.02, 1.625, 8],
  [-40, -0.062, -3, 24, 0.375, 2.02], // Golden Lane south stair (6 slabs)
  [-40, 0.063, -5, 24, 0.625, 2.02],
  [-40, 0.188, -7, 24, 0.875, 2.02],
  [-40, 0.313, -9, 24, 1.125, 2.02],
  [-40, 0.438, -11, 24, 1.375, 2.02],
  [-40, 0.563, -13, 24, 1.625, 2.02],
  [-40, -0.062, -49, 24, 0.375, 2.02], // Golden Lane north stair (6 slabs)
  [-40, 0.063, -47, 24, 0.625, 2.02],
  [-40, 0.188, -45, 24, 0.875, 2.02],
  [-40, 0.313, -43, 24, 1.125, 2.02],
  [-40, 0.438, -41, 24, 1.375, 2.02],
  [-40, 0.563, -39, 24, 1.625, 2.02],
  [40, 0, -1, 24, 0.5, 2.02], // East Ridge south stair (6 slabs)
  [40, 0.25, -3, 24, 1, 2.02],
  [40, 0.5, -5, 24, 1.5, 2.02],
  [40, 0.75, -7, 24, 2, 2.02],
  [40, 1, -9, 24, 2.5, 2.02],
  [40, 1.25, -11, 24, 3, 2.02],
  [40, 0, -51, 24, 0.5, 2.02], // East Ridge north stair (6 slabs)
  [40, 0.25, -49, 24, 1, 2.02],
  [40, 0.5, -47, 24, 1.5, 2.02],
  [40, 0.75, -45, 24, 2, 2.02],
  [40, 1, -43, 24, 2.5, 2.02],
  [40, 1.25, -41, 24, 3, 2.02],
  [40, -0.062, 1, 24, 0.375, 2.02], // Terrace Path north stair (6 slabs)
  [40, 0.063, 3, 24, 0.625, 2.02],
  [40, 0.188, 5, 24, 0.875, 2.02],
  [40, 0.313, 7, 24, 1.125, 2.02],
  [40, 0.438, 9, 24, 1.375, 2.02],
  [40, 0.563, 11, 24, 1.625, 2.02],
  [0, 0, -33, 20, 0.5, 2.02], // Sun Gate ceremonial stairs (6 slabs)
  [0, 0.25, -35, 20, 1, 2.02],
  [0, 0.5, -37, 20, 1.5, 2.02],
  [0, 0.75, -39, 20, 2, 2.02],
  [0, 1, -41, 20, 2.5, 2.02],
  [0, 1.25, -43, 20, 3, 2.02],
  [40, -0.062, 43.333, 24, 0.375, 1.353], // Terrace Path south stair (6 slabs)
  [40, 0.063, 42, 24, 0.625, 1.353],
  [40, 0.188, 40.667, 24, 0.875, 1.353],
  [40, 0.313, 39.333, 24, 1.125, 1.353],
  [40, 0.438, 38, 24, 1.375, 1.353],
  [40, 0.563, 36.667, 24, 1.625, 1.353],
  [-33, 0, -55, 2.02, 0.5, 6], // Sun Gate west flank stair (6 slabs)
  [-31, 0.25, -55, 2.02, 1, 6],
  [-29, 0.5, -55, 2.02, 1.5, 6],
  [-27, 0.75, -55, 2.02, 2, 6],
  [-25, 1, -55, 2.02, 2.5, 6],
  [-23, 1.25, -55, 2.02, 3, 6],
  [33, 0, -55, 2.02, 0.5, 6], // Sun Gate east flank stair (6 slabs)
  [31, 0.25, -55, 2.02, 1, 6],
  [29, 0.5, -55, 2.02, 1.5, 6],
  [27, 0.75, -55, 2.02, 2, 6],
  [25, 1, -55, 2.02, 2.5, 6],
  [23, 1.25, -55, 2.02, 3, 6],
];
