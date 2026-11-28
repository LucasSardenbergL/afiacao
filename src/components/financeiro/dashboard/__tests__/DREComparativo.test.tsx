import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DREComparativo } from '../DREComparativo';
import { makeDRE } from './factories';
import { fmtCompact } from '@/components/financeiro/dashboard/format';

const row = makeDRE({
  receita_liquida: 9000, lucro_bruto: 5000, resultado_operacional: 3000,
  resultado_liquido: 2500, impostos: 600,
});

describe('DREComparativo', () => {
  it('menos de 2 empresas → não renderiza nada', () => {
    const { container } = render(<DREComparativo data={{ oben: [row] }} ano={2026} />);
    expect(container.firstChild).toBeNull();
  });

  it('2+ empresas → tabela comparativa com indicadores', () => {
    render(<DREComparativo data={{ oben: [row], colacor_sc: [row] }} ano={2026} />);
    expect(screen.getByText(/Comparativo por Empresa/)).toBeTruthy();
    expect(screen.getByText('Receita Líquida')).toBeTruthy();
    expect(screen.getByText('Margem Bruta')).toBeTruthy();
    expect(screen.getByText('% da Receita Total')).toBeTruthy();
  });

  it('linha não-operacional fecha Resultado Operacional − Impostos = Resultado Líquido', () => {
    const r = makeDRE({ resultado_operacional: 3000, outras_receitas: 70_000, outras_despesas: 20_000, impostos: 600, resultado_liquido: 52_400 });
    render(<DREComparativo data={{ oben: [r], colacor_sc: [r] }} ano={2026} />);
    const tr = screen.getByText('Outras Receitas − Outras Despesas').closest('tr')!;
    const celulas = [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '');
    expect(celulas.some((c) => c.includes(fmtCompact(50_000)))).toBe(true);
  });

  it('badge de regime segue o ANO exibido: colacor SN em 2022, LP em 2023', () => {
    const { unmount } = render(<DREComparativo data={{ colacor: [row], oben: [row] }} ano={2022} />);
    expect(screen.getAllByText('SN')).toHaveLength(1);
    expect(screen.getAllByText('LP')).toHaveLength(1);
    unmount();
    render(<DREComparativo data={{ colacor: [row], oben: [row] }} ano={2023} />);
    expect(screen.queryAllByText('SN')).toHaveLength(0);
    expect(screen.getAllByText('LP')).toHaveLength(2);
  });
});
