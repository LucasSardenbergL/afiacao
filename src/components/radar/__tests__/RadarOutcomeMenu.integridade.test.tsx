// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Integridade do contato (20261031111000): "virou cliente" só com o cliente confirmado no Omie (RD005), cliente
 * confirmado só sai pelo gestor (RD007), a conversão não ganha "Desfazer" (RD006) e o desfazer que só removeu o
 * registro diz "status preservado" — nunca "Desfeito". Os hooks de I/O são substituídos; o servidor tem prova própria
 * (db/test-radar-contato-integridade.sh).
 */
const { registrar, desfazer, track, toast } = vi.hoisted(() => ({
  registrar: vi.fn(),
  desfazer: vi.fn(),
  track: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('@/queries/useRegistrarContatoRadar', () => ({
  useRegistrarContatoRadar: () => ({ mutateAsync: registrar, isPending: false }),
  useDesfazerContatoRadar: () => ({ mutateAsync: desfazer }),
}));
vi.mock('@/queries/useRadarAcoesLead', () => ({
  useRadarCadastrarOmie: () => ({ mutateAsync: vi.fn(), isPending: false }),
  lerLeadParaCadastro: vi.fn(),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));
vi.mock('sonner', () => ({ toast }));

import { RadarOutcomeMenu } from '../RadarOutcomeMenu';

const lead = {
  cnpj: '12345678000195',
  razao_social: 'MOVEIS TESTE LTDA',
  ja_cliente: false,
  omie_codigo_cliente: null,
  prospeccao_status: 'a_contatar',
  ultimo_lote: '2026-08',
  rfb_situacao: '02',
  score: 40,
} as unknown as RadarEmpresa;
const cliente = { ...lead, ja_cliente: true, omie_codigo_cliente: '555', prospeccao_status: 'em_conversa' } as unknown as RadarEmpresa;

class RO { observe() {} unobserve() {} disconnect() {} }

async function abrirMenu() {
  const trigger = screen.getByRole('button', { name: /registrar contato/i });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
}
async function abrirMenuEClicar(rotulo: RegExp) {
  await abrirMenu();
  fireEvent.click(await screen.findByText(rotulo));
}
/** A ação "Desfazer" do último toast de sucesso (ou undefined, se ele não tem). */
const acaoDoToast = () => (toast.success.mock.calls.at(-1)?.[1] as { action?: { onClick: () => void } } | undefined)?.action;

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  registrar.mockResolvedValue({ id: 'c1', deduped: false });
});

describe('RadarOutcomeMenu — "virou cliente" só com o cliente confirmado', () => {
  it('sem vínculo Omie: o item aparece DESABILITADO, com o caminho, e não registra', async () => {
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} />);
    await abrirMenu();
    const item = (await screen.findByText(/virou cliente \(pelo cadastro no omie\)/i)).closest('[role="menuitem"]');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item as Element);
    expect(registrar).not.toHaveBeenCalled();
  });

  it('no card da rota (sem empresa) também fica desabilitado: não há como saber do vínculo', async () => {
    render(<RadarOutcomeMenu cnpj={lead.cnpj} />);
    await abrirMenu();
    const item = (await screen.findByText(/virou cliente \(pelo cadastro no omie\)/i)).closest('[role="menuitem"]');
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('com vínculo: registra, e o toast da conversão NÃO oferece "Desfazer" (RD006)', async () => {
    render(<RadarOutcomeMenu cnpj={cliente.cnpj} empresa={cliente} />);
    await abrirMenuEClicar(/^virou cliente$/i);
    await waitFor(() => expect(registrar).toHaveBeenCalledWith({ cnpj: cliente.cnpj, acao: 'virou_cliente', nota: undefined }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Marcado: virou cliente'));
    expect(acaoDoToast()).toBeUndefined();
  });

  it('RD005 do servidor: aviso que aponta o cadastro (não "não foi possível")', async () => {
    registrar.mockRejectedValue({ code: 'RD005', message: 'RADAR_VIROU_CLIENTE_SEM_CONFIRMACAO' });
    render(<RadarOutcomeMenu cnpj={cliente.cnpj} empresa={cliente} />);
    await abrirMenuEClicar(/^virou cliente$/i);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('"Virou cliente" vem do cadastro no Omie', expect.anything()));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('RD007 do servidor (vendedor tira cliente confirmado): aviso de que é do gestor', async () => {
    registrar.mockRejectedValue({ code: 'RD007', message: 'RADAR_CLIENTE_CONFIRMADO' });
    render(<RadarOutcomeMenu cnpj={cliente.cnpj} empresa={cliente} />);
    await abrirMenuEClicar(/não atendeu/i);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Já é cliente confirmado no Omie', expect.anything()));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a MENSAGEM igual com outra SQLSTATE não classifica: segue erro genérico', async () => {
    registrar.mockRejectedValue({ code: 'P0001', message: 'RADAR_VIROU_CLIENTE_SEM_CONFIRMACAO' });
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} />);
    await abrirMenuEClicar(/não atendeu/i);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível registrar'));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('RadarOutcomeMenu — o "Desfazer" diz o que o servidor fez', () => {
  async function registrarEDesfazer(resposta: unknown) {
    if (resposta instanceof Error) desfazer.mockRejectedValue(resposta);
    else desfazer.mockResolvedValue(resposta);
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} />);
    await abrirMenuEClicar(/não atendeu/i);
    await waitFor(() => expect(acaoDoToast()).toBeDefined());
    acaoDoToast()?.onClick();
    await waitFor(() => expect(desfazer).toHaveBeenCalledWith('c1'));
  }

  it('dono do status: "Desfeito"', async () => {
    await registrarEDesfazer({ deleted: true, statusRestaurado: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Desfeito'));
  });

  it('outro escreveu depois: "Registro removido; status preservado" — nunca "Desfeito"', async () => {
    await registrarEDesfazer({ deleted: true, statusRestaurado: false });
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Registro removido; status preservado', expect.anything()));
    expect(toast.success).not.toHaveBeenCalledWith('Desfeito');
  });

  it('banco anterior (status_restaurado ausente): "Desfeito", como antes', async () => {
    await registrarEDesfazer({ deleted: true, statusRestaurado: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Desfeito'));
  });

  it('nada apagado ou erro do servidor: "Não foi possível desfazer" (sem rejeição solta)', async () => {
    await registrarEDesfazer({ deleted: false, statusRestaurado: false });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível desfazer'));
    vi.clearAllMocks();
    document.body.innerHTML = '';
    registrar.mockResolvedValue({ id: 'c1', deduped: false });
    await registrarEDesfazer(new Error('RD006'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível desfazer'));
  });
});
