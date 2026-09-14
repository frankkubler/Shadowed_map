import { describe, expect, it } from 'vitest';
import { meshFromOverpass, parseBuildingHeight } from '../src/shadow/buildings';

describe('parseBuildingHeight', () => {
  it('lit une hauteur en mètres', () => {
    expect(parseBuildingHeight({ height: '24' })).toBe(24);
    expect(parseBuildingHeight({ height: '24.5' })).toBeCloseTo(24.5, 6);
    expect(parseBuildingHeight({ height: '24 m' })).toBe(24);
  });

  it('accepte la virgule décimale, fréquente dans les contributions européennes', () => {
    expect(parseBuildingHeight({ height: '12,5' })).toBeCloseTo(12.5, 6);
  });

  it('convertit les pieds en mètres', () => {
    expect(parseBuildingHeight({ height: "40'" })).toBeCloseTo(12.192, 3);
    expect(parseBuildingHeight({ height: '40 ft' })).toBeCloseTo(12.192, 3);
  });

  it('déduit une hauteur du nombre de niveaux', () => {
    expect(parseBuildingHeight({ 'building:levels': '5' })).toBe(15);
  });

  it('préfère height à building:levels quand les deux existent', () => {
    expect(parseBuildingHeight({ height: '30', 'building:levels': '5' })).toBe(30);
  });

  it('retombe sur une valeur par défaut plausible', () => {
    expect(parseBuildingHeight(undefined)).toBe(8);
    expect(parseBuildingHeight({})).toBe(8);
    expect(parseBuildingHeight({ height: 'grand' })).toBe(8);
    expect(parseBuildingHeight({ height: '-3' })).toBe(8);
  });
});

/** Carré de ~0,001° de côté, fermé comme le renvoie Overpass. */
const squareWay = {
  type: 'way' as const,
  id: 1,
  tags: { building: 'yes', height: '20' },
  geometry: [
    { lat: 45.0, lon: 6.0 },
    { lat: 45.0, lon: 6.001 },
    { lat: 45.001, lon: 6.001 },
    { lat: 45.001, lon: 6.0 },
    { lat: 45.0, lon: 6.0 },
  ],
};

describe('meshFromOverpass', () => {
  it('triangule un carré en deux triangles', () => {
    const mesh = meshFromOverpass([squareWay]);
    expect(mesh.positions.length / 2).toBe(6);
    expect(mesh.anchors).toHaveLength(1);
    expect(mesh.anchors[0]?.vertexCount).toBe(6);
  });

  it('associe la hauteur lue dans les tags à chaque sommet', () => {
    const mesh = meshFromOverpass([squareWay]);
    expect(mesh.anchors[0]?.height).toBe(20);
    for (const height of mesh.heights) expect(height).toBe(20);
  });

  it("pose l'ancre à l'intérieur de l'empreinte", () => {
    const mesh = meshFromOverpass([squareWay]);
    const anchor = mesh.anchors[0];
    expect(anchor?.lng).toBeGreaterThan(6.0);
    expect(anchor?.lng).toBeLessThan(6.001);
    expect(anchor?.lat).toBeGreaterThan(45.0);
    expect(anchor?.lat).toBeLessThan(45.001);
  });

  it('ignore les anneaux dégénérés plutôt que de produire des triangles invalides', () => {
    const mesh = meshFromOverpass([
      {
        type: 'way',
        id: 2,
        tags: { building: 'yes' },
        geometry: [
          { lat: 45, lon: 6 },
          { lat: 45, lon: 6 },
        ],
      },
    ]);
    expect(mesh.positions.length).toBe(0);
    expect(mesh.anchors).toHaveLength(0);
  });

  it("prend les anneaux extérieurs d'un multipolygone", () => {
    const mesh = meshFromOverpass([
      {
        type: 'relation',
        id: 3,
        tags: { building: 'yes', 'building:levels': '4' },
        members: [
          { type: 'way', role: 'outer', geometry: squareWay.geometry },
          { type: 'way', role: 'inner', geometry: squareWay.geometry },
        ],
      },
    ]);
    // Seul l'anneau extérieur est retenu : un seul bâtiment, pas deux.
    expect(mesh.anchors).toHaveLength(1);
    expect(mesh.anchors[0]?.height).toBe(12);
  });

  it('cumule plusieurs bâtiments dans un seul maillage', () => {
    const mesh = meshFromOverpass([squareWay, { ...squareWay, id: 4 }]);
    expect(mesh.anchors).toHaveLength(2);
    expect(mesh.anchors[1]?.firstVertex).toBe(6);
  });
});
