import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Plano v7, C8 — os 3 KPIs de /admin/reposicao/cadastros e o "Histórico de ciclos".
 *
 * Antes: `if (error) return 0` / `return []` no `queryFn`. A query ficava `success`, e a tela
 * dizia "SKUs sem cadeia logística: 0" (= tudo mapeado) e "Nenhum ciclo encontrado" quando a
 * leitura tinha caído. O CONTROLE (mesma tela, leitura boa com zero) fica no mesmo arquivo: a
 * suíte só vale se o zero de verdade continuar aparecendo como "0".
 *
 * A query roda de verdade; só o supabase é mockado, roteado por TABELA, para a falha ser a da
 * leitura em causa e não um apagão que qualquer asserção pegaria.
 */

type Resposta = { data: unknown; error: { message: string } | null; count?: number | null };

const OK_ZERO: Resposta = { data: [], error: null, count: 0 };
const FALHA: Resposta = { data: null, error: { message: 'permission denied' }, count: null };
let porTabela: Record<string, Resposta> = {};

function builder(resposta: () => Resposta) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'eq', 'in', 'gte', 'lte', 'gt']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) => Promise.resolve(resposta()).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (tabela: string) => builder(() => porTabela[tabela] ?? OK_ZERO) },
}));
// As tabs auxiliares são lazy e fora do escopo; só a de pedidos (default) renderiza.
vi.mock('../AdminReposicaoCadeiaLogistica', () => ({ default: () => null }));
vi.mock('../AdminReposicaoGruposProducao', () => ({ default: () => null }));
vi.mock('../AdminSkuMapeamento', () => ({ default: () => null }));

import AdminReposicaoCadastros from '../AdminReposicaoCadastros';

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AdminReposicaoCadastros />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  porTabela = {};
});

describe('AdminReposicaoCadastros — leitura que falha não vira 0 nem lista vazia (C8)', () => {
  it('CONTROLE: leitura boa com zero mostra "0" (pronta) e "Nenhum ciclo"', async () => {
    renderPagina();
    const card = await screen.findByTestId('kpi-skus-sem-cadeia');
    await waitFor(() => expect(card.getAttribute('data-estado')).toBe('pronta'));
    expect(within(card).getByText('0')).toBeTruthy();
    expect(await screen.findByText('Nenhum ciclo encontrado para o período')).toBeTruthy();
  });

  it('a query de SKUs sem cadeia entra em ERRO quando uma das duas leituras falha', async () => {
    porTabela = { sku_grupo_producao: FALHA };
    const { qc } = renderPagina();
    // O assert que impede o fix inerte: com `return 0` a query fica `success`.
    await waitFor(() =>
      expect(qc.getQueryState(['cadastros-skus-sem-cadeia', 'OBEN'])?.status).toBe('error'),
    );
  });

  it('ERRO: "SKUs sem cadeia logística" mostra "—" com o motivo, não "0"', async () => {
    porTabela = { sku_parametros: FALHA };
    renderPagina();
    const card = await screen.findByTestId('kpi-skus-sem-cadeia');
    await waitFor(() => expect(card.getAttribute('data-estado')).toBe('erro'));
    expect(within(card).getByText('—')).toBeTruthy();
    expect(within(card).getByText('Não foi possível carregar')).toBeTruthy();
    expect(within(card).queryByText('0')).toBeNull();
  });

  it('ERRO: pedidos abertos e grupos também dizem "—" em falha', async () => {
    porTabela = { pedido_compra_sugerido: FALHA, fornecedor_grupo_producao: FALHA };
    renderPagina();
    for (const id of ['kpi-pedidos-abertos', 'kpi-grupos-producao']) {
      const card = await screen.findByTestId(id);
      await waitFor(() => expect(card.getAttribute('data-estado')).toBe('erro'));
      expect(within(card).queryByText('0')).toBeNull();
    }
  });

  it('ERRO no histórico de ciclos: aviso de leitura, NÃO "Nenhum ciclo encontrado"', async () => {
    porTabela = { pedido_compra_sugerido: FALHA };
    renderPagina();
    const aviso = await screen.findByTestId('aviso-historico-ciclos');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByText('Nenhum ciclo encontrado para o período')).toBeNull();
  });
});
