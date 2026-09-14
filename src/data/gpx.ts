/**
 * Lecture d'une trace GPX et calcul des temps de passage.
 *
 * `DOMParser` suffit : le GPX est un XML simple et machine-généré, une dépendance de
 * parsing serait disproportionnée.
 */

export interface TrackPoint {
  lng: number;
  lat: number;
  /** Altitude en mètres si le fichier la porte. */
  elevation: number | null;
  /** Horodatage si le fichier en porte — le cas d'une trace enregistrée, pas d'un itinéraire tracé. */
  time: Date | null;
}

export interface Track {
  name: string | null;
  points: TrackPoint[];
  /** Distance depuis le départ, en mètres, un élément par point. */
  cumulative: number[];
  totalDistance: number;
  ascent: number;
  descent: number;
  /** Vrai si tous les points portent un horodatage exploitable. */
  hasTimestamps: boolean;
}

const EARTH_RADIUS = 6371008.8;

/** Distance orthodromique entre deux points, en mètres. */
export function haversine(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Seuil sous lequel une variation d'altitude est considérée comme du bruit.
 *
 * L'altitude GPS oscille de quelques mètres à l'arrêt ; sommer les écarts bruts
 * gonflerait le dénivelé d'un facteur deux ou trois sur une longue trace.
 */
const ELEVATION_NOISE_METERS = 3;

function elevationGain(points: readonly TrackPoint[]): { ascent: number; descent: number } {
  let ascent = 0;
  let descent = 0;
  let anchor: number | null = null;

  for (const point of points) {
    if (point.elevation === null) continue;
    if (anchor === null) {
      anchor = point.elevation;
      continue;
    }
    const delta = point.elevation - anchor;
    if (Math.abs(delta) < ELEVATION_NOISE_METERS) continue;
    if (delta > 0) ascent += delta;
    else descent -= delta;
    anchor = point.elevation;
  }
  return { ascent, descent };
}

function parseNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function childText(parent: Element, tag: string): string | null {
  // getElementsByTagName ignore les préfixes de namespace, contrairement à querySelector :
  // certains exports GPX préfixent leurs balises.
  const found = parent.getElementsByTagName(tag);
  return found.length > 0 ? (found[0]?.textContent ?? null) : null;
}

function pointsFrom(doc: Document, tag: string): TrackPoint[] {
  const points: TrackPoint[] = [];
  const nodes = doc.getElementsByTagName(tag);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    const lat = parseNumber(node.getAttribute('lat'));
    const lng = parseNumber(node.getAttribute('lon'));
    if (lat === null || lng === null) continue;

    const timeText = childText(node, 'time');
    const time = timeText ? new Date(timeText) : null;

    points.push({
      lat,
      lng,
      elevation: parseNumber(childText(node, 'ele')),
      time: time && !Number.isNaN(time.getTime()) ? time : null,
    });
  }
  return points;
}

export class GpxError extends Error {}

/**
 * Lit une trace GPX. Lève `GpxError` sur un fichier illisible ou sans point exploitable,
 * de façon à ce que l'interface puisse le dire clairement plutôt que d'afficher une
 * trace vide.
 */
export function parseGpx(xml: string): Track {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new GpxError("Ce fichier n'est pas un XML valide.");
  }

  // Une trace enregistrée utilise <trkpt> ; un itinéraire préparé, <rtept>.
  let points = pointsFrom(doc, 'trkpt');
  if (points.length === 0) points = pointsFrom(doc, 'rtept');
  if (points.length < 2) {
    throw new GpxError("Aucune trace exploitable dans ce fichier (il faut au moins deux points).");
  }

  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1] as TrackPoint;
    const current = points[i] as TrackPoint;
    cumulative.push((cumulative[i - 1] as number) + haversine(previous, current));
  }

  const { ascent, descent } = elevationGain(points);

  return {
    name: childText(doc.documentElement, 'name')?.trim() || null,
    points,
    cumulative,
    totalDistance: cumulative[cumulative.length - 1] ?? 0,
    ascent,
    descent,
    hasTimestamps: points.every((p) => p.time !== null),
  };
}

/** Vitesse par défaut en randonnée, en km/h. */
export const DEFAULT_SPEED_KMH = 4;

/**
 * Instant de passage en chaque point.
 *
 * Une trace enregistrée porte ses propres horodatages : on conserve alors le rythme
 * réel du parcours, simplement décalé vers l'heure de départ choisie. Sinon on répartit
 * le temps à vitesse constante sur la distance.
 */
export function passageTimes(
  track: Track,
  departure: Date,
  speedKmh: number = DEFAULT_SPEED_KMH,
): Date[] {
  const start = departure.getTime();

  if (track.hasTimestamps) {
    const first = (track.points[0]?.time as Date).getTime();
    return track.points.map((p) => new Date(start + ((p.time as Date).getTime() - first)));
  }

  const metersPerMs = (Math.max(speedKmh, 0.1) * 1000) / 3600000;
  return track.cumulative.map((distance) => new Date(start + distance / metersPerMs));
}

/** Durée totale du parcours en minutes, telle qu'utilisée pour les temps de passage. */
export function trackDurationMinutes(track: Track, speedKmh: number = DEFAULT_SPEED_KMH): number {
  if (track.hasTimestamps) {
    const first = track.points[0]?.time;
    const last = track.points[track.points.length - 1]?.time;
    if (first && last) return (last.getTime() - first.getTime()) / 60000;
  }
  return (track.totalDistance / 1000 / Math.max(speedKmh, 0.1)) * 60;
}

export interface TrackBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function trackBounds(track: Track): TrackBounds {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of track.points) {
    if (p.lng < west) west = p.lng;
    if (p.lng > east) east = p.lng;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  return { west, south, east, north };
}
