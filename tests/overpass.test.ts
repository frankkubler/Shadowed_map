import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOverpassState, runOverpassQuery } from '../src/data/overpass';

/** Réponse Overpass minimale. */
const ok = () => new Response(JSON.stringify({ elements: [] }), { status: 200 });
const satureee = (retryAfter?: string) =>
  new Response('rate limited', {
    status: 429,
    headers: retryAfter ? { 'Retry-After': retryAfter } : undefined,
  });

describe('requêtes Overpass', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetOverpassState();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('bascule sur le miroir suivant quand le premier est saturé', async () => {
    const appels: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        return appels.length === 1 ? satureee() : ok();
      }),
    );

    await runOverpassQuery('[out:json];', new AbortController().signal);
    expect(appels).toHaveLength(2);
    expect(appels[0]).not.toBe(appels[1]);
  });

  // Sans mise à l'écart, un miroir qui répond 429 est resollicité à chaque déplacement
  // de carte : c'est exactement ce qui fait blacklister un client par Overpass.
  it('ne resollicite pas un miroir qui vient de répondre 429', async () => {
    const appels: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        return url.includes('overpass-api.de') ? satureee('120') : ok();
      }),
    );

    await runOverpassQuery('[out:json];', new AbortController().signal);
    const premierTour = [...appels];
    appels.length = 0;

    await runOverpassQuery('[out:json];', new AbortController().signal);

    expect(premierTour.some((u) => u.includes('overpass-api.de'))).toBe(true);
    expect(appels.some((u) => u.includes('overpass-api.de'))).toBe(false);
  });

  // Une mise à l'écart doit rester temporaire : le délai passé, le miroir retrouve
  // sa place dans la rotation.
  it('réessaie le miroir une fois le délai passé', async () => {
    let saturé = true;
    const appels: string[] = [];
    // les autres miroirs sont injoignables : seul overpass-api.de peut répondre
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        if (!url.includes('overpass-api.de')) throw new Error('injoignable');
        return saturé ? satureee('60') : ok();
      }),
    );

    await expect(
      runOverpassQuery('[out:json];', new AbortController().signal),
    ).rejects.toThrow();

    appels.length = 0;
    await expect(
      runOverpassQuery('[out:json];', new AbortController().signal),
    ).rejects.toThrow();
    expect(appels.some((u) => u.includes('overpass-api.de'))).toBe(false);

    saturé = false;
    vi.setSystemTime(Date.now() + 61_000);
    appels.length = 0;
    await runOverpassQuery('[out:json];', new AbortController().signal);
    expect(appels.some((u) => u.includes('overpass-api.de'))).toBe(true);
  });

  it('échoue proprement quand tous les miroirs sont saturés', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => satureee()));
    await expect(runOverpassQuery('[out:json];', new AbortController().signal)).rejects.toThrow();
  });
});
