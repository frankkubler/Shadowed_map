// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildTerracePopup, sweepOutcomes, sweepStillValid } from '../src/ui/terraceSweep';
import { sameLocalDay } from '../src/sun/sun';

const at = (h: number, m = 0, day = 14) => new Date(2026, 8, day, h, m);

describe('popup de terrasse', () => {
  it("n'interprète pas le balisage contenu dans un nom OSM", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const popup = buildTerracePopup(document, { name: hostile, kind: 'Café' }, 'au soleil');

    expect(popup.querySelector('img')).toBeNull();
    expect(popup.querySelector('h2')?.textContent).toBe(hostile);
  });

  it('affiche le type et l’état', () => {
    const popup = buildTerracePopup(document, { name: 'Le Bistrot', kind: 'Bar' }, 'à l’ombre');
    const values = Array.from(popup.querySelectorAll('dd'), (dd) => dd.textContent);
    expect(values).toEqual(['Bar', 'à l’ombre']);
  });
});

describe('dépouillement du balayage', () => {
  const dates = [at(17), at(17, 10), at(17, 20), at(17, 30)];

  it('rattache chaque résultat à son identifiant, pas à sa position', () => {
    const outcomes = sweepOutcomes(['node/1', 'node/2'], dates, [
      [true, false],
      [true, false],
      [false, false],
      [false, false],
    ]);
    // Une liste rechargée dans un autre ordre retrouve quand même le bon horaire.
    expect(outcomes.get('node/1')?.sunUntil).toEqual(at(17, 10));
    expect(outcomes.get('node/2')?.sunUntil).toBeNull();
    expect(outcomes.get('node/3')).toBeUndefined();
  });

  it('distingue un soleil jusqu’au coucher d’un passage à l’ombre', () => {
    const outcomes = sweepOutcomes(
      ['a', 'b'],
      dates,
      dates.map(() => [true, true]).map((row, t) => (t === 3 ? [true, false] : row)),
    );
    expect(outcomes.get('a')?.sunlitUntilSunset).toBe(true);
    expect(outcomes.get('b')?.sunlitUntilSunset).toBe(false);
    expect(outcomes.get('b')?.sunUntil).toEqual(at(17, 20));
  });

  it('garde un relief inconnu au départ pour inconnu', () => {
    const outcomes = sweepOutcomes(['a'], dates, [[null], [true], [true], [true]]);
    expect(outcomes.get('a')?.atStart).toBeNull();
  });
});

describe('validité d’un balayage', () => {
  it('survit à l’horloge qui avance dans la même journée', () => {
    expect(sweepStillValid(at(17), at(17, 1))).toBe(true);
    expect(sweepStillValid(at(17), at(21))).toBe(true);
  });

  it('se périme quand on revient en arrière ou qu’on change de jour', () => {
    expect(sweepStillValid(at(17), at(16, 59))).toBe(false);
    expect(sweepStillValid(at(17), at(17, 0, 15))).toBe(false);
  });

  it('est invalide sans balayage', () => {
    expect(sweepStillValid(null, at(17))).toBe(false);
  });
});

describe('même jour local', () => {
  it('compare le jour calendaire, pas l’écart de temps', () => {
    expect(sameLocalDay(new Date(2026, 8, 14, 0, 0), new Date(2026, 8, 14, 23, 59))).toBe(true);
    expect(sameLocalDay(new Date(2026, 8, 14, 23, 59), new Date(2026, 8, 15, 0, 0))).toBe(false);
  });
});
