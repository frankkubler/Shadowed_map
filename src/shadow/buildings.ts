/**
 * Empreintes et hauteurs de bâtiments, depuis OpenStreetMap via l'API Overpass.
 *
 * Overpass est un service bénévole et fragile : toute la logique de ce fichier vise
 * à en faire un usage sobre — une requête par déplacement significatif, résultats
 * réutilisés tant que la nouvelle vue tient dans une enveloppe déjà téléchargée,
 * annulation des requêtes obsolètes, et bascule sur un miroir en cas d'échec.
 */
import earcut from 'earcut';
import { latToMercatorY, lngToMercatorX, type Bounds } from '../sun/mercator';

/** Miroirs essayés dans l'ordre. Le premier qui répond gagne. */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

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

interface OverpassElement {
  type: 'way' | 'relation' | 'node';
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

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

function buildOverpassQuery(bounds: Bounds): string {
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east]
    .map((v) => v.toFixed(6))
    .join(',');
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

function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.west <= inner.west &&
    outer.south <= inner.south &&
    outer.east >= inner.east &&
    outer.north >= inner.north
  );
}

function padBounds(bounds: Bounds, ratio: number): Bounds {
  const dLng = (bounds.east - bounds.west) * ratio;
  const dLat = (bounds.north - bounds.south) * ratio;
  return {
    west: bounds.west - dLng,
    east: bounds.east + dLng,
    south: bounds.south - dLat,
    north: bounds.north + dLat,
  };
}

export type BuildingStatus = 'idle' | 'loading' | 'ready' | 'error' | 'zoomed-out';

export interface BuildingResult {
  mesh: BuildingMesh;
  bounds: Bounds | null;
  status: BuildingStatus;
}

/**
 * Récupère les bâtiments pour une vue, en réutilisant autant que possible ce qui a
 * déjà été téléchargé.
 *
 * La zone demandée est élargie de 40 % : on paie un peu plus de données une fois,
 * mais un déplacement modéré de la carte ne redéclenche aucune requête.
 */
export class BuildingProvider {
  private cachedBounds: Bounds | null = null;
  private cachedMesh: BuildingMesh = EMPTY_MESH;
  private controller: AbortController | null = null;
  private status: BuildingStatus = 'idle';
  private endpointIndex = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onUpdate: (result: BuildingResult) => void,
    private readonly debounceMs = 800,
  ) {}

  current(): BuildingResult {
    return { mesh: this.cachedMesh, bounds: this.cachedBounds, status: this.status };
  }

  /** À appeler après chaque déplacement de carte. Ne déclenche une requête que si nécessaire. */
  request(bounds: Bounds, zoom: number): void {
    if (zoom < MIN_BUILDING_ZOOM) {
      this.cancel();
      if (this.cachedMesh !== EMPTY_MESH || this.status !== 'zoomed-out') {
        this.cachedMesh = EMPTY_MESH;
        this.cachedBounds = null;
        this.status = 'zoomed-out';
        this.onUpdate(this.current());
      }
      return;
    }

    if (this.cachedBounds && boundsContain(this.cachedBounds, bounds)) return;

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fetchNow(padBounds(bounds, 0.4));
    }, this.debounceMs);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  private async fetchNow(bounds: Bounds): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    this.status = 'loading';
    this.onUpdate(this.current());

    const query = buildOverpassQuery(bounds);

    // On essaie chaque miroir une fois, en repartant de celui qui a marché la
    // dernière fois pour ne pas retomber systématiquement sur un serveur saturé.
    for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
      const index = (this.endpointIndex + attempt) % OVERPASS_ENDPOINTS.length;
      const endpoint = OVERPASS_ENDPOINTS[index];
      if (!endpoint) continue;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal,
        });
        if (!response.ok) continue;

        const json = (await response.json()) as { elements?: OverpassElement[] };
        if (controller.signal.aborted) return;

        this.endpointIndex = index;
        this.cachedMesh = meshFromOverpass(json.elements ?? []);
        this.cachedBounds = bounds;
        this.status = 'ready';
        this.controller = null;
        this.onUpdate(this.current());
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        // Miroir suivant.
        void error;
      }
    }

    if (controller.signal.aborted) return;
    this.controller = null;
    this.status = 'error';
    this.onUpdate(this.current());
  }
}
