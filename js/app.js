// app.js — アプリ全体の制御
import { DB } from './db.js';
import { renderDonut, renderMonthlyBars, formatYen } from './charts.js';
import { exportToFile, readFileAsJSON } from './export-import.js';

const viewRoot = document.getElementById('view-root');
const toastEl = document.getElementById('toast');

let state = {
  view: 'ledger',
  manageTab: 'category', // 'category' | 'subtype' | 'payee' | 'card' | 'recurring' | 'data'
  transactions: [],
  categories: [],
  cards: [],
  subtypes: [],
  payees: [],
  recurring: [],
  currentMonth: currentMonthKey(),
  calendarSelectedDate: null,
  editingId: null,
  recurringAutoFiredMonths: new Set() // この実行中に自動生成チェック済みの月（同一月で何度も処理しないためのガード）
};

function currentMonthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${y}年${m}月`;
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return currentMonthKey(d);
}

function showToast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add('is-visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('is-visible'), ms);
}

async function loadAll() {
  state.transactions = await DB.listTransactions();
  state.categories = await DB.listCategories();
  state.cards = await DB.listCards();
  state.subtypes = await DB.listSubtypes();
  state.payees = await DB.listPayees();
  state.recurring = await DB.listRecurring();
}

function txForMonth(monthKey) {
  return state.transactions.filter(t => t.date.startsWith(monthKey));
}

/* ===================== RENDER: ROUTER ===================== */
const headerMonthNav = document.getElementById('header-month-nav');
const headerMonthLabel = document.getElementById('header-month-label');
const headerPrevBtn = document.getElementById('header-prev-month');
const headerNextBtn = document.getElementById('header-next-month');

function render() {
  if (state.view === 'ledger') renderLedgerView();
  else if (state.view === 'calendar') renderCalendarView();
  else if (state.view === 'summary') renderSummaryView();
  else renderManageView();

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.view === state.view);
  });
  document.getElementById('fab-add').style.display = state.view === 'manage' ? 'none' : 'flex';

  // ヘッダーの年月ナビは記録・カレンダー・集計タブで表示し、月ラベルを最新化する
  const showMonthNav = state.view === 'ledger' || state.view === 'calendar' || state.view === 'summary';
  headerMonthNav.classList.toggle('is-hidden', !showMonthNav);
  if (showMonthNav) {
    headerMonthLabel.textContent = monthLabel(state.currentMonth);
  }
}

headerPrevBtn.addEventListener('click', () => {
  state.currentMonth = shiftMonth(state.currentMonth, -1);
  state.calendarSelectedDate = null;
  render();
});
headerNextBtn.addEventListener('click', () => {
  state.currentMonth = shiftMonth(state.currentMonth, 1);
  state.calendarSelectedDate = null;
  render();
});

/* ===================== VIEW: 記録 (LEDGER) ===================== */
function renderLedgerView() {
  const list = txForMonth(state.currentMonth);

  viewRoot.innerHTML = `
    <div class="ledger-list" id="ledger-list"></div>
  `;

  const listEl = document.getElementById('ledger-list');
  if (list.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="estamp">無</div>
        <p>${monthLabel(state.currentMonth)}の記録はまだありません。<br>右下の＋から追加できます。</p>
      </div>`;
    return;
  }

  list.forEach(t => {
    const row = document.createElement('button');
    row.className = 'ledger-row';
    const d = new Date(t.date);
    const dow = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    const subline = [t.subtype, t.payee, t.cardName, t.memo].filter(Boolean).join(' ・ ');
    row.innerHTML = `
      <span class="ledger-date"><span class="d">${d.getDate()}</span><span class="dow">${dow}</span></span>
      <span class="ledger-mid">
        <span class="ledger-cat-row">
          <span class="type-stamp ${t.type === 'card' ? 'is-card' : 'is-cash'}">${typeIconSVG(t.type)}</span>
          <span class="ledger-category">${escapeHTML(t.category)}</span>
        </span>
        <span class="ledger-memo">${escapeHTML(subline)}</span>
      </span>
      <span class="ledger-amount">${formatYen(t.amount)}</span>
    `;
    row.addEventListener('click', () => openEntryDialog(t));
    listEl.appendChild(row);
  });
}

/* ===================== 定期支払い：月初に未生成分だけを自動入力 ===================== */
function clampDayToMonth(year, month1to12, day) {
  // 31日指定で30日しかない月などに対応：その月の最終日に丸める
  const lastDay = new Date(year, month1to12, 0).getDate();
  return Math.min(day, lastDay);
}

/* 指定した月(monthKey 'YYYY-MM')について、定期支払いのうちまだ記録が生成されていないものを自動追加する。
   同じ月で重複生成しないよう、その月にrecurringIdが一致する記録が既にあればスキップする。 */
async function autoFillRecurringForMonth(monthKey) {
  if (state.recurringAutoFiredMonths.has(monthKey)) return false;
  if (!state.recurring || state.recurring.length === 0) {
    state.recurringAutoFiredMonths.add(monthKey);
    return false;
  }

  const [y, m] = monthKey.split('-').map(Number);
  let didAdd = false;

  for (const r of state.recurring) {
    // 開始月より前の月には生成しない
    if (monthKey < r.startMonth) continue;
    // 終了日が設定されていて、その月の支払日が終了日より後なら生成しない
    const day = clampDayToMonth(y, m, r.payDay);
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (r.endDate && dateStr > r.endDate) continue;

    // すでにこの月にこの定期支払いから生成された記録があるか確認
    const already = state.transactions.some(t => t.recurringId === r.id && t.date.startsWith(monthKey));
    if (already) continue;

    await DB.addTransaction({
      date: dateStr,
      type: r.type,
      cardName: r.cardName,
      category: r.category,
      subtype: r.subtype,
      payee: r.payee,
      amount: r.amount,
      memo: '',
      recurringId: r.id
    });
    didAdd = true;
  }

  state.recurringAutoFiredMonths.add(monthKey);
  if (didAdd) {
    state.transactions = await DB.listTransactions();
  }
  return didAdd;
}

/* ===================== VIEW: カレンダー (CALENDAR) ===================== */
function renderCalendarView() {
  autoFillRecurringForMonth(state.currentMonth).then(didAdd => {
    if (didAdd) render(); // 自動入力が発生した場合は最新データで再描画
  });
  renderCalendarViewBody();
}

function renderCalendarViewBody() {
  const [y, m] = state.currentMonth.split('-').map(Number);
  const firstDow = new Date(y, m - 1, 1).getDay(); // 0=日
  const daysInMonth = new Date(y, m, 0).getDate();
  const todayStr = todayISO();

  // 日別の集計（カード合計・現金合計）を作成
  const byDate = {};
  txForMonth(state.currentMonth).forEach(t => {
    if (!byDate[t.date]) byDate[t.date] = { card: 0, cash: 0 };
    byDate[t.date][t.type] += t.amount;
  });

  const dowLabels = ['日', '月', '火', '水', '木', '金', '土'];
  let cellsHTML = '';
  for (let i = 0; i < firstDow; i++) cellsHTML += `<div class="cal-cell is-empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dow = new Date(y, m - 1, day).getDay();
    const sums = byDate[dateStr];
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === state.calendarSelectedDate;
    cellsHTML += `
      <button type="button" class="cal-cell ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}" data-date="${dateStr}">
        <span class="cal-day ${dow === 0 ? 'is-sun' : ''} ${dow === 6 ? 'is-sat' : ''}">${day}</span>
        ${sums ? `
          <span class="cal-amounts">
            ${sums.card ? `<span class="cal-amount is-card">${formatYenShort(sums.card)}</span>` : ''}
            ${sums.cash ? `<span class="cal-amount is-cash">${formatYenShort(sums.cash)}</span>` : ''}
          </span>
        ` : ''}
      </button>
    `;
  }

  viewRoot.innerHTML = `
    <div class="calendar-card">
      <div class="cal-dow-row">
        ${dowLabels.map((d, i) => `<span class="cal-dow ${i === 0 ? 'is-sun' : ''} ${i === 6 ? 'is-sat' : ''}">${d}</span>`).join('')}
      </div>
      <div class="cal-grid">${cellsHTML}</div>
    </div>
    <div id="cal-day-detail"></div>
  `;

  viewRoot.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      const date = cell.dataset.date;
      state.calendarSelectedDate = state.calendarSelectedDate === date ? null : date;
      renderCalendarView();
    });
  });

  renderCalendarDayDetail();
}

function renderCalendarDayDetail() {
  const detailEl = document.getElementById('cal-day-detail');
  if (!detailEl) return;
  if (!state.calendarSelectedDate) { detailEl.innerHTML = ''; return; }

  const date = state.calendarSelectedDate;
  const list = state.transactions
    .filter(t => t.date === date)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  const d = new Date(date);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];

  let rowsHTML = '';
  if (list.length === 0) {
    rowsHTML = `<div class="empty-state"><div class="estamp">無</div><p>${d.getMonth() + 1}月${d.getDate()}日の記録はまだありません。<br>右下の＋から追加できます。</p></div>`;
  } else {
    rowsHTML = `<div class="ledger-list">` + list.map(t => {
      const subline = [t.subtype, t.payee, t.cardName, t.memo].filter(Boolean).join(' ・ ');
      return `
        <button type="button" class="ledger-row" data-id="${t.id}">
          <span class="ledger-date"><span class="d">${d.getDate()}</span><span class="dow">${dow}</span></span>
          <span class="ledger-mid">
            <span class="ledger-cat-row">
              <span class="type-stamp ${t.type === 'card' ? 'is-card' : 'is-cash'}">${typeIconSVG(t.type)}</span>
              <span class="ledger-category">${escapeHTML(t.category)}</span>
            </span>
            <span class="ledger-memo">${escapeHTML(subline)}</span>
          </span>
          <span class="ledger-amount">${formatYen(t.amount)}</span>
        </button>
      `;
    }).join('') + `</div>`;
  }

  detailEl.innerHTML = `
    <div class="cal-day-detail-head">${d.getMonth() + 1}月${d.getDate()}日（${dow}）の記録</div>
    ${rowsHTML}
  `;

  detailEl.querySelectorAll('.ledger-row[data-id]').forEach(row => {
    row.addEventListener('click', () => {
      const t = state.transactions.find(t => t.id === row.dataset.id);
      if (t) openEntryDialog(t);
    });
  });
}


function renderSummaryView() {
  const list = txForMonth(state.currentMonth);
  const cardTotal = list.filter(t => t.type === 'card').reduce((s, t) => s + t.amount, 0);
  const cashTotal = list.filter(t => t.type === 'cash').reduce((s, t) => s + t.amount, 0);
  const total = cardTotal + cashTotal;
  const cardPct = total > 0 ? Math.round((cardTotal / total) * 100) : 0;
  const cashPct = total > 0 ? 100 - cardPct : 0;

  viewRoot.innerHTML = `
    <div class="summary-card">
      <div class="total-row">
        <span class="total-label">支出合計</span>
        <span class="total-amount">${formatYen(total)}</span>
      </div>
      <div class="split-bar">
        <div class="split-bar-card" style="width:${cardPct}%"></div>
        <div class="split-bar-cash" style="width:${cashPct}%"></div>
      </div>
      <div class="split-legend">
        <span><i class="dot dot-card"></i>Credit ${formatYen(cardTotal)}（${cardPct}%）</span>
        <span><i class="dot dot-cash"></i>Cash ${formatYen(cashTotal)}（${cashPct}%）</span>
      </div>
    </div>

    <div class="chart-card">
      <p class="chart-card-title">カテゴリ別の内訳</p>
      <div id="donut-container"></div>
    </div>

    <div class="chart-card">
      <p class="chart-card-title">直近6か月の推移</p>
      <div id="bars-container"></div>
    </div>
  `;

  // donut by category
  const byCategory = {};
  list.forEach(t => { byCategory[t.category] = (byCategory[t.category] || 0) + t.amount; });
  const donutData = Object.entries(byCategory).map(([label, value]) => ({ label, value }));
  renderDonut(document.getElementById('donut-container'), donutData);

  if (donutData.length === 0) {
    document.getElementById('donut-container').insertAdjacentHTML('beforeend',
      '<p style="text-align:center;color:var(--ink-faint);font-size:13px;margin-top:8px;">この月の記録がありません</p>');
  }

  // monthly bars (last 6 months ending at currentMonth)
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const mk = shiftMonth(state.currentMonth, -i);
    const mList = txForMonth(mk);
    months.push({
      label: monthLabel(mk).replace('年', '/').replace('月', ''),
      card: mList.filter(t => t.type === 'card').reduce((s, t) => s + t.amount, 0),
      cash: mList.filter(t => t.type === 'cash').reduce((s, t) => s + t.amount, 0)
    });
  }
  renderMonthlyBars(document.getElementById('bars-container'), months);
}

/* ===================== VIEW: 管理 (カテゴリ・種別・支払い先・Credit・データ) ===================== */
function renderManageView() {
  viewRoot.innerHTML = `
    <div class="subtab-row subtab-row-scroll">
      <button class="subtab-btn ${state.manageTab === 'category' ? 'is-active' : ''}" id="subtab-category">カテゴリ</button>
      <button class="subtab-btn ${state.manageTab === 'subtype' ? 'is-active' : ''}" id="subtab-subtype">種別</button>
      <button class="subtab-btn ${state.manageTab === 'payee' ? 'is-active' : ''}" id="subtab-payee">支払い先</button>
      <button class="subtab-btn ${state.manageTab === 'card' ? 'is-active' : ''}" id="subtab-card">Credit</button>
      <button class="subtab-btn ${state.manageTab === 'recurring' ? 'is-active' : ''}" id="subtab-recurring">定期</button>
      <button class="subtab-btn ${state.manageTab === 'data' ? 'is-active' : ''}" id="subtab-data">データ</button>
    </div>
    <div id="subtab-content"></div>
  `;

  document.getElementById('subtab-category').addEventListener('click', () => {
    state.manageTab = 'category';
    renderManageView();
  });
  document.getElementById('subtab-subtype').addEventListener('click', () => {
    state.manageTab = 'subtype';
    renderManageView();
  });
  document.getElementById('subtab-payee').addEventListener('click', () => {
    state.manageTab = 'payee';
    renderManageView();
  });
  document.getElementById('subtab-card').addEventListener('click', () => {
    state.manageTab = 'card';
    renderManageView();
  });
  document.getElementById('subtab-recurring').addEventListener('click', () => {
    state.manageTab = 'recurring';
    renderManageView();
  });
  document.getElementById('subtab-data').addEventListener('click', () => {
    state.manageTab = 'data';
    renderManageView();
  });

  if (state.manageTab === 'category') renderCategorySubview();
  else if (state.manageTab === 'subtype') renderSubtypeSubview();
  else if (state.manageTab === 'payee') renderPayeeSubview();
  else if (state.manageTab === 'card') renderCardSubview();
  else if (state.manageTab === 'recurring') renderRecurringSubview();
  else renderDataSubview();
}

/* ---- データ管理 ---- */
function renderDataSubview() {
  const content = document.getElementById('subtab-content');
  content.innerHTML = `
    <h2 class="section-title">データの管理</h2>
    <div class="settings-group">
      <div class="settings-row">
        <div class="settings-row-text">
          <h3>JSONファイルに書き出す</h3>
          <p>全ての記録・カテゴリ・種別・支払い先・カード情報を1つのファイルに保存します</p>
        </div>
        <button id="btn-export" class="btn btn-secondary btn-small">書き出す</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-text">
          <h3>JSONファイルから読み込む</h3>
          <p>他の端末で書き出したファイルを取り込みます</p>
        </div>
        <button id="btn-import" class="btn btn-secondary btn-small">読み込む</button>
        <input type="file" id="file-import" class="file-input-hidden" accept="application/json">
      </div>
    </div>

    <h2 class="section-title">このアプリについて</h2>
    <div class="settings-group">
      <div class="settings-row">
        <div class="settings-row-text">
          <h3>すべてのデータはこの端末内に保存されます</h3>
          <p>サーバーには送信されません。端末を変える際はJSON書き出し・読み込みをご利用ください。</p>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-export').addEventListener('click', async () => {
    const payload = await DB.exportAll();
    exportToFile(payload);
    showToast('JSONファイルを書き出しました');
  });

  const fileInput = document.getElementById('file-import');
  document.getElementById('btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const payload = await readFileAsJSON(file);
      const mode = await confirmDialog({
        title: '読み込み方法を選択',
        message: '既存データに追加しますか、それとも全て置き換えますか？',
        confirmLabel: '追加する',
        cancelLabel: 'キャンセル',
        extraLabel: '置き換える'
      });
      if (mode === 'cancel') { fileInput.value = ''; return; }
      const result = await DB.importAll(payload, mode === 'extra' ? 'replace' : 'merge');
      await loadAll();
      render();
      showToast(`${result.importedTransactions}件の記録を読み込みました`);
    } catch (err) {
      showToast(err.message || '読み込みに失敗しました');
    } finally {
      fileInput.value = '';
    }
  });
}

/* ---- カテゴリの管理 ---- */
function renderCategorySubview() {
  const content = document.getElementById('subtab-content');
  content.innerHTML = `
    <h2 class="section-title">カテゴリの管理</h2>
    <div class="settings-group">
      <div class="category-add-row">
        <input type="text" id="new-category-input" placeholder="新しいカテゴリ名">
        <button id="btn-add-category" class="btn btn-secondary btn-small">追加</button>
      </div>
      <div class="category-manage-list" id="category-list"></div>
    </div>
  `;

  renderCategoryList();
  document.getElementById('btn-add-category').addEventListener('click', addCategoryHandler);
  document.getElementById('new-category-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addCategoryHandler(); }
  });
}

function renderCategoryList() {
  const listEl = document.getElementById('category-list');
  listEl.innerHTML = '';
  state.categories.forEach(c => {
    const row = document.createElement('div');
    row.className = 'category-manage-row';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = c.name;
    row.appendChild(nameSpan);

    const actions = document.createElement('div');
    actions.className = 'category-manage-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-cat-edit btn-small';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', () => startEditCategory(row, c));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-cat-delete btn-small';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'カテゴリを削除',
        message: `「${c.name}」を削除します。このカテゴリを使った過去の記録は残ります。`,
        confirmLabel: '削除する',
        cancelLabel: 'キャンセル'
      });
      if (ok === 'confirm') {
        // このカテゴリーに紐づいている種別は「未分類」に戻す（紐づけ先が消えて孤立しないようにする）
        await DB.renameCategoryInSubtypes(c.name, '');
        await DB.deleteCategory(c.id);
        state.categories = await DB.listCategories();
        state.subtypes = await DB.listSubtypes();
        renderCategoryList();
      }
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

/* ---- 汎用の「名前リスト管理」ファクトリ ----
   カテゴリ以外の単純な名前リスト(カード/種別/支払い先)はこの仕組みで生成する。
   ファクトリが呼ばれるたびに、対応する listXxx/addXxx/updateXxx/deleteXxx/renameXxxInTransactions
   を DB から呼び出す形にして、見た目と挙動を統一する。 */
function createSimpleListManager({ stateKey, listFn, addFn, updateFn, deleteFn, renameFn, txField, label, emptyText, placeholder, withCategory }) {
  function categoryOptionsHTML(selected) {
    return `<option value="">未分類</option>` + state.categories.map(c =>
      `<option value="${escapeHTML(c.name)}" ${selected === c.name ? 'selected' : ''}>${escapeHTML(c.name)}</option>`
    ).join('');
  }

  function renderSubview() {
    const content = document.getElementById('subtab-content');
    content.innerHTML = `
      <h2 class="section-title">${label}の管理</h2>
      ${withCategory ? `<p class="section-desc">カテゴリーを紐づけると、記録入力時にそのカテゴリーを選んだ場合のみ候補に表示されます。「未分類」のままにすると、どのカテゴリーを選んでも候補に表示されます。</p>` : ''}
      <div class="settings-group">
        <div class="category-add-row">
          <input type="text" id="new-${stateKey}-input" placeholder="${placeholder}">
          ${withCategory ? `<select id="new-${stateKey}-category">${categoryOptionsHTML('')}</select>` : ''}
          <button id="btn-add-${stateKey}" class="btn btn-secondary btn-small">追加</button>
        </div>
        <div class="category-manage-list" id="simple-list-${stateKey}"></div>
      </div>
    `;
    renderList();
    document.getElementById(`btn-add-${stateKey}`).addEventListener('click', addHandler);
    document.getElementById(`new-${stateKey}-input`).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addHandler(); }
    });
  }

  function renderList() {
    const listEl = document.getElementById(`simple-list-${stateKey}`);
    listEl.innerHTML = '';
    const items = state[stateKey];
    if (items.length === 0) {
      listEl.innerHTML = `<div class="category-manage-row"><span style="color:var(--ink-faint);">${emptyText}</span></div>`;
      return;
    }
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'category-manage-row';

      const nameWrap = document.createElement('div');
      nameWrap.className = 'category-manage-name-wrap';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = item.name;
      nameWrap.appendChild(nameSpan);

      if (withCategory) {
        const catSpan = document.createElement('span');
        catSpan.className = 'category-manage-tag';
        catSpan.textContent = item.category || '未分類';
        nameWrap.appendChild(catSpan);
      }
      row.appendChild(nameWrap);

      const actions = document.createElement('div');
      actions.className = 'category-manage-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-cat-edit btn-small';
      editBtn.textContent = '編集';
      editBtn.addEventListener('click', () => startEdit(row, item));

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-cat-delete btn-small';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `${label}を削除`,
          message: `「${item.name}」を削除します。この${label}を使った過去の記録は残ります。`,
          confirmLabel: '削除する',
          cancelLabel: 'キャンセル'
        });
        if (ok === 'confirm') {
          await deleteFn(item.id);
          state[stateKey] = await listFn();
          renderList();
        }
      });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }

  function startEdit(row, item) {
    row.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = item.name;
    row.appendChild(input);

    let categorySelect = null;
    if (withCategory) {
      categorySelect = document.createElement('select');
      categorySelect.className = 'category-manage-edit-select';
      categorySelect.innerHTML = categoryOptionsHTML(item.category || '');
      row.appendChild(categorySelect);
    }

    const actions = document.createElement('div');
    actions.className = 'category-manage-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary btn-small';
    saveBtn.textContent = '保存';
    saveBtn.type = 'button';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost btn-small';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => renderList());

    async function save() {
      const newName = input.value.trim();
      if (!newName) { showToast(`${label}名を入力してください`); return; }
      const oldName = item.name;
      const updated = { ...item, name: newName };
      if (withCategory) updated.category = categorySelect.value;
      await updateFn(updated);
      if (oldName !== newName && renameFn) {
        await renameFn(oldName, newName);
      }
      await loadAll();
      renderList();
      showToast(`${label}を更新しました`);
    }
    saveBtn.addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    row.appendChild(actions);
    input.focus();
    input.select();
  }

  async function addHandler() {
    const input = document.getElementById(`new-${stateKey}-input`);
    const name = input.value.trim();
    if (!name) return;
    const data = { name, order: state[stateKey].length };
    if (withCategory) {
      const categorySelect = document.getElementById(`new-${stateKey}-category`);
      data.category = categorySelect.value;
    }
    await addFn(data);
    state[stateKey] = await listFn();
    input.value = '';
    if (withCategory) document.getElementById(`new-${stateKey}-category`).value = '';
    renderList();
  }

  return { renderSubview };
}

const cardManager = createSimpleListManager({
  stateKey: 'cards',
  listFn: () => DB.listCards(),
  addFn: (data) => DB.addCard(data),
  updateFn: (record) => DB.updateCard(record),
  deleteFn: (id) => DB.deleteCard(id),
  renameFn: (oldName, newName) => DB.renameCardInTransactions(oldName, newName),
  label: 'カード',
  emptyText: '登録されているカードはありません',
  placeholder: '新しいカード名（例：楽天カード）'
});
function renderCardSubview() { cardManager.renderSubview(); }

const subtypeManager = createSimpleListManager({
  stateKey: 'subtypes',
  listFn: () => DB.listSubtypes(),
  addFn: (data) => DB.addSubtype(data),
  updateFn: (record) => DB.updateSubtype(record),
  deleteFn: (id) => DB.deleteSubtype(id),
  renameFn: (oldName, newName) => DB.renameSubtypeInTransactions(oldName, newName),
  label: '種別',
  emptyText: '登録されている種別はありません',
  placeholder: '新しい種別名（例：歯科、ガソリン代）',
  withCategory: true
});
function renderSubtypeSubview() { subtypeManager.renderSubview(); }

const payeeManager = createSimpleListManager({
  stateKey: 'payees',
  listFn: () => DB.listPayees(),
  addFn: (data) => DB.addPayee(data),
  updateFn: (record) => DB.updatePayee(record),
  deleteFn: (id) => DB.deletePayee(id),
  renameFn: (oldName, newName) => DB.renamePayeeInTransactions(oldName, newName),
  label: '支払い先',
  emptyText: '登録されている支払い先はありません',
  placeholder: '新しい支払い先名（例：イオン、〇〇内科クリニック）'
});
function renderPayeeSubview() { payeeManager.renderSubview(); }

/* ---- 定期支払い（毎月定額の自動入力設定）管理 ---- */
function recurringSummaryLine(r) {
  const period = r.endDate ? `${r.startMonth}〜${r.endDate}` : `${r.startMonth}〜`;
  const extra = [r.subtype, r.payee].filter(Boolean).join('・');
  return `毎月${r.payDay}日・${period}${extra ? ' ・ ' + extra : ''}`;
}

function renderRecurringSubview() {
  const content = document.getElementById('subtab-content');
  content.innerHTML = `
    <h2 class="section-title">定期支払いの管理</h2>
    <p class="section-desc">毎月決まった日に、決まった金額を自動で記録します。カレンダーでその月を開くと、その月分が自動入力されます。</p>
    <div class="settings-group">
      <button id="btn-add-recurring" class="btn btn-secondary btn-small" style="margin:14px;">＋ 定期支払いを追加</button>
      <div class="category-manage-list" id="recurring-list"></div>
    </div>
  `;
  renderRecurringList();
  document.getElementById('btn-add-recurring').addEventListener('click', () => openRecurringDialog());
}

function renderRecurringList() {
  const listEl = document.getElementById('recurring-list');
  listEl.innerHTML = '';
  if (state.recurring.length === 0) {
    listEl.innerHTML = `<div class="category-manage-row"><span style="color:var(--ink-faint);">登録されている定期支払いはありません</span></div>`;
    return;
  }
  state.recurring.forEach(r => {
    const row = document.createElement('div');
    row.className = 'category-manage-row recurring-row';

    const info = document.createElement('div');
    info.className = 'recurring-row-info';
    info.innerHTML = `
      <span class="recurring-row-name">${escapeHTML(r.name)}</span>
      <span class="recurring-row-sub">${escapeHTML(recurringSummaryLine(r))} ・ ${formatYen(r.amount)}</span>
    `;
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'category-manage-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-cat-edit btn-small';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', () => openRecurringDialog(r));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-cat-delete btn-small';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '定期支払いを削除',
        message: `「${r.name}」の定期支払い設定を削除します。これ以降は自動入力されませんが、過去に生成された記録は残ります。`,
        confirmLabel: '削除する',
        cancelLabel: 'キャンセル'
      });
      if (ok === 'confirm') {
        await DB.deleteRecurring(r.id);
        state.recurring = await DB.listRecurring();
        renderRecurringList();
        showToast('定期支払いを削除しました');
      }
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

/* 定期支払いの追加・編集ダイアログ（confirmDialogと同じ動的<dialog>パターン） */
function openRecurringDialog(existing = null) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'simple-dialog recurring-dialog';

    const categoryOptions = state.categories.map(c =>
      `<option value="${escapeHTML(c.name)}" ${existing && existing.category === c.name ? 'selected' : ''}>${escapeHTML(c.name)}</option>`
    ).join('');
    const cardOptions = state.cards.map(c =>
      `<option value="${escapeHTML(c.name)}" ${existing && existing.cardName === c.name ? 'selected' : ''}>${escapeHTML(c.name)}</option>`
    ).join('');
    const dayOptions = Array.from({ length: 31 }, (_, i) => i + 1).map(d =>
      `<option value="${d}" ${existing && existing.payDay === d ? 'selected' : ''}>${d}日</option>`
    ).join('');

    // 開始月（年・月）／終了日（年・月・日）の初期値を西暦の数値に分解しておく
    const startParts = existing
      ? { y: Number(existing.startMonth.split('-')[0]), m: Number(existing.startMonth.split('-')[1]) }
      : { y: new Date().getFullYear(), m: new Date().getMonth() + 1 };
    const endParts = existing && existing.endDate
      ? { y: Number(existing.endDate.split('-')[0]), m: Number(existing.endDate.split('-')[1]), d: Number(existing.endDate.split('-')[2]) }
      : null;

    dlg.innerHTML = `
      <h3>${existing ? '定期支払いを編集' : '定期支払いを追加'}</h3>
      <div class="recurring-form-scroll">
        <div class="field">
          <label class="field-label">名称</label>
          <input type="text" id="rf-name" placeholder="例：Netflix、家賃" value="${existing ? escapeHTML(existing.name) : ''}">
        </div>
        <div class="field">
          <label class="field-label">金額</label>
          <input type="number" id="rf-amount" inputmode="numeric" min="0" placeholder="例：1490" value="${existing ? existing.amount : ''}">
        </div>
        <div class="field">
          <label class="field-label">支払い方法</label>
          <div class="seg-control" id="rf-type-seg" role="radiogroup">
            <button type="button" class="seg-btn seg-card ${(!existing || existing.type === 'card') ? 'is-active' : ''}" data-type="card" role="radio" aria-checked="${(!existing || existing.type === 'card')}">Credit</button>
            <button type="button" class="seg-btn seg-cash ${(existing && existing.type === 'cash') ? 'is-active' : ''}" data-type="cash" role="radio" aria-checked="${(existing && existing.type === 'cash') || false}">Cash</button>
          </div>
        </div>
        <div class="field" id="rf-cardname-field" style="${(existing && existing.type === 'cash') ? 'display:none;' : ''}">
          <label class="field-label">カード名</label>
          <select id="rf-cardname">
            <option value="">選択してください</option>
            ${cardOptions}
          </select>
        </div>
        <div class="field">
          <label class="field-label">カテゴリ</label>
          <select id="rf-category">${categoryOptions}</select>
        </div>
        <div class="field">
          <span class="field-label">種別（任意）</span>
          <div class="combo" id="rf-subtype-combo">
            <input type="text" id="rf-subtype" placeholder="例：歯科、ガソリン代" autocomplete="off" value="${existing ? escapeHTML(existing.subtype || '') : ''}">
            <ul class="combo-list" id="rf-subtype-list" role="listbox" hidden></ul>
          </div>
        </div>
        <div class="field">
          <span class="field-label">支払い先（任意）</span>
          <div class="combo" id="rf-payee-combo">
            <input type="text" id="rf-payee" placeholder="例：イオン、〇〇内科クリニック" autocomplete="off" value="${existing ? escapeHTML(existing.payee || '') : ''}">
            <ul class="combo-list" id="rf-payee-list" role="listbox" hidden></ul>
          </div>
        </div>
        <div class="field">
          <label class="field-label">支払い日（毎月）</label>
          <select id="rf-payday">${dayOptions}</select>
        </div>
        <div class="field">
          <label class="field-label">開始月</label>
          <div class="era-toggle" id="rf-startmonth-era">
            <button type="button" class="era-btn is-active" data-era="seireki">西暦</button>
            <button type="button" class="era-btn" data-era="wareki">和暦</button>
          </div>
          <div class="ymd-row" id="rf-startmonth-fields"></div>
        </div>
        <div class="field">
          <label class="field-label">終了日（任意）</label>
          <div class="era-toggle" id="rf-enddate-era">
            <button type="button" class="era-btn is-active" data-era="seireki">西暦</button>
            <button type="button" class="era-btn" data-era="wareki">和暦</button>
          </div>
          <div class="ymd-row" id="rf-enddate-fields"></div>
          <p class="field-hint">設定すると、この日を過ぎた月は自動入力されなくなります。空欄のままにすると終了日なしになります。</p>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-ghost" data-action="cancel" type="button">キャンセル</button>
        <button class="btn btn-primary" data-action="save" type="button">${existing ? '保存' : '追加'}</button>
      </div>
    `;
    document.body.appendChild(dlg);

    // 種別・支払い先のコンボボックス（記録入力モーダルと共通のロジックを再利用）
    setupCombo('rf-subtype-combo', 'rf-subtype', 'rf-subtype-list', () => {
      const selectedCategory = dlg.querySelector('#rf-category').value;
      return state.subtypes
        .filter(s => !s.category || s.category === selectedCategory)
        .map(s => s.name);
    });
    setupCombo('rf-payee-combo', 'rf-payee', 'rf-payee-list', () => state.payees.map(p => p.name));

    // 開始月（年・月の2項目）・終了日（年・月・日の3項目、空欄可）の西暦/和暦切替フィールドを構築
    const startField = setupEraDateField(dlg, 'rf-startmonth', { hasDay: false, initial: startParts, required: true });
    const endField = setupEraDateField(dlg, 'rf-enddate', { hasDay: true, initial: endParts, required: false });

    const typeSeg = dlg.querySelector('#rf-type-seg');
    const cardField = dlg.querySelector('#rf-cardname-field');
    typeSeg.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        typeSeg.querySelectorAll('.seg-btn').forEach(b => {
          const active = b === btn;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-checked', String(active));
        });
        cardField.style.display = btn.dataset.type === 'cash' ? 'none' : '';
      });
    });

    dlg.addEventListener('click', async (e) => {
      const action = e.target.closest('button')?.dataset.action;
      if (!action) return;
      if (action === 'cancel') {
        dlg.close();
        dlg.remove();
        resolve(null);
        return;
      }
      if (action === 'save') {
        const name = dlg.querySelector('#rf-name').value.trim();
        const amount = Number(dlg.querySelector('#rf-amount').value);
        const type = typeSeg.querySelector('.seg-btn.is-active').dataset.type;
        const cardName = type === 'card' ? dlg.querySelector('#rf-cardname').value : '';
        const category = dlg.querySelector('#rf-category').value;
        const subtype = dlg.querySelector('#rf-subtype').value.trim();
        const payee = dlg.querySelector('#rf-payee').value.trim();
        const payDay = Number(dlg.querySelector('#rf-payday').value);

        const startResult = startField.getISOValue(); // { iso, error } 形式
        if (startResult.error) { showToast(startResult.error); return; }
        const startMonth = startResult.iso;

        const endResult = endField.getISOValue();
        if (endResult.error) { showToast(endResult.error); return; }
        const endDate = endResult.iso || '';

        if (!name) { showToast('名称を入力してください'); return; }
        if (!amount || amount <= 0) { showToast('金額を入力してください'); return; }
        if (!category) { showToast('カテゴリを選択してください'); return; }
        if (!startMonth) { showToast('開始月を入力してください'); return; }

        // 手入力された新しい種別・支払い先は、候補として一覧に自動登録する
        // （種別は今選んでいるカテゴリーに紐づけて登録する）
        if (subtype && !state.subtypes.some(s => s.name === subtype)) {
          await DB.addSubtype({ name: subtype, category, order: state.subtypes.length });
          state.subtypes = await DB.listSubtypes();
        }
        if (payee && !state.payees.some(p => p.name === payee)) {
          await DB.addPayee({ name: payee, order: state.payees.length });
          state.payees = await DB.listPayees();
        }

        const data = { name, amount, type, cardName, category, subtype, payee, payDay, startMonth, endDate };

        if (existing) {
          await DB.updateRecurring({ ...existing, ...data });
          showToast('定期支払いを更新しました');
        } else {
          await DB.addRecurring(data);
          showToast('定期支払いを追加しました');
        }
        state.recurring = await DB.listRecurring();
        // 自動入力ガードをリセット：設定変更後は再度チェックして反映できるようにする
        state.recurringAutoFiredMonths.clear();
        dlg.close();
        dlg.remove();
        resolve(data);
        renderRecurringList();
      }
    });
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve(null); });
    dlg.showModal();
  });
}

/* 西暦/和暦を切り替えながら年・月（・日）を手入力できるフィールドを構築する。
   fieldId: 'rf-startmonth' や 'rf-enddate' のようなベースID。
     -> '#{fieldId}-era' (トグルボタンの入っているdiv) と
        '#{fieldId}-fields' (年月日の入力欄を入れるdiv) を対象にDOMを生成する。
   options.hasDay: true なら日の入力欄も出す（終了日用）。false なら年月のみ（開始月用）。
   options.initial: { y, m, d? } 形式の西暦での初期値。終了日が未設定の場合は null。
   options.required: true なら年月が空欄だとエラーを返す。

   戻り値: { getISOValue() } — 現在の入力内容を 'YYYY-MM' または 'YYYY-MM-DD' のISO文字列に
   変換して返す。和暦入力時は西暦に変換してから返す。不正な値の場合は { error: '...' } を返す。 */
function setupEraDateField(dlg, fieldId, { hasDay, initial, required }) {
  const eraToggle = dlg.querySelector(`#${fieldId}-era`);
  const fieldsContainer = dlg.querySelector(`#${fieldId}-fields`);
  let currentEra = 'seireki'; // 'seireki' | 'wareki'

  function renderFields() {
    let y = '', m = '', d = '', selectedEraKanji = ERAS[0].kanji;
    if (initial) {
      if (currentEra === 'seireki') {
        y = initial.y;
      } else {
        const w = toWareki(initial.y);
        if (w) {
          y = w.year;
          selectedEraKanji = w.era;
        }
      }
      m = initial.m;
      d = hasDay ? (initial.d || '') : '';
    }

    const eraSelectHTML = currentEra === 'wareki'
      ? `<div class="ymd-item ymd-item-era">
           <span class="ymd-label">元号</span>
           <select class="ymd-era-name">
             ${ERAS.map(e => `<option value="${e.kanji}" ${e.kanji === selectedEraKanji ? 'selected' : ''}>${e.kanji}</option>`).join('')}
           </select>
         </div>`
      : '';

    fieldsContainer.innerHTML = `
      ${eraSelectHTML}
      <div class="ymd-item">
        <span class="ymd-label">年</span>
        <input type="number" class="ymd-year" placeholder="${currentEra === 'seireki' ? '2026' : '8'}" min="1" value="${y}">
      </div>
      <div class="ymd-item">
        <span class="ymd-label">月</span>
        <input type="number" class="ymd-month" placeholder="1〜12" min="1" max="12" value="${m}">
      </div>
      ${hasDay ? `
        <div class="ymd-item">
          <span class="ymd-label">日</span>
          <input type="number" class="ymd-day" placeholder="1〜31" min="1" max="31" value="${d}">
        </div>
      ` : ''}
    `;
  }

  renderFields();

  eraToggle.querySelectorAll('.era-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newEra = btn.dataset.era;
      if (newEra === currentEra) return;

      // 切り替え時、今入力されている年を変換して引き継ぐ（手入力中の値を消さないため）
      const yearInput = fieldsContainer.querySelector('.ymd-year');
      const eraNameSelect = fieldsContainer.querySelector('.ymd-era-name');
      const typedYear = yearInput && yearInput.value ? Number(yearInput.value) : null;

      let seirekiYear = null;
      if (typedYear !== null) {
        if (currentEra === 'seireki') {
          seirekiYear = typedYear;
        } else {
          const eraName = eraNameSelect ? eraNameSelect.value : ERAS[0].kanji;
          seirekiYear = fromWareki(eraName, typedYear);
        }
      }

      currentEra = newEra;
      eraToggle.querySelectorAll('.era-btn').forEach(b => b.classList.toggle('is-active', b === btn));

      if (seirekiYear !== null) {
        initial = { ...(initial || {}), y: seirekiYear };
      }
      renderFields();
    });
  });

  function getISOValue() {
    const yearInput = fieldsContainer.querySelector('.ymd-year');
    const monthInput = fieldsContainer.querySelector('.ymd-month');
    const dayInput = hasDay ? fieldsContainer.querySelector('.ymd-day') : null;
    const eraNameSelect = fieldsContainer.querySelector('.ymd-era-name');

    const yearStr = yearInput.value.trim();
    const monthStr = monthInput.value.trim();
    const dayStr = dayInput ? dayInput.value.trim() : '';

    // 終了日は空欄可。年・月・日のいずれも空欄なら「未設定」として扱う
    if (!required && !yearStr && !monthStr && !dayStr) {
      return { iso: '' };
    }

    if (!yearStr || !monthStr) {
      return { error: '年と月を入力してください' };
    }
    if (hasDay && !dayStr) {
      return { error: '日を入力してください' };
    }

    const month = Number(monthStr);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return { error: '月は1〜12の数字で入力してください' };
    }

    let seirekiYear;
    if (currentEra === 'seireki') {
      seirekiYear = Number(yearStr);
      if (!Number.isInteger(seirekiYear) || seirekiYear < 1900 || seirekiYear > 2100) {
        return { error: '年（西暦）は正しい数字で入力してください' };
      }
    } else {
      const eraName = eraNameSelect ? eraNameSelect.value : ERAS[0].kanji;
      const warekiYear = Number(yearStr);
      if (!Number.isInteger(warekiYear) || warekiYear < 1) {
        return { error: '年（和暦）は正しい数字で入力してください' };
      }
      seirekiYear = fromWareki(eraName, warekiYear);
      if (seirekiYear === null) {
        return { error: '和暦の元号を選択してください' };
      }
    }

    if (hasDay) {
      const day = Number(dayStr);
      const lastDay = new Date(seirekiYear, month, 0).getDate();
      if (!Number.isInteger(day) || day < 1 || day > lastDay) {
        return { error: `日は1〜${lastDay}の数字で入力してください` };
      }
      const iso = `${seirekiYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { iso };
    } else {
      const iso = `${seirekiYear}-${String(month).padStart(2, '0')}`;
      return { iso };
    }
  }

  return { getISOValue };
}

function startEditCategory(row, category) {
  row.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = category.name;

  const actions = document.createElement('div');
  actions.className = 'category-manage-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary btn-small';
  saveBtn.textContent = '保存';
  saveBtn.type = 'button';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost btn-small';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => renderCategoryList());

  async function save() {
    const newName = input.value.trim();
    if (!newName) { showToast('カテゴリ名を入力してください'); return; }
    const oldName = category.name;
    await DB.updateCategory({ ...category, name: newName });
    if (oldName !== newName) {
      await DB.renameCategoryInTransactions(oldName, newName);
      await DB.renameCategoryInSubtypes(oldName, newName);
    }
    await loadAll();
    renderCategoryList();
    showToast('カテゴリを更新しました');
  }
  saveBtn.addEventListener('click', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  row.appendChild(input);
  row.appendChild(actions);
  input.focus();
  input.select();
}

async function addCategoryHandler() {
  const input = document.getElementById('new-category-input');
  const name = input.value.trim();
  if (!name) return;
  await DB.addCategory({ name, order: state.categories.length });
  state.categories = await DB.listCategories();
  input.value = '';
  renderCategoryList();
}

/* ===================== ENTRY DIALOG (追加・編集) ===================== */
const entryDialog = document.getElementById('entry-dialog');
const entryForm = document.getElementById('entry-form');
const fType = document.getElementById('f-type');
const fDate = document.getElementById('f-date');
const fAmount = document.getElementById('f-amount');
const fCategory = document.getElementById('f-category');
const fSubtype = document.getElementById('f-subtype');
const fPayee = document.getElementById('f-payee');
const fCardName = document.getElementById('f-cardname');
const fCardNameField = document.getElementById('f-cardname-field');
const fMemo = document.getElementById('f-memo');
const entryDeleteBtn = document.getElementById('entry-delete');

// ---- カスタムコンボボックス（テキスト入力＋候補リスト） ----
// ネイティブの <input list> + <datalist> は、入力欄にすでに文字が入っていると
// タップしても候補が出ないブラウザが多いため、自前のドロップダウンで代替する。
// タップ/フォーカスすると常に全候補を表示し、文字を入力するとその場で絞り込む。
function setupCombo(comboId, inputId, listId, getOptions) {
  const combo = document.getElementById(comboId);
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let activeIndex = -1;

  function renderList(filterText) {
    const options = getOptions();
    const filtered = filterText
      ? options.filter(name => name.toLowerCase().includes(filterText.toLowerCase()))
      : options;

    if (filtered.length === 0) {
      list.innerHTML = `<li class="combo-empty">候補がありません</li>`;
    } else {
      list.innerHTML = filtered.map(name =>
        `<li class="combo-item" role="option">${escapeHTML(name)}</li>`
      ).join('');
    }
    activeIndex = -1;
  }

  function openList() {
    renderList(input.value.trim());
    list.hidden = false;
  }

  function closeList() {
    list.hidden = true;
    activeIndex = -1;
  }

  input.addEventListener('focus', openList);
  input.addEventListener('click', openList);
  input.addEventListener('input', openList);

  list.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.combo-item');
    if (!item) return;
    e.preventDefault();
    input.value = item.textContent;
    closeList();
    input.focus();
  });

  input.addEventListener('keydown', (e) => {
    const items = Array.from(list.querySelectorAll('.combo-item'));
    if (list.hidden || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      items.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0) {
        e.preventDefault();
        input.value = items[activeIndex].textContent;
        closeList();
      }
    } else if (e.key === 'Escape') {
      closeList();
    }
  });

  document.addEventListener('click', (e) => {
    if (!combo.contains(e.target)) closeList();
  });
}

setupCombo('f-subtype-combo', 'f-subtype', 'f-subtype-list', () => {
  const selectedCategory = fCategory.value;
  return state.subtypes
    .filter(s => !s.category || s.category === selectedCategory)
    .map(s => s.name);
});
setupCombo('f-payee-combo', 'f-payee', 'f-payee-list', () => state.payees.map(p => p.name));

/* ===================== 電卓モーダル ===================== */
const calculatorDialog = document.getElementById('calculator-dialog');
const calcDisplay = document.getElementById('calc-display');
const calcGrid = document.querySelector('.calc-grid');
const openCalculatorBtn = document.getElementById('open-calculator');
const calcCancelBtn = document.getElementById('calc-cancel');
const calcApplyBtn = document.getElementById('calc-apply');

let calc = {
  current: '0',   // 表示中の数値（文字列）
  previous: null, // 演算前の値
  operator: null, // '+', '−', '×', '÷'
  justEvaluated: false
};

function calcFormatDisplay(numStr) {
  // 表示用に3桁区切りを入れる（小数部はそのまま）
  if (numStr === '' || numStr === '-') return numStr || '0';
  const [intPart, decPart] = numStr.split('.');
  const negative = intPart.startsWith('-');
  const digits = negative ? intPart.slice(1) : intPart;
  const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let result = (negative ? '-' : '') + withCommas;
  if (decPart !== undefined) result += '.' + decPart;
  return result;
}

function calcRender() {
  calcDisplay.textContent = calcFormatDisplay(calc.current);
  document.querySelectorAll('.calc-key-op').forEach(btn => {
    btn.classList.toggle('is-selected', calc.operator === btn.dataset.op && !calc.justEvaluated);
  });
}

function calcResetAll() {
  calc = { current: '0', previous: null, operator: null, justEvaluated: false };
  calcRender();
}

function calcApplyOperator(a, b, op) {
  switch (op) {
    case '+': return a + b;
    case '−': return a - b;
    case '×': return a * b;
    case '÷': return b === 0 ? NaN : a / b;
    default: return b;
  }
}

function calcInputDigit(d) {
  if (calc.justEvaluated) {
    calc.current = d;
    calc.previous = null;
    calc.operator = null;
    calc.justEvaluated = false;
    calcRender();
    return;
  }
  if (calc.current === '0') {
    calc.current = d;
  } else {
    if (calc.current.replace('-', '').length >= 12) return; // 桁数制限
    calc.current += d;
  }
  calcRender();
}

function calcInputDot() {
  if (calc.justEvaluated) {
    calc.current = '0.';
    calc.previous = null;
    calc.operator = null;
    calc.justEvaluated = false;
    calcRender();
    return;
  }
  if (!calc.current.includes('.')) {
    calc.current += '.';
    calcRender();
  }
}

function calcInputOperator(op) {
  calc.justEvaluated = false;
  if (calc.operator && calc.previous !== null) {
    // 連続演算: 先に今までの式を計算してから次の演算子を構える
    const result = calcApplyOperator(calc.previous, parseFloat(calc.current), calc.operator);
    calc.previous = Number.isFinite(result) ? result : 0;
    calc.current = String(calc.previous);
  } else {
    calc.previous = parseFloat(calc.current);
  }
  calc.operator = op;
  calc.current = '0';
  calcRender();
}

function calcEquals() {
  if (calc.operator === null || calc.previous === null) return;
  const result = calcApplyOperator(calc.previous, parseFloat(calc.current), calc.operator);
  calc.current = Number.isFinite(result) ? String(result) : '0';
  calc.previous = null;
  calc.operator = null;
  calc.justEvaluated = true;
  calcRender();
}

function calcClear() {
  calcResetAll();
}

function calcBackspace() {
  if (calc.justEvaluated) {
    calcResetAll();
    return;
  }
  if (calc.current.length <= 1 || (calc.current.length === 2 && calc.current.startsWith('-'))) {
    calc.current = '0';
  } else {
    calc.current = calc.current.slice(0, -1);
  }
  calcRender();
}

function calcPercent() {
  const val = parseFloat(calc.current);
  if (!Number.isFinite(val)) return;
  calc.current = String(val / 100);
  calcRender();
}

calcGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.calc-key');
  if (!btn) return;
  if (btn.dataset.num !== undefined) {
    calcInputDigit(btn.dataset.num);
  } else if (btn.dataset.op) {
    calcInputOperator(btn.dataset.op);
  } else if (btn.dataset.action === 'equals') {
    calcEquals();
  } else if (btn.dataset.action === 'clear') {
    calcClear();
  } else if (btn.dataset.action === 'backspace') {
    calcBackspace();
  } else if (btn.dataset.action === 'percent') {
    calcPercent();
  } else if (btn.dataset.action === 'dot') {
    calcInputDot();
  }
});

openCalculatorBtn.addEventListener('click', () => {
  // 入力欄にすでに金額があれば、その値から電卓を開始する
  const existingValue = parseFloat(fAmount.value);
  calcResetAll();
  if (Number.isFinite(existingValue) && existingValue > 0) {
    calc.current = String(existingValue);
    calcRender();
  }
  calculatorDialog.showModal();
});

calcCancelBtn.addEventListener('click', () => calculatorDialog.close());

calcApplyBtn.addEventListener('click', () => {
  // 演算子が入力されたまま確定された場合は、その時点までを計算してから反映する
  let finalValue;
  if (calc.operator !== null && calc.previous !== null) {
    finalValue = calcApplyOperator(calc.previous, parseFloat(calc.current), calc.operator);
  } else {
    finalValue = parseFloat(calc.current);
  }
  if (!Number.isFinite(finalValue)) finalValue = 0;
  const rounded = Math.round(finalValue);
  fAmount.value = rounded >= 0 ? rounded : 0;
  calculatorDialog.close();
});

function openEntryDialog(existing = null) {
  state.editingId = existing ? existing.id : null;
  document.getElementById('entry-dialog-title').textContent = existing ? '記録を編集' : '支出を記録';
  entryDeleteBtn.hidden = !existing;

  setSegType(existing ? existing.type : 'card');
  const defaultDate = (state.view === 'calendar' && state.calendarSelectedDate) ? state.calendarSelectedDate : todayISO();
  fDate.value = existing ? existing.date : defaultDate;
  fAmount.value = existing ? existing.amount : '';
  fMemo.value = existing ? existing.memo || '' : '';

  fCategory.innerHTML = state.categories.map(c =>
    `<option value="${escapeHTML(c.name)}">${escapeHTML(c.name)}</option>`
  ).join('');
  if (existing) fCategory.value = existing.category;

  fSubtype.value = existing ? existing.subtype || '' : '';
  document.getElementById('f-subtype-list').hidden = true;

  fPayee.value = existing ? existing.payee || '' : '';
  document.getElementById('f-payee-list').hidden = true;

  if (state.cards.length === 0) {
    fCardName.innerHTML = `<option value="">登録されているカードがありません</option>`;
  } else {
    const blankOption = '<option value="">選択してください</option>';
    fCardName.innerHTML = blankOption + state.cards.map(c =>
      `<option value="${escapeHTML(c.name)}">${escapeHTML(c.name)}</option>`
    ).join('');
  }
  fCardName.value = (existing && existing.cardName) ? existing.cardName : '';

  entryDialog.showModal();
}

function setSegType(type) {
  fType.value = type;
  document.querySelectorAll('.seg-btn').forEach(b => {
    const active = b.dataset.type === type;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-checked', String(active));
  });
  fCardNameField.style.display = type === 'card' ? '' : 'none';
}

document.querySelectorAll('.seg-btn').forEach(btn => {
  btn.addEventListener('click', () => setSegType(btn.dataset.type));
});

document.getElementById('entry-cancel').addEventListener('click', () => entryDialog.close());

entryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const subtypeValue = fSubtype.value.trim();
  const payeeValue = fPayee.value.trim();
  const data = {
    type: fType.value,
    date: fDate.value,
    amount: fAmount.value,
    category: fCategory.value,
    subtype: subtypeValue,
    payee: payeeValue,
    cardName: fType.value === 'card' ? fCardName.value : '',
    memo: fMemo.value
  };
  if (!data.category) { showToast('カテゴリを選択してください'); return; }

  // 手入力された新しい種別・支払い先は、候補として一覧に自動登録する
  // （種別は今選んでいるカテゴリーに紐づけて登録する）
  if (subtypeValue && !state.subtypes.some(s => s.name === subtypeValue)) {
    await DB.addSubtype({ name: subtypeValue, category: data.category, order: state.subtypes.length });
  }
  if (payeeValue && !state.payees.some(p => p.name === payeeValue)) {
    await DB.addPayee({ name: payeeValue, order: state.payees.length });
  }

  if (state.editingId) {
    const existing = state.transactions.find(t => t.id === state.editingId);
    await DB.updateTransaction({ ...existing, ...data, amount: Number(data.amount) });
    showToast('記録を更新しました');
  } else {
    await DB.addTransaction(data);
    showToast('記録を保存しました');
  }
  entryDialog.close();
  await loadAll();
  state.currentMonth = data.date.slice(0, 7);
  if (state.view === 'calendar') state.calendarSelectedDate = data.date;
  render();
});

entryDeleteBtn.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'この記録を削除',
    message: '削除した記録は元に戻せません。',
    confirmLabel: '削除する',
    cancelLabel: 'キャンセル'
  });
  if (ok === 'confirm') {
    await DB.deleteTransaction(state.editingId);
    entryDialog.close();
    await loadAll();
    render();
    showToast('記録を削除しました');
  }
});

document.getElementById('fab-add').addEventListener('click', () => openEntryDialog());

/* ===================== SIMPLE CONFIRM DIALOG ===================== */
function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'キャンセル', extraLabel = null }) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'simple-dialog';
    dlg.innerHTML = `
      <h3>${escapeHTML(title)}</h3>
      <p>${escapeHTML(message)}</p>
      <div class="btn-row">
        <button class="btn btn-ghost" data-action="cancel">${escapeHTML(cancelLabel)}</button>
        ${extraLabel ? `<button class="btn btn-secondary" data-action="extra">${escapeHTML(extraLabel)}</button>` : ''}
        <button class="btn btn-primary" data-action="confirm">${escapeHTML(confirmLabel)}</button>
      </div>
    `;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => {
      const action = e.target.closest('button')?.dataset.action;
      if (action) {
        dlg.close();
        dlg.remove();
        resolve(action);
      }
    });
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve('cancel'); });
    dlg.showModal();
  });
}

/* ===================== UTIL ===================== */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ===================== 和暦変換ユーティリティ ===================== */
// 元号テーブル: 各元号の開始年(西暦)。境界年は1月1日始まりとして簡略化して扱う
// （改元月日まで厳密に扱うと定期支払いの「年・月」入力には不要に複雑になるため）
const ERAS = [
  { name: '令和', kanji: '令和', start: 2019 },
  { name: '平成', kanji: '平成', start: 1989 },
  { name: '昭和', kanji: '昭和', start: 1926 },
  { name: '大正', kanji: '大正', start: 1912 },
  { name: '明治', kanji: '明治', start: 1873 },
];

// 西暦年 -> { era: '令和', year: 8 } のような和暦表現に変換
function toWareki(seireki) {
  for (const e of ERAS) {
    if (seireki >= e.start) {
      const y = seireki - e.start + 1;
      return { era: e.kanji, year: y };
    }
  }
  return null; // 明治より前は扱わない
}

// 和暦(元号名 + 年) -> 西暦年。該当する元号がなければ null
function fromWareki(eraKanji, warekiYear) {
  const e = ERAS.find(e => e.kanji === eraKanji);
  if (!e) return null;
  return e.start + warekiYear - 1;
}

/* カレンダーの日付セルに表示する金額（漢字・英字を使わず数字のみ、コンマ区切り） */
function formatYenShort(n) {
  return Math.round(n).toLocaleString('en-US');
}

/* 記録カードの支払い種別アイコン（カード=クレジットカード／現金=ガマ口財布） */
function typeIconSVG(type) {
  if (type === 'card') {
    return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="4.5" width="22" height="15" rx="2.6" fill="#6E6BC4"/>
      <rect x="1" y="8" width="22" height="3.6" fill="#fff" fill-opacity="0.9"/>
      <rect x="3.4" y="14.5" width="7" height="2.2" rx="1.1" fill="#fff" fill-opacity="0.75"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 13.6c0-4.3 4-7.3 9-7.3s9 3 9 7.3c0 4.4-4 7.1-9 7.1s-9-2.7-9-7.1Z" fill="#3E2616"/>
    <path d="M4.4 13.6c0-3.6 3.4-6 7.6-6s7.6 2.4 7.6 6c0 3.9-3.5 6.3-7.6 6.3s-7.6-2.4-7.6-6.3Z" fill="#FFD000"/>
    <path d="M9.7 5.05c0.55-0.55 1.55-0.5 2.05 0.15-0.2-0.7 0.45-1.3 1.1-1.05 0.6 0.25 0.75 1 0.35 1.5-0.5 0.6-1.45 0.65-2.0 0.05-0.05 0.6-0.75 0.95-1.3 0.6-0.5-0.3-0.6-0.85-0.2-1.25Z" fill="#3E2616"/>
  </svg>`;
}

/* ===================== TAB NAV ===================== */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    render();
  });
});

/* ===================== INIT ===================== */
async function init() {
  await DB.init();
  await loadAll();
  fDate.value = todayISO();
  render();
}
init();

/* ===================== SERVICE WORKER (auto-update) ===================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // すでに動いているSWがいる状態で新しいSWが見つかったら、自動で適用する
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker?.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // 新しいバージョンの取得が完了 → 自動で反映される（reload）
            showToast('新しいバージョンに更新しています…');
          }
        });
      });
    }).catch(() => { /* SW登録失敗は静かに無視（オフライン動作には影響しない） */ });

    // 新しいSWが制御を引き継いだら、一度だけ自動リロードして新しいJS/CSSを反映
    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshed) return;
      refreshed = true;
      window.location.reload();
    });
  });
}
