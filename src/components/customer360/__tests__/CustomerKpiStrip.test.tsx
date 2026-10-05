import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CustomerKpiStrip } from '../CustomerKpiStrip';
import { formatBRL } from '../format';
import { horaDaLeitura } from '../kpi-rotulos';
import type { CustomerMetrics, CustomerScore, Faturamento12m, LeituraKpi } from '../viewTypes';

const LIDO_EM = Date.UTC(2026, 9, 5, 17, 32);

/**
 * O R$ como o Testing Library o LÊ no DOM. O `formatBRL` separa "R$" do número com espaço
 * não-separável (U+00A0), e o normalizador padrão troca todo `\s+` do NÓ por um espaço comum — mas
 * não a string da consulta. Consultar `formatBRL(x)` cru nunca casa: o positivo falha, e o
 * NEGATIVO (`queryByText(...)).toBeNull()`) passa verde por cegueira, com o R$ 0 na tela.
 */
const brlNaTela = (v: number) => formatBRL(v).replace(/\s+/g, ' ');

const lido = <T,>(valor: T, desatualizado: 'erro' | 'sem-rede' | null = null): LeituraKpi<T> => ({
  emMaos: true,
  valor,
  desatualizado,
  lidoEm: LIDO_EM,
});
const semValor = <T,>(motivo: 'carregando' | 'erro' | 'sem-rede'): LeituraKpi<T> => ({ emMaos: false, motivo });

const fat12 = lido<Faturamento12m>({ total: 12000, pedidos: 8 });
const linhaMv = {
  faturamento_90d: 5000,
  faturamento_prev_90d: 4000,
  pedidos_90d: 3,
  ticket_medio_90d: 1600,
  dias_desde_ultima_compra: 5,
  intervalo_medio_dias: 30,
  ultima_compra_data: '2026-09-30',
  is_cold_start: false,
  calculated_at: '2026-10-05T12:15:00+00:00',
} as unknown as NonNullable<CustomerMetrics>;
const score = { avg_repurchase_interval: 30 } as unknown as CustomerScore;

function montar(faturamento12m: LeituraKpi<Faturamento12m>, metricas: LeituraKpi<CustomerMetrics>) {
  return render(<CustomerKpiStrip faturamento12m={faturamento12m} metricas={metricas} score={score} />);
}

describe('CustomerKpiStrip', () => {
  it('renderiza os 4 KPIs e declara os dois relógios — sem aviso quando tudo foi lido', () => {
    montar(fat12, lido<CustomerMetrics>(linhaMv));
    expect(screen.getByText('Faturamento 12m')).toBeTruthy();
    expect(screen.getByText('Faturamento 90d')).toBeTruthy();
    expect(screen.getByText('Ticket médio (90d)')).toBeTruthy();
    expect(screen.getByText('Última compra')).toBeTruthy();
    expect(screen.getByText(brlNaTela(12000))).toBeTruthy();
    expect(screen.getByText('8 pedidos')).toBeTruthy();
    expect(screen.getByText('5d')).toBeTruthy();
    expect(screen.getByText(/consolidado em/)).toBeTruthy();
    expect(screen.queryByTestId('aviso-c360-faturamento-12m')).toBeNull();
    expect(screen.queryByTestId('aviso-c360-consolidado')).toBeNull();
  });

  it('12m que FALHOU sem valor: "indisponível", nunca R$ 0 e 0 pedidos', () => {
    montar(semValor('erro'), lido<CustomerMetrics>(linhaMv));
    expect(screen.getByText('indisponível')).toBeTruthy();
    expect(screen.queryByText('0 pedidos')).toBeNull();
    expect(screen.queryByText(brlNaTela(0))).toBeNull();
  });

  it('12m sem rede na 1ª carga: "sem rede", não "carregando…" para sempre', () => {
    montar(semValor('sem-rede'), lido<CustomerMetrics>(linhaMv));
    expect(screen.getByText('sem rede')).toBeTruthy();
    expect(screen.queryByText('carregando…')).toBeNull();
  });

  it('12m lido e o refetch falhou: o número FICA com a hora da leitura, e o aviso de desatualizado aparece (P1-1)', () => {
    montar(lido<Faturamento12m>({ total: 12000, pedidos: 8 }, 'erro'), lido<CustomerMetrics>(linhaMv));
    expect(screen.getByText(brlNaTela(12000))).toBeTruthy();
    expect(screen.getByText(`8 pedidos · lido às ${horaDaLeitura(LIDO_EM)}`)).toBeTruthy();
    expect(screen.getByTestId('aviso-c360-faturamento-12m').getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByTestId('aviso-c360-consolidado')).toBeNull();
  });

  it('consolidado que falhou sem valor: os TRÊS tiles dizem "indisponível" — não só o 90d (P2)', () => {
    montar(fat12, semValor<CustomerMetrics>('erro'));
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.getAllByText('indisponível')).toHaveLength(3);
    expect(screen.queryByText(/consolidado em/)).toBeNull();
  });

  it('cliente fora do consolidado: "—" com o motivo nos três tiles, nunca R$ 0 nem "Sem compra" (P2)', () => {
    montar(fat12, lido<CustomerMetrics>(null));
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.getAllByText('fora do consolidado')).toHaveLength(3);
    expect(screen.queryByText(brlNaTela(0))).toBeNull();
    expect(screen.queryByText('Sem compra')).toBeNull();
  });

  it('o sentinela 9999: "Sem compra · no consolidado" — nunca "Nunca" nem "9999d" (P1-2)', () => {
    montar(fat12, lido<CustomerMetrics>({ ...linhaMv, dias_desde_ultima_compra: 9999, intervalo_medio_dias: null }));
    expect(screen.getByText('Sem compra')).toBeTruthy();
    expect(screen.getByText('no consolidado')).toBeTruthy();
    expect(screen.queryByText('Nunca')).toBeNull();
    expect(screen.queryByText('9999d')).toBeNull();
  });

  it('consolidado lido e o refetch ficou sem rede: os valores FICAM e o aviso aparece', () => {
    montar(fat12, lido<CustomerMetrics>(linhaMv, 'sem-rede'));
    expect(screen.getByText('5d')).toBeTruthy();
    expect(screen.getByTestId('aviso-c360-consolidado').getAttribute('data-estado')).toBe('sem-rede');
    expect(screen.queryByTestId('aviso-c360-faturamento-12m')).toBeNull();
  });
});
