import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AcaoSugerida } from '@/lib/fila/types';

// N4 (plano v4, lote 4): com WhatsApp/Rota/Tarefas congelados a fila não lê as 3 fontes
// (nenhuma requisição, nenhum canal realtime) e o EvidencePack diz "indisponível" —
// ausência nunca vira "sem sinal" (ausente ≠ zero). Os hooks das 3 fontes rodam DE
// VERDADE; só o supabase é dublê (mockar os hooks seria vazar a fronteira de módulo).
const h = vi.hoisted(() => ({
  congeladas: new Set<string>(),
  tabelas: [] as string[],
  canais: 0,
  falhaTarefas: false,
}));

vi.mock('@/lib/modulos/congelamento', () => ({
  rotaCongelada: (path: string) =>
    h.congeladas.has(path)
      ? { desde: '2026-10-12', ate: '2027-01-10', motivo: 'teste', moduloId: 'm', moduloNome: 'M' }
      : null,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'farmer-1' } }) }));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: null }),
}));

const LINHAS: Record<string, unknown> = {
  customer_metrics_mv: [{
    customer_user_id: 'c1', intervalo_medio_dias: 15, dias_desde_ultima_compra: 30,
    atraso_relativo: 1, faturamento_90d: 1000, faturamento_prev_90d: 1000, is_cold_start: false,
  }],
  v_whatsapp_sla: [{
    conversation_id: 'cv1', customer_user_id: 'c1', owner_user_id: 'farmer-1',
    aguardando_desde: '2026-11-01T10:00:00Z', minutos_uteis_aguardando: 90, nivel: 'vermelho',
  }],
  route_disparo_config: null,
};

vi.mock('@/integrations/supabase/client', () => {
  // Cadeia PostgREST genérica: todo método devolve a cadeia; o `await` resolve a resposta.
  const cadeia = (resposta: () => unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get: (_t, k) => (k === 'then'
        ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(resposta()).then(ok, ko)
        : () => p),
      apply: () => p,
    });
    return p;
  };
  return {
    supabase: {
      from: (tabela: string) => {
        h.tabelas.push(tabela);
        return cadeia(() => (tabela === 'v_tarefas_estado' && h.falhaTarefas
          ? { data: null, error: { message: 'boom' } }
          : { data: tabela in LINHAS ? LINHAS[tabela] : [], error: null }));
      },
      channel: () => { h.canais++; return cadeia(() => ({})); },
      removeChannel: () => {},
    },
  };
});

import { useCriticaFila } from '../useCriticaFila';

const acao: AcaoSugerida = {
  fonte: 'tarefa', entidadeId: 'e', clienteUserId: 'c1', clienteNome: 'Cliente 1', telefone: null,
  acao: 'Ligar', titulo: 't', motivo: 'm', categoria: 'risco', score: 0.5,
  valorEsperado: null, tipoValor: 'sem_valor', cta: 'ligar', dedupeKey: 'k:c1',
  payload: { kind: 'tarefa', tarefaId: 'e' },
};

const FALTA_ROTA = 'Sinais de rota indisponíveis (cadência não lida).';
const FALTA_TAREFA = 'Sinais de tarefa indisponíveis (tarefas não lidas).';
const FALTA_WA = 'Sinais de WhatsApp indisponíveis (SLA não lido).';
const TABELAS_CONGELADAS = ['v_whatsapp_sla', 'route_schedule', 'v_tarefas_estado'];

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  h.tabelas = [];
  h.canais = 0;
  h.falhaTarefas = false;
});

describe('useCriticaFila × congelamento de WhatsApp/Rota/Tarefas', () => {
  it('congelados: nenhuma requisição às 3 fontes, sem realtime, e o pack diz "indisponível"', async () => {
    h.congeladas = new Set(['/whatsapp', '/rota', '/tarefas']);
    const { result } = renderHook(() => useCriticaFila([acao]), { wrapper });
    await waitFor(() => expect(h.tabelas).toContain('customer_metrics_mv'));
    await waitFor(() => expect(result.current.get('c1')?.faltaDado).not.toContain('Sem métricas de compra deste cliente.'));

    const pack = result.current.get('c1')!;
    expect(h.tabelas.filter(t => TABELAS_CONGELADAS.includes(t))).toEqual([]);
    expect(h.canais).toBe(0);
    expect(pack.faltaDado).toEqual(expect.arrayContaining([FALTA_ROTA, FALTA_TAREFA, FALTA_WA]));
    expect(pack.contradicoes.map(c => c.chave)).not.toContain('wa_sem_resposta');
  });

  it('ativos: as 3 fontes são lidas, nada indisponível e o sinal de WhatsApp aparece', async () => {
    h.congeladas = new Set();
    const { result } = renderHook(() => useCriticaFila([acao]), { wrapper });
    await waitFor(() => expect(result.current.get('c1')?.contradicoes.map(c => c.chave)).toContain('wa_sem_resposta'));
    await waitFor(() => expect(result.current.get('c1')?.faltaDado).toEqual([]));

    expect(h.tabelas).toEqual(expect.arrayContaining(TABELAS_CONGELADAS));
    expect(h.canais).toBe(1);
  });

  it('ativo mas a leitura de tarefas falhou: indisponível, não "sem tarefa"', async () => {
    h.congeladas = new Set();
    h.falhaTarefas = true;
    const { result } = renderHook(() => useCriticaFila([acao]), { wrapper });
    await waitFor(() => expect(result.current.get('c1')?.contradicoes.map(c => c.chave)).toContain('wa_sem_resposta'));
    await waitFor(() => expect(result.current.get('c1')?.faltaDado).toEqual([FALTA_TAREFA]));
  });
});
