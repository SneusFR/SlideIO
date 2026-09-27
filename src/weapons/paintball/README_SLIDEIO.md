# Paintball Rifle — intégration SlideIO

Doc technique du pack : `INTEGRATION.md` (même dossier). Prompt d'origine, pipeline et rendus : `tools/paintball/`.

## Fichiers

| Rôle | Fichier |
|---|---|
| Profil (`WeaponViewProfile`, TP aim, timeline) | `src/weapons/profiles/PaintballRifleProfile.ts` |
| Assets | `src/assets/potato/PaintballRifle_*.glb`, `WeaponProfile_PaintballRifle.json` (perso TP : celui du Popcorn Shotgun, inchangé) |
| Pack (inchangé) | `PaintballRifleController.ts`, `PaintballHopper.ts`, `PaintballHopperSim.ts`, `PaintballProjectiles.ts`, `PaintSplats.ts`, `PaintballSpread.ts` (référence, non utilisé au runtime) |
| Cache GLB FP/TP | `PaintballRifleModel.ts` |
| Billes / taches / peinture (1 instance) | `PaintballFX.ts` |
| Vraies billes en vol (remplace `PaintballProjectiles` du pack, gardé pour le type `PaintHit`) | `PaintballBalls.ts` |
| Arme locale (FP + gameplay solo + prédiction réseau) | `PaintballRifleWeapon.ts` |
| Règles partagées client/serveur | `shared/combat/PaintballRifleRules.ts` |
| Autorité serveur | `backend/src/weapons/PaintballRifleServer.ts` (+ `WeaponManager.ts`) |
| TP distant | `RemoteWeaponController.ts` (attach + replay), `RemotePlayerManager.ts` (peinture, bouche), `PotatoCharacter.ts` (set de poses) |
| HUD | `src/ui/PaintballRifleHUD.ts` |
| Sons | `GameAudio.ts` (`paintball*`), `public/assets/audio/paintball/` (CC0, voir `ATTRIBUTION.md`) |

## Réseau

- `PAINTBALL_FIRE` (une bille, ≥ 0,1 s) : `sd` (seed uint32), `sp` (cône de dispersion en degrés, quantifié au 1/1000), `pc` (couleur de la bille), aim arrondi au 1/1000. Le serveur valide munitions / cadence / recharge, reconstruit **le même rayon** (`paintballBallDirection`), fait **un hitscan** lag-compensé (portée 45 m) et applique **tout de suite** 12 (corps) / 18 (tête).
- La confirmation porte `sd`, `sp`, `pc`, `am` (munitions), `hx/hy/hz` (point d'arrivée) et `tid` (victime). Les autres clients rejouent la bille visible depuis la vraie bouche du tireur, la tache sur le mur (même seed = même tache) ou la peinture sur la victime (raycast visuel sur son corps).
- Cadence serveur : une bille peut arriver jusqu'à 40 ms en avance (gigue) mais la dette ne se reporte jamais : en moyenne, jamais plus de 600 coups/min.
- `PAINTBALL_RELOAD` / `PAINTBALL_RELOAD_CANCEL` : horloge serveur, munitions au clic (1,52 s), tir à 2,10 s (tolérance 0,1 s). Changer d'arme ou mourir annule avant le clic.
- Mort : chaque client efface la peinture du joueur mort (`clearPaintUnder`) ; départ d'un joueur : `detach`.

## Billes visibles (comportement hitscan)

- **La même bille que dans le réservoir** : géométrie `Ball_Template` (sphère à facettes), mêmes valeurs de matériau que `PaintballRifle_Ball` (brillant, rugosité 0,32, non métallique) et **couleur exacte de la palette** (celle de la bille partie du réservoir, identique à la tache). Chaque bille part avec une orientation aléatoire et tourne sur elle-même en vol (22 rad/s), comme les billes secouées dans le réservoir.
- **Lisible de nuit sans effet « plasma »** : pas d'auto-éclairage uniforme ni de halo. Une petite lumière intégrée (direction de la lumière principale de l'arme en main, part ambiante 45 % + lambert sur la facette) garde les facettes et le côté éclairé visibles même sur une carte sombre.
- **Taille** : 18 cm de diamètre, jamais plus petite qu'environ 0,4° à l'écran (une bille lointaine est agrandie), plafonnée près de la caméra.
- **Vitesse de traceur (400 m/s)** en **ligne droite** exacte sur le rayon du hitscan (pas d'arc), avec un temps de vol borné : **au moins 4 images**, **au plus 0,1 s** (45 m en 6 images). Départ en douceur (`easeIn` 2, même temps d'arrivée) et départ 1,15 rayon devant la bouche : sur un tir à 20 m, la bille se voit à 0 m → 1,3 m → 5 m → 11 m → impact. **On voit la sortie du canon.**
- **Traînée discrète** : un petit cône de 0,3 m, fin (0,45 × le rayon), peu opaque (0,4), couleur de la bille éclaircie. Elle indique la direction sans faire « comète » et n'est jamais plus longue que le trajet déjà parcouru.
- **Collées à l'arme** : pendant les 2 premières images, le départ de la trajectoire suit la **bouche du canon en direct** (FP : canon dessiné ; TP : vraie bouche du tireur distant). En pas chassés ou en glissade, la bille ne reste jamais « en arrière ». Ensuite, elle file sur le rayon tiré : tourner la caméra ne la courbe pas.
- **Tir droit** : pendant le tir en FP, l'arme passe dans l'axe comme en visée (clips `_Straight` dérivés de la pose Aim, voir `PaintballStraightFire.ts`).
- **Taches** : 0,96 m de base (3× le pack), peinture sur les joueurs 22,5 cm de rayon (3×).
- **Multijoueur** : la bille prédite du tireur s'arrête sur l'avatar distant touché (mêmes volumes que le serveur) au lieu de traverser jusqu'au mur.
- **Coût** : 3 draw calls pour tous les joueurs (billes, traînées, taches), 4 si le halo est activé.
- Réglages : `new PaintballBalls(geometry, scene, splats, { speed, radius, easeIn, glow, trailLength, halo, spin })` dans `PaintballFX.init` (`trailLength: 0` = pas de traînée, `halo: 1.25` = léger halo additif, `glow: 0` = éclairage de la scène seul), `MIN_FLIGHT` / `MAX_FLIGHT` / `PAINT_RADIUS` / `BALL_ROUGHNESS` dans `PaintballBalls.ts`, `SPLAT_SIZE` dans `PaintballFX.ts`.

## Limites connues

- Un joueur qui porte la **tenue astronaute** n'est pas peint (la tenue remplace la géométrie du corps) ; ses murs, eux, se tachent.
- Le joueur local ne se voit pas peint (pas de corps en FP).
- Les taches ne sont pas renvoyées aux joueurs qui rejoignent en cours de partie (optionnel dans le pack).

## Tests

- `npm run test:paintball` : règles vs référence du pack, parité client/serveur, profil / JSON, FP sur le vrai `ViewmodelSystem` (rafale auto, FireEnd, recharge, annulation), set TP sur le vrai perso, contrôleur TP, billes / taches / peinture.
- `cd backend && npm run test:weapons` : 5 tests serveur Paintball (12 / 18 immédiats, rayon = règle partagée, cadence + 32 billes, recharge / annulation / changement d'arme, seeds invalides).
