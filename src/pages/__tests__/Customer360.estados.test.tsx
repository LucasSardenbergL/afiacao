import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

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
/** A leitura de `farmer_client_scores` por `.maybeSingle()` (própria e fallback) — F12. */
let respostaScore: () => Promise<Resposta> = () => ok(null);

function consulta(tabela: string): unknown {
  let umaLinha = false;
  const proxy: unknown = new Proxy({}, {
    get(_alvo, prop) {
      if (prop === 'then') {
        // onda D: o contato do core vem de `v_perfil_contato`; o mock serve a MESMA linha (contato visível)
        const resposta = (tabela === 'profiles' || tabela === 'v_perfil_contato') && umaLinha
          ? respostaCore()
          : tabela === 'farmer_client_scores' && umaLinha ? respostaScore() : ok(umaLinha ? null : []);
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
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => consulta(t), rpc: (fn: string) => consulta(`rpc:${fn}`) },
}));
// Papel REAL (escrita) e o EXIBIDO (lente) mudam por teste — onda C, item 5.
let authAtual = { user: { id: 'staff-1' }, isMaster: false, isGestorComercial: false, isStaff: true };
let displayAtual = { displayIsStaff: true, displayIsMaster: false, displayIsGestorComercial: false };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authAtual }));
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: () => displayAtual }));
// O esqueleto não tem âncora própria — o stub dá uma, sem casar classe de estilo.
vi.mock('@/components/ui/page-skeleton', () => ({ PageSkeleton: () => <div data-testid="page-skeleton" /> }));
// Os filhos são do MESMO módulo e têm testes próprios; aqui interessa QUAL ramo a página escolhe.
// O herói stubado mostra o nome — é a prova positiva de que a página abriu com o cliente.
vi.mock('@/components/customer360/CustomerHero', () => ({
  CustomerHero: ({ customer, isPj, scoreSemLeitura, onBack, rotuloVoltar }: {
    customer: { name: string | null }; isPj: boolean; scoreSemLeitura?: string | null;
    onBack: () => void; rotuloVoltar?: string;
  }) => (
    <>
      <h1 data-pj={String(isPj)} data-score-sem-leitura={scoreSemLeitura ?? 'nenhum'}>{customer.name}</h1>
      <button type="button" onClick={onBack}>voltar: {rotuloVoltar}</button>
    </>
  ),
}));
vi.mock('@/components/customer360/CustomerKpiStrip', () => ({ CustomerKpiStrip: () => null }));
vi.mock('@/components/customer360/IdentityColumn', () => ({ IdentityColumn: () => null }));
vi.mock('@/components/customer360/ActivityColumn', () => ({ ActivityColumn: () => null }));
vi.mock('@/components/customer360/AcoesDaFicha', () => ({ AcoesDaFicha: () => <div data-testid="acoes-da-ficha" /> }));

import Customer360 from '../Customer360';

let qc: QueryClient;
function Onde() {
  const l = useLocation();
  return <p data-testid="onde">{l.pathname}{l.search}</p>;
}
function renderPagina(caminho = `/admin/customers/${ID}/360`, state?: unknown) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[{ pathname: caminho, state }]}>
        <Routes>
          <Route path="/admin/customers/:customerId/360" element={<Customer360 />} />
          <Route path="/sem-id/360" element={<Customer360 />} />
          <Route path="*" element={<Onde />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A leitura saiu do 1º fetch — sem isto, afirmar a AUSÊNCIA da mentira passaria antes dela chegar. */
const assentou = () => waitFor(() => expect(screen.queryByTestId(ESQUELETO)).toBeNull());

beforeEach(() => {
  authAtual = { user: { id: 'staff-1' }, isMaster: false, isGestorComercial: false, isStaff: true };
  displayAtual = { displayIsStaff: true, displayIsMaster: false, displayIsGestorComercial: false };
  respostaCore = () => ok(cliente);
  respostaScore = () => ok(null);
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
    expect(
      screen.queryByRole('button', { name: 'Tentar de novo' }),
      'sem rede, a tela ofereceu um "Tentar de novo" que só pausaria de novo — o caminho é a rede voltar',
    ).toBeNull();

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
      // O react-query 5 avisa o React num `setTimeout(0)` (`notifyManager`): sem drenar esse tick DENTRO
      // do act, a asserção lia o DOM de ANTES do erro — a falsificação mediu este teste passando COM a
      // regressão (a página trocada pelo aviso). O `status` abaixo prova o cache; isto, a tela.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // prova positiva de que o refetch FALHOU de fato — sem ela, a página "ficar" seria vacuidade
    expect(qc.getQueryState(['c360-core', ID])?.status).toBe('error');
    // `queryBy`, não `getBy`: o `getBy` LANÇA antes do expect e a mensagem abaixo nunca chegava ao relatório
    expect(screen.queryByText(NOME), 'o refetch falhou e a página trocou o cliente em mãos pelo aviso').not.toBeNull();
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });
});

// `isPj` decide o herói/coluna de identidade (PJ × PF). Era `replace(/\D/g,'').length === 14` — CNPJ
// alfanumérico (RFB jul/2026, 9 dígitos) abria como PF. Oráculo oficial 12.ABC.345/01DE-35; DV errado = inválido.
describe('Customer360 — score que não foi lido chega ao hero como FALHA (F12)', () => {
  const marca = async () => (await screen.findByText(NOME)).getAttribute('data-score-sem-leitura');

  it('leitura do score FALHA → o hero recebe `erro` (antes: descartado, virava "Sem score")', async () => {
    respostaScore = () => falha('57014', 'canceling statement due to statement timeout');
    renderPagina();
    await waitFor(async () => expect(await marca()).toBe('erro'));
  });

  it('ausência legítima (sucesso sem linha) → nenhum aviso', async () => {
    renderPagina();
    await assentou();
    // Espera o score assentar: leitura única sem linha → `null` lido, não falha.
    await waitFor(() => expect(qc.getQueryState(['c360-score', ID])?.status).toBe('success'));
    expect(await marca()).toBe('nenhum');
  });
});

describe('Customer360 — isPj com CNPJ alfanumérico', () => {
  const abrir = async () => {
    renderPagina();
    const h1 = await screen.findByRole('heading', { name: NOME });
    return h1.getAttribute('data-pj');
  };
  it('numérico 14 dígitos: PJ (como antes)', async () => {
    expect(await abrir()).toBe('true');
  });
  it('CNPJ alfanumérico VÁLIDO: PJ', async () => {
    respostaCore = () => ok({ ...cliente, document: '12.ABC.345/01DE-35' });
    expect(await abrir()).toBe('true');
  });
  it('alfanumérico INVÁLIDO: PF, como antes (não se fabrica CNPJ)', async () => {
    respostaCore = () => ok({ ...cliente, document: '12.ABC.345/01DE-36' });
    expect(await abrir()).toBe('false');
  });
  it('CPF: PF', async () => {
    respostaCore = () => ok({ ...cliente, document: '123.456.789-09' });
    expect(await abrir()).toBe('false');
  });
});

describe('Customer360 — lente e origem (onda C)', () => {
  it('na lente, o que a página MOSTRA segue a persona: sem staff exibido, sem as ações da ficha', async () => {
    displayAtual = { displayIsStaff: false, displayIsMaster: false, displayIsGestorComercial: false };
    renderPagina();
    expect(await screen.findByRole('heading', { name: NOME })).toBeTruthy();
    expect(screen.queryByTestId('acoes-da-ficha')).toBeNull();
  });

  it('tarefa por voz (escrita) exige o papel REAL e o da persona: master vendo uma vendedora não a vê', async () => {
    authAtual = { user: { id: 'master-1' }, isMaster: true, isGestorComercial: false, isStaff: true };
    renderPagina();
    expect(await screen.findByRole('heading', { name: NOME })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Criar tarefa por voz/ })).toBeNull();
  });

  it('aberta de Telefonia, o voltar se chama Telefonia e volta para lá', async () => {
    renderPagina(`/admin/customers/${ID}/360`, { origemTela: { rotulo: 'Telefonia', url: '/telefonia?aba=historico' } });
    fireEvent.click(await screen.findByRole('button', { name: 'voltar: Telefonia' }));
    expect(screen.getByTestId('onde').textContent).toBe('/telefonia?aba=historico');
  });

  it('sem origem, volta para a lista crua de Clientes', async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole('button', { name: 'voltar: Clientes' }));
    expect(screen.getByTestId('onde').textContent).toBe('/admin/customers');
  });
});
