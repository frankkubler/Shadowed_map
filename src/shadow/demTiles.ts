/**
 * Chargement et décodage des tuiles d'élévation.
 *
 * Source : AWS Open Data « Terrain Tiles », encodage terrarium.
 *   https://registry.opendata.aws/terrain-tiles/
 *   altitude = (r * 256 + g + b / 256) - 32768
 *
 * Ce sont des tuiles de **terrain nu** (DEM) : ni bâtiments ni végétation. C'est
 * exactement ce qu'il faut ici, puisque les bâtiments sont ajoutés par-dessus à
 * partir d'OpenStreetMap.
 *
 * Chaque tuile est décodée une fois en Float32Array et conservée côté CPU : cela sert
 * à la fois à alimenter le GPU et à répondre aux requêtes ponctuelles d'altitude
 * (popup au clic, calage des bâtiments sur le relief).
 */
import { latToMercatorY, lngToMercatorX, type TileCoord } from '../sun/mercator';
import { decodePngRgb8 } from './png';
import { fetchLidarTile, IGN_MAX_ZOOM, IGN_TILE_SIZE } from './lidarIgn';

export const TERRARIUM_TILE_SIZE = 256;
export const TERRARIUM_MAX_ZOOM = 15;

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

/** Valeur rendue quand aucune donnée n'est disponible : plus basse que tout terrain réel. */
export const NO_DATA_ELEVATION = -10000;

/**
 * Nature de la tuile. `surface` signifie que le sursol — toits, arbres — est déjà dans
 * les altitudes : il ne faut alors surtout pas y extruder les bâtiments d'OpenStreetMap,
 * ils seraient comptés deux fois.
 */
export type DemKind = 'terrain' | 'surface';

export interface DemTile {
  coord: TileCoord;
  size: number;
  /** Altitudes en mètres, ligne par ligne depuis le nord-ouest. */
  elevations: Float32Array;
  minElevation: number;
  maxElevation: number;
  kind: DemKind;
}

function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

let decodeCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let decodeContext: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

function getDecodeContext(size: number) {
  if (!decodeContext) {
    decodeCanvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement('canvas'), { width: size, height: size });
    // willReadFrequently : on ne fait que du getImageData, autant le dire au navigateur.
    decodeContext = (decodeCanvas as HTMLCanvasElement).getContext('2d', {
      willReadFrequently: true,
    }) as CanvasRenderingContext2D;
  }
  if (decodeCanvas && (decodeCanvas.width !== size || decodeCanvas.height !== size)) {
    decodeCanvas.width = size;
    decodeCanvas.height = size;
  }
  if (!decodeContext) throw new Error("Impossible d'obtenir un contexte 2D pour décoder les tuiles.");
  return decodeContext;
}

function decodeTerrarium(
  pixels: Uint8ClampedArray | Uint8Array,
  size: number,
  stride: number,
): DemTile['elevations'] {
  const count = size * size;
  const elevations = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const r = pixels[o] ?? 0;
    const g = pixels[o + 1] ?? 0;
    const b = pixels[o + 2] ?? 0;
    elevations[i] = r * 256 + g + b / 256 - 32768;
  }
  return elevations;
}

/**
 * Cache LRU en mémoire. Une tuile décodée pèse 256 Ko ; 256 tuiles ≈ 64 Mo, ce qui
 * couvre largement plusieurs déplacements de carte sans pression mémoire notable.
 */
export class DemTileCache {
  private tiles = new Map<string, DemTile>();
  private inFlight = new Map<string, Promise<DemTile | null>>();
  private failed = new Set<string>();

  /**
   * `baseUrl` permet de pointer vers un miroir ou un jeu de tuiles local — ce dont se
   * sert le banc de vérification, et ce qu'il faudra faire si le site prend de l'audience.
   */
  constructor(
    private readonly maxTiles = 256,
    private readonly baseUrl = TERRARIUM_URL,
    /**
     * Le LiDAR HD de l'IGN est essayé en premier là où il existe : il est six fois plus
     * fin que terrarium et porte le sursol. Désactivable pour le banc de vérification.
     */
    private readonly useLidar = true,
  ) {}

  /** Zoom maximal exploitable ici : celui du LiDAR s'il couvre, celui de terrarium sinon. */
  maxZoomAt(kind: DemKind | null): number {
    return kind === 'surface' ? IGN_MAX_ZOOM : TERRARIUM_MAX_ZOOM;
  }

  get(z: number, x: number, y: number): DemTile | undefined {
    const key = tileKey(z, x, y);
    const tile = this.tiles.get(key);
    if (tile) {
      // Réinsertion en fin de Map : c'est l'ordre d'itération qui fait le LRU.
      this.tiles.delete(key);
      this.tiles.set(key, tile);
    }
    return tile;
  }

  /** Charge la tuile si besoin. Renvoie `null` si elle est absente du serveur (océan, hors couverture). */
  async load(coord: TileCoord, signal?: AbortSignal): Promise<DemTile | null> {
    const key = tileKey(coord.z, coord.x, coord.y);
    const cached = this.tiles.get(key);
    if (cached) return cached;
    if (this.failed.has(key)) return null;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = this.fetchTile(coord, signal)
      .then((tile) => {
        if (tile) this.insert(key, tile);
        else this.failed.add(key);
        return tile;
      })
      .catch(() => {
        // Un échec réseau ne doit pas être définitif : on ne marque pas la tuile
        // comme absente, elle sera retentée au prochain déplacement.
        return null;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  private async fetchTile(coord: TileCoord, signal?: AbortSignal): Promise<DemTile | null> {
    if (this.useLidar && coord.z <= IGN_MAX_ZOOM) {
      // Un refus du service est transitoire : on ne l'absorbe que si terrarium peut
      // prendre le relais. Sinon on laisse remonter, pour que la tuile soit redemandée
      // au lieu d'être classée absente à tort.
      const secours = coord.z <= TERRARIUM_MAX_ZOOM;
      const lidar = secours
        ? await fetchLidarTile(coord, signal).catch(() => null)
        : await fetchLidarTile(coord, signal);
      if (lidar) return this.buildTile(coord, IGN_TILE_SIZE, lidar, 'surface');
    }
    // Terrarium ne va pas au-delà de son zoom natif : au-dessus, mieux vaut pas de
    // tuile du tout qu'une tuile étirée qui contredirait ses voisines.
    if (coord.z > TERRARIUM_MAX_ZOOM) return null;

    const url = `${this.baseUrl}/${coord.z}/${coord.x}/${coord.y}.png`;
    const response = await fetch(url, { signal, mode: 'cors' });
    if (!response.ok) return null;

    // Décodage exact, sans canvas : voir `png.ts`. Le chemin par canvas reste en repli
    // pour un format de tuile inattendu, au prix de quelques pixels altérés.
    const donnees = await response.arrayBuffer();
    const png = await decodePngRgb8(donnees);

    if (png) {
      return this.buildTile(coord, png.width, decodeTerrarium(png.rgb, png.width, 3), 'terrain');
    }
    const bitmap = await createImageBitmap(new Blob([donnees]));
    const size = bitmap.width;
    const ctx = getDecodeContext(size);
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const elevations = decodeTerrarium(ctx.getImageData(0, 0, size, size).data, size, 4);
    return this.buildTile(coord, size, elevations, 'terrain');
  }

  private buildTile(
    coord: TileCoord,
    size: number,
    elevations: Float32Array,
    kind: DemKind,
  ): DemTile {
    let min = Infinity;
    let max = -Infinity;
    for (const v of elevations) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { coord, size, elevations, minElevation: min, maxElevation: max, kind };
  }

  private insert(key: string, tile: DemTile): void {
    this.tiles.set(key, tile);
    while (this.tiles.size > this.maxTiles) {
      const oldest = this.tiles.keys().next();
      if (oldest.done) break;
      this.tiles.delete(oldest.value);
    }
  }

  /**
   * Altitude en un point, interpolée bilinéairement depuis la tuile déjà chargée.
   * Renvoie `null` si la tuile n'est pas en cache — l'appelant décide alors s'il
   * attend ou s'il se contente d'une valeur approchée.
   */
  /**
   * Nature de la donnée sous ce point, ou `null` si la tuile n'est pas chargée.
   * Sert à savoir si les bâtiments y sont déjà présents.
   */
  kindAt(lng: number, lat: number, z: number): DemKind | null {
    const scale = Math.pow(2, z);
    const tile = this.get(
      z,
      Math.floor(lngToMercatorX(lng) * scale),
      Math.floor(latToMercatorY(lat) * scale),
    );
    return tile?.kind ?? null;
  }

  elevationAt(lng: number, lat: number, z: number): number | null {
    const scale = Math.pow(2, z);
    const gx = lngToMercatorX(lng) * scale;
    const gy = latToMercatorY(lat) * scale;
    const tile = this.get(z, Math.floor(gx), Math.floor(gy));
    if (!tile) return null;

    const { size, elevations } = tile;
    // -0.5 : les valeurs sont au centre des texels, pas à leur coin.
    const px = (gx - Math.floor(gx)) * size - 0.5;
    const py = (gy - Math.floor(gy)) * size - 0.5;
    const x0 = Math.max(0, Math.min(size - 1, Math.floor(px)));
    const y0 = Math.max(0, Math.min(size - 1, Math.floor(py)));
    const x1 = Math.min(size - 1, x0 + 1);
    const y1 = Math.min(size - 1, y0 + 1);
    const fx = Math.max(0, Math.min(1, px - x0));
    const fy = Math.max(0, Math.min(1, py - y0));

    const h00 = elevations[y0 * size + x0] ?? 0;
    const h10 = elevations[y0 * size + x1] ?? 0;
    const h01 = elevations[y1 * size + x0] ?? 0;
    const h11 = elevations[y1 * size + x1] ?? 0;
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  }
}
