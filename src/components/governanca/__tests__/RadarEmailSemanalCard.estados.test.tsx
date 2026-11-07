import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Radar D1 — card de ligar o e-mail semanal (Governança → Usuários). O HOOK roda de verdade; só o supabase é mockado
 * (por nome de RPC). Prova: só master vê; erro de leitura ≠ lista vazia; "Ligado" (e-mail real) e ligar o envio
 * automático só disparam DEPOIS de confirmar; "Teste" e desligar vão direto; cron ausente ≠ desligado; lente = só leitura.
 * O Select do Radix vira <select> nativo aqui (jsdom não abre o portal); a ordem dos combobox é a das linhas.
 */

type Resposta = { data: unknown; error: { message: string } | null };
const respostas: Record<string, Resposta> = {};
const rpc = vi.fn((nome: string, _args?: unknown) =>
  Promise.resolve(respostas[nome] ?? { data: null, error: { message: `sem mock: ${nome}` } }),
);
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (n: string, a?: unknown) => rpc(n, a) } }));

let auth = { isMaster: true };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
let lente = { isImpersonating: false };
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => lente }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/ui/select', () => ({
  Select: (p: { value: string; disabled?: boolean; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select value={p.value} disabled={p.disabled} onChange={(e) => p.onValueChange(e.target.value)}>
      {p.children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: (p: { children: ReactNode }) => <>{p.children}</>,
  SelectItem: (p: { value: string; children: ReactNode }) => <option value={p.value}>{p.children}</option>,
}));

import { RadarEmailSemanalCard } from '../RadarEmailSemanalCard';

const REGINA = {
  user_id: 'u-regina', nome: 'Regina', email: 'regina@exemplo.com', papel: 'employee', papel_comercial: 'farmer',
  acesso_radar: true, modo: 'teste', email_teste: 'founder@exemplo.com', atualizado_em: '2026-11-07T03:00:00Z',
  territorio: [
    { municipio: 'DIVINÓPOLIS', uf: 'MG', clientes: 358 },
    { municipio: 'NOVA SERRANA', uf: 'MG', clientes: 266 },
    { municipio: 'CLÁUDIO', uf: 'MG', clientes: 187 },
  ],
  ultimo_envio: { semana: '2026-11-02', eh_teste: true, n_leads: 5, elegiveis: 972, destinatario: 'founder@exemplo.com', status: 'notificado' },
};
const TATY = {
  ...REGINA, user_id: 'u-taty', nome: 'Tatyana', email: 'taty@exemplo.com', modo: 'desligado', email_teste: null,
  territorio: [{ municipio: 'ITAÚNA', uf: 'MG', clientes: 148 }], ultimo_envio: null,
};
const SEM_ACESSO = { ...TATY, user_id: 'u-x', nome: 'Ex-vendedor', acesso_radar: false, modo: 'ligado', territorio: [] };

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><RadarEmailSemanalCard /></QueryClientProvider>);
}
const chamadas = (nome: string) => rpc.mock.calls.filter((c) => c[0] === nome);

beforeEach(() => {
  rpc.mockClear();
  for (const k of Object.keys(respostas)) delete respostas[k];
  auth = { isMaster: true };
  lente = { isImpersonating: false };
  respostas.radar_email_semanal_painel = {
    data: { cron: { ativo: false, agenda: '0 11 * * 1' }, usuarios: [REGINA, TATY] }, error: null,
  };
  respostas.radar_email_semanal_definir = { data: { ok: true }, error: null };
  respostas.radar_email_semanal_cron = { data: { ok: true, ativo: true }, error: null };
});

describe('RadarEmailSemanalCard', () => {
  it('não-master: o card nem aparece e a RPC não é chamada', () => {
    auth = { isMaster: false };
    const { container } = renderCard();
    expect(container.innerHTML).toBe('');
    expect(chamadas('radar_email_semanal_painel')).toHaveLength(0);
  });

  it('mostra cada pessoa com os municípios, o último envio e o modo atual', async () => {
    renderCard();
    expect(await screen.findByText('Regina')).toBeTruthy();
    expect(screen.getByText('DIVINÓPOLIS, NOVA SERRANA e CLÁUDIO')).toBeTruthy();
    expect(screen.getByText('semana de 02/11 · 5 de 972 · teste · enviado')).toBeTruthy();
    expect(screen.getByText('Nenhum envio ainda')).toBeTruthy();
    const [regina, taty] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(regina.value).toBe('teste');
    expect(taty.value).toBe('desligado');
    expect(screen.getByText(/Desligado: ninguém recebe/)).toBeTruthy();
  });

  it('erro de leitura vira aviso com "tentar de novo" — nunca lista vazia', async () => {
    respostas.radar_email_semanal_painel = { data: null, error: { message: 'forbidden: so master' } };
    renderCard();
    expect(await screen.findByText(/Não consegui ler o painel: forbidden: so master/)).toBeTruthy();
    expect(screen.queryByText('Ninguém da equipe encontrado')).toBeNull();
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('"Ligado" (e-mail real) só grava depois de confirmar; cancelar não grava nada', async () => {
    renderCard();
    await screen.findByText('Tatyana');
    const taty = screen.getAllByRole('combobox')[1];
    fireEvent.change(taty, { target: { value: 'ligado' } });
    expect(await screen.findByText('Ligar o e-mail para Tatyana?')).toBeTruthy();
    expect(chamadas('radar_email_semanal_definir')).toHaveLength(0);
    fireEvent.click(screen.getByText('Cancelar'));
    expect(chamadas('radar_email_semanal_definir')).toHaveLength(0);

    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'ligado' } });
    fireEvent.click(await screen.findByText('Ligar'));
    await waitFor(() => expect(chamadas('radar_email_semanal_definir')).toHaveLength(1));
    expect(chamadas('radar_email_semanal_definir')[0][1]).toEqual({ p_usuario: 'u-taty', p_modo: 'ligado' });
  });

  it('"Teste" e "Desligado" gravam direto (não mandam e-mail para a pessoa)', async () => {
    renderCard();
    await screen.findByText('Regina');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'desligado' } });
    await waitFor(() => expect(chamadas('radar_email_semanal_definir')).toHaveLength(1));
    expect(chamadas('radar_email_semanal_definir')[0][1]).toEqual({ p_usuario: 'u-regina', p_modo: 'desligado' });
  });

  it('ligar o envio automático pede confirmação com a contagem', async () => {
    renderCard();
    await screen.findByText('Regina');
    fireEvent.click(screen.getByRole('switch', { name: 'Envio automático toda segunda' }));
    expect(await screen.findByText(/sai o e-mail para 0 pessoa\(s\) ligada\(s\) e 1 em teste/)).toBeTruthy();
    expect(chamadas('radar_email_semanal_cron')).toHaveLength(0);
    fireEvent.click(screen.getByText('Ligar'));
    await waitFor(() => expect(chamadas('radar_email_semanal_cron')).toHaveLength(1));
    expect(chamadas('radar_email_semanal_cron')[0][1]).toEqual({ p_ativo: true });
  });

  it('desligar o envio automático vai direto, sem confirmação', async () => {
    respostas.radar_email_semanal_painel = {
      data: { cron: { ativo: true, agenda: '0 11 * * 1' }, usuarios: [REGINA] }, error: null,
    };
    renderCard();
    await screen.findByText(/Ligado: quem está ligado/);
    fireEvent.click(screen.getByRole('switch', { name: 'Envio automático toda segunda' }));
    await waitFor(() => expect(chamadas('radar_email_semanal_cron')).toHaveLength(1));
    expect(chamadas('radar_email_semanal_cron')[0][1]).toEqual({ p_ativo: false });
  });

  it('cron ausente no banco: diz "não encontrado" e o interruptor fica travado (≠ desligado)', async () => {
    respostas.radar_email_semanal_painel = { data: { cron: null, usuarios: [REGINA] }, error: null };
    renderCard();
    expect(await screen.findByText(/Agendamento não encontrado no banco/)).toBeTruthy();
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  });

  it('avisa quando o e-mail ligado seria pulado (sem acesso ao Radar)', async () => {
    respostas.radar_email_semanal_painel = { data: { cron: { ativo: true, agenda: '' }, usuarios: [SEM_ACESSO] }, error: null };
    renderCard();
    expect(await screen.findByText('Sem acesso ao Radar: o e-mail seria pulado.')).toBeTruthy();
  });

  it('lente "Ver como": lê, mas os controles ficam travados', async () => {
    lente = { isImpersonating: true };
    renderCard();
    await screen.findByText('Regina');
    expect(screen.getByText(/só leitura/)).toBeTruthy();
    for (const s of screen.getAllByRole('combobox') as HTMLSelectElement[]) expect(s.disabled).toBe(true);
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  });
});
