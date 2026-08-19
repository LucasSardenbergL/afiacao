import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — a falha do scoring tem de CHEGAR ao dashboard do farmer.
 *
 * O `useFarmerScoring` engolia a exceção num `console.error` e só encerrava o loading. Com o
 * `fetchAllPages` lançando em página perdida/malformada (#1581), esse buraco ficou mais
 * alcançável: em COLD LOAD com falha, `clientScores === []` e o dashboard renderiza "Saúde da
 * Carteira: 0 clientes" + "Nenhum cliente na agenda. Clique em 'Recalcular' para gerar" — dois
 * conselhos errados sobre um estado que não é o real. O farmer conclui que a carteira está
 * vazia; a verdade é que a leitura falhou.
 *
 * Contrato (§7 do money-path.md): sob falha SEM dado, a tela diz "indisponível" e oferece
 * retry; sob falha COM dado (ex.: troca de lente com o backend caindo), mantém o último estado
 * bom e avisa que está desatualizado.
 *
 * O hook roda de VERDADE (só o supabase é mockado): a cadeia leitura→scoring→tela é o que
 * precisa ser honesto — mockar o hook provaria apenas que a página renderiza um estado que eu
 * mesmo montei.
 */

const FARMER_A = 'farmer-a';

let falharScores = false;
let falharFaixas = false;
let falharCarteira = false;
let farmerAtual = FARMER_A;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

// Um pedido de um cliente com profile: o suficiente para o scoring produzir 1 score e a agenda
// exibir "Cliente Um" (quota de risco).
const PEDIDOS = [{
  id: 'o1', customer_user_id: 'c1', items: [], total: 100,
  created_at: '2026-07-01T00:00:00Z', order_date_kpi: null, status: 'confirmado',
}];
const PERFIS = [{ user_id: 'c1', name: 'Cliente Um', phone: null }];

// A margem vem da RPC `get_carteira_margem_faixa` (FU4-F fase 3): o hook não baixa mais
// `product_costs`. `margem_pct: null` com `faixa` presente é o caller SEM `cap_custo_ler` —
// o número fecha, o sinal fica.
const FAIXAS = [{ customer_user_id: 'c1', faixa: 'verde', motivo: 'saudavel', g: 0.8, margem_pct: null }];

// A tela do farmer é recortada pela CARTEIRA visível (decisão de 2026-08-14): sem um assignment
// para `c1`, o fail-closed de `filtrarPorCarteira` esvazia a lista — e é isso que deve acontecer.
const CARTEIRA = [{ customer_user_id: 'c1' }];

function resposta(table: string): unknown {
  if (table === 'sales_orders') {
    if (falharScores) return { data: null, error: ERRO_TIMEOUT };
    return { data: PEDIDOS, error: null };
  }
  if (table === 'profiles') return { data: PERFIS, error: null };
  if (table === 'carteira_assignments') {
    if (falharCarteira) return { data: null, error: ERRO_TIMEOUT };
    return { data: CARTEIRA, error: null };
  }
  return { data: [], error: null, count: 0 };
}

function respostaRpc(fn: string): unknown {
  if (fn === 'get_carteira_margem_faixa') {
    if (falharScores || falharFaixas) return { data: null, error: ERRO_TIMEOUT };
    return { data: FAIXAS, error: null };
  }
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (fn: string) => {
      const r = respostaRpc(fn);
      // A leitura de vendáveis é PAGINADA (`fetchAllPages`) desde que o cap de 1.000 do
      // PostgREST truncou a RPC em prod — e o builder de `.rpc()` expõe `.order()`/`.range()`
      // como o de `.from()`. O dublê precisa expor também, senão testa uma API que não existe.
      const c: Record<string, unknown> = {
        order: () => c,
        range: () => c,
        then: (resolve: (v: unknown) => void) => resolve(r),
      };
      return c;
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: farmerAtual }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: FARMER_A }, isStaff: true, isMaster: false, loading: false }),
}));
// Vendedora SEM `cap_carteira_ler`: é quem sofre o recorte da carteira (gestor/master lê tudo, e
// para ele o filtro é inerte — medido: 835→835, zero slots trocados).
vi.mock('@/hooks/useCommercialRole', () => ({
  useCommercialRole: () => ({ canViewManagerial: false, loading: false }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import FarmerDashboard from '../FarmerDashboard';
import { TooltipProvider } from '@/components/ui/tooltip';

// SlaVencidoCard (filho) usa react-query e o card da agenda usa Tooltip — no app os dois
// providers vêm do App.tsx; aqui são infra do teste, não do contrato.
const renderDashboard = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <FarmerDashboard />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const utils = render(ui());
  return { ...utils, rerenderDashboard: () => utils.rerender(ui()) };
};

beforeEach(() => {
  falharScores = false;
  falharFaixas = false;
  falharCarteira = false;
  farmerAtual = FARMER_A;
  vi.clearAllMocks();
});

describe('FarmerDashboard — falha do scoring não vira "carteira vazia"', () => {
  it('DETECTOR: o caminho feliz renderiza a agenda e nenhum alerta', async () => {
    // Sem isto, "não achei o alerta" e "a tela nem montou" seriam indistinguíveis.
    renderDashboard();

    expect(await screen.findByText('Cliente Um')).toBeTruthy();
    expect(screen.getByText(/1 clientes/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('anuncia indisponibilidade + retry em vez de "Nenhum cliente na agenda"', async () => {
    falharScores = true;

    renderDashboard();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'o alerta não diz que a carteira está indisponível').toMatch(/indispon/i);
    // O empty state de sucesso manda "Recalcular para gerar" — sob falha isso afirma
    // "não existe" onde a verdade é "não consegui ler".
    expect(
      screen.queryByText(/Nenhum cliente na agenda/i),
      'afirmou carteira vazia onde a verdade é falha de leitura',
    ).toBeNull();
    // O resumo com "0 clientes" seria a mesma mentira em número.
    expect(screen.queryByText(/\b0 clientes\b/), 'exibiu "0 clientes" fabricado').toBeNull();
    expect(
      screen.getByRole('button', { name: /Tentar novamente/i }),
      'sem retry o farmer fica preso no estado de erro',
    ).toBeTruthy();
  });

  it('falha SÓ da margem (RPC) também é erro honesto, não carteira sem margem em silêncio', async () => {
    // Os pedidos LEEM BEM e só `get_carteira_margem_faixa` cai: o caminho que o rebase do
    // #1543 quase perdeu. A versão original do PR fazia `console.error` + `return`, e o
    // `?? []` sobre a resposta pontuava TODA a carteira como "sem custo conhecido" — um
    // veredito fabricado, indistinguível de medição real, sem nada na tela avisando.
    falharFaixas = true;

    renderDashboard();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'a falha da margem morreu no console').toMatch(/indispon/i);
    expect(
      screen.queryByText(/Nenhum cliente na agenda/i),
      'afirmou carteira vazia onde a verdade é falha ao ler a margem',
    ).toBeNull();
  });

  it('falha ao ler a CARTEIRA é erro honesto — não a tela vazia que o fail-closed produziria', async () => {
    // A carteira virou o universo da tela (2026-08-14), e com isso ganhou o poder de esvaziá-la:
    // `filtrarPorCarteira` é fail-closed, então carteira vazia ⇒ zero clientes. Isso é CERTO para
    // uma vendedora genuinamente sem carteira e seria uma MENTIRA para um timeout de leitura —
    // as duas situações chegam aqui como "nenhum id". Quem as separa é o `fetchAllPages`, que
    // LANÇA em página que falha em vez de devolver lista curta (money-path.md §6).
    // Sem este teste, uma futura troca do helper por `.select()` cru trocaria "não consegui ler"
    // por "você não tem clientes", que é exatamente o bug que este arquivo inteiro persegue.
    falharCarteira = true;

    renderDashboard();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'a falha ao ler a carteira morreu no console').toMatch(/indispon/i);
    expect(
      screen.queryByText(/Nenhum cliente na agenda/i),
      'afirmou carteira vazia onde a verdade é falha ao ler a carteira',
    ).toBeNull();
  });

  it('o retry recarrega de verdade: backend recuperado → agenda aparece', async () => {
    falharScores = true;

    renderDashboard();
    await screen.findByRole('alert');

    falharScores = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    expect(await screen.findByText('Cliente Um')).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  });

  it('mantém o último estado bom + aviso quando a troca de farmer falha a leitura', async () => {
    // Cenário real do stale: dados do farmer A na tela, lente troca para B, releitura falha.
    // Descartar o que está na mão trocaria uma mentira por outra; o contrato é manter + avisar.
    const { rerenderDashboard } = renderDashboard();
    await screen.findByText('Cliente Um');

    falharScores = true;
    farmerAtual = 'farmer-b';
    rerenderDashboard();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'nada avisa que os números são de antes').toMatch(/última leitura|desatualizad/i);
    expect(screen.getByText('Cliente Um'), 'descartou o último estado bom').toBeTruthy();
  });
});
