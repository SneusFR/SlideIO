# Lance-Frisbee — intégration SlideIO

Doc technique du pack : `INTEGRATION.md` (même dossier). Prompt d'origine, rendus et pipeline de création : `tools/frisbee/`.

## Fichiers

| Rôle | Fichier |
|---|---|
| Profil (`WeaponViewProfile`, TP aim, timeline) | `src/weapons/profiles/FrisbeeLauncherProfile.ts` |
| Assets | `src/assets/potato/FrisbeeLauncher_*.glb`, `WeaponProfile_FrisbeeLauncher.json` (perso TP : celui du Popcorn Shotgun, inchangé) |
| Pack (types ajoutés, logique inchangée) | `FrisbeeLauncherController.ts`, `FrisbeeProjectiles.ts` (`FrisbeeSim` + visuels), `DroppedCages.ts`, `FrisbeeLauncherGameplay.ts` (référence, non utilisée au runtime) |
| Cache GLB FP/TP | `FrisbeeLauncherModel.ts` |
| Arme locale (FP + gameplay solo + prédiction réseau + cages jetées) | `FrisbeeLauncherWeapon.ts` |
| Règles + simulation partagées client/serveur | `shared/combat/FrisbeeLauncherRules.ts`, `shared/combat/FrisbeeSim.ts` |
| Autorité serveur | `backend/src/weapons/FrisbeeLauncherServer.ts` (+ `WeaponManager.ts`) |
| TP distant | `RemoteWeaponController.ts` (attach + replay), `RemotePlayerManager.ts`, `RemoteCombatVFXController.ts`, `Game.ts` (`handleRemoteFrisbeeAction`), `PotatoCharacter.ts` (set de poses) |
| HUD | `src/ui/FrisbeeLauncherHUD.ts` (1 gros disque = le pont, 5 petits = la cage) |
| Sons | `GameAudio.ts` (`frisbee*`) + `public/assets/audio/frisbee/` (4 samples CC0, voir `ATTRIBUTION.md`) |

## Gameplay (validé)

- **Un disque par appui** (front montant, jamais de tir auto). Lancé depuis l'**œil** à 102 m/s (34 dans le pack, x3 : le joueur à pleine vitesse dépassait le disque), dispersion 0,6° (0,15° en visée). Le disque visible part du `LaunchSocket` de l'arme et rejoint la trajectoire en ~0,1 s.
- **Vrai projectile** : pas fixe **1/120 s**, plane, freine, rebondit 3 fois sur le décor, se pose, disparaît (3,5 s max). 24 disques max pour toute la partie.
- **Dégâts (100 PV) : 75 au corps, 100 à la tête (×100/75 : un disque à la tête tue), ×0,6 après un rebond sur un mur (45 / 60).** Aucun dégât sous 8 m/s ni après le budget de rebonds. **Une seule touche par disque.** 2 disques au corps = 150 (kill), 1 disque à la tête = kill.
- **Recul (knockback)** : 2,5 m/s horizontal dans le sens du disque + 0,8 m/s vers le haut, ajouté à la vitesse du joueur touché par le **mécanisme existant** (`host.sendImpulse` → `APPLY_IMPULSE` → `PlayerCombatant.applyImpulse`, comme le marteau / la lance / la morsure Hex). Pas de recul sur un kill (le ragdoll prend le relais). Constantes : `FrisbeeLauncherConfig.tuning` dans `shared/combat/FrisbeeLauncherRules.ts`.
- **Munitions** : pont (0/1) + cage (0..5) = 6. Après un tir, réarmement automatique (1,58 s), tir suivant à 1,50 s. Cage vide : `fireLast`, l'arme reste vide, clic à vide puis changement de cage automatique.
- **Recharge = changement de cage, x1,5 plus rapide** (`FrisbeeLauncherConfig.reloadSpeed`, partagé serveur + clients) : `reload` 1,40 s de clip = **0,93 s** réelles (pont chargé) ou `reloadEmpty` 2,48 s = **1,65 s** (pont vide = cage + réarmement). Cage pleine à 0,47 s. Le tir / réarmement après un coup garde sa vitesse d'origine. La cage vide est jetée : FP → copie sous la vue (`spawnAt`), TP → copie monde à la pose et vitesse exactes du nœud `Cage` (`spawn`).
- Changer d'arme / mourir : avant `cageIn` la cage d'avant est rendue ; après, la nouvelle cage reste (le disque déjà pris retourne dans la cage) ; un réarmement en cours est **terminé** (le disque est sur le pont). Respawn = pont chargé + cage pleine.

## Réseau

- `FRISBEE_FIRE` (`sd` = seed uint32, `pc` = 1 en visée, origine = œil, direction = visée arrondie au 1/1000) → le serveur valide arme équipée, seed, pont chargé, cadence / recharge, reconstruit **la même direction** (`frisbeeDirection`), crée un `SharedFrisbeeSim` à l'œil validé et le fait avancer à **120 pas/s** (dette de temps conservée, cibles lag-compensées avec le `viewTime` du tireur). La confirmation (à tous) porte `sd`, `pc`, `pid` (id serveur du disque), `am` (munitions), `cg` (disques dans la cage **au moment du tir** : le distant joue `fire` ou `fireLast`) et la direction finale.
- `FRISBEE_RELOAD` / `FRISBEE_RELOAD_CANCEL` : horloge serveur (timeline de clip / `reloadSpeed` : cage pleine 0,47 s, tir à 0,87 s / 1,60 s, tolérance 0,1 s). Confirmations avec `cg` / `dk` (pont chargé avant).
- Serveur → clients pendant le vol : `FRISBEE_BOUNCE` (rebond > 3 m/s, `bn` = numéro), `FRISBEE_HIT` (touche : `tid`), `FRISBEE_END` (fin de vie). Ils ne servent qu'à **recaler** la copie locale (même seed, même pas fixe) ; une copie qui colle déjà au serveur (0,15 m / 0,5 m/s) n'est pas touchée.
- Touche : `dealDamage` (un seul événement, hitmarker via `HIT_CONFIRMED`) + `sendImpulse` sur la victime. Le tireur mort ne fait plus de dégâts.
- Mort / respawn / départ : cage annulée, état remis à zéro ; les disques d'un joueur qui part sont retirés côté serveur.

## Sons

4 samples CC0 Freesound (twang, rotation de disque, déclic plastique, élastique) + sons existants (clic Popcorn, bruit de bille) : voir `public/assets/audio/ATTRIBUTION.md`. Uniquement dans `GameAudio.ts`.

## Tests

- `npm run test:frisbee` : règles vs référence du pack, **parité vol partagé / vol du pack** (position et vitesse identiques à chaque pas), touche 45 / 68 / 27-41, profil / JSON, FP sur le vrai `ViewmodelSystem` (tir + réarmement, `fireLast`, `reload`, `reloadEmpty`, annulation), set TP sur le vrai perso, contrôleur TP (cage jetée), pool de disques, cages au sol, loadout.
- `cd backend && npm run test:frisbee` : 10 tests serveur (dégâts, recul, tête, rebond / mur, kill, cadence, recharge, `reloadEmpty`, annulation, mort / respawn).
