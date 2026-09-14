import { describe, expect, it } from 'vitest';
import SunCalc from 'suncalc';
import {
  azimuthFromNorthDeg,
  compassLabel,
  isDaylight,
  shadowDirection,
  shadowLength,
  sunDirection,
  sunPosition,
  sunTimes,
  MIN_USEFUL_ALTITUDE_RAD,
} from '../src/sun/sun';

const PARIS = { lat: 48.8566, lng: 2.3522 };
const SYDNEY = { lat: -33.8688, lng: 151.2093 };

const toDeg = (rad: number) => (rad * 180) / Math.PI;

describe('sunDirection', () => {
  it('place le soleil au sud pour un azimut nul', () => {
    const dir = sunDirection(0);
    expect(dir.east).toBeCloseTo(0, 6);
    expect(dir.north).toBeCloseTo(-1, 6);
  });

  it("place le soleil à l'ouest pour un azimut de +90°", () => {
    const dir = sunDirection(Math.PI / 2);
    expect(dir.east).toBeCloseTo(-1, 6);
    expect(dir.north).toBeCloseTo(0, 6);
  });

  it("place le soleil à l'est pour un azimut de -90°", () => {
    const dir = sunDirection(-Math.PI / 2);
    expect(dir.east).toBeCloseTo(1, 6);
    expect(dir.north).toBeCloseTo(0, 6);
  });

  it('produit toujours un vecteur unitaire', () => {
    for (const azimuth of [-2.5, -1, 0, 0.7, 2.9]) {
      const { east, north } = sunDirection(azimuth);
      expect(Math.hypot(east, north)).toBeCloseTo(1, 9);
    }
  });
});

describe("shadowDirection", () => {
  it("est exactement l'opposé de la direction du soleil", () => {
    for (const azimuth of [-2, -0.3, 0, 1.1, 3]) {
      const sun = sunDirection(azimuth);
      const shadow = shadowDirection(azimuth);
      expect(shadow.east).toBeCloseTo(-sun.east, 9);
      expect(shadow.north).toBeCloseTo(-sun.north, 9);
    }
  });
});

describe('hauteur du soleil au midi solaire', () => {
  it('vaut environ 64,6° à Paris au solstice de juin', () => {
    // 90° - latitude + déclinaison (23,44°) = 64,58°
    const noon = sunTimes(new Date('2026-06-21T12:00:00Z'), PARIS.lat, PARIS.lng).solarNoon;
    expect(noon).not.toBeNull();
    const { altitude } = sunPosition(noon as Date, PARIS.lat, PARIS.lng);
    expect(toDeg(altitude)).toBeGreaterThan(64);
    expect(toDeg(altitude)).toBeLessThan(65.2);
  });

  it('vaut environ 17,7° à Paris au solstice de décembre', () => {
    // 90° - latitude - déclinaison = 17,70°
    const noon = sunTimes(new Date('2026-12-21T12:00:00Z'), PARIS.lat, PARIS.lng).solarNoon;
    expect(noon).not.toBeNull();
    const { altitude } = sunPosition(noon as Date, PARIS.lat, PARIS.lng);
    expect(toDeg(altitude)).toBeGreaterThan(17.2);
    expect(toDeg(altitude)).toBeLessThan(18.2);
  });
});

describe("piège d'hémisphère", () => {
  it("dans l'hémisphère nord, l'ombre de midi pointe vers le nord", () => {
    const noon = sunTimes(new Date('2026-06-21T12:00:00Z'), PARIS.lat, PARIS.lng).solarNoon as Date;
    const { azimuth } = sunPosition(noon, PARIS.lat, PARIS.lng);
    const shadow = shadowDirection(azimuth);
    expect(shadow.north).toBeGreaterThan(0.99);
  });

  it("dans l'hémisphère sud, l'ombre de midi pointe vers le sud", () => {
    // Le soleil y culmine au nord : les ombres tombent donc de l'autre côté.
    const noon = sunTimes(new Date('2026-12-21T02:00:00Z'), SYDNEY.lat, SYDNEY.lng)
      .solarNoon as Date;
    const { azimuth } = sunPosition(noon, SYDNEY.lat, SYDNEY.lng);
    const shadow = shadowDirection(azimuth);
    expect(shadow.north).toBeLessThan(-0.99);
  });
});

describe('shadowLength', () => {
  it('égale la hauteur quand le soleil est à 45°', () => {
    expect(shadowLength(10, Math.PI / 4)).toBeCloseTo(10, 6);
  });

  it("s'allonge quand le soleil descend", () => {
    const high = shadowLength(10, Math.PI / 3);
    const low = shadowLength(10, Math.PI / 6);
    expect(low).toBeGreaterThan(high);
  });

  it('reste fini sous la hauteur minimale utile, pour borner la marge de calcul', () => {
    const atFloor = shadowLength(10, MIN_USEFUL_ALTITUDE_RAD);
    expect(shadowLength(10, 0.0001)).toBeCloseTo(atFloor, 6);
    expect(Number.isFinite(atFloor)).toBe(true);
  });

  it('est infinie quand le soleil est couché', () => {
    expect(shadowLength(10, -0.1)).toBe(Infinity);
  });
});

describe('conversions de lecture', () => {
  it('convertit un azimut SunCalc en degrés depuis le nord', () => {
    expect(azimuthFromNorthDeg(0)).toBeCloseTo(180, 6); // sud
    expect(azimuthFromNorthDeg(Math.PI / 2)).toBeCloseTo(270, 6); // ouest
    expect(azimuthFromNorthDeg(-Math.PI / 2)).toBeCloseTo(90, 6); // est
  });

  it('nomme les points cardinaux', () => {
    expect(compassLabel(0)).toBe('S');
    expect(compassLabel(Math.PI / 2)).toBe('O');
    expect(compassLabel(-Math.PI / 2)).toBe('E');
    expect(compassLabel(Math.PI)).toBe('N');
  });

  it('reconnaît le jour et la nuit', () => {
    expect(isDaylight(0.3)).toBe(true);
    expect(isDaylight(-0.01)).toBe(false);
  });
});

describe('sunTimes', () => {
  it('renvoie null plutôt qu\'une date invalide en nuit polaire', () => {
    // Longyearbyen, fin décembre : le soleil ne se lève pas.
    const times = sunTimes(new Date('2026-12-21T12:00:00Z'), 78.22, 15.65);
    expect(times.sunrise).toBeNull();
    expect(times.sunset).toBeNull();
  });

  it('reste cohérent avec SunCalc pour un jour ordinaire', () => {
    const date = new Date('2026-09-14T12:00:00Z');
    const ours = sunTimes(date, PARIS.lat, PARIS.lng);
    const raw = SunCalc.getTimes(date, PARIS.lat, PARIS.lng);
    expect(ours.sunrise?.getTime()).toBe(raw.sunrise.getTime());
    expect(ours.sunset?.getTime()).toBe(raw.sunset.getTime());
  });
});
