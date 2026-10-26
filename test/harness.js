// Node harness: instantiate triage.wasm, feed it real GitHub issue JSON, run queries.
const fs = require('fs');
(async () => {
  const { instance } = await WebAssembly.instantiate(
    fs.readFileSync(__dirname + '/../target/wasm32-unknown-unknown/release/triage.wasm'));
  const ex = instance.exports, mem = ex.memory;
  const call = (fn, obj) => {
    const enc = new TextEncoder().encode(JSON.stringify(obj));
    const p = ex.alloc(enc.length);
    new Uint8Array(mem.buffer, p, enc.length).set(enc);
    const out = ex[fn](p, enc.length);
    ex.dealloc(p, enc.length);
    const len = new DataView(mem.buffer).getUint32(out, true);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(mem.buffer, out + 4, len)));
  };
  const pages = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f)));
  for (const pg of pages) console.log('load:', JSON.stringify(call('triage_load', pg)));
  const q = call('triage_query', { q: '', labels: [], state: 'all', reason: 'all', sort: 'updated', desc: true, offset: 0, limit: 5 });
  console.log('query filtered:', q.filtered, 'total:', q.total);
  console.log('facets:', JSON.stringify(q.facets.reasons), 'open/closed:', q.facets.open, q.facets.closed);
  console.log('top labels:', JSON.stringify(q.facets.labels.slice(0, 10)));
  console.log('first row:', JSON.stringify(q.rows[0]).slice(0, 300));
  const dup = call('triage_query', { q: '', labels: [], state: 'all', reason: 'not_planned', sort: 'updated', desc: true, offset: 0, limit: 3 });
  console.log('not_planned rows:', dup.filtered);
  const tri = call('triage_query', { q: '', labels: ['triaged'], state: 'all', reason: 'all', sort: 'updated', desc: true, offset: 0, limit: 3 });
  console.log('label=triaged rows:', tri.filtered, tri.rows.map(r => '#' + r.n).join(','));
})();
