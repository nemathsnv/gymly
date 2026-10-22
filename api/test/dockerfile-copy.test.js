/* The api image carries only the files named on api/Dockerfile's COPY line (plus coach/). A
   root-level module that server.js imports and that line forgets is invisible to every test run
   from the source tree and shows up only when the published image boots — as
   ERR_MODULE_NOT_FOUND, on every instance that pulled it. So the line is checked here, for
   server.js's own imports and for whatever those modules import from the api root in turn. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(API, f), 'utf8');

// Every `./name.js` a file imports, statically or dynamically — root-level only; coach/ is
// copied as a whole directory.
const rootImports = src => [...src.matchAll(/(?:from\s+|import\s*\(\s*)['"]\.\/([^'"/]+\.js)['"]/g)].map(m => m[1]);

test('every root-level module server.js needs is on the Dockerfile COPY line', () => {
  const line = read('Dockerfile').split('\n').find(l => /^COPY\s+server\.js\b/.test(l));
  assert.ok(line, 'the COPY line that carries server.js');
  const copied = new Set(line.trim().split(/\s+/).slice(1, -1));

  const needed = new Set(['server.js']);
  const queue = ['server.js'];
  while (queue.length) {
    for (const dep of rootImports(read(queue.shift()))) {
      if (!needed.has(dep)) { needed.add(dep); queue.push(dep); }
    }
  }
  assert.ok(needed.has('media.js'), 'the walk finds the media store');
  const missing = [...needed].filter(f => !copied.has(f));
  assert.deepEqual(missing, [], `add ${missing.join(', ')} to the COPY line in api/Dockerfile`);
  for (const f of copied) assert.ok(fs.existsSync(path.join(API, f)), `${f} is copied but does not exist`);
});

// Directories server.js reaches into (`./coach/…`, `./mcp-remote/…`) are copied whole; each has to
// be on a COPY line, and whatever their modules import from the api root (`../durable.js`) has to
// be on the root COPY line too.
test('every directory server.js imports from is copied, with the root modules it needs', () => {
  const docker = read('Dockerfile');
  const rootLine = docker.split('\n').find(l => /^COPY\s+server\.js\b/.test(l));
  const copied = new Set(rootLine.trim().split(/\s+/).slice(1, -1));
  const dirs = new Set([...read('server.js').matchAll(/(?:from\s+|import\s*\(\s*)['"]\.\/([^'"/]+)\/[^'"]+['"]/g)].map(m => m[1]));
  assert.ok(dirs.has('mcp-remote'), 'the walk finds the hosted MCP modules');
  for (const d of dirs) {
    assert.match(docker, new RegExp(`^COPY\\s+${d}\\s+\\./${d}\\s*$`, 'm'), `COPY ${d} ./${d} is missing from api/Dockerfile`);
    for (const f of fs.readdirSync(path.join(API, d)).filter(x => x.endsWith('.js'))) {
      for (const m of read(path.join(d, f)).matchAll(/(?:from\s+|import\s*\(\s*)['"]\.\.\/([^'"/]+\.js)['"]/g)) {
        assert.ok(copied.has(m[1]), `${d}/${f} imports ../${m[1]}, which is not on the root COPY line`);
      }
    }
  }
});
