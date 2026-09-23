'use strict';
// Node 24's `node --test test/` resolves the directory argument to this file
// (it does not expand directories). Load every *.test.js so that command runs
// the whole suite. `npm test` uses an explicit glob instead.
const fs = require('node:fs');
const path = require('node:path');

for (const f of fs.readdirSync(__dirname).sort()) {
  if (f.endsWith('.test.js')) require(path.join(__dirname, f));
}
