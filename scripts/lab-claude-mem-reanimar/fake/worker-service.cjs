const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net');
const { spawn } = require('child_process');
const DATA = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), '.claude-mem');
const SETTINGS = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
const PORT = Number(SETTINGS.CLAUDE_MEM_WORKER_PORT);
const HOST = SETTINGS.CLAUDE_MEM_WORKER_HOST || '127.0.0.1';
const PIDF = path.join(DATA, 'worker.pid');
const CONTF = path.join(DATA, 'state', 'hook-failures.json');
const MODEF = path.join(DATA, '.lab-mode');
const log = (m) => fs.appendFileSync(path.join(DATA, 'logs', 'claude-mem-2026-09-24.log'), `[2026-09-24 12:00:00] [INFO ] [LAB] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(p, timeoutMs) {
  return new Promise((res) => {
    const req = http.get({ host: HOST, port: PORT, path: p, timeout: timeoutMs }, (r) => { r.resume(); res(r.statusCode); });
    req.on('timeout', () => { req.destroy(); res(0); });
    req.on('error', () => res(0));
  });
}
function portFree() {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(PORT, HOST, () => s.close(() => res(true)));
  });
}
function writePid() { fs.writeFileSync(PIDF, JSON.stringify({ pid: process.pid, port: PORT, startedAt: new Date().toISOString() }, null, 2)); }
async function daemon() {
  const mode = fs.existsSync(MODEF) ? fs.readFileSync(MODEF, 'utf8').trim() : 'sao';
  log(`daemon mode=${mode}`);
  if (mode === 'surdo') {
    // filho tipo chroma (mesmo pgid) + filho tipo SDK claude (detached = pgid proprio, ignora SIGTERM)
    spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)', 'chroma-mcp', '--client-type', 'persistent', '--data-dir', path.join(DATA, 'chroma')], { stdio: 'ignore' });
    spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1e9)", 'claude', '--output-format', 'stream-json', DATA], { stdio: 'ignore', detached: true });
    net.createServer({ pauseOnConnect: true }, () => {}).listen(PORT, HOST, writePid);
    return;
  }
  if (mode === 'semporta') { writePid(); setInterval(() => {}, 1e9); return; }
  const teimoso = mode === 'naopronto-teimoso';
  http.createServer((req, res) => {
    if (req.url === '/api/health') { res.writeHead(200); res.end(JSON.stringify({ status: 'ok', pid: process.pid })); return; }
    if (req.url === '/api/readiness') { const ok = mode === 'sao' || mode === 'sao-outro-endereco'; res.writeHead(ok ? 200 : 503); res.end(ok ? 'ready' : 'initializing'); return; }
    if (req.url === '/api/admin/shutdown') { res.writeHead(200); res.end('bye'); if (!teimoso) setTimeout(() => process.exit(0), 100); return; }
    if (req.url.startsWith('/api/context/inject')) { res.writeHead(200); res.end('ctx'); return; }
    res.writeHead(404); res.end();
  }).listen(PORT, mode === 'sao-outro-endereco' ? '127.0.0.2' : HOST, writePid);
}
async function start() {
  if (!(await portFree())) { console.log(JSON.stringify({ status: 'error', message: 'port in use' })); process.exit(1); }
  fs.writeFileSync(MODEF, process.env.LAB_START_MODE || 'sao');
  spawn(process.execPath, [__filename, '--daemon'], { detached: true, stdio: 'ignore', env: process.env, cwd: process.cwd() }).unref();
  for (let i = 0; i < 40; i++) {
    if ((await get('/api/health', 500)) === 200) { console.log(JSON.stringify({ status: 'ready' })); process.exit(0); }
    await sleep(250);
  }
  console.log(JSON.stringify({ status: 'error', message: 'Failed to start worker' }));
  process.exit(0);
}
async function restart() {
  await get('/api/admin/shutdown', 2000);
  for (let i = 0; i < 20 && !(await portFree()); i++) await sleep(250);
  if (!(await portFree())) { console.log('Port did not free up after shutdown'); process.exit(1); }
  await start();
}
async function hook() {
  let input = '';
  for await (const c of process.stdin) input += c;
  fs.appendFileSync(path.join(DATA, '.lab-hook-calls'), input + '\n');
  if (process.env.LAB_HOOK_FAIL) { process.stderr.write('lab: hook falhou de proposito'); process.exit(2); }
  const code = await get('/api/health', 3000);
  const ready = code === 200 ? await get('/api/readiness', 3000) : 0;
  let st = { consecutiveFailures: 0, lastFailureAt: 0 };
  try { st = JSON.parse(fs.readFileSync(CONTF, 'utf8')); } catch {}
  if (code === 200 && ready === 200) { fs.writeFileSync(CONTF, JSON.stringify({ consecutiveFailures: 0, lastFailureAt: 0 })); process.stdout.write('{}'); process.exit(0); }
  st.consecutiveFailures += 1;
  fs.writeFileSync(CONTF, JSON.stringify(st));
  if (st.consecutiveFailures >= 3) { process.stderr.write(`claude-mem worker unreachable for ${st.consecutiveFailures} consecutive hooks.`); process.exit(2); }
  process.exit(0);
}
const cmd = process.argv[2];
const table = { '--daemon': daemon, start, restart, hook };
(table[cmd] || (() => { console.error('comando desconhecido ' + cmd); process.exit(1); }))();
