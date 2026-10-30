import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Cadastro no Omie EM MASSA (e a retomada do lote) é só do gestor/master; o vendedor cadastra em
 * 1 clique pela ficha. Barreira de UI declarada (o servidor não distingue massa de 1 clique).
 */
let auth = { isMaster: false, isGestorComercial: false };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/queries/useRadarLote', () => ({ useRadarAcaoEmLote: () => ({ rodando: false, executar: vi.fn() }) }));
vi.mock('@/queries/useRegistrarContatoRadar', () => ({ registrarContatoRadar: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { RadarAcoesLote } from '../RadarAcoesLote';

const emp = (cnpj: string) => ({ cnpj, razao_social: `E ${cnpj}` }) as RadarEmpresa;
type LoteOmie = Parameters<typeof RadarAcoesLote>[0]['loteOmie'];
const lote = (over: Partial<Record<string, unknown>> = {}) =>
  ({ rodando: false, temPendencias: false, iniciar: vi.fn(() => true), ...over }) as unknown as LoteOmie;

function renderBarra(l = lote()) {
  return render(
    <RadarAcoesLote selecao={[emp('11111111000111'), emp('22222222000122')]} onLimpar={() => {}} onRemover={() => {}} loteOmie={l} onAbrirLote={() => {}} />,
  );
}

beforeEach(() => { auth = { isMaster: false, isGestorComercial: false }; });

describe('RadarAcoesLote — lote no Omie só para gestor/master', () => {
  it('vendedor: sem "Cadastrar no Omie" e sem "Lote pendente"; o resto da barra fica', () => {
    renderBarra();
    expect(screen.queryByText(/Cadastrar no Omie/)).toBeNull();
    expect(screen.getByText('Comparar')).toBeTruthy();
    expect(screen.getByText('Descartar')).toBeTruthy();
  });
  it('vendedor com lote pendente no navegador: a retomada também some', () => {
    renderBarra(lote({ temPendencias: true }));
    expect(screen.queryByText(/Lote pendente/)).toBeNull();
  });
  it('gestor comercial vê o lote', () => {
    auth = { isMaster: false, isGestorComercial: true };
    renderBarra();
    expect(screen.getByText(/Cadastrar no Omie/)).toBeTruthy();
  });
  it('master vê a retomada', () => {
    auth = { isMaster: true, isGestorComercial: false };
    renderBarra(lote({ temPendencias: true }));
    expect(screen.getByText(/Lote pendente/)).toBeTruthy();
  });
  it('a barra não oferece "Criar tarefas" a ninguém', () => {
    auth = { isMaster: true, isGestorComercial: false };
    renderBarra();
    expect(screen.queryByText(/Criar tarefas/)).toBeNull();
  });
});
