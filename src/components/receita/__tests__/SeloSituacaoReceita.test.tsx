import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Selo da Receita (Frente 5) — o HOOK roda de verdade; só supabase, auth e track são mockados.
 * Money-path: ausente ≠ ativa (nunca selo "ok"), falha de leitura ≠ silêncio, recusa de escopo só
 * pelo discriminador, e o selo de um cliente nunca aparece em outro durante a troca.
 */
type Resp = { data: unknown; error: { code?: string; hint?: string | null; message?: string } | null };
const respostas = new Map<string, () => Promise<Resp>>();
const rpc = vi.fn((_fn: string, args: { p_customer_user_id: string }) => {
  const r = respostas.get(args.p_customer_user_id);
  return r ? r() : Promise.resolve({ data: null, error: { code: 'X', message: 'sem mock' } });
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (fn: string, a: { p_customer_user_id: string }) => rpc(fn, a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'vendedor-1' } }) }));
const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));

import { SeloSituacaoReceita, type SuperficieSituacaoReceita } from '../SeloSituacaoReceita';
import { interpretarRespostaSituacao } from '@/lib/receita/situacao-cliente';

const linha = (over: Record<string, unknown> = {}) => ({
  estado: 'irregular', cnpj: '11111111000191', situacao: '08', data_situacao: '2026-03-15',
  motivo_descricao: 'EXTINCAO', lote: '2026-10', lote_vigente: '2026-10', confirmado_no_vigente: true, ...over,
});
const ok = (over: Record<string, unknown> = {}) => () => Promise.resolve({ data: [linha(over)], error: null });

/** Cache VENCIDO de uma leitura anterior do cliente (o staleTime do hook é 5 min). */
type Cache = { id: string; linha: Record<string, unknown> };
function montar(customerUserId: string | null, superficie: SuperficieSituacaoReceita = 'pedido', cache?: Cache) {
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: 60_000 } } });
  if (cache) {
    const dado = interpretarRespostaSituacao([cache.linha], null);
    qc.setQueryData(['situacao-receita-cliente', 'vendedor-1', cache.id], dado, { updatedAt: Date.now() - 3_600_000 });
  }
  const ui = (id: string | null) => (
    <QueryClientProvider client={qc}>
      <SeloSituacaoReceita customerUserId={id} superficie={superficie} />
    </QueryClientProvider>
  );
  const r = render(ui(customerUserId));
  return { ...r, trocar: (id: string | null) => r.rerender(ui(id)) };
}
const lidas = () => track.mock.calls.filter((c) => c[0] === 'cliente.situacao_receita_lida').map((c) => c[1]);

beforeEach(() => { respostas.clear(); rpc.mockClear(); track.mockClear(); onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('SeloSituacaoReceita', () => {
  it('irregular confirmado: selo com situação, data e base; no pedido diz que não bloqueia; sensores sem CNPJ', async () => {
    respostas.set('c1', ok());
    montar('c1');
    const selo = await screen.findByTestId('selo-situacao-receita');
    expect(selo.textContent).toContain('CNPJ baixado na Receita');
    expect(selo.textContent).toContain('desde 15/03/2026 · base RFB 2026-10');
    expect(selo.textContent).toContain('não bloqueia o pedido');
    expect(selo.getAttribute('data-confirmado')).toBe('sim');
    expect(lidas()).toEqual([{ superficie: 'pedido', estado: 'irregular' }]);
    expect(track).toHaveBeenCalledWith('cliente.situacao_receita_irregular_exibida', {
      superficie: 'pedido', situacao: '08', confirmado: true,
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain('11111111000191');
  });

  it('irregular de lote velho: "último registro", sem afirmar situação atual', async () => {
    respostas.set('c1', ok({ lote: '2026-09', confirmado_no_vigente: false }));
    montar('c1', 'ficha');
    const selo = await screen.findByTestId('selo-situacao-receita');
    expect(selo.textContent).toContain('Último registro na Receita: CNPJ baixado');
    expect(selo.textContent).toContain('sem confirmação no lote 2026-10');
    expect(selo.textContent).not.toContain('não bloqueia o pedido');
  });

  it.each(['ativa', 'sem_dado', 'sem_cnpj', 'sem_documento', 'outra'])('%s: nada na tela (nunca selo verde), mas a leitura é contada', async (estado) => {
    respostas.set('c1', ok({ estado, situacao: estado === 'ativa' ? '02' : estado === 'outra' ? '01' : null }));
    const { container } = montar('c1');
    await waitFor(() => expect(lidas()).toEqual([{ superficie: 'pedido', estado }]));
    expect(container.textContent).toBe('');
  });

  it('fora da carteira (42501 + fora_da_carteira): silêncio, contado como sem_acesso', async () => {
    respostas.set('c1', () => Promise.resolve({ data: null, error: { code: '42501', hint: 'fora_da_carteira', message: 'x' } }));
    const { container } = montar('c1');
    await waitFor(() => expect(lidas()).toEqual([{ superficie: 'pedido', estado: 'sem_acesso' }]));
    expect(container.textContent).toBe('');
  });

  it('42501 SEM o discriminador é falha: linha "indisponível" (não vira silêncio)', async () => {
    respostas.set('c1', () => Promise.resolve({ data: null, error: { code: '42501', hint: null, message: 'permission denied' } }));
    montar('c1');
    const aviso = await screen.findByTestId('situacao-receita-indisponivel', {}, { timeout: 8000 });
    expect(aviso.textContent).toContain('confirme o CNPJ antes de vender a prazo');
    expect(lidas()).toEqual([{ superficie: 'pedido', estado: 'erro' }]);
  }, 10_000);

  it('resposta fora do contrato (0 linhas): indisponível, sem retry, nunca "sem dado"', async () => {
    respostas.set('c1', () => Promise.resolve({ data: [], error: null }));
    montar('c1', 'ficha');
    expect((await screen.findByTestId('situacao-receita-indisponivel')).textContent).toContain('Não consegui consultar');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(lidas()).toEqual([{ superficie: 'ficha', estado: 'erro_contrato' }]);
  });

  it('offline (consulta pausada): indisponível, não silêncio', async () => {
    onlineManager.setOnline(false);
    respostas.set('c1', ok());
    montar('c1');
    await screen.findByTestId('situacao-receita-indisponivel');
    expect(rpc).not.toHaveBeenCalled();
    expect(lidas()).toEqual([{ superficie: 'pedido', estado: 'offline' }]);
  });

  it('offline com cache VENCIDO de "ativa": indisponível, nunca o cache passando por leitura nova', async () => {
    onlineManager.setOnline(false);
    const { container } = montar('c1', 'pedido', { id: 'c1', linha: linha({ estado: 'ativa', situacao: '02' }) });
    await screen.findByTestId('situacao-receita-indisponivel');
    expect(container.textContent).toContain('indisponível');
    expect(lidas()).toEqual([{ superficie: 'pedido', estado: 'offline' }]);
  });

  it('cache irregular vencido sem leitura nova (offline): só "indisponível" e nenhum irregular_exibida', async () => {
    onlineManager.setOnline(false);
    montar('c1', 'ficha', { id: 'c1', linha: linha() });
    await screen.findByTestId('situacao-receita-indisponivel');
    expect(screen.queryByTestId('selo-situacao-receita')).toBeNull();
    expect(track.mock.calls.filter((c) => c[0] === 'cliente.situacao_receita_irregular_exibida')).toEqual([]);
  });

  it('A→B→A na mesma montagem: 1 leitura por cliente e 1 selo exibido', async () => {
    respostas.set('a', ok());
    respostas.set('b', ok({ estado: 'ativa', situacao: '02' }));
    const { trocar } = montar('a');
    await screen.findByTestId('selo-situacao-receita');
    trocar('b');
    await waitFor(() => expect(lidas()).toHaveLength(2));
    trocar('a');
    await screen.findByTestId('selo-situacao-receita');
    expect(lidas()).toEqual([{ superficie: 'pedido', estado: 'irregular' }, { superficie: 'pedido', estado: 'ativa' }]);
    expect(track.mock.calls.filter((c) => c[0] === 'cliente.situacao_receita_irregular_exibida')).toHaveLength(1);
  });

  it('troca A→B com B lento: o selo de A some na hora e não aparece no B', async () => {
    let soltarB: (r: Resp) => void = () => {};
    respostas.set('a', ok());
    respostas.set('b', () => new Promise<Resp>((res) => { soltarB = res; }));
    const { trocar } = montar('a');
    await screen.findByTestId('selo-situacao-receita');
    trocar('b');
    expect(screen.queryByTestId('selo-situacao-receita')).toBeNull();
    soltarB({ data: [linha({ estado: 'ativa', situacao: '02' })], error: null });
    await waitFor(() => expect(lidas()).toContainEqual({ superficie: 'pedido', estado: 'ativa' }));
    expect(screen.queryByTestId('selo-situacao-receita')).toBeNull();
  });

  it('pedido sem cliente vinculado: diz que não consultou; ficha sem id: nada', () => {
    const { trocar } = montar(null, 'pedido');
    expect(screen.getByTestId('situacao-receita-nao-consultada')).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
    trocar(null);
    expect(lidas()).toEqual([{ superficie: 'pedido', estado: 'sem_vinculo' }]);
  });
});
