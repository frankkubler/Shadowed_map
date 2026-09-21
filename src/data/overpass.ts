/**
 * Accès mutualisé à l'API Overpass.
 *
 * Overpass est un service bénévole et fragile. Toute la sobriété de ce projet vis-à-vis
 * de lui tient dans ce fichier : une requête par déplacement significatif, résultats
 * réutilisés tant que la nouvelle vue tient dans une enveloppe déjà téléchargée,
 * annulation des requêtes obsolètes, délai propre à chaque miroir, et bascule sur le
 * suivant en cas d'échec — un miroir muet étant mis à l'écart comme un miroir saturé.
 *
 * Les bâtiments et les terrasses passent tous deux par ici. Dupliquer cette logique
 * pour chaque couche de données serait le meilleur moyen de se faire bloquer.
 */
import type { Bounds } from '../sun/mercator';

/** Miroirs essayés dans l'ordre. Le premier qui répond gagne. */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

/**
 * Index du dernier miroir qui a répondu, partagé par tous les consommateurs.
 *
 * Volontairement au niveau du module : quand un serveur est saturé, il ne sert à rien
 * que chaque couche le redécouvre de son côté.
 */
let preferredEndpoint = 0;

/**
 * Miroirs mis à l'écart après un refus, et l'instant à partir duquel on les réessaiera.
 *
 * Sans cela, un miroir qui répond 429 était resollicité au déplacement suivant, soit
 * toutes les 800 ms pendant un zoom : exactement la façon de se faire bloquer plus
 * durablement. Overpass indique lui-même le délai à respecter dans `Retry-After`.
 */
const cooldowns = new Map<string, number>();

/** Délai retenu quand le serveur ne dit rien. */
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

/**
 * Délai au-delà duquel un miroir est tenu pour muet.
 *
 * Il doit rester au-dessus du `[timeout:25]` que déclarent les requêtes : le serveur a
 * le droit de calculer vingt-cinq secondes avant de répondre, et couper plus tôt
 * sacrifierait des réponses légitimes sur les grandes emprises. La marge couvre
 * l'établissement de la connexion et le transfert.
 *
 * Le délai passe par `setTimeout` et non par `AbortSignal.timeout` : ce dernier échappe
 * aux faux timers, et le mécanisme ne serait pas vérifiable.
 */
const REQUEST_TIMEOUT_MS = 30_000;

function cooldownMs(response: Response): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const secondes = Number(retryAfter);
    if (Number.isFinite(secondes) && secondes > 0) {
      return Math.min(secondes * 1000, MAX_COOLDOWN_MS);
    }
  }
  return DEFAULT_COOLDOWN_MS;
}

/** Remet à zéro préférence et mises à l'écart. Réservé aux tests. */
export function resetOverpassState(): void {
  preferredEndpoint = 0;
  cooldowns.clear();
}

export interface OverpassGeometryPoint {
  lat: number;
  lon: number;
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  center?: OverpassGeometryPoint;
  geometry?: OverpassGeometryPoint[];
  members?: { type: string; role: string; geometry?: OverpassGeometryPoint[] }[];
}

/** Formate une enveloppe au format attendu par Overpass : sud,ouest,nord,est. */
export function bboxClause(bounds: Bounds): string {
  return [bounds.south, bounds.west, bounds.north, bounds.east].map((v) => v.toFixed(6)).join(',');
}

/**
 * Exécute une requête Overpass en essayant chaque miroir une fois.
 * Lève une erreur seulement si tous échouent ; une annulation remonte telle quelle.
 */
export async function runOverpassQuery(
  query: string,
  signal: AbortSignal,
): Promise<OverpassElement[]> {
  const maintenant = Date.now();
  let tousEnAttente = true;

  for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
    const index = (preferredEndpoint + attempt) % OVERPASS_ENDPOINTS.length;
    const endpoint = OVERPASS_ENDPOINTS[index];
    if (!endpoint) continue;

    const reprise = cooldowns.get(endpoint);
    if (reprise !== undefined && reprise > maintenant) continue;
    tousEnAttente = false;

    // Un miroir qui accepte la connexion puis se tait bloquait toute la rotation : les
    // suivants n'étaient jamais essayés, et la couche restait vide sans qu'aucune erreur
    // ne remonte — donc sans bandeau non plus. Mesuré sur overpass.kumi.systems, qui
    // laissait la requête pendante indéfiniment alors qu'overpass.osm.ch répondait en
    // 0,4 s. `AbortSignal.any` combine le délai avec l'annulation de l'appelant, qui
    // reste prioritaire et doit continuer de remonter telle quelle.
    const expiration = new AbortController();
    const minuteur = setTimeout(() => expiration.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.any([signal, expiration.signal]),
      });
      if (!response.ok) {
        // 429 : quota dépassé. 504 : la file du serveur est pleine. Dans les deux cas
        // insister ne fait qu'aggraver les choses.
        if (response.status === 429 || response.status === 504) {
          cooldowns.set(endpoint, Date.now() + cooldownMs(response));
        }
        continue;
      }

      const json = (await response.json()) as { elements?: OverpassElement[] };
      cooldowns.delete(endpoint);
      preferredEndpoint = index;
      return json.elements ?? [];
    } catch (error) {
      if (signal.aborted) throw error;
      // Le miroir n'a pas répondu : connexion refusée, ou silence jusqu'au délai. Le
      // mettre à l'écart est le vrai correctif — sans cela, chaque requête suivante
      // reperdrait le même délai avant d'atteindre les miroirs valides, et un
      // déplacement de carte l'annulerait avant d'y arriver.
      cooldowns.set(endpoint, Date.now() + DEFAULT_COOLDOWN_MS);
    } finally {
      clearTimeout(minuteur);
    }
  }
  throw new Error(
    tousEnAttente
      ? 'Tous les miroirs Overpass sont temporairement hors de portée.'
      : "Aucun miroir Overpass n'a répondu.",
  );
}

export type ProviderStatus = 'idle' | 'loading' | 'ready' | 'error' | 'zoomed-out' | 'disabled';

export interface BboxResult<T> {
  data: T;
  /** Enveloppe effectivement téléchargée, plus large que la vue demandée. */
  bounds: Bounds | null;
  status: ProviderStatus;
}

export interface BboxProviderOptions<T> {
  /** En dessous, la densité rend la requête trop lourde pour Overpass. */
  minZoom: number;
  /** Valeur renvoyée tant qu'il n'y a rien à montrer. */
  empty: T;
  buildQuery: (bounds: Bounds) => string;
  parse: (elements: OverpassElement[]) => T;
  onUpdate: (result: BboxResult<T>) => void;
  debounceMs?: number;
  /**
   * Élargissement de la zone demandée. On paie un peu plus de données une fois, mais
   * un déplacement modéré de la carte ne redéclenche aucune requête.
   */
  padRatio?: number;
  /**
   * État initial. Le poser ici plutôt que d'appeler `setEnabled(false)` juste après la
   * construction évite de déclencher `onUpdate` avant que l'appelant ait fini de se
   * construire — la couche qui reçoit la notification n'existe pas encore.
   */
  startEnabled?: boolean;
}

function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.west <= inner.west &&
    outer.south <= inner.south &&
    outer.east >= inner.east &&
    outer.north >= inner.north
  );
}

function padBounds(bounds: Bounds, ratio: number): Bounds {
  const dLng = (bounds.east - bounds.west) * ratio;
  const dLat = (bounds.north - bounds.south) * ratio;
  return {
    west: bounds.west - dLng,
    east: bounds.east + dLng,
    south: bounds.south - dLat,
    north: bounds.north + dLat,
  };
}

/**
 * Récupère une couche de données OSM pour la vue courante, en réutilisant autant que
 * possible ce qui a déjà été téléchargé.
 */
export class BboxProvider<T> {
  private cachedBounds: Bounds | null = null;
  private cached: T;
  private controller: AbortController | null = null;
  private status: ProviderStatus = 'idle';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled: boolean;
  private lastRequest: { bounds: Bounds; zoom: number } | null = null;

  constructor(private readonly options: BboxProviderOptions<T>) {
    this.cached = options.empty;
    this.enabled = options.startEnabled ?? true;
    if (!this.enabled) this.status = 'disabled';
  }

  current(): BboxResult<T> {
    return { data: this.cached, bounds: this.cachedBounds, status: this.status };
  }

  /**
   * Active ou coupe la couche. Couper annule tout de suite : une couche masquée ne doit
   * pas continuer à consommer le quota Overpass.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.cancel();
      this.reset('disabled');
      return;
    }
    this.status = 'idle';
    if (this.lastRequest) this.request(this.lastRequest.bounds, this.lastRequest.zoom);
  }

  /** À appeler après chaque déplacement de carte. Ne déclenche une requête que si nécessaire. */
  request(bounds: Bounds, zoom: number): void {
    this.lastRequest = { bounds, zoom };
    if (!this.enabled) return;

    if (zoom < this.options.minZoom) {
      this.cancel();
      this.reset('zoomed-out');
      return;
    }

    if (this.cachedBounds && boundsContain(this.cachedBounds, bounds)) return;

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fetchNow(padBounds(bounds, this.options.padRatio ?? 0.4));
    }, this.options.debounceMs ?? 800);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  private reset(status: ProviderStatus): void {
    if (this.cached === this.options.empty && this.status === status) return;
    this.cached = this.options.empty;
    this.cachedBounds = null;
    this.status = status;
    this.options.onUpdate(this.current());
  }

  private async fetchNow(bounds: Bounds): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    this.status = 'loading';
    this.options.onUpdate(this.current());

    try {
      const elements = await runOverpassQuery(this.options.buildQuery(bounds), controller.signal);
      if (controller.signal.aborted) return;
      this.cached = this.options.parse(elements);
      this.cachedBounds = bounds;
      this.status = 'ready';
    } catch (error) {
      if (controller.signal.aborted) return;
      void error;
      this.status = 'error';
    }

    this.controller = null;
    this.options.onUpdate(this.current());
  }
}
