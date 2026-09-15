import { describe, expect, it } from 'vitest';
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
    const url = new URL(lidarTileUrl({ z: 15, x: 17009, y: 11667 }));
    const p = url.searchParams;
    expect(p.get('FORMAT')).toBe('image/x-bil;bits=32');
    expect(p.get('CRS')).toBe('EPSG:3857');
    expect(p.get('WIDTH')).toBe('256');
    expect(p.get('LAYERS')).toContain('MNS');
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
