import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  IGN_MAX_ZOOM,
  NO_DATA_IGN,
  decodeBil32,
  lidarTileUrl,
  tileBounds3857,
} from '../src/shadow/lidarIgn';

const bil = (valeurs: number[], size: number) => {
  const a = new Float32Array(size * size);
  a.set(valeurs.slice(0, a.length));
  if (valeurs.length < a.length) a.fill(valeurs[valeurs.length - 1] ?? 0, valeurs.length);
  return a.buffer;
};

describe('tuiles LiDAR IGN', () => {
  it('couvre le monde entier au zoom 0', () => {
    const [minX, minY, maxX, maxY] = tileBounds3857({ z: 0, x: 0, y: 0 });
    expect(minX).toBeCloseTo(-20037508.34, 1);
    expect(maxX).toBeCloseTo(20037508.34, 1);
    expect(minY).toBeCloseTo(-20037508.34, 1);
    expect(maxY).toBeCloseTo(20037508.34, 1);
  });

  it('place la tuile 1/1/0 dans le quadrant nord-est', () => {
    const [minX, minY, maxX, maxY] = tileBounds3857({ z: 1, x: 1, y: 0 });
    expect(minX).toBeCloseTo(0, 6);
    expect(maxX).toBeCloseTo(20037508.34, 1);
    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(20037508.34, 1);
  });

  // Une tuile adjacente doit partager exactement son bord : sans cela, le champ de
  // hauteur montrerait des coutures.
  it('accole les tuiles voisines sans recouvrement ni trou', () => {
    const gauche = tileBounds3857({ z: 12, x: 2130, y: 1450 });
    const droite = tileBounds3857({ z: 12, x: 2131, y: 1450 });
    const dessous = tileBounds3857({ z: 12, x: 2130, y: 1451 });
    expect(droite[0]).toBeCloseTo(gauche[2], 6);
    expect(dessous[3]).toBeCloseTo(gauche[1], 6);
  });

  it('demande le bon format et la bonne projection', () => {
    const url = new URL(lidarTileUrl({ z: 15, x: 17009, y: 11667 }, 'mns'));
    const p = url.searchParams;
    expect(p.get('FORMAT')).toBe('image/x-bil;bits=32');
    expect(p.get('CRS')).toBe('EPSG:3857');
    expect(p.get('WIDTH')).toBe('256');
    expect(p.get('LAYERS')).toContain('MNS');
    expect(new URL(lidarTileUrl({ z: 15, x: 17009, y: 11667 }, 'mnt')).searchParams.get('LAYERS'))
      .toContain('MNT');
    expect(p.get('BBOX')?.split(',')).toHaveLength(4);
  });

  it('décode une réponse conforme', () => {
    const donnees = decodeBil32(bil([1000, 1001, 1002], 4), 4);
    expect(donnees).not.toBeNull();
    expect(donnees?.length).toBe(16);
    expect(donnees?.[0]).toBeCloseTo(1000, 3);
  });

  it('refuse une tuile de taille inattendue', () => {
    expect(decodeBil32(bil([1000], 4), 8)).toBeNull();
  });

  // Hors couverture, le service répond uniformément -9999. Une tuile seulement
  // partiellement couverte est refusée elle aussi : la mélanger au terrain nu créerait
  // une marche, donc une fausse ombre, à la limite des données.
  it('refuse une tuile hors couverture ou incomplète', () => {
    expect(decodeBil32(bil([NO_DATA_IGN], 4), 4)).toBeNull();
    expect(decodeBil32(bil([1000, 1001, NO_DATA_IGN, 1002], 2), 2)).toBeNull();
  });

  it('ne demande rien au-delà du zoom utile', () => {
    expect(IGN_MAX_ZOOM).toBeGreaterThanOrEqual(15);
  });
});

// Tuile réelle, téléchargée à la main depuis la Géoplateforme (MNT, z17, près de
// Guebwiller). L'application s'était vu refuser cette même requête en 400 : la voir
// répondre ici prouve que le refus était passager, et non une absence de couverture.
describe('tuile LiDAR réelle', () => {
  const coord = { z: 17, x: 68152, y: 45655 };
  const fichier = readFileSync(
    new URL('./fixtures/lidar-mnt-17-68152-45655.bil', import.meta.url),
  );

  it('demande exactement l’emprise de la tuile téléchargée', () => {
    const url = new URL(lidarTileUrl(coord, 'mnt'));
    const [minX, minY, maxX, maxY] = (url.searchParams.get('BBOX') ?? '').split(',').map(Number);
    expect(minX).toBeCloseTo(799837.063976083, 3);
    expect(minY).toBeCloseTo(6078272.489237215, 3);
    expect(maxX).toBeCloseTo(800142.8120892236, 3);
    expect(maxY).toBeCloseTo(6078578.237350356, 3);
  });

  it('se décode en altitudes plausibles, sans valeur manquante', () => {
    const buffer = fichier.buffer.slice(fichier.byteOffset, fichier.byteOffset + fichier.byteLength);
    const altitudes = decodeBil32(buffer);
    expect(altitudes).not.toBeNull();
    const valeurs = Array.from(altitudes ?? []);
    expect(Math.min(...valeurs)).toBeGreaterThan(300);
    expect(Math.max(...valeurs)).toBeLessThan(320);
  });
});
