/**
 * État applicatif minimal, sérialisé dans le hash d'URL pour que toute vue soit partageable.
 *
 * Format du hash : #12.5/45.8992/6.8677/0/0/2026-09-14T18:30/shadow
 *                   zoom lat      lng     bearing pitch date       mode
 */

export type ShadowMode = 'shadow' | 'exposure';

export interface AppState {
  lat: number;
  lng: number;
  zoom: number;
  bearing: number;
  pitch: number;
  /** Instant simulé. Toujours interprété dans le fuseau du navigateur. */
  date: Date;
  mode: ShadowMode;
}

type Listener = (state: AppState, changed: ReadonlySet<keyof AppState>) => void;

/** Chamonix — un bon défaut pour une carte d'ombres : relief marqué et vallée encaissée. */
export const DEFAULT_STATE: AppState = {
  lat: 45.9237,
  lng: 6.8694,
  zoom: 12.5,
  bearing: 0,
  pitch: 0,
  date: new Date(),
  mode: 'shadow',
};

/** `2026-09-14T18:30` — heure locale, sans fuseau, pour rester lisible dans l'URL. */
function formatLocalDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function serializeState(s: AppState): string {
  return [
    s.zoom.toFixed(2),
    s.lat.toFixed(5),
    s.lng.toFixed(5),
    s.bearing.toFixed(0),
    s.pitch.toFixed(0),
    formatLocalDate(s.date),
    s.mode,
  ].join('/');
}

export function deserializeState(hash: string, base: AppState = DEFAULT_STATE): AppState {
  const parts = hash.replace(/^#/, '').split('/');
  if (parts.length < 3) return { ...base, date: new Date(base.date) };

  const mode = parts[6];
  return {
    zoom: parseNumber(parts[0], base.zoom),
    lat: parseNumber(parts[1], base.lat),
    lng: parseNumber(parts[2], base.lng),
    bearing: parseNumber(parts[3], base.bearing),
    pitch: parseNumber(parts[4], base.pitch),
    date: (parts[5] !== undefined ? parseLocalDate(parts[5]) : null) ?? new Date(base.date),
    mode: mode === 'exposure' ? 'exposure' : 'shadow',
  };
}

/**
 * Store observable. Volontairement rudimentaire : l'application n'a qu'une poignée
 * de champs, un framework d'état serait disproportionné.
 */
export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  private hashWriteScheduled = false;
  /** Évite de réagir au `hashchange` que l'on vient soi-même de provoquer. */
  private lastWrittenHash = '';

  constructor(initial: AppState) {
    this.state = initial;
  }

  get(): Readonly<AppState> {
    return this.state;
  }

  set(patch: Partial<AppState>): void {
    const changed = new Set<keyof AppState>();
    for (const key of Object.keys(patch) as (keyof AppState)[]) {
      const next = patch[key];
      if (next === undefined) continue;
      const current = this.state[key];
      const same =
        current instanceof Date && next instanceof Date
          ? current.getTime() === next.getTime()
          : current === next;
      if (!same) changed.add(key);
    }
    if (changed.size === 0) return;

    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state, changed);
    this.scheduleHashWrite();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * L'écriture du hash est repoussée à la frame suivante : pendant un déplacement de
   * carte ou un glissement de slider, l'état change à chaque frame et `replaceState`
   * est trop coûteux pour être appelé aussi souvent.
   */
  private scheduleHashWrite(): void {
    if (this.hashWriteScheduled || typeof window === 'undefined') return;
    this.hashWriteScheduled = true;
    requestAnimationFrame(() => {
      this.hashWriteScheduled = false;
      this.lastWrittenHash = serializeState(this.state);
      history.replaceState(null, '', `#${this.lastWrittenHash}`);
    });
  }

  /** Prend en compte les navigations arrière/avant et les liens collés à la main. */
  bindToLocationHash(): void {
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (hash === this.lastWrittenHash) return;
      this.set(deserializeState(hash, this.state));
    });
  }
}

export function createStore(): Store {
  const fromUrl =
    typeof window !== 'undefined' && window.location.hash.length > 1
      ? deserializeState(window.location.hash)
      : { ...DEFAULT_STATE, date: new Date() };
  return new Store(fromUrl);
}
