/**
 * Logique pure des terrasses : validité et application d'un balayage « jusqu'à quand ? »,
 * et contenu de la popup. Isolée de MapLibre pour être vérifiable sous Node.
 */
import type { Terrace } from '../data/terraces';
import { sameLocalDay } from '../sun/sun';

/** Résultat du balayage pour une terrasse, rattaché à son identifiant OSM. */
export interface SweepOutcome {
  /** État au premier instant balayé, `null` si le relief y est inconnu. */
  atStart: boolean | null;
  /** Dernier instant balayé où la terrasse est encore au soleil. */
  sunUntil: Date | null;
  /** Vrai si elle reste au soleil jusqu'au dernier instant balayé (le coucher). */
  sunlitUntilSunset: boolean;
}

/**
 * Dépouille un balayage par terrasse.
 *
 * Indexé par identifiant et non par position : la liste des terrasses peut être
 * remplacée pendant le balayage (déplacement de carte, réponse Overpass), et un index
 * positionnel attribuerait alors les horaires à d'autres établissements.
 */
export function sweepOutcomes(
  ids: readonly string[],
  dates: readonly Date[],
  sunlit: readonly (readonly (boolean | null)[])[],
): Map<string, SweepOutcome> {
  const outcomes = new Map<string, SweepOutcome>();
  ids.forEach((id, index) => {
    let last: Date | null = null;
    let stillSunlit = true;
    for (let t = 0; t < sunlit.length; t++) {
      if (sunlit[t]?.[index] === true) last = dates[t] ?? last;
      else if (last !== null) {
        stillSunlit = false;
        break;
      }
    }
    outcomes.set(id, {
      atStart: sunlit[0]?.[index] ?? null,
      sunUntil: last,
      sunlitUntilSunset: last !== null && stillSunlit,
    });
  });
  return outcomes;
}

/**
 * Un balayage lancé à `sweptFrom` vaut-il encore à l'instant `date` ?
 *
 * Les horaires sont des instants absolus : ils restent justes tant qu'on avance dans la
 * même journée — c'est le cas de l'horloge temps réel, qui fait un pas par minute et
 * effaçait sinon le résultat presque aussitôt. Revenir en arrière ou changer de jour
 * sort de la plage balayée.
 */
export function sweepStillValid(sweptFrom: Date | null, date: Date): boolean {
  return (
    sweptFrom !== null && sameLocalDay(sweptFrom, date) && date.getTime() >= sweptFrom.getTime()
  );
}

/**
 * Contenu de la popup d'une terrasse.
 *
 * Construit en DOM et non en chaîne HTML : le nom vient du tag `name` d'OpenStreetMap,
 * que n'importe qui peut modifier. Passé à `setHTML`, un nom contenant du balisage
 * serait interprété — `textContent` le garde pour ce qu'il est, du texte.
 */
export function buildTerracePopup(
  doc: Document,
  terrace: Pick<Terrace, 'name' | 'kind'>,
  stateLabel: string,
): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'point-popup';

  const title = doc.createElement('h2');
  title.textContent = terrace.name;

  const list = doc.createElement('dl');
  for (const [label, value] of [
    ['Type', terrace.kind],
    ['État', stateLabel],
  ] as const) {
    const dt = doc.createElement('dt');
    dt.textContent = label;
    const dd = doc.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }

  root.append(title, list);
  return root;
}
