// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { onlineManager } from '@tanstack/react-query';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Revisão 2026-11-11, itens 2 e 21. Desfecho que FALHA: o diálogo segura até o servidor responder, a falha aparece
 * nele com a mensagem do servidor e "Tentar de novo", o motivo digitado não some, e sem rede nada é enviado (texto
 * próprio). "Quando retomar?" usa o dia da PÁGINA e "Amanhã" numa sexta vai para a segunda.
 */
const { registrar, desfazer, toast } = vi.hoisted(() => ({
  registrar: vi.fn(),
  desfazer: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/queries/useRegistrarContatoRadar', () => ({
  useRegistrarContatoRadar: () => ({ mutateAsync: registrar, isPending: false }),
  useDesfazerContatoRadar: () => ({ mutateAsync: desfazer }),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { RadarOutcomeMenu, TEXTO_SEM_REDE } from '../RadarOutcomeMenu';

const lead = { cnpj: '12345678000195', prospeccao_status: 'a_contatar', omie_codigo_cliente: null } as unknown as RadarEmpresa;
class RO { observe() {} unobserve() {} disconnect() {} }

async function escolher(rotulo: RegExp) {
  fireEvent.keyDown(screen.getByRole('button', { name: /registrar contato/i }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByText(rotulo));
}
const erroPostgrest = { message: 'permission denied for function registrar_contato_radar', code: '42501' };

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  onlineManager.setOnline(true);
});
afterEach(() => onlineManager.setOnline(true));

describe('RadarOutcomeMenu — descarte que falha', () => {
  it('o diálogo NÃO fecha, mostra a mensagem do servidor e "Tentar de novo"; o motivo fica', async () => {
    registrar.mockRejectedValueOnce(erroPostgrest);
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} />);
    await escolher(/^descartar$/i);
    fireEvent.change(await screen.findByPlaceholderText(/motivo/i), { target: { value: 'fechou a fábrica' } });
    fireEvent.click(screen.getByRole('button', { name: /^descartar$/i }));

    const falha = await screen.findByTestId('radar-desfecho-falha');
    expect(falha.textContent).toContain('permission denied for function registrar_contato_radar');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect((screen.getByPlaceholderText(/motivo/i) as HTMLTextAreaElement).value).toBe('fechou a fábrica');
    expect(toast.error).not.toHaveBeenCalled();

    registrar.mockResolvedValueOnce({ id: 'c9', deduped: false });
    fireEvent.click(screen.getByRole('button', { name: /tentar de novo/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(registrar).toHaveBeenLastCalledWith(expect.objectContaining({ acao: 'descartado', nota: 'fechou a fábrica' }));
  });

  it('fechar depois da falha e reabrir: o motivo digitado volta', async () => {
    registrar.mockRejectedValueOnce(erroPostgrest);
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} />);
    await escolher(/^descartar$/i);
    fireEvent.change(await screen.findByPlaceholderText(/motivo/i), { target: { value: 'sem perfil' } });
    fireEvent.click(screen.getByRole('button', { name: /^descartar$/i }));
    await screen.findByTestId('radar-desfecho-falha');
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await escolher(/^descartar$/i);
    expect(((await screen.findByPlaceholderText(/motivo/i)) as HTMLTextAreaElement).value).toBe('sem perfil');
    expect(screen.queryByTestId('radar-desfecho-falha')).toBeNull();
  });

  it('sem rede: nada é enviado e o diálogo diz isso', async () => {
    onlineManager.setOnline(false);
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} />);
    await escolher(/^descartar$/i);
    fireEvent.click(await screen.findByRole('button', { name: /^descartar$/i }));
    expect((await screen.findByTestId('radar-desfecho-falha')).textContent).toBe(TEXTO_SEM_REDE);
    expect(registrar).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('"não atendeu" (sem diálogo) que falha: toast com a mensagem e "Tentar de novo" que reenvia', async () => {
    registrar.mockRejectedValueOnce(erroPostgrest);
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} />);
    await escolher(/não atendeu/i);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [titulo, opcoes] = toast.error.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }];
    expect(titulo).toBe('Não foi possível registrar');
    expect(opcoes.description).toContain('permission denied');
    expect(opcoes.action.label).toBe('Tentar de novo');
    registrar.mockResolvedValueOnce({ id: 'c2', deduped: false });
    opcoes.action.onClick();
    await waitFor(() => expect(registrar).toHaveBeenCalledTimes(2));
  });
});

describe('RadarOutcomeMenu — "Quando retomar?" (item 21)', () => {
  it('usa o dia da PÁGINA: numa sexta, "Amanhã" vira "Próximo dia útil" e cai na segunda', async () => {
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} hojeISO="2026-11-13" />);
    await escolher(/em conversa/i);
    const chip = await screen.findByRole('button', { name: /próximo dia útil/i });
    expect(chip.textContent).toContain('16/11');
    expect(screen.queryByRole('button', { name: /^amanhã/i })).toBeNull();
    expect((screen.getByLabelText('Data de retorno') as HTMLInputElement).min).toBe('2026-11-13');
  });

  it('falha ao marcar "em conversa": o diálogo da data fica aberto com a falha', async () => {
    registrar.mockRejectedValueOnce(erroPostgrest);
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} hojeISO="2026-11-10" />);
    await escolher(/em conversa/i);
    fireEvent.click(await screen.findByRole('button', { name: /marcar em conversa/i }));
    await screen.findByTestId('radar-desfecho-falha');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: /tentar de novo/i })).toBeTruthy();
  });
});

describe('RadarOutcomeMenu — variante "botoes" do modo discagem (revisão 2026-11-11, item 11)', () => {
  it('desfechos como botões diretos: "Não atendeu" registra num toque; "Em conversa" abre a data; "Descartar" o motivo', async () => {
    registrar.mockResolvedValue({ id: 'c3', deduped: false });
    render(<RadarOutcomeMenu cnpj={lead.cnpj} empresa={lead} variante="botoes" hojeISO="2026-11-10" />);
    expect(screen.queryByRole('button', { name: /registrar contato/i })).toBeNull();
    const grupo = screen.getByRole('group', { name: 'Desfecho da ligação' });
    fireEvent.click(within(grupo).getByRole('button', { name: /não atendeu/i }));
    await waitFor(() => expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ acao: 'contatado_sem_resposta' })));
    fireEvent.click(within(grupo).getByRole('button', { name: /em conversa/i }));
    expect(await screen.findByText('Quando retomar a conversa?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(within(grupo).getByRole('button', { name: /descartar/i }));
    expect(await screen.findByPlaceholderText(/motivo/i)).toBeTruthy();
  });
});
