import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * #3401 — o card de caixa × fila de compras.
 *
 * 1. O piso inclui o saldo de HOJE: a compra à vista sai hoje, e o fechamento semanal sozinho
 *    escondia o caixa negativo antes do recebimento da sexta.
 * 2. A leitura das 03:59 SP não sobrevive à virada das 04h: a RPC julga o saldo pela régua do
 *    instante da leitura, e das 04h em diante o saldo de ontem já é velho. O staleTime de 5 min,
 *    sem refetch no foco, deixava o número velho na tela.
 *
 * O relógio é controlado; o supabase é mockado e o componente roda de verdade.
 */
let respostaRpc: { data: unknown; error: null } = { data: [], error: null };
const rpc = vi.fn(() => Promise.resolve(respostaRpc));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...(args as [])),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    }),
  },
}));

// Para a corrida render × efeito: depois da PRÓXIMA leitura da chave (a do render), o relógio salta
// para `saltarPara` — o efeito roda num instante posterior ao render.
let saltarPara: Date | null = null;
vi.mock('@/lib/financeiro/saldo-contas', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/financeiro/saldo-contas')>();
  return {
    ...real,
    chaveFrescorDaLeitura: (agora: Date) => {
      const chave = real.chaveFrescorDaLeitura(agora);
      if (saltarPara) {
        vi.setSystemTime(saltarPara);
        saltarPara = null;
      }
      return chave;
    },
  };
});

import { CaixaCompraCard } from '../CaixaCompraCard';

const FILA = [{ status: 'pendente_aprovacao', valor_total: 500 }];

function semanas(saldo: number, fluxo: number) {
  return [
    { semana_label: '26/10-01/11', saldo_projetado: saldo, fluxo_liquido: fluxo },
    { semana_label: '02/11-08/11', saldo_projetado: saldo, fluxo_liquido: 0 },
  ];
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CaixaCompraCard pedidos={FILA} />
    </QueryClientProvider>,
  );
}

/** Avança o relógio controlado e deixa os timers e as promessas assentarem. */
async function avancar(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  saltarPara = null;
  vi.useRealTimers();
  rpc.mockClear();
});

describe('CaixaCompraCard — o piso inclui o saldo de hoje', () => {
  it('saldo R$100, compra R$500, recebimento de R$1.000 na semana: acusa que fura o caixa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-27T15:00:00Z')); // 12h SP
    respostaRpc = { data: semanas(1_100, 1_000), error: null };
    renderCard();
    await avancar(0);

    expect(screen.getByText('hoje')).toBeTruthy();
    expect(screen.getByText(/leva o piso projetado abaixo de R\$0/)).toBeTruthy();
    expect(screen.getByText(/não o dia a dia/)).toBeTruthy();
  });

  it('controle: com saldo de hoje que cobre a fila, não acusa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-27T15:00:00Z'));
    respostaRpc = { data: semanas(1_600, 1_000), error: null };
    renderCard();
    await avancar(0);

    expect(screen.getByText('hoje')).toBeTruthy();
    expect(screen.queryByText(/leva o piso projetado abaixo de R\$0/)).toBeNull();
  });
});

describe('CaixaCompraCard — a leitura não atravessa a virada das 04h SP', () => {
  it('03:50 lê; 03:55 some da tela sem nova leitura; 04:05 lê de novo pela régua nova', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-27T06:50:00Z')); // 03:50 SP
    respostaRpc = { data: semanas(9_000, 0), error: null };
    renderCard();
    await avancar(0);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByText('R$ 9.000,00')).toBeTruthy();

    // Às 03:55:00.250 (o timer do card, sem outro gatilho de render) o número velho sai da tela.
    respostaRpc = { data: semanas(7_000, 0), error: null };
    await avancar(5 * 60_000 + 300);
    expect(screen.queryByText('R$ 9.000,00')).toBeNull();
    expect(screen.getByText(/Virada diária do saldo bancário/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledTimes(1);

    // Às 04:05:00.250 a régua nova está garantida no banco: lê de novo.
    await avancar(10 * 60_000);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Virada diária do saldo bancário/)).toBeNull();
    expect(screen.getAllByText('R$ 7.000,00').length).toBeGreaterThan(0);
  });
});

describe('CaixaCompraCard — a corrida entre o render e o efeito na entrada da janela', () => {
  it('render às 03:54:59.990 e efeito às 03:55:00.010: o número de antes sai já, não às 04:05', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-27T06:50:00Z')); // 03:50 SP, cache aquecido
    respostaRpc = { data: semanas(9_000, 0), error: null };
    renderCard();
    await avancar(0);
    expect(screen.getByText('R$ 9.000,00')).toBeTruthy();

    // A aba volta às 03:54:59.990 (render com a chave de antes); o efeito roda 20 ms depois.
    vi.setSystemTime(new Date('2026-10-27T06:54:59.990Z'));
    saltarPara = new Date('2026-10-27T06:55:00.010Z');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await avancar(0);
    expect(screen.queryByText('R$ 9.000,00')).toBeNull();
    expect(screen.getByText(/Virada diária do saldo bancário/)).toBeTruthy();

    // E segue fora da tela às 04:00:01, quando a régua do banco já mudou.
    await avancar(5 * 60_000);
    expect(screen.queryByText('R$ 9.000,00')).toBeNull();
  });
});
