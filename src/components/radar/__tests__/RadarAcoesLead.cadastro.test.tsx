import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Pacote A4: o "Cadastrar no Omie" da ficha abria a confirmação com o lead já no Omie, não conferia
 * `cadastravelNoOmie` (lead BAIXADO na RFB ia direto à edge) e tratava todo erro como genérico — perdendo a
 * recuperação "Omie confirmou, a gravação no Radar falhou" que o menu de contato já oferecia.
 */
const toastMock = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
// Pacote L: a confirmação lê a contabilidade do lead (escolha do telefone); aqui sem leitura — fora do assunto.
vi.mock('@/queries/useRadarContatoContabil', () => ({ useRadarContatoContabil: () => ({ data: undefined, isError: false }) }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
const mutateAsync = vi.fn();
const lerLead = vi.fn();
vi.mock('@/queries/useRadarAcoesLead', () => ({
  useRadarCadastrarOmie: () => ({ mutateAsync }),
  lerLeadParaCadastro: (...a: unknown[]) => lerLead(...a),
}));

import { RadarAcoesLead } from '../RadarAcoesLead';
import { FalhaCadastro } from '@/lib/radar/cadastro-omie';

const CNPJ = '11222333000181';
function lead(extra: Partial<RadarEmpresa> = {}): RadarEmpresa {
  return { cnpj: CNPJ, razao_social: 'Alfa Tintas', ja_cliente: false, omie_codigo_cliente: null, rfb_situacao: '02', prospeccao_status: 'em_conversa', ...extra } as unknown as RadarEmpresa;
}

async function confirmar() {
  fireEvent.click(screen.getByRole('button', { name: /Cadastrar no Omie/ }));
  fireEvent.click(await screen.findByText('Cadastrar na Oben'));
}

beforeEach(() => vi.clearAllMocks());

describe('RadarAcoesLead — cadastro no Omie pela ficha', () => {
  it('lead já no Omie: só informa o código, sem botão de cadastro', () => {
    render(<RadarAcoesLead empresa={lead({ omie_codigo_cliente: '987' })} />);
    expect(screen.getByTestId('radar-ficha-no-omie').textContent).toContain('987');
    expect(screen.queryByRole('button', { name: /Cadastrar no Omie/ })).toBeNull();
  });

  it('lead baixado na RFB (08): botão desabilitado com o motivo escrito, nada chega à edge', () => {
    render(<RadarAcoesLead empresa={lead({ rfb_situacao: '08' })} />);
    const botao = screen.getByRole('button', { name: /Cadastrar no Omie/ }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    expect(screen.getByTestId('radar-ficha-nao-cadastravel').textContent).toMatch(/Receita/);
    fireEvent.click(botao);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('lead mudou desde a lista (virou cliente): relê e NÃO cadastra', async () => {
    lerLead.mockResolvedValue(lead({ ja_cliente: true }));
    render(<RadarAcoesLead empresa={lead()} />);
    await confirmar();
    await waitFor(() => expect(toastMock.info).toHaveBeenCalledWith('Não cadastrei: o lead mudou', expect.anything()));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('Omie confirmou e o Radar não gravou: oferece "Gravar de novo" com o código conhecido', async () => {
    lerLead.mockResolvedValue(lead());
    mutateAsync.mockRejectedValueOnce(new FalhaCadastro('radar', 'rpc caiu', '555'));
    render(<RadarAcoesLead empresa={lead()} />);
    await confirmar();
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    const [titulo, opcoes] = toastMock.error.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(titulo).toMatch(/cód\. 555/);
    expect(opcoes.action.label).toBe('Gravar de novo');

    mutateAsync.mockResolvedValueOnce({ codigo: '555', jaExistia: true, recuperado: true });
    opcoes.action.onClick();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync.mock.calls[1][0]).toMatchObject({ opcoes: { codigoConhecido: '555' } });
    // A retomada não relê a elegibilidade (barraria a recuperação de quem o recruzamento já marcou cliente).
    expect(lerLead).toHaveBeenCalledTimes(1);
  });

  it('retry de toast antigo durante uma nova confirmação NÃO abre 2º cadastro concorrente (Codex P2)', async () => {
    lerLead.mockResolvedValueOnce(lead());
    mutateAsync.mockRejectedValueOnce(new Error('OMIE_RESPOSTA_INDETERMINADA: sem código'));
    render(<RadarAcoesLead empresa={lead()} />);
    await confirmar();
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled());
    const retry = (toastMock.warning.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick;

    // Nova confirmação pela ficha com a releitura PRESA; no meio dela, o retry do toast antigo.
    let soltarLeitura!: (v: RadarEmpresa) => void;
    lerLead.mockImplementationOnce(() => new Promise<RadarEmpresa>((r) => { soltarLeitura = r; }));
    let soltarCadastro!: (v: unknown) => void;
    mutateAsync.mockImplementationOnce(() => new Promise((r) => { soltarCadastro = r; }));
    await confirmar();
    await waitFor(() => expect(lerLead).toHaveBeenCalledTimes(2));
    retry();
    expect(toastMock.info).toHaveBeenCalledWith('Cadastro deste lead já em andamento', expect.anything());

    soltarLeitura(lead());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    // O botão segue ocupado até a tentativa em voo terminar (a trava é a fonte do "cadastrando").
    expect((screen.getByRole('button', { name: /Cadastrar no Omie/ }) as HTMLButtonElement).disabled).toBe(true);
    soltarCadastro({ codigo: '555', jaExistia: false, recuperado: false });
    await waitFor(() => expect((screen.getByRole('button', { name: /Cadastrar no Omie/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(mutateAsync).toHaveBeenCalledTimes(2);
  });

  it('B6: lead cadastrável ainda sem conversa — a ficha diz o caminho, sem botão; com a conversa salva, o botão aparece', () => {
    const v = render(<RadarAcoesLead empresa={lead({ prospeccao_status: 'a_contatar' })} />);
    expect(screen.getByTestId('radar-ficha-cadastro-depois')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cadastrar no Omie/ })).toBeNull();
    v.unmount();
    render(<RadarAcoesLead empresa={lead({ prospeccao_status: 'a_contatar' })} conversaSalva />);
    expect((screen.getByRole('button', { name: /Cadastrar no Omie/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('conversa salva e depois desfeita: a releitura exige "em conversa" e não cadastra (Codex P2)', async () => {
    lerLead.mockResolvedValueOnce(lead({ prospeccao_status: 'a_contatar' }));
    render(<RadarAcoesLead empresa={lead({ prospeccao_status: 'a_contatar' })} conversaSalva />);
    await confirmar();
    await waitFor(() => expect(toastMock.info).toHaveBeenCalledWith('Não cadastrei: o lead mudou', expect.objectContaining({
      description: expect.stringMatching(/não está mais em conversa/),
    })));
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
