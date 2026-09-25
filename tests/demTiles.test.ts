import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemTileCache, resolveDemSource } from '../src/shadow/demTiles';
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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
    let maintenant = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => maintenant);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<ServiceException/>', { status: 400 })),
    );

    const cache = new DemTileCache();
    const coord = { z: 17, x: 68037, y: 46670 };
    expect(await cache.load(coord)).toBeNull();
    expect(cache.isAbsent(coord)).toBe(false);

    // la tuile n'est pas mise sur liste noire : passé son délai, un nouvel essai repart
    // bien en requête
    maintenant += 2_500;
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

  // Certaines emprises refusent à chaque fois : les redemander à chaque rendu faisait des
  // milliers de requêtes sur les mêmes tuiles.
  it('espace les nouvelles tentatives d’une tuile refusée sans jamais la classer absente', async () => {
    let maintenant = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => maintenant);
    const appels: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        return new Response('<ServiceException/>', { status: 400 });
      }),
    );

    const cache = new DemTileCache();
    const coord = { z: 17, x: 68037, y: 46670 };
    expect(await cache.load(coord)).toBeNull();
    expect(appels).toHaveLength(1);

    // Pendant le délai, aucune requête : c'est ce qui casse la boucle.
    for (let i = 0; i < 50; i++) await cache.load(coord);
    expect(appels).toHaveLength(1);

    // Délais croissants, puis plafonnés : jamais de classement en absente, puisqu'un
    // refus s'est révélé passager (la même tuile répondait quand on la redemandait).
    const attendus = [2_000, 8_000, 30_000, 60_000, 60_000, 60_000];
    for (const [i, delai] of attendus.entries()) {
      expect(cache.delaiAvantNouvelleTentative(coord)).toBe(delai);
      maintenant += delai - 1;
      await cache.load(coord);
      expect(appels).toHaveLength(i + 1);
      maintenant += 2;
      await cache.load(coord);
      expect(appels).toHaveLength(i + 2);
    }
    expect(cache.isAbsent(coord)).toBe(false);

    // Et quand le service répond de nouveau, la tuile arrive.
    vi.stubGlobal('fetch', vi.fn(async () => reponseBil(310)));
    maintenant += 60_001;
    expect((await cache.load(coord))?.source).toBe('lidar');
    expect(cache.delaiAvantNouvelleTentative(coord)).toBeNull();
  });

  it('ne compte pas une limite de débit comme un refus de la tuile', async () => {
    let maintenant = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => maintenant);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));

    const cache = new DemTileCache();
    const coord = { z: 17, x: 68037, y: 46670 };
    for (let i = 0; i < 5; i++) {
      await cache.load(coord);
      maintenant += 11_000;
    }
    expect(cache.isAbsent(coord)).toBe(false);
    expect(cache.delaiAvantNouvelleTentative(coord)).toBeNull();
  });

  // Terrarium s'arrête au zoom 15 : au-delà, mieux vaut pas de tuile qu'une tuile étirée.
  it('ne rend rien au-delà du zoom de terrarium quand le LiDAR ne répond pas', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.includes('geopf') ? reponseBil(NO_DATA_IGN) : reponsePng())),
    );

    expect(await new DemTileCache().load({ z: 17, x: 68037, y: 46670 })).toBeNull();
  });

  // Une tuile de 256 px couvre 78 km de côté à z9 : demander du LiDAR à 50 cm pour
  // produire 306 m par texel coûte cher au service et ne donne rien que terrarium
  // n'ait déjà. Sans cette borne, une vue large sur la France partait en centaines de
  // requêtes, et la Géoplateforme répondait en 429.
  it('n’interroge pas le LiDAR aux zooms où il n’apporte rien', async () => {
    const appels: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        return reponsePng();
      }),
    );

    const tuile = await new DemTileCache().load({ z: 11, x: 1063, y: 729 });
    expect(tuile?.source).toBe('terrarium');
    expect(appels.some((u) => u.includes('geopf'))).toBe(false);
  });

  // La déduplication par tuile empêche de demander deux fois la même, pas d'en demander
  // cinquante différentes d'un coup — ce que fait le champ de hauteur à chaque région.
  it('borne le nombre de requêtes simultanées', async () => {
    let enCours = 0;
    let maximum = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        enCours++;
        maximum = Math.max(maximum, enCours);
        // Des réponses assez lentes pour que les requêtes se chevauchent malgré
        // l'espacement des départs : sans plafond, huit seraient en vol à la fois.
        await new Promise((resolve) => setTimeout(resolve, 400));
        enCours--;
        return reponseBil(1050);
      }),
    );

    const cache = new DemTileCache();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => cache.load({ z: 15, x: 17009 + i, y: 11667 })),
    );
    expect(maximum).toBe(6);
  });

  // La Géoplateforme limite le WMS-Raster à 40 requêtes par seconde et par IP : le
  // plafond de requêtes simultanées ne suffit pas quand elles répondent vite.
  it('espace les requêtes LiDAR pour rester sous la limite de débit', async () => {
    const departs: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        departs.push(performance.now());
        return reponseBil(1050);
      }),
    );

    const cache = new DemTileCache();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => cache.load({ z: 15, x: 17009 + i, y: 11667 })),
    );
    const ecarts = departs.slice(1).map((t, i) => t - (departs[i] as number));
    // Tolérance d'horloge : l'intervalle visé est de 50 ms.
    expect(Math.min(...ecarts)).toBeGreaterThanOrEqual(40);
  });

  it('respecte la durée de blocage annoncée par Retry-After', async () => {
    let maintenant = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => maintenant);
    const appels: string[] = [];
    let bloque = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        if (url.includes('geopf') && bloque) {
          return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
        }
        return url.includes('geopf') ? reponseBil(1050) : reponsePng();
      }),
    );

    const cache = new DemTileCache();
    expect((await cache.load(COORD))?.source).toBe('terrarium');

    // Pendant les deux secondes annoncées, le LiDAR n'est pas réinterrogé.
    bloque = false;
    maintenant += 1_500;
    expect((await cache.load({ z: 15, x: 17010, y: 11667 }))?.source).toBe('terrarium');
    expect(appels.filter((u) => u.includes('geopf'))).toHaveLength(1);

    // Passé ce délai, il l'est de nouveau — sans attendre une pause arbitraire plus longue.
    maintenant += 1_000;
    expect((await cache.load({ z: 15, x: 17011, y: 11667 }))?.source).toBe('lidar');
  });

  // La limite de débit porte sur l'adresse IP, pas sur la tuile : insister tuile par
  // tuile ne fait que la reconduire.
  it('met le LiDAR de côté après un 429 au lieu de le rappeler aussitôt', async () => {
    const appels: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        return url.includes('geopf') ? new Response('', { status: 429 }) : reponsePng();
      }),
    );

    const cache = new DemTileCache();
    expect((await cache.load(COORD))?.source).toBe('terrarium');
    expect(appels.filter((u) => u.includes('geopf'))).toHaveLength(1);

    expect((await cache.load({ z: 15, x: 17010, y: 11667 }))?.source).toBe('terrarium');
    expect(appels.filter((u) => u.includes('geopf'))).toHaveLength(1);
  });

  // Au-delà du zoom de terrarium, une tuile non obtenue est normalement classée absente.
  // Pendant une pause, ce serait à tort : le service n'a rien dit, il n'a pas été
  // interrogé — et le trou survivrait de très loin à la limite de débit qui l'a causé.
  it('ne classe pas une tuile absente quand le LiDAR est en pause', async () => {
    let maintenant = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => maintenant);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));

    const cache = new DemTileCache();
    const voisine = { z: 17, x: 68038, y: 46670 };
    expect(await cache.load({ z: 17, x: 68037, y: 46670 })).toBeNull();
    expect(await cache.load(voisine)).toBeNull();

    // La pause écoulée, le service répondant de nouveau : la tuile doit repartir en
    // requête, ce qui prouve qu'elle n'a pas été mise sur liste noire.
    maintenant += 31_000;
    const appels: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        appels.push(url);
        return reponseBil(1050);
      }),
    );
    expect((await cache.load(voisine))?.source).toBe('lidar');
    expect(appels).not.toHaveLength(0);
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

describe('annulation des tuiles devenues inutiles', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** `fetch` qui ne répond qu'à la demande, et échoue comme le vrai sur annulation. */
  const fetchManuel = () => {
    const urls: string[] = [];
    const enVol: (() => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            urls.push(url);
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            enVol.push(() => resolve(reponsePng()));
          }),
      ),
    );
    return { urls, enVol };
  };

  const tuile = (x: number) => ({ z: 15, x, y: 11667 });

  it('fait passer la nouvelle vue devant les tuiles de l’ancienne encore en file', async () => {
    const { urls, enVol } = fetchManuel();
    const cache = new DemTileCache(256, undefined, false);

    const vue1 = Array.from({ length: 6 }, (_, i) => tuile(100 + i));
    const enFile = Array.from({ length: 3 }, (_, i) => tuile(200 + i));
    const nouvelle = tuile(300);

    const chargements1 = vue1.map((c) => cache.load(c));
    const abandonnees = enFile.map((c) => cache.load(c));
    await Promise.resolve();
    expect(urls).toHaveLength(6);

    // La vue a bougé : seule la nouvelle tuile compte, avec celles déjà en vol.
    cache.retainOnly([...vue1, nouvelle]);
    const chargementNouvelle = cache.load(nouvelle);

    expect(await Promise.all(abandonnees)).toEqual([null, null, null]);
    for (const reponse of enVol.splice(0)) reponse();
    await Promise.all(chargements1);
    await vi.waitFor(() => expect(urls).toHaveLength(7));
    enVol.splice(0).forEach((reponse) => reponse());

    expect((await chargementNouvelle)?.source).toBe('terrarium');
    expect(urls.some((u) => u.includes('/15/200/'))).toBe(false);
    expect(urls).toHaveLength(7);
    // Annulée n'est pas absente : la tuile repartira si on y revient.
    expect(cache.isAbsent(enFile[0]!)).toBe(false);
  });

  it('interrompt aussi une requête déjà en vol', async () => {
    fetchManuel();
    const cache = new DemTileCache(256, undefined, false);

    const chargement = cache.load(tuile(1));
    await Promise.resolve();
    cache.retainOnly([]);

    expect(await chargement).toBeNull();
    expect(cache.isAbsent(tuile(1))).toBe(false);
    expect(cache.get(15, 1, 11667)).toBeUndefined();
  });
});

describe('choix de la source d’élévation sur tout le champ', () => {
  const bilan = (partiel: Partial<Parameters<typeof resolveDemSource>[0]>) => ({
    lidar: 0,
    terrarium: 0,
    absent: 0,
    pending: 0,
    ...partiel,
  });

  it('reste sur le LiDAR quand une tuile a dû se rabattre sur terrarium', () => {
    // Un refus ponctuel du LiDAR rattrapé par terrarium ne doit pas faire redescendre
    // le zoom, quel que soit l'ordre d'arrivée des tuiles.
    expect(resolveDemSource(bilan({ lidar: 11, terrarium: 1 }), 'lidar')).toBe('lidar');
    expect(resolveDemSource(bilan({ lidar: 11, terrarium: 1 }), 'terrarium')).toBe('lidar');
  });

  it('revient à terrarium hors couverture LiDAR', () => {
    expect(resolveDemSource(bilan({ terrarium: 9 }), 'lidar')).toBe('terrarium');
    // Au-delà de z15, hors couverture, toutes les tuiles sont absentes.
    expect(resolveDemSource(bilan({ absent: 9 }), 'lidar')).toBe('terrarium');
  });

  it('garde la décision précédente tant que rien n’est tranché', () => {
    expect(resolveDemSource(bilan({ pending: 9 }), 'lidar')).toBe('lidar');
    expect(resolveDemSource(bilan({ absent: 3, pending: 6 }), 'lidar')).toBe('lidar');
    expect(resolveDemSource(bilan({}), null)).toBeNull();
  });
});
