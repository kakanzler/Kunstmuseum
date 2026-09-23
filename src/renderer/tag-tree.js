// Tag hierarchy helpers (pure, DOM-free → unit-testable with node).
// A tag is {id, name, typeId, parentId|null}. All walks are cycle-safe.

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

function byIdMap(tags) {
  return new Map(tags.map((t) => [t.id, t]));
}

/** parentId (or null) → children sorted by name. */
export function childrenMap(tags) {
  const ids = new Set(tags.map((t) => t.id));
  const m = new Map();
  for (const t of tags) {
    const p = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    if (!m.has(p)) m.set(p, []);
    m.get(p).push(t);
  }
  for (const list of m.values()) list.sort((a, b) => collator.compare(a.name, b.name));
  return m;
}

/**
 * Nested tree [{tag, depth, children:[…]}] of the roots (optionally of one
 * type). Tags caught in a cycle are attached at the root once.
 */
export function buildTree(tags, typeId = null) {
  const list = typeId ? tags.filter((t) => t.typeId === typeId) : tags;
  const kids = childrenMap(list);
  const seen = new Set();
  const make = (tag, depth) => {
    seen.add(tag.id);
    const children = (kids.get(tag.id) || []).filter((c) => !seen.has(c.id)).map((c) => make(c, depth + 1));
    return { tag, depth, children };
  };
  const roots = (kids.get(null) || []).map((t) => make(t, 0));
  for (const t of list) if (!seen.has(t.id)) roots.push(make(t, 0)); // orphaned by a cycle
  return roots;
}

/** Pre-order flat list [{tag, depth}] (for indented selects / tables). */
export function flattenTree(tags, typeId = null) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      out.push({ tag: n.tag, depth: n.depth, hasChildren: n.children.length > 0 });
      walk(n.children);
    }
  };
  walk(buildTree(tags, typeId));
  return out;
}

/** Ids of all descendants of `id` (excluding itself). */
export function descendantsOf(tags, id) {
  const kids = childrenMap(tags);
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    for (const c of kids.get(stack.pop()) || []) {
      if (c.id === id || out.has(c.id)) continue;
      out.add(c.id);
      stack.push(c.id);
    }
  }
  return out;
}

/** Ancestors of `id`, root first (excluding itself). */
export function ancestorsOf(tags, id) {
  const m = byIdMap(tags);
  const out = [];
  const seen = new Set([id]);
  let cur = m.get(id);
  while (cur && cur.parentId && m.has(cur.parentId) && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = m.get(cur.parentId);
    out.unshift(cur);
  }
  return out;
}

/** "動物 > 犬 > 柴犬" */
export function pathLabel(tags, id, sep = ' > ') {
  const t = tags.find((x) => x.id === id);
  if (!t) return '';
  return [...ancestorsOf(tags, id).map((a) => a.name), t.name].join(sep);
}

/** ids plus all their descendants (filter semantics: a parent matches its subtree). */
export function expandWithDescendants(tags, ids) {
  const out = new Set(ids);
  for (const id of ids) for (const d of descendantsOf(tags, id)) out.add(d);
  return out;
}

/** Would making `parentId` the parent of `id` create a cycle (or self-parent)? */
export function wouldCycle(tags, id, parentId) {
  if (!parentId) return false;
  return parentId === id || descendantsOf(tags, id).has(parentId);
}

/**
 * Does an image with `imageTags` match every filter tag (AND)? A filter tag
 * matches the tag itself or any of its descendants.
 */
export function matchesFilter(tags, imageTags, filterIds) {
  if (!filterIds.length) return true;
  const have = new Set(imageTags || []);
  return filterIds.every((f) => have.has(f) || [...descendantsOf(tags, f)].some((d) => have.has(d)));
}

/** Pre-computed filter matcher (expands each filter tag once). */
export function filterMatcher(tags, filterIds) {
  const sets = filterIds.map((f) => expandWithDescendants(tags, [f]));
  return (imageTags) => {
    if (!sets.length) return true;
    const have = imageTags || [];
    return sets.every((set) => have.some((id) => set.has(id)));
  };
}

// ---------- カテゴリ一括編集 ----------
/**
 * Direct assignment counts per tag over `paths` ({path: tagIds} map):
 * Map tagId → count. State per tag: all (count === total), some, none.
 */
export function directCounts(paths, tagMap) {
  const counts = new Map();
  for (const p of paths) for (const id of new Set((tagMap && tagMap[p]) || [])) counts.set(id, (counts.get(id) || 0) + 1);
  return counts;
}

export function stateOf(count, total) {
  if (!count) return 'none';
  return count >= total ? 'all' : 'some';
}

/** 変更なし → 付与 → 削除 → 変更なし */
export function nextAction(action) {
  return action === 'add' ? 'remove' : action === 'remove' ? null : 'add';
}

/** {add:[ids], remove:[ids]} from a Map tagId → 'add' | 'remove'. */
export function planFromActions(actions) {
  const add = [];
  const remove = [];
  for (const [id, a] of actions) {
    if (a === 'add') add.push(id);
    else if (a === 'remove') remove.push(id);
  }
  return { add, remove };
}

/**
 * Pure model of a bulk apply over {path: tagIds}: returns the new map. Used to
 * preview / test; the store performs the same operation.
 */
export function applyPlan(tagMap, { add = [], remove = [] }) {
  const rm = new Set(remove);
  const out = {};
  for (const [p, ids] of Object.entries(tagMap)) {
    const next = (ids || []).filter((id) => !rm.has(id));
    for (const id of add) if (!rm.has(id) && !next.includes(id)) next.push(id);
    out[p] = next;
  }
  return out;
}
