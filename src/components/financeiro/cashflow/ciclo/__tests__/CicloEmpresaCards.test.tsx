// Régua honesta do card da empresa (Frente A, itens 2 e 3): DSO da carteira toda ao lado do PMR dos pagos,
// R$/dia do PME = CMV TTM ÷ 365, PME pelo estoque MÉDIO dos 90 d, sync e cobertura de custo do estoque.
// Ausente ≠ zero: cada insumo faltante vira "—" com motivo, nunca número.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReguaEmpresa } from '@/hooks/useFinanceiroCiclo';
import { somarDias } from '@/lib/financeiro/regua-ciclo-helpers';

const projMock = vi.fn();
vi.mock('@/hooks/useCashflowProjection', () => ({ useCashflowProjection: () => projMock() }));

import { CicloEmpresaCard } from '@/components/financeiro/cashflow/ciclo/CicloEmpresaCards';

const HOJE = '2026-10-31';
const ind = { prazo_medio_recebimento: 31, prazo_medio_pagamento: 12, prazo_medio_estoque: 40, cash_conversion_cycle: 59, estoque_valor: 480000, estoque_fonte: 'omie' as const };
const serie = (n: number, desde: string) => Array.from({ length: n }, (_, i) => ({ dia: somarDias(desde, i), valor: 480000, coberturaOk: true }));
const regua = (o: Partial<ReguaEmpresa> = {}): ReguaEmpresa => ({
  cmvTtm: { valor: 2400000, meses: 12, motivo: null },
  estoqueSerie: serie(70, '2026-08-23'),
  estoqueSyncEm: '2026-10-31T22:30:11.153+00:00',
  custoCobertura: { pct: 97.2, skusGiro: 400, skusComCusto: 389 },
  ...o,
});

function montar(props: Partial<Parameters<typeof CicloEmpresaCard>[0]> = {}) {
  return render(
    <CicloEmpresaCard company="oben" coorte={[]} receitaDia={4119620 / 365} receitaMeses={12} resumo={[]} hoje={HOJE}
      regua={regua()} crAberto={645925} {...props} />,
  );
}

beforeEach(() => {
  projMock.mockReset();
  projMock.mockReturnValue({ data: { indicadores: ind, confianca_dados: { motivos: [] } }, error: null, isLoading: false });
});

describe('CicloEmpresaCard — régua honesta', () => {
  it('DSO (carteira toda ÷ receita/dia) aparece ao lado do PMR com a convenção no tooltip; Ciclo rotulado como soma de bases distintas', () => {
    montar();
    // R$ 645.925 ÷ (R$ 4.119.620 / 365) ≈ 57,2 d — medido na prod em 2026-10-31
    expect(screen.getByTestId('ciclo-dso-oben').textContent).toMatch(/DSO57d/);
    expect(screen.getByTestId('ciclo-pmr-oben').textContent).toMatch(/PMR31d/);
    expect(screen.getByTestId('ciclo-dso-oben').getAttribute('title')).toMatch(/PMR = só títulos PAGOS/);
    expect(screen.getByTestId('ciclo-dso-oben').getAttribute('title')).toMatch(/DSO = carteira ABERTA toda/);
    expect(screen.getByTestId('ciclo-ciclo-oben').textContent).toMatch(/soma de bases distintas/);
    expect(screen.queryByTestId('ciclo-dso-motivo-oben')).toBeNull();
  });

  it('1 dia de PME = CMV TTM ÷ 365 (não receita); estoque traz sync e cobertura de custo', () => {
    montar();
    // 2.400.000 / 365 = 6.575,3
    expect(screen.getByTestId('ciclo-pme-dia-oben').textContent).toMatch(/1 dia de PME = R\$\s?6\.575 de CMV/);
    const estoque = screen.getByTestId('ciclo-estoque-oben').textContent ?? '';
    expect(estoque).toMatch(/Omie, agora/);
    expect(estoque).toMatch(/sync 31\/10,? 19:30/); // 22:30Z = 19:30 em SP
    expect(estoque).toMatch(/custo cobre 97% dos SKUs de giro/);
  });

  it('PME pelo estoque médio dos 90 d: 70 pontos a R$ 480 mil ÷ CMV 2,4 M × 365 = 73 d, com desde quando', () => {
    montar();
    expect(screen.getByTestId('ciclo-pme-medio-oben').textContent).toMatch(/PME pelo estoque médio 90 d: 73d \(média R\$\s?480\.000, 70 dias desde 23\/08\/2026\)/);
  });

  it('série curta, CMV incompleto e carteira ausente viram — com motivo, nunca 0', () => {
    montar({
      regua: regua({ cmvTtm: { valor: null, meses: 11, motivo: 'CMV do DRE cobre 11/12 meses fechados (último: 2026-09)' }, estoqueSerie: serie(10, '2026-10-22'), estoqueSyncEm: null, custoCobertura: { pct: null, skusGiro: null, skusComCusto: null } }),
      crAberto: null,
    });
    expect(screen.getByTestId('ciclo-pme-dia-oben').textContent).toMatch(/— \(CMV do DRE cobre 11\/12 meses fechados/);
    expect(screen.getByTestId('ciclo-pme-medio-oben').textContent).toMatch(/— \(série de estoque cobre 10\/90 dias \(desde 2026-10-22\)/);
    expect(screen.getByTestId('ciclo-dso-oben').textContent).toMatch(/DSO—/);
    expect(screen.getByTestId('ciclo-dso-motivo-oben').textContent).toMatch(/carteira aberta indisponível/);
    const estoque = screen.getByTestId('ciclo-estoque-oben').textContent ?? '';
    expect(estoque).toMatch(/sem sync registrado/);
    expect(estoque).toMatch(/cobertura de custo não lida/);
  });

  it('sem régua ainda (carregando) mostra … no DSO; erro de leitura aparece como erro, não como número', () => {
    montar({ regua: undefined, crAberto: undefined });
    expect(screen.getByTestId('ciclo-dso-oben').textContent).toMatch(/DSO…/);
    expect(screen.getByTestId('ciclo-pme-dia-oben').textContent).toMatch(/1 dia de PME = …/);
    expect(screen.queryByTestId('ciclo-pme-medio-oben')).toBeNull();
    montar({ regua: undefined, reguaErro: true, crAberto: undefined, crErro: true });
    expect(screen.getAllByTestId('ciclo-dso-motivo-oben').at(-1)?.textContent).toMatch(/erro de leitura da carteira/);
    expect(screen.getAllByTestId('ciclo-pme-dia-oben').at(-1)?.textContent).toMatch(/erro de leitura do CMV/);
    expect(screen.getAllByTestId('ciclo-pme-medio-oben').at(-1)?.textContent).toMatch(/erro de leitura/);
  });
});
