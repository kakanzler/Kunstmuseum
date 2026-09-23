// Quick Open (Ctrl+F): file-name search across every registered folder.
// The index lives in main (index:search). ↑↓ move and immediately show the
// result in Preview/inspector; Enter opens its folder in the MRU gallery and
// selects it; Ctrl+Enter opens a pinned image tab; Esc restores the previous
// selection. The first row narrows the active gallery's filename filter.
import { api, state, setGlobalSelection } from './state.js';
import { el, thumbUrl, toastError } from './ui.js';

let open = null;

export function isQuickOpenOpen() {
  return !!open;
}

/** For the smoke test: the open palette's state. */
export function quickOpenState() {
  return open;
}

function highlight(name, positions) {
  const set = new Set(positions || []);
  const out = [];
  let buf = '';
  let marking = false;
  for (let i = 0; i < name.length; i++) {
    const m = set.has(i);
    if (m !== marking && buf) {
      out.push(marking ? el('mark', {}, buf) : buf);
      buf = '';
    }
    marking = m;
    buf += name[i];
  }
  if (buf) out.push(marking ? el('mark', {}, buf) : buf);
  return out;
}

export function openQuickOpen(wb) {
  if (open) {
    open.input.focus();
    open.input.select();
    return open;
  }
  const saved = { ...state.selection, paths: [...state.selection.paths] };
  const input = el('input', {
    class: 'input qo-input', spellcheck: 'false',
    placeholder: 'ファイル名で検索（スペース区切りで AND、「/」を含めるとフォルダ名も対象）',
  });
  const list = el('div', { class: 'qo-list' });
  const status = el('div', { class: 'qo-status muted small' }, '入力するとすべての登録フォルダから検索します');
  const box = el('div', { class: 'qo', role: 'dialog' }, input, list, status);
  const backdrop = el('div', { class: 'qo-backdrop' }, box);
  document.body.append(backdrop);

  const st = { input, rows: [], active: -1, query: '', building: false, count: 0 };
  let token = 0;
  let pollTimer = null;
  let debounce = null;

  const fileRows = () => st.rows.filter((r) => r.kind === 'file');
  const targetGallery = () => {
    const p = wb.activePane();
    return p && p.kind === 'gallery' ? p : wb.mruGalleryPane();
  };

  const setActive = (i, { select = true } = {}) => {
    if (!st.rows.length) { st.active = -1; return; }
    st.active = Math.max(0, Math.min(st.rows.length - 1, i));
    [...list.children].forEach((c, k) => c.classList.toggle('active', k === st.active));
    const node = list.children[st.active];
    if (node) node.scrollIntoView({ block: 'nearest' });
    const row = st.rows[st.active];
    if (select && row && row.kind === 'file') {
      setGlobalSelection({ paths: [row.item.path], primary: row.item.path, origin: { kind: 'search', list: fileRows().map((r) => r.item) } });
    }
  };

  const render = () => {
    list.replaceChildren(...st.rows.map((r, i) => {
      let node;
      if (r.kind === 'filter') {
        node = el('div', { class: 'qo-row qo-filter' },
          el('span', { class: 'qo-icon' }, '⌕'),
          el('span', {}, `表示中のギャラリーを “${r.query}” で絞り込む`));
      } else {
        const it = r.item;
        node = el('div', { class: 'qo-row', title: it.path },
          el('img', { class: 'qo-thumb', src: thumbUrl(it), alt: '', loading: 'lazy', draggable: 'false' }),
          el('div', { class: 'qo-text' },
            el('div', { class: 'qo-name' }, ...highlight(it.name, it.positions)),
            el('div', { class: 'qo-rel muted small' }, it.rel ? `${it.rootName}/${it.rel}` : it.rootName)));
      }
      node.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
      node.addEventListener('click', () => setActive(i));
      node.addEventListener('dblclick', () => { setActive(i); choose(false); });
      return node;
    }));
    [...list.children].forEach((c, k) => c.classList.toggle('active', k === st.active));
  };

  const search = async () => {
    clearTimeout(pollTimer);
    const q = input.value;
    st.query = q;
    const my = ++token;
    if (!q.trim()) {
      st.rows = [];
      st.active = -1;
      render();
      status.textContent = '入力するとすべての登録フォルダから検索します';
      return;
    }
    let r;
    try {
      r = await api.searchIndex(q, 100);
    } catch (e) {
      toastError(e);
      return;
    }
    if (my !== token || open !== st) return;
    st.building = r.building;
    st.count = r.count;
    const prevPath = st.rows[st.active] && st.rows[st.active].kind === 'file' ? st.rows[st.active].item.path : null;
    st.rows = [];
    if (targetGallery()) st.rows.push({ kind: 'filter', query: q.trim() });
    for (const item of r.results) st.rows.push({ kind: 'file', item });
    render();
    // keep the highlighted result when the list refreshes, else the best match
    let idx = prevPath ? st.rows.findIndex((x) => x.kind === 'file' && x.item.path === prevPath) : -1;
    if (idx < 0) idx = st.rows.findIndex((x) => x.kind === 'file');
    if (idx < 0) idx = st.rows.length ? 0 : -1;
    if (idx >= 0) {
      const row = st.rows[idx];
      setActive(idx, { select: row.kind === 'file' && row.item.path !== prevPath });
    }
    const n = r.results.length;
    status.textContent = r.building
      ? `インデックス作成中… ${r.count} 件（${n} 件ヒット）`
      : (n ? `${n} 件${n >= 100 ? '以上' : ''}ヒット（全 ${r.count} 件中）` : `一致するファイルはありません（全 ${r.count} 件中）`);
    if (r.building) pollTimer = setTimeout(search, 400); // results update while the index builds
  };

  const close = (restore) => {
    if (open !== st) return;
    open = null;
    clearTimeout(pollTimer);
    clearTimeout(debounce);
    token++;
    backdrop.remove();
    if (restore) setGlobalSelection(saved);
  };
  st.close = close;

  const choose = async (ctrl) => {
    const row = st.rows[st.active];
    if (!row) return;
    const list2 = fileRows().map((r) => r.item);
    close(false);
    try {
      if (row.kind === 'filter') {
        const g = targetGallery();
        if (g) {
          wb.activate(g.tabId);
          g.setSearch(row.query);
        }
      } else if (ctrl) {
        wb.openImage(row.item.path, { list: list2 });
      } else {
        await wb.revealInGallery(row.item.path);
      }
    } catch (e) {
      toastError(e);
    }
  };
  st.choose = choose;

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(search, 60);
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(st.active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(st.active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(e.ctrlKey || e.metaKey); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    e.stopPropagation(); // the palette owns the keyboard while open
  });
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(true); });

  open = st;
  input.focus();
  return st;
}
