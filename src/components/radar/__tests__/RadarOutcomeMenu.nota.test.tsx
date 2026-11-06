// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Pacote B4/B6: o registro leva a NOTA da ficha (quem atendeu, o que precisa, próximo passo) e "em conversa" NÃO
 * abre mais a janela automática de cadastro no Omie — quem decide o que vem depois é a ficha (`onRegistrado`).
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

class RO { observe() {} unobserve() {} disconnect() {} }

async function abrirMenu() {
  const trigger = screen.getByRole('button', { name: /registrar contato/i });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
}
async function abrirMenuEClicar(rotulo: RegExp) {
  await abrirMenu();
  fireEvent.click(await screen.findByText(rotulo));
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  registrar.mockResolvedValue({ id: 'c1', deduped: false });
});

describe('RadarOutcomeMenu — nota e sem oferta automática', () => {
  it('"em conversa" num lead cadastrável: registra com a nota, sem janela de cadastro, e avisa a ficha', async () => {
    const onRegistrado = vi.fn();
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} nota="  Falei com o João; quer amostra de verniz  " onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/em conversa/i);
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith('em_conversa'));
    expect(registrar).toHaveBeenCalledWith({ cnpj: lead.cnpj, acao: 'em_conversa', nota: 'Falei com o João; quer amostra de verniz' });
    expect(screen.queryByText(/Cadastrar no Omie \(Oben\) agora/)).toBeNull();
  });

  it('nota vazia (só espaço) não vira texto gravado', async () => {
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} nota="   " />);
    await abrirMenuEClicar(/não atendeu/i);
    await waitFor(() => expect(registrar).toHaveBeenCalled());
    expect(registrar.mock.calls[0][0]).toMatchObject({ acao: 'contatado_sem_resposta', nota: undefined });
  });

  it('descarte: o motivo do diálogo vence; sem motivo, a nota da ficha vale como motivo', async () => {
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} nota="fechou a loja" />);
    await abrirMenuEClicar(/^\s*Descartar\s*$/);
    fireEvent.click(await screen.findByRole('button', { name: 'Descartar' }));
    await waitFor(() => expect(registrar).toHaveBeenCalled());
    expect(registrar.mock.calls[0][0]).toMatchObject({ acao: 'descartado', nota: 'fechou a loja' });
  });
});
