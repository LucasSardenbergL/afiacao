import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DRETab } from '../DRETab';
import { makeDRE } from './factories';

const row = makeDRE({
  mes: 1,
  receita_bruta: 10000, deducoes: 1000, receita_liquida: 9000, cmv: 4000, lucro_bruto: 5000,
  despesas_operacionais: 1000, despesas_administrativas: 500, despesas_comerciais: 300,
  despesas_financeiras: 100, receitas_financeiras: 50, resultado_operacional: 3150,
  impostos: 600, resultado_liquido: 2550,
});

describe('DRETab', () => {
  it('vazio → mensagem de recalcular', () => {
    render(<DRETab data={[]} view="all" ano={2026} />);
    expect(screen.getByText(/Nenhum DRE calculado para 2026/)).toBeTruthy();
  });

  it('com dados → cabeçalho, linhas do DRE, mês e badge consolidado', () => {
    render(<DRETab data={[row]} view="all" ano={2026} />);
    expect(screen.getByText(/DRE Regime de Caixa/)).toBeTruthy();
    expect(screen.getByText('Receita Bruta')).toBeTruthy();
    expect(screen.getByText('= RESULTADO LÍQUIDO')).toBeTruthy();
    expect(screen.getByText('Jan')).toBeTruthy();
    expect(screen.getByText('Consolidado')).toBeTruthy();
  });

  it('categorias não mapeadas → aviso de heurística', () => {
    const unmapped = [{ ...row, detalhamento: { receitas: {}, despesas: {}, categorias_nao_mapeadas: ['CAT_X'] } }];
    render(<DRETab data={unmapped} view="all" ano={2026} />);
    expect(screen.getByText(/classificadas por heurística/)).toBeTruthy();
    expect(screen.getByText(/CAT_X/)).toBeTruthy();
  });
});

describe('DRETab — falha de leitura ≠ vazio', () => {
  it('indisponivel + vazio → alerta com a causa, sem mandar recalcular', () => {
    render(<DRETab data={[]} view="all" ano={2026} indisponivel="statement timeout" />);
    const alerta = screen.getByRole('alert');
    expect(alerta.textContent).toMatch(/indispon/i);
    expect(alerta.textContent).toMatch(/statement timeout/);
    expect(screen.queryByText(/Recalcular/)).toBeNull();
  });

  it('indisponivel ausente + vazio → vazio genuíno mantém "Recalcular"', () => {
    render(<DRETab data={[]} view="all" ano={2026} />);
    expect(screen.getByText(/Recalcular/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('DRETab — DRE fase 2 (fora do DRE / resultado provisório)', () => {
  it('mês provisório → aviso, selo, mês marcado e linha fora do DRE fora dos subtotais', () => {
    const prov = [{ ...row, fora_dre: 26098.88, resultado_provisorio: true }];
    render(<DRETab data={prov} view="all" ano={2026} />);
    expect(screen.getByRole('status').textContent).toMatch(/Resultado provisório em 1 mês/);
    expect(screen.getByText('Resultado provisório')).toBeTruthy();
    expect(screen.getByText('Jan*')).toBeTruthy();
    expect(screen.getByText('Fora do DRE (composição pendente)')).toBeTruthy();
  });

  it('snapshot pré-fase 2 (fora_dre null) → sem linha fora do DRE e sem selo (ausente ≠ 0)', () => {
    render(<DRETab data={[{ ...row, fora_dre: null, resultado_provisorio: null }]} view="all" ano={2026} />);
    expect(screen.queryByText('Fora do DRE (composição pendente)')).toBeNull();
    expect(screen.queryByText('Resultado provisório')).toBeNull();
  });

  it('mapa inválido → alerta com o código e o valor', () => {
    const inval = [{ ...row, detalhamento: { receitas: {}, despesas: {}, mapeamentos_invalidos: [
      { codigo: '2.06.05', valor: 'irpj', origem: 'exato' as const, motivo: 'regime', codigo_titulo: '2.06.05', valor_afetado: 10 },
    ] } }];
    render(<DRETab data={inval} view="all" ano={2026} />);
    expect(screen.getByRole('alert').textContent).toMatch(/2\.06\.05→irpj/);
  });
});
