/**
 * Popup affichée au clic sur la carte : soleil ou ombre ici et maintenant, altitude,
 * durée d'ensoleillement, et trait indiquant la direction du soleil (utile en photo
 * pour anticiper le contre-jour).
 */
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, LineString } from 'geojson';
import { sunPosition, sunDirection } from '../sun/sun';
import { metersPerMercatorUnit } from '../sun/mercator';
import { formatDuration, formatElevation } from './format';
import type { PointQuery } from '../shadow/ShadowLayer';

const SUN_LINE_SOURCE = 'sun-line';
const SUN_LINE_LAYER = 'sun-line-layer';
const SUN_LINE_LENGTH_METERS = 400;

function buildPopupHtml(query: PointQuery, daylight: boolean): string {
  const rows: [string, string][] = [];

  if (query.sunMinutes !== null) {
    rows.push(['Soleil ce jour', formatDuration(query.sunMinutes)]);
  } else if (!daylight) {
    rows.push(['État', 'nuit']);
  } else if (!query.hasData) {
    rows.push(['État', 'relief inconnu ici']);
  } else {
    rows.push(['État', query.inShade ? 'à l’ombre' : 'au soleil']);
  }

  rows.push(['Altitude', formatElevation(query.elevation)]);

  const title = query.sunMinutes !== null
    ? 'Ensoleillement'
    : query.inShade || !daylight
      ? '🌑 À l’ombre'
      : '☀️ Au soleil';

  const body = rows
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join('');

  return `<div class="point-popup"><h2>${title}</h2><dl>${body}</dl></div>`;
}

/**
 * Trace un segment depuis le point cliqué vers le soleil.
 *
 * Le décalage est calculé en Mercator : la composante nord est divisée par le facteur
 * d'échelle local, sans quoi le trait serait trop court en latitude aux hautes latitudes.
 */
function sunLineFeature(lng: number, lat: number, date: Date): Feature<LineString> {
  const { azimuth, altitude } = sunPosition(date, lat, lng);
  const dir = sunDirection(azimuth);
  const metersPerUnit = metersPerMercatorUnit(lat);
  const lengthUnits = SUN_LINE_LENGTH_METERS / metersPerUnit;

  const dLng = dir.east * lengthUnits * 360;
  // 1 unité Mercator en y couvre 360° de « longueur d'arc Mercator » ; à cette échelle
  // l'approximation locale lat ≈ y * 360 * cos(lat) est largement suffisante.
  const dLat = dir.north * lengthUnits * 360 * Math.cos((lat * Math.PI) / 180);

  return {
    type: 'Feature',
    properties: { daylight: altitude > 0 },
    geometry: {
      type: 'LineString',
      coordinates: [
        [lng, lat],
        [lng + dLng, lat + dLat],
      ],
    },
  };
}

export interface PointInfoOptions {
  map: MapLibreMap;
  query: (lng: number, lat: number) => PointQuery | null;
  currentDate: () => Date;
}

export function createPointInfo({ map, query, currentDate }: PointInfoOptions) {
  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '260px' });
  let lastPoint: { lng: number; lat: number } | null = null;

  const ensureSunLineLayer = () => {
    if (!map.getSource(SUN_LINE_SOURCE)) {
      map.addSource(SUN_LINE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer(SUN_LINE_LAYER)) {
      map.addLayer({
        id: SUN_LINE_LAYER,
        type: 'line',
        source: SUN_LINE_SOURCE,
        paint: {
          'line-color': '#f0a500',
          'line-width': 3,
          'line-dasharray': [2, 1.5],
          'line-opacity': 0.9,
        },
      });
    }
  };

  const setSunLine = (lng: number, lat: number) => {
    ensureSunLineLayer();
    const source = map.getSource(SUN_LINE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: [sunLineFeature(lng, lat, currentDate())],
    });
  };

  const clearSunLine = () => {
    const source = map.getSource(SUN_LINE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features: [] });
  };

  const show = (lng: number, lat: number) => {
    const result = query(lng, lat);
    if (!result) return;
    lastPoint = { lng, lat };
    const { altitude } = sunPosition(currentDate(), lat, lng);
    popup.setLngLat([lng, lat]).setHTML(buildPopupHtml(result, altitude > 0)).addTo(map);
    setSunLine(lng, lat);
  };

  map.on('click', (event) => show(event.lngLat.lng, event.lngLat.lat));
  popup.on('close', () => {
    lastPoint = null;
    clearSunLine();
  });

  return {
    /** À rappeler quand l'heure change, pour que la popup ouverte reste juste. */
    refresh(): void {
      if (!lastPoint) return;
      show(lastPoint.lng, lastPoint.lat);
    },
    /** Après un changement de fond de carte, les sources ont disparu du style. */
    reinstall(): void {
      if (!lastPoint) return;
      setSunLine(lastPoint.lng, lastPoint.lat);
    },
  };
}
