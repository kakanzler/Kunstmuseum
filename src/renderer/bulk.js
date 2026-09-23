// カテゴリ一括編集 (Alt+Shift+C): add / remove categories on every image of a
// folder in one batch, with a one-step 元に戻す. Metadata only — image files
// are never touched.
import { api, state, setLib, applyImageTags, tagColor } from './state.js';
import { el, openModal, toast, toastError } from './ui.js';
import { fillTagSelect, tagPath } from './tags.js';
import { flattenTree, directCounts, stateOf, nextAction, planFromActions } from './tag-tree.js';

let current = null;

/** For the smoke test. */
export function bulkEditorState() {
  return current;
}

const ACTION_LABEL = { add: '付与', remove: '削除' };

/**
 * @param {{folder:string, includeSub?:boolean}} target
 */
export async function openBulkEditor({ folder, includeSub = true }) {
  if (current) return;
  const st = {
    folder,
    includeSub: includeSub !== false,
    items: [],
    tagMap: {},
    actions: new Map(), // tagId → 'add' | 'remove'
    filter: '',
    loading: true,
  };
  current = st;

  const pathEl = el('code', { class: 'bulk-folder' }, folder);
  const subCb = el('input', { type: 'checkbox', class: 'bulk-include' });
  subCb.checked = st.includeSub;
  const countEl = el('span', { class: 'bulk-count muted' }, '読み込み中…');
  const filterEl = el('input', { class: 'input bulk-filter', placeholder: 'カテゴリを絞り込み', spellcheck: 'false' });
  const table = el('div', { class: 'bulk-table' });
  const summary = el('div', { class: 'bulk-summary' });

  // inline new category
  const newName = el('input', { class: 'input bulk-new-name', placeholder: '新しいカテゴリ名', spellcheck: 'false', dataset: { localEnter: '1' } });
  const newType = el('select', { class: 'input bulk-new-type', title: '種類' });
  for (const t of state.lib.tagTypes) newType.append(el('option', { value: t.id }, t.name));
  const newParent = el('select', { class: 'input bulk-new-parent', title: '親カテゴリ' });
  const fillParents = () => fillTagSelect(newParent, { blank: '（ルート）', typeId: newType.value });
  fillParents();
  newType.addEventListener('change', fillParents);
  const newBtn = el('button', { class: 'btn small bulk-new-btn' }, '作成して付与');

  const load = async () => {
    st.loading = true;
    countEl.textContent = '読み込み中…';
    try {
      st.items = await api.scan(st.folder, st.includeSub);
    } catch (e) {
      toastError(e, 'フォルダを読み込めませんでした。');
      st.items = [];
    }
    st.tagMap = Object.fromEntries(st.items.map((it) => [it.path, it.tags || []]));
    st.loading = false;
    countEl.textContent = `対象 ${st.items.length} 枚`;
    render();
  };

  const render = () => {
    const paths = st.items.map((it) => it.path);
    const counts = directCounts(paths, st.tagMap); // direct assignments only
    const total = paths.length;
    const q = st.filter.trim().toLowerCase();
    const rows = [];
    for (const type of state.lib.tagTypes) {
      const flat = flattenTree(state.lib.tags, type.id).filter((n) => !q || tagPath(n.tag.id).toLowerCase().includes(q));
      if (!flat.length) continue;
      rows.push(el('div', { class: 'bulk-type' }, el('span', { class: 'dot', style: { background: type.color } }), type.name));
      for (const n of flat) {
        const t = n.tag;
        const c = counts.get(t.id) || 0;
        const s = stateOf(c, total);
        const stateText = s === 'all' ? 'すべて' : s === 'some' ? `一部 ${c} 件` : 'なし';
        const action = st.actions.get(t.id) || null;
        const btn = el('button', {
          class: `btn small bulk-action${action ? ` ${action}` : ''}`,
          title: 'クリックで 付与 → 削除 → 変更なし',
        }, action ? ACTION_LABEL[action] : '変更なし');
        btn.addEventListener('click', () => {
          const next = nextAction(st.actions.get(t.id) || null);
          if (next) st.actions.set(t.id, next); else st.actions.delete(t.id);
          render();
        });
        rows.push(el('div', { class: `bulk-row${action ? ` ${action}` : ''}`, dataset: { tag: t.id } },
          el('span', { class: 'bulk-name', style: { paddingLeft: `${n.depth * 18}px` }, title: tagPath(t.id) },
            el('span', { class: 'dot', style: { background: tagColor(t) } }), t.name),
          el('span', { class: `bulk-state ${s}` }, stateText),
          btn));
      }
    }
    if (!rows.length) rows.push(el('div', { class: 'muted small' }, state.lib.tags.length ? '該当するカテゴリがありません' : 'カテゴリはまだありません。下の欄で作成できます。'));
    table.replaceChildren(...rows);
    const plan = planFromActions(st.actions);
    summary.textContent = `付与 ${plan.add.length} 件・削除 ${plan.remove.length} 件 → 対象 ${total} 枚`;
    if (applyBtn) applyBtn.disabled = st.loading || !total || (!plan.add.length && !plan.remove.length);
  };

  subCb.addEventListener('change', () => { st.includeSub = subCb.checked; load(); });
  filterEl.addEventListener('input', () => { st.filter = filterEl.value; render(); });

  const createCategory = async () => {
    const name = newName.value.trim();
    if (!name) return;
    try {
      const r = await api.addTag({ name, typeId: newType.value, parentId: newParent.value || null });
      setLib(r.lib);
      st.actions.set(r.tag.id, 'add');
      newName.value = '';
      fillParents();
      render();
    } catch (e) {
      toastError(e);
    }
  };
  newBtn.addEventListener('click', createCategory);
  newName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); createCategory(); }
  });

  const apply = async (close) => {
    const plan = planFromActions(st.actions);
    const paths = st.items.map((it) => it.path);
    if (!paths.length || (!plan.add.length && !plan.remove.length)) return;
    let r;
    try {
      r = await api.bulkApplyTags(paths, plan.add, plan.remove);
    } catch (e) {
      toastError(e, '一括編集を適用できませんでした。');
      return;
    }
    close(true);
    setLib(r.lib);
    applyImageTags(r.tags);
    const before = r.before;
    toast(`${paths.length} 枚に適用しました（付与 ${plan.add.length} 件・削除 ${plan.remove.length} 件）`, 'success', 12000, [{
      label: '元に戻す',
      onClick: async () => {
        const u = await api.restoreTags(before);
        setLib(u.lib);
        applyImageTags(u.tags);
        toast('一括編集を元に戻しました。', 'success');
      },
    }]);
  };

  let applyBtn = null;
  const body = el('div', { class: 'bulk-dialog' },
    el('div', { class: 'bulk-head' },
      el('div', {}, el('span', { class: 'muted' }, 'フォルダ: '), pathEl),
      el('div', { class: 'bulk-head-row' }, el('label', { class: 'toggle' }, subCb, 'サブフォルダを含む'), countEl)),
    el('div', { class: 'note' }, '付与／削除は対象の全画像に適用されます。状態は各カテゴリが直接付いている枚数です（画像ファイルは変更しません）。'),
    filterEl,
    table,
    el('div', { class: 'bulk-new' }, newName, newType, newParent, newBtn),
    summary);

  const p = openModal({
    title: 'カテゴリ一括編集',
    body,
    buttons: [
      { label: 'キャンセル', value: false },
      { label: '適用', primary: true, onClick: apply },
    ],
    onEnter: apply,
    wide: true,
    className: 'bulk-modal',
  });
  applyBtn = [...document.querySelectorAll('.modal.bulk-modal .modal-foot .btn.primary')].pop() || null;
  st.applyButton = applyBtn;
  render();
  load();
  try {
    await p;
  } finally {
    current = null;
  }
}

