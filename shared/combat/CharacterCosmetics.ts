/**
 * SHARED character cosmetic contract — pure TypeScript DATA only.
 *
 * Imported by BOTH the frontend (Vite) and the backend (Node/Colyseus).
 * MUST NEVER import Three.js, DOM, Rapier or Colyseus code.
 *
 * A character cosmetic is a COSMETIC identifier per outfit slot, strictly
 * distinct from the weapon skin (`NetworkPlayer.skin`, WeaponSkins.ts) and
 * from any gameplay state: it never changes hitboxes, collisions, speed,
 * size, damage or animation clocks. The server only VALIDATES the
 * selection (known slots, whitelisted ids, bounded size) and replicates a
 * compact encoded string so every client — late joiners included — dresses
 * the same avatar. Asset paths / URLs are NEVER part of this contract.
 */

/** Outfit slots of the character (fixed order — also the encoding order). */
export const CHARACTER_COSMETIC_SLOTS = ["hats", "bags", "tops", "pants", "shoes"] as const;
export type CharacterCosmeticSlot = (typeof CHARACTER_COSMETIC_SLOTS)[number];

/** Every cosmetic id accepted per slot (an absent slot = base appearance). */
export const CHARACTER_COSMETIC_IDS: Record<CharacterCosmeticSlot, readonly string[]> = {
  hats: ["astronaut_helmet"],
  bags: ["astronaut_backpack"],
  tops: ["astronaut_top"],
  pants: ["astronaut_pants"],
  shoes: ["astronaut_shoes"],
};

/** Equipped cosmetic id per slot — a missing slot means "base appearance". */
export type CharacterCosmeticsSelection = Partial<Record<CharacterCosmeticSlot, string>>;

/** Hard cap of the encoded replicated string (5 × "slot:id" + separators). */
export const CHARACTER_COSMETICS_MAX_ENCODED_LENGTH = 160;
/** Hard cap of one cosmetic id (refuses oversized junk before any lookup). */
const MAX_ID_LENGTH = 32;

export function isCharacterCosmeticSlot(slot: unknown): slot is CharacterCosmeticSlot {
  return typeof slot === "string" && (CHARACTER_COSMETIC_SLOTS as readonly string[]).includes(slot);
}

/** True when `id` is a whitelisted cosmetic for `slot`. */
export function isCharacterCosmeticId(slot: CharacterCosmeticSlot, id: unknown): id is string {
  return typeof id === "string" && id.length <= MAX_ID_LENGTH && CHARACTER_COSMETIC_IDS[slot].includes(id);
}

/**
 * STRICT validation of an untrusted selection object (network message):
 * returns null when the structure is not a plain object, carries an unknown
 * slot, an unknown id, a non-string value or too many keys. Empty-string /
 * null / undefined values mean "slot cleared" and are accepted.
 */
export function validateCharacterCosmetics(raw: unknown): CharacterCosmeticsSelection | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length > CHARACTER_COSMETIC_SLOTS.length) return null;
  const out: CharacterCosmeticsSelection = {};
  for (const key of keys) {
    if (!isCharacterCosmeticSlot(key)) return null;
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === "") continue;
    if (!isCharacterCosmeticId(key, value)) return null;
    out[key] = value;
  }
  return out;
}

/**
 * LENIENT sanitizing (persisted / replicated data): unknown slots and ids
 * are dropped, valid entries are kept. Never throws.
 */
export function sanitizeCharacterCosmetics(raw: unknown): CharacterCosmeticsSelection {
  const out: CharacterCosmeticsSelection = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const slot of CHARACTER_COSMETIC_SLOTS) {
    const value = (raw as Record<string, unknown>)[slot];
    if (isCharacterCosmeticId(slot, value)) out[slot] = value;
  }
  return out;
}

/**
 * Canonical compact encoding replicated through the room state:
 * `hats:astronaut_helmet,tops:astronaut_top` (fixed slot order, empty
 * string when nothing is equipped). Deterministic → cheap change detection.
 */
export function encodeCharacterCosmetics(selection: CharacterCosmeticsSelection): string {
  const parts: string[] = [];
  for (const slot of CHARACTER_COSMETIC_SLOTS) {
    const id = selection[slot];
    if (isCharacterCosmeticId(slot, id)) parts.push(`${slot}:${id}`);
  }
  return parts.join(",");
}

/** Decode a replicated string (re-validated: junk falls back to the base look). */
export function decodeCharacterCosmetics(raw: unknown): CharacterCosmeticsSelection {
  const out: CharacterCosmeticsSelection = {};
  if (typeof raw !== "string" || raw.length === 0 || raw.length > CHARACTER_COSMETICS_MAX_ENCODED_LENGTH) return out;
  for (const part of raw.split(",")) {
    const sep = part.indexOf(":");
    if (sep <= 0) continue;
    const slot = part.slice(0, sep);
    const id = part.slice(sep + 1);
    if (isCharacterCosmeticSlot(slot) && isCharacterCosmeticId(slot, id)) out[slot] = id;
  }
  return out;
}

/** True when both selections equip the same ids on every slot. */
export function sameCharacterCosmetics(a: CharacterCosmeticsSelection, b: CharacterCosmeticsSelection): boolean {
  for (const slot of CHARACTER_COSMETIC_SLOTS) if ((a[slot] ?? "") !== (b[slot] ?? "")) return false;
  return true;
}
