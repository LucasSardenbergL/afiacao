import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Venda intragrupo sem cobrança na fila (migration 20261021190000): o botão só aparece para o master, só
 * em CP sem CR, e a gravação só é "sucesso" quando o banco devolve a linha atualizada — 0 linhas (RLS ou a
 * edge refez a linha) era toast de sucesso sobre decisão não gravada. Os hooks rodam de verdade; só o
 * supabase e o papel são mockados.
 */
type Resposta = { data: unknown; error: { message: string } | null };
let linhas: unknown[] = [];
let respostaUpdate: Resposta = { data: [{ id: 'm1' }], error: null };
let isMaster = true;
const updates: unknown[] = [];
const filtrosUpdate: Array<[string, unknown]> = [];
const toastSucesso = vi.fn();
const toastErro = vi.fn();

function builder() {
  let emUpdate = false;
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit']) q[m] = () => q;
  q.eq = (coluna: string, valor: unknown) => { if (emUpdate) filtrosUpdate.push([coluna, valor]); return q; };
  q.update = (payload: unknown) => { emUpdate = true; updates.push(payload); return q; };
  q.then = (ok: (r: Resposta) => unknown) =>
    Promise.resolve(emUpdate ? respostaUpdate : { data: linhas, error: null }).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => builder(),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u1' } } }) },
    functions: { invoke: () => Promise.resolve({ data: {}, error: null }) },
  },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isMaster }) }));
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSucesso(m), error: (m: string) => toastErro(m) } }));

import FinanceiroIntercompanyFila from '../FinanceiroIntercompanyFila';

const CP_SEM_CR = {
  id: 'm1', empresa_origem: 'colacor', empresa_destino: 'oben', cr_id: null, cp_id: 'cp1',
  valor_origem: null, valor_destino: 90000, diff_valor: 0, diff_dias: null,
  status: 'sem_contrapartida', matched_at: '2026-10-21T00:00:00Z', observacao: null,
};

function renderFila() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FinanceiroIntercompanyFila />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  linhas = [CP_SEM_CR];
  respostaUpdate = { data: [{ id: 'm1' }], error: null };
  isMaster = true;
  updates.length = 0;
  filtrosUpdate.length = 0;
  toastSucesso.mockClear();
  toastErro.mockClear();
});

describe('FinanceiroIntercompanyFila — venda sem cobrança', () => {
  it('master vê "Sem cobrança" num CP sem CR, e não vê "Aprovar" (um lado só só gera pendência)', async () => {
    renderFila();
    expect(await screen.findByRole('button', { name: /Sem cobrança/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Aprovar/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Ignorar/ })).toBeTruthy();
  });

  it('quem não é master não vê o botão (o trigger recusaria)', async () => {
    isMaster = false;
    renderFila();
    expect(await screen.findByRole('button', { name: /Ignorar/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sem cobrança/ })).toBeNull();
  });

  it('candidato com os dois lados segue com "Aprovar" (detector do teste acima)', async () => {
    linhas = [{ ...CP_SEM_CR, cr_id: 'cr1', valor_origem: 90000 }];
    renderFila();
    expect(await screen.findByRole('button', { name: /Aprovar/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sem cobrança/ })).toBeNull();
  });

  it('marcar grava o status novo e só diz sucesso com a linha devolvida', async () => {
    renderFila();
    fireEvent.click(await screen.findByRole('button', { name: /Sem cobrança/ }));
    await waitFor(() => expect(toastSucesso).toHaveBeenCalledTimes(1));
    expect(updates).toEqual([expect.objectContaining({ status: 'intragrupo_sem_cobranca' })]);
    expect(String(toastSucesso.mock.calls[0][0])).toContain('venda sem cobrança');
    expect(toastErro).not.toHaveBeenCalled();
  });

  it('0 linhas atualizadas (RLS ou linha refeita pela edge) é ERRO, não sucesso', async () => {
    respostaUpdate = { data: [], error: null };
    renderFila();
    fireEvent.click(await screen.findByRole('button', { name: /Sem cobrança/ }));
    await waitFor(() => expect(toastErro).toHaveBeenCalledTimes(1));
    expect(String(toastErro.mock.calls[0][0])).toContain('a linha não foi atualizada');
    expect(toastSucesso).not.toHaveBeenCalled();
  });

  it('linha marcada: master vê "Desfazer", que volta a sem_contrapartida', async () => {
    linhas = [{ ...CP_SEM_CR, status: 'intragrupo_sem_cobranca' }];
    renderFila();
    fireEvent.click(await screen.findByRole('button', { name: /Desfazer/ }));
    await waitFor(() => expect(toastSucesso).toHaveBeenCalledTimes(1));
    expect(updates).toEqual([expect.objectContaining({ status: 'sem_contrapartida' })]);
    // Só desfaz se a linha AINDA está marcada: um 2º "Desfazer" (outra aba) atualiza 0 linhas e vira erro,
    // em vez de regravar sem_contrapartida resolvido (que a edge trava para sempre).
    expect(filtrosUpdate).toEqual([['id', 'm1'], ['status', 'intragrupo_sem_cobranca']]);
  });
});
