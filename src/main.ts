/** Point d'entrée : assemble la carte, le moteur d'ombre et les contrôles. */
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';

import { createMap } from './map/createMap';
import { BASEMAPS, type BasemapId } from './map/style';
import { createStore, type AppState } from './state/appState';
import { ShadowLayer, type ShadowLayerState } from './shadow/ShadowLayer';
import { MIN_BUILDING_ZOOM } from './shadow/buildings';
import { createSunPanel } from './ui/sunPanel';
import { createSearchUi } from './ui/search';
import { createPointInfo } from './ui/pointInfo';
import { createTerracesUi } from './ui/terraces';
import { createTrackUi } from './ui/track';
import { onColorSchemeChange, stateColors } from './ui/palette';
import {
  formatDuration,
  formatMinutesOfDay,
  fromDateInputValue,
  minutesOfDay,
  toDateInputValue,
  withMinutesOfDay,
} from './ui/format';

/** Vitesse de l'animation : minutes simulées par seconde réelle. */
const ANIMATION_MINUTES_PER_SECOND = 240;

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Élément introuvable : #${id}`);
  return element as T;
}

function main(): void {
  const store = createStore();
  store.bindToLocationHash();

  const { map, setBasemap } = createMap(requireElement('map'), store);

  const banner = requireElement('banner');
  const showBanner = (message: string | null, tone: 'info' | 'error' = 'info') => {
    banner.textContent = message ?? '';
    banner.hidden = message === null;
    banner.dataset['tone'] = tone;
  };

  const setBusy = (label: string | null) => {
    busyLabel = label;
    if (engineState) renderEngineState(engineState);
    else showBanner(label);
  };

  // --- Moteur d'ombre -------------------------------------------------------

  const opacitySlider = requireElement<HTMLInputElement>('opacity-slider');
  const exposureRow = requireElement('exposure-progress-row');
  const exposureProgress = requireElement<HTMLProgressElement>('exposure-progress');
  const legend = requireElement('legend');
  const legendMax = requireElement('legend-max');

  let engineState: ShadowLayerState | null = null;
  /** Message posé par un calcul long (balayage de terrasses ou de parcours). */
  let busyLabel: string | null = null;

  const shadowLayer = new ShadowLayer({
    shadowColor: [0.05, 0.07, 0.18],
    opacity: Number(opacitySlider.value) / 100,
    onStatus: (state) => {
      engineState = state;
      renderEngineState(state);
    },
  });

  const renderEngineState = (state: ShadowLayerState) => {
    if (state.engine === 'unsupported') {
      showBanner(state.message, 'error');
      return;
    }

    const exposing = state.exposureProgress !== null && state.exposureProgress < 1;
    const sweeping = state.sweepProgress !== null;
    exposureRow.hidden = !exposing && !sweeping;
    exposureProgress.value = (sweeping ? state.sweepProgress : state.exposureProgress) ?? 0;

    if (store.get().mode === 'exposure') {
      legend.hidden = false;
      legendMax.textContent = formatDuration(state.maxExposureHours * 60);
    } else {
      legend.hidden = true;
    }

    if (exposing) {
      showBanner("Calcul des heures d'ensoleillement…");
    } else if (busyLabel) {
      showBanner(busyLabel);
    } else if (state.buildings === 'loading') {
      showBanner('Chargement des bâtiments…');
    } else if (state.buildings === 'error') {
      showBanner('Bâtiments indisponibles (Overpass ne répond pas). Le relief reste affiché.', 'error');
    } else if (state.buildings === 'zoomed-out' && map.getZoom() < MIN_BUILDING_ZOOM) {
      showBanner('Zoomez davantage pour voir les ombres des bâtiments.');
    } else {
      showBanner(null);
    }
  };

  // L'installation est déclenchée par `styledata` — émis dès que le style est analysé —
  // et non par `load`, qui attend en plus le chargement des tuiles du fond de carte.
  // Sans cela, un CDN de fond de carte injoignable (proxy d'entreprise, bloqueur de
  // contenu, coupure réseau) empêcherait la carte des ombres de s'afficher du tout,
  // alors qu'elle ne dépend que des tuiles d'élévation.
  // `styledata` est aussi ce qui permet de réinstaller la couche après un `setStyle`,
  // qui repart d'un style vierge.
  const installLayer = () => {
    try {
      if (!map.getLayer(shadowLayer.id)) map.addLayer(shadowLayer);
      // L'ordre compte : terrasses et trace se lisent par-dessus l'ombre.
      terraces.installLayers();
      trackUi.installLayers();
      pointInfo.reinstall();
    } catch (error) {
      // Le style n'est pas encore exploitable : le prochain `styledata` réessaiera.
      void error;
    }
  };

  // --- Popup et direction du soleil ----------------------------------------

  const pointInfo = createPointInfo({
    map,
    query: (lng, lat) => shadowLayer.queryPoint(lng, lat),
    currentDate: () => store.get().date,
  });

  // --- Terrasses au soleil --------------------------------------------------

  const terraces = createTerracesUi({
    map,
    shadowLayer,
    list: requireElement<HTMLUListElement>('terraces-list'),
    summary: requireElement('terraces-summary'),
    sweepButton: requireElement<HTMLButtonElement>('terraces-sweep'),
    currentDate: () => store.get().date,
    onBusy: (busy) => setBusy(busy ? 'Recherche des heures d’ensoleillement…' : null),
  });

  const terraceButtons = {
    off: requireElement<HTMLButtonElement>('terraces-off'),
    on: requireElement<HTMLButtonElement>('terraces-on'),
  };
  const setTerraces = (enabled: boolean) => {
    terraceButtons.on.setAttribute('aria-checked', String(enabled));
    terraceButtons.off.setAttribute('aria-checked', String(!enabled));
    terraces.setEnabled(enabled);
    if (enabled) terraces.onMove();
  };
  terraceButtons.on.addEventListener('click', () => setTerraces(true));
  terraceButtons.off.addEventListener('click', () => setTerraces(false));

  // --- Parcours GPX ---------------------------------------------------------

  const trackUi = createTrackUi({
    map,
    shadowLayer,
    root: requireElement('track-section'),
    fileInput: requireElement<HTMLInputElement>('track-file'),
    clearButton: requireElement<HTMLButtonElement>('track-clear'),
    departureInput: requireElement<HTMLInputElement>('track-departure'),
    speedInput: requireElement<HTMLInputElement>('track-speed'),
    speedOutput: requireElement<HTMLOutputElement>('track-speed-output'),
    profileHost: requireElement('track-profile'),
    statsHost: requireElement('track-stats'),
    messageHost: requireElement('track-message'),
    colors: stateColors,
    currentDate: () => store.get().date,
    onBusy: (busy) => setBusy(busy ? 'Calcul du profil du parcours…' : null),
  });

  map.on('moveend', () => terraces.onMove());

  // L'installation des couches est branchée seulement maintenant : `installLayer`
  // référence `terraces` et `trackUi`, qui viennent d'être créés.
  map.on('styledata', installLayer);
  installLayer();

  // MapLibre fige les couleurs de peinture à l'ajout de la couche : une bascule
  // clair/sombre doit forcer leur réinstallation.
  onColorSchemeChange(() => {
    for (const id of ['terraces-likely', 'terraces-confirmed', 'track-line']) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    installLayer();
  });

  // --- Contrôles temporels --------------------------------------------------

  const dateInput = requireElement<HTMLInputElement>('date-input');
  const timeSlider = requireElement<HTMLInputElement>('time-slider');
  const timeOutput = requireElement<HTMLOutputElement>('time-output');
  const playButton = requireElement<HTMLButtonElement>('play-button');
  const nowButton = requireElement<HTMLButtonElement>('now-button');
  const sunPanel = createSunPanel(requireElement('sun-info'));

  const syncTimeControls = (state: Readonly<AppState>) => {
    const minutes = minutesOfDay(state.date);
    dateInput.value = toDateInputValue(state.date);
    timeSlider.value = String(minutes);
    timeOutput.textContent = formatMinutesOfDay(minutes);
  };

  dateInput.addEventListener('change', () => {
    const next = fromDateInputValue(dateInput.value, store.get().date);
    if (next) store.set({ date: next });
  });

  const shiftDay = (days: number) => {
    const next = new Date(store.get().date);
    next.setDate(next.getDate() + days);
    store.set({ date: next });
  };
  requireElement('day-prev').addEventListener('click', () => shiftDay(-1));
  requireElement('day-next').addEventListener('click', () => shiftDay(1));

  timeSlider.addEventListener('input', () => {
    stopAnimation();
    store.set({ date: withMinutesOfDay(store.get().date, Number(timeSlider.value)) });
  });

  nowButton.addEventListener('click', () => {
    stopAnimation();
    store.set({ date: new Date() });
  });

  // --- Animation de la journée ---------------------------------------------

  let animationFrame: number | null = null;
  let lastFrameTime = 0;

  const stopAnimation = () => {
    if (animationFrame === null) return;
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
    playButton.setAttribute('aria-pressed', 'false');
    playButton.textContent = '▶ Animer la journée';
  };

  const tick = (now: number) => {
    const elapsedSeconds = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    const current = store.get().date;
    const advanced = new Date(current.getTime() + elapsedSeconds * ANIMATION_MINUTES_PER_SECOND * 60000);
    // Rebouclage sur la même journée : l'animation montre un cycle, pas une dérive
    // sur plusieurs jours.
    if (advanced.getDate() !== current.getDate()) {
      advanced.setTime(current.getTime());
      advanced.setHours(0, 0, 0, 0);
    }
    store.set({ date: advanced });

    animationFrame = requestAnimationFrame(tick);
  };

  playButton.addEventListener('click', () => {
    if (animationFrame !== null) {
      stopAnimation();
      return;
    }
    // L'accumulation d'ensoleillement repart de zéro à chaque changement d'heure :
    // l'animer n'aurait aucun sens et saturerait le GPU.
    if (store.get().mode === 'exposure') store.set({ mode: 'shadow' });
    playButton.setAttribute('aria-pressed', 'true');
    playButton.textContent = '⏸ Arrêter';
    lastFrameTime = performance.now();
    animationFrame = requestAnimationFrame(tick);
  });

  // --- Mode d'affichage -----------------------------------------------------

  const modeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-mode]'),
  );
  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      stopAnimation();
      store.set({ mode: button.dataset['mode'] === 'exposure' ? 'exposure' : 'shadow' });
    });
  }

  const syncModeButtons = (state: Readonly<AppState>) => {
    for (const button of modeButtons) {
      button.setAttribute('aria-checked', String(button.dataset['mode'] === state.mode));
    }
  };

  // --- Fond de carte --------------------------------------------------------

  const basemapGroup = requireElement('basemap-group');
  let currentBasemap: BasemapId = 'clair';
  basemapGroup.replaceChildren(
    ...BASEMAPS.map((basemap) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(basemap.id === currentBasemap));
      button.textContent = basemap.label;
      button.addEventListener('click', () => {
        if (basemap.id === currentBasemap) return;
        currentBasemap = basemap.id;
        setBasemap(basemap.id);
        for (const other of basemapGroup.querySelectorAll('button')) {
          other.setAttribute('aria-checked', String(other === button));
        }
      });
      return button;
    }),
  );

  opacitySlider.addEventListener('input', () => {
    shadowLayer.setAppearance('#0d1230', Number(opacitySlider.value) / 100);
  });

  // --- Recherche ------------------------------------------------------------

  createSearchUi({
    form: requireElement<HTMLFormElement>('search-form'),
    input: requireElement<HTMLInputElement>('search-input'),
    list: requireElement<HTMLUListElement>('search-results'),
    onPick: (result) => {
      if (result.boundingBox) {
        const [south, north, west, east] = result.boundingBox;
        map.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { maxZoom: 17, padding: 60 },
        );
      } else {
        map.flyTo({ center: [result.lng, result.lat], zoom: Math.max(map.getZoom(), 16) });
      }
    },
    onError: (message) => showBanner(message, 'error'),
  });

  // --- Panneau repliable sur mobile ----------------------------------------

  const panel = requireElement('panel');
  const panelToggle = requireElement<HTMLButtonElement>('panel-toggle');

  // Sur un écran étroit, le panneau déplié masque la moitié de la carte. On part donc
  // replié : l'utilisateur vient d'abord pour voir la carte.
  if (window.matchMedia('(max-width: 720px)').matches) {
    panel.dataset['collapsed'] = 'true';
    panelToggle.setAttribute('aria-expanded', 'false');
  }

  panelToggle.addEventListener('click', () => {
    const collapsed = panel.dataset['collapsed'] === 'true';
    panel.dataset['collapsed'] = String(!collapsed);
    panelToggle.setAttribute('aria-expanded', String(collapsed));
  });

  // --- Propagation de l'état ------------------------------------------------

  const applyState = (state: Readonly<AppState>, changed?: ReadonlySet<keyof AppState>) => {
    if (!changed || changed.has('date')) {
      syncTimeControls(state);
      shadowLayer.setDate(state.date);
      pointInfo.refresh();
      terraces.refreshStates();
      trackUi.onDateChange();
    }
    if (!changed || changed.has('mode')) {
      syncModeButtons(state);
      shadowLayer.setMode(state.mode);
      if (engineState) renderEngineState(engineState);
    }
    if (!changed || changed.has('date') || changed.has('lat') || changed.has('lng')) {
      sunPanel.update(state.date, state.lat, state.lng);
    }
  };

  store.subscribe(applyState);
  applyState(store.get());
}

main();
