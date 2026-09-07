// [ENVIADO = APROVADO] A quantidade EXIBIDA tem de ser a que vai ser GRAVADA e comprada.
//
// Buraco fechado aqui (challenge Codex retroativo do #2198, P0): `montarUpdateItem` aplica
// `quantidadeCompraCanonica` (sobe ao múltiplo da embalagem) TAMBÉM no fallback — ou seja, numa
// edição SÓ de preço, um item de 37 L com fator 0,2 era gravado como 40 L. Só que `linhas` (o que
// o comprador lê na tela, e a base do total do cabeçalho) usava `quantidadeCompraInteira`, que não
// conhece fator: mostrava 37 L / R$ 925 e gravava 40 L / R$ 1.000. "Aprovar e disparar" salva ANTES
// de disparar, então o fornecedor recebia 40 L sem que ninguém tivesse visto esse número.
//
// A correção NÃO é parar de arredondar (isso devolve a recusa da edge que o #2198 existiu para
// evitar): é a tela usar a MESMA função da gravação no fallback. O `edits[id]` em voo continua CRU
// — `value={l._qtd}` no input, canonizar durante a digitação brigaria com quem digita; quem canoniza
// o valor editado é o `onBlurQty`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PedidoSugerido } from '../types';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), functions: { invoke: vi.fn() } },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'lucas@x.com' } }) }));
vi.mock('../aprovar-disparar', () => ({ aprovarEDisparar: vi.fn() }));

import { supabase } from '@/integrations/supabase/client';
import { aprovarEDisparar } from '../aprovar-disparar';
import { useDetalhesModal } from '../useDetalhesModal';

interface Op { table: string; op: 'select' | 'update' | 'disparo'; payload?: unknown; filtros: [string, unknown][] }
let ops: Op[] = [];
// 37 L aprovados à mão sobre um SKU com embalagem de balde de 5 L (fator 0,2), sem preço ainda.
let itemFixture: Record<string, unknown> = {
  id: 501, pedido_id: 1, sku_codigo_omie: '123', sku_descricao: 'TINGIMIX TEH.3505.00BB',
  qtde_final: 37, qtde_sugerida: 37, valor_linha: null, preco_unitario: null, fator_embalagem_portal: 0.2,
};
const tabelas = (): Record<string, unknown[]> => ({
  omie_condicao_pagamento_catalogo: [{ codigo: '001', descricao: 'À vista', num_parcelas: 1, dias_parcelas: '0' }],
  pedido_compra_item: [itemFixture],
});

function builder(table: string) {
  const op: Op = { table, op: 'select', filtros: [] };
  const b = {
    select: () => b,
    update: (payload: unknown) => { op.op = 'update'; op.payload = payload; return b; },
    eq: (c: string, v: unknown) => { op.filtros.push([c, v]); return b; },
    is: (c: string, v: unknown) => { op.filtros.push([`is:${c}`, v]); return b; },
    in: () => b,
    order: () => b,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      ops.push(op);
      const out = op.op === 'select'
        ? { data: tabelas()[table] ?? [], error: null }
        : { data: [{ id: 501 }], error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}

const pedido = {
  id: 1, empresa: 'OBEN', fornecedor_nome: 'ACME', grupo_codigo: null, data_ciclo: '2026-09-05',
  horario_geracao: null, horario_corte_planejado: null, horario_disparo_real: null, valor_total: 0, num_skus: 1,
  pedido_anterior_valor: null, delta_vs_anterior_perc: null, status: 'pendente_aprovacao', mensagem_bloqueio: null,
  omie_pedido_compra_numero: null, aprovado_em: null, aprovado_por: null, condicao_pagamento_codigo: '001',
  condicao_pagamento_descricao: 'À vista', num_parcelas: 1, dias_parcelas: '0', condicao_origem: null,
  status_envio_portal: null, enviado_portal_em: null, portal_protocolo: null, portal_resposta: null,
  portal_screenshot_url: null, portal_tentativas: null, portal_proximo_retry_em: null, portal_erro: null,
  resposta_canal: null,
} as PedidoSugerido;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const updatesDe = (table: string) => ops.filter((o) => o.table === table && o.op === 'update');

async function montarPronto() {
  const r = renderHook(() => useDetalhesModal({ pedido, open: true, onOpenChange: vi.fn(), onApproved: vi.fn() }), { wrapper });
  await waitFor(() => expect(r.result.current.linhas).toHaveLength(1));
  await waitFor(() => expect(r.result.current.condicaoSelecionada?.codigo).toBe('001'));
  return r;
}

beforeEach(() => {
  ops = [];
  itemFixture = {
    id: 501, pedido_id: 1, sku_codigo_omie: '123', sku_descricao: 'TINGIMIX TEH.3505.00BB',
    qtde_final: 37, qtde_sugerida: 37, valor_linha: null, preco_unitario: null, fator_embalagem_portal: 0.2,
  };
  vi.mocked(supabase.from).mockReset().mockImplementation(builder as never);
  vi.mocked(aprovarEDisparar).mockReset().mockImplementation(async () => {
    ops.push({ table: 'edge', op: 'disparo', filtros: [] });
    return { ok: true, tipo: 'success', mensagem: 'ok' };
  });
});

describe('useDetalhesModal — a quantidade EXIBIDA é a que será GRAVADA (P0 do challenge Codex do #2198)', () => {
  it('item fora do múltiplo com fator do motor: a tela já mostra o múltiplo (40), não os 37 do banco', async () => {
    const { result } = await montarPronto();
    expect(result.current.linhas[0]._qtd, 'a tela mostrava 37 e o save gravava 40').toBe(40);
  });

  it('o total do cabeçalho segue a quantidade exibida (40 x 25 = 1000), não a do banco', async () => {
    const { result } = await montarPronto();
    act(() => result.current.onEditPreco(501, '25'));
    await waitFor(() => expect(result.current.totalAtual).toBe(1000));
  });

  it('edição SÓ de preço: exibido, gravado no item e total do cabeçalho são o MESMO número', async () => {
    const { result } = await montarPronto();
    act(() => result.current.onEditPreco(501, '25'));
    const exibido = result.current.linhas[0]._qtd;
    const totalExibido = result.current.totalAtual;
    await act(async () => { await result.current.aprovarMutation.mutateAsync(); });

    const item = updatesDe('pedido_compra_item')[0];
    const cab = updatesDe('pedido_compra_sugerido')[0];
    expect(item?.payload, 'gravado difere do exibido').toEqual(
      expect.objectContaining({ qtde_final: exibido, valor_linha: exibido * 25 }),
    );
    expect(cab?.payload, 'cabeçalho difere da soma dos itens').toEqual(
      expect.objectContaining({ valor_total: exibido * 25 }),
    );
    expect(totalExibido).toBe(exibido * 25);
    // o compare-and-set continua no valor CRU do banco (37) — é o que detecta a outra aba
    expect(item?.filtros).toContainEqual(['qtde_final', 37]);
    expect(aprovarEDisparar).toHaveBeenCalledTimes(1);
  });

  it('sem fator (a esmagadora maioria dos itens): segue o ceil inteiro de sempre — regressão', async () => {
    itemFixture = { ...itemFixture, qtde_final: 36.2, fator_embalagem_portal: null };
    const { result } = await montarPronto();
    expect(result.current.linhas[0]._qtd).toBe(37);
  });

  it('digitação em voo NÃO é canonizada (o input brigaria com quem digita); o blur é que sobe ao múltiplo', async () => {
    const { result } = await montarPronto();
    act(() => result.current.onEditQty(501, '3'));
    await waitFor(() => expect(result.current.linhas[0]._qtd).toBe(3));
    act(() => result.current.onBlurQty(501));
    await waitFor(() => expect(result.current.linhas[0]._qtd).toBe(5));
  });
});
