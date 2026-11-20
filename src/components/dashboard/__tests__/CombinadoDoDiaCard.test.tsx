import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { CombinadoVendedora } from '@/hooks/dashboard/useCombinadoDia';

/**
 * Combinado do dia (Meu dia do CEO): fonte que falhou é DECLARADA e lista vazia com falha não diz "nada a fazer";
 * copiar põe o texto no clipboard e grava a lista datada no ledger (sensor).
 */
let estado: { vendedoras: CombinadoVendedora[]; erroVendedoras: boolean; carregando: boolean };
const registrar = vi.fn(async () => true);
vi.mock('@/hooks/dashboard/useCombinadoDia', () => ({
  useCombinadoDia: () => estado,
  registrarCombinado: (...a: unknown[]) => registrar(...(a as [])),
}));
vi.mock('@/contexts/CompanyContext', () => ({
  COMPANIES: { oben: { shortName: 'Oben' }, colacor: { shortName: 'Colacor' } },
}));
vi.mock('@/lib/dashboard/sp-date', () => ({ hojeSP: () => '2026-11-20' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CombinadoDoDiaCard } from '../CombinadoDoDiaCard';

const regina = (over: Partial<CombinadoVendedora> = {}): CombinadoVendedora => ({
  id: 'R',
  nome: 'REGINA CELIA',
  itens: [
    { tipo: 'cobranca', empresa: 'oben', clienteRef: '7', nome: 'ACME', valor: 1500, detalhe: 'cobrar R$ 1.500,00 vencido' },
  ],
  fontesComErro: [],
  carregando: false,
  ...over,
});

describe('CombinadoDoDiaCard', () => {
  beforeEach(() => registrar.mockClear());

  it('[CMB-COPIA] copiar põe o texto no clipboard e grava no ledger', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    estado = { vendedoras: [regina()], erroVendedoras: false, carregando: false };
    render(<CombinadoDoDiaCard />);
    expect(screen.getByText('ACME')).toBeTruthy();
    fireEvent.click(screen.getByText('Copiar para WhatsApp'));
    await waitFor(() => expect(registrar).toHaveBeenCalledTimes(1));
    const texto = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(texto).toContain('Combinado de hoje (20/11), REGINA:');
    expect(texto).toContain('1. ACME (Oben): cobrar R$ 1.500,00 vencido');
    expect(registrar).toHaveBeenCalledWith('R', regina().itens);
  });

  it('[CMB-FONTE-ERRO] fonte não lida é declarada; vazio com falha NÃO diz "nada a combinar"', () => {
    estado = {
      vendedoras: [regina({ itens: [], fontesComErro: ['recompra', 'cobrança Oben'] })],
      erroVendedoras: false,
      carregando: false,
    };
    render(<CombinadoDoDiaCard />);
    const t = document.body.textContent ?? '';
    expect(t).toContain('Não consegui ler: recompra, cobrança Oben');
    expect(t).not.toContain('Nada a combinar hoje');
    expect(screen.queryByText('Copiar para WhatsApp')).toBeNull();
  });

  it('[CMB-VAZIO] vazio com as fontes lidas é afirmação: nada a combinar', () => {
    estado = { vendedoras: [regina({ itens: [] })], erroVendedoras: false, carregando: false };
    render(<CombinadoDoDiaCard />);
    expect(document.body.textContent).toContain('Nada a combinar hoje');
  });

  it('[CMB-SEM-VENDEDORAS] erro na lista de vendedoras aparece como erro', () => {
    estado = { vendedoras: [], erroVendedoras: true, carregando: false };
    render(<CombinadoDoDiaCard />);
    expect(document.body.textContent).toContain('Não consegui ler a lista de vendedoras');
  });
});
