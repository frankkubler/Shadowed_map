import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATE,
  deserializeState,
  hashSpecifiesDate,
  serializeState,
  Store,
} from '../src/state/appState';
import {
  formatDuration,
  formatMinutesOfDay,
  fromDateInputValue,
  minutesOfDay,
  toDateInputValue,
  withMinutesOfDay,
} from '../src/ui/format';

describe('sérialisation dans l\'URL', () => {
  it('fait un aller-retour fidèle', () => {
    const state = {
      lat: 45.9237,
      lng: 6.8694,
      zoom: 14.25,
      bearing: 30,
      pitch: 45,
      date: new Date(2026, 8, 14, 18, 30),
      mode: 'exposure' as const,
    };
    const back = deserializeState(serializeState(state));
    expect(back.lat).toBeCloseTo(state.lat, 4);
    expect(back.lng).toBeCloseTo(state.lng, 4);
    expect(back.zoom).toBeCloseTo(state.zoom, 2);
    expect(back.bearing).toBe(30);
    expect(back.pitch).toBe(45);
    expect(back.mode).toBe('exposure');
    expect(back.date.getTime()).toBe(state.date.getTime());
  });

  it('retombe sur les valeurs par défaut face à un hash abîmé', () => {
    const back = deserializeState('#n/importe/quoi');
    expect(back.zoom).toBe(DEFAULT_STATE.zoom);
    expect(back.mode).toBe('shadow');
  });

  it('tolère un hash tronqué', () => {
    const back = deserializeState('#12.5');
    expect(back.lat).toBe(DEFAULT_STATE.lat);
  });

  it('accepte le hash avec ou sans dièse', () => {
    const withHash = deserializeState('#13.00/45.00000/6.00000/0/0/2026-01-02T08:15/shadow');
    const without = deserializeState('13.00/45.00000/6.00000/0/0/2026-01-02T08:15/shadow');
    expect(withHash).toEqual(without);
  });

  it('ne retient que les modes connus', () => {
    const back = deserializeState('13.00/45.00000/6.00000/0/0/2026-01-02T08:15/bidon');
    expect(back.mode).toBe('shadow');
  });
});

describe('Store', () => {
  it('ne notifie que lorsqu\'une valeur change vraiment', () => {
    const store = new Store({ ...DEFAULT_STATE, date: new Date(2026, 0, 1, 12, 0) });
    let calls = 0;
    store.subscribe(() => calls++);

    store.set({ zoom: DEFAULT_STATE.zoom });
    expect(calls).toBe(0);

    store.set({ zoom: 15 });
    expect(calls).toBe(1);
  });

  it('compare les dates par leur instant, pas par leur identité', () => {
    const date = new Date(2026, 0, 1, 12, 0);
    const store = new Store({ ...DEFAULT_STATE, date });
    let calls = 0;
    store.subscribe(() => calls++);

    store.set({ date: new Date(date.getTime()) });
    expect(calls).toBe(0);

    store.set({ date: new Date(date.getTime() + 60000) });
    expect(calls).toBe(1);
  });

  it('indique quels champs ont changé', () => {
    const store = new Store({ ...DEFAULT_STATE, date: new Date(2026, 0, 1) });
    let changed: ReadonlySet<string> | null = null;
    store.subscribe((_state, keys) => {
      changed = keys;
    });
    store.set({ zoom: 16, mode: 'exposure' });
    expect(changed).not.toBeNull();
    expect([...(changed as unknown as Set<string>)].sort()).toEqual(['mode', 'zoom']);
  });
});

describe('formatage du temps', () => {
  it('compte les minutes depuis minuit', () => {
    expect(minutesOfDay(new Date(2026, 0, 1, 18, 30))).toBe(1110);
    expect(minutesOfDay(new Date(2026, 0, 1, 0, 0))).toBe(0);
  });

  it('repose l\'heure du jour sans changer la date', () => {
    const date = new Date(2026, 5, 15, 3, 7, 42);
    const moved = withMinutesOfDay(date, 1110);
    expect(moved.getDate()).toBe(15);
    expect(moved.getHours()).toBe(18);
    expect(moved.getMinutes()).toBe(30);
    expect(moved.getSeconds()).toBe(0);
  });

  it('affiche les minutes du jour sur deux chiffres', () => {
    expect(formatMinutesOfDay(0)).toBe('00:00');
    expect(formatMinutesOfDay(545)).toBe('09:05');
    expect(formatMinutesOfDay(1439)).toBe('23:59');
  });

  it('met les durées en heures et minutes', () => {
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(60)).toBe('1 h');
    expect(formatDuration(270)).toBe('4 h 30');
  });

  it('fait un aller-retour avec le champ date du formulaire', () => {
    const date = new Date(2026, 8, 14, 18, 30);
    const value = toDateInputValue(date);
    expect(value).toBe('2026-09-14');

    const back = fromDateInputValue(value, date);
    expect(back?.getFullYear()).toBe(2026);
    expect(back?.getMonth()).toBe(8);
    expect(back?.getDate()).toBe(14);
    // L'heure en cours est conservée : changer de jour ne doit pas remettre l'heure à zéro.
    expect(back?.getHours()).toBe(18);
  });

  it('rejette une date mal formée', () => {
    expect(fromDateInputValue('14/09/2026', new Date())).toBeNull();
  });
});

// C'est ce qui décide si la carte suit l'heure réelle : un lien qui désigne un instant
// ne doit jamais être écrasé par l'horloge.
describe('instant demandé par le lien', () => {
  it('reconnaît une date dans le hash', () => {
    expect(hashSpecifiesDate('#12.5/45.8992/6.8677/0/0/2026-09-14T18:30/shadow')).toBe(true);
    expect(hashSpecifiesDate('12.5/45.8992/6.8677/0/0/2026-09-14T18:30')).toBe(true);
  });

  it('ne voit pas de date là où il n’y en a pas', () => {
    expect(hashSpecifiesDate('')).toBe(false);
    expect(hashSpecifiesDate('#')).toBe(false);
    expect(hashSpecifiesDate('#12.5/45.8992/6.8677')).toBe(false);
    expect(hashSpecifiesDate('#12.5/45.8992/6.8677/0/0')).toBe(false);
  });

  it('refuse une date illisible plutôt que de la croire sur parole', () => {
    expect(hashSpecifiesDate('#12.5/45.8992/6.8677/0/0/pas-une-date/shadow')).toBe(false);
    expect(hashSpecifiesDate('#12.5/45.8992/6.8677/0/0/2026-09-14/shadow')).toBe(false);
  });

  // `new Date(2026, 12, 45)` ne vaut pas NaN : JavaScript reporte les débordements sur
  // le mois suivant. Un tel hash désigne donc bien un instant, aussi saugrenu soit-il.
  it('accepte une date que JavaScript normalise', () => {
    expect(hashSpecifiesDate('#12.5/45.8992/6.8677/0/0/2026-13-45T99:99/shadow')).toBe(true);
  });
});
