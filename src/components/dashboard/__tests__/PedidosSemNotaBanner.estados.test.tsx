import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ResumoSemNota } from '@/lib/dashboard/pedidos-sem-nota';

/**
 * O aviso substituiu o "Dados de venda parciais" (que afirmava números SUBESTIMADOS, o contrário do
 * medido). Contrato: erro de leitura aparece como erro, nunca some; zero medido não mostra nada; o
 * número aparece com a ressalva de comissão e, no grupo, quebrado por empresa.
 */
type Estado = { data?: ResumoSemNota & { janela: { de: string; ate: string } }; isLoading: boolean; isError: boolean };
let estado: Estado = { isLoading: false, isError: false };
vi.mock('@/hooks/dashboard/usePedidosSemNota', () => ({ usePedidosSemNota: () => estado }));
vi.mock('@/contexts/CompanyContext', () => ({
  COMPANIES: { oben: { shortName: 'Oben' }, colacor: { shortName: 'Colacor' } },
}));

import { PedidosSemNotaBanner } from '../PedidosSemNotaBanner';

const janela = { de: '2025-10-12', ate: '2026-09-12' };

describe('PedidosSemNotaBanner', () => {
  it('[SN-ERRO] leitura que falhou aparece como "não consegui medir", nunca some', () => {
    estado = { isLoading: false, isError: true };
    render(<PedidosSemNotaBanner />);
    expect(screen.getByText(/Não consegui medir os pedidos sem nota/)).toBeTruthy();
    expect(screen.getByText(/não como base de comissão/)).toBeTruthy();
  });

  it('[SN-ZERO] zero MEDIDO não mostra aviso', () => {
    estado = { isLoading: false, isError: false, data: { receita: 0, pedidos: 0, porEmpresa: [], janela } };
    const { container } = render(<PedidosSemNotaBanner />);
    expect(container.textContent).toBe('');
  });

  it('[SN-NUMERO] mostra receita e pedidos, sem afirmar "subestimado"', () => {
    estado = {
      isLoading: false,
      isError: false,
      data: { receita: 205815, pedidos: 551, porEmpresa: [{ account: 'colacor', receita: 205815, pedidos: 551 }], janela },
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
      },
    };
    render(<PedidosSemNotaBanner />);
    expect(document.body.textContent).toMatch(/Oben: R\$\s?1\.295\.229,00 \(1187\) · Colacor: R\$\s?205\.815,00 \(551\)/);
  });
});
