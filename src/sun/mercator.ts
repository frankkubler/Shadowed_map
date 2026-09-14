/**
 * Géométrie Web Mercator.
 *
 * Tout le moteur d'ombre travaille en coordonnées Mercator normalisées : x et y dans
 * [0, 1], origine en haut à gauche (180°O, ~85,05°N). C'est la même convention que
 * MapLibre, ce qui évite les conversions au moment de caler l'overlay sur la carte.
 *
 * Piège central : une unité Mercator ne vaut pas la même distance au sol selon la
 * latitude. Toute conversion vers des mètres doit passer par `metersPerMercatorUnit`.
 */

/** Circonférence de la Terre à l'équateur, en mètres (sphère WGS84). */
export const EARTH_CIRCUMFERENCE = 40075016.686;

/**
 * Latitude maximale représentable en Web Mercator : celle pour laquelle y vaut
 * exactement 0, soit atan(sinh(π)) en degrés.
 */
export const MAX_MERCATOR_LATITUDE = 85.0511287798066;

export interface LngLat {
  lng: number;
  lat: number;
}

export interface MercatorPoint {
  x: number;
  y: number;
}

export function clampLatitude(lat: number): number {
  return Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, lat));
}

export function lngToMercatorX(lng: number): number {
  return (180 + lng) / 360;
}

export function latToMercatorY(lat: number): number {
  const phi = (clampLatitude(lat) * Math.PI) / 180;
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
  // Le bornage de la latitude laisse passer une erreur d'arrondi de l'ordre de 1e-9
  // aux pôles ; la borne sur y, elle, est un invariant dont dépendent les calculs
  // d'indices de tuiles.
  return Math.min(1, Math.max(0, y));
}

export function mercatorXToLng(x: number): number {
  return x * 360 - 180;
}

export function mercatorYToLat(y: number): number {
  const n = Math.PI * (1 - 2 * y);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export function toMercator({ lng, lat }: LngLat): MercatorPoint {
  return { x: lngToMercatorX(lng), y: latToMercatorY(lat) };
}

export function fromMercator({ x, y }: MercatorPoint): LngLat {
  return { lng: mercatorXToLng(x), lat: mercatorYToLat(y) };
}

/**
 * Combien de mètres au sol représente une unité Mercator (donc la carte entière)
 * à cette latitude. Vaut EARTH_CIRCUMFERENCE à l'équateur et tend vers 0 aux pôles.
 */
export function metersPerMercatorUnit(lat: number): number {
  return EARTH_CIRCUMFERENCE * Math.cos((clampLatitude(lat) * Math.PI) / 180);
}

/**
 * Résolution d'une tuile raster classique, en mètres par pixel.
 * `tileSize` vaut 256 pour les tuiles terrarium, 512 pour les tuiles vectorielles.
 */
export function metersPerPixel(lat: number, zoom: number, tileSize = 256): number {
  return metersPerMercatorUnit(lat) / (tileSize * Math.pow(2, zoom));
}

export interface TileCoord {
  x: number;
  y: number;
  z: number;
}

/** Tuile XYZ contenant un point donné. */
export function pointToTile(lng: number, lat: number, z: number): TileCoord {
  const scale = Math.pow(2, z);
  return {
    x: Math.floor(lngToMercatorX(lng) * scale),
    y: Math.floor(latToMercatorY(lat) * scale),
    z,
  };
}

/** Enveloppe géographique : ouest, sud, est, nord. */
export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Toutes les tuiles XYZ couvrant une enveloppe, au zoom donné. */
export function tilesInBounds(bounds: Bounds, z: number): TileCoord[] {
  const scale = Math.pow(2, z);
  const minX = Math.floor(lngToMercatorX(bounds.west) * scale);
  const maxX = Math.floor(lngToMercatorX(bounds.east) * scale);
  // En Mercator, y croît vers le sud : le nord donne le plus petit indice.
  const minY = Math.floor(latToMercatorY(bounds.north) * scale);
  const maxY = Math.floor(latToMercatorY(bounds.south) * scale);

  const tiles: TileCoord[] = [];
  for (let y = Math.max(0, minY); y <= Math.min(scale - 1, maxY); y++) {
    for (let x = minX; x <= maxX; x++) {
      // Enroulement en longitude : la carte est cyclique en x.
      tiles.push({ x: ((x % scale) + scale) % scale, y, z });
    }
  }
  return tiles;
}
