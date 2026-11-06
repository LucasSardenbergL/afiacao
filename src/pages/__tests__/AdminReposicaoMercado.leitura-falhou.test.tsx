import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Plano v7, C9 — os 4 KPIs de /admin/reposicao/mercado.
 *
 * Dois defeitos, e o teste cobre os dois:
 *  1. "Promoções vigentes" fazia `if (error) return 0` e fixava `unavailable: false`;
 *  2. o render COMUM imprimia `c.value` sempre: os 3 irmãos que levavam `unavailable` saíam
 *     "0" + "Sem dados disponíveis", ou seja, zero com ressalva. Indisponível agora é "—".
 * O CONTROLE (leitura boa → o número) fica no mesmo arquivo.
 */

type Resposta = { data: unknown; error: { message: string } | null; count?: number | null };

const FALHA: Resposta = { data: null, error: { message: 'permission denied' }, count: null };
let porTabela: Record<string, Resposta> = {};
const OK = (count: number): Resposta => ({ data: null, error: null, count });

function builder(resposta: () => Resposta) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'eq', 'in', 'gte', 'lte', 'gt']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) => Promise.resolve(resposta()).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (tabela: string) => builder(() => porTabela[tabela] ?? OK(0)) },
}));
vi.mock('../AdminReposicaoOportunidades', () => ({ default: () => null }));
vi.mock('../AdminReposicaoPromocoes', () => ({ default: () => null }));
vi.mock('../AdminReposicaoAumentos', () => ({ default: () => null }));
vi.mock('../AdminReposicaoNegociacaoParalela', () => ({ default: () => null }));

import AdminReposicaoMercado from '../AdminReposicaoMercado';

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AdminReposicaoMercado />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  porTabela = {};
});

describe('AdminReposicaoMercado — indisponível é "—" com motivo, não 0 (C9)', () => {
  it('CONTROLE: leitura boa mostra o número lido', async () => {
    porTabela = { promocao_campanha: OK(3) };
    renderPagina();
    const card = await screen.findByTestId('kpi-promocoes-vigentes');
    await waitFor(() => expect(card.getAttribute('data-estado')).toBe('pronta'));
    expect(within(card).getByText('3')).toBeTruthy();
  });

  it('a query de promoções entra em ERRO quando o select falha', async () => {
    porTabela = { promocao_campanha: FALHA };
    const { qc } = renderPagina();
    await waitFor(() =>
      expect(qc.getQueryState(['mercado-promocoes-vigentes'])?.status).toBe('error'),
    );
  });

  it('ERRO: "Promoções vigentes" mostra "—" com o motivo, não "0"', async () => {
    porTabela = { promocao_campanha: FALHA };
    renderPagina();
    const card = await screen.findByTestId('kpi-promocoes-vigentes');
    await waitFor(() => expect(card.getAttribute('data-estado')).toBe('erro'));
    expect(within(card).getByText('—')).toBeTruthy();
    expect(within(card).getByText('Não foi possível carregar')).toBeTruthy();
    expect(within(card).queryByText('0')).toBeNull();
  });

  it('ERRO nos 3 irmãos: o render comum também diz "—", não "0" com ressalva', async () => {
    porTabela = {
      v_oportunidade_economica_hoje: FALHA,
      fornecedor_aumento_anunciado: FALHA,
      v_sugestao_negociacao_ativa: FALHA,
    };
    renderPagina();
    for (const id of ['kpi-oportunidades-ativas', 'kpi-aumentos-30d', 'kpi-negociacoes-sugeridas']) {
      const card = await screen.findByTestId(id);
      await waitFor(() => expect(card.getAttribute('data-estado')).toBe('erro'));
      expect(within(card).getByText('—')).toBeTruthy();
      expect(within(card).queryByText('0')).toBeNull();
    }
  });
});
