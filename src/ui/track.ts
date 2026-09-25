/**
 * Import d'une trace GPX, coloration soleil/ombre et profil d'ensoleillement.
 *
 * Le calcul repose sur `ShadowLayer.sweepTimes` : une passe de lancer de rayon par
 * tranche de dix minutes, puis lecture de l'état en chaque point de la trace à sa
 * propre heure de passage.
 */
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import {
  DEFAULT_SPEED_KMH,
  GpxError,
  parseGpx,
  passageTimes,
  trackBounds,
  trackDurationMinutes,
  type Track,
  type TrackPoint,
} from '../data/gpx';
import type { LngLatPoint, ShadowLayer } from '../shadow/ShadowLayer';
import { renderProfile, type ProfileColors, type ProfileSample, type SegmentState } from './trackProfile';
import { formatDuration, formatTime } from './format';
import { sameLocalDay } from '../sun/sun';

const SOURCE = 'track';
const LAYER = 'track-line';

/** Une passe de lancer de rayon par tranche : dix minutes suffisent pour une trace. */
const BUCKET_MINUTES = 10;

/** Au-delà, le balayage devient plus long que ce que l'utilisateur acceptera d'attendre. */
const MAX_BUCKETS = 90;

/**
 * Points conservés pour l'interrogation et le tracé.
 *
 * Une trace enregistrée peut compter des dizaines de milliers de points, bien au-delà
 * de la résolution du masque d'ombre : les sous-échantillonner ne perd aucune
 * information et allège tout le reste.
 */
const MAX_POINTS = 800;

function subsample(track: Track): { points: TrackPoint[]; cumulative: number[] } {
  const total = track.points.length;
  if (total <= MAX_POINTS) return { points: track.points, cumulative: track.cumulative };

  const points: TrackPoint[] = [];
  const cumulative: number[] = [];
  const stride = (total - 1) / (MAX_POINTS - 1);
  for (let i = 0; i < MAX_POINTS; i++) {
    const index = Math.round(i * stride);
    points.push(track.points[index] as TrackPoint);
    cumulative.push(track.cumulative[index] as number);
  }
  return { points, cumulative };
}

function segmentsFeature(
  points: readonly TrackPoint[],
  states: readonly SegmentState[],
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  let start = 0;

  for (let i = 1; i <= points.length; i++) {
    const endOfRun = i === points.length || states[i] !== states[start];
    if (!endOfRun) continue;

    // Le segment inclut le point suivant : sans ce recouvrement d'un point, la trace
    // afficherait un trou à chaque changement d'état.
    const end = Math.min(i, points.length - 1);
    if (end > start) {
      features.push({
        type: 'Feature',
        properties: { state: states[start] ?? 'unknown' },
        geometry: {
          type: 'LineString',
          coordinates: points.slice(start, end + 1).map((p) => [p.lng, p.lat]),
        },
      });
    }
    start = i;
  }
  return { type: 'FeatureCollection', features };
}

export interface TrackUiOptions {
  map: MapLibreMap;
  shadowLayer: ShadowLayer;
  root: HTMLElement;
  fileInput: HTMLInputElement;
  clearButton: HTMLButtonElement;
  departureInput: HTMLInputElement;
  speedInput: HTMLInputElement;
  speedOutput: HTMLOutputElement;
  profileHost: HTMLElement;
  statsHost: HTMLElement;
  messageHost: HTMLElement;
  colors: () => ProfileColors;
  currentDate: () => Date;
  onBusy: (busy: boolean) => void;
}

export function createTrackUi(options: TrackUiOptions) {
  const {
    map,
    shadowLayer,
    root,
    fileInput,
    clearButton,
    departureInput,
    speedInput,
    speedOutput,
    profileHost,
    statsHost,
    messageHost,
    colors,
    currentDate,
    onBusy,
  } = options;

  let track: Track | null = null;
  let sampled: { points: TrackPoint[]; cumulative: number[] } | null = null;
  let states: SegmentState[] = [];
  let recomputeTimer: ReturnType<typeof setTimeout> | null = null;
  let computing = false;
  /** Jour sur lequel portait le dernier calcul : les heures de passage en dépendent. */
  let computedDay: Date | null = null;
  /** Note sur l'origine des heures de passage, réaffichée après chaque calcul. */
  let sourceNote = '';

  const emptyCollection: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };

  const installLayers = () => {
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, { type: 'geojson', data: emptyCollection });
    }
    if (!map.getLayer(LAYER)) {
      const palette = colors();
      map.addLayer({
        id: LAYER,
        type: 'line',
        source: SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-width': 4,
          'line-color': [
            'match',
            ['get', 'state'],
            'sun',
            palette.sun,
            'shade',
            palette.shade,
            palette.unknown,
          ],
        },
      });
    }
    pushToMap();
  };

  const pushToMap = () => {
    const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(
      sampled && states.length === sampled.points.length
        ? segmentsFeature(sampled.points, states)
        : emptyCollection,
    );
  };

  const setMessage = (text: string, isError = false) => {
    messageHost.textContent = text;
    messageHost.hidden = text === '';
    messageHost.classList.toggle('is-error', isError);
  };

  const departureDate = (): Date => {
    const base = currentDate();
    const match = /^(\d{2}):(\d{2})$/.exec(departureInput.value);
    if (!match) return base;
    const date = new Date(base);
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return date;
  };

  const speed = (): number => {
    const value = Number(speedInput.value);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SPEED_KMH;
  };

  /**
   * Regroupe les instants de passage en tranches.
   *
   * Recalculer le masque pour chaque point de trace serait absurde : l'ombre ne bouge
   * pas de façon perceptible en moins de dix minutes.
   */
  const buildBuckets = (times: Date[]): { dates: Date[]; indexOf: number[] } => {
    const first = times[0]?.getTime() ?? Date.now();
    const last = times[times.length - 1]?.getTime() ?? first;
    const stepMs = BUCKET_MINUTES * 60000;
    const rawCount = Math.floor((last - first) / stepMs) + 1;
    const count = Math.max(1, Math.min(rawCount, MAX_BUCKETS));
    // Si le parcours dépasse le plafond, les tranches s'élargissent plutôt que d'être
    // tronquées : mieux vaut un profil un peu grossier qu'un profil incomplet.
    const effectiveStep = rawCount > MAX_BUCKETS ? (last - first) / (count - 1 || 1) : stepMs;

    const dates: Date[] = [];
    for (let i = 0; i < count; i++) dates.push(new Date(first + i * effectiveStep));

    const indexOf = times.map((time) => {
      const index = Math.round((time.getTime() - first) / (effectiveStep || 1));
      return Math.max(0, Math.min(count - 1, index));
    });
    return { dates, indexOf };
  };

  const renderStats = (times: Date[]) => {
    if (!track || !sampled) {
      statsHost.replaceChildren();
      return;
    }

    let sunMeters = 0;
    let knownMeters = 0;
    for (let i = 1; i < sampled.points.length; i++) {
      const length = (sampled.cumulative[i] as number) - (sampled.cumulative[i - 1] as number);
      const state = states[i - 1];
      if (state === 'unknown' || state === undefined) continue;
      knownMeters += length;
      if (state === 'sun') sunMeters += length;
    }

    const total = track.totalDistance;
    const share = knownMeters > 0 ? Math.round((sunMeters / knownMeters) * 100) : 0;
    const duration = trackDurationMinutes(track, speed());
    const arrival = times[times.length - 1];

    const km = (meters: number) => (meters / 1000).toLocaleString('fr-FR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });

    const items: [string, string][] = [
      ['Au soleil', `${share} % · ${km(sunMeters)} km`],
      ['Distance', `${km(total)} km`],
      ['Durée estimée', formatDuration(duration)],
      ['Arrivée', arrival ? formatTime(arrival) : '—'],
      ['Dénivelé', `+${Math.round(track.ascent)} m / −${Math.round(track.descent)} m`],
    ];

    statsHost.replaceChildren(
      ...items.map(([label, value]) => {
        const item = document.createElement('div');
        item.className = 'item';
        const key = document.createElement('span');
        key.className = 'item-label';
        key.textContent = label;
        const val = document.createElement('span');
        val.className = 'item-value';
        val.textContent = value;
        item.append(key, val);
        return item;
      }),
    );
  };

  const renderProfileStrip = (times: Date[]) => {
    if (!sampled) {
      profileHost.replaceChildren();
      return;
    }

    // Copie locale : le narrowing de `sampled` ne survit pas à la fermeture du map.
    const current = sampled;
    const samples: ProfileSample[] = current.points.map((point, i) => ({
      distance: current.cumulative[i] as number,
      elevation: point.elevation,
      state: states[i] ?? 'unknown',
      time: times[i] as Date,
    }));

    const { svg, sampleAt } = renderProfile(samples, colors());
    const tooltip = document.createElement('div');
    tooltip.className = 'profile-tooltip';
    tooltip.hidden = true;

    const figure = document.createElement('div');
    figure.className = 'profile-figure';
    figure.append(svg, tooltip);

    // Survol : une lecture point par point sans quoi le profil ne dit que des tendances.
    const onMove = (event: PointerEvent) => {
      const rect = figure.getBoundingClientRect();
      const fraction = (event.clientX - rect.left) / rect.width;
      const sample = sampleAt(fraction);
      if (!sample) return;
      const label =
        sample.state === 'sun' ? 'au soleil' : sample.state === 'shade' ? 'à l’ombre' : 'relief inconnu';
      tooltip.textContent =
        `${(sample.distance / 1000).toFixed(1)} km · ${formatTime(sample.time)} · ${label}` +
        (sample.elevation !== null ? ` · ${Math.round(sample.elevation)} m` : '');
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(0, Math.min(rect.width - 10, event.clientX - rect.left))}px`;
    };
    figure.addEventListener('pointermove', onMove);
    figure.addEventListener('pointerleave', () => {
      tooltip.hidden = true;
    });

    profileHost.replaceChildren(figure);
  };

  /** Relance le calcul complet : temps de passage, balayage, carte, profil, statistiques. */
  const recompute = async () => {
    if (!track || !sampled) return;
    // Une demande arrivée pendant un calcul n'est pas abandonnée : elle repasse après,
    // sans quoi un changement de jour survenu entre-temps ne serait jamais pris en compte.
    if (computing) {
      scheduleRecompute();
      return;
    }

    const departure = departureDate();
    computedDay = departure;
    const times = passageTimes(
      { ...track, points: sampled.points, cumulative: sampled.cumulative },
      departure,
      speed(),
    );
    const { dates, indexOf } = buildBuckets(times);

    computing = true;
    onBusy(true);
    setMessage('Calcul du profil d’ensoleillement…');

    const points: LngLatPoint[] = sampled.points.map((p) => ({ lng: p.lng, lat: p.lat }));
    const { sunlit } = await shadowLayer.sweepTimes(dates, points);

    computing = false;
    onBusy(false);

    // Balayage remplacé par un plus récent : le résultat en cours n'a plus d'intérêt.
    if (sunlit.length === 0) {
      computedDay = null;
      return;
    }

    states = points.map((_, i) => {
      const value = sunlit[indexOf[i] ?? 0]?.[i];
      return value === null || value === undefined ? 'unknown' : value ? 'sun' : 'shade';
    });

    setMessage(sourceNote);
    pushToMap();
    renderProfileStrip(times);
    renderStats(times);
  };

  const scheduleRecompute = () => {
    if (recomputeTimer) clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => {
      recomputeTimer = null;
      void recompute();
    }, 250);
  };

  const load = async (file: File) => {
    try {
      const parsed = parseGpx(await file.text());
      track = parsed;
      sampled = subsample(parsed);
      states = sampled.points.map(() => 'unknown');
      root.dataset['loaded'] = 'true';

      const bounds = trackBounds(parsed);
      map.fitBounds(
        [
          [bounds.west, bounds.south],
          [bounds.east, bounds.north],
        ],
        { padding: 48, maxZoom: 16 },
      );

      // L'heure de départ suit celle de la trace quand elle en porte une.
      const firstTime = parsed.points[0]?.time;
      if (firstTime) {
        const pad = (n: number) => String(n).padStart(2, '0');
        departureInput.value = `${pad(firstTime.getHours())}:${pad(firstTime.getMinutes())}`;
      }

      sourceNote = parsed.hasTimestamps
        ? 'Horodatages du fichier utilisés pour les heures de passage.'
        : 'Fichier sans horodatage : les heures de passage viennent de la vitesse choisie.';
      setMessage(sourceNote);

      // Le champ de hauteur doit d'abord couvrir la trace : on laisse la carte finir
      // son recadrage avant de lancer le balayage.
      map.once('moveend', () => void recompute());
    } catch (error) {
      const message =
        error instanceof GpxError ? error.message : "Ce fichier n'a pas pu être lu comme un GPX.";
      setMessage(message, true);
    }
  };

  const clear = () => {
    track = null;
    computedDay = null;
    sampled = null;
    states = [];
    delete root.dataset['loaded'];
    fileInput.value = '';
    sourceNote = '';
    pushToMap();
    profileHost.replaceChildren();
    statsHost.replaceChildren();
    setMessage('');
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void load(file);
  });
  clearButton.addEventListener('click', clear);
  departureInput.addEventListener('change', scheduleRecompute);
  speedInput.addEventListener('input', () => {
    speedOutput.textContent = `${speed()} km/h`;
    scheduleRecompute();
  });

  // Glisser-déposer sur la carte : le geste le plus direct pour ouvrir une trace.
  const container = map.getContainer();
  const stop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  container.addEventListener('dragover', (event) => {
    stop(event);
    container.classList.add('is-drop-target');
  });
  container.addEventListener('dragleave', () => container.classList.remove('is-drop-target'));
  container.addEventListener('drop', (event) => {
    stop(event);
    container.classList.remove('is-drop-target');
    const file = event.dataTransfer?.files?.[0];
    if (file) void load(file);
  });

  return {
    installLayers,
    /**
     * À appeler quand la date change. Les heures de passage ne dépendent que du jour et de
     * l'heure de départ saisie : un changement d'heure dans la même journée — l'horloge
     * temps réel en fait un par minute — ne change rien au profil, et relancerait pour
     * rien un balayage complet.
     */
    onDateChange(): void {
      if (!track) return;
      if (computedDay && sameLocalDay(computedDay, currentDate())) return;
      scheduleRecompute();
    },
    hasTrack: () => track !== null,
  };
}
