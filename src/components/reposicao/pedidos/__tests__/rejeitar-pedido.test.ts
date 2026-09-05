import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import {
  STATUS_CANCELAVEIS_PELO_HUMANO,
  podeCancelarPeloHumano,
  rejeitarPedidos,
} from '../rejeitar-pedido';

const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const ok = { data: { status: 'ok' }, error: null } as never;
const opts = { usuario: 'lucas@x.com', justificativa: 'Rejeitado em lote no Cockpit' };

beforeEach(() => {
  mockedRpc.mockReset();
  mockedFrom.mockReset();
});

describe('podeCancelarPeloHumano — a regra de produto "cancelável até o disparo" (fonte única)', () => {
  it('pendente_aprovacao, bloqueado_guardrail e aprovado_aguardando_disparo (veto do auto-aprovado) podem', () => {
    for (const s of ['pendente_aprovacao', 'bloqueado_guardrail', 'aprovado_aguardando_disparo']) {
      expect(podeCancelarPeloHumano(s), s).toBe(true);
      expect(STATUS_CANCELAVEIS_PELO_HUMANO.has(s), s).toBe(true);
    }
  });

  it('disparado, terminais, split e ausente NÃO podem — era o bug: `.in("id", ids)` sem guard rejeitava pedido já disparado', () => {
    for (const s of ['disparado', 'concluido_recebido', 'falha_envio', 'cancelado', 'cancelado_humano', 'expirado_sem_aprovacao', 'split_em_filhos', null, undefined, '']) {
      expect(podeCancelarPeloHumano(s), String(s)).toBe(false);
    }
  });
});

describe('rejeitarPedidos — passa pela RPC cancelar_pedido_sugerido (fronteira com guard), nunca UPDATE cru', () => {
  it('chama a RPC com os args canônicos, um pedido por vez, na ordem dada', async () => {
    mockedRpc.mockResolvedValue(ok);
    const r = await rejeitarPedidos(
      [{ id: 10, status: 'pendente_aprovacao' }, { id: 11, status: 'aprovado_aguardando_disparo' }],
      opts,
    );
    expect(mockedRpc).toHaveBeenCalledTimes(2);
    expect(mockedRpc).toHaveBeenNthCalledWith(1, 'cancelar_pedido_sugerido', {
      p_pedido_id: 10, p_usuario: 'lucas@x.com', p_justificativa: 'Rejeitado em lote no Cockpit',
    });
    expect(mockedRpc).toHaveBeenNthCalledWith(2, 'cancelar_pedido_sugerido', expect.objectContaining({ p_pedido_id: 11 }));
    expect(r).toEqual({ rejeitados: [10, 11], pulados: [], falhas: [] });
    expect(mockedFrom).not.toHaveBeenCalled();
  });

  it('status fora da allowlist é PULADO antes de chamar a RPC (com o status no motivo) — os demais seguem', async () => {
    mockedRpc.mockResolvedValue(ok);
    const r = await rejeitarPedidos(
      [{ id: 1, status: 'disparado' }, { id: 2, status: 'pendente_aprovacao' }, { id: 3, status: 'cancelado_humano' }],
      opts,
    );
    expect(mockedRpc).toHaveBeenCalledTimes(1);
    expect(mockedRpc).toHaveBeenCalledWith('cancelar_pedido_sugerido', expect.objectContaining({ p_pedido_id: 2 }));
    expect(r.rejeitados).toEqual([2]);
    expect(r.pulados.map((p) => p.id)).toEqual([1, 3]);
    expect(r.pulados[0].motivo).toContain('disparado');
    expect(r.pulados[1].motivo).toContain('cancelado_humano');
    expect(r.falhas).toEqual([]);
  });

  it('a RPC recusando pelo guard do servidor ({error} no jsonb) vira FALHA com o motivo — não "rejeitado"', async () => {
    mockedRpc
      .mockResolvedValueOnce({ data: { error: 'pedido já foi disparado em 2026-09-05 10:00' }, error: null } as never)
      .mockResolvedValueOnce(ok);
    const r = await rejeitarPedidos([{ id: 5, status: 'pendente_aprovacao' }, { id: 6, status: 'pendente_aprovacao' }], opts);
    expect(r.rejeitados).toEqual([6]);
    expect(r.falhas).toEqual([{ id: 5, motivo: 'pedido já foi disparado em 2026-09-05 10:00' }]);
  });

  it('erro de transporte (PostgREST) vira FALHA com a mensagem, e não aborta os seguintes', async () => {
    mockedRpc
      .mockResolvedValueOnce({ data: null, error: { message: 'permission denied for function cancelar_pedido_sugerido', code: '42501' } } as never)
      .mockResolvedValueOnce(ok);
    const r = await rejeitarPedidos([{ id: 7, status: 'pendente_aprovacao' }, { id: 8, status: 'pendente_aprovacao' }], opts);
    expect(r.falhas).toEqual([{ id: 7, motivo: 'permission denied for function cancelar_pedido_sugerido' }]);
    expect(r.rejeitados).toEqual([8]);
  });

  it('resposta que não afirma `status:"ok"` NÃO conta como rejeitado (ausência de sinal ≠ sucesso)', async () => {
    mockedRpc.mockResolvedValueOnce({ data: null, error: null } as never).mockResolvedValueOnce({ data: 'ok', error: null } as never);
    const r = await rejeitarPedidos([{ id: 9, status: 'pendente_aprovacao' }, { id: 10, status: 'pendente_aprovacao' }], opts);
    expect(r.rejeitados).toEqual([]);
    expect(r.falhas.map((f) => f.id)).toEqual([9, 10]);
  });

  it('a RPC lançando (rede) vira FALHA daquele pedido, sem derrubar o lote', async () => {
    mockedRpc.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce(ok);
    const r = await rejeitarPedidos([{ id: 1, status: 'pendente_aprovacao' }, { id: 2, status: 'pendente_aprovacao' }], opts);
    expect(r.falhas).toEqual([{ id: 1, motivo: 'Failed to fetch' }]);
    expect(r.rejeitados).toEqual([2]);
  });
});

describe('fronteira: nenhum caminho do Cockpit grava cancelamento por UPDATE cru', () => {
  const ler = (p: string) => readFileSync(p, 'utf8');
  const semUpdateCru = (src: string, nome: string) => {
    expect(src, `${nome}: UPDATE cru com status "cancelado"`).not.toContain('status: "cancelado"');
    expect(src, `${nome}: UPDATE cru gravando cancelado_em`).not.toMatch(/\.from\(["']pedido_compra_sugerido["']\)[\s\S]{0,400}?cancelado_em/);
    expect(src, `${nome}: não passa por rejeitarPedidos`).toContain('rejeitarPedidos(');
  };

  it('useCicloHoje (rejeição em lote)', () => {
    semUpdateCru(ler('src/components/reposicao/cicloHoje/useCicloHoje.ts'), 'useCicloHoje');
  });

  it('PedidoRow do ciclo (rejeição inline — mesma classe)', () => {
    semUpdateCru(ler('src/components/reposicao/cicloHoje/PedidoRow.tsx'), 'cicloHoje/PedidoRow');
  });

  it('PedidoRow da lista de pedidos usa a MESMA allowlist (não uma lista inline própria)', () => {
    const src = ler('src/components/reposicao/pedidos/PedidoRow.tsx');
    expect(src).toContain('podeCancelarPeloHumano(');
    expect(src).not.toMatch(/\[\s*'pendente_aprovacao',\s*'bloqueado_guardrail',\s*'aprovado_aguardando_disparo'\s*\]\.includes/);
  });

  it('CiclosAnteriores conta cancelado_humano como cancelado (o Cockpit agora grava esse vocabulário)', () => {
    const src = ler('src/components/reposicao/pedidos/CiclosAnteriores.tsx');
    expect(src).toContain('cancelado_humano');
  });
});
