/**
 * Fonds de carte, tous accessibles sans clé d'API.
 *
 * Un fond pâle est préférable ici : l'overlay d'ombre est une couche sombre
 * semi-transparente, elle devient illisible sur un fond déjà chargé. Le fond clair
 * est donc le défaut, le fond sombre existe pour l'usage nocturne et le plan OSM
 * pour quand on a besoin des noms de rues et des numéros.
 */
import type { StyleSpecification } from 'maplibre-gl';

export type BasemapId = 'clair' | 'sombre' | 'plan';

export interface BasemapDefinition {
  id: BasemapId;
  label: string;
  style: StyleSpecification;
}

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CARTO_ATTRIBUTION = `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions">CARTO</a>`;

function rasterStyle(tiles: string[], attribution: string, maxzoom: number): StyleSpecification {
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles,
        tileSize: 256,
        maxzoom,
        attribution,
      },
    },
    layers: [
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
      },
    ],
  };
}

const cartoSubdomains = ['a', 'b', 'c', 'd'];

/**
 * CARTO exige une clé depuis fin août 2026 : sans elle, ses tuiles reviennent barrées
 * d'un filigrane « API KEY REQUIRED ». La clé se passe en `key=` — `api_key=` est
 * ignoré et renvoie la tuile filigranée. Absente, on garde l'URL nue : la carte reste
 * lisible, filigrane compris, plutôt que de ne rien afficher.
 */
function cartoTiles(variant: string): string[] {
  const key = import.meta.env.CARTO_BASEMAPS_API_KEY;
  const query = key ? `?key=${encodeURIComponent(key)}` : '';
  return cartoSubdomains.map(
    (s) => `https://${s}.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}.png${query}`,
  );
}

export const BASEMAPS: readonly BasemapDefinition[] = [
  {
    id: 'clair',
    label: 'Clair',
    style: rasterStyle(cartoTiles('light_all'), CARTO_ATTRIBUTION, 20),
  },
  {
    id: 'sombre',
    label: 'Sombre',
    style: rasterStyle(cartoTiles('dark_all'), CARTO_ATTRIBUTION, 20),
  },
  {
    id: 'plan',
    label: 'Plan OSM',
    style: rasterStyle(['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], OSM_ATTRIBUTION, 19),
  },
];

export function getBasemap(id: BasemapId): BasemapDefinition {
  return BASEMAPS.find((b) => b.id === id) ?? (BASEMAPS[0] as BasemapDefinition);
}
