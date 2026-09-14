import { describe, expect, it } from 'vitest';
import {
  boundsToRegion,
  chooseDemZoom,
  computeFieldRegion,
  regionCenterLat,
  regionContains,
  regionHeight,
  regionToBounds,
  regionWidth,
  squareRegion,
} from '../src/shadow/region';
import { sunDirection } from '../src/sun/sun';
import { TERRARIUM_MAX_ZOOM } from '../src/shadow/demTiles';

/** Vue d'environ 5 km de côté autour de Chamonix. */
const visible = boundsToRegion({ west: 6.83, south: 45.9, east: 6.91, north: 45.95 });

describe('computeFieldRegion', () => {
  it("étend la région vers l'ouest quand le soleil est à l'ouest", () => {
    // Azimut +90° (SunCalc) = soleil à l'ouest.
    const { region } = computeFieldRegion({
      visible,
      sunDir: sunDirection(Math.PI / 2),
      sunAltitude: Math.PI / 6,
    });
    expect(region.x0).toBeLessThan(visible.x0);
    expect(region.x1).toBeCloseTo(visible.x1, 12);
  });

  it("étend la région vers le sud quand le soleil est au sud", () => {
    const { region } = computeFieldRegion({
      visible,
      sunDir: sunDirection(0),
      sunAltitude: Math.PI / 6,
    });
    // Mercator : le sud est la valeur de y la plus grande.
    expect(region.y1).toBeGreaterThan(visible.y1);
    expect(region.y0).toBeCloseTo(visible.y0, 12);
  });

  it("n'étend jamais du côté opposé au soleil", () => {
    const { region } = computeFieldRegion({
      visible,
      sunDir: sunDirection(-Math.PI / 2), // soleil à l'est
      sunAltitude: Math.PI / 4,
    });
    expect(region.x0).toBeCloseTo(visible.x0, 12);
    expect(region.x1).toBeGreaterThan(visible.x1);
  });

  it('agrandit la marge quand le soleil descend', () => {
    const high = computeFieldRegion({
      visible,
      sunDir: sunDirection(Math.PI / 2),
      sunAltitude: Math.PI / 3,
      reliefMeters: 2000,
    });
    const low = computeFieldRegion({
      visible,
      sunDir: sunDirection(Math.PI / 2),
      sunAltitude: Math.PI / 12,
      reliefMeters: 2000,
    });
    expect(regionWidth(low.region)).toBeGreaterThan(regionWidth(high.region));
  });

  it('plafonne la marge au lever du soleil, où elle divergerait', () => {
    const { region } = computeFieldRegion({
      visible,
      sunDir: sunDirection(Math.PI / 2),
      sunAltitude: 0.00001,
      reliefMeters: 4000,
    });
    // Sans plafond, la marge serait de plusieurs milliers de kilomètres.
    expect(regionWidth(region)).toBeLessThan(regionWidth(visible) * 4);
    expect(Number.isFinite(regionWidth(region))).toBe(true);
  });

  it('contient toujours la région visible', () => {
    for (const azimuth of [-2, -0.5, 0, 1.2, 3]) {
      const { region } = computeFieldRegion({
        visible,
        sunDir: sunDirection(azimuth),
        sunAltitude: 0.4,
      });
      expect(regionContains(region, visible)).toBe(true);
    }
  });
});

describe('marge omnidirectionnelle', () => {
  const omni = computeFieldRegion({
    visible,
    sunDir: sunDirection(Math.PI / 2),
    sunAltitude: Math.PI / 6,
    reliefMeters: 2000,
    omnidirectional: true,
  }).region;

  it('étend les quatre côtés', () => {
    expect(omni.x0).toBeLessThan(visible.x0);
    expect(omni.x1).toBeGreaterThan(visible.x1);
    expect(omni.y0).toBeLessThan(visible.y0);
    expect(omni.y1).toBeGreaterThan(visible.y1);
  });

  it('reste centrée sur la vue', () => {
    expect((omni.x0 + omni.x1) / 2).toBeCloseTo((visible.x0 + visible.x1) / 2, 12);
    expect((omni.y0 + omni.y1) / 2).toBeCloseTo((visible.y0 + visible.y1) / 2, 12);
  });

  it("contient la région qu'aurait produite n'importe quel azimut", () => {
    // C'est la propriété qui compte : un balayage horaire fait tourner le soleil, et
    // le champ doit couvrir les obstacles de toutes les directions à la fois.
    for (let azimuth = -Math.PI; azimuth <= Math.PI; azimuth += Math.PI / 8) {
      const oriented = computeFieldRegion({
        visible,
        sunDir: sunDirection(azimuth),
        sunAltitude: Math.PI / 6,
        reliefMeters: 2000,
      }).region;
      expect(regionContains(omni, oriented)).toBe(true);
    }
  });
});

describe('squareRegion', () => {
  it('rend la région carrée sans déplacer son centre', () => {
    const square = squareRegion(visible);
    expect(regionWidth(square)).toBeCloseTo(regionHeight(square), 12);
    expect((square.x0 + square.x1) / 2).toBeCloseTo((visible.x0 + visible.x1) / 2, 12);
    expect((square.y0 + square.y1) / 2).toBeCloseTo((visible.y0 + visible.y1) / 2, 12);
  });

  it("n'ampute jamais la région d'origine", () => {
    expect(regionContains(squareRegion(visible), visible)).toBe(true);
  });
});

describe('chooseDemZoom', () => {
  it('monte en zoom quand la région rétrécit', () => {
    const wide = squareRegion(boundsToRegion({ west: 0, south: 44, east: 2, north: 46 }));
    const narrow = squareRegion(boundsToRegion({ west: 0, south: 45, east: 0.01, north: 45.01 }));
    expect(chooseDemZoom(narrow, 2048)).toBeGreaterThan(chooseDemZoom(wide, 2048));
  });

  it('reste dans la couverture des tuiles terrarium', () => {
    const tiny = squareRegion(boundsToRegion({ west: 0, south: 45, east: 0.0001, north: 45.0001 }));
    const zoom = chooseDemZoom(tiny, 2048);
    expect(zoom).toBeLessThanOrEqual(TERRARIUM_MAX_ZOOM);
    expect(zoom).toBeGreaterThanOrEqual(0);
  });

  it('ne dépasse jamais le budget de tuiles, même sur une vue très large', () => {
    // Une vue de 200 km de côté au zoom idéal demanderait plusieurs centaines de tuiles.
    const wide = squareRegion(boundsToRegion({ west: 5, south: 44, east: 8, north: 47 }));
    const zoom = chooseDemZoom(wide, 2048, 36);
    const scale = Math.pow(2, zoom);
    const across = Math.floor(regionWidth(wide) * scale) + 1;
    expect(across * across).toBeLessThanOrEqual(36);
  });

  it('respecte un budget resserré en descendant en zoom', () => {
    const view = squareRegion(boundsToRegion({ west: 6.8, south: 45.85, east: 6.95, north: 46 }));
    expect(chooseDemZoom(view, 2048, 4)).toBeLessThan(chooseDemZoom(view, 2048, 64));
  });
});

describe('conversions de région', () => {
  it('revient à l\'enveloppe de départ', () => {
    const bounds = { west: 6.83, south: 45.9, east: 6.91, north: 45.95 };
    const back = regionToBounds(boundsToRegion(bounds));
    expect(back.west).toBeCloseTo(bounds.west, 9);
    expect(back.east).toBeCloseTo(bounds.east, 9);
    expect(back.north).toBeCloseTo(bounds.north, 9);
    expect(back.south).toBeCloseTo(bounds.south, 9);
  });

  it('donne la latitude du centre', () => {
    expect(regionCenterLat(visible)).toBeGreaterThan(45.9);
    expect(regionCenterLat(visible)).toBeLessThan(45.95);
  });
});
