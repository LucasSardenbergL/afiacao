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
import { hojeBRT, retornoPadrao, somarDias } from '@/lib/radar/retorno';

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
  it('"em conversa": pede a data de retorno (sugestão marcada), registra com nota e data, sem janela de cadastro (G1)', async () => {
    const onRegistrado = vi.fn();
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} nota="  Falei com o João; quer amostra de verniz  " onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/em conversa/i);
    expect(registrar).not.toHaveBeenCalled();
    expect(await screen.findByText('Quando retomar a conversa?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Em 1 semana/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Marcar em conversa' }));
    const padrao = retornoPadrao(hojeBRT());
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith('em_conversa',
      { deduped: false, notaGravada: true, notaEnviada: 'Falei com o João; quer amostra de verniz' }));
    expect(registrar).toHaveBeenCalledWith({ cnpj: lead.cnpj, acao: 'em_conversa', nota: 'Falei com o João; quer amostra de verniz', retorno: padrao });
    expect(track).toHaveBeenCalledWith('radar.retorno_definido', { dias: expect.any(Number), sugestao_aceita: true });
    expect(screen.queryByText(/Cadastrar no Omie \(Oben\) agora/)).toBeNull();
  });

  it('"em conversa": o chip escolhido vai como data; data fora da faixa desabilita o confirmar', async () => {
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} nota="" />);
    await abrirMenuEClicar(/em conversa/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Hoje/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Marcar em conversa' }));
    await waitFor(() => expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ acao: 'em_conversa', retorno: hojeBRT() })));
    expect(track).toHaveBeenCalledWith('radar.retorno_definido', { dias: 0, sugestao_aceita: false });
    await abrirMenuEClicar(/em conversa/i);
    fireEvent.change(await screen.findByLabelText('Data de retorno'), { target: { value: somarDias(hojeBRT(), 61) } });
    expect(screen.getByTestId('radar-retorno-invalido')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Marcar em conversa' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('o toast diz quando o lead volta (data que o servidor devolveu)', async () => {
    registrar.mockResolvedValueOnce({ id: 'c1', deduped: false, notaGravada: true, retornoEm: '2026-11-12' });
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} nota="" />);
    await abrirMenuEClicar(/não atendeu/i);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Marcado: não atendeu · volta para você em 12/11', expect.anything()));
  });

  it('data recusada pelo servidor (RD008): avisa, nada é gravado e a ficha não avança', async () => {
    registrar.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'RD008' }));
    const onRegistrado = vi.fn();
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} nota="n" onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/em conversa/i);
    fireEvent.click(await screen.findByRole('button', { name: 'Marcar em conversa' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Data de retorno fora do prazo', expect.anything()));
    expect(onRegistrado).not.toHaveBeenCalled();
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

  it('banco anterior: dedupe com nota = nota NÃO gravada — avisa e diz à ficha para não apagar nem avançar (Codex P2, G4)', async () => {
    registrar.mockResolvedValueOnce({ id: 'c0', deduped: true, notaGravada: null, retornoEm: null });
    const onRegistrado = vi.fn();
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} nota="quer orçamento" onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/não atendeu/i);
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith('contatado_sem_resposta',
      { deduped: true, notaGravada: false, notaEnviada: 'quer orçamento' }));
    expect(toast.warning).toHaveBeenCalledWith('A nota não foi gravada', expect.anything());
  });

  it('pacote G: dedupe do MESMO conteúdo (nota_gravada) não avisa perda — a nota já está gravada', async () => {
    registrar.mockResolvedValueOnce({ id: 'c0', deduped: true, notaGravada: true, retornoEm: null });
    const onRegistrado = vi.fn();
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} nota="quer orçamento" onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/não atendeu/i);
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith('contatado_sem_resposta',
      { deduped: true, notaGravada: true, notaEnviada: 'quer orçamento' }));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
