import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * /admin/reposicao/calendario — leitura que falha NÃO vira grade de "regra base", "nenhuma pendência" nem
 * "nenhum período". Ausente ≠ zero: com a tabela da empresa caída, a regra base sozinha AFIRMARIA "aberto"
 * em pleno recesso.
 *
 * Molde de AdminReposicaoCadastros.leitura-falhou: a query roda de verdade, só o supabase é mockado,
 * roteado por TABELA/RPC — a falha é a da leitura em causa, não um apagão. O CONTROLE (leituras boas,
 * zero linhas) fica no mesmo arquivo: a suíte só vale se o caminho feliz continuar desenhando a grade.
 */

type Resposta = { data: unknown; error: { message: string } | null };

const OK_VAZIO: Resposta = { data: [], error: null };
const FALHA: Resposta = { data: null, error: { message: 'permission denied' } };
let porFonte: Record<string, Resposta> = {};
let auth = { isMaster: true, user: { id: 'u-master' } };

function builder(resposta: () => Resposta) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'range', 'limit', 'eq', 'in', 'gte', 'lte', 'gt', 'delete', 'upsert']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resposta()).then(ok, ko);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => builder(() => porFonte[tabela] ?? OK_VAZIO),
    rpc: (nome: string) => builder(() => porFonte[`rpc:${nome}`] ?? OK_VAZIO),
  },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import AdminReposicaoCalendario from '../AdminReposicaoCalendario';

function renderPagina(url = '/admin/reposicao/calendario?empresa=OBEN&ano=2026&mes=12') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <AdminReposicaoCalendario />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  porFonte = {};
  auth = { isMaster: true, user: { id: 'u-master' } };
  // Só o Date: hoje fixo em 2026-11-18 (sem bomba-relógio), sem congelar os timers do react-query.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-18T15:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('AdminReposicaoCalendario — leitura que falha não vira vazio', () => {
  it('CONTROLE: leituras boas e vazias desenham a grade pela regra base e listam pendências', async () => {
    renderPagina();
    const grade = await screen.findByTestId('grade-mes');
    // 25/12/2026 é sexta, sem linha → aberto pela regra base; 26/12 sábado → fechado.
    const sab = grade.querySelector('[data-status="fechado"][data-regra-base="1"]');
    const util = grade.querySelector('[data-status="aberto"][data-regra-base="1"]');
    expect(sab).not.toBeNull();
    expect(util).not.toBeNull();
    // sem nenhum dia cadastrado ⇒ "calendário curto" é pendência, não "nenhuma pendência"
    expect(await screen.findByTestId('lista-pendencias')).toBeTruthy();
    expect(screen.queryByTestId('aviso-grade')).toBeNull();
    expect(screen.queryByTestId('aviso-pendencias')).toBeNull();
    expect(await screen.findByText('Nenhum período fechado em 2026')).toBeTruthy();
  });

  it('ERRO na tabela da empresa: aviso honesto, SEM grade e SEM lista de pendências', async () => {
    porFonte = { calendario_operacao_empresa: FALHA };
    renderPagina();
    const aviso = await screen.findByTestId('aviso-grade');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByTestId('grade-mes')).toBeNull();
    expect((await screen.findByTestId('aviso-pendencias')).getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByTestId('lista-pendencias')).toBeNull();
    expect(screen.queryByText('Nenhuma pendência')).toBeNull();
    expect(await screen.findByTestId('aviso-recesso')).toBeTruthy();
  });

  it('ERRO nos períodos dos fornecedores: aviso, NÃO "Nenhum período fechado"', async () => {
    porFonte = { calendario_operacao_fornecedor: FALHA };
    renderPagina();
    expect((await screen.findByTestId('aviso-fornecedores')).getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByText('Nenhum período fechado em 2026')).toBeNull();
    // a regra "fornecedor sem recesso" depende dessa leitura: pendências também não afirmam nada
    expect(await screen.findByTestId('aviso-pendencias')).toBeTruthy();
  });

  it('ERRO na RPC de dias sem NF (OBEN): pendências dizem que não carregaram', async () => {
    porFonte = { 'rpc:calendario_dias_sem_nf': FALHA };
    renderPagina();
    expect((await screen.findByTestId('aviso-pendencias')).getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByTestId('lista-pendencias')).toBeNull();
    // a grade não depende da RPC e continua de pé
    expect(await screen.findByTestId('grade-mes')).toBeTruthy();
  });

  it('ERRO na RPC de itens a antecipar (com recesso cadastrado): aviso, NÃO "Nada a antecipar"', async () => {
    porFonte = {
      calendario_operacao_empresa: {
        data: [{ data: '2026-12-24', status: 'fechado', peso: 0, motivo: 'recesso', origem: 'escala' }],
        error: null,
      },
      'rpc:calendario_itens_antecipar': FALHA,
    };
    renderPagina();
    expect((await screen.findByTestId('aviso-antecipar')).getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByText('Nada a antecipar')).toBeNull();
  });

  it('quem não é master não vê ações de escrita', async () => {
    auth = { isMaster: false, user: { id: 'u-employee' } };
    renderPagina();
    await screen.findByTestId('grade-mes');
    await waitFor(() => expect(screen.queryByTestId('lista-pendencias')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Incluir' })).toBeNull();
    expect(screen.getByText(/Somente leitura/)).toBeTruthy();
  });
});
