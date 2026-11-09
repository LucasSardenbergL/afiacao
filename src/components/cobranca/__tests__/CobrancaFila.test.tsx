import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CobrancaFila } from '../CobrancaFila';
import type { FilaItem } from '@/lib/cobranca/cobranca-helpers';

const filaMock = vi.fn();
const mutateAsync = vi.fn();
vi.mock('@/hooks/useCobranca', () => ({
  useCobrancaFila: () => filaMock(),
  useCobrancaRegistrar: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
let lente = false;
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => lente }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const item = (o: Partial<FilaItem> = {}): FilaItem => ({
  company: 'oben', omieCodigoCliente: 10, nomeCliente: 'CLI DEZ', saldoVencido: 300, nVencidas: 2, diasVencidoMax: 60, faixa: '46-90d',
  donaUserId: 'u1', donaNome: 'Regina', casoId: null, estado: 'a_contatar', proximoContatoEm: null, notaAtual: null, atualizadoEm: null,
  promessaId: null, promessaData: null, promessaValor: null, promessaSituacao: null, saldoInicialCoorte: 500, nTitulosCoorte: 3,
  saldoAtualCoorte: 300, coorteCorteEm: '2026-10-31', ultimoContatoEm: null, nContatos: 0, podeAgir: true, podeQuitar: false, ...o,
});
const ok = (data: FilaItem[]) => ({ data, isLoading: false, error: null, refetch: vi.fn() });

describe('CobrancaFila', () => {
  beforeEach(() => { filaMock.mockReset(); mutateAsync.mockReset(); mutateAsync.mockResolvedValue({}); lente = false; });

  it('agrupa por faixa (recentes primeiro), mostra saldo, dias, dona e coorte como variação', () => {
    filaMock.mockReturnValue(ok([item({ omieCodigoCliente: 30, faixa: '>90d', saldoVencido: 800, diasVencidoMax: 120, donaNome: 'Tatyana' }), item()]));
    render(<CobrancaFila company="oben" />);
    const titulos = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '');
    expect(titulos[0]).toMatch(/46 a 90 dias/);
    expect(titulos[1]).toMatch(/Mais de 90 dias/);
    expect(screen.getByTestId('cobranca-linha-10')).toHaveTextContent('R$ 300,00');
    expect(screen.getByTestId('cobranca-linha-10')).toHaveTextContent('Regina');
    expect(screen.getByTestId('cobranca-linha-10')).toHaveTextContent('R$ 500,00 → R$ 300,00');
  });

  it('erro de leitura mostra erro, não fila vazia; vazio mostra estado vazio honesto', () => {
    filaMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom'), refetch: vi.fn() });
    render(<CobrancaFila company="oben" />);
    expect(screen.getByTestId('cobranca-fila-erro')).toBeInTheDocument();
    filaMock.mockReturnValue(ok([]));
    render(<CobrancaFila company="oben" />);
    expect(screen.getByTestId('cobranca-fila-vazia')).toBeInTheDocument();
  });

  it('registrar contato chama o writer único com acao=contato e canal; não troca estado na tela', async () => {
    filaMock.mockReturnValue(ok([item()]));
    render(<CobrancaFila company="oben" />);
    fireEvent.click(screen.getByRole('button', { name: 'Contato' }));
    fireEvent.click(screen.getByRole('button', { name: /Registrar contato/ }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ acao: 'contato', canal: 'telefone', omieCodigoCliente: 10, company: 'oben' })));
  });

  it('promessa exige data e valor; valor em pt-BR vira número', async () => {
    filaMock.mockReturnValue(ok([item()]));
    render(<CobrancaFila company="oben" />);
    fireEvent.click(screen.getByRole('button', { name: 'Promessa' }));
    const btn = screen.getByRole('button', { name: /Registrar promessa/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Data prometida'), { target: { value: '2026-11-10' } });
    fireEvent.change(screen.getByLabelText('Valor prometido'), { target: { value: '1.250,50' } });
    fireEvent.click(btn);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ acao: 'promessa', promessaData: '2026-11-10', promessaValor: 1250.5 })));
  });

  it('"Fechar (quitado)" só com EVIDÊNCIA do servidor (pode_quitar) e caso aberto — saldo null NÃO basta', () => {
    filaMock.mockReturnValue(ok([
      item({ casoId: 'c1', saldoVencido: null, faixa: null, podeQuitar: false }),
      item({ omieCodigoCliente: 11, casoId: 'c2', saldoVencido: null, faixa: null, podeQuitar: true }),
      item({ omieCodigoCliente: 12, casoId: null, podeQuitar: true }),
    ]));
    render(<CobrancaFila company="oben" />);
    expect(screen.getAllByRole('button', { name: /Fechar \(quitado\)/ })).toHaveLength(1);
    expect(screen.getByTestId('cobranca-linha-11').querySelector('button[class*="h-7"]')).toBeTruthy();
  });

  it('valor da promessa com ponto decimal não é multiplicado por 100 (1250.50 → 1250.5); agrupamento inválido é recusado', async () => {
    filaMock.mockReturnValue(ok([item()]));
    render(<CobrancaFila company="oben" />);
    fireEvent.click(screen.getByRole('button', { name: 'Promessa' }));
    fireEvent.change(screen.getByLabelText('Data prometida'), { target: { value: '2026-11-10' } });
    fireEvent.change(screen.getByLabelText('Valor prometido'), { target: { value: '1250.50' } });
    fireEvent.click(screen.getByRole('button', { name: /Registrar promessa/ }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ promessaValor: 1250.5 })));
    mutateAsync.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Promessa' }));
    fireEvent.change(screen.getByLabelText('Data prometida'), { target: { value: '2026-11-10' } });
    fireEvent.change(screen.getByLabelText('Valor prometido'), { target: { value: '1.2.3' } });
    fireEvent.click(screen.getByRole('button', { name: /Registrar promessa/ }));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('coorte: atual desconhecido mostra "?" e nunca R$ 0,00; cancelado pela gestão aparece como tal', () => {
    filaMock.mockReturnValue(ok([item({ saldoAtualCoorte: null }), item({ omieCodigoCliente: 20, estado: 'cancelado_gestao', casoId: null })]));
    render(<CobrancaFila company="oben" />);
    expect(screen.getByTestId('cobranca-linha-10')).toHaveTextContent('R$ 500,00 → ?');
    expect(screen.getByTestId('cobranca-linha-10')).not.toHaveTextContent('R$ 0,00');
    expect(screen.getByTestId('cobranca-linha-20')).toHaveTextContent('Cancelado (gestão)');
  });

  it('sem pode_agir (não é a dona) ou sob a lente, as ações ficam desabilitadas', () => {
    filaMock.mockReturnValue(ok([item({ podeAgir: false })]));
    render(<CobrancaFila company="oben" />);
    expect((screen.getByRole('button', { name: 'Contato' }) as HTMLButtonElement).disabled).toBe(true);
    lente = true;
    filaMock.mockReturnValue(ok([item()]));
    render(<CobrancaFila company="oben" />);
    expect((screen.getAllByRole('button', { name: 'Contato' }).at(-1) as HTMLButtonElement).disabled).toBe(true);
  });

  it('promessa vencida aparece com a situação; saldo ausente mostra "—" e não R$ 0', () => {
    filaMock.mockReturnValue(ok([item({ promessaData: '2026-10-20', promessaValor: 100, promessaSituacao: 'vencida', saldoVencido: null, saldoAtualCoorte: 300 })]));
    render(<CobrancaFila company="oben" />);
    expect(screen.getByTestId('cobranca-linha-10')).toHaveTextContent('vencida');
    expect(screen.getByTestId('cobranca-linha-10')).not.toHaveTextContent('R$ 0,00');
  });
});
