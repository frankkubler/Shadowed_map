/**
 * Terrasses de cafés, bars et restaurants, depuis OpenStreetMap.
 *
 * `outdoor_seating` est un tag peu renseigné : s'y limiter donnerait une poignée de
 * points dans la plupart des villes. On récupère donc tous les établissements du genre
 * et on distingue deux niveaux de certitude, plutôt que de faire croire à une absence
 * de terrasses là où c'est la donnée qui manque.
 */
import {
  bboxClause,
  BboxProvider,
  type BboxResult,
  type OverpassElement,
} from './overpass';
import type { Bounds } from '../sun/mercator';

/** En dessous, la requête couvre trop d'établissements pour Overpass. */
export const MIN_TERRACE_ZOOM = 15;

/**
 * Plafond du nombre de terrasses retenues.
 *
 * Dans un centre-ville dense la requête peut en ramener plusieurs milliers : la carte
 * deviendrait illisible et la liste inutilisable. Les terrasses confirmées passent
 * devant les probables au moment de couper.
 */
const MAX_TERRACES = 250;

const AMENITIES = ['cafe', 'bar', 'pub', 'restaurant', 'biergarten', 'ice_cream'] as const;

const KIND_LABELS: Record<string, string> = {
  cafe: 'Café',
  bar: 'Bar',
  pub: 'Pub',
  restaurant: 'Restaurant',
  biergarten: 'Brasserie en plein air',
  ice_cream: 'Glacier',
};

/** `confirmed` : `outdoor_seating=yes`. `likely` : établissement sans le tag. */
export type TerraceConfidence = 'confirmed' | 'likely';

export interface Terrace {
  id: string;
  name: string;
  /** Libellé français du type d'établissement. */
  kind: string;
  confidence: TerraceConfidence;
  lng: number;
  lat: number;
}

export type TerraceResult = BboxResult<Terrace[]>;

export const NO_TERRACES: Terrace[] = [];

function terraceQuery(bounds: Bounds): string {
  const bbox = bboxClause(bounds);
  const filter = `["amenity"~"^(${AMENITIES.join('|')})$"]`;
  // `out center` suffit : on n'a besoin que d'un point par établissement, pas de son
  // contour — c'est bien plus léger que `out geom`.
  return `[out:json][timeout:25];(node${filter}(${bbox});way${filter}(${bbox}););out center tags qt;`;
}

/** Position représentative d'un élément : le nœud lui-même, ou le centre du contour. */
function positionOf(element: OverpassElement): { lng: number; lat: number } | null {
  if (typeof element.lat === 'number' && typeof element.lon === 'number') {
    return { lng: element.lon, lat: element.lat };
  }
  if (element.center) return { lng: element.center.lon, lat: element.center.lat };

  const geometry = element.geometry;
  if (geometry && geometry.length > 0) {
    let sumLng = 0;
    let sumLat = 0;
    for (const p of geometry) {
      sumLng += p.lon;
      sumLat += p.lat;
    }
    return { lng: sumLng / geometry.length, lat: sumLat / geometry.length };
  }
  return null;
}

/**
 * Traduit les tags OSM en terrasses exploitables.
 *
 * `outdoor_seating=no` est une information, pas une absence : ces établissements sont
 * écartés, contrairement à ceux qui ne disent rien.
 */
export function terracesFromOverpass(elements: OverpassElement[]): Terrace[] {
  const terraces: Terrace[] = [];

  for (const element of elements) {
    const tags = element.tags;
    if (!tags) continue;

    const amenity = tags['amenity'];
    if (!amenity || !KIND_LABELS[amenity]) continue;

    const seating = tags['outdoor_seating'];
    if (seating === 'no') continue;

    const position = positionOf(element);
    if (!position) continue;

    const kind = KIND_LABELS[amenity] as string;
    terraces.push({
      id: `${element.type}/${element.id}`,
      name: tags['name']?.trim() || kind,
      kind,
      confidence: seating === undefined ? 'likely' : 'confirmed',
      lng: position.lng,
      lat: position.lat,
    });
  }

  // Les confirmées d'abord : si le plafond coupe, ce sont les probables qui tombent.
  terraces.sort((a, b) => Number(b.confidence === 'confirmed') - Number(a.confidence === 'confirmed'));
  return terraces.slice(0, MAX_TERRACES);
}

export function createTerraceProvider(
  onUpdate: (result: TerraceResult) => void,
): BboxProvider<Terrace[]> {
  return new BboxProvider<Terrace[]>({
    minZoom: MIN_TERRACE_ZOOM,
    empty: NO_TERRACES,
    buildQuery: terraceQuery,
    parse: terracesFromOverpass,
    onUpdate,
    // Les terrasses sont masquées tant que l'utilisateur ne les demande pas : inutile
    // de solliciter Overpass pour une couche invisible.
    startEnabled: false,
  });
}
