/**
 * Position du soleil et horaires remarquables, au-dessus de SunCalc.
 *
 * Convention SunCalc, source de la plupart des erreurs de signe dans ce genre de code :
 *   - `altitude` : hauteur au-dessus de l'horizon, en radians. Négative la nuit.
 *   - `azimuth`  : mesuré **depuis le sud, positif vers l'ouest**, en radians.
 *
 * On ne manipule jamais l'azimut brut ailleurs dans le projet : tout passe par
 * `sunDirection()` (vecteur unitaire vers le soleil) et `shadowDirection()`.
 */
import SunCalc from 'suncalc';

/** Hauteur du soleil sous laquelle on considère qu'il n'y a plus d'ombre utile. */
export const MIN_USEFUL_ALTITUDE_RAD = (1.5 * Math.PI) / 180;

export interface SunPosition {
  /** Hauteur au-dessus de l'horizon, en radians. */
  altitude: number;
  /** Azimut SunCalc : depuis le sud, positif vers l'ouest, en radians. */
  azimuth: number;
}

export interface Direction {
  /** Composante est du vecteur horizontal unitaire (positif = vers l'est). */
  east: number;
  /** Composante nord du vecteur horizontal unitaire (positif = vers le nord). */
  north: number;
}

export function sunPosition(date: Date, lat: number, lng: number): SunPosition {
  const { altitude, azimuth } = SunCalc.getPosition(date, lat, lng);
  return { altitude, azimuth };
}

/**
 * Vecteur horizontal unitaire pointant **vers** le soleil.
 *
 * Vérification des cas limites : azimut 0 → soleil au sud → (0, -1) ;
 * azimut +π/2 → soleil à l'ouest → (-1, 0).
 */
export function sunDirection(azimuth: number): Direction {
  return { east: -Math.sin(azimuth), north: -Math.cos(azimuth) };
}

/** Vecteur horizontal unitaire dans lequel les ombres s'allongent (opposé au soleil). */
export function shadowDirection(azimuth: number): Direction {
  return { east: Math.sin(azimuth), north: Math.cos(azimuth) };
}

/** Le soleil est-il assez haut pour que le calcul d'ombre ait un sens ? */
export function isDaylight(altitude: number): boolean {
  return altitude > 0;
}

/**
 * Longueur au sol de l'ombre d'un objet vertical, en mètres.
 *
 * La hauteur du soleil est bornée par `MIN_USEFUL_ALTITUDE_RAD` : sans cela la
 * longueur diverge vers l'infini au lever et au coucher, et la marge de calcul
 * du champ de hauteur devient ingérable.
 */
export function shadowLength(heightMeters: number, altitude: number): number {
  if (altitude <= 0) return Infinity;
  return heightMeters / Math.tan(Math.max(altitude, MIN_USEFUL_ALTITUDE_RAD));
}

export interface SunTimes {
  dawn: Date | null;
  sunrise: Date | null;
  goldenHourEnd: Date | null;
  solarNoon: Date | null;
  goldenHour: Date | null;
  sunset: Date | null;
  dusk: Date | null;
}

/** `null` plutôt qu'une Date invalide aux latitudes où l'événement n'existe pas ce jour-là. */
function validDate(d: Date | undefined): Date | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}

export function sunTimes(date: Date, lat: number, lng: number): SunTimes {
  const t = SunCalc.getTimes(date, lat, lng);
  return {
    dawn: validDate(t.dawn),
    sunrise: validDate(t.sunrise),
    goldenHourEnd: validDate(t.goldenHourEnd),
    solarNoon: validDate(t.solarNoon),
    goldenHour: validDate(t.goldenHour),
    sunset: validDate(t.sunset),
    dusk: validDate(t.dusk),
  };
}

/** Azimut en degrés depuis le nord, sens horaire — la convention qu'attend un lecteur humain. */
export function azimuthFromNorthDeg(azimuth: number): number {
  return (((azimuth * 180) / Math.PI + 180) % 360 + 360) % 360;
}

/** Point cardinal abrégé correspondant à un azimut SunCalc. */
export function compassLabel(azimuth: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  const index = Math.round(azimuthFromNorthDeg(azimuth) / 22.5) % 16;
  return points[index] ?? 'N';
}
