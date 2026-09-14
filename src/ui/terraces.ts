/**
 * Terrasses au soleil : couche de points sur la carte et liste triée dans le panneau.
 *
 * L'état soleil/ombre de chaque terrasse est lu dans le masque déjà calculé par le
 * moteur — aucun calcul supplémentaire pour l'affichage courant. Seul le « jusqu'à
 * quand ? » déclenche un balayage horaire, et seulement à la demande.
 */
import { Popup, type ExpressionSpecification, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, Point } from 'geojson';
import {
  createTerraceProvider,
  MIN_TERRACE_ZOOM,
  NO_TERRACES,
  type Terrace,
  type TerraceResult,
} from '../data/terraces';
import type { LngLatPoint, ShadowLayer } from '../shadow/ShadowLayer';
import { sunTimes } from '../sun/sun';
import { formatTime } from './format';
import { stateColors } from './palette';

const SOURCE = 'terraces';
const LAYER_LIKELY = 'terraces-likely';
const LAYER_CONFIRMED = 'terraces-confirmed';

/** Pas du balayage « jusqu'à quand ? », en minutes. */
const SWEEP_STEP_MINUTES = 10;

type SunState = 'sun' | 'shade' | 'unknown';

interface TerraceRow {
  terrace: Terrace;
  state: SunState;
  /** Instant où la terrasse bascule à l'ombre, une fois le balayage fait. */
  sunUntil: Date | null;
  /** Vrai si elle est encore au soleil au coucher. */
  sunlitUntilSunset: boolean;
}

/** Expression de peinture MapLibre associant chaque état à sa couleur validée. */
function colorByState(): ExpressionSpecification {
  const palette = stateColors();
  return ['match', ['get', 'state'], 'sun', palette.sun, 'shade', palette.shade, palette.unknown];
}

export interface TerracesUiOptions {
  map: MapLibreMap;
  shadowLayer: ShadowLayer;
  list: HTMLElement;
  summary: HTMLElement;
  sweepButton: HTMLButtonElement;
  currentDate: () => Date;
  onBusy: (busy: boolean) => void;
}

function toFeature(row: TerraceRow): Feature<Point> {
  return {
    type: 'Feature',
    id: row.terrace.id,
    geometry: { type: 'Point', coordinates: [row.terrace.lng, row.terrace.lat] },
    properties: {
      state: row.state,
      confidence: row.terrace.confidence,
      name: row.terrace.name,
    },
  };
}

export function createTerracesUi({
  map,
  shadowLayer,
  list,
  summary,
  sweepButton,
  currentDate,
  onBusy,
}: TerracesUiOptions) {
  let rows: TerraceRow[] = [];
  let status: TerraceResult['status'] = 'disabled';
  let enabled = false;
  let sweeping = false;

  // Attention : ce rappel peut être déclenché dès la construction du provider. Il ne
  // doit donc toucher à rien qui soit déclaré plus bas dans cette fonction.
  const provider = createTerraceProvider((result) => {
    status = result.status;
    rows = (result.data ?? NO_TERRACES).map((terrace) => ({
      terrace,
      state: 'unknown' as SunState,
      sunUntil: null,
      sunlitUntilSunset: false,
    }));
    refresh();
  });

  const collection = (): FeatureCollection<Point> => ({
    type: 'FeatureCollection',
    features: rows.map(toFeature),
  });

  const installLayers = () => {
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, { type: 'geojson', data: collection() });
    }
    // Les probables d'abord, en contour seul : elles ne doivent pas masquer les
    // terrasses réellement cartographiées comme telles.
    if (!map.getLayer(LAYER_LIKELY)) {
      map.addLayer({
        id: LAYER_LIKELY,
        type: 'circle',
        source: SOURCE,
        filter: ['==', ['get', 'confidence'], 'likely'],
        paint: {
          'circle-radius': 4,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-width': 2,
          'circle-stroke-color': colorByState(),
          'circle-stroke-opacity': 0.85,
        },
      });
    }
    if (!map.getLayer(LAYER_CONFIRMED)) {
      map.addLayer({
        id: LAYER_CONFIRMED,
        type: 'circle',
        source: SOURCE,
        filter: ['==', ['get', 'confidence'], 'confirmed'],
        paint: {
          'circle-radius': 6,
          'circle-color': colorByState(),
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
    }
    setLayerVisibility();
  };

  const setLayerVisibility = () => {
    const visibility = enabled ? 'visible' : 'none';
    for (const id of [LAYER_LIKELY, LAYER_CONFIRMED]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
  };

  const pushToMap = () => {
    const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
    source?.setData(collection());
  };

  /** Relit l'état soleil/ombre dans le masque courant, sans recalcul. */
  const updateStates = () => {
    if (rows.length === 0) return;
    const points: LngLatPoint[] = rows.map((r) => ({ lng: r.terrace.lng, lat: r.terrace.lat }));
    const sunlit = shadowLayer.queryPoints(points);
    rows.forEach((row, i) => {
      const value = sunlit[i];
      row.state = value === null || value === undefined ? 'unknown' : value ? 'sun' : 'shade';
    });
  };

  const describe = (row: TerraceRow): string => {
    if (row.state === 'unknown') return 'relief inconnu';
    if (row.state === 'shade') return 'à l’ombre';
    if (row.sunlitUntilSunset) return 'au soleil jusqu’au coucher';
    if (row.sunUntil) return `au soleil jusqu’à ${formatTime(row.sunUntil)}`;
    return 'au soleil';
  };

  const renderList = () => {
    if (!enabled) {
      list.replaceChildren();
      summary.textContent = '';
      return;
    }

    if (status === 'loading') {
      summary.textContent = 'Recherche des terrasses…';
      list.replaceChildren();
      return;
    }
    if (status === 'zoomed-out') {
      summary.textContent = `Zoomez (niveau ${MIN_TERRACE_ZOOM}) pour chercher des terrasses.`;
      list.replaceChildren();
      return;
    }
    if (status === 'error') {
      summary.textContent = 'Overpass ne répond pas ; réessayez dans un instant.';
      list.replaceChildren();
      return;
    }
    if (rows.length === 0) {
      // Fréquent : OSM ne cartographie pas partout les cafés et restaurants.
      summary.textContent = 'Aucune terrasse cartographiée dans cette vue.';
      list.replaceChildren();
      return;
    }

    const inSun = rows.filter((r) => r.state === 'sun').length;
    summary.textContent = `${inSun} terrasse${inSun > 1 ? 's' : ''} au soleil sur ${rows.length}`;

    // Au soleil d'abord, puis les confirmées, puis par nom : l'utilisateur cherche
    // où s'asseoir maintenant, pas un inventaire.
    const sorted = [...rows].sort((a, b) => {
      const rank = (r: TerraceRow) => (r.state === 'sun' ? 0 : r.state === 'shade' ? 2 : 3);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const confidence = (r: TerraceRow) => (r.terrace.confidence === 'confirmed' ? 0 : 1);
      if (confidence(a) !== confidence(b)) return confidence(a) - confidence(b);
      return a.terrace.name.localeCompare(b.terrace.name, 'fr');
    });

    list.replaceChildren(
      ...sorted.slice(0, 40).map((row) => {
        const item = document.createElement('li');
        item.className = `terrace terrace-${row.state}`;

        const button = document.createElement('button');
        button.type = 'button';

        const name = document.createElement('span');
        name.className = 'terrace-name';
        name.textContent = row.terrace.name;

        const meta = document.createElement('span');
        meta.className = 'terrace-meta';
        meta.textContent =
          row.terrace.confidence === 'likely'
            ? `${row.terrace.kind} · ${describe(row)} · terrasse non confirmée`
            : `${row.terrace.kind} · ${describe(row)}`;

        button.append(name, meta);
        button.addEventListener('click', () => {
          map.flyTo({ center: [row.terrace.lng, row.terrace.lat], zoom: Math.max(map.getZoom(), 17) });
          new Popup({ closeButton: true, maxWidth: '240px' })
            .setLngLat([row.terrace.lng, row.terrace.lat])
            .setHTML(
              `<div class="point-popup"><h2>${row.terrace.name}</h2>` +
                `<dl><dt>Type</dt><dd>${row.terrace.kind}</dd>` +
                `<dt>État</dt><dd>${describe(row)}</dd></dl></div>`,
            )
            .addTo(map);
        });

        item.append(button);
        return item;
      }),
    );
  };

  const refresh = () => {
    updateStates();
    pushToMap();
    renderList();
    sweepButton.disabled = !enabled || rows.length === 0 || sweeping;
  };

  /**
   * Balaie la fin de journée pour dire jusqu'à quand chaque terrasse reste au soleil.
   *
   * Lancé à la demande : un balayage coûte une passe de lancer de rayon par pas de dix
   * minutes, ce qu'il serait déraisonnable de refaire à chaque déplacement de carte.
   */
  const computeSunUntil = async () => {
    if (rows.length === 0 || sweeping) return;

    const now = currentDate();
    const center = map.getCenter();
    const sunset = sunTimes(now, center.lat, center.lng).sunset;
    if (!sunset || sunset.getTime() <= now.getTime()) {
      summary.textContent = 'Le soleil est déjà couché ici.';
      return;
    }

    const dates: Date[] = [];
    for (let t = now.getTime(); t <= sunset.getTime(); t += SWEEP_STEP_MINUTES * 60000) {
      dates.push(new Date(t));
    }

    sweeping = true;
    sweepButton.disabled = true;
    onBusy(true);

    const points: LngLatPoint[] = rows.map((r) => ({ lng: r.terrace.lng, lat: r.terrace.lat }));
    const { sunlit } = await shadowLayer.sweepTimes(dates, points);

    sweeping = false;
    onBusy(false);

    // Un balayage annulé par un plus récent renvoie un résultat vide : ne rien écraser.
    if (sunlit.length === 0) return;

    rows.forEach((row, index) => {
      // Le balayage reconstruit le champ avec une marge omnidirectionnelle, donc à une
      // résolution un peu différente du masque affiché. Pour ne pas afficher « au
      // soleil » à côté d'un horaire qui dit le contraire, c'est le balayage qui fait
      // foi une fois lancé : son premier instant est l'heure courante.
      const atDeparture = sunlit[0]?.[index];
      if (atDeparture !== null && atDeparture !== undefined) {
        row.state = atDeparture ? 'sun' : 'shade';
      }

      let last: Date | null = null;
      let stillSunlit = true;
      for (let t = 0; t < sunlit.length; t++) {
        if (sunlit[t]?.[index] === true) last = dates[t] ?? last;
        else if (last !== null) {
          stillSunlit = false;
          break;
        }
      }
      row.sunUntil = last;
      row.sunlitUntilSunset = last !== null && stillSunlit;
    });

    pushToMap();
    renderList();
    sweepButton.disabled = rows.length === 0;
  };

  sweepButton.addEventListener('click', () => void computeSunUntil());

  return {
    installLayers,
    setEnabled(next: boolean): void {
      enabled = next;
      provider.setEnabled(next);
      setLayerVisibility();
      if (!next) {
        rows = [];
        pushToMap();
      }
      refresh();
    },
    /** À appeler après chaque déplacement de carte. */
    onMove(): void {
      if (!enabled) return;
      const b = map.getBounds();
      provider.request(
        { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
        map.getZoom(),
      );
    },
    /** À appeler quand l'heure change : l'état soleil/ombre a bougé, pas la liste. */
    refreshStates(): void {
      if (!enabled) return;
      // Les horaires calculés valaient pour l'ancienne heure de référence.
      for (const row of rows) {
        row.sunUntil = null;
        row.sunlitUntilSunset = false;
      }
      refresh();
    },
  };
}
