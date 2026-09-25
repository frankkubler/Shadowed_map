/**
 * Élévation LiDAR HD de l'IGN, via le service WMS de la Géoplateforme.
 *
 * Le produit retenu est le **MNS** : un modèle de surface, qui inclut les toits et la
 * végétation. C'est ce qui distingue cette source de terrarium, un modèle de terrain nu
 * au pas de 3 mètres environ : là où le LiDAR répond, les bâtiments n'ont plus besoin
 * d'être extrudés depuis OpenStreetMap, ils sont déjà dans la donnée, avec leur forme
 * réelle — et les arbres portent enfin leur ombre.
 *
 * Accès libre, sans clé ni compte, sous licence ouverte Etalab 2.0. Le service répond en
 * `image/x-bil;bits=32`, c'est-à-dire des altitudes en float32 brut, et il accepte
 * EPSG:3857 : une tuile de la grille web se demande donc telle quelle.
 *
 * Couverture : France métropolitaine et DROM hors Guyane, livrée par blocs. Partout
 * ailleurs le service renvoie uniformément NO_DATA_IGN, ce qui permet de retomber sur
 * terrarium sans avoir à connaître l'emprise à l'avance.
 */
import type { TileCoord } from '../sun/mercator';

const WMS_URL = 'https://data.geopf.fr/wms-r';

/**
 * Deux produits, deux usages.
 *
 * `mnt` est le sol nu : les bâtiments continuent d'être extrudés depuis OpenStreetMap,
 * ce qui donne une carte lisible et valable toute l'année. `mns` est la surface telle
 * qu'elle a été mesurée, arbres compris — plus exact, mais le feuillage est celui du
 * jour de la campagne LiDAR, ce qui trompe en hiver.
 */
export type LidarProduct = 'mnt' | 'mns';

const LAYERS: Record<LidarProduct, string> = {
  mnt: 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  mns: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
};

/** Valeur rendue par le service hors couverture. */
export const NO_DATA_IGN = -9999;

/** Demi-circonférence en projection Web Mercator, en mètres. */
const MERCATOR_EXTENT = 20037508.342789244;

export const IGN_TILE_SIZE = 256;

/**
 * Le LiDAR HD est au pas de 50 cm ; au-delà de ce zoom on ne gagnerait plus rien et on
 * multiplierait les requêtes. À z18, un texel vaut environ 0,4 m à nos latitudes.
 */
export const IGN_MAX_ZOOM = 18;

/**
 * En dessous de ce zoom, le LiDAR ne sert plus à rien et coûte cher.
 *
 * Une tuile de 256 px couvre 78 km de côté à z9, soit 306 m par texel : le service doit
 * rééchantillonner une emprise énorme pour produire une valeur que terrarium, au pas de
 * 3 m, donne à l'identique. Tout ce qui fait l'intérêt du LiDAR — la finesse, et le
 * sursol du MNS — a disparu dans la moyenne bien avant.
 *
 * À z13 un texel vaut environ 13 m à nos latitudes : c'est la limite en dessous de
 * laquelle un bâtiment ne pèse plus un texel entier. Mesuré : sans cette borne, une vue
 * large sur la France lance des centaines de requêtes réparties de z9 à z15, et la
 * Géoplateforme répond en 429.
 *
 * La borne reste sous `TERRARIUM_MAX_ZOOM` (15), ce qui laisse une plage où les deux
 * sources coexistent : la première tuile LiDAR obtenue y sert de sonde de couverture et
 * débloque les zooms plus fins.
 */
export const IGN_MIN_ZOOM = 13;

/**
 * Refus du service, avec son code.
 *
 * Le code importe : un 429 est une limite de débit, qui vaut pour toutes les requêtes à
 * venir et demande de lever le pied, alors qu'un 400 sporadique ne concerne que cette
 * tuile-là et se retente aussitôt.
 */
export class LidarHttpError extends Error {
  constructor(readonly status: number) {
    super(`LiDAR IGN : réponse ${status}`);
    this.name = 'LidarHttpError';
  }
}

/** Emprise d'une tuile de la grille web, en EPSG:3857. */
export function tileBounds3857(coord: TileCoord): [number, number, number, number] {
  const span = (2 * MERCATOR_EXTENT) / Math.pow(2, coord.z);
  const minX = -MERCATOR_EXTENT + coord.x * span;
  const maxY = MERCATOR_EXTENT - coord.y * span;
  return [minX, maxY - span, minX + span, maxY];
}

export function lidarTileUrl(
  coord: TileCoord,
  product: LidarProduct,
  size = IGN_TILE_SIZE,
): string {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: LAYERS[product],
    STYLES: '',
    CRS: 'EPSG:3857',
    BBOX: tileBounds3857(coord).join(','),
    WIDTH: String(size),
    HEIGHT: String(size),
    FORMAT: 'image/x-bil;bits=32',
  });
  return `${WMS_URL}?${params.toString()}`;
}

/**
 * Convertit la réponse BIL en altitudes.
 *
 * Renvoie `null` si la tuile n'est pas entièrement couverte : mélanger un modèle de
 * surface et un modèle de terrain nu dans une même tuile ferait apparaître des marches
 * de plusieurs mètres, et donc de fausses ombres, exactement là où la donnée s'arrête.
 */
export function decodeBil32(buffer: ArrayBuffer, size = IGN_TILE_SIZE): Float32Array | null {
  const attendu = size * size * 4;
  if (buffer.byteLength !== attendu) return null;

  const valeurs = new Float32Array(buffer.slice(0));
  for (const v of valeurs) {
    if (v <= NO_DATA_IGN + 1 || !Number.isFinite(v)) return null;
  }
  return valeurs;
}

/**
 * Charge une tuile d'élévation LiDAR.
 *
 * Renvoie `null` quand la zone n'est pas couverte, ou quand le zoom sort des bornes
 * utiles : c'est un fait durable, l'appelant peut se rabattre sur terrarium une fois
 * pour toutes. En revanche un refus du service
 * **lève**, et c'est délibéré : mesuré, une requête sur huit environ repart en 400 sans
 * raison apparente. Confondre ce hasard avec une absence de données ferait renoncer
 * définitivement à une tuile qui existe — et laisserait un trou dans le champ aux zooms
 * où terrarium ne peut pas prendre le relais.
 */
export async function fetchLidarTile(
  coord: TileCoord,
  product: LidarProduct,
  signal?: AbortSignal,
): Promise<Float32Array | null> {
  if (coord.z > IGN_MAX_ZOOM || coord.z < IGN_MIN_ZOOM) return null;

  const response = await fetch(lidarTileUrl(coord, product), { signal, mode: 'cors' });
  if (!response.ok) {
    throw new LidarHttpError(response.status);
  }

  // Le service signale certaines erreurs en XML, avec un code 200.
  const type = response.headers.get('Content-Type') ?? '';
  if (!type.includes('bil')) {
    throw new Error(`LiDAR IGN : réponse inattendue (${type})`);
  }

  return decodeBil32(await response.arrayBuffer());
}
