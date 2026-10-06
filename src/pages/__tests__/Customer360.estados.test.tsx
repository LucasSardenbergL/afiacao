import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Guard da classe "erro colapsado em vazio" na porta do Customer 360 — a forma que MENTE com
 * especificidade (docs/historico/o-check-verde-que-a-falha-acende.md, achado 3): `useCustomerCore`
 * lê `profiles` com `.maybeSingle()` e LANÇA no erro, então "não existe" (`null` em sucesso) e
 * "não consegui ler" (`undefined`) chegam DISTINTOS — e o `if (!core.data)` da página os fundia em
 * "Cliente não encontrado". O vendedor sai procurando um cliente que existe.
 *
 * O offline é o estado que engana quem "já trata erro": `pending` + `paused`, com `isLoading` FALSE.
 * Por isso a query aqui é a REAL (react-query + supabase mockado) e o offline sai do
 * `onlineManager` — um `UseQueryResult` fabricado à mão provaria só o que eu imaginei dele.
 */
const ID = 'cli-1';
const NOME = 'Marcenaria Exemplo Ltda';
const NAO_ENCONTRADO = 'Cliente não encontrado';
const AVISO = 'aviso-c360-cliente';
const ESQUELETO = 'page-skeleton';

type Resposta = { data: unknown; error: { message: string; code?: string } | null };
const ok = (data: unknown): Promise<Resposta> => Promise.resolve({ data, error: null });
const falha = (code: string, message: string): Promise<Resposta> => Promise.resolve({ data: null, error: { code, message } });
const cliente = {
  user_id: ID, name: NOME, email: null, phone: null, document: '12345678000199', customer_type: null,
  cnae: null, requires_po: false, created_at: '2026-01-01T00:00:00Z', avatar_url: null, is_approved: true,
};

/** A leitura de `profiles` por `.maybeSingle()` é a do core; o resto da página lê vazio. */
let respostaCore: () => Promise<Resposta> = () => ok(cliente);

function consulta(tabela: string): unknown {
  let umaLinha = false;
  const proxy: unknown = new Proxy({}, {
    get(_alvo, prop) {
      if (prop === 'then') {
        const resposta = tabela === 'profiles' && umaLinha ? respostaCore() : ok(umaLinha ? null : []);
        return (sim: (v: Resposta) => unknown, nao?: (e: unknown) => unknown) => resposta.then(sim, nao);
      }
      return () => {
        if (prop === 'maybeSingle' || prop === 'single') umaLinha = true;
        return proxy;
      };
    },
  });
  return proxy;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => consulta(t) } }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'staff-1' }, isMaster: false, isGestorComercial: false, isStaff: true }),
}));
// O esqueleto não tem âncora própria — o stub dá uma, sem casar classe de estilo.
vi.mock('@/components/ui/page-skeleton', () => ({ PageSkeleton: () => <div data-testid="page-skeleton" /> }));
// Os filhos são do MESMO módulo e têm testes próprios; aqui interessa QUAL ramo a página escolhe.
// O herói stubado mostra o nome — é a prova positiva de que a página abriu com o cliente.
vi.mock('@/components/customer360/CustomerHero', () => ({
  CustomerHero: ({ customer }: { customer: { name: string | null } }) => <h1>{customer.name}</h1>,
}));
vi.mock('@/components/customer360/CustomerKpiStrip', () => ({ CustomerKpiStrip: () => null }));
vi.mock('@/components/customer360/IdentityColumn', () => ({ IdentityColumn: () => null }));
vi.mock('@/components/customer360/ActivityColumn', () => ({ ActivityColumn: () => null }));

import Customer360 from '../Customer360';

let qc: QueryClient;
function renderPagina(caminho = `/admin/customers/${ID}/360`) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[caminho]}>
        <Routes>
          <Route path="/admin/customers/:customerId/360" element={<Customer360 />} />
          <Route path="/sem-id/360" element={<Customer360 />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A leitura saiu do 1º fetch — sem isto, afirmar a AUSÊNCIA da mentira passaria antes dela chegar. */
const assentou = () => waitFor(() => expect(screen.queryByTestId(ESQUELETO)).toBeNull());

beforeEach(() => {
  respostaCore = () => ok(cliente);
  onlineManager.setOnline(true);
});
afterEach(() => {
  onlineManager.setOnline(true);
});

describe('Customer360 — "não consegui ler" NÃO pode virar "cliente não encontrado"', () => {
  it('carregando: esqueleto — nem aviso, nem "não encontrado"', async () => {
    respostaCore = () => new Promise<Resposta>(() => {});
    renderPagina();
    expect(await screen.findByTestId(ESQUELETO)).toBeTruthy();
    expect(screen.queryByTestId(AVISO)).toBeNull();
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });

  it('pronta: a página abre com o cliente', async () => {
    renderPagina();
    expect(await screen.findByText(NOME)).toBeTruthy();
    expect(screen.queryByTestId(AVISO)).toBeNull();
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });

  it('inexistente (`null` em SUCESSO): "Cliente não encontrado" — a única frase que a resposta autoriza', async () => {
    respostaCore = () => ok(null);
    renderPagina();
    expect(await screen.findByText(NAO_ENCONTRADO)).toBeTruthy();
    expect(screen.queryByTestId(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa que não conseguiu, e "Tentar de novo" abre o cliente quando o banco volta', async () => {
    respostaCore = () => falha('57014', 'canceling statement due to statement timeout');
    renderPagina();
    await assentou();
    expect(screen.queryByText(NAO_ENCONTRADO), 'a leitura FALHOU e a tela afirmou que o cliente não existe').toBeNull();
    expect(screen.getByTestId(AVISO).getAttribute('data-estado')).toBe('erro');

    respostaCore = () => ok(cliente);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText(NOME)).toBeTruthy();
    expect(screen.queryByTestId(AVISO)).toBeNull();
  });

  it('SEM REDE na 1ª carga (pending+paused, `isLoading` FALSE): avisa, e a página abre sozinha quando a rede volta', async () => {
    onlineManager.setOnline(false);
    renderPagina();
    await assentou();
    expect(screen.queryByText(NAO_ENCONTRADO), 'sem rede, a tela afirmou que o cliente não existe').toBeNull();
    expect(screen.getByTestId(AVISO).getAttribute('data-estado')).toBe('sem-rede');
    // tentar de novo sem rede não faz nada (a query pausa de novo) — o caminho é a rede voltar
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();

    act(() => onlineManager.setOnline(true));
    expect(await screen.findByText(NOME)).toBeTruthy();
    expect(screen.queryByTestId(AVISO)).toBeNull();
  });

  it('sem id na URL (`enabled:false`): a pergunta não foi feita — "não encontrado", nunca aviso de falha', async () => {
    renderPagina('/sem-id/360');
    expect(await screen.findByText(NAO_ENCONTRADO)).toBeTruthy();
    expect(screen.queryByTestId(AVISO)).toBeNull();
  });

  it('refetch FALHA com o cliente em mãos: a página FICA — o erro não tem precedência sobre o dado', async () => {
    renderPagina();
    expect(await screen.findByText(NOME)).toBeTruthy();

    respostaCore = () => falha('57014', 'canceling statement due to statement timeout');
    await act(async () => {
      await qc.refetchQueries();
    });
    // prova positiva de que o refetch FALHOU de fato — sem ela, a página "ficar" seria vacuidade
    expect(qc.getQueryState(['c360-core', ID])?.status).toBe('error');
    expect(screen.getByText(NOME), 'o refetch falhou e a página trocou o cliente em mãos pelo aviso').toBeTruthy();
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });
});
