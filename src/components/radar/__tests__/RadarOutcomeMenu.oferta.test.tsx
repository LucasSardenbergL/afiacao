// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Gatilho pós-sinal (bloco 5): marcar `em_conversa` OFERECE "Cadastrar no Omie (Oben) agora" —
 * um clique, nunca cadastro silencioso. A oferta só aparece quando o lead é cadastrável (não
 * cliente, sem vínculo, RFB ativa, CNPJ numérico) e só nessa ação; o menu da rota (sem `empresa`)
 * não oferece. O que se prova aqui é a DECISÃO do menu e o rastro (`track` com `aceitou`), com os
 * hooks de I/O substituídos — a validação da resposta do Omie tem suíte própria (cadastro-omie).
 */
const { registrar, cadastrar, track, toast } = vi.hoisted(() => ({
  registrar: vi.fn(),
  cadastrar: vi.fn(),
  track: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/queries/useRegistrarContatoRadar', () => ({
  useRegistrarContatoRadar: () => ({ mutateAsync: registrar, isPending: false }),
  useDesfazerContatoRadar: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/queries/useRadarAcoesLead', () => ({
  useRadarCadastrarOmie: () => ({ mutateAsync: cadastrar, isPending: false }),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));
vi.mock('sonner', () => ({ toast }));

import { RadarOutcomeMenu } from '../RadarOutcomeMenu';

const empresa = {
  cnpj: '12345678000195',
  razao_social: 'MOVEIS TESTE LTDA',
  ja_cliente: false,
  omie_codigo_cliente: null,
  prospeccao_status: 'a_contatar',
  ultimo_lote: '2026-08',
  rfb_situacao: '02',
  score: 75,
} as unknown as RadarEmpresa;

/** Radix Popper mede o conteúdo com ResizeObserver, que o jsdom não tem. */
class RO { observe() {} unobserve() {} disconnect() {} }

async function abrirMenuEClicar(rotulo: RegExp) {
  // Teclado, não pointerDown: o jsdom não tem PointerEvent e o `button` chega undefined ao Radix.
  const trigger = screen.getByRole('button', { name: /registrar contato/i });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const item = await screen.findByText(rotulo);
  fireEvent.click(item);
}

const OFERTA = /cadastrar no omie \(oben\) agora/i;

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  registrar.mockResolvedValue({ id: 'c1', deduped: false });
  cadastrar.mockResolvedValue({ codigo: '4242', jaExistia: false, recuperado: false });
});

describe('RadarOutcomeMenu — oferta de cadastro pós-sinal', () => {
  it('em_conversa num lead cadastrável: oferece; "Cadastrar agora" dispara o fluxo com ESTE lead e rastreia aceitou=true', async () => {
    const onRegistrado = vi.fn();
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/em conversa/i);

    await screen.findByText(OFERTA);
    expect(registrar).toHaveBeenCalledWith({ cnpj: empresa.cnpj, acao: 'em_conversa', nota: undefined });
    // nada cadastrado antes do clique — e a ficha ainda não avançou
    expect(cadastrar).not.toHaveBeenCalled();
    expect(onRegistrado).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /cadastrar agora/i }));
    await waitFor(() => expect(cadastrar).toHaveBeenCalledTimes(1));
    expect(cadastrar.mock.calls[0][0]).toEqual({ empresa });
    expect(track).toHaveBeenCalledWith('radar.cadastro_pos_sinal', expect.objectContaining({ aceitou: true }));
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith('em_conversa'));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/4242/), expect.anything());
  });

  it('"Agora não": não cadastra, rastreia aceitou=false e só então avança a ficha', async () => {
    const onRegistrado = vi.fn();
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/em conversa/i);
    await screen.findByText(OFERTA);

    fireEvent.click(screen.getByRole('button', { name: /agora não/i }));
    expect(cadastrar).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith('radar.cadastro_pos_sinal', expect.objectContaining({ aceitou: false }));
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith('em_conversa'));
  });

  it('resposta INDETERMINADA do Omie vira aviso (não sucesso, não erro genérico)', async () => {
    cadastrar.mockRejectedValue(new Error('OMIE_RESPOSTA_INDETERMINADA: o Omie não devolveu o código do cliente'));
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} />);
    await abrirMenuEClicar(/em conversa/i);
    await screen.findByText(OFERTA);
    fireEvent.click(screen.getByRole('button', { name: /cadastrar agora/i }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('já cliente: marca em_conversa sem oferecer e avança direto', async () => {
    const onRegistrado = vi.fn();
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={{ ...empresa, ja_cliente: true }} onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/em conversa/i);
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith('em_conversa'));
    expect(screen.queryByText(OFERTA)).toBeNull();
    expect(track).not.toHaveBeenCalledWith('radar.cadastro_pos_sinal', expect.anything());
  });

  it('baixado pela RFB: sem oferta', async () => {
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={{ ...empresa, rfb_situacao: '08' }} />);
    await abrirMenuEClicar(/em conversa/i);
    await waitFor(() => expect(registrar).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(OFERTA)).toBeNull();
  });

  it('outra ação (não atendeu) num lead cadastrável: sem oferta — o sinal é em_conversa', async () => {
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} />);
    await abrirMenuEClicar(/não atendeu/i);
    await waitFor(() => expect(registrar).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(OFERTA)).toBeNull();
  });

  it('sem `empresa` (menu da rota): sem oferta', async () => {
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} />);
    await abrirMenuEClicar(/em conversa/i);
    await waitFor(() => expect(registrar).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(OFERTA)).toBeNull();
  });

  it('registro falhou: não oferece cadastro de um sinal que não foi gravado', async () => {
    registrar.mockRejectedValue(new Error('forbidden'));
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} />);
    await abrirMenuEClicar(/em conversa/i);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByText(OFERTA)).toBeNull();
  });
});
