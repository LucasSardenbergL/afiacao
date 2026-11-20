import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PedidosSemNotaDados } from '@/hooks/dashboard/usePedidosSemNota';

/**
 * O aviso substituiu o "Dados de venda parciais" (que afirmava números SUBESTIMADOS, o contrário do
 * medido). Contrato: erro de leitura aparece como erro, nunca some; zero medido não mostra nada; o
 * número aparece com a ressalva de comissão e, no grupo, quebrado por empresa.
 */
type Estado = { data?: PedidosSemNotaDados; isLoading: boolean; isError: boolean };
let estado: Estado = { isLoading: false, isError: false };
vi.mock('@/hooks/dashboard/usePedidosSemNota', () => ({ usePedidosSemNota: () => estado }));
vi.mock('@/contexts/CompanyContext', () => ({
  COMPANIES: { oben: { shortName: 'Oben' }, colacor: { shortName: 'Colacor' } },
}));

import { PedidosSemNotaBanner } from '../PedidosSemNotaBanner';

const janela = { de: '2025-10-12', ate: '2026-09-12' };
const semDetalhe = {
  faixas: [
    { faixa: '30-90' as const, receita: 0, pedidos: 0 },
    { faixa: '90-180' as const, receita: 0, pedidos: 0 },
    { faixa: '180+' as const, receita: 0, pedidos: 0 },
  ],
  clientesRecentes: [],
  clientesRecentesTotal: 0,
  nomes: new Map<string, string>(),
};

describe('PedidosSemNotaBanner', () => {
  it('[SN-ERRO] leitura que falhou aparece como "não consegui medir", nunca some', () => {
    estado = { isLoading: false, isError: true };
    render(<PedidosSemNotaBanner />);
    expect(screen.getByText(/Não consegui medir os pedidos sem nota/)).toBeTruthy();
    expect(screen.getByText(/não como base de comissão/)).toBeTruthy();
  });

  it('[SN-ZERO] zero MEDIDO não mostra aviso', () => {
    estado = { isLoading: false, isError: false, data: { receita: 0, pedidos: 0, porEmpresa: [], janela, ...semDetalhe } };
    const { container } = render(<PedidosSemNotaBanner />);
    expect(container.textContent).toBe('');
  });

  it('[SN-NUMERO] mostra receita e pedidos, sem afirmar "subestimado"', () => {
    estado = {
      isLoading: false,
      isError: false,
      data: { receita: 205815, pedidos: 551, porEmpresa: [{ account: 'colacor', receita: 205815, pedidos: 551 }], janela, ...semDetalhe },
    };
    render(<PedidosSemNotaBanner />);
    expect(screen.getByText(/em 551 pedidos sem nota no Omie há mais de 30 dias/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/subestimad|backfill/i);
    expect(document.body.textContent).not.toMatch(/Oben:/);
  });

  it('[SN-GRUPO] no grupo, quebra por empresa', () => {
    estado = {
      isLoading: false,
      isError: false,
      data: {
        receita: 1501044,
        pedidos: 1738,
        porEmpresa: [
          { account: 'oben', receita: 1295229, pedidos: 1187 },
          { account: 'colacor', receita: 205815, pedidos: 551 },
        ],
        janela,
        ...semDetalhe,
      },
    };
    render(<PedidosSemNotaBanner />);
    expect(document.body.textContent).toMatch(/Oben: R\$\s?1\.295\.229,00 \(1187\) · Colacor: R\$\s?205\.815,00 \(551\)/);
  });

  it('[SN-QUEM] quebra por idade e lista os clientes 30–90d com pedido, data e vendedor', () => {
    estado = {
      isLoading: false,
      isError: false,
      data: {
        receita: 189872.53,
        pedidos: 538,
        porEmpresa: [{ account: 'colacor', receita: 189872.53, pedidos: 538 }],
        janela,
        faixas: [
          { faixa: '30-90', receita: 32800, pedidos: 90 },
          { faixa: '90-180', receita: 46600, pedidos: 127 },
          { faixa: '180+', receita: 110472.53, pedidos: 321 },
        ],
        clientesRecentes: [
          {
            customerUserId: 'C1',
            account: 'colacor',
            receita: 1500,
            pedidos: [{ id: 'p1', numero: '4321', data: '2026-09-15', total: 1500, vendedorUserId: 'V1' }],
          },
        ],
        clientesRecentesTotal: 3,
        nomes: new Map([
          ['C1', 'Marcenaria Alfa'],
          ['V1', 'Regina'],
        ]),
      },
    };
    render(
      <MemoryRouter>
        <PedidosSemNotaBanner />
      </MemoryRouter>,
    );
    const t = document.body.textContent ?? '';
    expect(t).toMatch(/mais de 180 dias: R\$\s?110\.472,53 \(321\)/);
    expect(t).toContain('Ver os 3 clientes com pedido de 30–90 dias');
    expect(t).toContain('Marcenaria Alfa');
    expect(t).toContain('vendedor: Regina');
    expect(t).toContain('nº 4321 de 15/09');
    expect(t).toContain('+ 2 clientes menores nesta faixa.');
  });

  it('[SN-NOMES-FALHOU] leitura de nomes que falhou diz "nome indisponível", não "sem nome"', () => {
    estado = {
      isLoading: false,
      isError: false,
      data: {
        receita: 100,
        pedidos: 1,
        porEmpresa: [{ account: 'colacor', receita: 100, pedidos: 1 }],
        janela,
        ...semDetalhe,
        clientesRecentes: [
          { customerUserId: 'C1', account: 'colacor', receita: 100, pedidos: [{ id: 'p1', numero: null, data: '2026-10-01', total: 100, vendedorUserId: null }] },
        ],
        clientesRecentesTotal: 1,
        nomes: null,
      },
    };
    render(
      <MemoryRouter>
        <PedidosSemNotaBanner />
      </MemoryRouter>,
    );
    const t = document.body.textContent ?? '';
    expect(t).toContain('nome indisponível');
    expect(t).not.toContain('cliente sem nome no cadastro');
    expect(t).toContain('vendedor: sem vendedor');
  });
});
