# GoofyBasket — quatre skins sur le ballon existant

Textures et effets temps réel destinés à Three.js 0.185.1 / WebGL. Le pack réutilise le GoofyBasket original et son LOD1. Aucun nouveau GLB, aucune modification du personnage ou de ses animations.

| ID | Nom | Rareté | Apparence | Effets supplémentaires low / high |
|---|---|---|---|---|
| `mandarine` | Mandarine | Peu commun | Orange, rainures charbon | 0 / 0 appel |
| `street_pop` | Street Pop | Rare | Crème, corail, violet, bleu pétrole ; graphismes imprimés | 0 / 0 appel |
| `haute_tension` | Haute Tension | Epic | Circuits cyan sur fond bleu/violet ; arcs électriques | 1 / 2 appels |
| `eclipse_solaire` | Éclipse solaire | Légendaire | Roche noire, lave circulant dans les fractures, plasma solaire | 2 / 4 appels |

Ces nombres concernent uniquement les effets, hors ballon, ombres et scène. L’aura est un effet visuel attaché au ballon ; elle ne participe pas aux raycasts. Le niveau `icon` conserve les matériaux et omet les effets.

## Contenu à intégrer

- `runtime/GoofyBasketSkins.ts` : catalogue, chargement des cinq textures, application et entretien des instances.
- `runtime/BasketSkinFX.ts` : effets animés locaux, sans boucle autonome ni post-traitement global.
- `runtime/BasketLavaSurface.ts` : animation des zones chaudes dans les fissures solaires, intégrée au matériau du ballon sans appel de rendu supplémentaire.
- `assets/textures/*.png` : textures 1024 × 1024. Mandarine utilise seulement des couleurs de matériaux.
- `PROMPT_CLINE.md` : consignes d’intégration dans SlideIO.
- `apercus/` : captures du vrai modèle dans Three.js, pas des images conceptuelles.
- `CONTROLES.md` : périmètre de validation et limites.

Copier `runtime` et `assets` côte à côte dans un dossier de sources importé par Vite. Les URLs par défaut sont statiques et compatibles avec son traitement d’assets. L’import `.js` de BasketSkinFX dans le fichier TypeScript est destiné à la résolution TypeScript/Vite ; ne pas ajouter une deuxième copie de Three.js.

## Raccord minimal

```ts
import { loadGoofyBasketSkins } from './runtime/GoofyBasketSkins';

// Une seule fois pour la session ; partager cette promesse.
const skinLibrary = await loadGoofyBasketSkins();

// ballInstance est le clone local du ballon, pas le template chargé.
let skin = skinLibrary.apply(ballInstance, 'eclipse_solaire', {
  context: 'fp',
  quality: 'high',
  seed: 17,
});

// Dans la boucle déjà existante du jeu. Le ballon garde sa visibilité propre.
skin.update(elapsedSeconds, {
  charge: normalizedCharge,
  visible: isHeldBallVisible,
  effectsEnabled: true,
});

// Changer le skin remplace et nettoie automatiquement l'ancien handle.
skin = skinLibrary.apply(ballInstance, 'street_pop', { context: 'fp' });

// Retirer l'instance : restaurer ses matériaux avant son nettoyage habituel.
skin.dispose();

// À l'arrêt complet, une fois tous les utilisateurs terminés :
skinLibrary.dispose();
```

Les noms de variables liés au jeu dans cet exemple sont à adapter à son état réel. Le module ne décide pas des états d’attaque, de la visibilité du ballon ni du réseau. `visible:false` masque uniquement l’aura ; le propriétaire reste responsable du mesh tenu.

Pour un CDN ou une disposition différente, `loadGoofyBasketSkins({textureURLs: {...}})` accepte les cinq clés `streetColor`, `electricColor`, `electricEmission`, `solarColor`, `solarEmission`. Passer des URL d’assets, jamais un identifiant reçu directement du réseau.

## Matériaux, dimensions et rendu

Le GLB doit garder ses matériaux `Skin_Panels_A`, `Skin_Panels_B`, `Skin_Channels` et ses UV. Les cinq cartes couleur/émission sont en sRGB, `flipY=false`, répétition horizontale et bord vertical limité. Les rainures reçoivent un matériau distinct ; aucune carte ne remplace leur géométrie.

Le rayon des effets est calculé dans l’espace local de l’instance. Le rayon de la géométrie source est d’environ 0,125 ; la taille finale du jeu est héritée des transformations existantes, même si le ballon est momentanément masqué par une échelle nulle. Ne pas multiplier une seconde fois par l’échelle du personnage.

Les effets respectent la profondeur et le brouillard. Leurs géométries supplémentaires dessinent l’aura ; le modèle, sa silhouette physique et sa hitbox restent inchangés. Aucun bloom requis, aucun éclairage dynamique ajouté au niveau, aucun son ajouté. Le plasma solaire garde une couleur saturée via ses propres matériaux, sans modifier l’exposition du jeu.

La lave solaire reste animée même si l’aura est coupée. Le module principal met à jour son temps et sa charge ; il n’y a pas d’appel d’intégration supplémentaire. La roche et les UV restent fixes. Les fissures servent de masque à un déplacement des zones chaudes, avec une intensité accrue pendant la charge.

Les cartes sont partagées par la bibliothèque. Les matériaux et effets d’une instance lui appartiennent. Ne jamais appeler un nettoyage profond qui détruirait ces textures alors qu’une autre instance les utilise. Pour créer une nouvelle instance, cloner le template original puis appliquer son skin ; ne pas cloner un ballon déjà habillé.

Après `handle.dispose()`, les matériaux de base sont restaurés. Un clone du template partage toujours ces matériaux d’origine et sa géométrie : ne pas les détruire au retrait de ce clone. Seul leur propriétaire commun doit les libérer à la fin de leur utilisation.

## Réglage en jeu

`low` / `high` se choisit lors de `apply`. Pour changer de qualité, réappliquer le même skin et conserver le nouveau handle. `effectsEnabled` permet de couper l’aura sans recharger ni remplacer les matériaux. Les couleurs et motifs persistent en qualité basse. Les projectiles utilisent `low` par défaut, les autres vues `high` ; choisir explicitement la qualité TP selon la distance et le budget du jeu.

Les effets sont une adaptation jouable des concepts : la lumière et les détails diffèrent d’une illustration promotionnelle. Les aperçus montrent le résultat réellement calculé. L’intégration finale doit être vérifiée avec les lumières FP et les cartes du jeu.
