/**
 * Couche personnalisée MapLibre qui orchestre le moteur d'ombre.
 *
 * Le travail lourd (construction du champ de hauteur, lancer de rayon) a lieu dans
 * `prerender`, et seulement quand une entrée a changé — déplacement sortant de la
 * région couverte, changement d'heure, arrivée de nouvelles tuiles. `render` se
 * contente de plaquer le masque déjà calculé sur la carte.
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import {
  fromMercator,
  latToMercatorY,
  lngToMercatorX,
  metersPerMercatorUnit,
  mercatorYToLat,
  type Bounds,
} from '../sun/mercator';
import { isDaylight, sunDirection, sunPosition, MIN_USEFUL_ALTITUDE_RAD } from '../sun/sun';
import { createBuildingProvider, EMPTY_MESH, MIN_BUILDING_ZOOM, type BuildingResult } from './buildings';
import type { DemKind } from './demTiles';
import { DemTileCache } from './demTiles';
import { createUnitQuad, detectCapabilities } from './glUtils';
import { ProjectionProgramCache, setProjectionUniforms } from './projection';
import { HeightField } from './heightField';
import {
  EXPOSURE_BATCH_SIZE,
  ShadowPass,
  solveStepGrowth,
  type MarchParams,
  type MaskTarget,
  type SunSample,
} from './raymarch';
import {
  boundsToRegion,
  chooseDemZoom,
  computeFieldRegion,
  regionCenterLat,
  regionContains,
  regionToBounds,
  regionWidth,
  squareRegion,
  type MercatorRegion,
} from './region';
import { buildOverlayVertexSource, OVERLAY_FRAG } from './shaders';

const FIELD_SIZE = 2048;
const MASK_SIZE = 1024;
const EXPOSURE_SIZE = 768;
const RAY_STEPS = 256;

/** Intervalle entre deux échantillons du mode « heures de soleil », en minutes. */
const EXPOSURE_SAMPLE_MINUTES = 10;

/** Au-delà, la rotation du soleil rend la marge de la région obsolète : il faut reconstruire. */
const SUN_DIRECTION_TOLERANCE = 0.05;

export type EngineStatus = 'ok' | 'unsupported' | 'loading';

export interface ShadowLayerOptions {
  shadowColor: [number, number, number];
  opacity: number;
  onStatus?: (status: ShadowLayerState) => void;
}

export interface ShadowLayerState {
  engine: EngineStatus;
  message: string | null;
  buildings: BuildingResult['status'];
  /** Progression du calcul d'ensoleillement, entre 0 et 1. `null` hors de ce mode. */
  exposureProgress: number | null;
  maxExposureHours: number;
  /** Progression d'un balayage horaire, entre 0 et 1. `null` quand aucun n'est en cours. */
  sweepProgress: number | null;
}

export interface LngLatPoint {
  lng: number;
  lat: number;
}

/** `sunlit[instant][point]` : true au soleil, false à l'ombre, null hors du champ calculé. */
export interface SweepResult {
  sunlit: (boolean | null)[][];
}

export interface PointQuery {
  inShade: boolean;
  hasData: boolean;
  elevation: number | null;
  /** Minutes de soleil dans la journée, seulement en mode ensoleillement. */
  sunMinutes: number | null;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean.padEnd(6, '0');
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

export class ShadowLayer implements CustomLayerInterface {
  readonly id = 'shadow';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private quad: WebGLBuffer | null = null;
  private field: HeightField | null = null;
  private pass: ShadowPass | null = null;
  private overlayPrograms: ProjectionProgramCache | null = null;

  private demCache = new DemTileCache();
  private buildingProvider: ReturnType<typeof createBuildingProvider>;
  private buildings: BuildingResult = { data: EMPTY_MESH, bounds: null, status: 'idle' };

  private date = new Date();
  private mode: 'shadow' | 'exposure' = 'shadow';
  private shadowColor: [number, number, number];
  private opacity: number;

  private fieldRegion: MercatorRegion | null = null;
  private maskRegion: MercatorRegion | null = null;
  private marchParams: MarchParams | null = null;
  private demZoom = 12;
  private lastSunDir: [number, number] = [0, 0];
  private needsFieldRebuild = true;
  /** Nature de la dernière tuile obtenue : décide du zoom exploitable. */
  private demKind: DemKind | null = null;
  private needsMaskRender = true;

  private sweep: {
    dates: Date[];
    points: LngLatPoint[];
    cursor: number;
    sunlit: (boolean | null)[][];
    resolve: (result: SweepResult) => void;
  } | null = null;

  private exposureSamples: SunSample[] = [];
  private exposureCursor = 0;
  private exposureDirty = true;
  private maxExposureHours = 0;

  private state: ShadowLayerState = {
    engine: 'ok',
    message: null,
    buildings: 'idle',
    exposureProgress: null,
    maxExposureHours: 0,
    sweepProgress: null,
  };

  constructor(private readonly options: ShadowLayerOptions) {
    this.shadowColor = options.shadowColor;
    this.opacity = options.opacity;
    this.buildingProvider = createBuildingProvider((result) => {
      this.buildings = result;
      this.needsFieldRebuild = true;
      this.exposureDirty = true;
      this.publishState({ buildings: result.status });
      this.map?.triggerRepaint();
    });
  }

  // --- API publique ---------------------------------------------------------

  setDate(date: Date): void {
    if (date.getTime() === this.date.getTime()) return;
    this.date = date;
    this.needsMaskRender = true;
    // La marge de la région dépend de la hauteur du soleil : un grand saut d'heure
    // peut la rendre insuffisante, d'où la reconstruction quand la direction change.
    this.exposureDirty = true;
    this.map?.triggerRepaint();
  }

  setMode(mode: 'shadow' | 'exposure'): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.exposureDirty = true;
    this.needsMaskRender = true;
    this.map?.triggerRepaint();
  }

  setAppearance(color: string, opacity: number): void {
    this.shadowColor = hexToRgb(color);
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  getState(): Readonly<ShadowLayerState> {
    return this.state;
  }

  elevationAt(lng: number, lat: number): number | null {
    return this.demCache.elevationAt(lng, lat, this.demZoom);
  }

  /** Interroge le résultat déjà calculé en un point géographique. */
  queryPoint(lng: number, lat: number): PointQuery | null {
    if (!this.pass || !this.maskRegion) return null;

    const mx = lngToMercatorX(lng);
    const my = latToMercatorY(lat);
    const u = (mx - this.maskRegion.x0) / regionWidth(this.maskRegion);
    const v = (my - this.maskRegion.y0) / (this.maskRegion.y1 - this.maskRegion.y0);

    const elevation = this.elevationAt(lng, lat);

    if (this.mode === 'exposure') {
      const minutes = this.pass.readExposure(u, v);
      return {
        inShade: false,
        hasData: minutes !== null,
        elevation,
        sunMinutes: minutes,
      };
    }

    const mask = this.pass.readMask(u, v);
    if (!mask) return null;
    return { inShade: mask.shadow > 0.5, hasData: mask.hasData, elevation, sunMinutes: null };
  }

  /**
   * Interroge l'ombre en de nombreux points d'un coup.
   *
   * Passe par la copie CPU du masque : une seule synchronisation GPU, quel que soit le
   * nombre de points. Les points hors du masque renvoient `null` plutôt qu'une valeur
   * inventée — un point non calculé n'est pas un point au soleil.
   */
  queryPoints(points: readonly LngLatPoint[]): (boolean | null)[] {
    if (!this.pass || !this.maskRegion || points.length === 0) {
      return points.map(() => null);
    }
    return this.samplePoints(points);
  }

  /** Échantillonne un masque. La lecture groupée n'a lieu qu'une fois par rendu. */
  private samplePoints(
    points: readonly LngLatPoint[],
    target: MaskTarget = 'main',
  ): (boolean | null)[] {
    const pass = this.pass as ShadowPass;
    const region = this.maskRegion as MercatorRegion;
    const buffer = pass.readMaskBuffer(target);
    const size = pass.maskSize;
    const width = regionWidth(region);
    const height = region.y1 - region.y0;

    return points.map((point) => {
      const u = (lngToMercatorX(point.lng) - region.x0) / width;
      const v = (latToMercatorY(point.lat) - region.y0) / height;
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;

      const x = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
      const y = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
      const offset = (y * size + x) * 4;
      if ((buffer[offset + 1] ?? 0) <= 127) return null; // relief inconnu ici
      return (buffer[offset] ?? 0) < 128;
    });
  }

  /**
   * Calcule l'ombre en chaque point, pour chaque instant demandé.
   *
   * Sert à la fois au « jusqu'à quand cette terrasse est-elle au soleil ? » et au profil
   * d'ensoleillement d'une trace GPX — même mécanique, deux usages.
   *
   * Le champ de hauteur est reconstruit avec une marge omnidirectionnelle : sur une
   * journée le soleil fait le tour, et la marge unidirectionnelle du mode normal
   * laisserait passer les obstacles situés du côté opposé au soleil de départ.
   */
  sweepTimes(dates: readonly Date[], points: readonly LngLatPoint[]): Promise<SweepResult> {
    if (dates.length === 0 || points.length === 0 || !this.map) {
      return Promise.resolve({ sunlit: dates.map(() => points.map(() => null)) });
    }

    // Un balayage déjà en cours est abandonné : c'est le plus récent qui intéresse
    // l'utilisateur (il vient de bouger le curseur d'heure de départ).
    this.sweep?.resolve({ sunlit: [] });

    return new Promise<SweepResult>((resolve) => {
      this.sweep = {
        dates: [...dates],
        points: [...points],
        cursor: 0,
        sunlit: [],
        resolve,
      };
      // La marge du champ doit changer de forme : on force la reconstruction.
      this.needsFieldRebuild = true;
      this.publishState({ sweepProgress: 0 });
      this.map?.triggerRepaint();
    });
  }

  // --- Cycle de vie MapLibre ------------------------------------------------

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;

    const caps = detectCapabilities(gl);
    if (!caps.webgl2 || !caps.colorBufferFloat) {
      this.publishState({
        engine: 'unsupported',
        message: !caps.webgl2
          ? "Ce navigateur n'expose pas WebGL2 : le calcul des ombres est impossible."
          : "Ce GPU ne permet pas le rendu en virgule flottante (EXT_color_buffer_float), requis par le calcul des ombres.",
      });
      return;
    }

    const gl2 = gl as WebGL2RenderingContext;
    this.gl = gl2;
    this.quad = createUnitQuad(gl2);
    this.field = new HeightField(gl2, this.quad, FIELD_SIZE);
    this.pass = new ShadowPass(gl2, this.quad, MASK_SIZE, EXPOSURE_SIZE);
    this.overlayPrograms = new ProjectionProgramCache(gl2, buildOverlayVertexSource, OVERLAY_FRAG);

    map.on('move', this.handleMove);
    this.handleMove();
  }

  onRemove(): void {
    this.map?.off('move', this.handleMove);
    this.buildingProvider.cancel();
    this.field?.dispose();
    this.pass?.dispose();
    this.overlayPrograms?.dispose();
    if (this.gl && this.quad) this.gl.deleteBuffer(this.quad);
    this.map = null;
    this.gl = null;
  }

  private handleMove = (): void => {
    const map = this.map;
    if (!map) return;
    this.needsMaskRender = true;
    this.exposureDirty = true;

    const bounds = this.visibleBounds();
    this.buildingProvider.request(bounds, map.getZoom());
  };

  prerender(_gl: WebGLRenderingContext | WebGL2RenderingContext, _options: CustomRenderMethodInput): void {
    if (!this.gl || !this.field || !this.pass || !this.map) return;

    const visible = boundsToRegion(this.visibleBounds());
    const centerLat = regionCenterLat(visible);
    const centerLng = (visible.x0 + visible.x1) / 2 * 360 - 180;
    const sun = sunPosition(this.date, centerLat, centerLng);
    const dir = sunDirection(sun.azimuth);
    const texelDir: [number, number] = [dir.east, -dir.north];

    const sunMoved =
      Math.abs(texelDir[0] - this.lastSunDir[0]) + Math.abs(texelDir[1] - this.lastSunDir[1]) >
      SUN_DIRECTION_TOLERANCE;
    const outsideField = !this.fieldRegion || !regionContains(this.fieldRegion, visible);

    // Pendant un balayage la direction du soleil change à chaque instant : la laisser
    // déclencher une reconstruction du champ rendrait le calcul interminable.
    const sweeping = this.sweep !== null;
    if ((sunMoved && !sweeping) || outsideField || this.needsFieldRebuild) {
      this.recomputeRegions(visible, sun.altitude, texelDir, sweeping);
      this.lastSunDir = texelDir;
      this.needsFieldRebuild = true;
    }

    this.maskRegion = visible;

    const allTilesReady = this.ensureDemTiles();

    if (this.needsFieldRebuild && this.fieldRegion) {
      const stats = this.field.build({
        region: this.fieldRegion,
        demZoom: this.demZoom,
        demCache: this.demCache,
        buildings: this.buildings.data,
      });
      this.needsFieldRebuild = false;
      this.needsMaskRender = true;
      this.exposureDirty = true;
      this.publishState({
        engine: allTilesReady ? 'ok' : 'loading',
        maxHeightHint: stats.maxHeight,
      });
    }

    if (!this.fieldRegion) return;
    this.marchParams = this.buildMarchParams(this.fieldRegion, visible, centerLat);

    if (this.sweep) {
      this.stepSweep(centerLat, centerLng);
      return;
    }

    if (this.mode === 'exposure') {
      this.stepExposure(centerLat, centerLng);
      return;
    }

    if (this.needsMaskRender) {
      this.pass.renderShadow(
        this.marchParams,
        { dir: texelDir, tanAltitude: Math.tan(Math.max(sun.altitude, MIN_USEFUL_ALTITUDE_RAD)) },
        !isDaylight(sun.altitude),
      );
      this.needsMaskRender = false;
      this.publishState({ exposureProgress: null });
    }
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const gl2 = this.gl;
    if (!gl2 || !this.pass || !this.overlayPrograms || !this.maskRegion) return;
    if (this.state.engine === 'unsupported') return;
    // En mode ensoleillement, ne rien afficher tant que le premier calcul n'est pas terminé :
    // une accumulation partielle donnerait des durées fausses, pas juste imprécises.
    if (this.mode === 'exposure' && this.state.exposureProgress !== null && this.state.exposureProgress < 1) {
      return;
    }

    void gl;
    const region = this.maskRegion;
    const overlay = this.overlayPrograms.get(options.shaderData);
    if (!overlay) {
      this.publishState({
        engine: 'unsupported',
        message: `Le shader d'affichage n'a pas pu être compilé : ${this.overlayPrograms.error ?? 'raison inconnue'}`,
      });
      return;
    }
    const { program, uniforms } = overlay;

    gl2.useProgram(program);
    gl2.enable(gl2.BLEND);
    gl2.blendFunc(gl2.ONE, gl2.ONE_MINUS_SRC_ALPHA);
    gl2.disable(gl2.DEPTH_TEST);
    // MapLibre laisse le découpage par tuile armé sur le stencil et l'élimination des
    // faces arrière active. Le quad d'overlay n'appartient à aucune tuile et son sens
    // d'enroulement dépend de l'orientation de la caméra : sans ces deux désactivations,
    // il est rejeté silencieusement.
    gl2.disable(gl2.STENCIL_TEST);
    gl2.disable(gl2.CULL_FACE);

    // MapLibre lie un VAO pour ses propres couches ; y écrire nos pointeurs d'attributs
    // corromprait son état. On revient au VAO par défaut pour la durée de notre tracé.
    gl2.bindVertexArray(null);
    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.quad);
    const posLoc = gl2.getAttribLocation(program, 'a_pos');
    gl2.enableVertexAttribArray(posLoc);
    gl2.vertexAttribPointer(posLoc, 2, gl2.FLOAT, false, 0, 0);

    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(
      gl2.TEXTURE_2D,
      this.mode === 'exposure' ? this.pass.exposureTexture : this.pass.maskTexture,
    );
    gl2.uniform1i(uniforms.at('u_mask'), 0);
    setProjectionUniforms(gl2, uniforms, options.defaultProjectionData);

    gl2.uniform4f(uniforms.at('u_region'), region.x0, region.y0, region.x1, region.y1);
    gl2.uniform1i(uniforms.at('u_mode'), this.mode === 'exposure' ? 1 : 0);
    gl2.uniform3fv(uniforms.at('u_shadowColor'), this.shadowColor);
    gl2.uniform1f(uniforms.at('u_opacity'), this.opacity);
    gl2.uniform1f(uniforms.at('u_maxHours'), Math.max(this.maxExposureHours, 1));

    gl2.drawArrays(gl2.TRIANGLES, 0, 6);
    gl2.disableVertexAttribArray(posLoc);
  }

  // --- Interne --------------------------------------------------------------

  private visibleBounds(): Bounds {
    const map = this.map;
    if (!map) return { west: -180, south: -85, east: 180, north: 85 };
    const b = map.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  }

  /** Détermine la région du champ de hauteur et le zoom des tuiles DEM à charger. */
  private recomputeRegions(
    visible: MercatorRegion,
    sunAltitude: number,
    texelDir: [number, number],
    omnidirectional: boolean,
  ): void {
    const stats = this.field?.getStats();
    // Le dénivelé observé au tour précédent est le meilleur estimateur disponible de
    // la hauteur des obstacles susceptibles d'assombrir la vue.
    const relief = stats && stats.tilesDrawn > 0
      ? Math.max(200, stats.maxHeight - stats.minHeight)
      : undefined;

    const { region } = computeFieldRegion({
      visible,
      sunDir: { east: texelDir[0], north: -texelDir[1] },
      sunAltitude,
      omnidirectional,
      ...(relief !== undefined ? { reliefMeters: relief } : {}),
    });

    this.fieldRegion = squareRegion(region);
    // Le plafond dépend de ce que la dernière tuile a révélé : là où le LiDAR répond,
    // on peut descendre bien plus fin que les 3 mètres de terrarium.
    this.demZoom = chooseDemZoom(
      this.fieldRegion,
      FIELD_SIZE,
      undefined,
      this.demCache.maxZoomAt(this.demKind),
    );
  }

  /** Lance le chargement des tuiles manquantes. Renvoie `true` si tout est déjà là. */
  private ensureDemTiles(): boolean {
    if (!this.fieldRegion) return false;
    const bounds = regionToBounds(this.fieldRegion);
    const scale = Math.pow(2, this.demZoom);

    const minX = Math.floor(lngToMercatorX(bounds.west) * scale);
    const maxX = Math.floor(lngToMercatorX(bounds.east) * scale);
    const minY = Math.max(0, Math.floor(latToMercatorY(bounds.north) * scale));
    const maxY = Math.min(scale - 1, Math.floor(latToMercatorY(bounds.south) * scale));

    let complete = true;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const wrapped = ((x % scale) + scale) % scale;
        if (this.demCache.get(this.demZoom, wrapped, y)) continue;
        complete = false;
        void this.demCache.load({ x: wrapped, y, z: this.demZoom }).then((tile) => {
          if (!tile) return;
          // La nature de la source ne se connaît qu'une fois une tuile obtenue : la
          // première sert de sonde, les suivantes pourront être demandées plus fines.
          this.demKind = tile.kind;
          this.needsFieldRebuild = true;
          this.map?.triggerRepaint();
        });
      }
    }
    return complete;
  }

  private buildMarchParams(
    fieldRegion: MercatorRegion,
    maskRegion: MercatorRegion,
    centerLat: number,
  ): MarchParams {
    const field = this.field as HeightField;
    const stats = field.getStats();
    const metersPerTexel =
      (regionWidth(fieldRegion) * metersPerMercatorUnit(centerLat)) / FIELD_SIZE;

    // La marche ne peut de toute façon pas sortir du champ : plafonner la distance
    // à sa diagonale évite de gaspiller des pas hors des bornes.
    const maxDistanceTexels = FIELD_SIZE * Math.SQRT2;
    return {
      fieldTexture: field.texture,
      fieldSize: FIELD_SIZE,
      fieldRegion,
      maskRegion,
      metersPerTexel,
      maxFieldHeight: stats.maxHeight + 1,
      steps: RAY_STEPS,
      stepGrowth: solveStepGrowth(maxDistanceTexels, RAY_STEPS),
    };
  }

  /**
   * Fait avancer le balayage horaire de quelques instants par frame.
   *
   * Chaque instant coûte un lancer de rayon plein écran plus une lecture du masque :
   * tout enchaîner d'un bloc figerait l'onglet une à deux secondes.
   */
  private stepSweep(centerLat: number, centerLng: number): void {
    const sweep = this.sweep;
    const pass = this.pass;
    const params = this.marchParams;
    if (!sweep || !pass || !params) return;

    const INSTANTS_PER_FRAME = 4;
    const end = Math.min(sweep.cursor + INSTANTS_PER_FRAME, sweep.dates.length);
    for (let i = sweep.cursor; i < end; i++) {
      const date = sweep.dates[i] as Date;
      const { altitude, azimuth } = sunPosition(date, centerLat, centerLng);
      const dir = sunDirection(azimuth);
      pass.renderShadow(
        params,
        {
          dir: [dir.east, -dir.north],
          tanAltitude: Math.tan(Math.max(altitude, MIN_USEFUL_ALTITUDE_RAD)),
        },
        !isDaylight(altitude),
        'sweep',
      );
      sweep.sunlit.push(this.samplePoints(sweep.points, 'sweep'));
    }
    sweep.cursor = end;

    if (sweep.cursor < sweep.dates.length) {
      this.publishState({ sweepProgress: sweep.cursor / sweep.dates.length });
      this.map?.triggerRepaint();
      return;
    }

    this.sweep = null;
    // Le masque affiché n'a pas bougé (le balayage a sa propre cible) ; seule la marge
    // du champ doit revenir à sa forme orientée, moins grossière.
    this.needsFieldRebuild = true;
    this.publishState({ sweepProgress: null });
    sweep.resolve({ sunlit: sweep.sunlit });
    this.map?.triggerRepaint();
  }

  /**
   * Fait avancer l'accumulation d'ensoleillement d'un lot par frame.
   *
   * Tout calculer d'un coup figerait l'interface une à deux secondes ; en étalant sur
   * plusieurs frames, la carte reste manipulable et une barre de progression peut
   * rendre compte de l'avancement.
   */
  private stepExposure(centerLat: number, centerLng: number): void {
    const pass = this.pass;
    const params = this.marchParams;
    if (!pass || !params) return;

    if (this.exposureDirty) {
      this.exposureSamples = this.buildExposureSamples(centerLat, centerLng);
      this.exposureCursor = 0;
      this.maxExposureHours =
        (this.exposureSamples.length * EXPOSURE_SAMPLE_MINUTES) / 60;
      pass.resetExposure();
      this.exposureDirty = false;
    }

    if (this.exposureCursor >= this.exposureSamples.length) {
      this.publishState({ exposureProgress: 1, maxExposureHours: this.maxExposureHours });
      return;
    }

    const batch = this.exposureSamples.slice(
      this.exposureCursor,
      this.exposureCursor + EXPOSURE_BATCH_SIZE,
    );
    pass.accumulateExposure(params, batch, EXPOSURE_SAMPLE_MINUTES);
    this.exposureCursor += batch.length;

    this.publishState({
      exposureProgress: this.exposureCursor / Math.max(1, this.exposureSamples.length),
      maxExposureHours: this.maxExposureHours,
    });
    this.map?.triggerRepaint();
  }

  /** Positions du soleil échantillonnées sur la journée courante, uniquement de jour. */
  private buildExposureSamples(lat: number, lng: number): SunSample[] {
    const samples: SunSample[] = [];
    const day = new Date(this.date);
    day.setHours(0, 0, 0, 0);

    const stepMs = EXPOSURE_SAMPLE_MINUTES * 60 * 1000;
    for (let t = day.getTime(); t < day.getTime() + 24 * 3600 * 1000; t += stepMs) {
      const { altitude, azimuth } = sunPosition(new Date(t), lat, lng);
      if (altitude <= 0) continue;
      const dir = sunDirection(azimuth);
      samples.push({
        dir: [dir.east, -dir.north],
        tanAltitude: Math.tan(Math.max(altitude, MIN_USEFUL_ALTITUDE_RAD)),
      });
    }
    return samples;
  }

  private publishState(patch: Partial<ShadowLayerState> & { maxHeightHint?: number }): void {
    const { maxHeightHint, ...rest } = patch;
    void maxHeightHint;
    const next = { ...this.state, ...rest };
    const changed = (Object.keys(rest) as (keyof ShadowLayerState)[]).some(
      (key) => this.state[key] !== next[key],
    );
    if (!changed) return;
    this.state = next;
    this.options.onStatus?.(next);
  }
}

/** Coordonnées géographiques du centre d'une région — pratique pour le débogage. */
export function regionCenter(region: MercatorRegion): { lng: number; lat: number } {
  return fromMercator({
    x: (region.x0 + region.x1) / 2,
    y: (region.y0 + region.y1) / 2,
  });
}

export { mercatorYToLat, MIN_BUILDING_ZOOM };
