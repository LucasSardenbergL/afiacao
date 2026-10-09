import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RankingResult } from '@/lib/dashboard/team-kpis';

/**
 * O card do ranking do Master pela régua da carteira (spec 2026-10-06 §5.4): diz a régua no subtítulo,
 * separa "Carteira de não-vendedor" de "Sem vendedor atribuído" e só some quando nenhum dos três destinos
 * tem pedido.
 */
let estado: { data?: RankingResult; isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };
vi.mock('@/hooks/useTeamRanking', () => ({ useTeamRanking: () => estado }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ selection: 'oben', companyInfo: { shortName: 'Oben' } }),
}));

import { RankingVendedoresCard } from '../RankingVendedoresCard';

const vazio = { receita: 0, pedidos: 0 };
function comDados(over: Partial<RankingResult>) {
  estado = {
    isLoading: false,
    isError: false,
    data: { ranking: [], carteiraNaoVendedor: vazio, naoAtribuido: vazio, semAtividade: 0, ...over },
  };
}

describe('RankingVendedoresCard — régua da carteira', () => {
  it('[CARD-SUB] o subtítulo diz a régua', () => {
    comDados({ ranking: [{ id: 'V1', nome: 'Regina', receita: 1000, pedidos: 2 }] });
    render(<RankingVendedoresCard />);
    expect(screen.getByText(/por dono da carteira · Oben/)).toBeTruthy();
    expect(screen.queryByText(/quem lançou/)).toBeNull();
  });

  it('[CARD-SO-NV] mês só com carteira de não-vendedor: o card aparece, com a linha e o porquê', () => {
    comDados({ carteiraNaoVendedor: { receita: 1234.5, pedidos: 3 } });
    render(<RankingVendedoresCard />);
    const linha = screen.getByText(/Carteira de não-vendedor:/);
    expect(linha.textContent).toContain('3 ped.');
    expect(linha.getAttribute('title')).toContain('farmer, hunter nem closer');
  });

  it('[CARD-ORDEM] não-vendedor vem antes de "Sem vendedor atribuído", em linhas distintas', () => {
    comDados({ carteiraNaoVendedor: { receita: 200, pedidos: 1 }, naoAtribuido: { receita: 300, pedidos: 2 } });
    const { container } = render(<RankingVendedoresCard />);
    const texto = container.textContent ?? '';
    const nv = texto.indexOf('Carteira de não-vendedor:');
    expect(nv).toBeGreaterThan(-1);
    expect(nv).toBeLessThan(texto.indexOf('Sem vendedor atribuído:'));
    expect(screen.getByText(/Carteira de não-vendedor:/)).not.toBe(screen.getByText(/Sem vendedor atribuído:/));
  });

  it('[CARD-VAZIO] sem pedido em destino nenhum: o card some', () => {
    comDados({ semAtividade: 2 });
    const { container } = render(<RankingVendedoresCard />);
    expect(container.firstChild).toBeNull();
  });

  it('[CARD-POR-QUE] o porquê de cada rodapé é texto visível (toque e leitor de tela), não só title', () => {
    comDados({ carteiraNaoVendedor: { receita: 200, pedidos: 1 }, naoAtribuido: { receita: 300, pedidos: 2 } });
    render(<RankingVendedoresCard />);
    expect(screen.getByText(/Carteira de não-vendedor:/).textContent).toContain('dono sem papel de venda');
    expect(screen.getByText(/Sem vendedor atribuído:/).textContent).toContain('cliente sem carteira');
  });

  it('[CARD-ERRO] leitura que falha mostra "Indisponível no momento", nunca some nem vira ranking vazio', () => {
    estado = { isLoading: false, isError: true };
    render(<RankingVendedoresCard />);
    expect(screen.getByText('Indisponível no momento.')).toBeTruthy();
    expect(screen.queryByText(/Sem vendedor atribuído/)).toBeNull();
  });
});
