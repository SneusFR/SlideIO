# Paintball Rifle — intégration SlideIO

Doc technique du pack : `INTEGRATION.md` (même dossier). Prompt d'origine, pipeline et rendus : `tools/paintball/`.

## Fichiers

| Rôle | Fichier |
|---|---|
| Profil (`WeaponViewProfile`, TP aim, timeline) | `src/weapons/profiles/PaintballRifleProfile.ts` |
| Assets | `src/assets/potato/PaintballRifle_*.glb`, `WeaponProfile_PaintballRifle.json` (perso TP : celui du Popcorn Shotgun, inchangé) |
| Pack (inchangé) | `PaintballRifleController.ts`, `PaintballHopper.ts`, `PaintballHopperSim.ts`, `PaintballProjectiles.ts`, `PaintSplats.ts`, `PaintballSpread.ts` (référence, non utilisé au runtime) |
| Cache GLB FP/TP | `PaintballRifleModel.ts` |
| Jets / taches / peinture (1 instance) | `PaintballFX.ts` |
| Jets de peinture en vol (remplace `PaintballProjectiles` du pack, gardé pour le type `PaintHit`) | `PaintJets.ts` |
| Ancienne bille en vol (plus utilisée, gardée pour revenir en arrière) | `PaintballBalls.ts` |
| Arme locale (FP + gameplay solo + prédiction réseau) | `PaintballRifleWeapon.ts` |
| Règles partagées client/serveur | `shared/combat/PaintballRifleRules.ts` |
| Autorité serveur | `backend/src/weapons/PaintballRifleServer.ts` (+ `WeaponManager.ts`) |
| TP distant | `RemoteWeaponController.ts` (attach + replay), `RemotePlayerManager.ts` (peinture, bouche), `PotatoCharacter.ts` (set de poses) |
| HUD | `src/ui/PaintballRifleHUD.ts` |
| Sons | `GameAudio.ts` (`paintball*`), `public/assets/audio/paintball/` (CC0, voir `ATTRIBUTION.md`) |

## Réseau

- `PAINTBALL_FIRE` (une bille, ≥ 0,1 s) : `sd` (seed uint32, sert à la forme de la tache), `sp` (cône de dispersion, **toujours 0** : aucune dispersion, le serveur ramène toute valeur reçue à 0), `pc` (couleur de la bille), aim arrondi au 1/1000. Le serveur valide munitions / cadence / recharge, reconstruit **le même rayon** (`paintballBallDirection`), fait **un hitscan** lag-compensé (**pas de portée maximale** : premier mur / joueur ou limites de la carte, comme la langue du Hex Sniper ; le pack prévoyait 45 m) et applique **tout de suite** 12 (corps) / 18 (tête).
- La confirmation porte `sd`, `sp`, `pc`, `am` (munitions), `hx/hy/hz` (point d'arrivée) et `tid` (victime). Les autres clients rejouent la bille visible depuis la vraie bouche du tireur, la tache sur le mur (même seed = même tache) ou la peinture sur la victime (raycast visuel sur son corps).
- Cadence serveur : une bille peut arriver jusqu'à 40 ms en avance (gigue) mais la dette ne se reporte jamais : en moyenne, jamais plus de 600 coups/min.
- `PAINTBALL_RELOAD` / `PAINTBALL_RELOAD_CANCEL` : horloge serveur, munitions au clic (1,52 s), tir à 2,10 s (tolérance 0,1 s). Changer d'arme ou mourir annule avant le clic.
- Mort : chaque client efface la peinture du joueur mort (`clearPaintUnder`) ; départ d'un joueur : `detach`.

## Jets de peinture visibles (comportement hitscan)

- **Un vrai jet de peinture liquide par tir** (`PaintJets.ts`), plus de bille en vol. Le jet est de la **couleur exacte de la palette**, celle de la bille partie du réservoir (identique à la tache). Tout est purement visuel : les dégâts restent le hitscan immédiat (client solo / serveur), rien ne change côté réseau.
- **Forme de liquide** : une chaîne de segments de tube instanciés dont le rayon est calculé dans le vertex shader. On a une goutte arrondie à l'avant, des ondulations qui avancent avec la peinture, un léger balancement, et une queue qui s'affine puis **se casse en perles** pendant que le jet se vide. Chaque jet a son propre seed, donc aucun jet n'est identique. La longueur des segments suit la distance à la caméra (même niveau de détail à l'écran), 96 segments max par jet.
- **Texture de peinture, entièrement procédurale** (aucune image) : relief de surface en bruit (traînées d'écoulement + petites bulles) qui **glisse avec la peinture**, variations de pigment (plus riche où c'est épais, plus clair où le film est fin), rugosité basse et variable (0,07–0,3) pour un rendu mouillé et brillant, reflet net et bord brillant. Une petite lumière intégrée (`glow` 0,2) garde le jet lisible sur une carte sombre. Le relief s'efface au loin (anti-aliasing), donc pas de scintillement. Le rendu est opaque, sans tri de transparence.
- **Timing** : l'avant du jet arrive à l'impact en **vitesse de traceur (700 m/s)**, en ligne droite exacte sur le rayon, avec **au moins 2 images** et **au plus 0,1 s** (même temps de vol que les anciennes billes). **La tache apparaît quasiment au clic.** Le jet reste accroché à la buse 50 ms, puis sa queue se vide dans l'impact en 0,14 s. À 600 coups/min les jets se chevauchent : en tir continu, ça fait un **jet pulsé continu**.
- **Impact** : une **couronne d'éclaboussures** (12 gouttes dans la couleur du jet, étirées selon leur vitesse, qui retombent avec la gravité), des petites gouttes tant que le jet se déverse, puis la tache persistante / la peinture sur le joueur comme avant (`PaintSplats`, même seed = même tache chez tout le monde). Les gouttes sont déterministes (pas de `Math.random` dans la boucle) et ne créent pas de taches.
- **Lisible à toute distance** : jamais plus fin qu'environ 0,2° à l'écran, plafonné près de la caméra (la vue FP n'est jamais bouchée). Les gouttes ont aussi une taille minimale à l'écran.
- **Précision laser** : aucune dispersion (0°, même en longue rafale) et **aucun tremblement de caméra** au tir. Chaque jet part exactement au centre du viseur, chez le tireur, sur le serveur et chez les autres joueurs. Le recul visuel de l'arme en main reste.
- **Touche ressentie tout de suite (multijoueur)** : quand le tir prédit touche un avatar distant (mêmes volumes que le serveur), l'indicateur de touche et le son partent **au clic**. La confirmation du serveur ajoute seulement le chiffre de dégâts (et le retour de kill).
- **Collé à l'arme** : pendant **toute la vie du jet** (≈ 0,19 s), son départ suit la **bouche du canon en direct** (FP : canon dessiné ; TP : vraie bouche du tireur distant), et le jet reste une ligne droite vers le point d'impact du hitscan (fixe). Courir, straffer ou tourner ne laisse plus jamais le jet à côté / derrière la caméra (avant : départ figé après 2 images → le point, à ~0,7 m devant l'œil, passait à côté de la tête et paraissait énorme). Un virage très rapide fait pivoter le jet autour de l'impact, comme une lance d'arrosage. Si l'arme disparaît (changement, mort, avatar caché), le jet garde son dernier point de départ.
- **Tir droit** : pendant le tir en FP, l'arme passe dans l'axe comme en visée (clips `_Straight`, voir `PaintballStraightFire.ts`).
- **Tir dans le vide** (ciel) : le jet file jusqu'au bout du rayon (`maxRange` = 400 m, ce n'est pas une portée de gameplay) et se vide sans tache ni éclaboussure.
- **Taches** (inchangées) : 0,96 m de base, peinture sur les joueurs 22,5 cm de rayon. Un tir qui tombe sur une tache existante la **fusionne sans la redessiner** (même forme, dernière couleur dessus, elle grossit un peu).
- **Coût** : 3 draw calls pour tous les joueurs (jets, gouttes, taches), aucune allocation par image, rien n'est calculé quand aucun jet n'est en vol. Seule la partie utilisée des buffers est envoyée au GPU. En rafale continue : environ 2 jets / 50 segments en vie par tireur.
- **Réglages** : `new PaintJets(scene, splats, { speed, radius, minAngularRadius, easeIn, glow, maxJets, maxSegments, maxDrops })` dans `PaintballFX.init`. Dans `PaintJets.ts` : `EMIT` / `DRAIN` (durée du jet), `HEAD_BULGE`, `FLOW`, `SPLASH_DROPS`, `MIN_FLIGHT` / `MAX_FLIGHT`, `PAINT_RADIUS`. `SPLAT_SIZE` est dans `PaintballFX.ts`.
- **Revenir aux billes** : `PaintballBalls.ts` est toujours là. Il suffit de le réinstancier dans `PaintballFX.init` (`new PaintballBalls(ballTemplate.geometry, scene, splats)`).


## Limites connues

- Un joueur qui porte la **tenue astronaute** n'est pas peint (la tenue remplace la géométrie du corps) ; ses murs, eux, se tachent.
- Le joueur local ne se voit pas peint (pas de corps en FP).
- Les taches ne sont pas renvoyées aux joueurs qui rejoignent en cours de partie (optionnel dans le pack).

## Tests

- `npm run test:paintball` : règles vs référence du pack, parité client/serveur, profil / JSON, FP sur le vrai `ViewmodelSystem` (rafale auto, FireEnd, recharge, annulation), set TP sur le vrai perso, contrôleur TP, billes / taches / peinture.
- `cd backend && npm run test:weapons` : 6 tests serveur Paintball (12 / 18 immédiats, pas de portée max (joueur touché à 150 m, mur devant = bloqué), rayon = règle partagée, cadence + 32 billes, recharge / annulation / changement d'arme, seeds invalides).
