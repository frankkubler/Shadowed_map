import { describe, expect, it } from 'vitest';
import {
  EARTH_CIRCUMFERENCE,
  clampLatitude,
  fromMercator,
  latToMercatorY,
  lngToMercatorX,
  mercatorXToLng,
  mercatorYToLat,
  metersPerMercatorUnit,
  metersPerPixel,
  pointToTile,
  tilesInBounds,
  toMercator,
} from '../src/sun/mercator';

describe('projection Web Mercator', () => {
  it('place le méridien de Greenwich et l\'équateur au centre', () => {
    expect(lngToMercatorX(0)).toBeCloseTo(0.5, 12);
    expect(latToMercatorY(0)).toBeCloseTo(0.5, 12);
  });

  it('place les bords de la carte en 0 et 1', () => {
    expect(lngToMercatorX(-180)).toBeCloseTo(0, 12);
    expect(lngToMercatorX(180)).toBeCloseTo(1, 12);
  });

  it('fait croître y vers le sud', () => {
    expect(latToMercatorY(45)).toBeLessThan(latToMercatorY(-45));
  });

  it('revient au point de départ par aller-retour', () => {
    for (const point of [
      { lng: 2.3522, lat: 48.8566 },
      { lng: -122.4194, lat: 37.7749 },
      { lng: 151.2093, lat: -33.8688 },
      { lng: 6.8694, lat: 45.9237 },
    ]) {
      const back = fromMercator(toMercator(point));
      expect(back.lng).toBeCloseTo(point.lng, 9);
      expect(back.lat).toBeCloseTo(point.lat, 9);
    }
  });

  it('borne la latitude au domaine représentable', () => {
    expect(clampLatitude(90)).toBeLessThan(85.06);
    expect(clampLatitude(-90)).toBeGreaterThan(-85.06);
    // y doit rester dans [0, 1] : les indices de tuiles en dépendent.
    expect(latToMercatorY(90)).toBeGreaterThanOrEqual(0);
    expect(latToMercatorY(-90)).toBeLessThanOrEqual(1);
    expect(latToMercatorY(90)).toBeLessThan(0.001);
    expect(latToMercatorY(-90)).toBeGreaterThan(0.999);
  });

  it('inverse correctement chaque axe', () => {
    expect(mercatorXToLng(lngToMercatorX(12.5))).toBeCloseTo(12.5, 9);
    expect(mercatorYToLat(latToMercatorY(-12.5))).toBeCloseTo(-12.5, 9);
  });
});

describe('échelles', () => {
  it("vaut la circonférence terrestre à l'équateur", () => {
    expect(metersPerMercatorUnit(0)).toBeCloseTo(EARTH_CIRCUMFERENCE, 3);
  });

  it('décroît en cos(latitude)', () => {
    expect(metersPerMercatorUnit(60)).toBeCloseTo(EARTH_CIRCUMFERENCE * 0.5, 0);
  });

  it("donne la résolution classique d'environ 156 km/px au zoom 0", () => {
    expect(metersPerPixel(0, 0, 256)).toBeCloseTo(156543.03, 1);
  });

  it('divise la résolution par deux à chaque niveau de zoom', () => {
    expect(metersPerPixel(45, 10)).toBeCloseTo(metersPerPixel(45, 11) * 2, 6);
  });
});

describe('tuiles', () => {
  it('trouve la tuile contenant un point', () => {
    // Au zoom 1, Paris est dans le quadrant nord-est.
    expect(pointToTile(2.3522, 48.8566, 1)).toEqual({ x: 1, y: 0, z: 1 });
  });

  it('couvre une enveloppe complète', () => {
    const tiles = tilesInBounds({ west: -1, south: -1, east: 1, north: 1 }, 8);
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.z).toBe(8);
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(256);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeLessThan(256);
    }
  });

  it('replie les indices qui débordent en longitude', () => {
    const tiles = tilesInBounds({ west: 179, south: -1, east: 181, north: 1 }, 4);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(16);
    }
  });
});
