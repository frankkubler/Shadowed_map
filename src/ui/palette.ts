/**
 * Couleurs de l'encodage soleil / ombre, partagées par la carte, la liste des terrasses
 * et le profil de trace — pour que l'ensemble se lise comme un seul système.
 *
 * Les deux teintes ont été validées : bande de clarté, plancher de chroma, contraste sur
 * le fond, et surtout séparation en vision des couleurs déficiente (ΔE ≈ 26, très
 * au-dessus du seuil de 8). C'est ce dernier point qui dispense de recourir à une
 * texture ou à un motif en complément de la couleur.
 *
 * Les valeurs vivent dans la feuille de style, pour que le thème clair et le thème
 * sombre restent définis au même endroit que le reste de la palette ; les constantes
 * ci-dessous ne servent que de repli si la lecture échoue (rendu hors document).
 */
import type { ProfileColors } from './trackProfile';

/** Repli : les valeurs validées du thème clair. */
const FALLBACK: ProfileColors = {
  sun: '#c9741a',
  shade: '#43509e',
  unknown: '#9aa0b4',
  line: '#52514e',
  grid: 'rgba(127,127,127,0.35)',
  text: '#5a6078',
};

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

/** Couleurs courantes, relues à chaque appel pour suivre un changement de thème. */
export function stateColors(): ProfileColors {
  if (typeof document === 'undefined') return FALLBACK;
  const styles = getComputedStyle(document.documentElement);
  return {
    sun: readVar(styles, '--sun', FALLBACK.sun),
    shade: readVar(styles, '--shade', FALLBACK.shade),
    unknown: readVar(styles, '--state-unknown', FALLBACK.unknown),
    line: readVar(styles, '--text-muted', FALLBACK.line),
    grid: readVar(styles, '--border', FALLBACK.grid),
    text: readVar(styles, '--text-muted', FALLBACK.text),
  };
}

/**
 * Prévient d'un changement de thème système.
 *
 * MapLibre fige les couleurs de peinture au moment où la couche est ajoutée : sans ce
 * signal, une bascule clair/sombre laisserait les points et la trace dans l'ancienne
 * palette.
 */
export function onColorSchemeChange(listener: () => void): void {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', listener);
}
