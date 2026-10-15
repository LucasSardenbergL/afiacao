// Gera retrato.json a partir de fatos.json: pré-voo → classificar → resumo.
// Uso: node gerar.mjs <fatos.json> <retrato.json> [hoje YYYY-MM-DD]
import { readFileSync, writeFileSync } from 'node:fs';
import { classificar } from './logica.mjs';

export function preVoo(fatos, agora) {
  const falhas = [];
  const s = fatos.meta?.synced_at_max;
  if (!s) falhas.push('synced_at ausente — não sei se o estoque está fresco');
  else if (agora - new Date(s) > 24 * 3600 * 1000) falhas.push(`synced_at ${s} tem mais de 24h`);
  if (!fatos.itens?.length) falhas.push('0 itens no universo — consulta suspeita');
  return falhas;
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
  const [, , entrada, saida, hojeArg] = process.argv;
  const fatos = JSON.parse(readFileSync(entrada, 'utf8'));
  const falhas = preVoo(fatos, new Date());
  if (falhas.length) {
    console.error('PRÉ-VOO FALHOU:\n- ' + falhas.join('\n- '));
    process.exit(2);
  }
  const hoje = hojeArg ?? new Date().toISOString().slice(0, 10);
  const retrato = classificar(fatos, hoje);
  retrato.meta = { ...retrato.meta, hoje, resumo: resumo(retrato) };
  writeFileSync(saida, JSON.stringify(retrato));
  const r = retrato.meta.resumo;
  for (const [k, v] of Object.entries(r.porCategoria)) console.log(`${k}|${v.n}|${Math.round(v.valor)}`);
  console.log(`total|${r.n}|${Math.round(r.valor)}`);
  console.log(`sem_custo|${fatos.meta.sem_custo.n}`);
  console.log('RETRATO-OK');
}
