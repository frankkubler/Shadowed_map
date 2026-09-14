/** Initialisation de la carte MapLibre et synchronisation bidirectionnelle avec le store. */
import {
  AttributionControl,
  GeolocateControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Store } from '../state/appState';
import { getBasemap, type BasemapId } from './style';

// Depuis la v6, MapLibre charge son worker via `import.meta.url`, que les bundlers ne
// résolvent pas jusqu'au fichier : sans cet appel, aucune tuile n'est décodée — fond de
// carte vide et couche d'ombre absente. `?worker&url` (et non `?url`) est indispensable,
// le worker important lui-même `maplibre-gl-shared.mjs`.
setWorkerUrl(workerUrl);

export interface MapHandle {
  map: MapLibreMap;
  setBasemap: (id: BasemapId) => void;
}

export function createMap(container: HTMLElement, store: Store): MapHandle {
  const initial = store.get();

  const map = new MapLibreMap({
    container,
    style: getBasemap('clair').style,
    center: [initial.lng, initial.lat],
    zoom: initial.zoom,
    bearing: initial.bearing,
    pitch: initial.pitch,
    maxPitch: 85,
    hash: false, // le hash est géré par le store, qui y stocke aussi la date
    attributionControl: false,
  });

  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(
    new GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }),
    'bottom-right',
  );
  map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

  // Carte -> store. `applyingFromStore` coupe la boucle de rétroaction quand c'est
  // le store qui vient de déplacer la carte.
  let applyingFromStore = false;
  const syncFromMap = () => {
    if (applyingFromStore) return;
    const center = map.getCenter();
    store.set({
      lat: center.lat,
      lng: center.lng,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    });
  };
  map.on('move', syncFromMap);
  map.on('rotate', syncFromMap);
  map.on('pitch', syncFromMap);

  // Store -> carte, uniquement pour les changements qui ne viennent pas de la carte
  // (lien partagé, recherche d'adresse, navigation arrière).
  store.subscribe((state, changed) => {
    const viewChanged =
      changed.has('lat') || changed.has('lng') || changed.has('zoom') || changed.has('bearing') || changed.has('pitch');
    if (!viewChanged) return;

    const center = map.getCenter();
    const alreadyThere =
      Math.abs(center.lat - state.lat) < 1e-6 &&
      Math.abs(center.lng - state.lng) < 1e-6 &&
      Math.abs(map.getZoom() - state.zoom) < 1e-3;
    if (alreadyThere) return;

    applyingFromStore = true;
    map.jumpTo({
      center: [state.lng, state.lat],
      zoom: state.zoom,
      bearing: state.bearing,
      pitch: state.pitch,
    });
    applyingFromStore = false;
  });

  const setBasemap = (id: BasemapId) => {
    // setStyle retire toutes les couches, y compris la couche d'ombre : on la
    // réinstalle sur l'évènement `styledata` émis juste après.
    map.setStyle(getBasemap(id).style, { diff: false });
  };

  return { map, setBasemap };
}
