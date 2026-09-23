// 設定 modal: ホットキー (editable keymap), 操作説明, 一般.
import { api, state, saveSettings, on } from './state.js';
import { el, openModal, toastError } from './ui.js';
import { COMMANDS, commandById, eventToCombo, validateCombo, setBinding, resetBinding, resolveBindings, displayCombo } from './keymap.js';
import { bindings, applyBindings, keyLabel } from './commands.js';
import { DEFAULT_THUMB } from './gallery.js';

let current = null; // { close, capture }

export function isSettingsOpen() {
  return !!current;
}

/** Ctrl+, : open, or close when already open. */
export function toggleSettings(ctx) {
  if (current) current.close(true);
  else openSettings(ctx);
}

/** For the smoke test: is a key capture in progress? */
export function isCapturing() {
  return !!(current && current.capture);
}

export function openSettings(ctx = {}, section = 'hotkeys') {
  if (current) return Promise.resolve();
  const sections = [
    { id: 'hotkeys', label: 'ホットキー', build: () => hotkeysPanel() },
    { id: 'guide', label: '操作説明', build: () => guidePanel() },
    { id: 'general', label: '一般', build: () => generalPanel(ctx) },
  ];
  const nav = el('div', { class: 'settings-nav' });
  const panel = el('div', { class: 'settings-panel' });
  let active = section;
  const show = (id) => {
    active = id;
    for (const b of nav.children) b.classList.toggle('active', b.dataset.section === id);
    panel.replaceChildren(sections.find((s) => s.id === id).build());
  };
  for (const s of sections) {
    nav.append(el('button', { class: 'settings-nav-item', dataset: { section: s.id }, onclick: () => { cancelCapture(); show(s.id); } }, s.label));
  }
  const root = el('div', { class: 'settings-dialog' }, nav, panel);

  // key capture for rebinding: runs before the modal's own Esc handling
  const onCaptureKey = (e) => {
    const cap = current && current.capture;
    if (!cap) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { cancelCapture(); return; }
    const combo = eventToCombo(e);
    if (!combo) return; // modifier only: keep waiting
    current.capture = null;
    cap.done(combo);
  };
  window.addEventListener('keydown', onCaptureKey, true);
  const offKeymap = on('keymap-changed', () => { if (active === 'guide') show('guide'); });

  const p = openModal({
    title: '設定',
    body: (close) => {
      current = { close, capture: null };
      show(section);
      return root;
    },
    buttons: [{ label: '閉じる', value: true, primary: true }],
    wide: true,
    className: 'settings-modal', // fixed size: switching sections never resizes the dialog
  });
  return p.finally(() => {
    window.removeEventListener('keydown', onCaptureKey, true);
    offKeymap();
    current = null;
  });
}

function cancelCapture() {
  if (current && current.capture) {
    const cap = current.capture;
    current.capture = null;
    cap.cancel();
  }
}

// ---------------------------------------------------------------- ホットキー
function hotkeysPanel() {
  const msg = el('div', { class: 'kb-msg' });
  const tbody = el('tbody');
  const setMsg = (text, kind = 'info', extra = []) => {
    msg.className = `kb-msg ${kind}`;
    msg.replaceChildren(el('span', {}, text), ...extra);
  };

  const commit = (r, id) => {
    applyBindings(r.bindings);
    const c = commandById(id);
    setMsg(r.swappedWith
      ? `「${c.label}」と「${commandById(r.swappedWith).label}」のショートカットを入れ替えました。`
      : `「${c.label}」を ${keyLabel(id)} に設定しました。`, 'ok');
    render();
  };

  /** Try to bind; on conflict ask to swap. */
  const attempt = (id, combo, resetting = false) => {
    const r = resetting ? resetBinding(bindings(), id) : setBinding(bindings(), id, combo);
    if (!r.conflict) { commit(r, id); return; }
    const other = commandById(r.conflict);
    setMsg(`${other.label} と重複しています。入れ替えますか？`, 'warn', [
      el('button', {
        class: 'btn small primary kb-swap',
        onclick: () => commit(resetting ? resetBinding(bindings(), id, { swap: true }) : setBinding(bindings(), id, combo, { swap: true }), id),
      }, '入れ替える'),
      el('button', { class: 'btn small kb-swap-cancel', onclick: () => { setMsg(''); render(); } }, 'キャンセル'),
    ]);
  };

  const render = () => {
    const b = bindings();
    tbody.replaceChildren(...COMMANDS.map((c) => {
      const combo = b.get(c.id);
      const keyCell = el('td', { class: 'kb-key' }, el('kbd', {}, displayCombo(combo) || '未設定'));
      const change = el('button', { class: 'btn small kb-change' }, '変更');
      const reset = el('button', { class: 'btn small subtle kb-reset', disabled: combo === c.default, title: `既定: ${displayCombo(c.default)}` }, '既定に戻す');
      change.addEventListener('click', () => {
        cancelCapture();
        setMsg('');
        keyCell.replaceChildren(el('span', { class: 'kb-capture' }, 'キーを押してください… (Escでキャンセル)'));
        change.disabled = true;
        current.capture = {
          id: c.id,
          cancel: () => { setMsg('変更をキャンセルしました。'); render(); },
          done: (newCombo) => {
            const err = validateCombo(newCombo);
            if (err) { setMsg(err, 'error'); render(); return; }
            attempt(c.id, newCombo);
            if (msg.classList.contains('warn')) render();
          },
        };
      });
      reset.addEventListener('click', () => { cancelCapture(); attempt(c.id, c.default, true); if (msg.classList.contains('warn')) render(); });
      return el('tr', { dataset: { command: c.id } },
        el('td', {}, el('span', { class: 'muted small kb-cat' }, c.category), c.label), keyCell, el('td', {}, change), el('td', {}, reset));
    }));
  };
  render();

  const resetAll = el('button', { class: 'btn kb-reset-all' }, 'すべて既定に戻す');
  resetAll.addEventListener('click', () => {
    cancelCapture();
    applyBindings(resolveBindings({}));
    setMsg('すべてのショートカットを既定に戻しました。', 'ok');
    render();
  });

  return el('div', {},
    el('h3', {}, 'ホットキー（変更できます）'),
    el('div', { class: 'note' }, 'Ctrl または Alt を含む組み合わせ（F1〜F12 は単独可）を割り当てられます。変更はすぐに反映され、保存されます。'),
    msg,
    el('table', { class: 'kb-table' },
      el('thead', {}, el('tr', {}, el('th', {}, '操作'), el('th', {}, 'ショートカット'), el('th', {}, '変更'), el('th', {}, '既定に戻す'))),
      tbody),
    el('div', { class: 'kb-actions' }, resetAll),
    el('h3', {}, '場面ごとのキー（固定）'),
    fixedTable([
      ['ビューア（Preview／画像タブ）', '← / →', '前 / 次の画像'],
      ['', '1 / 0', '等倍 / 画面に合わせる'],
      ['', 'ダブルクリック', '等倍 ⇔ 画面に合わせる'],
      ['', keyLabel('edit.rename'), '名前の変更（ホットキー「名前の変更」）'],
      ['スクリーン表示', 'Esc', '終了'],
      ['', '← / →', '前 / 次の画像'],
      ['', 'Space', '一時停止 / 再開'],
      ['サイドバーのツリー', '↑ / ↓', '移動（Shift でファイルを範囲選択）'],
      ['', '← / →', '折りたたむ・親へ / 展開・子へ'],
      ['', 'Enter', 'ファイルは画像タブで開く、フォルダはギャラリーで表示'],
      ['検索パレット（' + keyLabel('search.quickOpen') + '）', '↑ / ↓', '結果の移動（Preview とインスペクタに表示）'],
      ['', 'Enter', 'フォルダをギャラリーで開いて選択（先頭行ならギャラリーを絞り込み）'],
      ['', 'Ctrl+Enter', '画像タブで開く'],
      ['', 'Esc', '閉じる（選択を元に戻す）'],
      ['カテゴリ一括編集（' + keyLabel('tags.bulkFolder') + '）', 'クリック', '変更なし → 付与 → 削除 を切り替え'],
      ['', 'Enter / Esc', '適用 / キャンセル'],
      ['ギャラリー', '矢印キー', '選択の移動（Shift で範囲）'],
      ['', 'Enter', '画像タブで開く'],
      ['', 'Ctrl+クリック / Shift+クリック', '追加選択 / 範囲選択'],
      ['', 'Esc', '選択解除'],
    ]),
    el('h3', {}, 'マウス（固定）'),
    fixedTable([
      ['Ctrl+ホイール', 'カーソルの下のペインを拡大・縮小（ギャラリーはサムネイルサイズ）'],
      ['中ボタン（ホイールクリック）', '表示サイズを戻す（ギャラリー・ビューア・グラフ）／タブを閉じる（タブ上）'],
      ['ドラッグ', 'ビューアで表示位置の移動、タブの並べ替え・分割、画像をフォルダやギャラリーへ移動'],
      ['ダブルクリック', 'ギャラリー・ツリー・グラフの画像を画像タブで開く'],
    ], true));
}

function fixedTable(rows, twoCols = false) {
  return el('table', { class: 'kb-table fixed' },
    el('tbody', {}, ...rows.map((r) => el('tr', {},
      ...(twoCols ? [el('td', {}, el('kbd', {}, r[0])), el('td', {}, r[1])] : [el('td', { class: 'muted' }, r[0]), el('td', {}, el('kbd', {}, r[1])), el('td', {}, r[2])])))));
}

// ---------------------------------------------------------------- 操作説明
function guidePanel() {
  const k = (id) => el('kbd', {}, keyLabel(id));
  const sec = (title, ...items) => el('section', { class: 'guide-sec' }, el('h3', {}, title), el('ul', {}, ...items.map((i) => el('li', {}, ...[].concat(i)))));
  return el('div', { class: 'guide' },
    sec('フォルダ登録',
      '「＋ フォルダを追加」またはエクスプローラーからサイドバーへのドロップで画像フォルダを登録します。',
      '一覧から外してもディスク上のファイルは変更されません。'),
    sec('ギャラリー / Preview / 画像タブ / 分割',
      'サイドバーでフォルダを選ぶとギャラリーに表示されます。画像を選ぶと Preview タブに表示されます。',
      ['ダブルクリックまたは Enter で画像タブを開きます。', k('preview.showRight'), ' で Preview、', k('graph.showRight'), ' で知識グラフをアクティブなグループの右隣に表示します。'],
      ['タブはドラッグで並べ替え・分割できます（最大 4 グループ）。', k('tab.splitRight'), ' で右に分割、', k('tab.close'), ' で閉じます。']),
    sec('タグ・カテゴリ',
      '右側のインスペクタで選択中の画像にタグを追加・削除します。タグには「カテゴリ」「ジャンル」などの種類があります。',
      '「タグ管理」で種類とタグの名前・色の変更、統合、削除ができます（画像ファイルは変更されません）。'),
    sec('検索',
      [k('search.quickOpen'), ' で、登録したすべてのフォルダからファイル名で検索します（部分一致・あいまい一致、スペース区切りで AND、「/」を含めるとフォルダ名も対象）。'],
      '↑↓ で選ぶと Preview に表示、Enter でそのフォルダをギャラリーで開いて選択、Ctrl+Enter で画像タブ、Esc で閉じます。先頭行を選ぶと表示中のギャラリーをその文字で絞り込みます。'),
    sec('カテゴリ一括編集',
      [k('tags.bulkFolder'), ' またはフォルダの右クリックで、そのフォルダ（サブフォルダを含めることも可）の全画像にカテゴリをまとめて付与・削除します。'],
      '各カテゴリをクリックして「付与」「削除」「変更なし」を選び、「適用」で反映します。直後のトーストの「元に戻す」で取り消せます。画像ファイルは変更しません。'),
    sec('カテゴリの階層',
      '「タグ管理」でカテゴリを親子にできます（例: 動物 > 犬 > 柴犬）。行をドラッグするか「親カテゴリ」を選び、「＋子」で子カテゴリを追加します。',
      '親カテゴリで絞り込むと、子孫カテゴリが付いた画像も表示されます（子を付けても親は自動では付きません）。知識グラフでは「階層をまとめる」で子を親の枠内に表示します。'),
    sec('知識グラフ',
      'タグと画像の関係をグラフで表示します。ノードをクリックすると関連が強調され、タグをダブルクリックするとそのタグでギャラリーを絞り込みます。'),
    sec('名前の変更・移動',
      ['ギャラリーやツリーで ', k('edit.rename'), ' を押すと名前を変更できます。サムネイルやファイルをフォルダ・ギャラリーへドラッグすると移動します。'],
      '同名のファイルがある場合は上書きせずにスキップします（ファイルを上書き・削除することはありません）。タグは新しい場所に引き継がれます。'),
    sec('スクリーン表示',
      [k('screen.open'), ' で対象（フォルダまたはカテゴリ）・切り替え秒数・順番を選んで全画面のスライドショーを開始します。Esc で終了、←/→ で前後、Space で一時停止。']),
    sec('データ保存場所',
      'タグ・登録フォルダ・レイアウト・設定は %APPDATA%\\Kunstmuseum\\library.json に保存されます（「一般」で場所を確認・表示できます）。'));
}

// ---------------------------------------------------------------- 一般
function generalPanel(ctx) {
  const s = state.settings;
  const showFiles = el('input', { type: 'checkbox', class: 'gen-show-files' });
  showFiles.checked = s.showFiles !== false;
  showFiles.addEventListener('change', () => (ctx.setShowFiles ? ctx.setShowFiles(showFiles.checked) : saveSettings({ showFiles: showFiles.checked })));

  const thumb = el('input', { type: 'number', class: 'input gen-thumb', min: '80', max: '400', step: '8', value: String(s.thumbSize || DEFAULT_THUMB) });
  thumb.addEventListener('change', () => {
    const v = Math.max(80, Math.min(400, Math.round(Number(thumb.value) || DEFAULT_THUMB)));
    thumb.value = String(v);
    saveSettings({ thumbSize: v });
  });

  const interval = el('input', { type: 'number', class: 'input gen-interval', min: '1', max: '3600', step: '0.5', value: String((s.screen && s.screen.interval) || 5) });
  interval.addEventListener('change', () => {
    const v = Math.max(1, Math.min(3600, Number(interval.value) || 5));
    interval.value = String(v);
    saveSettings({ screen: { ...(state.settings.screen || {}), interval: v } });
  });

  const dataPath = el('code', { class: 'gen-path' }, '…');
  const version = el('span', { class: 'gen-version' }, '…');
  api.appPaths().then((p) => {
    dataPath.textContent = p.userData;
    version.textContent = p.version;
  }).catch((e) => toastError(e));
  const openBtn = el('button', { class: 'btn small', onclick: () => api.openUserData().catch((e) => toastError(e)) }, 'フォルダを開く');

  const row = (label, ...ctrl) => el('div', { class: 'gen-row' }, el('div', { class: 'gen-label' }, label), el('div', { class: 'gen-ctrl' }, ...ctrl));
  return el('div', { class: 'general' },
    el('h3', {}, '表示'),
    row('サイドバー', el('label', { class: 'toggle' }, showFiles, 'サイドバーにファイルを表示')),
    row('既定のサムネイルサイズ', thumb, el('span', { class: 'muted small' }, 'px（新しいギャラリータブに適用。既定 160）')),
    row('スクリーン表示の既定秒数', interval, el('span', { class: 'muted small' }, '秒（1〜3600）')),
    el('h3', {}, 'データ'),
    row('データの保存場所', dataPath, openBtn),
    el('div', { class: 'note' }, 'タグ・登録フォルダ・レイアウト・設定はこのフォルダの library.json に保存されます。インストール・更新・アンインストールでは削除されません。'),
    el('h3', {}, 'バージョン'),
    row('Kunstmuseum', version));
}
