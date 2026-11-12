import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Revisão do Radar 2026-11-11, item 5 — o cadastro em LOTE no Omie ia direto ao ERP com a linha da lista, sem as
 * checagens da ficha. Agora a edge relê o lead e RECUSA criar o inelegível; aqui, com o hook REAL do lote e o núcleo
 * real (`cadastrarEmpresaNoOmie`), o item recusado fica "recusado" com o motivo — terminal, fora das pendências — e o
 * do lado segue normal. Só a I/O (`depsCadastroSupabase`) é falsa.
 */
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-recusado' } }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
const deps = vi.hoisted(() => ({
  criarNoOmie: vi.fn(),
  registrarNoRadar: vi.fn(),
  lerEstado: vi.fn(),
  registrarConflito: vi.fn(),
}));
vi.mock('@/queries/useRadarAcoesLead', () => ({ depsCadastroSupabase: deps }));

import { useRadarLoteOmie } from '../useRadarLote';
import { chaveLotePersistido, parsearLote } from '@/lib/radar/lote-persistido';

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
const BAIXADA = { cnpj: '11111111000111', razao_social: 'Baixada Ltda', rfb_situacao: '08' } as unknown as RadarEmpresa;
const ATIVA = { cnpj: '22222222000122', razao_social: 'Ativa Ltda', rfb_situacao: '02' } as unknown as RadarEmpresa;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  deps.lerEstado.mockResolvedValue({ vinculo: null, conflitos: [] });
  deps.registrarNoRadar.mockResolvedValue({ ok: true, deduped: false });
  deps.criarNoOmie.mockImplementation(async (e: RadarEmpresa) => (e.cnpj === BAIXADA.cnpj
    ? { success: false, code: 'RADAR_INELEGIVEL', motivo: 'rfb_nao_ativa', error: 'RADAR_INELEGIVEL: rfb_nao_ativa' }
    : { success: true, created: true, codigo_cliente: 901 }));
});

describe('useRadarLoteOmie — recusa do servidor', () => {
  it('o inelegível vira "recusado" (terminal, com motivo); o elegível é cadastrado; o lote conclui', async () => {
    const h = renderHook(() => useRadarLoteOmie(), { wrapper });
    act(() => { expect(h.result.current.iniciar([BAIXADA, ATIVA])).toBe(true); });
    await waitFor(() => expect(h.result.current.rodando).toBe(false));

    const porCnpj = new Map(h.result.current.lote!.itens.map((i) => [i.cnpj, i.estado]));
    expect(porCnpj.get(BAIXADA.cnpj)).toMatchObject({ status: 'recusado', motivo: 'rfb_nao_ativa' });
    expect(porCnpj.get(ATIVA.cnpj)).toMatchObject({ status: 'ok', codigo: '901' });
    expect(h.result.current.progresso?.pendentes).toBe(0);
    expect(h.result.current.temPendencias).toBe(false);
    // O Radar só grava o vínculo do cadastrado.
    expect(deps.registrarNoRadar).toHaveBeenCalledTimes(1);
    expect(deps.registrarNoRadar).toHaveBeenCalledWith(ATIVA.cnpj, '901', false);
    // Concluído (ok + recusado) não fica no storage: não há o que retomar — a recusa não reabre o banner de pendência.
    expect(parsearLote(localStorage.getItem(chaveLotePersistido('u-recusado')))).toBeNull();
  });
});
