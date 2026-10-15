// Uso: node medir.mjs <retrato.json> <decisoes.json> <atual.json>
import { readFileSync } from 'node:fs';
import { medir, aplicarCategorias } from './logica.mjs';
const [, , r, d, a] = process.argv;
const retrato = JSON.parse(readFileSync(r, 'utf8'));
const decisoes = JSON.parse(readFileSync(d, 'utf8'));
// categoria marcada à mão (uso e consumo) vale também na medição
const m = medir({ ...retrato, itens: aplicarCategorias(retrato.itens, decisoes) }, decisoes, JSON.parse(readFileSync(a, 'utf8')));
const brl = (v) => Math.round(v).toLocaleString('pt-BR');
console.log(`caixa_liberado|${brl(m.caixa_liberado)}`);
console.log(`  vendido|${brl(m.vendido)}\n  liquidado|${brl(m.liquidado)} (margem sacrificada ${brl(m.margem_sacrificada)})\n  trocado|${brl(m.trocado)}`);
console.log(`continua_parado|${brl(m.parado)}`);
console.log(`recomprado|${brl(m.recomprado)} (vendeu e repôs: não é caixa liberado)`);
console.log(`reclassificado_nao_caixa|${brl(m.reclassificado_nao_caixa)} (melhora DIO, NÃO é caixa)`);
console.log(`sem_medicao|${m.sem_medicao.length} SKUs · R$ ${brl(m.sem_medicao_valor)} (sem número: ausente ou unidade divergente)`);
console.log(`contradicoes|${m.contradicoes.length}`);
for (const c of m.contradicoes) console.log(`  ${c.sku}|${c.destino}|${c.pedido_em}`);
console.log('MEDICAO-OK');
