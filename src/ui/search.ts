/**
 * Recherche de lieux via Nominatim.
 *
 * Nominatim est gratuit mais son usage est encadré : pas plus d'une requête par
 * seconde, pas de recherche à chaque frappe. D'où la soumission explicite (touche
 * Entrée ou bouton) plutôt qu'une autocomplétion au fil de la saisie.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export interface SearchResult {
  label: string;
  lat: number;
  lng: number;
  /** Enveloppe fournie par Nominatim, quand elle existe, pour cadrer la vue. */
  boundingBox: [number, number, number, number] | null;
}

interface NominatimItem {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '6');
  url.searchParams.set('addressdetails', '0');

  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Nominatim a répondu ${response.status}`);

  const items = (await response.json()) as NominatimItem[];
  return items.map((item) => ({
    label: item.display_name,
    lat: Number(item.lat),
    lng: Number(item.lon),
    boundingBox: item.boundingbox
      ? [
          Number(item.boundingbox[0]),
          Number(item.boundingbox[1]),
          Number(item.boundingbox[2]),
          Number(item.boundingbox[3]),
        ]
      : null,
  }));
}

export interface SearchUiOptions {
  form: HTMLFormElement;
  input: HTMLInputElement;
  list: HTMLUListElement;
  onPick: (result: SearchResult) => void;
  onError: (message: string) => void;
}

export function createSearchUi({ form, input, list, onPick, onError }: SearchUiOptions) {
  let controller: AbortController | null = null;

  const close = () => {
    list.replaceChildren();
    list.hidden = true;
  };

  const show = (results: SearchResult[]) => {
    if (results.length === 0) {
      close();
      onError('Aucun lieu trouvé.');
      return;
    }
    list.replaceChildren(
      ...results.map((result) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = result.label;
        button.addEventListener('click', () => {
          onPick(result);
          close();
          input.blur();
        });
        item.append(button);
        return item;
      }),
    );
    list.hidden = false;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    controller?.abort();
    controller = new AbortController();

    searchPlaces(input.value, controller.signal)
      .then(show)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        close();
        onError('La recherche de lieu est indisponible pour le moment.');
      });
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  document.addEventListener('click', (event) => {
    if (!list.hidden && !form.contains(event.target as Node) && !list.contains(event.target as Node)) {
      close();
    }
  });

  return { close };
}
