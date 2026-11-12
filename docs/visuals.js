(function () {
  'use strict';

  const palette = {
    production: { label: 'Добывающие', color: '#bb9442' },
    injection: { label: 'ППД', color: '#608a6b' },
    piezometric: { label: 'Пьезометрические', color: '#438bb1' },
    conserved: { label: 'Законсервированные', color: '#c9ac45' },
    abandoned: { label: 'Ликвидированные', color: '#77848a' },
    unknown: { label: 'Тип не указан', color: '#b5bcbf' }
  };
  const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const format = value => value.toLocaleString('ru-RU');
  const wellWord = value => value % 10 === 1 && value % 100 !== 11 ? 'скважина' : value % 10 >= 2 && value % 10 <= 4 && (value % 100 < 12 || value % 100 > 14) ? 'скважины' : 'скважин';
  const typeWord = value => value === 1 ? 'тип' : value >= 2 && value <= 4 ? 'типа' : 'типов';

  window.atlasDonut = function atlasDonut(wells, options = {}) {
    const entries = Array.isArray(wells) ? wells : [];
    const definitions = typeof TYPES === 'object' ? TYPES : palette;
    const counts = Object.fromEntries(Object.keys(palette).map(type => [type, 0]));
    entries.forEach(well => { counts[Object.hasOwn(counts, well?.type) ? well.type : 'unknown'] += 1; });
    const total = entries.length;
    const centerLabel = typeof options.label === 'string' && options.label.trim() ? options.label.trim() : wellWord(total);
    const size = Number.isFinite(options.size) ? Math.max(110, Math.min(240, options.size)) : 144;
    const overview = options.variant === 'overview' || size >= 190;
    const present = Object.keys(palette).filter(type => counts[type]);
    const leading = present.reduce((best, type) => !best || counts[type] > counts[best] ? type : best, null);
    const description = total ? `${format(total)} ${wellWord(total)}. ${present.map(type => `${definitions[type]?.label || palette[type].label}: ${format(counts[type])}`).join('. ')}.` : 'Скважины отсутствуют.';
    let offset = 0;
    const segments = present.map((type, index) => {
      const share = counts[type] / total * 100;
      const gap = present.length > 1 ? Math.min(1.25, share * .16) : 0;
      const length = share - gap;
      const start = offset + gap / 2;
      offset += share;
      return `<circle class="atlas-donut-segment" cx="96" cy="96" r="69" pathLength="100" fill="none" stroke-width="17" stroke="${palette[type].color}" stroke-dasharray="${length.toFixed(5)} ${(100 - length).toFixed(5)}" stroke-dashoffset="${(-start).toFixed(5)}" transform="rotate(-90 96 96)" style="--atlas-segment-color:var(--${type},${palette[type].color});--atlas-dash:${length.toFixed(5)} ${(100 - length).toFixed(5)};--atlas-segment-delay:${index * 45}ms"/>`;
    }).join('');
    const title = options.title || 'Состав скважин';
    const mainType = leading ? definitions[leading]?.label || palette[leading].label : 'Нет данных';
    const percent = leading ? Math.round(counts[leading] / total * 100) : 0;
    return `<figure class="atlas-donut${overview ? ' atlas-donut-overview' : ''}" style="--atlas-donut-size:${size}px" aria-label="${safe(title)}">
      <div class="atlas-donut-graphic"><svg class="atlas-donut-svg" viewBox="0 0 192 192" role="img" aria-label="${safe(description)}"><title>${safe(title)}</title><desc>${safe(description)}</desc>
        <circle class="atlas-donut-orbit" cx="96" cy="96" r="88" fill="none" stroke-width="1"/>
        <path class="atlas-donut-ticks" d="M96 4v5M96 183v5M4 96h5M183 96h5" fill="none" stroke-width="1"/>
        <circle class="atlas-donut-track" cx="96" cy="96" r="69" fill="none" stroke-width="17"/>
        ${segments}
        <text class="atlas-donut-total" x="96" y="96" text-anchor="middle" dominant-baseline="central">${format(total)}</text>
        <text class="atlas-donut-unit" x="96" y="119" text-anchor="middle">${safe(centerLabel)}</text>
      </svg></div>
      <figcaption class="atlas-donut-copy"><span class="atlas-donut-kicker">${safe(title)}</span><strong>${safe(mainType)}</strong>${leading ? `<div class="atlas-donut-share"><b>${percent}<small>%</small></b><span>от общего числа<br>${format(counts[leading])} ${wellWord(counts[leading])}</span></div><span class="atlas-donut-types"><i style="--atlas-dot-color:var(--${leading},${palette[leading].color})"></i>${present.length} ${typeWord(present.length)} в реестре</span>` : '<span class="atlas-donut-empty">Добавьте записи в реестр</span>'}</figcaption>
    </figure>`;
  };

  window.atlasOverviewVisual = function atlasOverviewVisual(wells) {
    return window.atlasDonut(wells, { variant: 'overview', title: 'Вся бригада', size: 210 });
  };
}());
