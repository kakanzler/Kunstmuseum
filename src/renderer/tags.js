// Tag chips, autocomplete input, tag operations and the タグ管理 dialog.
// Tags form a per-type hierarchy (parentId); see tag-tree.js.
import { api, state, setLib, applyImageTags, tagById, typeById, tagColor, emit } from './state.js';
import { el, openModal, confirmDialog, promptDialog, toastError, toast, collator } from './ui.js';
import { flattenTree, pathLabel, descendantsOf, wouldCycle } from './tag-tree.js';

// ---------- operations ----------
export async function addTagsToPaths(paths, tagIds) {
  if (!paths.length || !tagIds.length) return;
  const r = await api.addImageTags(paths, tagIds);
  setLib(r.lib);
  applyImageTags(r.tags);
}

export async function removeTagsFromPaths(paths, tagIds) {
  if (!paths.length || !tagIds.length) return;
  const r = await api.removeImageTags(paths, tagIds);
  setLib(r.lib);
  applyImageTags(r.tags);
}

export async function createTag(name, typeId, parentId = null) {
  const r = await api.addTag({ name, typeId, parentId });
  setLib(r.lib);
  return r.tag;
}

// ---------- hierarchy helpers ----------
/** "動物 > 犬 > 柴犬" for a tag id. */
export function tagPath(id) {
  return pathLabel(state.lib.tags, id);
}

/** "直接 n（子孫含め m）" */
export function usageLabel(id) {
  const n = state.lib.usage[id] || 0;
  const m = (state.lib.usageDeep && state.lib.usageDeep[id]) || n;
  return m > n ? `直接 ${n}（子孫含め ${m}）` : `直接 ${n}`;
}

/**
 * Fill a <select> with tags grouped by type and indented as a tree.
 * opts: {blank: label for an empty first option, exclude: Set of ids,
 * typeId: only this type, count: (tag)=>string, value: selected id}
 */
export function fillTagSelect(select, { blank = null, exclude = new Set(), typeId = null, count = null, value = null } = {}) {
  select.replaceChildren();
  if (blank != null) select.append(el('option', { value: '' }, blank));
  for (const type of state.lib.tagTypes) {
    if (typeId && type.id !== typeId) continue;
    const rows = flattenTree(state.lib.tags, type.id).filter((n) => !exclude.has(n.tag.id));
    if (!rows.length) continue;
    const g = el('optgroup', { label: type.name });
    for (const n of rows) {
      g.append(el('option', { value: n.tag.id, title: tagPath(n.tag.id) },
        `${'　'.repeat(n.depth)}${n.depth ? '└ ' : ''}${n.tag.name}${count ? count(n.tag) : ''}`));
    }
    select.append(g);
  }
  if (value && [...select.options].some((o) => o.value === value)) select.value = value;
  return select;
}

// ---------- chips ----------
export function tagChip(tag, { onRemove, partial = false, onClick, title } = {}) {
  const type = typeById(tag.typeId);
  const chip = el('span', {
    class: `chip${partial ? ' partial' : ''}${onRemove ? '' : ' no-x'}`,
    title: title || `${type ? type.name : ''}: ${tagPath(tag.id) || tag.name}`,
    style: { '--chip': tagColor(tag) },
  }, el('span', { class: 'chip-label' }, tag.name));
  if (partial) chip.append(el('span', { class: 'chip-badge' }, '一部'));
  if (onClick) chip.addEventListener('click', (e) => { if (!e.target.closest('.chip-x')) onClick(); });
  if (onRemove) {
    chip.append(el('button', {
      class: 'chip-x', title: '外す',
      onclick: (e) => { e.stopPropagation(); onRemove(); },
    }, '×'));
  }
  return chip;
}

export function sortedTags(tags = state.lib.tags) {
  const order = new Map(state.lib.tagTypes.map((t, i) => [t.id, i]));
  return [...tags].sort((a, b) => (order.get(a.typeId) - order.get(b.typeId)) || collator.compare(tagPath(a.id), tagPath(b.id)));
}

// ---------- autocomplete input ----------
/**
 * @param {{onPick:(tagId:string)=>any, exclude?:()=>Set<string>}} opts
 */
export function createTagInput({ onPick, exclude = () => new Set() }) {
  const input = el('input', { class: 'input', placeholder: 'タグを追加…', spellcheck: 'false' });
  const typeSel = el('select', { class: 'input', title: '新規タグの種類' });
  const list = el('div', { class: 'ac-list hidden' });
  const row = el('div', { class: 'tag-input-row' }, input, typeSel, list);
  let options = [];
  let active = 0;

  const fillTypes = () => {
    const cur = typeSel.value;
    typeSel.innerHTML = '';
    for (const t of state.lib.tagTypes) typeSel.append(el('option', { value: t.id }, t.name));
    if (cur && state.lib.tagTypes.some((t) => t.id === cur)) typeSel.value = cur;
  };
  fillTypes();

  const close = () => { list.classList.add('hidden'); options = []; };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    if (!q && document.activeElement !== input) { close(); return; }
    const ex = exclude();
    const matches = sortedTags().filter((t) => !ex.has(t.id) && (!q || tagPath(t.id).toLowerCase().includes(q)));
    matches.sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)));
    options = matches.slice(0, 30).map((t) => ({ kind: 'tag', tag: t }));
    const exact = q && state.lib.tags.some((t) => t.typeId === typeSel.value && !t.parentId && t.name.toLowerCase() === q);
    if (q && !exact) options.push({ kind: 'new', name: input.value.trim() });
    active = Math.min(active, Math.max(0, options.length - 1));
    list.innerHTML = '';
    options.forEach((o, i) => {
      let item;
      if (o.kind === 'tag') {
        const type = typeById(o.tag.typeId);
        item = el('div', { class: 'ac-item', title: tagPath(o.tag.id) },
          el('span', { class: 'dot', style: { background: tagColor(o.tag) } }),
          el('span', {}, tagPath(o.tag.id)),
          el('span', { class: 'ac-type' }, type ? type.name : ''));
      } else {
        const type = typeById(typeSel.value);
        item = el('div', { class: 'ac-item' }, `「${o.name}」を新規作成`, el('span', { class: 'ac-type' }, type ? type.name : ''));
      }
      if (i === active) item.classList.add('active');
      item.addEventListener('mousedown', (e) => { e.preventDefault(); active = i; choose(); });
      list.append(item);
    });
    list.classList.toggle('hidden', options.length === 0);
  };

  const choose = async () => {
    const o = options[active];
    if (!o) return;
    try {
      let id;
      if (o.kind === 'tag') id = o.tag.id;
      else id = (await createTag(o.name, typeSel.value)).id;
      input.value = '';
      close();
      await onPick(id);
    } catch (e) {
      toastError(e);
    }
  };

  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(close, 120));
  typeSel.addEventListener('change', render);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, options.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options.length) choose(); }
    else if (e.key === 'Escape') { if (!list.classList.contains('hidden')) { e.stopPropagation(); close(); } else input.blur(); }
  });

  return { element: row, refreshTypes: fillTypes, focus: () => input.focus() };
}

// ---------- タグ管理 dialog ----------
const TM_DRAG = 'application/x-km-tag';
const collapsed = new Set(); // tag ids collapsed in the manager (session only)

export function openTagManager() {
  const root = el('div', { class: 'tm' });
  let filter = '';

  const typeCol = el('div');
  const tagCol = el('div');
  root.append(typeCol, tagCol);

  const run = async (fn) => {
    try {
      const lib = await fn();
      if (lib) setLib(lib);
      emit('tags-structure-changed');
    } catch (e) {
      toastError(e);
    }
    render();
  };

  function renderTypes() {
    typeCol.innerHTML = '';
    typeCol.append(el('h3', {}, 'タグの種類'));
    const list = el('div', { class: 'tm-list' });
    for (const t of state.lib.tagTypes) {
      const name = el('input', { class: 'input name', value: t.name, spellcheck: 'false' });
      name.addEventListener('change', () => run(() => api.updateTagType(t.id, { name: name.value })));
      const color = el('input', { type: 'color', value: t.color });
      color.addEventListener('change', () => run(() => api.updateTagType(t.id, { color: color.value })));
      const count = state.lib.tags.filter((x) => x.typeId === t.id).length;
      const del = el('button', { class: 'btn small danger', title: '種類を削除', disabled: state.lib.tagTypes.length <= 1 }, '削除');
      del.addEventListener('click', async () => {
        const others = state.lib.tagTypes.filter((x) => x.id !== t.id);
        const ok = await confirmDialog(
          count ? `種類「${t.name}」を削除します。\nこの種類の ${count} 個のタグは（階層ごと）「${others[0].name}」に移されます。` : `種類「${t.name}」を削除します。`,
          { okLabel: '削除', danger: true },
        );
        if (ok) run(() => api.deleteTagType(t.id, others[0].id));
      });
      list.append(el('div', { class: 'tm-row' }, color, name, el('span', { class: 'count' }, `${count}個`), del));
    }
    typeCol.append(list);
    const newName = el('input', { class: 'input', placeholder: '新しい種類の名前', spellcheck: 'false' });
    const newColor = el('input', { type: 'color', value: randomColor() });
    const add = el('button', { class: 'btn' }, '追加');
    const doAdd = () => {
      if (!newName.value.trim()) return;
      run(() => api.addTagType({ name: newName.value, color: newColor.value }));
    };
    add.addEventListener('click', doAdd);
    newName.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); doAdd(); } });
    typeCol.append(el('div', { class: 'tm-add' }, newColor, newName, add));
  }

  /** Drop target handling: `targetTypeId` + `parentId` (null = root of that type). */
  const dropHandlers = (node, targetTypeId, parentId) => {
    const allowed = (id) => {
      const t = tagById(id);
      return t && t.typeId === targetTypeId && !wouldCycle(state.lib.tags, id, parentId) && (t.parentId || null) !== parentId;
    };
    node.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(TM_DRAG)) return;
      e.preventDefault();
      const id = dragId;
      const ok = id && allowed(id);
      e.dataTransfer.dropEffect = ok ? 'move' : 'none';
      node.classList.toggle('tm-drop', !!ok);
      node.classList.toggle('tm-drop-bad', !ok);
    });
    node.addEventListener('dragleave', (e) => {
      if (!node.contains(e.relatedTarget)) node.classList.remove('tm-drop', 'tm-drop-bad');
    });
    node.addEventListener('drop', (e) => {
      node.classList.remove('tm-drop', 'tm-drop-bad');
      if (!e.dataTransfer.types.includes(TM_DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      const id = e.dataTransfer.getData(TM_DRAG);
      if (!allowed(id)) {
        const t = tagById(id);
        if (t && t.typeId !== targetTypeId) toast('別の種類のカテゴリの下には移動できません。', 'error');
        return;
      }
      run(() => api.updateTag(id, { parentId }));
    });
  };
  let dragId = null;

  function renderTags() {
    tagCol.innerHTML = '';
    tagCol.append(el('h3', {}, `タグ（${state.lib.tags.length}）`));
    const f = el('input', { class: 'input tm-filter', placeholder: 'タグを絞り込み（パスでも検索）', value: filter, spellcheck: 'false' });
    f.addEventListener('input', () => { filter = f.value; renderTagList(); });
    tagCol.append(f, el('div', { class: 'muted small tm-hint' }, 'ドラッグで親カテゴリを変更（同じ種類の中だけ）。種類の見出しへドロップするとルートへ移動します。'));
    const list = el('div', { class: 'tm-list tm-tree' });
    tagCol.append(list);

    function renderTagList() {
      list.innerHTML = '';
      const q = filter.trim().toLowerCase();
      const tags = state.lib.tags;
      if (!tags.length) {
        list.append(el('div', { class: 'muted small' }, 'タグはまだありません。インスペクタから画像にタグを追加すると作成されます。'));
        return;
      }
      // with a filter: matching tags plus their ancestors (for context)
      let visible = null;
      if (q) {
        visible = new Set();
        for (const t of tags) {
          if (!tagPath(t.id).toLowerCase().includes(q)) continue;
          visible.add(t.id);
          let p = t.parentId && tagById(t.parentId);
          while (p && !visible.has(p.id)) { visible.add(p.id); p = p.parentId && tagById(p.parentId); }
        }
      }
      for (const type of state.lib.tagTypes) {
        const head = el('div', { class: 'tm-type-head', title: 'ここへドロップするとルートへ移動' },
          el('span', { class: 'dot', style: { background: type.color } }), type.name);
        dropHandlers(head, type.id, null);
        list.append(head);
        const rows = flattenTree(tags, type.id);
        let hiddenDepth = Infinity;
        let shown = 0;
        for (const n of rows) {
          if (n.depth > hiddenDepth) continue;
          hiddenDepth = Infinity;
          if (visible && !visible.has(n.tag.id)) continue;
          if (!q && collapsed.has(n.tag.id)) hiddenDepth = n.depth;
          list.append(tagRow(n));
          shown++;
        }
        if (!shown) list.append(el('div', { class: 'muted small tm-empty-type' }, q ? '該当なし' : '（タグなし）'));
      }
    }

    function tagRow(n) {
      const t = n.tag;
      const caret = el('button', { class: `tm-caret${n.hasChildren ? '' : ' leaf'}`, title: '折りたたむ／展開' }, collapsed.has(t.id) ? '▶' : '▼');
      caret.addEventListener('click', () => {
        if (collapsed.has(t.id)) collapsed.delete(t.id); else collapsed.add(t.id);
        renderTagList();
      });
      const grip = el('span', { class: 'tm-grip', title: 'ドラッグで親カテゴリを変更' }, '⋮⋮');
      const name = el('input', { class: 'input name', value: t.name, spellcheck: 'false', title: tagPath(t.id) });
      name.addEventListener('change', () => run(() => api.updateTag(t.id, { name: name.value })));
      const parentSel = el('select', { class: 'input tm-parent', title: '親カテゴリ' });
      const banned = new Set([t.id, ...descendantsOf(state.lib.tags, t.id)]);
      fillTagSelect(parentSel, { blank: '（ルート）', exclude: banned, typeId: t.typeId, value: t.parentId || '' });
      if (!t.parentId) parentSel.value = '';
      parentSel.addEventListener('change', () => run(() => api.updateTag(t.id, { parentId: parentSel.value || null })));
      const typeSel = el('select', { class: 'input tm-type', title: '種類（子カテゴリごと移動）' });
      for (const ty of state.lib.tagTypes) typeSel.append(el('option', { value: ty.id, selected: ty.id === t.typeId }, ty.name));
      typeSel.addEventListener('change', () => run(() => api.updateTag(t.id, { typeId: typeSel.value })));
      const addChild = el('button', { class: 'btn small tm-add-child', title: '子カテゴリを追加' }, '＋子');
      addChild.addEventListener('click', async () => {
        const v = await promptDialog({ title: `「${tagPath(t.id)}」に子カテゴリを追加`, value: '', okLabel: '追加', validate: (s) => (s.trim() ? null : '名前を入力してください。') });
        if (v) {
          collapsed.delete(t.id);
          run(async () => (await api.addTag({ name: v.trim(), parentId: t.id })).lib);
        }
      });
      const toRoot = el('button', { class: 'btn small subtle tm-to-root', title: 'ルートへ移動', disabled: !t.parentId }, 'ルートへ');
      toRoot.addEventListener('click', () => run(() => api.updateTag(t.id, { parentId: null })));
      const merge = el('button', { class: 'btn small', title: '他のタグに統合' }, '統合');
      merge.addEventListener('click', () => mergeDialog(t));
      const del = el('button', { class: 'btn small danger', title: 'タグを削除（画像ファイルは変更されません）' }, '削除');
      del.addEventListener('click', async () => {
        const n2 = state.lib.usage[t.id] || 0;
        const kids = state.lib.tags.filter((x) => x.parentId === t.id).length;
        const parent = t.parentId ? tagById(t.parentId) : null;
        const ok = await confirmDialog(
          `タグ「${tagPath(t.id)}」を削除します。`
          + (n2 ? `\n${n2} 枚の画像からこのタグが外れます。` : '')
          + (kids ? `\n子カテゴリ ${kids} 件は${parent ? `「${parent.name}」の下` : 'ルート'}へ移動します。` : '')
          + '\n画像ファイル自体は変更されません。',
          { okLabel: '削除', danger: true },
        );
        if (ok) run(() => api.deleteTag(t.id));
      });
      const dot = el('span', { class: 'dot', style: { width: '9px', height: '9px', borderRadius: '50%', flex: 'none', background: tagColor(t) } });
      const row = el('div', {
        class: 'tm-row tm-tag-row', draggable: 'true', dataset: { tag: t.id, depth: String(n.depth) },
        style: { paddingLeft: `${n.depth * 18}px` },
      }, caret, grip, dot, name, parentSel, typeSel, el('span', { class: 'count tm-usage' }, usageLabel(t.id)), addChild, toRoot, merge, del);
      row.addEventListener('dragstart', (e) => {
        if (e.target.closest('input, select, button')) { e.preventDefault(); return; }
        dragId = t.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(TM_DRAG, t.id);
      });
      row.addEventListener('dragend', () => { dragId = null; });
      dropHandlers(row, t.typeId, t.id);
      return row;
    }
    renderTagList();
  }

  async function mergeDialog(src) {
    const sel = el('select', { class: 'input wide' });
    fillTagSelect(sel, { exclude: new Set([src.id]) });
    if (!sel.options.length) { toast('統合先のタグがありません。'); return; }
    const kids = state.lib.tags.filter((x) => x.parentId === src.id).length;
    const target = await openModal({
      title: `「${tagPath(src.id)}」を統合`,
      body: el('div', {}, el('div', { class: 'note', style: { marginTop: 0, marginBottom: '6px' } }, '統合先のタグ:'), sel,
        el('div', { class: 'note' }, `「${src.name}」が付いた画像には統合先のタグが付き、「${src.name}」は削除されます。${kids ? `子カテゴリ ${kids} 件は統合先の下へ移動します。` : ''}`)),
      buttons: [{ label: 'キャンセル', value: null }, { label: '統合', primary: true, onClick: (close) => close(sel.value) }],
      onEnter: (close) => close(sel.value),
    });
    if (target) run(() => api.mergeTag(src.id, target));
  }

  function render() {
    renderTypes();
    renderTags();
  }
  render();

  return openModal({ title: 'タグ管理', body: root, buttons: [{ label: '閉じる', value: true, primary: true }], wide: true });
}

function randomColor() {
  const h = Math.floor(Math.random() * 360);
  // HSL → hex, muted
  const s = 0.45;
  const l = 0.62;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export { tagById };
