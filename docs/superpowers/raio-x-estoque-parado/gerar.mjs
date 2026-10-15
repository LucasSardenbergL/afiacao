// Gera retrato.json a partir de fatos.json: pré-voo → classificar → resumo.
// Uso: node gerar.mjs --banco <dir-saida> [hoje]   (roda fatos.sql no psql-ro, read-only)
//      node gerar.mjs <fatos.json> <retrato.json> [hoje YYYY-MM-DD]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classificar } from './logica.mjs';

export function preVoo(fatos, agora) {
  const falhas = [];
  const s = fatos.meta?.synced_at_max;
  if (!s) falhas.push('synced_at ausente — não sei se o estoque está fresco');
  else if (agora - new Date(s) > 24 * 3600 * 1000) falhas.push(`synced_at ${s} tem mais de 24h`);
  if (!fatos.itens?.length) falhas.push('0 itens no universo — consulta suspeita');
  return falhas;
}

export function hojeSP(agora) {
  return agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

// Saída do psql: exige o marcador positivo de fim (psql sai 0 com ERROR sem ON_ERROR_STOP).
export function extrairJson(raw) {
  if (/^ERROR:|^psql:.*ERROR/m.test(raw)) throw new Error('psql devolveu ERROR: ' + raw.slice(0, 500));
  if (!/^fim\|ok$/m.test(raw)) throw new Error('sem marcador fim|ok na saída do psql');
  const linha = raw.split('\n').find((l) => l.startsWith('json|'));
  if (!linha) throw new Error('sem linha json| na saída do psql');
  return linha.slice('json|'.length);
}

export function resumo(retrato) {
  const porCategoria = {};
  let n = 0;
  let valor = 0;
  for (const i of retrato.itens) {
    const c = (porCategoria[i.categoria] ??= { n: 0, valor: 0 });
    c.n += 1; c.valor += i.valor; n += 1; valor += i.valor;
  }
  return { porCategoria, n, valor };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let [, , entrada, saida, hojeArg] = process.argv;
  if (entrada === '--banco') {
    const out = saida;
    if (!out) { console.error('uso: node gerar.mjs --banco <dir-saida> [hoje]'); process.exit(3); }
    mkdirSync(out, { recursive: true });
    const sql = join(dirname(fileURLToPath(import.meta.url)), 'fatos.sql');
    const r = spawnSync(join(homedir(), '.config/afiacao/psql-ro'), ['-At', '-F|', '-v', 'ON_ERROR_STOP=1', '-f', sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) { console.error('psql falhou (exit ' + r.status + '):', (r.stderr || r.stdout || '').slice(0, 2000)); process.exit(1); }
    entrada = join(out, 'fatos.json');
    writeFileSync(entrada, extrairJson(r.stdout + (r.stderr ?? '')));
    saida = join(out, 'retrato.json');
  }
  const fatos = JSON.parse(readFileSync(entrada, 'utf8'));
  const falhas = preVoo(fatos, new Date());
  if (falhas.length) {
    console.error('PRÉ-VOO FALHOU:\n- ' + falhas.join('\n- '));
    process.exit(2);
  }
  const hoje = hojeArg ?? hojeSP(new Date());
  const retrato = classificar(fatos, hoje);
  retrato.meta = { ...retrato.meta, hoje, resumo: resumo(retrato) };
  writeFileSync(saida, JSON.stringify(retrato));
  const r = retrato.meta.resumo;
  for (const [k, v] of Object.entries(r.porCategoria)) console.log(`${k}|${v.n}|${Math.round(v.valor)}`);
  console.log(`total|${r.n}|${Math.round(r.valor)}`);
  console.log(`sem_custo|${fatos.meta.sem_custo.n}`);
  console.log('RETRATO-OK');
}
