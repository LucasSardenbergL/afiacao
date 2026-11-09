import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Plano v7, C10 — as oportunidades de compra afirmavam "economia R$ 0" em falha.
 *
 * O `queryFn` de `v_otimizador_compras_insumos` já LANÇAVA; o defeito era o consumidor:
 * `data: oportunidades = []` sem ler o estado. As somas partiam de zero e a tabela caía no
 * <EstadoVazio>. Reprodução do Codex: erro simulado → 0 linhas, economia 0, IDÊNTICO ao
 * controle `[]` com sucesso. Este arquivo tem os dois lados: o controle (leitura boa vazia →
 * R$ 0,00 + "Nenhuma oportunidade ativa", que AÍ é verdade) e a falha (→ "—" + aviso).
 *
 * Terceiro caso: falha de ATUALIZAÇÃO com dado anterior em mãos — a linha fica, e a página diz
 * que ela está desatualizada (`desatualizado()`), em vez de apagar ou de fingir que é atual.
 */

type Resposta = { data: unknown; error: { message: string } | null; count?: number | null };

const OK_VAZIO: Resposta = { data: [], error: null, count: 0 };
const FALHA: Resposta = { data: null, error: { message: 'statement timeout' }, count: null };
let porTabela: Record<string, Resposta> = {};

const LINHA = {
  empresa: 'OBEN',
  sku_codigo_omie: 999,
  sku_descricao: 'Verniz Premium',
  fornecedor_nome: 'SAYERLACK',
  cenario: 'promo_flat',
  desconto_total_perc: 12.5,
  desconto_promo_perc: 10,
  data_limite_acao: '2026-11-20',
  dias_ate_limite: 3,
  demanda_diaria: 2,
  qtde_base: 10,
  qtde_oportunidade: 30,
  preco_item_eoq: 50,
  economia_bruta_estimada: 500,
  aumentos_json: null,
};

function builder(resposta: () => Resposta) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'eq', 'in', 'gte', 'lte', 'gt']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) => Promise.resolve(resposta()).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => builder(() => porTabela[tabela] ?? OK_VAZIO),
    rpc: () => Promise.resolve({ data: [], error: null }),
    functions: { invoke: () => Promise.resolve({ data: {}, error: null }) },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/execucoes/UltimaExecucao', () => ({ UltimaExecucao: () => null }));

import AdminReposicaoOportunidades from '../AdminReposicaoOportunidades';

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AdminReposicaoOportunidades />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  porTabela = {};
});

describe('AdminReposicaoOportunidades — falha da lista não vira "economia R$ 0" (C10)', () => {
  it('CONTROLE: leitura boa e vazia → R$ 0,00 e "Nenhuma oportunidade ativa" (aí é verdade)', async () => {
    renderPagina();
    expect(await screen.findByText('Nenhuma oportunidade ativa')).toBeTruthy();
    expect(screen.getAllByText(/0,00/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('aviso-oportunidades')).toBeNull();
  });

  it('ERRO: tabela FALA que não leu e os KPIs dizem "—", nunca R$ 0', async () => {
    porTabela = { v_otimizador_compras_insumos: FALHA };
    renderPagina();
    const aviso = await screen.findByTestId('aviso-oportunidades');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByText('Nenhuma oportunidade ativa')).toBeNull();
    expect(screen.queryAllByText(/0,00/)).toHaveLength(0);
    // ganho líquido, economia, contagem e data limite: os 4 que vêm desta leitura
    expect(screen.getAllByText('Não foi possível carregar').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('Sem janelas ativas')).toBeNull();
  });

  it('ERRO no ciclo do dia: "—", não "Sem ciclo hoje"', async () => {
    porTabela = { fornecedor_aumento_anunciado: FALHA };
    renderPagina();
    await screen.findByText('Nenhuma oportunidade ativa');
    await waitFor(() => expect(screen.queryByText('Sem ciclo hoje')).toBeNull());
    expect(screen.getAllByText('Não foi possível carregar').length).toBeGreaterThanOrEqual(1);
  });

  it('DESATUALIZADO: refetch que falha mantém a linha e avisa que é a leitura anterior', async () => {
    porTabela = { v_otimizador_compras_insumos: { data: [LINHA], error: null } };
    const { qc } = renderPagina();
    expect(await screen.findByText('Verniz Premium')).toBeTruthy();
    expect(screen.queryByTestId('aviso-oportunidades-desatualizadas')).toBeNull();

    porTabela = { v_otimizador_compras_insumos: FALHA };
    await qc.refetchQueries({ queryKey: ['oportunidades-hoje'] });

    const aviso = await screen.findByTestId('aviso-oportunidades-desatualizadas');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(screen.getByText('Verniz Premium')).toBeTruthy();
    expect(screen.queryByTestId('aviso-oportunidades')).toBeNull();
  });
});
