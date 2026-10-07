import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Guarda textual do PR0 da baixa de PO (spec 2026-09-26 §15 item 2): a edge omie-sync-estoque registra o
// conjunto aberto que o motor contou SEM nunca pôr o pendente em risco. O helper puro tem os testes Deno
// (observacao-po_test.ts) e, desde a v1.6, a publicação é EXECUTADA com escritas falsas (publicacao_test.ts); aqui se
// vigia só o que nenhum dos dois vê — ONDE e COMO a edge os usa.
const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-estoque/index.ts'), 'utf8'),
);
const fontePublicacao = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-estoque/publicacao.ts'), 'utf8'),
);
const iFuncaoObservacao = fontePublicacao.indexOf('async function publicarObservacao(');

describe('omie-sync-estoque — observação do conjunto aberto', () => {
  it('só publica depois de conferir que a observação bate com o pendente calculado', () => {
    const iInvariante = fontePublicacao.indexOf('observacaoBateComPendente(', iFuncaoObservacao);
    const iRpc = fontePublicacao.indexOf('ops.publicarObservacao(', iFuncaoObservacao);
    expect(iFuncaoObservacao).toBeGreaterThan(0);
    expect(iInvariante).toBeGreaterThan(iFuncaoObservacao);
    expect(iRpc).toBeGreaterThan(iInvariante);
    // o adaptador real é a RPC, com prazo
    expect(fonte).toMatch(/rpc\("reposicao_po_observado_publicar", \{ p_run: run, p_itens: itens \}\)\.abortSignal\(s\)/);
  });

  it('a publicação é não-fatal (try/catch dentro da função) e roda depois da gravação do par e da inativação', () => {
    const iRpc = fontePublicacao.indexOf('ops.publicarObservacao(', iFuncaoObservacao);
    const iFimFuncao = fontePublicacao.indexOf('\nasync function ', iRpc);
    expect(fontePublicacao.slice(iFuncaoObservacao, iRpc)).toContain('try {');
    expect(fontePublicacao.slice(iRpc, iFimFuncao)).toContain('} catch');
    const iConcluir = fontePublicacao.indexOf('export async function concluirRun(');
    const iGravacao = fontePublicacao.indexOf('await gravarEstoque(ops, e, linhas);', iConcluir);
    const iInativacao = fontePublicacao.indexOf('await inativarNaoEncontrados(ops, e);', iConcluir);
    const iChamada = fontePublicacao.indexOf('await publicarObservacao(ops, e, pend, gravacaoCompleta && gm.confirmados === linhasMembros.length, pendenteGravado);', iConcluir);
    expect(iGravacao).toBeGreaterThan(iConcluir);
    expect(iInativacao).toBeGreaterThan(iGravacao);
    expect(iChamada).toBeGreaterThan(iInativacao);
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

  it('a publicação exige coleta íntegra e tem prazo: o limite da cauda, o mesmo da gravação e da inativação', () => {
    const iRpc = fontePublicacao.indexOf('ops.publicarObservacao(', iFuncaoObservacao);
    expect(fontePublicacao.slice(iFuncaoObservacao, iRpc)).toContain('o.coletaIntegra');
    expect(fontePublicacao.slice(iFuncaoObservacao, iRpc)).toMatch(
      /timeoutRequestMs\(ops\.agora\(\), e\.limiteCauda, e\.prazos\.tetoObservacaoMs\)/,
    );
  });
});
