/**
 * Banc de vérification du lancer de rayon, à exécuter dans un vrai navigateur.
 *
 * Les tests Node ne peuvent pas valider le shader : ils n'ont pas de GPU. Or c'est là
 * que se jouent les erreurs les plus coûteuses — un signe inversé dans la direction du
 * soleil produit une carte qui *semble* plausible tout en étant fausse.
 *
 * On construit donc un relief synthétique dont on connaît la réponse exacte : sol plat
 * à l'altitude 0, et une tour de 100 m au centre. À 45° de hauteur de soleil, son ombre
 * doit mesurer exactement 100 m, du côté opposé au soleil.
 *
 * Usage : `npm run dev` puis ouvrir /tools/gpu-check.html
 */
import { createFloatTexture, createUnitQuad, detectCapabilities } from '../src/shadow/glUtils';
import { ShadowPass, solveStepGrowth, type MarchParams } from '../src/shadow/raymarch';
import {
  EARTH_CIRCUMFERENCE,
  latToMercatorY,
  lngToMercatorX,
  metersPerMercatorUnit,
} from '../src/sun/mercator';
import { sunDirection, sunPosition, sunTimes } from '../src/sun/sun';
import {
  boundsToRegion,
  chooseDemZoom,
  computeFieldRegion,
  regionToBounds,
  squareRegion,
  type MercatorRegion,
} from '../src/shadow/region';
import { DemTileCache } from '../src/shadow/demTiles';
import { HeightField } from '../src/shadow/heightField';
import { EMPTY_MESH, meshFromOverpass } from '../src/shadow/buildings';

const FIELD_SIZE = 512;
const METERS_PER_TEXEL = 2;
const TOWER_HEIGHT = 100;
const TOWER_CENTER = 256;
const TOWER_HALF_WIDTH = 2;

/** Région carrée à l'équateur : le facteur d'échelle y vaut exactement la circonférence. */
function buildRegion(): MercatorRegion {
  const sizeMeters = FIELD_SIZE * METERS_PER_TEXEL;
  const sizeUnits = sizeMeters / EARTH_CIRCUMFERENCE;
  return {
    x0: 0.5 - sizeUnits / 2,
    x1: 0.5 + sizeUnits / 2,
    y0: 0.5 - sizeUnits / 2,
    y1: 0.5 + sizeUnits / 2,
  };
}

/** Sol plat à 0 m, tour carrée de 100 m au centre. */
function buildSyntheticField(): Float32Array {
  const data = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  for (let y = TOWER_CENTER - TOWER_HALF_WIDTH; y < TOWER_CENTER + TOWER_HALF_WIDTH; y++) {
    for (let x = TOWER_CENTER - TOWER_HALF_WIDTH; x < TOWER_CENTER + TOWER_HALF_WIDTH; x++) {
      data[y * FIELD_SIZE + x] = TOWER_HEIGHT;
    }
  }
  return data;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** Convertit une position en texels vers les coordonnées [0,1] attendues par `readMask`. */
function texelToUv(x: number, y: number): [number, number] {
  return [(x + 0.5) / FIELD_SIZE, (y + 0.5) / FIELD_SIZE];
}

export function runGpuChecks(canvas: HTMLCanvasElement): CheckResult[] {
  const results: CheckResult[] = [];
  const gl = canvas.getContext('webgl2');
  if (!gl) {
    return [{ name: 'Contexte WebGL2', passed: false, detail: 'webgl2 indisponible' }];
  }

  const caps = detectCapabilities(gl);
  results.push({
    name: 'EXT_color_buffer_float',
    passed: caps.colorBufferFloat,
    detail: caps.colorBufferFloat ? 'présent' : 'absent — le moteur ne peut pas fonctionner',
  });
  if (!caps.colorBufferFloat) return results;

  const quad = createUnitQuad(gl);
  const pass = new ShadowPass(gl, quad, FIELD_SIZE, 128);
  const region = buildRegion();
  const fieldTexture = createFloatTexture(gl, buildSyntheticField(), FIELD_SIZE);

  const params: MarchParams = {
    fieldTexture,
    fieldSize: FIELD_SIZE,
    fieldRegion: region,
    maskRegion: region,
    metersPerTexel: METERS_PER_TEXEL,
    maxFieldHeight: TOWER_HEIGHT + 1,
    steps: 256,
    stepGrowth: solveStepGrowth(FIELD_SIZE * Math.SQRT2, 256),
  };

  const shadowAt = (x: number, y: number): number => {
    const [u, v] = texelToUv(x, y);
    return pass.readMask(u, v)?.shadow ?? -1;
  };

  const check = (name: string, passed: boolean, detail: string) => {
    results.push({ name, passed, detail });
  };

  // --- Soleil plein sud, 45° : l'ombre doit s'étendre de 100 m vers le nord ---------
  // En espace texel, le nord correspond aux y décroissants.
  const south = sunDirection(0);
  pass.renderShadow(
    params,
    { dir: [south.east, -south.north], tanAltitude: Math.tan(Math.PI / 4) },
    false,
  );

  // 100 m d'ombre = 50 texels. On teste bien à l'intérieur et bien à l'extérieur pour
  // ne pas dépendre de l'adoucissement bilinéaire au bord.
  check(
    'Ombre présente à 40 texels au nord de la tour',
    shadowAt(TOWER_CENTER, TOWER_CENTER - 40) > 0.5,
    `valeur = ${shadowAt(TOWER_CENTER, TOWER_CENTER - 40).toFixed(2)} (attendu 1)`,
  );
  check(
    'Plein soleil à 65 texels au nord (au-delà des 50 texels théoriques)',
    shadowAt(TOWER_CENTER, TOWER_CENTER - 65) < 0.5,
    `valeur = ${shadowAt(TOWER_CENTER, TOWER_CENTER - 65).toFixed(2)} (attendu 0)`,
  );
  check(
    "Pas d'ombre du côté du soleil (au sud de la tour)",
    shadowAt(TOWER_CENTER, TOWER_CENTER + 40) < 0.5,
    `valeur = ${shadowAt(TOWER_CENTER, TOWER_CENTER + 40).toFixed(2)} (attendu 0)`,
  );
  check(
    "Pas d'ombre latéralement, à l'est de la tour",
    shadowAt(TOWER_CENTER + 40, TOWER_CENTER) < 0.5,
    `valeur = ${shadowAt(TOWER_CENTER + 40, TOWER_CENTER).toFixed(2)} (attendu 0)`,
  );

  // Longueur mesurée : dernier texel ombré en remontant vers le nord.
  let measured = 0;
  for (let d = 1; d < 120; d++) {
    if (shadowAt(TOWER_CENTER, TOWER_CENTER - d) > 0.5) measured = d;
  }
  const measuredMeters = measured * METERS_PER_TEXEL;
  check(
    'Longueur d’ombre mesurée ≈ hauteur / tan(45°) = 100 m',
    Math.abs(measuredMeters - TOWER_HEIGHT) <= 12,
    `mesuré ${measuredMeters} m, attendu 100 m (tolérance 12 m)`,
  );

  // --- Soleil à l'est : l'ombre bascule vers l'ouest --------------------------------
  const east = sunDirection(-Math.PI / 2);
  pass.renderShadow(
    params,
    { dir: [east.east, -east.north], tanAltitude: Math.tan(Math.PI / 4) },
    false,
  );
  check(
    "Soleil à l'est : ombre à l'ouest de la tour",
    shadowAt(TOWER_CENTER - 40, TOWER_CENTER) > 0.5,
    `valeur = ${shadowAt(TOWER_CENTER - 40, TOWER_CENTER).toFixed(2)} (attendu 1)`,
  );
  check(
    "Soleil à l'est : plein soleil à l'est de la tour",
    shadowAt(TOWER_CENTER + 40, TOWER_CENTER) < 0.5,
    `valeur = ${shadowAt(TOWER_CENTER + 40, TOWER_CENTER).toFixed(2)} (attendu 0)`,
  );

  // --- Soleil bas : l'ombre s'allonge ----------------------------------------------
  pass.renderShadow(
    params,
    { dir: [south.east, -south.north], tanAltitude: Math.tan(Math.PI / 12) },
    false,
  );
  // 100 / tan(15°) = 373 m = 187 texels
  check(
    'Soleil à 15° : ombre encore présente à 150 texels',
    shadowAt(TOWER_CENTER, TOWER_CENTER - 150) > 0.5,
    `valeur = ${shadowAt(TOWER_CENTER, TOWER_CENTER - 150).toFixed(2)} (attendu 1)`,
  );

  // --- Nuit -------------------------------------------------------------------------
  pass.renderShadow(params, { dir: [0, 1], tanAltitude: 0.1 }, true);
  check(
    'Nuit : toute la zone est à l’ombre',
    shadowAt(10, 10) > 0.5 && shadowAt(500, 500) > 0.5,
    `coins = ${shadowAt(10, 10).toFixed(2)} / ${shadowAt(500, 500).toFixed(2)} (attendu 1)`,
  );

  pass.dispose();
  gl.deleteTexture(fieldTexture);
  gl.deleteBuffer(quad);

  return results;
}

/** Taille du champ pour la vérification sur données réelles — plus petite, pour limiter le nombre de tuiles. */
const TERRAIN_FIELD_SIZE = 1024;

/** Vallée de Chamonix : dénivelé de 3 800 m sur quelques kilomètres, cas d'école. */
const CHAMONIX_VALLEY = { lng: 6.8694, lat: 45.9237 };
const MONT_BLANC_SUMMIT = { lng: 6.8652, lat: 45.8326 };

/**
 * Vérification de bout en bout sur du relief réel.
 *
 * Peu après le lever du soleil, le fond de la vallée de Chamonix (1 035 m) est encore
 * dans l'ombre des massifs qui l'encadrent, alors que le sommet du Mont-Blanc (4 808 m)
 * est déjà éclairé. C'est une propriété robuste : elle ne dépend ni de la date exacte
 * ni de la résolution du modèle.
 */
export async function runTerrainChecks(canvas: HTMLCanvasElement): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const gl = canvas.getContext('webgl2');
  if (!gl || !detectCapabilities(gl).colorBufferFloat) {
    return [{ name: 'Contexte WebGL2', passed: false, detail: 'prérequis GPU absents' }];
  }

  // Fenêtre d'environ 25 km de côté autour de la vallée.
  const halfSpanDeg = 0.16;
  const visible = boundsToRegion({
    west: CHAMONIX_VALLEY.lng - halfSpanDeg,
    east: CHAMONIX_VALLEY.lng + halfSpanDeg,
    south: CHAMONIX_VALLEY.lat - halfSpanDeg * 0.7,
    north: CHAMONIX_VALLEY.lat + halfSpanDeg * 0.7,
  });

  const times = sunTimes(new Date('2026-06-21T12:00:00Z'), CHAMONIX_VALLEY.lat, CHAMONIX_VALLEY.lng);
  if (!times.sunrise) {
    return [{ name: 'Lever du soleil', passed: false, detail: 'introuvable' }];
  }
  const date = new Date(times.sunrise.getTime() + 15 * 60 * 1000);
  const sun = sunPosition(date, CHAMONIX_VALLEY.lat, CHAMONIX_VALLEY.lng);
  const dir = sunDirection(sun.azimuth);

  const fieldRegion = squareRegion(
    computeFieldRegion({ visible, sunDir: dir, sunAltitude: sun.altitude, reliefMeters: 4000 })
      .region,
  );
  const demZoom = chooseDemZoom(fieldRegion, TERRAIN_FIELD_SIZE);

  // --- Chargement des tuiles réelles ------------------------------------------------
  // Un miroir local peut être fourni via ?dem=… : c'est ce qui permet de faire tourner
  // ce banc derrière un réseau restreint, avec un jeu de tuiles téléchargé à l'avance.
  const demBase = new URLSearchParams(location.search).get('dem') ?? undefined;
  const cache = demBase ? new DemTileCache(256, demBase) : new DemTileCache();
  const bounds = regionToBounds(fieldRegion);
  const scale = Math.pow(2, demZoom);
  const minX = Math.floor(lngToMercatorX(bounds.west) * scale);
  const maxX = Math.floor(lngToMercatorX(bounds.east) * scale);
  const minY = Math.floor(latToMercatorY(bounds.north) * scale);
  const maxY = Math.floor(latToMercatorY(bounds.south) * scale);

  const coords: { x: number; y: number; z: number }[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) coords.push({ x, y, z: demZoom });
  }

  // Chargement par lots : ouvrir une centaine de connexions simultanées vers S3 fait
  // régulièrement retomber des requêtes en erreur réseau.
  let available = 0;
  const CONCURRENCY = 6;
  for (let i = 0; i < coords.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      coords.slice(i, i + CONCURRENCY).map((c) => cache.load(c)),
    );
    available += batch.filter(Boolean).length;
  }
  results.push({
    name: 'Tuiles d’élévation téléchargées',
    passed: available > 0,
    detail: `${available}/${coords.length} tuiles au zoom ${demZoom}`,
  });
  if (available === 0) return results;

  // --- Altitudes lues ---------------------------------------------------------------
  const summitElevation = cache.elevationAt(MONT_BLANC_SUMMIT.lng, MONT_BLANC_SUMMIT.lat, demZoom);
  const valleyElevation = cache.elevationAt(CHAMONIX_VALLEY.lng, CHAMONIX_VALLEY.lat, demZoom);
  results.push({
    name: 'Altitude du Mont-Blanc plausible (4 800 m environ)',
    passed: summitElevation !== null && summitElevation > 4000 && summitElevation < 5000,
    detail: `lu ${summitElevation === null ? 'rien' : `${Math.round(summitElevation)} m`}`,
  });
  results.push({
    name: 'Altitude du fond de vallée plausible (1 000 m environ)',
    passed: valleyElevation !== null && valleyElevation > 700 && valleyElevation < 1600,
    detail: `lu ${valleyElevation === null ? 'rien' : `${Math.round(valleyElevation)} m`}`,
  });

  // --- Construction du champ et lancer de rayon -------------------------------------
  const quad = createUnitQuad(gl);
  const field = new HeightField(gl, quad, TERRAIN_FIELD_SIZE);
  const stats = field.build({
    region: fieldRegion,
    demZoom,
    demCache: cache,
    buildings: EMPTY_MESH,
  });
  results.push({
    name: 'Champ de hauteur cohérent avec le relief alpin',
    passed: stats.maxHeight > 3500 && stats.minHeight < 1500,
    detail: `min ${Math.round(stats.minHeight)} m, max ${Math.round(stats.maxHeight)} m, ${stats.tilesDrawn} tuiles`,
  });

  const pass = new ShadowPass(gl, quad, 512, 128);
  const metersPerTexel =
    ((fieldRegion.x1 - fieldRegion.x0) * metersPerMercatorUnit(CHAMONIX_VALLEY.lat)) /
    TERRAIN_FIELD_SIZE;

  pass.renderShadow(
    {
      fieldTexture: field.texture,
      fieldSize: TERRAIN_FIELD_SIZE,
      fieldRegion,
      maskRegion: visible,
      metersPerTexel,
      maxFieldHeight: stats.maxHeight + 1,
      steps: 256,
      stepGrowth: solveStepGrowth(TERRAIN_FIELD_SIZE * Math.SQRT2, 256),
    },
    { dir: [dir.east, -dir.north], tanAltitude: Math.tan(sun.altitude) },
    false,
  );

  const readAt = (lng: number, lat: number) => {
    const u = (lngToMercatorX(lng) - visible.x0) / (visible.x1 - visible.x0);
    const v = (latToMercatorY(lat) - visible.y0) / (visible.y1 - visible.y0);
    return pass.readMask(u, v);
  };

  const summit = readAt(MONT_BLANC_SUMMIT.lng, MONT_BLANC_SUMMIT.lat);
  const valley = readAt(CHAMONIX_VALLEY.lng, CHAMONIX_VALLEY.lat);
  const altitudeDeg = ((sun.altitude * 180) / Math.PI).toFixed(1);

  results.push({
    name: `Sommet au soleil peu après le lever (soleil à ${altitudeDeg}°)`,
    passed: summit !== null && summit.hasData && summit.shadow < 0.5,
    detail: `ombre = ${summit ? summit.shadow.toFixed(2) : 'hors champ'} (attendu 0)`,
  });
  results.push({
    name: 'Fond de vallée encore à l’ombre au même instant',
    passed: valley !== null && valley.hasData && valley.shadow > 0.5,
    detail: `ombre = ${valley ? valley.shadow.toFixed(2) : 'hors champ'} (attendu 1)`,
  });

  // --- Rasterisation des bâtiments --------------------------------------------------
  // L'appel à Overpass n'est pas testable ici, mais tout ce qui vient après l'est :
  // triangulation, calage sur l'altitude du terrain, et prise en compte par le rayon.
  // On pose une tour d'un kilomètre au fond de la vallée, à midi, et on vérifie qu'elle
  // projette une ombre là où il n'y en avait pas.
  const noonDate = times.solarNoon ?? date;
  const noon = sunPosition(noonDate, CHAMONIX_VALLEY.lat, CHAMONIX_VALLEY.lng);
  const noonDir = sunDirection(noon.azimuth);
  const noonParams = {
    fieldTexture: field.texture,
    fieldSize: TERRAIN_FIELD_SIZE,
    fieldRegion,
    maskRegion: visible,
    metersPerTexel,
    maxFieldHeight: stats.maxHeight + 1,
    steps: 256,
    stepGrowth: solveStepGrowth(TERRAIN_FIELD_SIZE * Math.SQRT2, 256),
  };
  const noonSun = {
    dir: [noonDir.east, -noonDir.north] as [number, number],
    tanAltitude: Math.tan(noon.altitude),
  };

  // Point d'observation : 250 m dans la direction de l'ombre depuis la tour.
  const shadowOffsetMeters = 250;
  const degPerMeterLat = 1 / 111320;
  const probe = {
    lng:
      CHAMONIX_VALLEY.lng +
      -noonDir.east * shadowOffsetMeters * degPerMeterLat /
        Math.cos((CHAMONIX_VALLEY.lat * Math.PI) / 180),
    lat: CHAMONIX_VALLEY.lat + -noonDir.north * shadowOffsetMeters * degPerMeterLat,
  };

  pass.renderShadow(noonParams, noonSun, false);
  const before = readAt(probe.lng, probe.lat);

  const halfSide = 0.0012; // ~130 m de demi-côté
  const tower = meshFromOverpass([
    {
      type: 'way',
      id: -1,
      tags: { building: 'yes', height: '1000' },
      geometry: [
        { lat: CHAMONIX_VALLEY.lat - halfSide, lon: CHAMONIX_VALLEY.lng - halfSide },
        { lat: CHAMONIX_VALLEY.lat - halfSide, lon: CHAMONIX_VALLEY.lng + halfSide },
        { lat: CHAMONIX_VALLEY.lat + halfSide, lon: CHAMONIX_VALLEY.lng + halfSide },
        { lat: CHAMONIX_VALLEY.lat + halfSide, lon: CHAMONIX_VALLEY.lng - halfSide },
        { lat: CHAMONIX_VALLEY.lat - halfSide, lon: CHAMONIX_VALLEY.lng - halfSide },
      ],
    },
  ]);

  const withTower = field.build({ region: fieldRegion, demZoom, demCache: cache, buildings: tower });
  results.push({
    name: 'Bâtiment rasterisé sur le relief (triangulation + calage en altitude)',
    passed: withTower.buildingVertices === 6,
    detail: `${withTower.buildingVertices} sommets écrits (6 attendus pour un carré)`,
  });

  pass.renderShadow({ ...noonParams, maxFieldHeight: withTower.maxHeight + 1 }, noonSun, false);
  const after = readAt(probe.lng, probe.lat);

  results.push({
    name: 'La tour projette une ombre à 250 m, dans la direction opposée au soleil',
    passed:
      before !== null && after !== null && before.shadow < 0.5 && after.shadow > 0.5,
    detail: `avant ${before ? before.shadow.toFixed(2) : '?'} → après ${after ? after.shadow.toFixed(2) : '?'} (attendu 0 → 1)`,
  });

  field.dispose();
  pass.dispose();
  gl.deleteBuffer(quad);
  return results;
}
