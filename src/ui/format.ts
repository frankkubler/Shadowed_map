/** Formatage des valeurs affichées. Tout est en français, heure locale du navigateur. */

const timeFormatter = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

export function formatTime(date: Date | null): string {
  return date ? timeFormatter.format(date) : '—';
}

export function formatMinutesOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** « 4 h 30 », « 45 min ». Les durées d'ensoleillement se lisent mieux ainsi qu'en décimal. */
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

export function formatDegrees(radians: number): string {
  return `${((radians * 180) / Math.PI).toFixed(1)}°`;
}

export function formatElevation(meters: number | null): string {
  return meters === null ? '—' : `${Math.round(meters)} m`;
}

/** Minutes écoulées depuis minuit local. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** Même jour que `date`, à `minutes` minutes après minuit local. */
export function withMinutesOfDay(date: Date, minutes: number): Date {
  const next = new Date(date);
  next.setHours(Math.floor(minutes / 60), Math.floor(minutes % 60), 0, 0);
  return next;
}

/** `YYYY-MM-DD` local, le format attendu par `<input type="date">`. */
export function toDateInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Applique une date `YYYY-MM-DD` en conservant l'heure courante. */
export function fromDateInputValue(value: string, current: Date): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const next = new Date(current);
  next.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(next.getTime()) ? null : next;
}

/**
 * Vitesse d'animation : minutes simulées par seconde réelle.
 *
 * L'échelle est géométrique, parce qu'une vitesse se perçoit en proportion : passer de
 * 30 à 60 min/s change autant l'allure que passer de 300 à 600. Un curseur linéaire
 * rendrait toute la moitié lente inutilisable.
 */
export const MIN_ANIMATION_SPEED = 10;
export const MAX_ANIMATION_SPEED = 1440;

/** Position du curseur, de 0 à 100, vers une vitesse en minutes par seconde. */
export function animationSpeedFromSlider(position: number): number {
  const t = Math.min(100, Math.max(0, position)) / 100;
  return MIN_ANIMATION_SPEED * Math.pow(MAX_ANIMATION_SPEED / MIN_ANIMATION_SPEED, t);
}

/** L'inverse, pour poser le curseur sur une vitesse donnée. */
export function sliderFromAnimationSpeed(minutesPerSecond: number): number {
  const borne = Math.min(MAX_ANIMATION_SPEED, Math.max(MIN_ANIMATION_SPEED, minutesPerSecond));
  const t = Math.log(borne / MIN_ANIMATION_SPEED) / Math.log(MAX_ANIMATION_SPEED / MIN_ANIMATION_SPEED);
  return Math.round(t * 100);
}

/** « 4 h/s », « 30 min/s ». En dessous d'une heure par seconde, les minutes parlent mieux. */
export function formatAnimationSpeed(minutesPerSecond: number): string {
  if (minutesPerSecond < 60) return `${Math.round(minutesPerSecond)} min/s`;
  const heures = minutesPerSecond / 60;
  return `${heures < 10 ? heures.toFixed(1).replace('.0', '') : Math.round(heures)} h/s`;
}
