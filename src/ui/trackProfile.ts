/**
 * Bande de profil d'un parcours : altitude en aire, colorée selon le soleil ou l'ombre
 * à l'heure de passage.
 *
 * Deux catégories seulement (au soleil / à l'ombre), plus un état « relief inconnu ».
 * Le couple de couleurs est validé — écart CVD ΔE ≈ 26, bien au-delà du seuil de 8 —
 * ce qui dispense de recourir à une texture ; la légende et les chiffres du résumé
 * évitent malgré tout de reposer sur la seule couleur.
 */

export type SegmentState = 'sun' | 'shade' | 'unknown';

export interface ProfileSample {
  /** Distance depuis le départ, en mètres. */
  distance: number;
  /** Altitude en mètres, ou `null` si le fichier n'en porte pas. */
  elevation: number | null;
  state: SegmentState;
  time: Date;
}

export interface ProfileColors {
  sun: string;
  shade: string;
  unknown: string;
  line: string;
  grid: string;
  text: string;
}

const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 140;
const PADDING = { top: 10, right: 8, bottom: 20, left: 40 };

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function colorFor(state: SegmentState, colors: ProfileColors): string {
  return state === 'sun' ? colors.sun : state === 'shade' ? colors.shade : colors.unknown;
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

export interface ProfileRender {
  svg: SVGSVGElement;
  /** Renvoie l'échantillon le plus proche d'une position horizontale en fraction [0,1]. */
  sampleAt: (fraction: number) => ProfileSample | null;
}

/**
 * Construit le SVG du profil.
 *
 * L'aire est découpée en séries contiguës de même état, chacune tracée comme un
 * polygone jusqu'à la ligne de base. Les séries se touchent sans interstice : il
 * s'agit d'un parcours continu, et un espace laisserait croire à une interruption.
 */
export function renderProfile(samples: ProfileSample[], colors: ProfileColors): ProfileRender {
  const svg = el('svg', {
    viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': 'Profil d’ensoleillement du parcours',
  });

  if (samples.length < 2) return { svg, sampleAt: () => null };

  const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;
  const baseline = PADDING.top + plotHeight;

  const totalDistance = samples[samples.length - 1]?.distance ?? 1;
  const elevations = samples.map((s) => s.elevation).filter((e): e is number => e !== null);
  const hasElevation = elevations.length >= 2;
  const minEle = hasElevation ? Math.min(...elevations) : 0;
  const maxEle = hasElevation ? Math.max(...elevations) : 1;
  // Un parcours plat donnerait une aire d'épaisseur nulle : on impose une amplitude.
  const span = Math.max(maxEle - minEle, 10);

  const xOf = (distance: number) =>
    PADDING.left + (totalDistance > 0 ? (distance / totalDistance) * plotWidth : 0);
  const yOf = (elevation: number | null) =>
    hasElevation && elevation !== null
      ? baseline - ((elevation - minEle) / span) * plotHeight
      : baseline - plotHeight * 0.55;

  // Grille discrète : deux repères d'altitude suffisent à donner l'échelle.
  for (const value of hasElevation ? [minEle, maxEle] : []) {
    const y = yOf(value);
    svg.append(
      el('line', {
        x1: PADDING.left,
        x2: VIEW_WIDTH - PADDING.right,
        y1: y,
        y2: y,
        stroke: colors.grid,
        'stroke-width': 1,
      }),
      el('text', {
        x: PADDING.left - 6,
        y: y + 3,
        'text-anchor': 'end',
        'font-size': 9,
        fill: colors.text,
      }),
    );
    (svg.lastElementChild as SVGTextElement).textContent = `${Math.round(value)} m`;
  }

  // Aires par série d'état contigu.
  let runStart = 0;
  for (let i = 1; i <= samples.length; i++) {
    const endOfRun = i === samples.length || samples[i]?.state !== samples[runStart]?.state;
    if (!endOfRun) continue;

    // On prolonge d'un point pour que les séries voisines se rejoignent exactement.
    const last = Math.min(i, samples.length - 1);
    const points: string[] = [];
    for (let j = runStart; j <= last; j++) {
      const sample = samples[j] as ProfileSample;
      points.push(`${xOf(sample.distance).toFixed(2)},${yOf(sample.elevation).toFixed(2)}`);
    }
    const startX = xOf((samples[runStart] as ProfileSample).distance).toFixed(2);
    const endX = xOf((samples[last] as ProfileSample).distance).toFixed(2);

    svg.append(
      el('path', {
        d: `M ${startX},${baseline} L ${points.join(' L ')} L ${endX},${baseline} Z`,
        fill: colorFor((samples[runStart] as ProfileSample).state, colors),
        'fill-opacity': 0.9,
      }),
    );
    runStart = i;
  }

  // Ligne d'altitude par-dessus, fine et neutre : c'est la couleur de l'aire qui porte
  // l'information, la ligne ne fait que dessiner le relief.
  if (hasElevation) {
    const path = samples
      .map((s, i) => `${i === 0 ? 'M' : 'L'} ${xOf(s.distance).toFixed(2)},${yOf(s.elevation).toFixed(2)}`)
      .join(' ');
    svg.append(
      el('path', {
        d: path,
        fill: 'none',
        stroke: colors.line,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        'vector-effect': 'non-scaling-stroke',
      }),
    );
  }

  // Un seul repère de distance, à l'arrivée : le départ vaut zéro par construction, et
  // son étiquette viendrait se superposer à celle de l'altitude minimale.
  const distanceLabel = el('text', {
    x: xOf(totalDistance),
    y: VIEW_HEIGHT - 6,
    'text-anchor': 'end',
    'font-size': 9,
    fill: colors.text,
  });
  distanceLabel.textContent = formatDistance(totalDistance);
  svg.append(distanceLabel);

  const sampleAt = (fraction: number): ProfileSample | null => {
    const target = Math.max(0, Math.min(1, fraction)) * totalDistance;
    let best: ProfileSample | null = null;
    let bestGap = Infinity;
    for (const sample of samples) {
      const gap = Math.abs(sample.distance - target);
      if (gap < bestGap) {
        bestGap = gap;
        best = sample;
      }
    }
    return best;
  };

  return { svg, sampleAt };
}
