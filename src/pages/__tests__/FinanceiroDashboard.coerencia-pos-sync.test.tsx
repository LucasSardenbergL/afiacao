import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { spBusinessDate } from '@/lib/time/sp-day';

/**
 * Guard da COERÊNCIA TEMPORAL entre as duas pontas do caixa projetado (aba "Fluxo Caixa" de
 * /financeiro).
 *
 * O número da tela é `saldoCC + Σ previsto futuro` (`fluxo-caixa-semanas.ts`): a ÂNCORA é o
 * saldo bancário de HOJE e o delta é só o que ainda NÃO entrou. As duas pontas vêm de estados
 * DIFERENTES do `useFinanceiro` — `resumo` (âncora) e `fluxoCaixa` (previsto) — e o botão
 * "Sincronizar" recarregava só o resumo. Um título que virasse RECEBIDO durante a
 * sincronização já entrava no saldo bancário e continuava contando como entrada futura: a
 * mesma dupla contagem do #2459, agora criada pelo próprio botão. Em prod há 20 títulos
 * RECEBIDO com vencimento futuro (psql-ro, 2026-10-08), então o gatilho existe.
 *
 * O invariante fixado aqui é de PRODUTO, não de implementação: **receber um título a vencer
 * não muda o caixa projetado** — o dinheiro só muda de bolso (sai do previsto, entra na
 * conta). A tela pode mostrar o total certo ou degradar para "—"/skeleton; o que ela não pode
 * é somar âncora NOVA com previsto VELHO e inflar o total.
 *
 * Cenário (o do briefing, com os bolsos separados para a aritmética ficar legível):
 *   antes do sync : banco 1.000 + previsto 4.000  → projetado 5.000   (`R$ 5.0k`)
 *   o sync recebe 2.000 do título a vencer
 *   depois do sync: banco 3.000 + previsto 2.000  → projetado 5.000   (invariante)
 *   defeito       : banco 3.000 + previsto 4.000  → projetado 7.000   (`R$ 7.0k`)
 *
 * `R$ 7.0k` é a marca EXCLUSIVA do defeito e não aparece em nenhum outro KPI do cenário.
 * Como `R$ 5.0k` é o total antes E depois, a ausência do 7.0k sozinha não provaria
 * reconciliação (inércia daria o mesmo) — por isso o teste também exige o sinal POSITIVO:
 * o previsto foi relido (2ª chamada de `getFluxoCaixa`) e o KPI de saldo saiu de `R$ 1.0k`
 * para `R$ 3.0k`.
 *
 * Os hooks rodam de VERDADE; só o service é mockado. Mockar `useFinanceiro` provaria apenas
 * que a tela renderiza um estado que eu mesmo montei, e o defeito mora justamente na
 * reconciliação entre as duas pontas (mesma razão registrada em
 * `FinanceiroIc.leitura-falhou.test.tsx`).
 */

// Um dia DENTRO do horizonte de projeção: `agruparSemanasFluxo` só conta `data >= hoje`.
const HOJE = spBusinessDate(new Date());
const DIA_FUTURO = (() => {
  const d = new Date(HOJE + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
})();

/** O "banco" que o mock serve. `triggerFinanceiroSync` o muda, como o Omie faria. */
let saldoBanco = 1000;
let previstoFuturo = 4000;

const SEM_MOVIMENTO = {
  total_a_pagar: 0,
  total_vencido_receber: 0,
  total_vencido_pagar: 0,
};

/** O resumo vem por empresa e o hook consolida somando; só `oben` carrega o cenário. */
const getResumoFinanceiro = vi.fn(async (companies: string[]) =>
  Object.fromEntries(
    companies.map((co) => [
      co,
      co === 'oben'
        ? {
            contas_correntes: [{ descricao: 'CC', saldo_atual: saldoBanco, banco: 'Banco' }],
            saldo_total_cc: saldoBanco,
            total_a_receber: previstoFuturo,
            ...SEM_MOVIMENTO,
            posicao_liquida: saldoBanco + previstoFuturo,
          }
        : {
            contas_correntes: [],
            saldo_total_cc: 0,
            total_a_receber: 0,
            ...SEM_MOVIMENTO,
            posicao_liquida: 0,
          },
    ]),
  ),
);

/** `falharFluxo` simula a leitura do previsto que ERRA (RLS, timeout, rede). */
let falharFluxo = false;
const getFluxoCaixa = vi.fn(async () => {
  if (falharFluxo) throw new Error('leitura do fluxo falhou');
  return [
  {
    data: DIA_FUTURO,
    entradas_previstas: previstoFuturo,
    entradas_realizadas: 0,
    saidas_previstas: 0,
    saidas_realizadas: 0,
      saldo_previsto: 0,
      saldo_realizado: 0,
    },
  ];
});

/**
 * O sync RECEBE 2.000 do título a vencer: o dinheiro muda de bolso, o total não muda.
 * Com `modoManual`, fica pendente até `liberarSync()` — é como se inspeciona a tela com a
 * sincronização EM VOO, que é onde vive a janela de mistura.
 */
let modoManual = false;
let liberarSync: (() => void) | null = null;
const triggerFinanceiroSync = vi.fn(async () => {
  if (modoManual) await new Promise<void>((res) => { liberarSync = res; });
  saldoBanco = 3000;
  previstoFuturo = 2000;
  return {};
});

vi.mock('@/services/financeiroService', () => ({
  getResumoFinanceiro: (...a: unknown[]) => getResumoFinanceiro(...(a as [string[]])),
  getFluxoCaixa: (...a: unknown[]) => getFluxoCaixa(...(a as [])),
  triggerFinanceiroSync: (...a: unknown[]) => triggerFinanceiroSync(...(a as [])),
  getContasPagar: async () => ({ rows: [], total: 0 }),
  getContasReceber: async () => ({ rows: [], total: 0 }),
  getAgingReceber: async () => null,
  getAgingPagar: async () => null,
  getDRE: async () => [],
  getTopInadimplentes: async () => [],
  getLastSyncTime: async () => null,
  exportDRECSV: () => '',
  downloadCSV: () => undefined,
}));

// Abas irmãs: fora do objeto deste guard e com dependências próprias (react-query, supabase).
vi.mock('@/components/financeiro/dashboard/VisaoGeralTab', () => ({ VisaoGeralTab: () => <div /> }));
vi.mock('@/components/financeiro/dashboard/ContasReceberTab', () => ({ ContasReceberTab: () => <div /> }));
vi.mock('@/components/financeiro/dashboard/ContasPagarTab', () => ({ ContasPagarTab: () => <div /> }));
vi.mock('@/components/financeiro/dashboard/ConcentracaoTab', () => ({ ConcentracaoTab: () => <div /> }));
vi.mock('@/components/financeiro/dashboard/DRETab', () => ({ DRETab: () => <div /> }));
vi.mock('@/components/financeiro/dashboard/DREComparativo', () => ({ DREComparativo: () => <div /> }));
vi.mock('@/components/financeiro/AuditTrailDrawer', () => ({ AuditTrailDrawer: () => <div /> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isMaster: false }) }));

import FinanceiroDashboard from '../FinanceiroDashboard';
import { useFinanceiro } from '@/hooks/useFinanceiro';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FinanceiroDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  saldoBanco = 1000;
  previstoFuturo = 4000;
  modoManual = false;
  liberarSync = null;
  falharFluxo = false;
  getResumoFinanceiro.mockClear();
  getFluxoCaixa.mockClear();
  triggerFinanceiroSync.mockClear();
});

describe('aba Fluxo Caixa: sincronizar não pode inflar o caixa projetado', () => {
  it('receber um título a vencer move o dinheiro de bolso sem mudar o total projetado', async () => {
    montar();

    // Radix seleciona a aba no mouseDown: um click simples não troca o painel.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Fluxo Caixa' }));

    // Linha de base: o total projetado é banco 1.000 + previsto 4.000.
    await waitFor(() => expect(screen.getAllByText('R$ 5.0k').length).toBeGreaterThan(0));
    expect(getFluxoCaixa).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Sincronizar/ }));

    // Sinal POSITIVO de reconciliação: o previsto foi relido e a âncora mudou de valor.
    await waitFor(() => expect(getFluxoCaixa).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('R$ 3.0k').length).toBeGreaterThan(0));

    // O invariante: o total projetado continua 5.000 — e NUNCA 7.000.
    expect(screen.getAllByText('R$ 5.0k').length).toBeGreaterThan(0);
    expect(screen.queryByText('R$ 7.0k')).toBeNull();
  });
});

describe('aba Fluxo Caixa: com o sync em voo a tela não mente nem repete a época anterior', () => {
  it('não exibe o total de antes do sync e não afirma que não há dado', async () => {
    modoManual = true;
    montar();

    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Fluxo Caixa' }));
    await waitFor(() => expect(screen.getAllByText('R$ 5.0k').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Sincronizar/ }));
    await waitFor(() => expect(triggerFinanceiroSync).toHaveBeenCalledTimes(1));

    // Sync EM VOO: o previsto da época anterior já saiu da tela...
    await waitFor(() => expect(screen.queryByText('R$ 5.0k')).toBeNull());
    // ...e a tela não afirma o vazio — o empty state diria "Sincronize os dados primeiro"
    // exatamente enquanto a sincronização acontece.
    expect(screen.queryByText(/Nenhum dado de fluxo de caixa/)).toBeNull();

    liberarSync!();

    // E ao fim o total volta, reconciliado com a âncora nova.
    await waitFor(() => expect(getFluxoCaixa).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('R$ 5.0k').length).toBeGreaterThan(0));
    expect(screen.queryByText('R$ 7.0k')).toBeNull();
  });
});

describe('useFinanceiro: ação que muda o banco não deixa previsto velho em memória', () => {
  it('syncAll invalida o fluxo antes de mexer no banco e sinaliza a nova versão', async () => {
    const { result } = renderHook(() => useFinanceiro('all'));

    await act(async () => {
      await result.current.loadFluxoCaixa('2026-01-01', '2026-12-31');
    });
    expect(result.current.fluxoCaixa).toHaveLength(1);
    const versaoAntes = result.current.versaoDados;

    await act(async () => {
      await result.current.syncAll();
    });

    // Fail-closed: o previsto de antes do sync não sobrevive ao sync. Quem repõe é a tela,
    // pela `versaoDados` — o pior caso é a aba vazia, nunca a soma de duas épocas.
    expect(result.current.fluxoCaixa).toHaveLength(0);
    expect(result.current.versaoDados).toBeGreaterThan(versaoAntes);
  });

  it('carga do previsto que FALHA não deixa o fluxo da leitura anterior na tela', async () => {
    const { result } = renderHook(() => useFinanceiro('all'));

    await act(async () => {
      await result.current.loadFluxoCaixa('2026-01-01', '2026-12-31');
    });
    expect(result.current.fluxoCaixa).toHaveLength(1);

    // Trocar de empresa (ou de janela) e a leitura falhar: o previsto de antes não pode
    // sobreviver sob a âncora nova — é a mesma mistura, por outra porta.
    falharFluxo = true;
    await act(async () => {
      await result.current.loadFluxoCaixa('2026-01-01', '2026-12-31');
    });

    expect(result.current.fluxoCaixa).toHaveLength(0);
    expect(result.current.errosCarga.fluxoCaixa).toBeDefined();
  });
});
