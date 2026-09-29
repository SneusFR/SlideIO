# FAMAS à eau — intégration SlideIO

Doc technique du pack : `INTEGRATION.md` (même dossier). Prompt d'origine, pipeline de création et rendus : `tools/waterfamas/`.

## Fichiers

| Rôle | Fichier |
|---|---|
| Profil (`WeaponViewProfile`, TP aim, timeline) | `src/weapons/profiles/WaterFamasProfile.ts` |
| Assets | `src/assets/potato/WaterFamas_*.glb`, `WeaponProfile_WaterFamas.json` (perso TP : celui du Popcorn Shotgun, inchangé) |
| Pack (types ajoutés, logique inchangée) | `WaterFamasController.ts`, `WaterTank.ts`, `WaterJets.ts`, `WetMarks.ts`, `WaterFamasGameplay.ts` (référence, non utilisée au runtime) |
| Cache GLB FP/TP | `WaterFamasModel.ts` |
| Jets + traces + joueurs mouillés (1 instance) | `WaterFamasFX.ts` |
| Arme locale (FP + gameplay solo + prédiction réseau) | `WaterFamasWeapon.ts` |
| Règles partagées client/serveur | `shared/combat/WaterFamasRules.ts` |
| Autorité serveur | `backend/src/weapons/WaterFamasServer.ts` (+ `WeaponManager.ts`) |
| TP distant | `RemoteWeaponController.ts` (attach), `RemotePlayerManager.ts`, `Game.ts` (`handleRemoteWaterFamasAction`), `PotatoCharacter.ts` (set de poses) |
| HUD | `src/ui/WaterFamasHUD.ts` |
| Sons | `GameAudio.ts` (`famas*`) — aucun nouvel asset, voir « Sons » |

## Gameplay

- **Une rafale par appui** (front montant du clic gauche, jamais de tir auto en maintenant) : 3 jets à 0 / 0,075 / 0,15 s, 0,45 s minimum entre deux rafales, 9 jets = 3 rafales.
- **Chaque jet = un hitscan** depuis la caméra de jeu, lancé quand le jet part (`onJet`), **sans portée maximale** (premier mur / joueur ou limites de la carte, rayon de 400 m comme le Paintball ; le pack prévoyait 28 m), dispersion 0,35° / 0,8° / 1,25° (×0,55 en visée), sans atténuation.
- **Dégâts : 23 au corps, 34,5 à la tête (×1,5).** Les joueurs ont 200 PV (le pack en supposait 100) : une rafale = 69, un réservoir plein = 207, donc un kill seulement si les 9 jets touchent le corps (8 suffisent avec une tête). Une seule constante à changer : `bodyDamage` dans `shared/combat/WaterFamasRules.ts`.
- Recharge au bouchon 3,3 s : munitions pleines à 1,98 s, tir possible à 2,95 s. Changer d'arme / mourir avant 1,98 s annule (munitions gardées).

## Réseau

- `WATER_FAMAS_FIRE` = **un message par jet**, envoyé quand le jet part : `sd` (seed du jet = `waterFamasJetSeed(seedRafale, k)`), `pi` (numéro du jet 0..2), `pc` (1 = rafale tirée en visée), aim arrondi au 1/1000 comme le Paintball.
- Le serveur valide (arme équipée, seed et `pi` valides, munitions, ≥ 0,45 s entre les débuts de rafale, jets 1 et 2 dans l'ordre à 0,075 / 0,15 s avec la tolérance de gigue, porte de recharge), reconstruit **le même rayon** (`waterFamasJetDirection`), fait **un hitscan lag-compensé** et applique les dégâts tout de suite.
- La confirmation (à tous) porte `sd`, `pi`, `pc`, `am` (munitions), `hx/hy/hz` (point d'arrivée), `tid` (victime éventuelle) et **dx/dy/dz = la direction FINALE du jet** (dispersion appliquée) : les clients la reprennent telle quelle.
- `WATER_FAMAS_RELOAD` / `WATER_FAMAS_RELOAD_CANCEL` : horloge serveur (1,98 s / 2,95 s, tolérance 0,1 s).
- Hitmarker + son de touche **au jet** (prédiction avec les mêmes volumes que le serveur) ; `HIT_CONFIRMED` n'ajoute que le chiffre de dégâts (et le retour de kill).
- Mort / respawn : chaque client sèche le joueur (`dryUnder`), réservoir plein ; départ d'un joueur : `detach`.

## Visuels

- **Vitesse du jet visible : 120 m/s** (le pack : 30 m/s, doublée deux fois), réglage `jetSpeed` dans `WaterFamasRules.ts`. C'est purement visuel : les dégâts restent instantanés. La courbe de gravité du jet est plafonnée à 0,35 m (sans limite de portée, elle ferait sinon une grande arche sur un tir lointain alors que le hitscan est une ligne droite).
- 3 objets pour toute la partie (paquets d'eau, gouttes, traces mouillées) ; réservoir : 2 draw calls par FAMAS visible.
- Le jet visible part du canon dessiné (FP : `socketWorldForGameCamera`, TP : `muzzle` du joueur distant), relu à chaque frame pendant que l'eau sort. **`join` n'est jamais utilisé** (il fusionnerait les 3 jets).
- Traces sur le décor statique seulement (même seed = même trace chez tous), sèchent en ~6 s. Joueurs mouillés par sommet, secs en ~10 s.
- Limite : un joueur en tenue astronaute n'a pas de trace de mouillé (son corps est remplacé par une géométrie masquée).

## Sons

Aucun sample dédié n'a été ajouté (recherche Freesound CC0 « water squirt » sans résultat) : `famasJet` réutilise le « pfft » d'air du Paintball, monté en hauteur et raccourci ; clics et bulles réutilisent les sons existants (Popcorn / UI). À remplacer par de vrais sons d'eau quand ils seront choisis (uniquement dans `GameAudio.ts`).

## Tests

- `npm run test:famas` : règles vs référence du pack, parité client/serveur, profil / JSON, FP sur le vrai `ViewmodelSystem` (rafale, cadence, recharge, annulation), jets / traces / mouillé, set TP sur le vrai perso, contrôleur TP.
- `cd backend && npm run test:famas` : 9 tests serveur (24 / 36 immédiats, portée 28 m, mur, seed → même rayon, cadence, ordre des jets, 9 jets, recharge / annulation, seeds invalides, respawn).
