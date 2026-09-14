/**
 * Choix de la région couverte par le champ de hauteur.
 *
 * Le champ doit déborder du viewport **dans la direction du soleil** : un relief ou un
 * immeuble situé hors de l'écran projette son ombre dans l'écran. La marge nécessaire
 * vaut `hauteurMax / tan(hauteurDuSoleil)`, ce qui diverge au lever et au coucher —
 * d'où le plafonnement, assumé et documenté dans l'interface.
 */
import {
  latToMercatorY,
  lngToMercatorX,
  mercatorYToLat,
  metersPerMercatorUnit,
  type Bounds,
} from '../sun/mercator';
import { MIN_USEFUL_ALTITUDE_RAD, type Direction } from '../sun/sun';
import { TERRARIUM_MAX_ZOOM, TERRARIUM_TILE_SIZE } from './demTiles';

/** Rectangle en Mercator normalisé. `y0` est le bord nord (y croît vers le sud). */
export interface MercatorRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Au-delà, la marge coûte plus de résolution qu'elle n'apporte d'ombres utiles. */
const MAX_MARGIN_RATIO = 1.5;

/** Relief maximal supposé au-dessus du viewport quand le DEM n'est pas encore chargé. */
const FALLBACK_RELIEF_METERS = 1500;

export function regionWidth(r: MercatorRegion): number {
  return r.x1 - r.x0;
}

export function regionHeight(r: MercatorRegion): number {
  return r.y1 - r.y0;
}

export function regionCenterLat(r: MercatorRegion): number {
  return mercatorYToLat((r.y0 + r.y1) / 2);
}

export function boundsToRegion(bounds: Bounds): MercatorRegion {
  return {
    x0: lngToMercatorX(bounds.west),
    y0: latToMercatorY(bounds.north),
    x1: lngToMercatorX(bounds.east),
    y1: latToMercatorY(bounds.south),
  };
}

/**
 * Rend la région carrée en Mercator, autour de son centre.
 *
 * Sans cela, l'espace texel serait anisotrope et chaque distance manipulée dans le
 * shader demanderait une correction d'aspect — source d'erreurs pour un gain nul,
 * puisqu'il suffit d'agrandir légèrement la région.
 */
export function squareRegion(r: MercatorRegion): MercatorRegion {
  const size = Math.max(regionWidth(r), regionHeight(r));
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  return { x0: cx - size / 2, x1: cx + size / 2, y0: cy - size / 2, y1: cy + size / 2 };
}

export function regionContains(outer: MercatorRegion, inner: MercatorRegion): boolean {
  return (
    outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 && outer.y1 >= inner.y1
  );
}

export interface FieldRegionOptions {
  /** Région visible, celle qu'il faudra effectivement ombrer. */
  visible: MercatorRegion;
  /** Vecteur horizontal unitaire vers le soleil. */
  sunDir: Direction;
  /** Hauteur du soleil au-dessus de l'horizon, en radians. */
  sunAltitude: number;
  /** Dénivelé maximal connu dans la zone, en mètres. */
  reliefMeters?: number;
}

export interface FieldRegion {
  region: MercatorRegion;
  /** Distance maximale utile pour le lancer de rayon, en mètres. */
  maxShadowDistanceMeters: number;
}

/**
 * Étend la région visible dans la direction du soleil.
 *
 * L'extension est asymétrique : inutile d'élargir du côté opposé au soleil, rien de
 * ce qui s'y trouve ne peut assombrir le viewport.
 */
export function computeFieldRegion({
  visible,
  sunDir,
  sunAltitude,
  reliefMeters = FALLBACK_RELIEF_METERS,
}: FieldRegionOptions): FieldRegion {
  const lat = regionCenterLat(visible);
  const metersPerUnit = metersPerMercatorUnit(lat);
  const effectiveAltitude = Math.max(sunAltitude, MIN_USEFUL_ALTITUDE_RAD);

  const neededMeters = reliefMeters / Math.tan(effectiveAltitude);
  const neededUnits = neededMeters / metersPerUnit;

  const width = regionWidth(visible);
  const height = regionHeight(visible);
  const maxMarginUnits = Math.max(width, height) * MAX_MARGIN_RATIO;
  const marginUnits = Math.min(neededUnits, maxMarginUnits);

  // Mercator : x croît vers l'est, y croît vers le **sud**, d'où l'inversion sur north.
  const dx = sunDir.east * marginUnits;
  const dy = -sunDir.north * marginUnits;

  const region: MercatorRegion = {
    x0: visible.x0 + Math.min(0, dx),
    x1: visible.x1 + Math.max(0, dx),
    y0: visible.y0 + Math.min(0, dy),
    y1: visible.y1 + Math.max(0, dy),
  };

  return {
    region,
    maxShadowDistanceMeters: marginUnits * metersPerUnit + Math.max(width, height) * metersPerUnit,
  };
}

/**
 * Nombre de tuiles d'élévation qu'on s'autorise à télécharger pour une vue.
 *
 * Une tuile terrarium pèse une centaine de kilo-octets : sans plafond, une vue large
 * au zoom idéal en demanderait plus d'une centaine, soit une douzaine de mégaoctets
 * — inacceptable, et pour rien, puisque les données sous-jacentes (SRTM à 30 m,
 * EU-DEM à 25 m) n'ont pas ce niveau de détail. Descendre d'un cran de zoom divise
 * le volume par quatre sans perte d'information réelle.
 */
const MAX_DEM_TILES = 36;

/** Nombre de tuiles nécessaires pour couvrir la région à ce zoom. */
function tileCountAtZoom(region: MercatorRegion, zoom: number): number {
  const scale = Math.pow(2, zoom);
  const across = Math.floor(regionWidth(region) * scale) + 1;
  const down = Math.floor(regionHeight(region) * scale) + 1;
  return across * down;
}

/**
 * Zoom de tuile DEM dont la résolution colle à celle du champ de hauteur, sans
 * dépasser le budget de tuiles.
 *
 * Prendre plus fin que le champ ne sert à rien (l'information serait perdue à la
 * rasterisation) ; prendre plus grossier crée des marches d'escalier visibles dans
 * les ombres de crête. Entre les deux, le budget tranche.
 */
export function chooseDemZoom(
  region: MercatorRegion,
  fieldSize: number,
  maxTiles = MAX_DEM_TILES,
): number {
  const unitsPerTexel = Math.max(regionWidth(region), regionHeight(region)) / fieldSize;
  // Un texel de tuile au zoom z couvre 1 / (tileSize * 2^z) unités Mercator.
  const idealZoom = Math.log2(1 / (unitsPerTexel * TERRARIUM_TILE_SIZE));

  let zoom = Math.max(0, Math.min(TERRARIUM_MAX_ZOOM, Math.round(idealZoom)));
  while (zoom > 0 && tileCountAtZoom(region, zoom) > maxTiles) zoom--;
  return zoom;
}

/** Enveloppe géographique d'une région, pour interroger Overpass ou lister les tuiles. */
export function regionToBounds(region: MercatorRegion): Bounds {
  return {
    west: region.x0 * 360 - 180,
    east: region.x1 * 360 - 180,
    north: mercatorYToLat(region.y0),
    south: mercatorYToLat(region.y1),
  };
}
