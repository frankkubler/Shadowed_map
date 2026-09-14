# Shadowed Map

Carte des ombres du soleil — relief et bâtiments, partout sur Terre, à n'importe quelle
date et heure. Inspiré de [ShadeMap](https://shademap.app), avec un angle plein air :
où est le soleil à 18 h, quelles terrasses sont encore éclairées, combien d'heures de
soleil tombent ici aujourd'hui.

Tout est calculé dans le navigateur, sans clé d'API et sans serveur.

## Ce que ça fait

- **Ombres du relief et des bâtiments** à l'instant choisi, recalculées en temps réel.
- **Curseur horaire** et animation de la journée.
- **Heures d'ensoleillement** cumulées sur la journée, en carte colorée.
- **Clic sur la carte** : au soleil ou à l'ombre, altitude, direction du soleil tracée
  sur la carte (utile pour anticiper un contre-jour en photo).
- **Lever, coucher, midi solaire, golden hour** pour le point visé.
- **Lien partageable** : la vue et l'heure sont dans l'URL.

## Comment ça marche

Le relief et les bâtiments sont fusionnés dans **un seul champ de hauteur** — une
texture où chaque texel porte l'altitude du sommet de ce qui s'y trouve — puis un
**unique lancer de rayon** vers le soleil détermine l'ombre.

```
   tuiles DEM terrarium (AWS)  ─┐
                                ├─►  champ de hauteur   ─►  lancer de rayon  ─►  masque d'ombre
   empreintes bâtiments OSM  ───┘     (viewport + marge)     vers le soleil       sur la carte
```

Traiter relief et bâtiments séparément donnerait de mauvais résultats là où un immeuble
se trouve à l'ombre d'une montagne ; les fusionner règle le cas sans code particulier.

Quelques points sensibles, détaillés dans les commentaires du code :

- Le champ est **carré en Mercator**, ce qui rend l'espace texel isotrope et évite toute
  correction d'aspect dans le shader (`src/shadow/region.ts`).
- La marge du champ s'étend **uniquement du côté du soleil**, et est plafonnée : sans
  cela elle diverge au lever et au coucher.
- Le pas de marche **croît géométriquement** : fin près du point de départ pour attraper
  les ombres de bâtiments, grossier au loin pour les crêtes (`src/shadow/raymarch.ts`).
- Le nombre de tuiles d'élévation par vue est **plafonné** : les données sous-jacentes
  (SRTM 30 m, EU-DEM 25 m) ne justifient pas les zooms les plus fins.
- L'affichage passe par **`projectTile()`**, la fonction de projection que MapLibre
  injecte dans le shader, et non par une matrice brute — c'est ce qui garde la couche
  correcte si la carte passe en projection globe (`src/shadow/projection.ts`).

## Précision — à lire avant de s'y fier

Les résultats sont des **estimations**, sensiblement moins précises que ShadeMap :

- Le relief vient d'un modèle de terrain nu à 25–30 m de résolution réelle.
- Les hauteurs de bâtiments viennent d'OpenStreetMap ; elles sont souvent absentes, et
  alors déduites du nombre de niveaux ou remplacées par une valeur par défaut de 8 m.
- **La végétation n'est pas modélisée** : un arbre ne projette aucune ombre ici.

Utile pour choisir une terrasse ou préparer une photo. À ne pas utiliser pour du
dimensionnement de panneaux solaires ou une étude d'ensoleillement réglementaire.

## Développement

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
```

| Commande | Rôle |
|---|---|
| `npm run typecheck` | TypeScript en mode strict |
| `npm run lint` | ESLint |
| `npm test` | Tests unitaires (Vitest) |
| `npm run build` | Build de production |

### Vérifier le moteur d'ombre

Les tests unitaires ne peuvent pas valider le shader : il n'y a pas de GPU sous Node.
Or c'est là que se cachent les erreurs les plus coûteuses — une inversion de signe dans
la direction du soleil produit une carte qui *semble* plausible tout en étant fausse.

Un banc de vérification tourne donc dans le navigateur :

```bash
npm run dev
# puis ouvrir http://localhost:5173/tools/gpu-check.html
```

Il vérifie, sur un relief synthétique dont la réponse est connue analytiquement, que
l'ombre d'une tour de 100 m mesure bien 100 m quand le soleil est à 45°, qu'elle bascule
correctement avec l'azimut, et qu'elle s'allonge quand le soleil descend. Puis, sur du
relief réel, que le fond de la vallée de Chamonix est encore à l'ombre au moment où le
sommet du Mont-Blanc est déjà éclairé.

Derrière un réseau restreint, un miroir local de tuiles peut être passé en paramètre :
`?dem=http://127.0.0.1:5180`.

## Sources de données et attributions

Ce projet n'existe que grâce à des données et des services ouverts. Leur usage est
encadré ; si le site devait prendre de l'audience, il faudrait mettre en cache côté
serveur ou héberger ses propres instances.

| Donnée | Source | Licence / conditions |
|---|---|---|
| Élévation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (terrarium) | domaine public / sources multiples |
| Bâtiments | [OpenStreetMap](https://www.openstreetmap.org/copyright) via [Overpass API](https://overpass-api.de) | ODbL |
| Recherche de lieux | [Nominatim](https://nominatim.org/release-docs/latest/api/Overview/) | ODbL, [politique d'usage](https://operations.osmfoundation.org/policies/nominatim/) |
| Fonds de carte | [CARTO](https://carto.com/attributions), [OpenStreetMap](https://www.openstreetmap.org/copyright) | attribution requise |
| Rendu | [MapLibre GL JS](https://maplibre.org/) | BSD-3-Clause |
| Position du soleil | [SunCalc](https://github.com/mourner/suncalc) | BSD-2-Clause |

## Prérequis navigateur

**WebGL2** et l'extension **`EXT_color_buffer_float`** sont nécessaires. À défaut,
l'application affiche un message explicite plutôt qu'une carte vide.
