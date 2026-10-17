import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Guarda textual do PR(d) da baixa de PO: o helper puro (etapa-desconhecida.ts) tem os testes Deno; aqui se vigia só
// a LIGAÇÃO na edge — chamado dentro do ramo de etapa não aberta, ANTES do `continue`, e o resultado vai para
// `problemas` (que recusa o run). Sem isso o helper poderia existir, testado, e nunca barrar nada.
const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-estoque/index.ts'), 'utf8'),
);

describe('omie-sync-estoque — etapa desconhecida recusa o run', () => {
  it('o ramo de etapa não aberta consulta o helper e empurra o problema antes de seguir', () => {
    const iRamo = fonte.indexOf('if (!ETAPAS_APROVADO_ABERTO.has(etapa)) {');
    expect(iRamo).toBeGreaterThan(0);
    const iFimRamo = fonte.indexOf('continue;', iRamo);
    const ramo = fonte.slice(iRamo, iFimRamo);
    expect(ramo).toMatch(/problemaDeEtapaDesconhecida\(\s*etapa, ped\?\.produtos_consulta, ETAPAS_CONHECIDAS,/);
    expect(ramo).toMatch(/if \(problemaEtapa\) problemas\.push\(problemaEtapa\);/);
    expect(ramo).toContain('coletor.registrar(cabObs, itensObs, "etapa_nao_aberta")');
  });

  it('problema torna o pendente não confiável', () => {
    expect(fonte).toMatch(/const confiavel = problemas\.length === 0 && pedidosVistos > 0;/);
  });
});
