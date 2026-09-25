// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE, HASH_WRITE_INTERVAL_MS, serializeState, Store } from '../src/state/appState';

describe('écriture du hash d’URL', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reste sous le seuil de bridage de Chrome pendant une animation', () => {
    vi.useFakeTimers();
    const replaceState = vi.spyOn(history, 'replaceState');
    const store = new Store({ ...DEFAULT_STATE, date: new Date(2026, 8, 14, 6, 0) });

    // Dix secondes d'animation à 60 images par seconde : une nouvelle date par frame.
    const frames = 600;
    for (let i = 1; i <= frames; i++) {
      store.set({ date: new Date(2026, 8, 14, 6, i) });
      vi.advanceTimersByTime(1000 / 60);
    }
    vi.advanceTimersByTime(HASH_WRITE_INTERVAL_MS);

    expect(replaceState.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil((frames * (1000 / 60)) / HASH_WRITE_INTERVAL_MS) + 1,
    );
    // Le dernier état finit toujours par être écrit.
    expect(window.location.hash).toBe(`#${serializeState(store.get())}`);
  });

  it('écrit sans attendre un changement isolé', () => {
    vi.useFakeTimers();
    const replaceState = vi.spyOn(history, 'replaceState');
    const store = new Store({ ...DEFAULT_STATE, date: new Date(2026, 8, 14, 6, 0) });

    store.set({ zoom: 14 });
    vi.advanceTimersByTime(0);
    expect(replaceState).toHaveBeenCalledTimes(1);
  });
});
