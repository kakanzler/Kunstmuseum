// Slideshow playlist (pure, DOM-free → unit-testable with node).
// Order: natural name order or random; loop wraps around (a random order is
// reshuffled for every pass); without loop the list stops on the last item.

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

export function byName(a, b) {
  return collator.compare(a.name, b.name) || collator.compare(a.path, b.path);
}

/** Fisher–Yates shuffle (returns a new array). */
export function shuffle(list, random = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Playlist {
  /**
   * @param {Array<{path:string,name:string}>} items
   * @param {{order?:'name'|'random', loop?:boolean, random?:()=>number}} [opts]
   */
  constructor(items, { order = 'name', loop = true, random = Math.random } = {}) {
    this.random = random;
    this.shuffled = order === 'random';
    this.loop = !!loop;
    this.base = items.slice().sort(byName);
    this.order = this.shuffled ? shuffle(this.base, random) : this.base.slice();
    this.index = 0;
    this.pass = 0;
    this.upcoming = null; // pre-computed order of the next pass (random + loop)
  }

  get length() {
    return this.order.length;
  }

  get current() {
    return this.order[this.index] || null;
  }

  /** At the last item of a non-looping list. */
  get atEnd() {
    return !this.loop && this.index >= this.order.length - 1;
  }

  _nextPassOrder() {
    if (!this.shuffled) return this.order.slice();
    if (!this.upcoming) {
      let next = shuffle(this.base, this.random);
      // do not show the same image twice in a row across the pass boundary
      if (next.length > 1 && next[0] === this.order[this.order.length - 1]) {
        next = [...next.slice(1), next[0]];
      }
      this.upcoming = next;
    }
    return this.upcoming;
  }

  /** The item `next()` would show, without moving (for preloading). */
  peekNext() {
    if (!this.order.length) return null;
    if (this.index < this.order.length - 1) return this.order[this.index + 1];
    if (!this.loop) return null;
    return this._nextPassOrder()[0] || null;
  }

  /** Advance; returns the new current item, or null at the end without loop. */
  next() {
    if (!this.order.length) return null;
    if (this.index < this.order.length - 1) {
      this.index++;
      return this.current;
    }
    if (!this.loop) return null;
    this.order = this._nextPassOrder();
    this.upcoming = null;
    this.index = 0;
    this.pass++;
    return this.current;
  }

  /** Go back; wraps to the end of the current pass when looping. */
  prev() {
    if (!this.order.length) return null;
    if (this.index > 0) this.index--;
    else if (this.loop) this.index = this.order.length - 1;
    return this.current;
  }

  /** Drop an item (e.g. a missing/broken file); the current position moves to its successor. */
  remove(item) {
    const i = this.order.indexOf(item);
    this.base = this.base.filter((x) => x !== item);
    if (this.upcoming) this.upcoming = this.upcoming.filter((x) => x !== item);
    if (i < 0) return;
    this.order.splice(i, 1);
    if (i < this.index) this.index--;
    if (this.index >= this.order.length) this.index = this.loop ? 0 : Math.max(0, this.order.length - 1);
  }
}
