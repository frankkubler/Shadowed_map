/** Panneau d'informations solaires : horaires du jour et position instantanée du soleil. */
import { azimuthFromNorthDeg, compassLabel, sunPosition, sunTimes } from '../sun/sun';
import { formatDegrees, formatTime } from './format';

interface Item {
  label: string;
  value: string;
  muted?: boolean;
}

function renderItems(container: HTMLElement, items: Item[]): void {
  container.replaceChildren(
    ...items.map((item) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'item';

      const label = document.createElement('span');
      label.className = 'item-label';
      label.textContent = item.label;

      const value = document.createElement('span');
      value.className = item.muted ? 'item-value muted' : 'item-value';
      value.textContent = item.value;

      wrapper.append(label, value);
      return wrapper;
    }),
  );
}

export function createSunPanel(container: HTMLElement) {
  return {
    update(date: Date, lat: number, lng: number): void {
      const times = sunTimes(date, lat, lng);
      const { altitude, azimuth } = sunPosition(date, lat, lng);
      const daylight = altitude > 0;

      renderItems(container, [
        { label: 'Lever', value: formatTime(times.sunrise) },
        { label: 'Coucher', value: formatTime(times.sunset) },
        { label: 'Midi solaire', value: formatTime(times.solarNoon) },
        {
          label: 'Golden hour',
          value:
            times.goldenHour && times.sunset
              ? `${formatTime(times.goldenHour)} – ${formatTime(times.sunset)}`
              : '—',
        },
        {
          label: 'Hauteur du soleil',
          value: daylight ? formatDegrees(altitude) : 'sous l’horizon',
          muted: !daylight,
        },
        {
          label: 'Direction',
          value: daylight
            ? `${compassLabel(azimuth)} · ${azimuthFromNorthDeg(azimuth).toFixed(0)}°`
            : '—',
          muted: !daylight,
        },
      ]);
    },
  };
}
