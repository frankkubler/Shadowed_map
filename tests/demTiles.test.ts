import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemTileCache } from '../src/shadow/demTiles';
import { NO_DATA_IGN } from '../src/shadow/lidarIgn';

const tuilePng = readFileSync(new URL('./fixtures/terrarium-15-17009-11667.png', import.meta.url));
const COORD = { z: 15, x: 17009, y: 11667 };

const reponseBil = (valeur: number) => {
  const a = new Float32Array(256 * 256).fill(valeur);
  return new Response(a.buffer, {
    status: 200,
    headers: { 'Content-Type': 'image/x-bil;bits=32' },
  });
};
const reponsePng = () =>
  new Response(tuilePng.buffer.slice(tuilePng.byteOffset, tuilePng.byteOffset + tuilePng.byteLength), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });

describe('source d’élévation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('préfère le LiDAR quand il couvre la zone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.includes('geopf') ? reponseBil(1050) : reponsePng())),
    );

    const tuile = await new DemTileCache().load(COORD);
    expect(tuile?.source).toBe('lidar');
    expect(tuile?.minElevation).toBeCloseTo(1050, 3);
  });

  // Hors couverture le service renvoie -9999 partout : il faut retomber sur terrarium
  // sans que l'utilisateur voie de trou.
  it('retombe sur terrarium hors couverture LiDAR', async () => {
    const appels: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        return url.includes('geopf') ? reponseBil(NO_DATA_IGN) : reponsePng();
      }),
    );

    const tuile = await new DemTileCache().load(COORD);
    expect(tuile?.source).toBe('terrarium');
    expect(Math.round(tuile!.minElevation)).toBe(1033);
    expect(appels.some((u) => u.includes('geopf'))).toBe(true);
    expect(appels.some((u) => u.includes('elevation-tiles-prod'))).toBe(true);
  });

  it('retombe aussi sur terrarium si le service refuse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('geopf') ? new Response('erreur', { status: 500 }) : reponsePng(),
      ),
    );

    expect((await new DemTileCache().load(COORD))?.source).toBe('terrarium');
  });

  it('n’interroge pas le LiDAR quand il est désactivé', async () => {
    const appels: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        return reponsePng();
      }),
    );

    const cache = new DemTileCache(256, undefined, false);
    expect((await cache.load(COORD))?.source).toBe('terrarium');
    expect(appels.some((u) => u.includes('geopf'))).toBe(false);
  });

  // Un 400 sporadique du service (mesuré : environ une requête sur huit) ne doit pas
  // faire classer la tuile comme absente là où terrarium ne peut pas prendre le relais,
  // sinon le trou serait définitif.
  it('laisse remonter un refus au-delà du zoom de terrarium', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<ServiceException/>', { status: 400 })),
    );

    const cache = new DemTileCache();
    const coord = { z: 17, x: 68037, y: 46670 };
    expect(await cache.load(coord)).toBeNull();

    // la tuile n'est pas mise sur liste noire : un nouvel essai repart bien en requête
    const appels: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        return reponseBil(1050);
      }),
    );
    expect((await cache.load(coord))?.source).toBe('lidar');
    expect(appels).not.toHaveLength(0);
  });

  // Terrarium s'arrête au zoom 15 : au-delà, mieux vaut pas de tuile qu'une tuile étirée.
  it('ne rend rien au-delà du zoom de terrarium quand le LiDAR ne répond pas', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.includes('geopf') ? reponseBil(NO_DATA_IGN) : reponsePng())),
    );

    expect(await new DemTileCache().load({ z: 17, x: 68037, y: 46670 })).toBeNull();
  });

  it('annonce le zoom exploitable selon la source', () => {
    const cache = new DemTileCache();
    expect(cache.maxZoomAt('lidar')).toBeGreaterThan(cache.maxZoomAt('terrarium'));
    expect(cache.maxZoomAt(null)).toBe(cache.maxZoomAt('terrarium'));
  });

  // Le sol nu est le défaut : les bâtiments restent extrudés depuis OpenStreetMap, ce
  // qui reste vrai toute l'année, là où le feuillage du MNS est celui du jour du vol.
  it('demande le sol nu par défaut, et la surface sur demande', async () => {
    const couches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('geopf')) couches.push(new URL(url).searchParams.get('LAYERS') ?? '');
        return reponseBil(1050);
      }),
    );

    const cache = new DemTileCache();
    expect(cache.lidarProduct).toBe('mnt');
    expect((await cache.load(COORD))?.kind).toBe('terrain');
    expect(couches[0]).toContain('_MNT_');

    cache.setLidarProduct('mns');
    expect((await cache.load(COORD))?.kind).toBe('surface');
    expect(couches[1]).toContain('_MNS_');
  });

  // Une requête partie avant la bascule ne doit pas repeupler le cache avec les
  // altitudes de l'ancien produit.
  it('ignore une réponse arrivée après un changement de produit', async () => {
    let debloquer: (() => void) | undefined;
    const attente = new Promise<void>((resolve) => {
      debloquer = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await attente;
        return reponseBil(1050);
      }),
    );

    const cache = new DemTileCache();
    const enVol = cache.load(COORD);
    cache.setLidarProduct('mns');
    debloquer?.();

    expect(await enVol).toBeNull();
    expect(cache.get(COORD.z, COORD.x, COORD.y)).toBeUndefined();
  });

  it('jette le cache en changeant de produit, les altitudes n’étant plus les mêmes', async () => {
    let altitude = 1050;
    vi.stubGlobal('fetch', vi.fn(async () => reponseBil(altitude)));

    const cache = new DemTileCache();
    expect((await cache.load(COORD))?.minElevation).toBeCloseTo(1050, 3);

    altitude = 1062;
    cache.setLidarProduct('mns');
    expect((await cache.load(COORD))?.minElevation).toBeCloseTo(1062, 3);
  });
});
