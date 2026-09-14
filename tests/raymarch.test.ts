import { describe, expect, it } from 'vitest';
import { solveStepGrowth } from '../src/shadow/raymarch';

/** Distance totale parcourue par une marche géométrique de `steps` pas partant de 1 texel. */
function totalDistance(growth: number, steps: number): number {
  return growth === 1 ? steps : (Math.pow(growth, steps) - 1) / (growth - 1);
}

describe('solveStepGrowth', () => {
  it('garde un pas constant quand les pas suffisent à couvrir la distance', () => {
    expect(solveStepGrowth(100, 256)).toBe(1);
    expect(solveStepGrowth(256, 256)).toBe(1);
  });

  it('couvre effectivement la distance demandée', () => {
    for (const distance of [1000, 2896, 10000]) {
      const growth = solveStepGrowth(distance, 256);
      expect(totalDistance(growth, 256)).toBeCloseTo(distance, 0);
    }
  });

  it('commence par des pas fins, ce qui conditionne les ombres de bâtiments', () => {
    // Un bâtiment fait quelques texels : les premiers pas doivent rester inférieurs à ~2.
    const growth = solveStepGrowth(2048 * Math.SQRT2, 256);
    expect(Math.pow(growth, 10)).toBeLessThan(2);
  });

  it('demande une croissance plus forte quand les pas sont plus rares', () => {
    expect(solveStepGrowth(4000, 64)).toBeGreaterThan(solveStepGrowth(4000, 256));
  });

  it('reste défini pour les cas dégénérés', () => {
    expect(solveStepGrowth(0, 256)).toBe(1);
    expect(solveStepGrowth(500, 1)).toBe(1);
  });
});
