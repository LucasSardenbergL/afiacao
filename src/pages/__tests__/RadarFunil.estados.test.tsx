import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Radar H — tela do funil: gate master/gestor (sem gate, nem chama a RPC); "—" onde o sensor não cobria, 0 onde
 * mediu; denominador à vista; sensor que falhou aparece com o motivo; erro de leitura não mostra número nenhum.
 */
const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (n: string, a?: unknown) => rpc(n, a) } }));
let auth = { isMaster: false, isGestorComercial: true, loading: false };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import RadarFunil from '../RadarFunil';
import { COLUNAS } from '@/lib/radar/funil';

function linha(semana: string, over: Record<string, unknown>) {
  const l: Record<string, unknown> = { semana, vendedor_user_id: 'v1' };
  for (const c of COLUNAS) l[c] = 0;
  return { ...l, ...over };
}
const sensor = (s: string, estado: string, falhas: Array<{ motivo: string; n: number }> = []) => ({
  sensor: s, rotulo: `Rótulo ${s}`, fonte: 'fonte', instalado_em: null, cobertura_desde: null, ultimo_registro_em: null,
  registros_periodo: 0, falhas_periodo: falhas.reduce((a, f) => a + f.n, 0), falhas, estado,
});
const cob = { email_envio: 'completa', email_entrega: 'completa', abertura_email: 'completa', ficha_email: 'ausente',
  card_servido: 'completa', abertura_card: 'completa', ficha_card: 'ausente', contato: 'completa', cadastro: 'completa' };
const PAINEL = {
  gerado_em: '2026-11-07T20:00:00+00:00', semanas_pedidas: 8, inicio: '2026-09-14', fim: '2026-11-08',
  semanas: [{ semana: '2026-11-02', corrente: true, cobertura: cob }],
  sensores: [sensor('email_entrega', 'falhou', [{ motivo: 'falha_notificacao', n: 2 }]), sensor('ficha_card', 'sem_registro')],
  vendedores: [{ user_id: 'v1', nome: 'Regina' }],
  linhas: [linha('2026-11-02', { email_enviados: 3, email_entregues: 1, email_falhos: 2, email_leads_entregues: 5,
    email_leads_clicados: 2, email_fichas: null, card_fichas: null, contatos: 0, contatos_empurrados: 0 })],
};

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/radar/funil']}><RadarFunil /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rpc.mockReset();
  auth = { isMaster: false, isGestorComercial: true, loading: false };
});

describe('RadarFunil', () => {
  it('sem ser master/gestor: avisa e NÃO chama a RPC', () => {
    auth = { isMaster: false, isGestorComercial: false, loading: false };
    montar();
    expect(screen.getByText('Só master ou gestor comercial')).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('gestor: mostra o funil com denominador, "—" sem sensor e 0 medido', async () => {
    rpc.mockResolvedValue({ data: PAINEL, error: null });
    montar();
    const etapa = (await screen.findByText('E-mails entregues', { selector: 'div' })).parentElement as HTMLElement;
    expect(etapa).toHaveTextContent(/1\s*de\s*3\s*\(33\s?%\)/);
    expect(rpc).toHaveBeenCalledWith('radar_funil', { p_semanas: 8 });
    const fichas = screen.getByText('Fichas entregues (dos cliques no e-mail)', { selector: 'div' }).parentElement as HTMLElement;
    // e-mail: ficha sem sensor = "—" de 2 cliques, taxa "—" (nunca 0 %)
    expect(fichas).toHaveTextContent(/—\s*de\s*2\s*\(—\)/);
    const contatos = screen.getByText(/Contatos humanos em lead empurrado/, { selector: 'div' }).parentElement as HTMLElement;
    expect(contatos).toHaveTextContent(/0\s*de\s*0\s*\(—\)/);
  });

  it('sensor que falhou aparece com o motivo; sensor sem escritor aparece como "nunca gravou"', async () => {
    rpc.mockResolvedValue({ data: PAINEL, error: null });
    montar();
    expect(await screen.findByText('Saúde dos sensores')).toBeInTheDocument();
    const linhaEntrega = screen.getByText('Rótulo email_entrega').closest('tr') as HTMLElement;
    expect(within(linhaEntrega).getByText('falhou')).toBeInTheDocument();
    expect(within(linhaEntrega).getByText(/2 × falha notificacao/)).toBeInTheDocument();
    const linhaFicha = screen.getByText('Rótulo ficha_card').closest('tr') as HTMLElement;
    expect(within(linhaFicha).getByText('nunca gravou')).toBeInTheDocument();
  });

  it('nenhum vendedor no funil com o sensor cobrindo: 0 medido, não "—"', async () => {
    rpc.mockResolvedValue({ data: { ...PAINEL, vendedores: [], linhas: [] }, error: null });
    montar();
    const etapa = (await screen.findByText('E-mails entregues', { selector: 'div' })).parentElement as HTMLElement;
    expect(etapa).toHaveTextContent(/0\s*de\s*0\s*\(—\)/);
    // a ficha do e-mail continua sem sensor na semana: "—"
    const fichas = screen.getByText('Fichas entregues (dos cliques no e-mail)', { selector: 'div' }).parentElement as HTMLElement;
    expect(fichas).toHaveTextContent(/—\s*de\s*0/);
  });

  it('erro de leitura: mensagem honesta, nenhum número inventado', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'forbidden: funil do radar exige master ou gestor comercial' } });
    montar();
    expect(await screen.findByText('Não consegui ler o funil')).toBeInTheDocument();
    expect(screen.queryByText('Funil do período')).toBeNull();
  });

  it('resposta fora da forma também é erro (não vira 0)', async () => {
    rpc.mockResolvedValue({ data: { ...PAINEL, linhas: [linha('2026-11-02', { contatos: 'muitos' })] }, error: null });
    montar();
    expect(await screen.findByText('Não consegui ler o funil')).toBeInTheDocument();
  });
});
