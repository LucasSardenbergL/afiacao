import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * DRE fase 2 (decisão do founder, 2026-10-14): fechar/aprovar mês com resultado PROVISÓRIO é
 * permitido, mas AVISADO. Contrato: a célula do mês mostra "resultado provisório"; Fechar pede
 * confirmação (cancelar não chama a ação, confirmar chama); leitura dos snapshots que falha é
 * dita na tela e também pede confirmação — "não conferi" ≠ "sem pendência".
 */

let falharSnapshots = false;

function resposta(table: string): unknown {
  if (table === 'fin_dre_snapshots') {
    if (falharSnapshots) return { data: null, error: { code: '57014', message: 'statement timeout' } };
    return { data: [{ company: 'colacor', mes: 3, resultado_provisorio: true }, { company: 'colacor', mes: 4, resultado_provisorio: false }], error: null };
  }
  return { data: [], error: null };
}
function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range', 'neq', 'gte', 'lte', 'is', 'maybeSingle', 'single']) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));

const atualizar = vi.fn(async () => undefined);
vi.mock('@/services/financeiroV2Service', () => ({
  getFechamentos: async () => [
    { id: 'f3', company: 'colacor', ano: new Date().getFullYear(), mes: 3, status: 'em_revisao', versao: 1 },
    { id: 'f4', company: 'colacor', ano: new Date().getFullYear(), mes: 4, status: 'em_revisao', versao: 1 },
  ],
  criarFechamento: vi.fn(),
  atualizarFechamento: (...a: unknown[]) => atualizar(...(a as [])),
  getFechamentoLog: vi.fn(async () => []),
}));
vi.mock('@/services/financeiroService', () => ({ triggerFinanceiroSync: vi.fn() }));

import FinanceiroFechamento from '../FinanceiroFechamento';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><FinanceiroFechamento /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('FinanceiroFechamento — resultado provisório só avisa', () => {
  let confirmar: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { falharSnapshots = false; atualizar.mockClear(); confirmar = vi.spyOn(window, 'confirm'); });
  afterEach(() => { confirmar.mockRestore(); });

  it('marca o mês provisório e só ele', async () => {
    montar();
    await waitFor(() => expect(screen.getAllByText('resultado provisório').length).toBeGreaterThan(0));
    // colacor mar provisório; colacor abr false — o card da colacor tem exatamente 1 marca
    expect(screen.getAllByText('resultado provisório')).toHaveLength(1);
  });

  it('Fechar mês provisório pede confirmação: cancelar NÃO fecha, confirmar fecha', async () => {
    montar();
    await waitFor(() => expect(screen.getAllByText('resultado provisório').length).toBe(1));
    const fechar = () => screen.getAllByRole('button', { name: /Fechar/ });
    confirmar.mockReturnValueOnce(false);
    fireEvent.click(fechar()[0]); // mar (provisório) vem antes de abr na grade
    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(String(confirmar.mock.calls[0][0])).toMatch(/PROVISÓRIO/);
    expect(atualizar).not.toHaveBeenCalled();
    confirmar.mockReturnValueOnce(true);
    fireEvent.click(fechar()[0]);
    await waitFor(() => expect(atualizar).toHaveBeenCalledWith('f3', 'fechar', undefined));
  });

  it('mês sem pendência fecha sem perguntar', async () => {
    montar();
    await waitFor(() => expect(screen.getAllByText('resultado provisório').length).toBe(1));
    fireEvent.click(screen.getAllByRole('button', { name: /Fechar/ })[1]); // abr
    await waitFor(() => expect(atualizar).toHaveBeenCalledWith('f4', 'fechar', undefined));
    expect(confirmar).not.toHaveBeenCalled();
  });

  it('leitura dos snapshots falhou: aviso na tela e confirmação antes de fechar', async () => {
    falharSnapshots = true;
    montar();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Não foi possível conferir/));
    confirmar.mockReturnValueOnce(false);
    fireEvent.click(screen.getAllByRole('button', { name: /Fechar/ })[1]);
    expect(String(confirmar.mock.calls[0][0])).toMatch(/Não foi possível conferir/);
    expect(atualizar).not.toHaveBeenCalled();
  });
});

