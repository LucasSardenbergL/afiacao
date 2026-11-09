import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Pacote G (migration 20261111100000) no card "Prospectar hoje": os retornos vencidos e as posses que vencem em 48 h.
 * O HOOK roda de verdade; só o supabase é mockado por nome de RPC. O que pegaria a saída errada: aviso de posse que
 * some quando não há lead novo (a posse venceria calada), retorno que toma o lugar dos leads novos, e RPC antiga
 * (sem os campos) virando "zero retornos".
 */
type Resposta = { data: unknown; error: { message: string } | null };
const respostas: Record<string, Resposta> = {};
const rpc = vi.fn((nome: string, _args?: unknown) => {
  const r = Promise.resolve(respostas[nome] ?? { data: null, error: { message: `sem mock: ${nome}` } });
  return Object.assign(r, { order() { return this; }, range() { return this; } });
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (n: string, a?: unknown) => rpc(n, a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ role: 'employee', commercialRole: 'farmer' }) }));
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: () => ({ displayRole: 'employee', displayCommercialRole: 'farmer' }) }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'eu' }) }));
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  Link: ({ to, children, ...p }: { to: string; children: ReactNode }) => <a href={to} {...p}>{children}</a>,
}));
vi.mock('@/queries/useRadarRegistroEmpurrado', () => ({
  registrarCardExibido: () => Promise.resolve({ ok: true, registrado: true }),
  registrarAberturaEmpurrada: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));

import { ProspectarHojeCard } from '../ProspectarHojeCard';

const TERRITORIO = [{ municipio_codigo: '3122306', municipio_nome: 'DIVINOPOLIS', uf: 'MG', clientes: 358 }];
const LEAD = { posicao: 1, cnpj: '00000000000101', razao_social: 'Marcenaria Um Ltda', nome_fantasia: 'Marcenaria Um',
  municipio_nome: 'DIVINOPOLIS', uf: 'MG', score: 95, score_motivos: [], elegiveis: 8 };
const retorno = (i: number, extra: Record<string, unknown> = {}) => ({
  cnpj: `1010000000${String(i).padStart(4, '0')}`, nome_fantasia: `Retorno ${i}`, retorno_tipo: 'conversa',
  retorno_em: '2026-11-06', atrasado: true, nota: null, ...extra,
});

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ProspectarHojeCard /></QueryClientProvider>);
}

beforeEach(() => {
  rpc.mockClear(); navigate.mockClear(); track.mockClear();
  for (const k of Object.keys(respostas)) delete respostas[k];
  respostas.radar_atendimentos_ativos = { data: [], error: null };
});

describe('ProspectarHojeCard — acompanhamento (pacote G)', () => {
  it('retornos vêm à parte e NÃO tomam o lugar dos leads novos; abrir vai à ficha direta (não é lead empurrado)', async () => {
    respostas.radar_prospectar_hoje = { data: {
      territorio: TERRITORIO, leads: [LEAD],
      retornos: { total: 1, itens: [retorno(1, { nota: 'quer amostra' })] },
      posses: { vencendo: [], vencidas_7d: 0 },
    }, error: null };
    renderCard();
    expect(await screen.findByText('Retornos para hoje (1)')).toBeTruthy();
    expect(screen.getAllByTestId('prospectar-hoje-lead')).toHaveLength(1);
    expect(screen.getByTestId('prospectar-hoje-retorno').textContent).toMatch(/Em conversa · atrasado \(era 06\/11\) · quer amostra/);
    fireEvent.click(screen.getAllByRole('button', { name: /^Abrir ficha/ })[0]);
    expect(navigate).toHaveBeenCalledWith('/radar?cnpj=10100000000001');
    expect(rpc.mock.calls.some((c) => c[0] === 'radar_registrar_abertura_empurrada')).toBe(false);
  });

  it('mais de 3 retornos: mostra 3 e "Ver todos (N)" abre o resto — a agenda não esconde compromisso', async () => {
    respostas.radar_prospectar_hoje = { data: {
      territorio: TERRITORIO, leads: [LEAD],
      retornos: { total: 5, itens: [1, 2, 3, 4, 5].map((i) => retorno(i)) },
      posses: { vencendo: [], vencidas_7d: 0 },
    }, error: null };
    renderCard();
    expect(await screen.findAllByTestId('prospectar-hoje-retorno')).toHaveLength(3);
    fireEvent.click(screen.getByTestId('prospectar-hoje-retornos-todos'));
    expect(screen.getAllByTestId('prospectar-hoje-retorno')).toHaveLength(5);
  });

  it('posse vencendo aparece mesmo SEM território e sem lead novo (não vence calada) e conta o aviso exibido', async () => {
    respostas.radar_prospectar_hoje = { data: {
      territorio: [], leads: [], territorio_motivo: 'sem_carteira',
      retornos: { total: 0, itens: [] },
      posses: { vencendo: [{ atendimento_id: 9, cnpj: '22200000000101', razao_social: 'Lead 222', expira_em: '2026-11-09T15:00:00Z' }], vencidas_7d: 2 },
    }, error: null };
    renderCard();
    expect((await screen.findByTestId('prospectar-hoje-posses')).textContent).toMatch(/1 atendimento seu vence em até 48 h/);
    expect(screen.getByTestId('prospectar-hoje-posses-vencidas').textContent).toMatch(/2 atendimentos seus venceram/);
    expect(screen.getByText('Sem território no Radar')).toBeTruthy();
    expect(track).toHaveBeenCalledWith('radar.posse_aviso_exibido', { vencendo: 1, vencidas_7d: 2 });
  });

  it('RPC anterior ao pacote G (sem retornos/posses): nada de acompanhamento — ausente não vira "zero"', async () => {
    respostas.radar_prospectar_hoje = { data: { territorio: TERRITORIO, leads: [LEAD] }, error: null };
    renderCard();
    expect(await screen.findByTestId('prospectar-hoje-lead')).toBeTruthy();
    expect(screen.queryByTestId('prospectar-hoje-acompanhamento')).toBeNull();
  });
});
