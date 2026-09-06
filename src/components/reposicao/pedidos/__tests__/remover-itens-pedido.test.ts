import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { removerItensDoPedido, STATUS_COM_ITENS_EDITAVEIS } from '../remover-itens-pedido';

/** Cliente mínimo: só `rpc`, que é a única superfície que a fronteira usa. */
const clienteQueResponde = (resposta: unknown, erro: unknown = null) => {
  const rpc = vi.fn().mockResolvedValue({ data: resposta, error: erro });
  return { cliente: { rpc } as never, rpc };
};

describe('removerItensDoPedido — a fronteira', () => {
  it('sucesso: repassa os números que vieram DO BANCO', async () => {
    const { cliente, rpc } = clienteQueResponde({
      status: 'ok', pedido_id: 7, removidos: 2, restantes: 3, valor_total: 450.5, cancelado: false,
    });
    const r = await removerItensDoPedido(7, [11, 12], 'lucas@x.com', cliente);
    expect(r).toEqual({ pedidoId: 7, removidos: 2, restantes: 3, valorTotal: 450.5, cancelado: false });
    expect(rpc).toHaveBeenCalledWith('remover_itens_pedido_sugerido', {
      p_pedido_id: 7, p_item_ids: [11, 12], p_usuario: 'lucas@x.com',
    });
  });

  it('esvaziou: `cancelado` chega como true', async () => {
    const { cliente } = clienteQueResponde({
      status: 'ok', pedido_id: 7, removidos: 1, restantes: 0, valor_total: 0, cancelado: true,
    });
    await expect(removerItensDoPedido(7, [11], 'lucas@x.com', cliente)).resolves.toMatchObject({
      cancelado: true, restantes: 0, valorTotal: 0,
    });
  });

  // ── O ponto da fatia: a RECUSA do servidor tem de ser VISÍVEL, nunca sucesso silencioso ──
  it('recusa da RPC vira erro com a mensagem do servidor', async () => {
    const { cliente } = clienteQueResponde({
      error: 'pedido não permite remoção de itens (status atual: disparado)',
    });
    await expect(removerItensDoPedido(7, [11], 'lucas@x.com', cliente))
      .rejects.toThrow('pedido não permite remoção de itens (status atual: disparado)');
  });

  it('pedido inexistente também vira erro', async () => {
    const { cliente } = clienteQueResponde({ error: 'pedido não encontrado' });
    await expect(removerItensDoPedido(7, [11], 'lucas@x.com', cliente))
      .rejects.toThrow('pedido não encontrado');
  });

  // `'texto' || NULL` colapsa a string inteira para NULL no Postgres. Um `{"error": null}` que
  // caísse no ramo "sem erro" faria a recusa SUMIR da tela — o modo de falha que a
  // 20260905224959 documenta. Aqui ele continua sendo erro.
  it('{"error": null} NÃO é lido como sucesso', async () => {
    const { cliente } = clienteQueResponde({ error: null });
    await expect(removerItensDoPedido(7, [11], 'lucas@x.com', cliente))
      .rejects.toThrow('a remoção foi recusada pelo servidor');
  });

  it('resposta sem status ok não conta como removida', async () => {
    const { cliente } = clienteQueResponde({ removidos: 3 });
    await expect(removerItensDoPedido(7, [11], 'lucas@x.com', cliente))
      .rejects.toThrow('resposta inesperada da RPC (sem status ok)');
  });

  it('erro de transporte do PostgREST vira erro', async () => {
    const { cliente } = clienteQueResponde(null, { message: 'permission denied for function remover_itens_pedido_sugerido', code: '42501' });
    await expect(removerItensDoPedido(7, [11], 'lucas@x.com', cliente))
      .rejects.toThrow(/permission denied/);
  });

  it('a lista enviada é uma CÓPIA (não vaza o array do chamador para a RPC)', async () => {
    const { cliente, rpc } = clienteQueResponde({ status: 'ok', pedido_id: 1, removidos: 1, restantes: 0, valor_total: 0, cancelado: true });
    const ids: readonly number[] = [11];
    await removerItensDoPedido(1, ids, 'lucas@x.com', cliente);
    expect(rpc.mock.calls[0][1].p_item_ids).not.toBe(ids);
    expect(rpc.mock.calls[0][1].p_item_ids).toEqual([11]);
  });
});

describe('a allowlist do cliente e a do servidor são a MESMA regra', () => {
  it('exporta exatamente os dois status que a migration aceita', () => {
    expect([...STATUS_COM_ITENS_EDITAVEIS].sort()).toEqual(['bloqueado_guardrail', 'pendente_aprovacao']);
  });

  // Se a migration mudar a allowlist e o front não, o modal ofereceria um botão que o servidor
  // recusa (ou pior: esconderia um que ele aceita). Este teste casa as duas pontas pelo TEXTO da
  // migration — a única fonte que o front não controla.
  it('a migration recusa qualquer status fora dessa allowlist', () => {
    const sql = readFileSync('supabase/migrations/20260906105549_remover_itens_pedido_guard.sql', 'utf8');
    expect(sql).toContain("v_status NOT IN ('pendente_aprovacao', 'bloqueado_guardrail')");
    // `aprovado_aguardando_disparo` PRECISA ficar de fora: é o estado que o disparador leva ao Omie.
    expect(sql).not.toMatch(/v_status NOT IN \([^)]*aprovado_aguardando_disparo/);
  });

  it('a migration trava a linha do pedido ANTES de apagar os itens', () => {
    const sql = readFileSync('supabase/migrations/20260906105549_remover_itens_pedido_guard.sql', 'utf8');
    const corpo = sql.slice(sql.indexOf('AS $$'), sql.indexOf('$$;'));
    const lock = corpo.indexOf('FOR NO KEY UPDATE');
    const del = corpo.indexOf('DELETE FROM pedido_compra_item');
    expect(lock, 'o lock do pedido sumiu do corpo').toBeGreaterThan(-1);
    expect(del, 'o DELETE sumiu do corpo').toBeGreaterThan(-1);
    expect(lock, 'o DELETE vem antes do lock — o guard deixou de proteger a primeira escrita').toBeLessThan(del);
  });
});

describe('fronteira: o modal não grava remoção nem cancelamento por PostgREST cru', () => {
  const src = readFileSync('src/components/reposicao/pedidos/useDetalhesModal.ts', 'utf8');
  // Comentários explicam POR QUE a via crua saiu e citam o vocabulário que os asserts procuram;
  // medir sobre a fonte com comentários daria vermelho por CEGUEIRA. Stripper compartilhado.
  const semComentarios = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('não apaga itens direto', () => {
    expect(semComentarios).not.toMatch(/\.from\(['"]pedido_compra_item['"]\)[\s\S]{0,200}?\.delete\(/);
  });

  it('não carimba cancelamento por UPDATE cru', () => {
    expect(semComentarios).not.toMatch(/cancelado_humano/);
    expect(semComentarios).not.toMatch(/justificativa_cancelamento/);
    expect(semComentarios).not.toMatch(/cancelado_por/);
    expect(semComentarios).not.toMatch(/portal_proximo_retry_em/);
    // ⚠️ O alvo é o UPDATE que grava STATUS, não qualquer UPDATE na tabela. O modal tem dois
    // UPDATEs LEGÍTIMOS e pré-existentes (salvar quantidades → `valor_total`; salvar condição de
    // pagamento), fora do escopo desta fatia — um assert que os proibisse ficaria vermelho pelo
    // motivo errado e seria desligado na primeira manutenção.
    expect(semComentarios).not.toMatch(/\.from\(['"]pedido_compra_sugerido['"]\)[\s\S]{0,400}?\.update\(\{[^}]*\bstatus:/);
  });

  // Falsifica o assert acima: a regex TEM de casar o padrão que ela promete proibir. Sem isto,
  // um erro de escrita na regex (que nunca casa nada) deixaria o gate sempre-verde.
  it('o gate de UPDATE-com-status realmente casa esse padrão', () => {
    const amostraProibida = `supabase.from('pedido_compra_sugerido').update({ status: 'cancelado_humano' }).eq('id', 1)`;
    expect(amostraProibida).toMatch(/\.from\(['"]pedido_compra_sugerido['"]\)[\s\S]{0,400}?\.update\(\{[^}]*\bstatus:/);
    const amostraLegitima = `supabase.from('pedido_compra_sugerido').update({ valor_total: 10 }).eq('id', 1)`;
    expect(amostraLegitima).not.toMatch(/\.from\(['"]pedido_compra_sugerido['"]\)[\s\S]{0,400}?\.update\(\{[^}]*\bstatus:/);
  });

  it('passa pela fronteira', () => {
    expect(semComentarios).toContain('removerItensDoPedido(');
  });

  // O stripper de comentários tem DOIS lados de falha: sobre-limpeza (apaga código e o teste fica
  // verde por cegueira) e sub-limpeza. Este eixo fica POR FORA dele: a fonte crua tem de conter o
  // que o stripper deveria preservar, provando que ele não comeu o arquivo inteiro.
  it('o stripper não esvaziou a fonte medida', () => {
    expect(semComentarios.length).toBeGreaterThan(src.length * 0.5);
    expect(semComentarios).toContain('useDetalhesModal');
  });
});
