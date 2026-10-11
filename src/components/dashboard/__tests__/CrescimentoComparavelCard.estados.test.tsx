import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  avaliarComparabilidade,
  decomporCrescimento,
  type CoberturaEmpresa,
} from '@/lib/dashboard/crescimento-comparavel';
import type { CrescimentoComparavel, Comparacao } from '@/hooks/dashboard/useCrescimentoComparavel';

/**
 * Os estados do card: erro de pedido aparece como erro (nunca ponte parcial), comparação com
 * cobertura incompatível é SUPRIMIDA com o motivo, a ponte fecha e a coorte mostra seu tamanho,
 * e o sensor de uso dispara uma vez por (empresa, comparação), só com dado.
 */
let estado: { data?: CrescimentoComparavel; isLoading: boolean; isError: boolean } = {
  isLoading: false,
  isError: false,
};
let selection = 'oben';
const track = vi.fn();
vi.mock('@/hooks/dashboard/useCrescimentoComparavel', () => ({ useCrescimentoComparavel: () => estado }));
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ selection, companyInfo: { shortName: 'Oben' } }),
  COMPANIES: { oben: { shortName: 'Oben' }, colacor: { shortName: 'Colacor' } },
}));

import { CrescimentoComparavelCard } from '../CrescimentoComparavelCard';

const p = (c: string, total: number) => ({ customer_user_id: c, total });
function comparacao(base: { de: string; ate: string }, coberturas: CoberturaEmpresa[]): Comparacao {
  return {
    base,
    decomposicao: decomporCrescimento([p('a', 120), p('b', 40), p('d', 70)], [p('a', 100), p('b', 50), p('c', 30)]),
    coberturas,
    comparabilidade: avaliarComparabilidade(coberturas),
  };
}
function comDados(ano: CoberturaEmpresa[], meses: CoberturaEmpresa[]) {
  estado = {
    isLoading: false,
    isError: false,
    data: {
      atual: { de: '2026-07-01', ate: '2026-10-01' },
      comparacoes: {
        ano_anterior: comparacao({ de: '2025-07-01', ate: '2025-10-01' }, ano),
        meses_anteriores: comparacao({ de: '2026-04-01', ate: '2026-07-01' }, meses),
      },
    },
  };
}
const ok: CoberturaEmpresa[] = [{ account: 'oben', atual: 1.3, base: 1.25 }];

beforeEach(() => {
  track.mockReset();
  selection = 'oben';
});

describe('CrescimentoComparavelCard', () => {
  it('[CC-ERRO] pedido que falhou aparece como erro, não como ponte vazia', () => {
    estado = { isLoading: false, isError: true };
    render(<CrescimentoComparavelCard />);
    expect(screen.getByText(/leitura dos pedidos falhou/)).toBeTruthy();
    expect(screen.queryByText(/Saíram/)).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it('[CC-PONTE] a ponte fecha e a coorte mostra tamanho e participação nos dois lados', () => {
    comDados(ok, ok);
    render(<CrescimentoComparavelCard />);
    expect(screen.getByText(/jul–set\/26 vs jul–set\/25 · Oben/)).toBeTruthy();
    expect(screen.getByText(/− Saíram \(1 clientes\)/)).toBeTruthy();
    expect(screen.getByText(/\+ Entraram \(1 clientes\)/)).toBeTruthy();
    expect(screen.getByText(/2 clientes · 69.6% da receita atual · 83.3% da anterior/)).toBeTruthy();
    expect(screen.queryByText(/Sem cliente identificado/)).toBeNull();
  });

  it('[CC-DEFAULT] ano anterior incomparável: abre nos 3 meses antes, com números', () => {
    comDados([{ account: 'colacor', atual: 0.91, base: 0.49 }], ok);
    render(<CrescimentoComparavelCard />);
    expect(screen.getByText(/jul–set\/26 vs abr–jun\/26/)).toBeTruthy();
    expect(screen.getByText('Base comparável')).toBeTruthy();
  });

  it('[CC-INCOMP] cobertura incompatível suprime os percentuais e diz por quê', () => {
    comDados([{ account: 'colacor', atual: 0.91, base: 0.49 }], ok);
    render(<CrescimentoComparavelCard />);
    fireEvent.click(screen.getByText('ano anterior'));
    expect(screen.getByText('Comparação indisponível.')).toBeTruthy();
    expect(screen.getByText(/Na Colacor, os pedidos do app cobriam 49% .* e 91%/)).toBeTruthy();
    expect(screen.queryByText('Base comparável')).toBeNull();
    expect(screen.queryByText(/Saíram/)).toBeNull();
  });

  it('[CC-NAOVERIF] sem régua de cobertura, mostra os números com o aviso (não finge "comparável")', () => {
    comDados([{ account: 'oben', atual: null, base: 1 }], ok);
    render(<CrescimentoComparavelCard />);
    expect(screen.getByText(/não verificada/)).toBeTruthy();
    expect(screen.getByText('Base comparável')).toBeTruthy();
  });

  it('[CC-GRUPO] no grupo, avisa que a unidade é empresa × cliente', () => {
    selection = 'all';
    comDados(ok, ok);
    render(<CrescimentoComparavelCard />);
    expect(screen.getByText(/cadastros não unificados entre empresas/)).toBeTruthy();
  });

  it('[CC-SENSOR] dispara 1x por comparação, com o estado; voltar à mesma não repete', () => {
    comDados([{ account: 'colacor', atual: 0.91, base: 0.49 }], ok);
    const { rerender } = render(<CrescimentoComparavelCard />);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenLastCalledWith('dashboard.crescimento_comparavel_visto', {
      selection: 'oben',
      comparacao: 'meses_anteriores',
      estado: 'comparavel',
    });
    fireEvent.click(screen.getByText('ano anterior'));
    expect(track).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenLastCalledWith('dashboard.crescimento_comparavel_visto', {
      selection: 'oben',
      comparacao: 'ano_anterior',
      estado: 'incomparavel',
    });
    fireEvent.click(screen.getByText('3 meses antes'));
    rerender(<CrescimentoComparavelCard />);
    expect(track).toHaveBeenCalledTimes(2);
  });
});
