import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentType } from 'react';

/**
 * Guard da FATIA DE GATILHO — `fin_ic_matches` tem 0 linhas em prod (psql-ro, 2026-09-06),
 * então o dano HOJE é zero. É exatamente por isso que se corrige AGORA: a partir da primeira
 * linha o aviso some calado e ninguém liga o sumiço à falha de leitura
 * (docs/historico/a-forma-que-some-e-a-forma-que-mente.md, §"Dano hoje ZERO ⇒ chip com gatilho").
 *
 * O defeito tem os DOIS sub-tipos da classe no mesmo hook:
 *   - `{totalIc > 0 && <⚠ N pendências IC>}` em Fechamento e Intercompany — o aviso SOME.
 *     `useIcMatches` LANÇA (`if (error) throw error`), logo `data` fica `undefined`, o
 *     `(icDiv?.length ?? 0)` vira 0 e a soma vira 0 — a MESMA condição do zero real. Numa
 *     tela de FECHAMENTO CONTÁBIL a ausência afirma "não há pendência intercompany".
 *   - `{!isLoading && (!data || data.length === 0) && "Nenhum registro encontrado"}` na Fila —
 *     o sub-tipo que MENTE: afirma o vazio com palavras sobre uma leitura que não aconteceu.
 *
 * Os HOOKS rodam de verdade; só o supabase é mockado. Mockar `useIcMatches` provaria apenas que
 * a página renderiza um estado que eu mesmo montei — e o defeito mora justamente na tradução
 * "select falhou" → "data undefined" → "tela igual à do zero".
 */

type Resposta = { data: unknown; error: { message: string } | null };
let respostaIc: Resposta = { data: [], error: null };

/** Builder encadeável mínimo do PostgREST: select/order/limit/eq devolvem `this` e o objeto é thenable. */
function builder(resposta: () => Resposta) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'eq', 'in', 'update']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) => Promise.resolve(resposta()).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => builder(() => respostaIc),
    rpc: () => Promise.resolve({ data: [], error: null }),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u1' } } }) },
    functions: { invoke: () => Promise.resolve({ data: {}, error: null }) },
  },
}));

// Serviços que não são o objeto deste guard — a página os chama no mount.
vi.mock('@/services/financeiroV2Service', () => ({
  getFechamentos: () => Promise.resolve([]),
  criarFechamento: () => Promise.resolve(),
  atualizarFechamento: () => Promise.resolve(),
  getFechamentoLog: () => Promise.resolve([]),
  getEliminacoes: () => Promise.resolve([]),
  upsertEliminacao: () => Promise.resolve(),
  deleteEliminacao: () => Promise.resolve(),
}));
vi.mock('@/services/financeiroService', () => ({ triggerFinanceiroSync: () => Promise.resolve() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import FinanceiroFechamento from '../FinanceiroFechamento';
import FinanceiroIntercompany from '../FinanceiroIntercompany';
import FinanceiroIntercompanyFila from '../FinanceiroIntercompanyFila';

function renderPagina(Pagina: ComponentType) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Pagina />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const UM_MATCH = [
  {
    id: 'm1', empresa_origem: 'oben', empresa_destino: 'colacor', cr_id: 'cr1', cp_id: null,
    valor_origem: 100, valor_destino: 90, diff_valor: 10, diff_dias: 1,
    status: 'divergencia_valor', matched_at: '2026-09-01T00:00:00Z', observacao: null,
  },
];

beforeEach(() => { respostaIc = { data: [], error: null }; });
afterEach(() => { onlineManager.setOnline(true); vi.restoreAllMocks(); });

describe('FinanceiroFechamento — o alerta IC não pode sumir quando a leitura falha', () => {
  it('ERRO: a tela FALA que não conseguiu ler as pendências IC', async () => {
    respostaIc = { data: null, error: { message: 'timeout' } };
    renderPagina(FinanceiroFechamento);

    // Antes: `totalIc` caía a 0 e o bloco inteiro sumia — fechamento contábil sem sinal.
    expect(await screen.findByTestId('aviso-ic-fechamento')).toBeTruthy();
  });

  it('ZERO real: nada de aviso e nada de alerta — ausência de pendência é verdade', async () => {
    respostaIc = { data: [], error: null };
    const { container } = renderPagina(FinanceiroFechamento);

    await waitFor(() => expect(container.textContent).toContain('Fechamento'));
    expect(screen.queryByTestId('aviso-ic-fechamento')).toBeNull();
    expect(container.textContent).not.toMatch(/pendências IC/i);
  });

  it('ERRO e ZERO são telas DIFERENTES — é isto que o `&&` colapsava', async () => {
    respostaIc = { data: [], error: null };
    const zero = renderPagina(FinanceiroFechamento);
    await waitFor(() => expect(zero.container.textContent).toContain('Fechamento'));
    const textoZero = zero.container.textContent ?? '';
    zero.unmount();

    respostaIc = { data: null, error: { message: 'timeout' } };
    const erro = renderPagina(FinanceiroFechamento);
    await screen.findByTestId('aviso-ic-fechamento');
    const textoErro = erro.container.textContent ?? '';

    expect(textoErro).not.toBe(textoZero);
    // E o texto precisa DESFAZER a leitura errada, não só ser diferente.
    expect(textoErro).toMatch(/não quer dizer que está tudo certo/i);
  });

  it('COM pendência: o alerta aparece com o total real', async () => {
    respostaIc = { data: UM_MATCH, error: null };
    renderPagina(FinanceiroFechamento);

    // duas queries (divergencia_valor + sem_contrapartida), 1 linha cada = 2
    expect(await screen.findByText(/2 pendências IC/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-ic-fechamento')).toBeNull();
  });

  it('OFFLINE: fica na tela dizendo que falta REDE — não some', async () => {
    onlineManager.setOnline(false);
    respostaIc = { data: UM_MATCH, error: null }; // o banco responderia; é a rede que não deixa sair
    renderPagina(FinanceiroFechamento);

    const aviso = await screen.findByTestId('aviso-ic-fechamento');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
  });
});

describe('FinanceiroIntercompany — mesmo alerta, mesma regra', () => {
  it('ERRO: a tela FALA que não conseguiu ler as pendências IC', async () => {
    respostaIc = { data: null, error: { message: 'timeout' } };
    renderPagina(FinanceiroIntercompany);

    expect(await screen.findByTestId('aviso-ic-intercompany')).toBeTruthy();
  });

  it('ZERO real: silêncio é a resposta certa', async () => {
    respostaIc = { data: [], error: null };
    const { container } = renderPagina(FinanceiroIntercompany);

    await waitFor(() => expect(container.textContent).toContain('Consolidação Intercompany'));
    expect(screen.queryByTestId('aviso-ic-intercompany')).toBeNull();
    expect(container.textContent).not.toMatch(/pendências IC/i);
  });
});

describe('FinanceiroIntercompanyFila — o sub-tipo que MENTE', () => {
  it('ERRO: NÃO afirma "Nenhum registro encontrado" — diz que não conseguiu ler', async () => {
    respostaIc = { data: null, error: { message: 'timeout' } };
    const { container } = renderPagina(FinanceiroIntercompanyFila);

    expect(await screen.findByTestId('aviso-ic-fila')).toBeTruthy();
    // A frase falsa é o dano: afirmar o vazio sobre uma leitura que não aconteceu.
    expect(container.textContent).not.toMatch(/Nenhum registro encontrado/i);
  });

  it('ERRO: o contador do título não pode afirmar "0 registros"', async () => {
    respostaIc = { data: null, error: { message: 'timeout' } };
    const { container } = renderPagina(FinanceiroIntercompanyFila);

    await screen.findByTestId('aviso-ic-fila');
    // `{data?.length ?? 0} registros` fabrica um zero a partir de ausência (`Number(null)===0`).
    expect(container.textContent).not.toMatch(/0 registros/i);
  });

  it('ZERO real: aí sim a frase "Nenhum registro encontrado" é verdadeira', async () => {
    respostaIc = { data: [], error: null };
    const { container } = renderPagina(FinanceiroIntercompanyFila);

    expect(await screen.findByText(/Nenhum registro encontrado/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-ic-fila')).toBeNull();
    expect(container.textContent).toMatch(/0 registros/i);
  });

  it('OFFLINE: não afirma vazio — diz que falta rede', async () => {
    onlineManager.setOnline(false);
    respostaIc = { data: UM_MATCH, error: null };
    const { container } = renderPagina(FinanceiroIntercompanyFila);

    const aviso = await screen.findByTestId('aviso-ic-fila');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    expect(container.textContent).not.toMatch(/Nenhum registro encontrado/i);
  });
});
