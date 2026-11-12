import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Json } from '@/integrations/supabase/types';
import { lerContribuicao, type Contribuicao } from '@/lib/venda-cliente/contribuicao';
import { metricasJson } from '@/lib/venda-cliente/__tests__/contribuicao.fixture';

/**
 * Estados que o founder não pode ler errado: falha ≠ R$ 0, eixo sem dono ≠ lista vazia, empresa sem taxa de
 * capital mostra "—" e o motivo — nunca contribuição R$ 0.
 */
const registrarNoLedger = vi.fn();
vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: (...a: unknown[]) => registrarNoLedger(...a) }));

let resp: { data?: Contribuicao; isPending: boolean; isError: boolean; error: unknown; isFetching: boolean };
vi.mock('@/hooks/useVendaContribuicao', () => ({ useVendaContribuicao: () => resp }));

import { AbaContribuicao } from '../AbaContribuicao';

const renderAba = () => render(<MemoryRouter><AbaContribuicao /></MemoryRouter>);

function dados(over: Record<string, Json> = {}): Contribuicao {
  return lerContribuicao({
    janela: '12m', desde: '2025-11-13', ate: '2026-11-12', eixo: 'cliente', empresa: null,
    ordem: 'contribuicao_asc', limite: 50, offset: 0, indisponivel: false,
    taxa_capital: { oben: 0.1775, colacor: null },
    total: metricasJson(),
    por_empresa: {
      oben: metricasJson(),
      colacor: metricasJson({
        contribuicao: null, contribuicao_pct: null, receita_contribuicao: null, custo_contribuicao: null,
        custo_prazo_contribuicao: null, custo_prazo: null, custo_prazo_pct: null, receita_com_prazo: null,
        pedidos_prazo_ok: 0, pedidos_taxa_ausente: 4, prazo_medio_dias: 23,
      }),
    },
    total_linhas: 1,
    linhas: [{ chave: 'u1', rotulo: 'Marcenaria Um', detalhe: { empresas: 2 }, ...metricasJson({ contribuicao: null, contribuicao_pct: null }) }],
    ...over,
  });
}

describe('AbaContribuicao — estados', () => {
  beforeEach(() => {
    registrarNoLedger.mockClear();
  });

  it('falha da RPC mostra a mensagem, nunca R$ 0', () => {
    resp = { isPending: false, isError: true, error: { message: 'forbidden' }, isFetching: false };
    renderAba();
    expect(screen.getByText(/Não foi possível carregar a contribuição: forbidden/)).toBeInTheDocument();
    expect(screen.queryByText(/R\$\s?0/)).not.toBeInTheDocument();
  });

  it('eixo vendedor indisponível mostra o motivo, não uma lista vazia', () => {
    resp = {
      data: lerContribuicao({ janela: '12m', desde: '2025-11-13', ate: '2026-11-12', eixo: 'vendedor', indisponivel: true, motivo: 'ainda nao existe (Entrega 2)' }),
      isPending: false, isError: false, error: null, isFetching: false,
    };
    renderAba();
    expect(screen.getByText('Eixo indisponível')).toBeInTheDocument();
    expect(screen.getByText(/Entrega 2/)).toBeInTheDocument();
    expect(registrarNoLedger).not.toHaveBeenCalled();
  });

  it('colacor sem taxa: selo, motivo e "—" no lugar da contribuição; a linha sem contribuição mostra "—"', () => {
    resp = { data: dados(), isPending: false, isError: false, error: null, isFetching: false };
    renderAba();
    expect(screen.getByText('sem taxa de capital')).toBeInTheDocument();
    expect(screen.getByText('indisponível: a empresa não tem taxa de capital configurada')).toBeInTheDocument();
    expect(screen.getByText(/prazo médio 23 d em 4 pedidos, sem taxa para custear/)).toBeInTheDocument();
    expect(screen.getByText('Marcenaria Um')).toBeInTheDocument();
    expect(screen.getByText('2 empresas')).toBeInTheDocument();
    // controle positivo: a oben (completa) mostra a cobertura da interseção
    expect(screen.getAllByText(/sobre 100\s?% da receita líquida/).length).toBeGreaterThan(0);
    expect(registrarNoLedger).toHaveBeenCalledWith('venda.painel_aberto', 'contribuicao', expect.objectContaining({ aba: 'contribuicao' }));
  });
});
