/**
 * Anatomical zone a damaging hit landed on. Resolved by the beam raycast
 * from `userData.hitZone` tags on the victim's meshes (default = BODY).
 */
export enum HitZone {
  BODY = "BODY",
  HEAD = "HEAD",
}