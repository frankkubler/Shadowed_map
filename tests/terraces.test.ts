import { describe, expect, it } from 'vitest';
import { terracesFromOverpass } from '../src/data/terraces';
import type { OverpassElement } from '../src/data/overpass';

const node = (tags: Record<string, string>, id = 1): OverpassElement => ({
  type: 'node',
  id,
  lat: 45.9,
  lon: 6.87,
  tags,
});

describe('classement des terrasses', () => {
  it('marque comme confirmée une terrasse explicitement tagguée', () => {
    const [terrace] = terracesFromOverpass([node({ amenity: 'cafe', outdoor_seating: 'yes' })]);
    expect(terrace?.confidence).toBe('confirmed');
  });

  it('marque comme probable un établissement qui ne dit rien', () => {
    const [terrace] = terracesFromOverpass([node({ amenity: 'restaurant' })]);
    expect(terrace?.confidence).toBe('likely');
  });

  it('écarte les établissements qui déclarent ne pas avoir de terrasse', () => {
    expect(terracesFromOverpass([node({ amenity: 'bar', outdoor_seating: 'no' })])).toHaveLength(0);
  });

  it('retient une terrasse saisonnière comme confirmée', () => {
    // `outdoor_seating=seasonal` affirme bien l'existence d'une terrasse.
    const [terrace] = terracesFromOverpass([node({ amenity: 'bar', outdoor_seating: 'seasonal' })]);
    expect(terrace?.confidence).toBe('confirmed');
  });

  it('ignore les objets qui ne sont pas des établissements du genre', () => {
    expect(terracesFromOverpass([node({ amenity: 'pharmacy' })])).toHaveLength(0);
    expect(terracesFromOverpass([node({ shop: 'bakery' })])).toHaveLength(0);
    expect(terracesFromOverpass([{ type: 'node', id: 9, lat: 45, lon: 6 }])).toHaveLength(0);
  });

  it('fait passer les confirmées devant les probables', () => {
    const terraces = terracesFromOverpass([
      node({ amenity: 'cafe', name: 'Probable' }, 1),
      node({ amenity: 'cafe', name: 'Confirmée', outdoor_seating: 'yes' }, 2),
    ]);
    expect(terraces[0]?.name).toBe('Confirmée');
  });
});

describe('nommage et position', () => {
  it('utilise le nom OSM quand il existe', () => {
    const [terrace] = terracesFromOverpass([node({ amenity: 'bar', name: '  Le Refuge  ' })]);
    expect(terrace?.name).toBe('Le Refuge');
  });

  it('retombe sur le type quand le nom manque', () => {
    const [terrace] = terracesFromOverpass([node({ amenity: 'ice_cream' })]);
    expect(terrace?.name).toBe('Glacier');
    expect(terrace?.kind).toBe('Glacier');
  });

  it('utilise le centre fourni par Overpass pour un contour', () => {
    const [terrace] = terracesFromOverpass([
      {
        type: 'way',
        id: 5,
        tags: { amenity: 'restaurant' },
        center: { lat: 45.5, lon: 6.5 },
      },
    ]);
    expect(terrace?.lat).toBeCloseTo(45.5, 6);
    expect(terrace?.lng).toBeCloseTo(6.5, 6);
  });

  it('calcule un centroïde quand seul le contour est donné', () => {
    const [terrace] = terracesFromOverpass([
      {
        type: 'way',
        id: 6,
        tags: { amenity: 'cafe' },
        geometry: [
          { lat: 45.0, lon: 6.0 },
          { lat: 45.0, lon: 6.2 },
          { lat: 45.2, lon: 6.2 },
          { lat: 45.2, lon: 6.0 },
        ],
      },
    ]);
    expect(terrace?.lat).toBeCloseTo(45.1, 6);
    expect(terrace?.lng).toBeCloseTo(6.1, 6);
  });

  it('écarte un élément sans position exploitable', () => {
    expect(terracesFromOverpass([{ type: 'way', id: 7, tags: { amenity: 'bar' } }])).toHaveLength(0);
  });

  it('donne un identifiant distinct par élément', () => {
    const terraces = terracesFromOverpass([node({ amenity: 'bar' }, 1), node({ amenity: 'bar' }, 2)]);
    expect(terraces[0]?.id).not.toBe(terraces[1]?.id);
  });
});

describe('plafond du nombre de terrasses', () => {
  it('coupe les probables avant les confirmées', () => {
    const many: OverpassElement[] = [];
    for (let i = 0; i < 400; i++) many.push(node({ amenity: 'cafe' }, i + 1000));
    for (let i = 0; i < 10; i++) {
      many.push(node({ amenity: 'cafe', outdoor_seating: 'yes', name: `Sûre ${i}` }, i + 1));
    }

    const terraces = terracesFromOverpass(many);
    expect(terraces.length).toBeLessThanOrEqual(250);
    // Les dix confirmées doivent avoir survécu à la coupe.
    expect(terraces.filter((t) => t.confidence === 'confirmed')).toHaveLength(10);
  });
});
