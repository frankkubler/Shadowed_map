// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEED_KMH,
  GpxError,
  haversine,
  parseGpx,
  passageTimes,
  trackBounds,
  trackDurationMinutes,
} from '../src/data/gpx';

/** Deux points séparés d'exactement 0,01° de latitude, soit ~1,11 km. */
const SIMPLE_GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <trk>
    <name>Boucle de test</name>
    <trkseg>
      <trkpt lat="45.900" lon="6.870"><ele>1000</ele></trkpt>
      <trkpt lat="45.910" lon="6.870"><ele>1120</ele></trkpt>
      <trkpt lat="45.920" lon="6.870"><ele>1040</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const TIMED_GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <trk><trkseg>
    <trkpt lat="45.900" lon="6.870"><ele>1000</ele><time>2026-06-21T06:00:00Z</time></trkpt>
    <trkpt lat="45.910" lon="6.870"><ele>1100</ele><time>2026-06-21T06:30:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

const ROUTE_GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <rte>
    <rtept lat="45.900" lon="6.870"></rtept>
    <rtept lat="45.910" lon="6.870"></rtept>
  </rte>
</gpx>`;

describe('haversine', () => {
  it("mesure environ 111 km pour un degré de latitude", () => {
    const d = haversine({ lng: 6, lat: 45 }, { lng: 6, lat: 46 });
    expect(d).toBeGreaterThan(111000);
    expect(d).toBeLessThan(111400);
  });

  it('est nulle entre un point et lui-même', () => {
    expect(haversine({ lng: 6.87, lat: 45.9 }, { lng: 6.87, lat: 45.9 })).toBeCloseTo(0, 6);
  });

  it('est symétrique', () => {
    const a = { lng: 2.35, lat: 48.85 };
    const b = { lng: 6.87, lat: 45.92 };
    expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 6);
  });
});

describe('parseGpx', () => {
  it('lit les points, le nom et les altitudes', () => {
    const track = parseGpx(SIMPLE_GPX);
    expect(track.points).toHaveLength(3);
    expect(track.name).toBe('Boucle de test');
    expect(track.points[0]?.elevation).toBe(1000);
    expect(track.points[0]?.lat).toBeCloseTo(45.9, 6);
    expect(track.points[0]?.lng).toBeCloseTo(6.87, 6);
  });

  it('cumule les distances dans l’ordre', () => {
    const track = parseGpx(SIMPLE_GPX);
    expect(track.cumulative[0]).toBe(0);
    expect(track.cumulative[1]).toBeGreaterThan(1000);
    expect(track.cumulative[2]).toBeGreaterThan(track.cumulative[1] as number);
    expect(track.totalDistance).toBeCloseTo(track.cumulative[2] as number, 6);
  });

  it('sépare montée et descente', () => {
    const track = parseGpx(SIMPLE_GPX);
    expect(track.ascent).toBeCloseTo(120, 0);
    expect(track.descent).toBeCloseTo(80, 0);
  });

  it('ignore les micro-variations d’altitude, qui sont du bruit GPS', () => {
    const noisy = `<?xml version="1.0"?><gpx><trk><trkseg>
      ${Array.from({ length: 40 }, (_, i) => `<trkpt lat="45.${900 + i}" lon="6.870"><ele>${1000 + (i % 2)}</ele></trkpt>`).join('')}
    </trkseg></trk></gpx>`;
    // Sommer les écarts bruts donnerait une vingtaine de mètres de dénivelé positif.
    expect(parseGpx(noisy).ascent).toBe(0);
  });

  it('retombe sur les points d’itinéraire quand il n’y a pas de trace', () => {
    expect(parseGpx(ROUTE_GPX).points).toHaveLength(2);
  });

  it('reconnaît les horodatages', () => {
    expect(parseGpx(TIMED_GPX).hasTimestamps).toBe(true);
    expect(parseGpx(SIMPLE_GPX).hasTimestamps).toBe(false);
  });

  it('rejette un fichier vide ou non exploitable', () => {
    expect(() => parseGpx('<gpx></gpx>')).toThrow(GpxError);
    expect(() => parseGpx('pas du xml du tout <<<')).toThrow(GpxError);
    // Un seul point ne fait pas un parcours.
    expect(() =>
      parseGpx('<gpx><trk><trkseg><trkpt lat="45" lon="6"/></trkseg></trk></gpx>'),
    ).toThrow(GpxError);
  });
});

describe('passageTimes', () => {
  it('répartit le temps à vitesse constante sans horodatage', () => {
    const track = parseGpx(SIMPLE_GPX);
    const departure = new Date(2026, 5, 21, 8, 0, 0, 0);
    const times = passageTimes(track, departure, 4);

    expect(times[0]?.getTime()).toBe(departure.getTime());
    // ~2,2 km à 4 km/h ≈ 33 min.
    const minutes = ((times[2] as Date).getTime() - departure.getTime()) / 60000;
    expect(minutes).toBeGreaterThan(30);
    expect(minutes).toBeLessThan(36);
  });

  it('va deux fois plus vite quand on double la vitesse', () => {
    const track = parseGpx(SIMPLE_GPX);
    const departure = new Date(2026, 5, 21, 8, 0);
    const slow = passageTimes(track, departure, 4);
    const fast = passageTimes(track, departure, 8);
    const slowSpan = (slow[2] as Date).getTime() - departure.getTime();
    const fastSpan = (fast[2] as Date).getTime() - departure.getTime();
    expect(fastSpan).toBeCloseTo(slowSpan / 2, -3);
  });

  it('conserve le rythme réel quand le fichier est horodaté', () => {
    const track = parseGpx(TIMED_GPX);
    const departure = new Date(2026, 5, 21, 9, 0, 0, 0);
    const times = passageTimes(track, departure, 99);

    expect(times[0]?.getTime()).toBe(departure.getTime());
    // L'écart de 30 min du fichier est préservé, la vitesse demandée est ignorée.
    expect((times[1] as Date).getTime() - departure.getTime()).toBe(30 * 60000);
  });

  it('reste croissant', () => {
    const times = passageTimes(parseGpx(SIMPLE_GPX), new Date(2026, 5, 21, 8, 0));
    for (let i = 1; i < times.length; i++) {
      expect((times[i] as Date).getTime()).toBeGreaterThanOrEqual((times[i - 1] as Date).getTime());
    }
  });
});

describe('trackDurationMinutes', () => {
  it('suit la distance et la vitesse', () => {
    const track = parseGpx(SIMPLE_GPX);
    expect(trackDurationMinutes(track, 4)).toBeCloseTo(
      (track.totalDistance / 1000 / 4) * 60,
      6,
    );
  });

  it('utilise les horodatages quand ils existent', () => {
    expect(trackDurationMinutes(parseGpx(TIMED_GPX), DEFAULT_SPEED_KMH)).toBe(30);
  });
});

describe('trackBounds', () => {
  it('encadre tous les points', () => {
    const bounds = trackBounds(parseGpx(SIMPLE_GPX));
    expect(bounds.south).toBeCloseTo(45.9, 6);
    expect(bounds.north).toBeCloseTo(45.92, 6);
    expect(bounds.west).toBeCloseTo(6.87, 6);
    expect(bounds.east).toBeCloseTo(6.87, 6);
  });
});
