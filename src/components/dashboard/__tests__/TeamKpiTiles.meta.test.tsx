import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TeamKpiTiles } from '@/components/dashboard/TeamKpiTiles';
import type { MetaResposta } from '@/lib/dashboard/meta-potencial';

const kpis = { receitaHoje: 10_000, receitaMes: 400_000, receitaMesAnterior: 380_000, variacaoMes: 0.05,
  vendedoresHoje: 1, vendedoresMes: 2, pedidosSemVendedorMes: 0 };
let metaState: { data?: MetaResposta; isLoading: boolean; isError: boolean };

vi.mock('@/hooks/useTeamKpis', () => ({ useTeamKpis: () => ({ data: kpis, isLoading: false, isError: false }) }));
vi.mock('@/hooks/dashboard/useMetaPotencial', () => ({ useMetaPotencial: () => metaState }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ selection: 'all', companyInfo: { shortName: 'Oben' } }) }));

const linha = (meta: number | null) => ({
  account: 'oben', owner_user_id: 'r', owner_nome: 'Regina', owner_ativo: true, base: 500_000, esp_c: 10_000,
  esp_d: 2_000, novos: 0, inc_c: 5_000, inc_d: 1_000, inc_b: 7_000, inc_cross: 1_000, taxa_c: 0.2, taxa_d: 0.07,
  indice_sazonal: 1, meta, n_a: 50, n_b: 50, n_c: 50, n_d: 50, realizado: 400_000,
});
const resp = (status: 'congelada' | 'provisoria', meta: number | null): MetaResposta => ({
  mes: '2026-11-01', versao: 1, status, linhas: [linha(meta)],
  diasUteis: { oben: { total: 19, restantes: 5 } }, diasUteisGrupo: { total: 21, restantes: 5 },
});

describe('TeamKpiTiles · meta por potencial', () => {
  beforeEach(() => { metaState = { isLoading: false, isError: false }; });

  it('mostra meta, % e ritmo por dia útil', () => {
    metaState.data = resp('congelada', 500_000);
    render(<TeamKpiTiles />);
    expect(screen.getByText(/meta R\$\s?500\.000/)).toBeTruthy();
    expect(screen.getByText(/precisa R\$\s?20\.000,00\/dia útil · 5 dias/)).toBeTruthy();
    expect(screen.getByText('Como a meta do mês foi feita')).toBeTruthy();
  });

  it('erro da RPC → "meta indisponível" e a receita continua', () => {
    metaState.isError = true;
    render(<TeamKpiTiles />);
    expect(screen.getByText('meta indisponível')).toBeTruthy();
    expect(screen.getByText(/R\$\s?400\.000/)).toBeTruthy();
  });

  it('calibração ausente → indisponível, nunca R$ 0', () => {
    metaState.data = resp('congelada', null);
    render(<TeamKpiTiles />);
    expect(screen.getByText('meta indisponível (sem calibração)')).toBeTruthy();
    expect(screen.queryByText(/meta R\$\s?0/)).toBeNull();
  });

  it('dias 1–2 → marcada provisória', () => {
    metaState.data = resp('provisoria', 500_000);
    render(<TeamKpiTiles />);
    expect(screen.getByText(/· provisória$/)).toBeTruthy();
  });
});
