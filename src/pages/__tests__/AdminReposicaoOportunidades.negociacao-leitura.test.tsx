import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Guard da FATIA DE GATILHO — `v_sugestao_negociacao_ativa` tem 0 linhas em prod
 * (psql-ro, 2026-09-06). Dano hoje zero; a partir da primeira sugestão o banner some calado
 * (docs/historico/a-forma-que-some-e-a-forma-que-mente.md).
 *
 * ⚠️ Aqui o defeito é de DUAS camadas, e por isso o teste começa pelo `queryFn`:
 * `const { count } = await supabase…; return count ?? 0` **engole o erro** — a query fica
 * `success` com 0, `error` nunca popula e `<AvisoLeituraFalhou>` seria INALCANÇÁVEL por
 * construção. Trocar só o `&&` por `estadoDeLeitura` seria um *fix inerte*: diff plausível,
 * zero mudança de comportamento (a armadilha do `?? 0` do UnifiedOrder, 2026-08-22).
 * Por isso o primeiro caso afirma o estado da QUERY, não só o pixel.
 *
 * A query roda de verdade; só o supabase é mockado, roteado por tabela para que a falha seja
 * a da view do banner e não um apagão geral que qualquer asserção pegaria.
 */

type Resposta = { data: unknown; error: { message: string } | null; count?: number | null };

let respostaNegociacao: Resposta = { data: null, error: null, count: 0 };
const OK_VAZIO: Resposta = { data: [], error: null, count: 0 };

function builder(resposta: () => Resposta) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'eq', 'in', 'gte', 'lte']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) => Promise.resolve(resposta()).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) =>
      builder(() => (tabela === 'v_sugestao_negociacao_ativa' ? respostaNegociacao : OK_VAZIO)),
    rpc: () => Promise.resolve({ data: [], error: null }),
    functions: { invoke: () => Promise.resolve({ data: {}, error: null }) },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
  respostaNegociacao = { data: null, error: null, count: 0 };
});
afterEach(() => { onlineManager.setOnline(true); vi.restoreAllMocks(); });

describe('AdminReposicaoOportunidades — o queryFn do banner precisa PROPAGAR o erro', () => {
  it('a query de sugestões entra em ERRO quando o select falha (hoje ela engole)', async () => {
    respostaNegociacao = { data: null, error: { message: 'permission denied' }, count: null };
    const { qc } = renderPagina();

    // O assert que impede o fix inerte: sem isto, a UI nunca teria como saber que falhou.
    await waitFor(() => {
      const estado = qc.getQueryState(['negociacao-paralela-sugestoes-count']);
      expect(estado?.status).toBe('error');
    });
  });

  it('ERRO: a tela FALA que não conseguiu ler as sugestões — não fica muda', async () => {
    respostaNegociacao = { data: null, error: { message: 'permission denied' }, count: null };
    renderPagina();

    expect(await screen.findByTestId('aviso-negociacao')).toBeTruthy();
  });

  it('ZERO real: nem banner nem aviso — não há sugestão mesmo', async () => {
    respostaNegociacao = { data: [], error: null, count: 0 };
    const { container } = renderPagina();

    await waitFor(() => expect(container.textContent).toContain('Oportunidades'));
    expect(screen.queryByTestId('aviso-negociacao')).toBeNull();
    expect(container.textContent).not.toMatch(/negociação paralela/i);
  });

  it('COM sugestões: o banner aparece com o total real', async () => {
    respostaNegociacao = { data: [], error: null, count: 3 };
    renderPagina();

    expect(await screen.findByText(/foram sugeridos/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-negociacao')).toBeNull();
  });

  it('OFFLINE: diz que falta rede em vez de sumir', async () => {
    onlineManager.setOnline(false);
    respostaNegociacao = { data: [], error: null, count: 3 };
    renderPagina();

    const aviso = await screen.findByTestId('aviso-negociacao');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
  });
});
