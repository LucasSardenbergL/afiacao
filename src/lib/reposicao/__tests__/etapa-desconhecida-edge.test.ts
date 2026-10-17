import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Guarda textual do PR(d) da baixa de PO. O comportamento está nos testes Deno: o helper por página
// (etapa-desconhecida_test.ts, inclusive o PO do app) e a recusa sem escrita quando o pendente não é confiável
// (publicacao_test.ts). Aqui se vigia só a LIGAÇÃO: a guarda roda sobre a página INTEIRA, antes do laço por PO —
// onde a de-dup do app e o ramo de etapa não aberta dão `continue` —, e o resultado entra em `problemas`.
const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-estoque/index.ts'), 'utf8'),
);

describe('omie-sync-estoque — etapa desconhecida recusa o run', () => {
  it('a guarda roda por página, antes do laço por PO, e alimenta `problemas`', () => {
    const iGuarda = fonte.indexOf(
      'problemas.push(...problemasDeEtapaDaPagina(pedidos, ETAPAS_CONHECIDAS, { parseQtd, parseRecebido }));',
    );
    const iLaco = fonte.indexOf('for (const ped of pedidos) {');
    const iPaginaLida = fonte.indexOf('paginasLidas++;');
    expect(iGuarda).toBeGreaterThan(iPaginaLida);
    expect(iPaginaLida).toBeGreaterThan(0);
    expect(iLaco).toBeGreaterThan(iGuarda);
    expect(fonte.slice(iPaginaLida, iLaco)).not.toMatch(/\bif\s*\(|continue;|return\b/);
  });

  it('problema torna o pendente não confiável', () => {
    expect(fonte).toMatch(/const confiavel = problemas\.length === 0 && pedidosVistos > 0;/);
  });
});
