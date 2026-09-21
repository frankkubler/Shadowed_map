# Shadowed Map

Carte des ombres du soleil — relief et bâtiments, partout sur Terre, à n'importe quelle
date et heure. Inspiré de [ShadeMap](https://shademap.app), avec un angle plein air :
où est le soleil à 18 h, quelles terrasses sont encore éclairées, combien d'heures de
soleil tombent ici aujourd'hui.

Tout est calculé dans le navigateur, sans serveur. Seuls les fonds de carte CARTO
demandent une clé, gratuite (voir « Sources de données »).

## Ce que ça fait

- **Ombres du relief et des bâtiments** à l'instant choisi, recalculées en temps réel.
  En France, le relief vient du LiDAR HD de l'IGN, au pas de 50 cm ; la végétation peut
  être incluse, au choix.
- **Curseur horaire** et animation de la journée, à vitesse réglable. Sans instant
  demandé dans le lien, la carte suit l'heure courante.
- **Heures d'ensoleillement** cumulées sur la journée, en carte colorée.
- **Terrasses au soleil** : cafés, bars et restaurants d'OpenStreetMap, colorés selon
  qu'ils sont éclairés ou non, avec une liste triée et, à la demande, jusqu'à quelle
  heure chacun reste au soleil.
- **Import GPX** : trace colorée soleil/ombre à l'heure de passage, profil
  d'ensoleillement le long du parcours, et part du trajet au soleil selon l'heure de
  départ.
- **Clic sur la carte** : au soleil ou à l'ombre, altitude, direction du soleil tracée
  sur la carte (utile pour anticiper un contre-jour en photo).
- **Lever, coucher, midi solaire, golden hour** pour le point visé.
- **Lien partageable** : la vue et l'heure sont dans l'URL.

## Comment ça marche

Le relief et les bâtiments sont fusionnés dans **un seul champ de hauteur** — une
texture où chaque texel porte l'altitude du sommet de ce qui s'y trouve — puis un
**unique lancer de rayon** vers le soleil détermine l'ombre.

```
   LiDAR HD IGN (France)  ─┐
   ou tuiles terrarium     ├─►  champ de hauteur   ─►  lancer de rayon  ─►  masque d'ombre
   empreintes bâtiments OSM┘     (viewport + marge)     vers le soleil       sur la carte
```

Les bâtiments d'OpenStreetMap ne sont extrudés que si l'élévation est un modèle de
terrain nu. Là où elle vient du modèle de surface LiDAR, les toits sont déjà dans la
donnée, avec leur forme réelle : les extruder par-dessus poserait chaque bâtiment sur
son propre toit.

Traiter relief et bâtiments séparément donnerait de mauvais résultats là où un immeuble
se trouve à l'ombre d'une montagne ; les fusionner règle le cas sans code particulier.

Quelques points sensibles, détaillés dans les commentaires du code :

- Le champ est **carré en Mercator**, ce qui rend l'espace texel isotrope et évite toute
  correction d'aspect dans le shader (`src/shadow/region.ts`).
- La marge du champ s'étend **uniquement du côté du soleil** (sauf pendant un balayage
  horaire, voir plus bas), et est plafonnée : sans cela elle diverge au lever et au
  coucher.
- Le pas de marche **croît géométriquement** : fin près du point de départ pour attraper
  les ombres de bâtiments, grossier au loin pour les crêtes (`src/shadow/raymarch.ts`).
- Le zoom d'élévation exploitable dépend de la **source** : terrarium dérive de données
  à 25–30 m et s'arrête tôt, le LiDAR descend à 50 cm. Le nombre de tuiles par vue
  reste **plafonné**, ce qui borne les requêtes quelle que soit la source.
- Le LiDAR n'est demandé que dans une **fenêtre de zoom** (`src/shadow/lidarIgn.ts`) :
  au-dessus de z18 il n'apporte plus rien, en dessous de z13 non plus, puisqu'une tuile
  de 256 px couvre alors des dizaines de kilomètres et que le service doit rééchantillonner
  une emprise énorme pour un résultat que terrarium donne à l'identique. Les requêtes
  sont par ailleurs **menées six par six**, et le LiDAR mis de côté trente secondes
  après un `429` : la limite de débit de la Géoplateforme porte sur l'adresse IP, donc
  insister tuile par tuile ne fait que la reconduire (`src/shadow/demTiles.ts`).
- Les tuiles d'élévation sont **décodées sans passer par le canvas**
  (`src/shadow/png.ts`) : `createImageBitmap` + `drawImage` + `getImageData` n'est pas
  fidèle à l'octet près, et une unité du canal rouge vaut 256 mètres. Mesuré : 78 pixels
  faux sur une seule tuile, donc 78 pics de 256 m et autant de fausses ombres.
- L'affichage passe par **`projectTile()`**, la fonction de projection que MapLibre
  injecte dans le shader, et non par une matrice brute — c'est ce qui garde la couche
  correcte si la carte passe en projection globe (`src/shadow/projection.ts`).

### Interroger l'ombre en masse, et dans le temps

Les terrasses et le profil GPX reposent sur la même brique (`src/shadow/ShadowLayer.ts`) :

- `queryPoints` lit **tout le masque d'un coup** plutôt qu'un `readPixels` par point.
  Chaque lecture force une synchronisation avec le GPU ; en faire une par terrasse ou
  par point de trace figerait l'interface.
- `sweepTimes` rejoue le lancer de rayon pour une série d'instants, quelques-uns par
  frame, dans **un masque distinct de celui affiché** — sans quoi un balayage laisserait
  l'écran sur le dernier instant calculé.
- Pendant un balayage, la marge du champ de hauteur devient **omnidirectionnelle**. Le
  soleil fait le tour de l'horizon dans la journée : une marge posée pour le matin
  manquerait les obstacles de l'ouest en fin d'après-midi, et l'erreur serait invisible
  puisqu'une ombre manquante ressemble à du soleil.

### Terrasses : ce qu'OpenStreetMap sait et ne sait pas

`outdoor_seating` est peu renseigné. S'y limiter donnerait une poignée de points dans la
plupart des villes, ce qui ferait passer un manque de données pour une absence de
terrasses. Le site affiche donc deux niveaux : **confirmée** (`outdoor_seating` présent)
en pastille pleine, **probable** (café, bar ou restaurant qui ne dit rien) en contour
seul et signalée comme telle. Les établissements qui déclarent `outdoor_seating=no` sont
écartés.

## Précision — à lire avant de s'y fier

Les résultats sont des **estimations**, et leur qualité dépend beaucoup de l'endroit.

**En France**, l'élévation vient du LiDAR HD de l'IGN, mesuré au pas de 50 cm. Deux
modes, au choix dans le panneau :

- *Bâtiments* — le sol nu mesuré, les bâtiments extrudés depuis OpenStreetMap. Valable
  toute l'année. Les hauteurs OSM sont souvent absentes, et alors déduites du nombre de
  niveaux ou remplacées par une valeur par défaut de 8 m.
- *Bâtiments et arbres* — la surface telle qu'elle a été relevée, toits et végétation
  compris. Plus exact au jour du vol, mais **le feuillage est celui de ce jour-là** :
  un tilleul dénudé en janvier projette ici l'ombre de son feuillage d'été.

**Ailleurs**, le relief vient d'un modèle de terrain nu à 25–30 m de résolution réelle,
et la végétation n'est pas modélisée du tout.

Utile pour choisir une terrasse ou préparer une photo. À ne pas utiliser pour du
dimensionnement de panneaux solaires ou une étude d'ensoleillement réglementaire.

## Développement

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
```

Les fonds CARTO attendent leur clé dans un fichier `.env` à la racine, ignoré par git :

```
CARTO_BASEMAPS_API_KEY=…
```

Sans elle, la carte fonctionne mais les fonds clair et sombre reviennent barrés d'un
filigrane. Pour le site publié, la même clé se pose en secret de dépôt, sous le même nom.

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
correctement avec l'azimut, qu'elle s'allonge quand le soleil descend, et qu'elle suit
le soleil sur tout le tour de l'horizon — c'est ce dernier contrôle qui protège du piège
de la marge unidirectionnelle. Puis, sur du relief réel, que le fond de la vallée de
Chamonix est encore à l'ombre au moment où le sommet du Mont-Blanc est déjà éclairé, et
qu'un bâtiment posé sur ce relief projette bien son ombre.

Derrière un réseau restreint, un miroir local de tuiles peut être passé en paramètre :
`?dem=http://127.0.0.1:5180`.

## Déploiement en conteneur

Le site est statique : l'image construit le bundle, puis nginx le sert. Aucune donnée
ne transite par ce serveur — le navigateur interroge directement l'IGN, Overpass,
Nominatim et CARTO, et c'est donc le poste client qui a besoin de l'accès réseau, pas
l'hôte du conteneur.

```bash
cp .env.example .env    # y poser CARTO_BASEMAPS_API_KEY
docker compose up -d --build
```

Le conteneur écoute par défaut sur `127.0.0.1:8080`, pour être atteint par un reverse
proxy plutôt que directement : la terminaison TLS, les redirections et HSTS relèvent de
l'amont. `BIND_ADDR`, `HTTP_PORT` et `BASE_PATH` se règlent dans `.env` ; les cas
courants — proxy sur un autre pair, proxy en conteneur, site sous un sous-chemin — sont
commentés dans `docker-compose.yml`.

Deux points valent d'être connus :

- `vite.config.ts` fixe `base` à `/Shadowed_map/` pour GitHub Pages. L'image rebâtit
  avec `--base=/`, sans quoi `index.html` demanderait `/Shadowed_map/assets/…` et la
  page resterait blanche.
- La clé CARTO est résolue **au build** et se retrouve en clair dans le bundle, comme
  pour le site publié. Un secret monté n'y changerait rien ; le quota gratuit est la
  seule protection.

L'image rejoue `typecheck`, `lint` et les tests avant de produire le bundle : une
régression arrête la construction au lieu de se découvrir en production. Le banc de
vérification GPU (`tools/gpu-check.html`) n'est pas dans le bundle et reste un outil de
développement.

## Sources de données et attributions

Ce projet n'existe que grâce à des données et des services ouverts. Leur usage est
encadré ; si le site devait prendre de l'audience, il faudrait mettre en cache côté
serveur ou héberger ses propres instances.

| Donnée | Source | Licence / conditions |
|---|---|---|
| Élévation (France) | [LiDAR HD](https://geoservices.ign.fr/lidarhd) de l'IGN, via le WMS de la [Géoplateforme](https://data.geopf.fr) | [Etalab 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/), sans clé |
| Élévation (ailleurs) | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (terrarium) | domaine public / sources multiples |
| Bâtiments | [OpenStreetMap](https://www.openstreetmap.org/copyright) via [Overpass API](https://overpass-api.de) | ODbL |
| Recherche de lieux | [Nominatim](https://nominatim.org/release-docs/latest/api/Overview/) | ODbL, [politique d'usage](https://operations.osmfoundation.org/policies/nominatim/) |
| Fonds de carte | [CARTO](https://carto.com/attributions), [OpenStreetMap](https://www.openstreetmap.org/copyright) | attribution requise ; CARTO exige une [clé](https://carto.com/basemaps/apikey), gratuite jusqu'à 5 M tuiles/mois |
| Terrasses | [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass | ODbL |
| Rendu | [MapLibre GL JS](https://maplibre.org/) | BSD-3-Clause |
| Position du soleil | [SunCalc](https://github.com/mourner/suncalc) | BSD-2-Clause |

## Couleurs

L'encodage soleil / ombre est le même partout — points de terrasses, trace GPX, profil —
pour que l'ensemble se lise comme un seul système. Le couple a été validé : bande de
clarté, plancher de chroma, contraste sur le fond, et séparation en vision des couleurs
déficiente (ΔE ≈ 26, contre un seuil de 8). C'est ce dernier point qui permet de se
passer de texture en complément ; une pastille et un libellé accompagnent malgré tout
chaque état dans les listes, pour que l'information ne repose jamais sur la seule
couleur.

Les valeurs vivent dans `src/styles/app.css` (`--sun`, `--shade`), avec un jeu propre au
thème sombre — redosé pour ce fond, et non simplement éclairci.

## Prérequis navigateur

**WebGL2** et l'extension **`EXT_color_buffer_float`** sont nécessaires. À défaut,
l'application affiche un message explicite plutôt qu'une carte vide.
