/**
 * Empreintes et hauteurs de bâtiments, depuis OpenStreetMap.
 *
 * Le transport (miroirs, anti-rebond, cache par enveloppe, annulation) est mutualisé
 * dans `src/data/overpass.ts` ; ici on ne s'occupe que d'interpréter les tags et de
 * transformer les empreintes en triangles.
 */
import earcut from 'earcut';
import { latToMercatorY, lngToMercatorX, type Bounds } from '../sun/mercator';
import {
  bboxClause,
  BboxProvider,
  type BboxResult,
  type OverpassElement,
} from '../data/overpass';

/** En dessous, la densité de bâtiments rend la requête trop lourde pour Overpass. */
export const MIN_BUILDING_ZOOM = 15;

/** Hauteur retenue quand OSM ne dit rien : ordre de grandeur d'un immeuble de 2-3 niveaux. */
const DEFAULT_BUILDING_HEIGHT = 8;

/** Hauteur d'un niveau, en mètres, pour convertir `building:levels`. */
const METERS_PER_LEVEL = 3;

export interface BuildingMesh {
  /** Sommets des triangles, en Mercator normalisé, entrelacés x,y. */
  positions: Float32Array;
  /** Hauteur (et non altitude) de chaque sommet, en mètres. Constante par bâtiment. */
  heights: Float32Array;
  /** Un point intérieur par bâtiment, pour aller chercher l'altitude du terrain dessous. */
  anchors: { lng: number; lat: number; height: number; firstVertex: number; vertexCount: number }[];
}

export const EMPTY_MESH: BuildingMesh = {
  positions: new Float32Array(0),
  heights: new Float32Array(0),
  anchors: [],
};

/**
 * Interprète les tags de hauteur d'OSM.
 *
 * `height` est en mètres par convention, mais les contributions américaines utilisent
 * parfois les pieds (`40'`, `40 ft`) — d'où la conversion explicite.
 */
export function parseBuildingHeight(tags: Record<string, string> | undefined): number {
  if (!tags) return DEFAULT_BUILDING_HEIGHT;

  const raw = tags['height'] ?? tags['building:height'];
  if (raw) {
    const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*(.*)$/.exec(raw);
    if (match?.[1]) {
      const value = Number(match[1].replace(',', '.'));
      if (Number.isFinite(value) && value > 0) {
        const unit = (match[2] ?? '').trim().toLowerCase();
        const isFeet = unit === "'" || unit === 'ft' || unit === 'feet';
        return isFeet ? value * 0.3048 : value;
      }
    }
  }

  const levels = Number(tags['building:levels'] ?? tags['levels']);
  if (Number.isFinite(levels) && levels > 0) {
    return levels * METERS_PER_LEVEL;
  }

  return DEFAULT_BUILDING_HEIGHT;
}

function buildingQuery(bounds: Bounds): string {
  const bbox = bboxClause(bounds);
  // `out geom` renvoie la géométrie en ligne : pas besoin de résoudre les nœuds
  // séparément, ce qui divise par deux le volume transféré.
  return `[out:json][timeout:25];(way["building"](${bbox});relation["building"]["type"="multipolygon"](${bbox}););out geom qt;`;
}

/** Anneaux fermés d'un élément Overpass, en lng/lat. */
function ringsOf(element: OverpassElement): { lat: number; lon: number }[][] {
  if (element.type === 'way' && element.geometry) return [element.geometry];
  if (element.type === 'relation' && element.members) {
    return element.members
      .filter((m) => m.role === 'outer' && m.geometry && m.geometry.length >= 4)
      .map((m) => m.geometry as { lat: number; lon: number }[]);
  }
  return [];
}

export function meshFromOverpass(elements: OverpassElement[]): BuildingMesh {
  const positions: number[] = [];
  const heights: number[] = [];
  const anchors: BuildingMesh['anchors'] = [];

  for (const element of elements) {
    if (element.type === 'node') continue;
    const height = parseBuildingHeight(element.tags);

    for (const ring of ringsOf(element)) {
      if (ring.length < 4) continue;

      // earcut veut un tableau plat ; on retire le point de fermeture, qui ferait
      // un triangle dégénéré.
      const closed =
        ring[0]?.lat === ring[ring.length - 1]?.lat && ring[0]?.lon === ring[ring.length - 1]?.lon;
      const points = closed ? ring.slice(0, -1) : ring;
      if (points.length < 3) continue;

      const flat: number[] = [];
      let sumLng = 0;
      let sumLat = 0;
      for (const p of points) {
        flat.push(lngToMercatorX(p.lon), latToMercatorY(p.lat));
        sumLng += p.lon;
        sumLat += p.lat;
      }

      const indices = earcut(flat, undefined, 2);
      if (indices.length === 0) continue;

      const firstVertex = positions.length / 2;
      for (const i of indices) {
        positions.push(flat[i * 2] ?? 0, flat[i * 2 + 1] ?? 0);
        heights.push(height);
      }

      anchors.push({
        lng: sumLng / points.length,
        lat: sumLat / points.length,
        height,
        firstVertex,
        vertexCount: indices.length,
      });
    }
  }

  return {
    positions: new Float32Array(positions),
    heights: new Float32Array(heights),
    anchors,
  };
}

export type BuildingResult = BboxResult<BuildingMesh>;

/**
 * Fournisseur de bâtiments pour la vue courante.
 *
 * En dessous de `MIN_BUILDING_ZOOM`, la densité rend la requête trop lourde pour
 * Overpass : le provider renvoie alors un maillage vide avec le statut `zoomed-out`,
 * ce que l'interface traduit par une invitation à zoomer.
 */
export function createBuildingProvider(
  onUpdate: (result: BuildingResult) => void,
): BboxProvider<BuildingMesh> {
  return new BboxProvider<BuildingMesh>({
    minZoom: MIN_BUILDING_ZOOM,
    empty: EMPTY_MESH,
    buildQuery: buildingQuery,
    parse: meshFromOverpass,
    onUpdate,
  });
}
