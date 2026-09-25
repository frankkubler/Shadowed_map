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
import {
  fetchLidarTile,
  IGN_MAX_ZOOM,
  IGN_MIN_ZOOM,
  IGN_TILE_SIZE,
  LidarHttpError,
  type LidarProduct,
} from './lidarIgn';

export const TERRARIUM_TILE_SIZE = 256;
export const TERRARIUM_MAX_ZOOM = 15;

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

/** Valeur rendue quand aucune donnée n'est disponible : plus basse que tout terrain réel. */
export const NO_DATA_ELEVATION = -10000;

/**
 * Requêtes réseau menées de front.
 *
 * Le champ de hauteur demande d'un coup toutes les tuiles de sa région — viewport plus
 * marge, et marge omnidirectionnelle pendant un balayage horaire. Sans plafond, cela
 * part en une seule rafale de plusieurs dizaines de requêtes, ce qui suffit à déclencher
 * la limite de débit de la Géoplateforme, et se voit aussi en `ERR_HTTP2_PROTOCOL_ERROR`
 * quand le serveur coupe les flux.
 */
const MAX_REQUETES_SIMULTANEES = 6;

/**
 * Durée pendant laquelle le LiDAR est mis de côté après un 429.
 *
 * La limite porte sur l'adresse IP, pas sur la tuile : la pause doit donc être commune à
 * toutes les tuiles. Sans elle, la rafale se reforme au déplacement suivant, puisqu'un
 * refus n'est délibérément pas mémorisé tuile par tuile (voir `load`) — la limite se
 * nourrit alors d'elle-même.
 */
const PAUSE_APRES_429_MS = 10_000;

/**
 * Délais avant de retenter une tuile qui a échoué, de plus en plus espacés.
 *
 * Un refus du service n'est jamais classé absent : vérifié, une tuile refusée en 400
 * par l'application répondait correctement quand on la redemandait à la main. Le refus
 * est passager — sans doute le service qui décroche sous la charge — et classer la tuile
 * absente laisserait un trou là où la donnée existe. L'absence réelle se reconnaît
 * autrement : le service répond alors, avec des valeurs NO_DATA_IGN.
 *
 * Ce qu'il fallait éviter, c'est de la redemander à chaque rendu : sur des emprises qui
 * refusaient plusieurs fois de suite, cela partait en milliers de requêtes. D'où ces
 * délais, sans aucune requête entre deux tentatives ; le dernier vaut ensuite pour
 * toutes les suivantes.
 */
const DELAIS_NOUVELLE_TENTATIVE_MS = [2_000, 8_000, 30_000, 60_000];

/** Échec qui ne dit rien de la tuile elle-même : pause après un 429, annulation. */
class EchecSansRapportAvecLaTuile extends Error {}

/** Plafond de la pause, quel que soit le `Retry-After` annoncé. */
const PAUSE_MAX_MS = 60_000;

/**
 * Intervalle minimal entre deux requêtes LiDAR.
 *
 * La Géoplateforme limite le WMS-Raster à 40 requêtes par seconde et par IP. Plafonner le
 * nombre de requêtes simultanées ne borne pas ce débit : six requêtes qui répondent en
 * 100 ms en font déjà 60 par seconde, et chaque zoom à la molette relance une rafale.
 * 50 ms donnent 20 requêtes par seconde, soit une marge de moitié — pour un deuxième
 * onglet ouvert, ou les requêtes annulées, que le serveur compte aussi.
 */
const INTERVALLE_LIDAR_MS = 50;

/**
 * Nature de la tuile. `surface` signifie que le sursol — toits, arbres — est déjà dans
 * les altitudes : il ne faut alors surtout pas y extruder les bâtiments d'OpenStreetMap,
 * ils seraient comptés deux fois.
 */
export type DemKind = 'terrain' | 'surface';

/** D'où vient la tuile : c'est la source, et non sa nature, qui borne la finesse. */
export type DemSource = 'lidar' | 'terrarium';

export interface DemTile {
  coord: TileCoord;
  size: number;
  /** Altitudes en mètres, ligne par ligne depuis le nord-ouest. */
  elevations: Float32Array;
  minElevation: number;
  maxElevation: number;
  kind: DemKind;
  source: DemSource;
}

function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** Bilan des tuiles d'un champ de hauteur, au zoom demandé. */
export interface DemTileCounts {
  lidar: number;
  terrarium: number;
  /** Classées absentes pour de bon : le serveur n'a rien à ce zoom. */
  absent: number;
  /** Ni obtenues ni classées : en vol, en attente, ou refusées passagèrement. */
  pending: number;
}

/**
 * Source d'élévation à retenir pour choisir le zoom, d'après l'ensemble du champ.
 *
 * Décider sur la dernière tuile arrivée faisait osciller le zoom : un refus ponctuel du
 * LiDAR rattrapé par terrarium, ou une vue à cheval sur la limite de couverture,
 * suffisait à redescendre à z15, puis la tuile LiDAR suivante faisait remonter.
 *
 * - Une seule tuile LiDAR suffit : la couverture existe, les zooms fins sont utiles.
 * - Sinon des tuiles terrarium, ou un champ entièrement absent (au-delà de z15 hors
 *   couverture LiDAR) : on revient dans la plage de terrarium.
 * - Tant que rien n'est tranché, on garde la décision précédente.
 */
export function resolveDemSource(
  counts: DemTileCounts,
  previous: DemSource | null,
): DemSource | null {
  if (counts.lidar > 0) return 'lidar';
  if (counts.terrarium > 0) return 'terrarium';
  if (counts.absent > 0 && counts.pending === 0) return 'terrarium';
  return previous;
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
  /** Annulation propre à chaque requête en vol ou en attente, par clé de tuile. */
  private controllers = new Map<string, AbortController>();
  private failed = new Set<string>();
  /** Tuiles en échec passager : nombre d'échecs et instant de la prochaine tentative. */
  private echecs = new Map<string, { nombre: number; reprise: number }>();
  /** Incrémentée à chaque changement de source : périme les requêtes déjà en vol. */
  private generation = 0;
  /** Requêtes réseau en cours, et files d'attente des suivantes. */
  private enCours = 0;
  private attente: (() => void)[] = [];
  /** Instant avant lequel le LiDAR n'est pas réinterrogé, après un 429. */
  private pauseLidarJusqua = 0;
  /** Instant à partir duquel la prochaine requête LiDAR peut partir. */
  private prochainCreneauLidar = 0;

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
    private product: LidarProduct = 'mnt',
  ) {}

  /** Zoom maximal exploitable ici : celui du LiDAR s'il couvre, celui de terrarium sinon. */
  maxZoomAt(source: DemSource | null): number {
    return source === 'lidar' ? IGN_MAX_ZOOM : TERRARIUM_MAX_ZOOM;
  }

  get lidarProduct(): LidarProduct {
    return this.product;
  }

  /**
   * Change de produit LiDAR. Les altitudes changent de nature : tout ce qui était en
   * cache est périmé, y compris les tuiles terrarium, dont le zoom ne correspondra plus.
   */
  setLidarProduct(product: LidarProduct): void {
    if (product === this.product) return;
    this.product = product;
    this.generation++;
    this.tiles.clear();
    this.failed.clear();
    this.echecs.clear();
    this.inFlight.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  /** Vrai si la tuile a été classée absente du serveur (océan, hors couverture). */
  isAbsent(coord: TileCoord): boolean {
    return this.failed.has(tileKey(coord.z, coord.x, coord.y));
  }

  /**
   * Délai avant la prochaine tentative d'une tuile en échec passager, `null` si elle
   * n'est pas en échec. Sert à l'appelant pour redemander un rendu au bon moment.
   */
  delaiAvantNouvelleTentative(coord: TileCoord): number | null {
    const echec = this.echecs.get(tileKey(coord.z, coord.x, coord.y));
    return echec ? Math.max(0, echec.reprise - Date.now()) : null;
  }

  /**
   * Annule les requêtes, en vol ou en file, des tuiles qui ne sont plus demandées.
   *
   * Sans cela, après un déplacement rapide, la file plafonnée restait occupée par les
   * tuiles de l'ancienne vue, téléchargées une à une avant celles de la nouvelle. Une
   * tuile annulée n'est pas classée absente : elle repartira si on y revient.
   */
  retainOnly(wanted: readonly TileCoord[]): void {
    if (this.controllers.size === 0) return;
    const keep = new Set(wanted.map((c) => tileKey(c.z, c.x, c.y)));
    for (const [key, controller] of this.controllers) {
      if (keep.has(key)) continue;
      controller.abort();
      this.controllers.delete(key);
      this.inFlight.delete(key);
    }
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
    const echec = this.echecs.get(key);
    if (echec && Date.now() < echec.reprise) return null;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const generation = this.generation;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const promise = this.fetchAvecPlafond(coord, combined)
      .then((tile) => {
        // Annulée entre-temps : ni en cache, ni absente, elle n'est simplement plus voulue.
        if (combined.aborted) return null;
        // Une réponse qui arrive après un changement de source décrit l'ancien monde :
        // la mettre en cache ferait réapparaître des altitudes qu'on vient d'écarter.
        if (generation !== this.generation) return null;
        this.echecs.delete(key);
        if (tile) this.insert(key, tile);
        else this.failed.add(key);
        return tile;
      })
      .catch((erreur: unknown) => {
        // Un échec n'est pas définitif d'emblée : la tuile est retentée après un délai,
        // puis classée absente si elle refuse encore. Une annulation, une pause après
        // 429 ou un changement de source ne disent rien d'elle : on n'en tient pas compte.
        if (
          combined.aborted ||
          generation !== this.generation ||
          erreur instanceof EchecSansRapportAvecLaTuile ||
          (erreur instanceof LidarHttpError && erreur.status === 429)
        ) {
          return null;
        }
        this.noterEchec(key);
        return null;
      })
      .finally(() => {
        // La clé peut déjà porter une requête plus récente : ne retirer que la sienne.
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
        if (this.controllers.get(key) === controller) this.controllers.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  /** Compte un échec de plus pour cette tuile et repousse sa prochaine tentative. */
  private noterEchec(key: string): void {
    const nombre = (this.echecs.get(key)?.nombre ?? 0) + 1;
    const delais = DELAIS_NOUVELLE_TENTATIVE_MS;
    const delai = delais[Math.min(nombre, delais.length) - 1] as number;
    this.echecs.set(key, { nombre, reprise: Date.now() + delai });
  }

  /**
   * Prend un jeton avant de laisser partir la requête, et le rend dans tous les cas.
   *
   * La déduplication par tuile de `load` ne borne pas le débit : elle empêche de
   * demander deux fois la même tuile, pas d'en demander cinquante différentes d'un coup.
   */
  private async fetchAvecPlafond(
    coord: TileCoord,
    signal: AbortSignal,
  ): Promise<DemTile | null> {
    // `while` et non `if` : plusieurs attentes peuvent être réveillées, chacune doit
    // revérifier qu'il reste bien un jeton pour elle.
    while (this.enCours >= MAX_REQUETES_SIMULTANEES) {
      await this.attendreJeton(signal);
    }
    if (signal.aborted) {
      // Réveillée puis annulée avant d'avoir pris le jeton : le réveil passe à la
      // suivante, sans quoi la file resterait bloquée avec un jeton libre.
      if (this.enCours < MAX_REQUETES_SIMULTANEES) this.attente.shift()?.();
      throw signal.reason;
    }
    this.enCours++;
    try {
      return await this.fetchTile(coord, signal);
    } finally {
      this.enCours--;
      this.attente.shift()?.();
    }
  }

  /**
   * Attend qu'un jeton se libère. Une annulation fait quitter la file sur-le-champ, sans
   * consommer de jeton : c'est ce qui laisse passer les tuiles de la vue courante.
   */
  private attendreJeton(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const abandon = () => {
        const index = this.attente.indexOf(reveil);
        if (index >= 0) this.attente.splice(index, 1);
        reject(signal.reason);
      };
      const reveil = () => {
        signal.removeEventListener('abort', abandon);
        resolve();
      };
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', abandon, { once: true });
      this.attente.push(reveil);
    });
  }

  /**
   * Réserve le prochain créneau LiDAR et attend qu'il arrive. Les créneaux sont espacés
   * d'`INTERVALLE_LIDAR_MS`, quel que soit le nombre de requêtes menées de front.
   */
  private async attendreCreneauLidar(signal: AbortSignal): Promise<void> {
    const maintenant = Date.now();
    const creneau = Math.max(maintenant, this.prochainCreneauLidar);
    this.prochainCreneauLidar = creneau + INTERVALLE_LIDAR_MS;
    if (creneau <= maintenant) return;
    await new Promise<void>((resolve, reject) => {
      const minuteur = setTimeout(() => {
        signal.removeEventListener('abort', abandon);
        resolve();
      }, creneau - maintenant);
      const abandon = () => {
        clearTimeout(minuteur);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abandon, { once: true });
    });
  }

  /** Vrai tant que la limite de débit de la Géoplateforme est supposée active. */
  private lidarEnPause(): boolean {
    return Date.now() < this.pauseLidarJusqua;
  }

  /** Le LiDAR vaut-il d'être interrogé pour ce zoom, maintenant ? */
  private lidarUtilisable(z: number): boolean {
    if (!this.useLidar) return false;
    if (z < IGN_MIN_ZOOM || z > IGN_MAX_ZOOM) return false;
    return !this.lidarEnPause();
  }

  /**
   * Charge une tuile LiDAR en retenant une limite de débit au passage.
   *
   * Le refus continue de lever, comme avant : c'est ce qui distingue un incident
   * passager d'une absence de données. La pause n'y change rien pour cette tuile-ci,
   * elle épargne les suivantes.
   */
  private async chargerLidar(
    coord: TileCoord,
    signal: AbortSignal,
  ): Promise<Float32Array | null> {
    await this.attendreCreneauLidar(signal);
    // Un 429 a pu tomber pendant l'attente : partir quand même prolongerait le blocage.
    // Lever — et non renvoyer `null` — pour que la tuile ne soit pas classée absente.
    if (this.lidarEnPause()) throw new EchecSansRapportAvecLaTuile('LiDAR IGN : en pause après un 429');
    try {
      return await fetchLidarTile(coord, this.product, signal);
    } catch (erreur) {
      if (erreur instanceof LidarHttpError && erreur.status === 429) {
        // Le service annonce la durée du blocage — 5 s au départ d'après sa documentation ;
        // à défaut de pouvoir la lire, une valeur un peu plus prudente.
        const pause = Math.min(erreur.retryAfterMs ?? PAUSE_APRES_429_MS, PAUSE_MAX_MS);
        this.pauseLidarJusqua = Date.now() + pause;
      }
      throw erreur;
    }
  }

  private async fetchTile(coord: TileCoord, signal: AbortSignal): Promise<DemTile | null> {
    if (this.lidarUtilisable(coord.z)) {
      // Un refus du service est transitoire : on ne l'absorbe que si terrarium peut
      // prendre le relais. Sinon on laisse remonter, pour que la tuile soit redemandée
      // au lieu d'être classée absente à tort.
      const secours = coord.z <= TERRARIUM_MAX_ZOOM;
      const lidar = secours
        ? await this.chargerLidar(coord, signal).catch(() => null)
        : await this.chargerLidar(coord, signal);
      if (lidar) {
        // Seul le MNS porte le sursol ; le MNT est un sol nu, comme terrarium.
        const kind: DemKind = this.product === 'mns' ? 'surface' : 'terrain';
        return this.buildTile(coord, IGN_TILE_SIZE, lidar, kind, 'lidar');
      }
    }
    // Terrarium ne va pas au-delà de son zoom natif : au-dessus, mieux vaut pas de
    // tuile du tout qu'une tuile étirée qui contredirait ses voisines.
    if (coord.z > TERRARIUM_MAX_ZOOM) {
      // Sauf pendant une pause : là, le LiDAR n'a pas dit que la tuile n'existait pas,
      // il n'a simplement pas été interrogé. Lever plutôt que renvoyer `null` est
      // capital — `null` la ferait classer absente pour de bon par `load`, et le trou
      // survivrait très largement à la limite de débit qui l'a causé.
      if (this.lidarEnPause()) throw new EchecSansRapportAvecLaTuile('LiDAR IGN : en pause après un 429');
      return null;
    }

    const url = `${this.baseUrl}/${coord.z}/${coord.x}/${coord.y}.png`;
    const response = await fetch(url, { signal, mode: 'cors' });
    if (!response.ok) return null;

    // Décodage exact, sans canvas : voir `png.ts`. Le chemin par canvas reste en repli
    // pour un format de tuile inattendu, au prix de quelques pixels altérés.
    const donnees = await response.arrayBuffer();
    const png = await decodePngRgb8(donnees);

    if (png) {
      return this.buildTile(
        coord,
        png.width,
        decodeTerrarium(png.rgb, png.width, 3),
        'terrain',
        'terrarium',
      );
    }
    const bitmap = await createImageBitmap(new Blob([donnees]));
    const size = bitmap.width;
    const ctx = getDecodeContext(size);
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const elevations = decodeTerrarium(ctx.getImageData(0, 0, size, size).data, size, 4);
    return this.buildTile(coord, size, elevations, 'terrain', 'terrarium');
  }

  private buildTile(
    coord: TileCoord,
    size: number,
    elevations: Float32Array,
    kind: DemKind,
    source: DemSource,
  ): DemTile {
    let min = Infinity;
    let max = -Infinity;
    for (const v of elevations) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { coord, size, elevations, minElevation: min, maxElevation: max, kind, source };
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
