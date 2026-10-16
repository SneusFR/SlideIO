# Écran de fin de partie (FFA)

Maquette d'origine intégrée telle quelle (cinématique vitre brisée + titre 3D,
grande modale : classement, Performance / Temps forts, vote de la prochaine map).
Seul changement visuel : les vignettes de map procédurales (`mapArt.js`) sont
remplacées par de **vraies captures du jeu** (`maps/*.webp`).

## Fichiers

```
endscreen/
  EndScreen.js    point d'entrée (seule classe à importer) — typé par EndScreen.d.ts
  Intro3D.js      scène Three.js : vitre, fissures, titre extrudé, particules
  UI.js           interface DOM animée (classement, stats, momentum, duels, vote)
  stats.js        calculs : KDR, précision, rival, proie, séries, momentum, distinctions
  styles.js       CSS injecté (unités d'écran 1920×1080 mises à l'échelle)
  modalStyles.js  présentation de la grande modale, onglets, mise en page adaptative
  sfx.js          bruitages synthétisés (WebAudio, aucun fichier son)
  avatar.js       avatars de secours (fruit cartoon dans la couleur du joueur)
  anim.js         easings, tweens
  titleFont.js    contours de glyphes pour le titre 3D (sous-ensemble de Lilita One)
  fonts/          Lilita One + Nunito (licence SIL OFL 1.1, voir OFL-*.txt)
  maps/           vignettes de vote : captures réelles JUNGLE / YARD / GIVRE (640×400)
```

## Branchement dans le jeu

- `src/match/MatchEndController.ts` — flux de fin de partie (solo + multijoueur).
- `src/match/EndScreenData.ts` — convertit les **vrais** résultats
  (`shared/match/MatchResultsTracker.ts`) au format ci-dessous.
- `src/match/MatchClockHUD.ts` — chrono 5:00 de la pilule FFA.
- Serveur : `backend/src/rooms/GameRoom.ts` (chrono autoritaire, `MATCH_ENDED`,
  `MAP_VOTES`, `MATCH_RETURN`) et `backend/src/match/MapVote.ts`.

## Format des données (`show(data, { snapshot })`)

```ts
{
  mode: "FFA", mapName: "Jungle City", duration: 300, localPlayerId: "-1",
  players: [{ id, name, kills, deaths, assists, rank, score, damage, shotsFired, shotsHit }],
  killFeed: [{ t: 12.3, killer: "a" | null, victim: "b", assisters: ["c"] }],
  maps: [{ id: "JUNGLE", name: "Jungle City", subtitle, image }],
}
```

`rank` (optionnel) impose le classement du leaderboard du jeu ; sans lui, tri par score.
`map.image` absent → fond uni (plus de vignette procédurale).

## Régénérer les vignettes de map

```
npx vite --port 5180 --strictPort                 # autre terminal
node tools/endscreen/capture-map-thumbs.mjs       # captures brutes → maps/raw/
node tools/endscreen/encode-map-thumbs.mjs --clean # recadrage + WebP, supprime raw/
```

## Licences

Lilita One (Juan Montoreano) et Nunito (The Nunito Project Authors) : SIL Open Font
License 1.1 (`fonts/OFL-*.txt`). `titleFont.js` est un sous-ensemble converti de
Lilita One, renommé « EndScreen Display » comme l'exige la licence.
Three.js est la dépendance `three` du projet (MIT).
