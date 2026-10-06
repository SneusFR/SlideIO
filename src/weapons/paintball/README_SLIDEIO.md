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

- `PAINTBALL_FIRE` (une bille, ≥ 0,1 s) : `sd` (seed uint32, sert à la forme de la tache), `sp` (cône de dispersion, **toujours 0** : aucune dispersion, le serveur ramène toute valeur reçue à 0), `pc` (couleur de la bille), aim arrondi au 1/1000. Le serveur valide munitions / cadence / recharge, reconstruit **le même rayon** (`paintballBallDirection`), fait **un hitscan** lag-compensé (**pas de portée maximale** : premier mur / joueur ou limites de la carte, comme la langue du Hex Sniper ; le pack prévoyait 45 m) et applique **tout de suite** 23 (corps) / 34,5 (tête, ×1,5). Les joueurs ont 200 PV (le pack prévoyait 12 / 18) : 9 billes au corps = 207 = un kill. Une seule constante à changer : `bodyDamage` dans `shared/combat/PaintballRifleRules.ts`.
- La confirmation porte `sd`, `sp`, `pc`, `am` (munitions), `hx/hy/hz` (point d'arrivée) et `tid` (victime). Les autres clients rejouent la bille visible depuis la vraie bouche du tireur, la tache sur le mur (même seed = même tache) ou la peinture sur la victime (raycast visuel sur son corps).
- Cadence serveur : une bille peut arriver jusqu'à 40 ms en avance (gigue) mais la dette ne se reporte jamais : en moyenne, jamais plus de 600 coups/min.
- `PAINTBALL_RELOAD` / `PAINTBALL_RELOAD_CANCEL` : horloge serveur, munitions au clic (1,52 s), tir à 2,10 s (tolérance 0,1 s). Changer d'arme ou mourir annule avant le clic.
- Mort : chaque client efface la peinture du joueur mort (`clearPaintUnder`) ; départ d'un joueur : `detach`.

## Jets de peinture élastiques (comportement hitscan)

- **Un jet de peinture liquide, étiré et élastique par tir** (`PaintJets.ts`), plus de bille en vol. Tout est purement visuel : les dégâts, les munitions, la cadence et le réseau restent le hitscan inchangé.
- **Couleurs** : rose, bleu, jaune (`PAINT_COLORS_SRGB` dans `PaintJetSettings.ts`, index = le `pc` du réseau). `loadPaintballRifleGltf` remplace la palette du réservoir par les mêmes valeurs : les billes du réservoir, la couleur du tir, le jet et la tache sont identiques. La couleur est fixée au tir et gardée jusqu'à l'impact.
- **Réglages centralisés** : tout est dans `PaintJetSettings.ts` (`PAINT_JET` : vitesse, longueur de repos / maximale, élasticité, amortissement, rayon, gouttelettes, cadence des gouttes…).
- **Forme** : un long jet liquide, **environ 24 cm d'épaisseur** (rayon `radius` 12,4 cm, soit 2,25 fois l'ancien 5,5 cm, deux fois ×1,5, pour une longueur inchangée), **3,5 à 5,3 fois plus long qu'épais**. Le nez est légèrement arrondi (`noseRound`), le corps s'affine progressivement jusqu'à une queue en pointe (profil `sin(u·π/2)^taper`). Il n'y a ni renflement de tête ni ondulations régulières. **Une seule géométrie partagée** et **une instance par jet**, avec un seul matériau, réutilisés à chaque tir. Le vertex shader façonne le jet : légère déformation élastique et asymétrique (la queue fine se balance latéralement, la section respire un peu en ovale), avec une phase propre à chaque tir. Le **volume est conservé** : plus le jet est étiré, plus il est fin. Chaque jet a sa propre graine (vitesse ±10 %, longueur de repos ±5 %, fréquence du ressort ±20 %, effilement ±20 %) : deux jets ne sont jamais identiques.
- **Né étiré, reste long** : dès la première image, le jet mesure déjà 1,2 m (`launchLength`, environ 5,3:1) et sa queue est au canon. Un ressort amorti (ζ = 0,6) le détend légèrement vers environ 1,06 m (environ 4,4:1) en ≈ 80 ms. Sa longueur est bornée entre `minLength` et `maxLength` : il ne se contracte **jamais** en boule, de l'apparition jusqu'à l'impact. **En vol, il reste élastique** : sa longueur de repos « respire » de ±4,5 % (`breathe`, environ 6 Hz, phase propre à chaque tir), donc le corps s'étire et s'amincit légèrement en continu. Le milieu du corps se cambre doucement d'un côté (`bow`) et un seul étranglement glisse du nez vers la queue (`neck`). La silhouette reste allongée, entre 4,3:1 et 4,8:1. Sous-pas fixe de 1/180 s avec accumulateur : identique à 20 ou 240 fps. **Durée de vol** : le jet parcourt **tout le trajet** muzzle → point d'impact calculé par le hitscan, en **80 ms maximum** quelle que soit la distance (`maxFlight` = 0,08 s dans `PaintJetSettings.ts`, le réglage à modifier ; il était de 0,31 s). Le temps est arrondi à un nombre entier de sous-pas de 1/180 s : 0,08 s donne 14 sous-pas, soit 77,8 ms. Au-dessus de ~8,5 m, le jet est donc plus rapide que `speed` (106,875 m/s, vitesse des tirs très proches, ±10 % par jet) : 20 m en 78 ms soit ~257 m/s, 400 m en 78 ms. À 2 m il met 34 ms, à 5 m 45 ms (`minFlight` = 2/60 s sert de plancher). La trajectoire reste droite sur le rayon du hitscan, sans aucun guidage vers les bots. Forme, couleurs et squishy sont inchangés. C'est **purement visuel** : les dégâts, le hitmarker, le son de touche et le flash du bot sont décidés au moment du tir par le hitscan. Seuls la tache et la peinture sur le joueur arrivent avec le jet (≤ 80 ms plus tard). La cadence et les impacts sont inchangés.
- **Lisible en FPS** : vu par le tireur, le jet part presque dans l'axe de la caméra, et un jet réel se réduirait à un point. Quand c'est le cas, l'axe dessiné pivote autour du nez, uniquement dans le plan (caméra, trajectoire), jusqu'à ce que le jet fasse au moins `minScreenAspect` (3,1:1, soit la même longueur à l'écran qu'avant pour un jet 2,25 fois plus large) à l'écran. Il reste exactement sur la ligne écran canon → viseur et ne recule jamais derrière la bouche. Au loin, il ne devient jamais plus fin que `minAngularRadius` et s'allonge d'autant (mêmes proportions, plafonné par `maxDrawLength`). Vu de profil, rien n'est modifié : c'est la vraie géométrie.
- **Aspect humide** : petit reflet net (`wetSpecular`), fin lustre sur le dessus (`wetSheen`) et fin liseré sombre sur la silhouette (`rimDark`, `rimWidth`).
- **Rafale** : à 600 coups/min, deux jets sont séparés d'environ 9 m : on voit des espaces entre les jets, pas un tuyau continu.
- **Collision** : la tête est plafonnée au point d'impact du hitscan (un à-coup de 500 ms ne peut pas la faire traverser) et l'impact n'est déclenché qu'une fois, à l'instant réel de la collision.
- **Impact : écrasement → étalement → trace** (peinture molle projetée fort, jamais un « tampon ») :
  1. **Le corps s'enfonce** (`impactDrain`, 35 ms) : le nez reste collé à la surface, le reste du jet continue d'arriver et rentre dedans, de plus en plus court et gros (jusqu'à ×1,6 en rayon).
  2. **La peinture s'écrase** : une galette (même mesh sphère que les gouttes, aucun nouvel objet) part d'une goutte bombée d'environ 7 × 4 cm. Elle s'aplatit violemment (épaisseur ∝ 1/r², volume conservé) et s'étale vite, avec l'essentiel en 25 ms. Elle **dépasse** sa taille d'environ 10 % puis se rétracte (`impactOvershoot`). Sur un tir rasant, elle est étirée et glisse vers l'avant le long de la surface (`impactSmear`). 5 gouttes partent latéralement.
  3. **La trace s'étale** : 20 ms après l'impact (`impactSplatAt`), la tache persistante apparaît **sous** la galette sous forme de petite flaque ronde. En 200 ms (`impactGrow`), elle s'étale jusqu'à sa forme finale : d'abord le cœur, puis les doigts qui poussent, puis les satellites qui atterrissent en s'éloignant. Pendant ce temps, la galette s'amincit et se fond dedans (fin à 220 ms, `impactLife`). Un seul flottant par tache est envoyé au GPU à chaque image (`aSpread`), et seulement pendant l'étalement.
  - La peinture sur un joueur est appliquée à l'instant exact de la collision.
- **Taches irrégulières** : même couleur que le tir, rotation et aspect issus de la graine du tir (identiques chez tous les clients, et identiques à ceux de la galette), taille variée de ±25 % (`splatSizeVariation`), contour qui change avec la graine (4 à 6 lobes, profondeur des lobes, 0 à 6 satellites).
- **Gouttelettes** : environ 7 par tir (contre 25 à 30 avant) : 2 minuscules à la bouche (3,5 à 8 mm, `dropRadius`), 0 à 2 arrachées par un jet très étiré, 5 à l'impact (≤ 2,2 cm, inchangées). Étirées selon leur vitesse, 0,1 à 0,3 s de vie, de la couleur du tir. Le jet reste largement dominant.
- **Recul de l'arme** : `ViewmodelSystem.kick()` pose, à chaque tir, une impulsion vers l'arrière (14 mm) rendue par un ressort critique : pic à 18 ms, retour à 5 % en ≈ 105 ms, sans rebond. L'impulsion **remplace** la vitesse du ressort au lieu de l'ajouter : une rafale répète exactement la même course (aucune accumulation). Intégration exacte, donc identique à tout framerate. Seul le groupe arme + bras bouge : la caméra de visée n'est jamais touchée. Réglages : `kickPeak`, `kickOmega`, `kickPitch` dans `PaintJetSettings.ts`.
- **Rendu** : opaque, saturé, légèrement brillant (rugosité 0,34). Pas de glow, de bloom ni de transparence : seulement un éclairage d'appoint pour que la couleur reste lisible sur une carte sombre. Jamais plus fin qu'environ 0,45° à l'écran (`minAngularRadius`), plafonné près de la caméra (`maxAngularRadius`). Ces deux limites ont été multipliées par 2,25, comme l'épaisseur.
- **Coût des jets** : une instance par jet (au plus 3 à 4 en vol par tireur en rafale), géométrie de 300 sommets, aucune allocation par image.
- **Départ** : le jet part de la bouche du canon en direct (FP : canon dessiné ; TP : vraie bouche du tireur distant) tant que sa queue le quitte (premiers centimètres) ; ensuite il vole librement le long de son rayon fixe.
- **Coût** : 3 draw calls pour tous les joueurs (jets, gouttes, taches), aucune allocation par image, rien n'est calculé quand aucun jet n'est en vol.
- **Précision laser** : aucune dispersion (0°, même en longue rafale) et **aucun tremblement de caméra** au tir. Chaque jet part exactement au centre du viseur, chez le tireur, sur le serveur et chez les autres joueurs. Le recul visuel de l'arme en main reste.
- **Touche ressentie tout de suite (multijoueur)** : quand le tir prédit touche un avatar distant (mêmes volumes que le serveur), l'indicateur de touche et le son partent **au clic**. La confirmation du serveur ajoute seulement le chiffre de dégâts (et le retour de kill).
- **Tir droit** : pendant le tir en FP, l'arme passe dans l'axe comme en visée (clips `_Straight`, voir `PaintballStraightFire.ts`).
- **Tir dans le vide** (ciel) : le jet file jusqu'au bout du rayon (`maxRange` = 400 m, ce n'est pas une portée de gameplay), sans tache ni éclaboussure.
- **Taches** (inchangées) : 0,96 m de base, peinture sur les joueurs 22,5 cm de rayon. Un tir qui tombe sur une tache existante la **fusionne sans la redessiner** (même forme, dernière couleur dessus, elle grossit un peu).
- **Revenir aux billes** : `PaintballBalls.ts` est toujours là. Il suffit de le réinstancier dans `PaintballFX.init` (`new PaintballBalls(ballTemplate.geometry, scene, splats)`).

## Limites connues

- Un joueur qui porte la **tenue astronaute** n'est pas peint (la tenue remplace la géométrie du corps) ; ses murs, eux, se tachent.
- Le joueur local ne se voit pas peint (pas de corps en FP).
- Les taches ne sont pas renvoyées aux joueurs qui rejoignent en cours de partie (optionnel dans le pack).

## Tests

- `npm run test:paintball` : règles vs référence du pack, parité client/serveur, profil / JSON, FP sur le vrai `ViewmodelSystem` (rafale auto, FireEnd, recharge, annulation), set TP sur le vrai perso, contrôleur TP, billes / taches / peinture.
- `cd backend && npm run test:weapons` : 6 tests serveur Paintball (23 / 34,5 immédiats, pas de portée max (joueur touché à 150 m, mur devant = bloqué), rayon = règle partagée, cadence + 32 billes, recharge / annulation / changement d'arme, seeds invalides).
