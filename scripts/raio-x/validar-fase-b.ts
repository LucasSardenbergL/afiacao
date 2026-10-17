// Validação da fase B do Raio-X com dado real (Task 10 do plano 2026-10-16).
// Lê o JSON exportado de raio_x_estoque_fatos(<empresa>) e roda a MESMA lógica
// da tela (classificar + placar), imprimindo os totais para conferir contra a
// fase A (Oben ≈ 611 SKUs / R$ 341k parados) e a tabela por tipo da spec §2.
//
// Uso: bun scripts/raio-x/validar-fase-b.ts <fatos.json> <oben|colacor>
import { readFileSync } from 'node:fs';
import { classificar } from '@/lib/reposicao/raio-x/classificar';
import { placar } from '@/lib/reposicao/raio-x/placar';
import type { Empresa, FatoSku } from '@/lib/reposicao/raio-x/tipos';
import { hojeSP } from '@/lib/time/sp-day';

const [arquivo, empresaArg] = process.argv.slice(2);
if (!arquivo || (empresaArg !== 'oben' && empresaArg !== 'colacor')) {
  console.error('uso: bun scripts/raio-x/validar-fase-b.ts <fatos.json> <oben|colacor>');
  process.exit(2);
}
const empresa: Empresa = empresaArg;
const fatos = JSON.parse(readFileSync(arquivo, 'utf8')) as FatoSku[];
const itens = classificar(fatos, new Map(), empresa, hojeSP());
const p = placar(itens, new Map());

const brl = (v: number) => `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
const somar = (xs: typeof itens) => {
  const comCusto = xs.filter((i) => i.valor !== null);
  return { n: xs.length, valor: comCusto.reduce((s, i) => s + (i.valor as number), 0), semCusto: xs.length - comCusto.length };
};
const linha = (rotulo: string, xs: typeof itens) => {
  const s = somar(xs);
  console.log(`${rotulo.padEnd(28)} ${String(s.n).padStart(5)} SKUs  ${brl(s.valor).padStart(14)}  (sem custo: ${s.semCusto})`);
};

console.log(`Raio-X fase B — ${empresa} — ${fatos.length} linhas da RPC — hoje ${hojeSP()}`);
linha('total com saldo', itens);
for (const cat of ['mercadoria', 'uso_consumo', 'nao_mercadoria'] as const) {
  linha(`categoria ${cat}`, itens.filter((i) => i.categoria === cat));
}
linha('mercadoria PARADA', itens.filter((i) => i.categoria === 'mercadoria' && i.parado));
linha('Top 61', itens.filter((i) => i.top));
// Universo da fase A (fatos.sql de 2026-10-14): o MESMO critério de parado, mas sobre TODAS as
// categorias e só CMC > 0 — é com ele que se compara o "≈ 611 SKUs / R$ 341k" da spec.
if (empresa === 'oben') {
  linha('universo fase A (todas)', itens.filter((i) => i.valor !== null && (!i.no_motor || i.q12 === 0 || (i.cobertura !== null && i.cobertura > 180))));
}

console.log('\npor tipo_produto (todas as categorias):');
const tipos = [...new Set(itens.map((i) => i.tipo_produto ?? '(sem cadastro)'))].sort();
for (const t of tipos) linha(`  tipo ${t}`, itens.filter((i) => (i.tipo_produto ?? '(sem cadastro)') === t));

console.log('\ndestino sugerido (mercadoria parada):');
const parados = itens.filter((i) => i.categoria === 'mercadoria' && i.parado);
const destinos = [...new Set(parados.map((i) => i.destino_sugerido ?? '(nenhum)'))].sort();
for (const d of destinos) linha(`  ${d}`, parados.filter((i) => (i.destino_sugerido ?? '(nenhum)') === d));

console.log(`\nplacar: total ${brl(p.total)} · Top ${brl(p.topTotal)} · sem custo ${p.semCustoN} · distorce o DIO ${brl(p.distorceDio)} (sem custo ${p.semCustoDioN})`);

console.log('\namostra para conferir no Omie (maior valor de cada categoria):');
for (const cat of ['mercadoria', 'uso_consumo', 'nao_mercadoria'] as const) {
  const [i] = itens.filter((x) => x.categoria === cat && x.valor !== null).sort((a, b) => (b.valor as number) - (a.valor as number));
  if (i) console.log(`  ${cat}: ${i.codigo} · ${i.descricao} · saldo ${i.saldo} · ${brl(i.valor as number)} · ${i.motivo_categoria}${i.destino_sugerido ? ` · sugere ${i.destino_sugerido}` : ''}`);
}
console.log('VALIDACAO_FIM');
