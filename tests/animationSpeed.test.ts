import { describe, expect, it } from 'vitest';
import {
  MAX_ANIMATION_SPEED,
  MIN_ANIMATION_SPEED,
  animationSpeedFromSlider,
  formatAnimationSpeed,
  sliderFromAnimationSpeed,
} from '../src/ui/format';

describe('vitesse d’animation', () => {
  it('couvre toute la plage aux extrémités du curseur', () => {
    expect(animationSpeedFromSlider(0)).toBeCloseTo(MIN_ANIMATION_SPEED, 6);
    expect(animationSpeedFromSlider(100)).toBeCloseTo(MAX_ANIMATION_SPEED, 6);
  });

  it('borne les positions hors plage', () => {
    expect(animationSpeedFromSlider(-20)).toBeCloseTo(MIN_ANIMATION_SPEED, 6);
    expect(animationSpeedFromSlider(999)).toBeCloseTo(MAX_ANIMATION_SPEED, 6);
  });

  it('progresse géométriquement, pas linéairement', () => {
    const bas = animationSpeedFromSlider(25) / animationSpeedFromSlider(0);
    const haut = animationSpeedFromSlider(100) / animationSpeedFromSlider(75);
    expect(bas).toBeCloseTo(haut, 6);
  });

  // Le curseur n'a que 101 crans : l'aller-retour ne peut pas être exact, un cran
  // valant environ 5 % de vitesse. On vérifie donc qu'on retombe dans le bon cran.
  it('fait l’aller-retour entre vitesse et position', () => {
    for (const vitesse of [10, 60, 240, 720, 1440]) {
      const retour = animationSpeedFromSlider(sliderFromAnimationSpeed(vitesse));
      expect(Math.abs(retour - vitesse) / vitesse).toBeLessThan(0.03);
    }
  });

  it('formate en minutes puis en heures par seconde', () => {
    expect(formatAnimationSpeed(10)).toBe('10 min/s');
    expect(formatAnimationSpeed(59)).toBe('59 min/s');
    expect(formatAnimationSpeed(60)).toBe('1 h/s');
    expect(formatAnimationSpeed(240)).toBe('4 h/s');
    expect(formatAnimationSpeed(90)).toBe('1.5 h/s');
    expect(formatAnimationSpeed(1440)).toBe('24 h/s');
  });
});
