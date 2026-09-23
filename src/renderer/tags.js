// Tag chips, autocomplete input, tag operations and the タグ管理 dialog.
import { api, state, setLib, applyImageTags, tagById, typeById, tagColor, emit } from './state.js';
import { el, openModal, confirmDialog, toastError, toast, collator } from './ui.js';

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

export async function createTag(name, typeId) {
  const r = await api.addTag({ name, typeId });
  setLib(r.lib);
  return r.tag;
}

// ---------- chips ----------
export function tagChip(tag, { onRemove, partial = false, onClick, title } = {}) {
  const type = typeById(tag.typeId);
  const chip = el('span', {
    class: `chip${partial ? ' partial' : ''}${onRemove ? '' : ' no-x'}`,
    title: title || `${type ? type.name : ''}: ${tag.name}`,
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
  return [...tags].sort((a, b) => (order.get(a.typeId) - order.get(b.typeId)) || collator.compare(a.name, b.name));
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
    const matches = sortedTags().filter((t) => !ex.has(t.id) && (!q || t.name.toLowerCase().includes(q)));
    matches.sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)));
    options = matches.slice(0, 30).map((t) => ({ kind: 'tag', tag: t }));
    const exact = q && state.lib.tags.some((t) => t.typeId === typeSel.value && t.name.toLowerCase() === q);
    if (q && !exact) options.push({ kind: 'new', name: input.value.trim() });
    active = Math.min(active, Math.max(0, options.length - 1));
    list.innerHTML = '';
    options.forEach((o, i) => {
      let item;
      if (o.kind === 'tag') {
        const type = typeById(o.tag.typeId);
        item = el('div', { class: 'ac-item' },
          el('span', { class: 'dot', style: { background: tagColor(o.tag) } }),
          el('span', {}, o.tag.name),
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
          count ? `種類「${t.name}」を削除します。\nこの種類の ${count} 個のタグは「${others[0].name}」に移されます。` : `種類「${t.name}」を削除します。`,
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

  function renderTags() {
    tagCol.innerHTML = '';
    tagCol.append(el('h3', {}, `タグ（${state.lib.tags.length}）`));
    const f = el('input', { class: 'input tm-filter', placeholder: 'タグを絞り込み', value: filter, spellcheck: 'false' });
    f.addEventListener('input', () => { filter = f.value; renderTagList(); });
    tagCol.append(f);
    const list = el('div', { class: 'tm-list' });
    tagCol.append(list);

    function renderTagList() {
      list.innerHTML = '';
      const q = filter.trim().toLowerCase();
      const tags = sortedTags().filter((t) => !q || t.name.toLowerCase().includes(q));
      if (!tags.length) list.append(el('div', { class: 'muted small' }, state.lib.tags.length ? '該当するタグがありません' : 'タグはまだありません。インスペクタから画像にタグを追加すると作成されます。'));
      for (const t of tags) {
        const name = el('input', { class: 'input name', value: t.name, spellcheck: 'false' });
        name.addEventListener('change', () => run(() => api.updateTag(t.id, { name: name.value })));
        const typeSel = el('select', { class: 'input', title: '種類' });
        for (const ty of state.lib.tagTypes) typeSel.append(el('option', { value: ty.id, selected: ty.id === t.typeId }, ty.name));
        typeSel.addEventListener('change', () => run(() => api.updateTag(t.id, { typeId: typeSel.value })));
        const merge = el('button', { class: 'btn small', title: '他のタグに統合' }, '統合');
        merge.addEventListener('click', () => mergeDialog(t));
        const del = el('button', { class: 'btn small danger', title: 'タグを削除（画像ファイルは変更されません）' }, '削除');
        del.addEventListener('click', async () => {
          const n = state.lib.usage[t.id] || 0;
          const ok = await confirmDialog(`タグ「${t.name}」を削除します。${n ? `\n${n} 枚の画像からこのタグが外れます。` : ''}\n画像ファイル自体は変更されません。`, { okLabel: '削除', danger: true });
          if (ok) run(() => api.deleteTag(t.id));
        });
        const dot = el('span', { class: 'dot', style: { width: '9px', height: '9px', borderRadius: '50%', flex: 'none', background: tagColor(t) } });
        list.append(el('div', { class: 'tm-row' }, dot, name, typeSel, el('span', { class: 'count' }, `${state.lib.usage[t.id] || 0}枚`), merge, del));
      }
    }
    renderTagList();
  }

  async function mergeDialog(src) {
    const sel = el('select', { class: 'input wide' });
    for (const t of sortedTags().filter((x) => x.id !== src.id)) {
      const ty = typeById(t.typeId);
      sel.append(el('option', { value: t.id }, `${t.name}（${ty ? ty.name : ''}）`));
    }
    if (!sel.options.length) { toast('統合先のタグがありません。'); return; }
    const target = await openModal({
      title: `「${src.name}」を統合`,
      body: el('div', {}, el('div', { class: 'note', style: { marginTop: 0, marginBottom: '6px' } }, '統合先のタグ:'), sel,
        el('div', { class: 'note' }, `「${src.name}」が付いた画像には統合先のタグが付き、「${src.name}」は削除されます。`)),
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
