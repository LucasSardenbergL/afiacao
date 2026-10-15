// Uso: node medir.mjs <retrato.json> <decisoes.json> <atual.json>
import { readFileSync } from 'node:fs';
import { medir } from './logica.mjs';
const [, , r, d, a] = process.argv;
const m = medir(JSON.parse(readFileSync(r, 'utf8')), JSON.parse(readFileSync(d, 'utf8')), JSON.parse(readFileSync(a, 'utf8')));
const brl = (v) => Math.round(v).toLocaleString('pt-BR');
console.log(`caixa_liberado|${brl(m.caixa_liberado)}`);
console.log(`  vendido|${brl(m.vendido)}\n  liquidado|${brl(m.liquidado)} (margem sacrificada ${brl(m.margem_sacrificada)})\n  trocado|${brl(m.trocado)}`);
console.log(`continua_parado|${brl(m.parado)}`);
console.log(`reclassificado_nao_caixa|${brl(m.reclassificado_nao_caixa)} (melhora DIO, NÃO é caixa)`);
console.log(`sem_medicao|${m.sem_medicao.length}`);
console.log(`contradicoes|${m.contradicoes.length}`);
for (const c of m.contradicoes) console.log(`  ${c.sku}|${c.destino}|${c.pedido_em}`);
console.log('MEDICAO-OK');
