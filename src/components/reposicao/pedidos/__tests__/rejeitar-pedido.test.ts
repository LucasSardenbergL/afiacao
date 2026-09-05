import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import {
  STATUS_CANCELAVEIS_EM_LOTE,
  STATUS_CANCELAVEIS_PELO_HUMANO,
  podeCancelarPeloHumano,
  rejeitarPedidos,
  resumirRejeicao,
} from '../rejeitar-pedido';

const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

/** O status ATUAL no banco, por id — o helper RELÊ antes de decidir (o do browser pode ter minutos). */
let statusNoBanco: Record<number, string | null> = {};
let erroLeitura: { message: string } | null = null;
let updates = 0;
function builder(table: string) {
  const b = {
    select: () => b,
    in: (_c: string, ids: number[]) => {
      const data = ids.filter((id) => id in statusNoBanco).map((id) => ({ id, status: statusNoBanco[id] }));
      return Promise.resolve(erroLeitura ? { data: null, error: erroLeitura } : { data, error: null });
    },
    update: () => { updates += 1; return b; },
    eq: () => b,
  };
  if (table !== 'pedido_compra_sugerido') throw new Error(`tabela inesperada: ${table}`);
  return b;
}

const ok = { data: { status: 'ok' }, error: null } as never;
const lote = { usuario: 'lucas@x.com', justificativa: 'Rejeitado em lote no Cockpit', via: 'lote' as const };
const individual = { ...lote, justificativa: 'Rejeitado inline no Cockpit', via: 'individual' as const };

beforeEach(() => {
  mockedRpc.mockReset();
  mockedFrom.mockReset().mockImplementation(builder as never);
  statusNoBanco = {}; erroLeitura = null; updates = 0;
});

describe('allowlists — a regra de produto "cancelável até o disparo", por via (fonte única)', () => {
  it('lote: só o que NUNCA foi aprovado; individual: também o veto do auto-aprovado', () => {
    expect([...STATUS_CANCELAVEIS_EM_LOTE].sort()).toEqual(['bloqueado_guardrail', 'pendente_aprovacao']);
    expect([...STATUS_CANCELAVEIS_PELO_HUMANO].sort()).toEqual(['aprovado_aguardando_disparo', 'bloqueado_guardrail', 'pendente_aprovacao']);
    for (const s of STATUS_CANCELAVEIS_PELO_HUMANO) expect(podeCancelarPeloHumano(s), s).toBe(true);
  });

  it('disparado, falha_envio (tentativa de envio já feita), terminais, split e ausente NÃO podem', () => {
    for (const s of ['disparado', 'concluido_recebido', 'falha_envio', 'cancelado', 'cancelado_humano', 'expirado_sem_aprovacao', 'split_em_filhos', null, undefined, '']) {
      expect(podeCancelarPeloHumano(s), String(s)).toBe(false);
    }
  });
});

describe('rejeitarPedidos — decide pelo status RELIDO do banco e passa pela RPC (fronteira), nunca UPDATE cru', () => {
  it('chama a RPC com os args canônicos, um pedido por vez, na ordem dada', async () => {
    statusNoBanco = { 10: 'pendente_aprovacao', 11: 'aprovado_aguardando_disparo' };
    mockedRpc.mockResolvedValue(ok);
    const r = await rejeitarPedidos([{ id: 10, status: 'pendente_aprovacao' }, { id: 11, status: 'aprovado_aguardando_disparo' }], individual);
    expect(mockedRpc).toHaveBeenNthCalledWith(1, 'cancelar_pedido_sugerido', { p_pedido_id: 10, p_usuario: 'lucas@x.com', p_justificativa: 'Rejeitado inline no Cockpit' });
    expect(mockedRpc).toHaveBeenNthCalledWith(2, 'cancelar_pedido_sugerido', expect.objectContaining({ p_pedido_id: 11 }));
    expect(r).toEqual({ rejeitados: [10, 11], pulados: [], falhas: [] });
    expect(updates).toBe(0);
  });

  it('o status do BROWSER não manda: browser diz "pendente", banco diz "disparado" → pulado, RPC nem é chamada (Codex P1)', async () => {
    statusNoBanco = { 1: 'disparado', 2: 'falha_envio', 3: 'pendente_aprovacao' };
    mockedRpc.mockResolvedValue(ok);
    const r = await rejeitarPedidos(
      [{ id: 1, status: 'pendente_aprovacao' }, { id: 2, status: 'aprovado_aguardando_disparo' }, { id: 3, status: 'pendente_aprovacao' }],
      individual,
    );
    expect(mockedRpc).toHaveBeenCalledTimes(1);
    expect(mockedRpc).toHaveBeenCalledWith('cancelar_pedido_sugerido', expect.objectContaining({ p_pedido_id: 3 }));
    expect(r.rejeitados).toEqual([3]);
    expect(r.pulados.map((p) => [p.id, p.status])).toEqual([[1, 'disparado'], [2, 'falha_envio']]);
    expect(r.pulados[0].motivo).toContain('disparado');
  });

  it('via LOTE não veta auto-aprovado (aguardando o cron): pulado com a dica de vetar individualmente', async () => {
    statusNoBanco = { 1: 'aprovado_aguardando_disparo', 2: 'bloqueado_guardrail' };
    mockedRpc.mockResolvedValue(ok);
    const r = await rejeitarPedidos([{ id: 1, status: 'aprovado_aguardando_disparo' }, { id: 2, status: 'bloqueado_guardrail' }], lote);
    expect(mockedRpc).toHaveBeenCalledTimes(1);
    expect(r.rejeitados).toEqual([2]);
    expect(r.pulados[0].motivo).toMatch(/individual/);
  });

  it('pedido que sumiu do banco (removido/regenerado) → pulado, sem RPC', async () => {
    statusNoBanco = { 2: 'pendente_aprovacao' };
    mockedRpc.mockResolvedValue(ok);
    const r = await rejeitarPedidos([{ id: 1, status: 'pendente_aprovacao' }, { id: 2, status: 'pendente_aprovacao' }], lote);
    expect(r.rejeitados).toEqual([2]);
    expect(r.pulados).toEqual([{ id: 1, status: null, motivo: expect.stringMatching(/não encontrado/) }]);
  });

  it('se nem o status dá para reler, NINGUÉM é rejeitado (fail-closed): tudo em falhas, RPC não chamada', async () => {
    erroLeitura = { message: 'permission denied for table pedido_compra_sugerido' };
    const r = await rejeitarPedidos([{ id: 1, status: 'pendente_aprovacao' }, { id: 2, status: 'pendente_aprovacao' }], lote);
    expect(mockedRpc).not.toHaveBeenCalled();
    expect(r.rejeitados).toEqual([]);
    expect(r.falhas.map((f) => f.id)).toEqual([1, 2]);
    expect(r.falhas[0].motivo).toContain('permission denied');
  });

  it('a RPC recusando pelo guard do servidor ({error} no jsonb) vira FALHA com o motivo — não "rejeitado"', async () => {
    statusNoBanco = { 5: 'pendente_aprovacao', 6: 'pendente_aprovacao' };
    mockedRpc
      .mockResolvedValueOnce({ data: { error: 'pedido já foi disparado em 2026-09-05 10:00' }, error: null } as never)
      .mockResolvedValueOnce(ok);
    const r = await rejeitarPedidos([{ id: 5, status: 'pendente_aprovacao' }, { id: 6, status: 'pendente_aprovacao' }], lote);
    expect(r.rejeitados).toEqual([6]);
    expect(r.falhas).toEqual([{ id: 5, motivo: 'pedido já foi disparado em 2026-09-05 10:00' }]);
  });

  it('erro de transporte e exceção viram FALHA daquele pedido, sem derrubar o lote', async () => {
    statusNoBanco = { 7: 'pendente_aprovacao', 8: 'pendente_aprovacao', 9: 'pendente_aprovacao' };
    mockedRpc
      .mockResolvedValueOnce({ data: null, error: { message: 'permission denied for function cancelar_pedido_sugerido', code: '42501' } } as never)
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(ok);
    const r = await rejeitarPedidos([7, 8, 9].map((id) => ({ id, status: 'pendente_aprovacao' })), lote);
    expect(r.falhas).toEqual([
      { id: 7, motivo: 'permission denied for function cancelar_pedido_sugerido' },
      { id: 8, motivo: 'Failed to fetch' },
    ]);
    expect(r.rejeitados).toEqual([9]);
  });

  it('resposta que não afirma `status:"ok"` NÃO conta como rejeitado (ausência de sinal ≠ sucesso)', async () => {
    statusNoBanco = { 9: 'pendente_aprovacao', 10: 'pendente_aprovacao' };
    mockedRpc.mockResolvedValueOnce({ data: null, error: null } as never).mockResolvedValueOnce({ data: 'ok', error: null } as never);
    const r = await rejeitarPedidos([{ id: 9, status: 'pendente_aprovacao' }, { id: 10, status: 'pendente_aprovacao' }], lote);
    expect(r.rejeitados).toEqual([]);
    expect(r.falhas.map((f) => f.id)).toEqual([9, 10]);
  });
});

describe('resumirRejeicao — o resumo não pode enganar o operador', () => {
  it('0 rejeitados + N pulados NÃO é sucesso nem "parcial": é aviso com os status', () => {
    const r = resumirRejeicao({ rejeitados: [], pulados: [{ id: 1, status: 'disparado', motivo: 'x' }, { id: 2, status: 'disparado', motivo: 'x' }], falhas: [] });
    expect(r.nivel).toBe('warning');
    expect(r.texto).toMatch(/0 rejeitado/);
    expect(r.texto).toMatch(/2× disparado/);
  });
  it('qualquer falha → erro, com o primeiro motivo', () => {
    const r = resumirRejeicao({ rejeitados: [1], pulados: [], falhas: [{ id: 2, motivo: 'pedido já foi disparado' }] });
    expect(r.nivel).toBe('error');
    expect(r.texto).toContain('pedido já foi disparado');
  });
  it('tudo rejeitado → sucesso', () => {
    expect(resumirRejeicao({ rejeitados: [1, 2], pulados: [], falhas: [] }).nivel).toBe('success');
  });
});

describe('fronteira: nenhum caminho humano grava cancelamento por UPDATE cru nem lê só o erro de transporte da RPC', () => {
  const ler = (p: string) => readFileSync(p, 'utf8');
  const semUpdateCru = (src: string, nome: string) => {
    expect(src, `${nome}: UPDATE cru com status cancelado`).not.toMatch(/status:\s*["']cancelado(_humano)?["']/);
    expect(src, `${nome}: UPDATE cru gravando cancelado_em`).not.toMatch(/\.from\(["']pedido_compra_sugerido["']\)[\s\S]{0,2000}?\.update\([\s\S]{0,600}?cancelado_em/);
    expect(src, `${nome}: chama a RPC direto, fora da fronteira`).not.toContain("rpc('cancelar_pedido_sugerido'");
    expect(src, `${nome}: não passa por rejeitarPedidos`).toContain('rejeitarPedidos(');
  };

  it('useCicloHoje (rejeição em lote) — via lote', () => {
    const src = ler('src/components/reposicao/cicloHoje/useCicloHoje.ts');
    semUpdateCru(src, 'useCicloHoje');
    expect(src).toMatch(/via:\s*["']lote["']/);
  });

  it('PedidoRow do ciclo (rejeição inline) — via individual', () => {
    const src = ler('src/components/reposicao/cicloHoje/PedidoRow.tsx');
    semUpdateCru(src, 'cicloHoje/PedidoRow');
    expect(src).toMatch(/via:\s*["']individual["']/);
  });

  it('CancelarModal (lista de pedidos) — mesma fronteira; a recusa da RPC vira erro, não "Pedido cancelado"', () => {
    const src = ler('src/components/reposicao/pedidos/CancelarModal.tsx');
    semUpdateCru(src, 'CancelarModal');
    expect(src).toMatch(/if \(motivo\) throw new Error\(motivo\)/);
  });

  it('PedidoRow da lista usa a MESMA allowlist (não uma lista inline própria)', () => {
    const src = ler('src/components/reposicao/pedidos/PedidoRow.tsx');
    expect(src).toContain('podeCancelarPeloHumano(');
    expect(src).not.toMatch(/\[\s*['"]pendente_aprovacao['"],\s*['"]bloqueado_guardrail['"],\s*['"]aprovado_aguardando_disparo['"]\s*\]\.includes/);
  });

  it('CiclosAnteriores conta cancelado_humano como cancelado — na CONDIÇÃO, não num comentário', () => {
    const src = ler('src/components/reposicao/pedidos/CiclosAnteriores.tsx');
    expect(src).toMatch(/r\.status === ['"]cancelado['"] \|\| r\.status === ['"]cancelado_humano['"]\) g\.cancelados \+= 1/);
  });

  it('o rótulo de cancelado_humano não é mais "vazio"', () => {
    const src = ler('src/components/reposicao/pedidos/shared.ts');
    expect(src).not.toMatch(/cancelado_humano:\s*\{\s*label:\s*['"]Cancelado \(vazio\)['"]/);
  });
});
