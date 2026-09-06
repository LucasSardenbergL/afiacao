import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ColKey, PedidoItem } from '@/types/reposicao';
import type { ItemDoPedido } from '../types';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), functions: { invoke: vi.fn() } },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/reposicao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reposicao')>()),
  logAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/components/reposicao/pedidos/aprovar-disparar', () => ({ aprovarEDisparar: vi.fn() }));

import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { aprovarEDisparar } from '@/components/reposicao/pedidos/aprovar-disparar';
import { PedidoRow } from '../PedidoRow';

/** Builder mínimo do PostgREST: registra cada operação (tabela, op, payload, filtros) e resolve. */
interface Op { table: string; op: 'select' | 'update' | 'disparo'; payload?: unknown; filtros: [string, unknown][]; selectApos?: boolean }
let ops: Op[] = [];
let cabecalhoStatus = 'pendente_aprovacao';
let updateRetornaVazio = false; // simula o compare-and-set NÃO casando (0 linhas)

function builder(table: string) {
  const op: Op = { table, op: 'select', filtros: [] };
  const b = {
    select: () => { if (op.op === 'update') op.selectApos = true; return b; },
    update: (payload: unknown) => { op.op = 'update'; op.payload = payload; return b; },
    eq: (c: string, v: unknown) => { op.filtros.push([c, v]); return b; },
    is: (c: string, v: unknown) => { op.filtros.push([`is:${c}`, v]); return b; },
    maybeSingle: () => b,
    order: () => b,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      ops.push(op);
      let out: unknown;
      if (op.op === 'select') out = { data: table === 'pedido_compra_sugerido' ? { status: cabecalhoStatus } : [], error: null };
      else out = { data: op.selectApos ? (updateRetornaVazio ? [] : [{ id: 501 }]) : null, error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}

function linha(over: Partial<PedidoItem> = {}): PedidoItem {
  return {
    id: 1, fornecedor_nome: 'ACME', grupo_codigo: 'G1', num_skus: 1, valor_total: 500,
    pedido_anterior_valor: null, // "primeiro pedido" → modo revisão → editor inline visível
    status: 'pendente_aprovacao', aprovado_em: null, cancelado_em: null, horario_disparo_real: null,
    ...over,
  };
}
const ITEM: ItemDoPedido = { id: 501, qtde_final: 40, qtde_sugerida: 40, preco_unitario: 12.5 };
const cols: Record<ColKey, boolean> = {
  fornecedor: true, grupo: false, skus: false, valor: true, preco: false, confianca: false, status: true, qtdAprovada: true,
};

function montar(row: PedidoItem, itens: ItemDoPedido[] | null | undefined) {
  const onChanged = vi.fn();
  render(
    <table><tbody>
      <PedidoRow row={row} reviewMode={false} selected={false} onToggle={() => {}} cols={cols}
        user={{ id: 'u1', email: 'lucas@x.com' }} onChanged={onChanged} itens={itens} />
    </tbody></table>,
  );
  return { onChanged };
}
// Os dois botões da célula "qtd aprovada" são, nesta ordem, aprovar (✓) e rejeitar (✕).
const botaoAprovar = () => screen.getAllByRole('button')[0];
const updatesDe = (table: string) => ops.filter((o) => o.table === table && o.op === 'update');
const gravouNumSkus = () =>
  ops.some((o) => o.op === 'update' && !!o.payload && typeof o.payload === 'object' && 'num_skus' in (o.payload as object));

beforeEach(() => {
  ops = []; cabecalhoStatus = 'pendente_aprovacao'; updateRetornaVazio = false;
  vi.mocked(supabase.from).mockReset().mockImplementation(builder as never);
  vi.mocked(aprovarEDisparar).mockReset().mockImplementation(async () => {
    ops.push({ table: 'edge', op: 'disparo', filtros: [] }); // entra no MESMO log: a ordem é testável
    return { ok: true, tipo: 'success', mensagem: 'ok' };
  });
  vi.mocked(toast.error).mockReset();
});

describe('PedidoRow (ciclo) — o editor de quantidade edita o ITEM do pedido, nunca num_skus (M-03)', () => {
  it('pedido de 1 item: o campo mostra a quantidade do ITEM (40), não `num_skus` — e a linha NÃO consulta o item (o painel já trouxe)', async () => {
    montar(linha({ num_skus: 7 /* corrompido pelo bug antigo: a cardinalidade vem dos ITENS */ }), [ITEM]);
    expect(await screen.findByDisplayValue('40')).toBeTruthy();
    expect(screen.queryByDisplayValue('7')).toBeNull();
    expect(ops.filter((o) => o.table === 'pedido_compra_item' && o.op === 'select')).toEqual([]);
  });

  it('editar 40→35 e aprovar: checa o status do cabeçalho, grava o ITEM com compare-and-set na quantidade vista, recalcula valor_total e SÓ ENTÃO dispara — nunca num_skus', async () => {
    montar(linha(), [ITEM]);
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));

    const iStatus = ops.findIndex((o) => o.table === 'pedido_compra_sugerido' && o.op === 'select');
    const iItem = ops.findIndex((o) => o.table === 'pedido_compra_item' && o.op === 'update');
    const iCab = ops.findIndex((o) => o.table === 'pedido_compra_sugerido' && o.op === 'update');
    const iDisparo = ops.findIndex((o) => o.op === 'disparo');
    expect([iStatus, iItem, iCab, iDisparo].every((i) => i >= 0), JSON.stringify(ops.map((o) => `${o.table}:${o.op}`))).toBe(true);
    expect(iStatus).toBeLessThan(iItem);
    expect(iItem).toBeLessThan(iCab);
    expect(iCab).toBeLessThan(iDisparo);

    const upItem = ops[iItem];
    expect(upItem.payload).toEqual({ qtde_final: 35, valor_linha: 437.5, ajustado_humano: true });
    expect(upItem.filtros).toContainEqual(['id', 501]);
    expect(upItem.filtros, 'sem compare-and-set na quantidade que o operador VIU').toContainEqual(['qtde_final', 40]);
    expect(upItem.selectApos, 'sem .select() depois do update não dá para saber se casou').toBe(true);
    expect(ops[iCab].payload).toEqual(expect.objectContaining({ valor_total: 437.5 }));
    expect(ops[iCab].filtros).toContainEqual(['id', 1]);
    expect(gravouNumSkus(), 'gravou num_skus (era o bug: contagem de SKUs ≠ quantidade)').toBe(false);
    expect(aprovarEDisparar).toHaveBeenCalledWith(expect.objectContaining({ pedidoId: 1 }));
  });

  it('quantidade inalterada: aprova sem tocar no item nem no cabeçalho', async () => {
    montar(linha(), [ITEM]);
    await screen.findByDisplayValue('40');
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));
    expect(updatesDe('pedido_compra_item')).toEqual([]);
    expect(updatesDe('pedido_compra_sugerido')).toEqual([]);
    expect(gravouNumSkus()).toBe(false);
  });

  it('pedido com VÁRIOS itens: sem editor inline, mostra "2 SKUs" (dos itens, não de num_skus); aprovar não grava item nem num_skus', async () => {
    montar(linha({ num_skus: 1 /* corrompido */ }), [ITEM, { ...ITEM, id: 502 }]);
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByText(/2 SKUs/)).toBeTruthy();
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));
    expect(ops.filter((o) => o.table === 'pedido_compra_item')).toEqual([]);
    expect(gravouNumSkus()).toBe(false);
  });

  it('quantidade ≤ 0 bloqueia a aprovação (toast de erro), sem gravar nem disparar', async () => {
    montar(linha(), [ITEM]);
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(aprovarEDisparar).not.toHaveBeenCalled();
    expect(updatesDe('pedido_compra_item')).toEqual([]);
  });

  it('item sem preço conhecido: grava valor_linha null (ausente ≠ zero) e NÃO reescreve valor_total', async () => {
    montar(linha({ valor_total: null }), [{ ...ITEM, preco_unitario: null }]);
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));
    expect(updatesDe('pedido_compra_item')[0].payload).toEqual({ qtde_final: 35, valor_linha: null, ajustado_humano: true });
    expect(updatesDe('pedido_compra_sugerido')).toEqual([]);
  });

  it('FAIL-CLOSED: com os itens carregando, falhos ou vazios, o botão Aprovar fica DESABILITADO (o operador não vê o que vai comprar)', async () => {
    for (const [itens, rotulo] of [[undefined, 'carregando'], [null, 'falhou'], [[], 'vazio']] as const) {
      ops = [];
      const { unmount } = render(
        <table><tbody>
          <PedidoRow row={linha()} reviewMode={false} selected={false} onToggle={() => {}} cols={cols}
            user={{ id: 'u1', email: 'lucas@x.com' }} onChanged={() => {}} itens={itens as ItemDoPedido[] | null | undefined} />
        </tbody></table>,
      );
      expect(screen.queryByRole('spinbutton'), rotulo).toBeNull();
      expect(botaoAprovar(), `aprovar habilitado com itens ${rotulo}`).toBeDisabled();
      fireEvent.click(botaoAprovar());
      expect(aprovarEDisparar, rotulo).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('decimal digitado (35,1) vira 36 no campo (ceil) e é 36 que se grava — o campo mostra o que compra', async () => {
    montar(linha(), [ITEM]);
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '35.1' } });
    expect(await screen.findByDisplayValue('36')).toBeTruthy();
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));
    expect(updatesDe('pedido_compra_item')[0].payload).toEqual({ qtde_final: 36, valor_linha: 450, ajustado_humano: true });
  });

  it('fator de embalagem (0,2 = balde de 5 L): 37 sobe a 40 no blur; e mesmo sem blur (33) a gravação repete a regra (35)', async () => {
    montar(linha(), [{ ...ITEM, fator_embalagem_portal: 0.2 }]);
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '37' } });
    fireEvent.blur(input);
    expect(await screen.findByDisplayValue('40')).toBeTruthy();
    fireEvent.change(input, { target: { value: '33' } });
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));
    expect(updatesDe('pedido_compra_item')[0].payload).toEqual({ qtde_final: 35, valor_linha: 437.5, ajustado_humano: true });
  });

  it('compare-and-set NÃO casa (outra aba mudou a quantidade): erro visível, nada disparado, lista recarregada', async () => {
    updateRetornaVazio = true;
    const { onChanged } = montar(linha(), [ITEM]);
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/mudou/)));
    expect(aprovarEDisparar).not.toHaveBeenCalled();
    expect(updatesDe('pedido_compra_sugerido')).toEqual([]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('cabeçalho já não aprovável (disparado em outra aba): não grava o item nem dispara', async () => {
    cabecalhoStatus = 'disparado';
    montar(linha(), [ITEM]);
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/aprov/)));
    expect(updatesDe('pedido_compra_item')).toEqual([]);
    expect(aprovarEDisparar).not.toHaveBeenCalled();
  });

  it('item com qtde_final NULL (só sugerida): o compare-and-set usa IS NULL, não eq null', async () => {
    montar(linha(), [{ ...ITEM, qtde_final: null }]);
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));
    expect(updatesDe('pedido_compra_item')[0].filtros).toContainEqual(['is:qtde_final', null]);
  });
});
