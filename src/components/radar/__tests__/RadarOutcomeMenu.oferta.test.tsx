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
const { registrar, cadastrar, lerLead, track, toast } = vi.hoisted(() => ({
  registrar: vi.fn(),
  cadastrar: vi.fn(),
  lerLead: vi.fn(),
  track: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('@/queries/useRegistrarContatoRadar', () => ({
  useRegistrarContatoRadar: () => ({ mutateAsync: registrar, isPending: false }),
  useDesfazerContatoRadar: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/queries/useRadarAcoesLead', () => ({
  useRadarCadastrarOmie: () => ({ mutateAsync: cadastrar, isPending: false }),
  lerLeadParaCadastro: (...a: unknown[]) => lerLead(...a),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));
vi.mock('sonner', () => ({ toast }));

import { RadarOutcomeMenu } from '../RadarOutcomeMenu';
import { FalhaCadastro } from '@/lib/radar/cadastro-omie';

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
  // releitura antes do efeito: por default o lead está como no snapshot, já com o sinal gravado
  lerLead.mockImplementation(async () => ({ ...empresa, prospeccao_status: 'em_conversa' }));
  toast.success.mockReturnValue('toast-contato');
});

const eventosOferta = () => track.mock.calls.filter(([n]) => n === 'radar.cadastro_pos_sinal');

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
    expect(cadastrar.mock.calls[0][0]).toEqual({ empresa, opcoes: undefined });
    expect(lerLead, 'elegibilidade é do AGORA: relê antes do efeito').toHaveBeenCalledWith(empresa.cnpj);
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith('em_conversa'));
    // Codex ALTO 1: o clique e o onOpenChange(false) do Radix chegam juntos — a oferta é respondida UMA vez
    expect(eventosOferta()).toEqual([['radar.cadastro_pos_sinal', expect.objectContaining({ aceitou: true })]]);
    expect(onRegistrado).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/4242/), expect.anything());
    expect(track).toHaveBeenCalledWith('radar.cadastro_pos_sinal_resultado', expect.objectContaining({ resultado: 'sucesso' }));
    // Codex ALTO 6: "Desfazer" o contato não desfaz o Omie — o toast com Desfazer sai de cena
    expect(toast.dismiss).toHaveBeenCalledWith('toast-contato');
  });

  it('"Agora não": não cadastra, rastreia aceitou=false e só então avança a ficha', async () => {
    const onRegistrado = vi.fn();
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/em conversa/i);
    await screen.findByText(OFERTA);

    fireEvent.click(screen.getByRole('button', { name: /agora não/i }));
    expect(cadastrar).not.toHaveBeenCalled();
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith('em_conversa'));
    expect(eventosOferta()).toEqual([['radar.cadastro_pos_sinal', expect.objectContaining({ aceitou: false })]]);
    expect(onRegistrado).toHaveBeenCalledTimes(1);
    expect(toast.dismiss, 'recusou: o Desfazer do contato continua válido').not.toHaveBeenCalled();
  });

  it('resposta INDETERMINADA do Omie vira aviso com "Tentar de novo" que RELÊ o vínculo (retentativa)', async () => {
    cadastrar.mockRejectedValue(new Error('OMIE_RESPOSTA_INDETERMINADA: o Omie não devolveu o código do cliente'));
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} />);
    await abrirMenuEClicar(/em conversa/i);
    await screen.findByText(OFERTA);
    fireEvent.click(screen.getByRole('button', { name: /cadastrar agora/i }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/cód\./), expect.anything());
    expect(toast.error).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith('radar.cadastro_pos_sinal_resultado', expect.objectContaining({ resultado: 'indeterminado' }));
    const acao = (toast.warning.mock.calls[0][1] as { action: { label: string; onClick: () => void } }).action;
    expect(acao.label).toMatch(/tentar de novo/i);
    cadastrar.mockResolvedValue({ codigo: '4242', jaExistia: true, recuperado: true });
    acao.onClick();
    await waitFor(() => expect(cadastrar).toHaveBeenCalledTimes(2));
    expect(cadastrar.mock.calls[1][0]).toEqual({ empresa, opcoes: { retentativa: true } });
  });

  it('Omie confirmou mas o Radar não gravou: "Gravar de novo" repete SÓ a gravação (codigoConhecido)', async () => {
    cadastrar.mockRejectedValue(new FalhaCadastro('radar', 'RPC caiu', '9090'));
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} />);
    await abrirMenuEClicar(/em conversa/i);
    await screen.findByText(OFERTA);
    fireEvent.click(screen.getByRole('button', { name: /cadastrar agora/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0][0]).toMatch(/9090/);
    const acao = (toast.error.mock.calls[0][1] as { action: { label: string; onClick: () => void } }).action;
    cadastrar.mockResolvedValue({ codigo: '9090', jaExistia: true, recuperado: true });
    acao.onClick();
    await waitFor(() => expect(cadastrar).toHaveBeenCalledTimes(2));
    expect(cadastrar.mock.calls[1][0]).toEqual({ empresa, opcoes: { codigoConhecido: '9090' } });
  });

  it('"Gravar de novo" depois que o recruzamento marcou ja_cliente: a RETOMADA não é barrada pela releitura', async () => {
    cadastrar.mockRejectedValue(new FalhaCadastro('radar', 'RPC caiu', '9090'));
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} />);
    await abrirMenuEClicar(/em conversa/i);
    await screen.findByText(OFERTA);
    fireEvent.click(screen.getByRole('button', { name: /cadastrar agora/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    // entre a falha e a retomada, o lead passou a constar como cliente (sem vínculo ainda)
    lerLead.mockImplementation(async () => ({ ...empresa, prospeccao_status: 'em_conversa', ja_cliente: true }));
    cadastrar.mockResolvedValue({ codigo: '9090', jaExistia: true, recuperado: true });
    (toast.error.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick();
    await waitFor(() => expect(cadastrar).toHaveBeenCalledTimes(2));
    expect(cadastrar.mock.calls[1][0]).toEqual({ empresa, opcoes: { codigoConhecido: '9090' } });
    expect(toast.info, 'retomada barrada como "lead mudou"').not.toHaveBeenCalled();
    expect(lerLead, 'só o cadastro NOVO relê a elegibilidade').toHaveBeenCalledTimes(1);
  });

  it('a ficha trocou de lead durante o registro: nem oferta nem avanço (seriam sobre o lead errado)', async () => {
    let resolver: (v: unknown) => void = () => {};
    registrar.mockImplementation(() => new Promise((r) => { resolver = r; }));
    const onRegistrado = vi.fn();
    const outra = { ...empresa, cnpj: '99888777000166', razao_social: 'OUTRA LTDA' } as RadarEmpresa;
    const { rerender } = render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/em conversa/i);
    rerender(<RadarOutcomeMenu cnpj={outra.cnpj} empresa={outra} onRegistrado={onRegistrado} />);
    resolver({ id: 'c1', deduped: false });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1)); // o contato de A ficou gravado e o toast diz
    expect(screen.queryByText(OFERTA)).toBeNull();
    expect(onRegistrado, 'avançou a ficha de B por um contato de A').not.toHaveBeenCalled();
  });

  it('a ficha trocou de lead com a oferta aberta: "Agora não" não avança a ficha nova', async () => {
    const onRegistrado = vi.fn();
    const outra = { ...empresa, cnpj: '99888777000166', razao_social: 'OUTRA LTDA' } as RadarEmpresa;
    const { rerender } = render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/em conversa/i);
    await screen.findByText(OFERTA);
    rerender(<RadarOutcomeMenu cnpj={outra.cnpj} empresa={outra} onRegistrado={onRegistrado} />);
    fireEvent.click(screen.getByRole('button', { name: /agora não/i }));
    await waitFor(() => expect(eventosOferta()).toHaveLength(1));
    expect(onRegistrado).not.toHaveBeenCalled();
  });

  it('sensor: a oferta EXIBIDA emite exposição com id, e a resposta e o resultado levam o MESMO id', async () => {
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} />);
    await abrirMenuEClicar(/em conversa/i);
    await screen.findByText(OFERTA);
    const exib = track.mock.calls.filter(([n]) => n === 'radar.cadastro_pos_sinal_exibida');
    expect(exib, 'exposição não emitida — oferta abandonada some do denominador').toHaveLength(1);
    const id = (exib[0][1] as { oferta_id: string }).oferta_id;
    expect(id).toMatch(/\S+/);
    fireEvent.click(screen.getByRole('button', { name: /cadastrar agora/i }));
    await waitFor(() => expect(track).toHaveBeenCalledWith('radar.cadastro_pos_sinal_resultado', expect.objectContaining({ oferta_id: id })));
    expect(eventosOferta()[0][1]).toMatchObject({ aceitou: true, oferta_id: id });
  });

  it('o lead MUDOU entre o sinal e o clique (virou cliente em outra aba): não cadastra, avisa', async () => {
    lerLead.mockResolvedValue({ ...empresa, prospeccao_status: 'em_conversa', ja_cliente: true, omie_codigo_cliente: '7' });
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} />);
    await abrirMenuEClicar(/em conversa/i);
    await screen.findByText(OFERTA);
    fireEvent.click(screen.getByRole('button', { name: /cadastrar agora/i }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    expect(cadastrar).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith('radar.cadastro_pos_sinal_resultado', expect.objectContaining({ resultado: 'lead_mudou' }));
  });

  it('registro DEDUPLICADO (2 min): não reoferece — o 1º clique já ofereceu e o status pode ter mudado', async () => {
    registrar.mockResolvedValue({ id: 'c1', deduped: true });
    const onRegistrado = vi.fn();
    render(<RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} onRegistrado={onRegistrado} />);
    await abrirMenuEClicar(/em conversa/i);
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith('em_conversa'));
    expect(screen.queryByText(OFERTA)).toBeNull();
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
