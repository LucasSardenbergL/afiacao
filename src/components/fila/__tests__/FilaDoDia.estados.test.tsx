import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AcaoSugerida } from '@/lib/fila/types';

const filaMock = vi.fn();
vi.mock('@/hooks/useFilaAcoes', () => ({ useFilaAcoes: () => filaMock() }));
vi.mock('@/hooks/useCriticaFila', () => ({ useCriticaFila: () => new Map() }));
vi.mock('@/hooks/useRegistrarContato', () => ({
  useContatosDoDia: () => ({ data: new Map([['c1', 'nao_atendeu']]) }),
  rotuloResultado: (r: string) => (r === 'nao_atendeu' ? 'Não atendeu' : r),
}));
vi.mock('@/components/venda-cliente/FichaLigacao', () => ({ FichaLigacao: () => null }));
vi.mock('@/components/fila/AcaoOutcomeMenu', () => ({ AcaoOutcomeMenu: () => null }));
vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { FilaDoDia } from '../FilaDoDia';

const acaoRecompra: AcaoSugerida = {
  fonte: 'recompra', entidadeId: 'c1', clienteUserId: 'c1', clienteNome: 'Marcenaria A',
  telefone: '(37) 3221-0000', acao: 'Ligar', titulo: 'Marcenaria A',
  motivo: 'entrega amanhã em Divinopolis · 2 itens atrasados', categoria: 'esperado', score: 0.2,
  valorEsperado: 1500, tipoValor: 'estimado', cta: 'ligar', dedupeKey: 'recompra:c1',
  payload: { kind: 'recompra', compradorId: 'c1', sugestaoIds: ['s1', 's2'] },
};

function fila(over: Record<string, unknown>) {
  return { acoes: [], isLoading: false, isError: false, fontesComErro: [], recompra: { tipo: 'pronta', resp: { dia: 'x', compradores: [] } }, retry: vi.fn(), ...over };
}

const renderFila = () => render(<MemoryRouter><FilaDoDia /></MemoryRouter>);

/** Prefixos dos módulos congelados pelo M-41 + as telas aposentadas da farmer (spec §7 Fase 5). */
const CONGELADOS = /^\/(rota|whatsapp|telefonia|tarefas)(\/|$|\?)|^\/farmer\/(calls|recommendations|bundles|tactical-plan|copilot)/;
const hrefsInternos = () =>
  [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '').filter((h) => h.startsWith('/'));

beforeEach(() => { vi.clearAllMocks(); });

describe('FilaDoDia — estados', () => {
  it('onda desligada → mensagem "começa em breve", não lista vazia', () => {
    filaMock.mockReturnValue(fila({ recompra: { tipo: 'onda_desligada' } }));
    renderFila();
    expect(screen.getByText(/Sua lista de quem ligar começa em breve/)).toBeInTheDocument();
    expect(screen.queryByText(/Ninguém na sua lista hoje/)).toBeNull();
    expect(screen.queryByText(/carteira está em dia/i)).toBeNull();
  });

  it('lente "Ver como" → aviso de que a lista da vendedora não é lida, não "ninguém hoje"', () => {
    filaMock.mockReturnValue(fila({ recompra: { tipo: 'lente' } }));
    renderFila();
    expect(screen.getByText(/lista de recompra da vendedora não é exibida/)).toBeInTheDocument();
    expect(screen.queryByText(/Ninguém na sua lista hoje/)).toBeNull();
  });

  it('erro da recompra ≠ dia limpo', () => {
    filaMock.mockReturnValue(fila({ isError: true, fontesComErro: ['recompra'], recompra: { tipo: 'erro', erro: new Error('x') } }));
    renderFila();
    expect(screen.getByText(/Não consegui carregar sua fila/)).toBeInTheDocument();
    expect(screen.getByText(/lista de recompra/)).toBeInTheDocument();
  });

  it('lista pronta: cliente, motivo, ligar por tel: e o desfecho já registrado', () => {
    filaMock.mockReturnValue(fila({ acoes: [acaoRecompra] }));
    renderFila();
    expect(screen.getByRole('button', { name: 'Marcenaria A' })).toBeInTheDocument();
    expect(screen.getByText(/2 itens atrasados/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ligar para/ })).toHaveAttribute('href', 'tel:3732210000');
    expect(screen.getByText('Não atendeu')).toBeInTheDocument();
  });

  it.each([
    ['vazia', fila({})],
    ['pronta', fila({ acoes: [acaoRecompra] })],
    ['onda desligada', fila({ recompra: { tipo: 'onda_desligada' } })],
  ])('nenhum link para módulo congelado (%s)', (_n, estado) => {
    filaMock.mockReturnValue(estado);
    renderFila();
    expect(hrefsInternos().filter((h) => CONGELADOS.test(h))).toEqual([]);
  });
});

describe('FarmerDashboardV2 — Meu Dia sem entradas para módulos congelados', () => {
  it('não contém link para /rota, /whatsapp, /telefonia (nem modo antigo, SLA, chamadas)', () => {
    const src = readFileSync(resolve(__dirname, '../../dashboard/FarmerDashboardV2.tsx'), 'utf8');
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codigo).not.toMatch(/['"`]\/(rota|whatsapp|telefonia|tarefas)/);
    expect(codigo).not.toMatch(/SlaCardMeuDia|AgendaTodayList|MinhasTarefasCard|KpisToday|ChamadasPendentesNudge|modoAntigo/);
    expect(codigo).toMatch(/<FilaDoDia \/>/);
  });
});
