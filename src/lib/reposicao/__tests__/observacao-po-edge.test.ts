import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Guarda textual do PR0 da baixa de PO (spec 2026-09-26 §15 item 2): a edge omie-sync-estoque registra o
// conjunto aberto que o motor contou SEM nunca pôr o pendente em risco. O helper puro tem os testes Deno
// (observacao-po_test.ts); aqui se vigia só o que o helper não vê — ONDE e COMO a edge o usa.
const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-estoque/index.ts'), 'utf8'),
);

describe('omie-sync-estoque — observação do conjunto aberto', () => {
  it('só publica depois de conferir que a observação bate com o pendente calculado', () => {
    const iInvariante = fonte.indexOf('observacaoBateComPendente(');
    const iRpc = fonte.indexOf('"reposicao_po_observado_publicar"');
    expect(iInvariante).toBeGreaterThan(0);
    expect(iRpc).toBeGreaterThan(iInvariante);
  });

  it('a publicação é não-fatal: chamada dentro de try/catch e nunca antes do upsert do pendente', () => {
    // O try tem de abrir DENTRO do bloco da observação (um `lastIndexOf('try {')` solto acharia o try do ramo COLACOR
    // se este sumisse — revisão final do PR0) e o catch fechar antes do passo seguinte do run.
    const iBloco = fonte.indexOf('if (observacaoPo) {');
    const iRpc = fonte.indexOf('"reposicao_po_observado_publicar"');
    const iDepois = fonte.indexOf('detectarVarreduraTruncada(', iRpc);
    expect(iBloco).toBeGreaterThan(0);
    expect(iDepois).toBeGreaterThan(iRpc);
    expect(fonte.slice(iBloco, iRpc)).toContain('try {');
    expect(fonte.slice(iRpc, iDepois)).toContain('} catch');
    expect(iRpc).toBeGreaterThan(fonte.indexOf('from("sku_estoque_atual")'));
  });

  it('cada ponto de decisão da varredura registra o motivo', () => {
    for (const motivo of ['"dedup_app"', '"etapa_nao_aberta"', '"repetido_na_varredura"']) {
      expect(fonte).toContain(motivo);
    }
  });

  it('registra pelo coletor (1 registro por PO): observarPedido direto reintroduziria a colisão na PK', () => {
    expect(fonte).toContain('criarColetorObservacao(');
    expect(fonte).not.toContain('observarPedido(');
  });

  it('o PO contado é anotado com a decisão FINAL do motor (o filtro poNumerosEmTransito do acumulador)', () => {
    // Sem isto, um PO que o acumulador descarta por número (cNumero "" casando um número vazio do app) apareceria
    // como contado, e a soma por SKU poderia fechar por compensação com outro PO (Codex, adversarial do PR0).
    expect(fonte).toContain('coletor.registrar(cabObs, itensObs, emTransitoNumeros.has(cNumero) ? "dedup_app" : null)');
  });

  it('a publicação exige coleta íntegra e tem prazo: não come o tempo da inativação nem dos marcadores', () => {
    const iRpc = fonte.indexOf('"reposicao_po_observado_publicar"');
    expect(fonte.lastIndexOf('coletaIntegra', iRpc)).toBeGreaterThan(0);
    expect(fonte.indexOf('.abortSignal(', iRpc)).toBeGreaterThan(iRpc);
    expect(fonte.lastIndexOf('timeoutRequestMs(', iRpc)).toBeGreaterThan(fonte.indexOf('from("sku_estoque_atual")'));
  });
});
