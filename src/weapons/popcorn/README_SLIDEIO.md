# Popcorn Shotgun — intégration SlideIO

Doc technique du pack : `INTEGRATION.md` (même dossier). Prompt d'origine et pipeline : `tools/popcorn/`.

## Fichiers

| Rôle | Fichier |
|---|---|
| Profil (`WeaponViewProfile`, TP aim, timeline) | `src/weapons/profiles/PopcornShotgunProfile.ts` |
| Assets | `src/assets/potato/PopcornShotgun_*.glb`, `WeaponProfile_PopcornShotgun.json`, `Potato_TP_Character.glb` (remplacé) |
| Pack (inchangé sauf 1 correctif) | `PopcornShotgunController.ts`, `PopcornTank.ts`*, `PopcornTankSim.ts`, `PopcornProjectiles.ts`, `PopcornSpread.ts` (référence, non utilisé au runtime) |
| Cache GLB FP/TP | `PopcornShotgunModel.ts` |
| Arme locale (FP + gameplay solo + prédiction réseau) | `PopcornShotgunWeapon.ts` |
| Règles partagées client/serveur | `shared/combat/PopcornShotgunRules.ts` |
| Autorité serveur | `backend/src/weapons/PopcornShotgunServer.ts` (+ `WeaponManager.ts`) |
| TP distant | `RemoteWeaponController.ts` (attach + replay), `PotatoCharacter.ts` (set de poses) |
| HUD | `src/ui/PopcornShotgunHUD.ts` |

\* `PopcornTank.freeSlots` : les popcorns en cours d'aspiration (0,35 s après un tir) comptent comme libres. Sans ça, une recharge lancée juste après le 2e tir remplissait le réservoir à moitié (vu en TP distant).

## Réseau

- `POPCORN_FIRE` (+ `sd` = seed uint32) → le serveur valide munitions / cadence / recharge, recalcule les 12 plombs (seed + visée arrondie au 1/1000 comme sur le fil), additionne par victime, **un seul** `dealDamage` par victime. La confirmation porte `sd` et `am` (munitions restantes → FireLast en TP).
- `POPCORN_RELOAD` / `POPCORN_RELOAD_CANCEL` → horloge serveur : munitions à 1,75 s, tir à 2,06 s (tolérance 0,1 s de gigue).

## Tests

- `npm run test:popcorn` : règles vs référence du pack, tableau de distances, profil / JSON, FP sur le vrai `ViewmodelSystem`, set TP sur le vrai perso, contrôleur TP, pool de popcorns.
- `cd backend && npm run test:weapons` : 5 tests serveur Popcorn (one shot à bout portant, 1 seul événement de dégâts, tête, loin, munitions / cadence / recharge / annulation, seeds invalides).
