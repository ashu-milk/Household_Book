// charts.js — 依存ライブラリなしで描く、帳簿らしいインク調のチャート

const PALETTE = [
  '#8B9DD9', '#F2A4BC', '#7FB89A', '#E3B873',
  '#B79FD6', '#85C2C9', '#D99A7A', '#A8AE7E'
];

function colorFor(index) {
  return PALETTE[index % PALETTE.length];
}

export function formatYen(n) {
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

// ドーナツチャート: カテゴリ別の内訳
export function renderDonut(container, data) {
  // data: [{ label, value }]
  container.innerHTML = '';
  const total = data.reduce((s, d) => s + d.value, 0);
  const size = 220;
  const r = 86;
  const cx = size / 2;
  const cy = size / 2;
  const strokeWidth = 34;
  const circumference = 2 * Math.PI * r;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'donut-svg');

  // base ring (paper rule color)
  const base = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  base.setAttribute('cx', cx);
  base.setAttribute('cy', cy);
  base.setAttribute('r', r);
  base.setAttribute('fill', 'none');
  base.setAttribute('stroke', '#E4DCC6');
  base.setAttribute('stroke-width', strokeWidth);
  svg.appendChild(base);

  if (total > 0) {
    let offset = 0;
    data.forEach((d, i) => {
      const frac = d.value / total;
      const len = frac * circumference;
      const seg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      seg.setAttribute('cx', cx);
      seg.setAttribute('cy', cy);
      seg.setAttribute('r', r);
      seg.setAttribute('fill', 'none');
      seg.setAttribute('stroke', colorFor(i));
      seg.setAttribute('stroke-width', strokeWidth);
      seg.setAttribute('stroke-dasharray', `${len} ${circumference - len}`);
      seg.setAttribute('stroke-dashoffset', -offset);
      seg.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
      seg.setAttribute('class', 'donut-seg');
      svg.appendChild(seg);
      offset += len;
    });
  }

  // center label
  const fo = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  fo.setAttribute('x', cx);
  fo.setAttribute('y', cy - 6);
  fo.setAttribute('text-anchor', 'middle');
  fo.setAttribute('class', 'donut-center-label');
  fo.textContent = '合計';
  svg.appendChild(fo);

  const fo2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  fo2.setAttribute('x', cx);
  fo2.setAttribute('y', cy + 18);
  fo2.setAttribute('text-anchor', 'middle');
  fo2.setAttribute('class', 'donut-center-amount');
  fo2.textContent = formatYen(total);
  svg.appendChild(fo2);

  container.appendChild(svg);

  // legend
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  data
    .map((d, i) => ({ ...d, color: colorFor(i) }))
    .sort((a, b) => b.value - a.value)
    .forEach(d => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
      row.innerHTML = `
        <span class="stamp-dot" style="--stamp-color:${d.color}"></span>
        <span class="legend-label">${d.label}</span>
        <span class="legend-pct">${pct}%</span>
        <span class="legend-amount">${formatYen(d.value)}</span>
      `;
      legend.appendChild(row);
    });
  container.appendChild(legend);
}

// 月別の縦バーチャート: Credit/Cashの積み上げ
export function renderMonthlyBars(container, months) {
  // months: [{ label, card, cash }]
  container.innerHTML = '';
  const max = Math.max(1, ...months.map(m => m.card + m.cash));
  const wrap = document.createElement('div');
  wrap.className = 'bars-wrap';

  months.forEach(m => {
    const total = m.card + m.cash;
    const cardH = max > 0 ? (m.card / max) * 100 : 0;
    const cashH = max > 0 ? (m.cash / max) * 100 : 0;
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.innerHTML = `
      <div class="bar-amount">${total > 0 ? formatYen(total) : ''}</div>
      <div class="bar-stack" title="Credit ${formatYen(m.card)} / Cash ${formatYen(m.cash)}">
        <div class="bar-seg bar-cash" style="height:${cashH}%"></div>
        <div class="bar-seg bar-card" style="height:${cardH}%"></div>
      </div>
      <div class="bar-label">${m.label}</div>
    `;
    wrap.appendChild(col);
  });
  container.appendChild(wrap);
}
