import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DREComparativo } from '../DREComparativo';
import { makeDRE } from './factories';

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
});
