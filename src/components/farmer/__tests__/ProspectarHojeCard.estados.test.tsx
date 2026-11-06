import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Radar D2 — card "Prospectar hoje". O HOOK roda de verdade; só o supabase é mockado (por nome de RPC), para provar a
 * tradução RPC → tela: erro não vira "sem leads" (ausente ≠ zero), sem território ≠ sem leads, a ação principal
 * (Assumir) e o link da ficha (/radar?cnpj=) gravam no ledger, e a lente "Ver como" lê a persona sem gravar nada.
 */

type Resposta = { data: unknown; error: { message: string } | null };
const respostas: Record<string, Resposta> = {};
const rpc = vi.fn((nome: string, _args?: unknown) => Promise.resolve(respostas[nome] ?? { data: null, error: { message: `sem mock: ${nome}` } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (n: string, a?: unknown) => rpc(n, a) } }));

let auth = { role: 'employee', commercialRole: 'farmer' as string | null };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
let display = { displayRole: 'employee', displayCommercialRole: 'farmer' as string | null };
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: () => display }));
let lente = { isImpersonating: false, effectiveUserId: 'eu' };
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => lente }));
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));

import { ProspectarHojeCard } from '../ProspectarHojeCard';

const TERRITORIO = [
  { municipio_codigo: '3122306', municipio_nome: 'DIVINOPOLIS', uf: 'MG', clientes: 358 },
  { municipio_codigo: '3145208', municipio_nome: 'NOVA SERRANA', uf: 'MG', clientes: 266 },
];
const lead = (posicao: number, cnpj: string, nome: string) => ({
  posicao, cnpj, razao_social: `${nome} Ltda`, nome_fantasia: nome, municipio_nome: 'DIVINOPOLIS', uf: 'MG',
  score: 96 - posicao, score_motivos: ['CNAE 3101'], elegiveis: 8,
});
const TRES = [lead(1, '00000000000101', 'Marcenaria Um'), lead(2, '00000000000108', 'Moveis Oito'), lead(3, '00000000000109', 'Lead Nove')];

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ProspectarHojeCard /></QueryClientProvider>);
}
const chamadas = (nome: string) => rpc.mock.calls.filter((c) => c[0] === nome);

beforeEach(() => {
  rpc.mockClear(); navigate.mockClear(); track.mockClear();
  for (const k of Object.keys(respostas)) delete respostas[k];
  auth = { role: 'employee', commercialRole: 'farmer' };
  display = { displayRole: 'employee', displayCommercialRole: 'farmer' };
  lente = { isImpersonating: false, effectiveUserId: 'eu' };
  respostas.radar_prospectar_hoje = { data: { territorio: TERRITORIO, leads: TRES }, error: null };
  respostas.radar_registrar_card_servido = { data: { ok: true, registrado: true }, error: null };
  respostas.radar_registrar_abertura_empurrada = { data: { ok: true, registrado: true, do_destinatario: true }, error: null };
  respostas.radar_definir_atendimento = { data: { ok: true, renovado: false, ja_livre: false, expira_em: '2026-11-13T12:00:00Z' }, error: null };
});

describe('ProspectarHojeCard', () => {
  it('mostra os 3 leads com o denominador e o território que os decidiu; grava "servido" 1 vez', async () => {
    renderCard();
    expect(await screen.findByText('Marcenaria Um')).toBeInTheDocument();
    expect(screen.getAllByTestId('prospectar-hoje-lead')).toHaveLength(3);
    expect(screen.getByText('3 de 8')).toBeInTheDocument();
    expect(screen.getByText(/Perto dos seus clientes: Divinopolis \(358\) · Nova Serrana \(266\)/)).toBeInTheDocument();
    expect(chamadas('radar_prospectar_hoje')[0][1]).toEqual({ p_n: 3 });
    await waitFor(() => expect(chamadas('radar_registrar_card_servido')).toHaveLength(1));
    expect(chamadas('radar_registrar_card_servido')[0][1]).toEqual({ p_n_leads: 3 });
  });

  it('Abrir ficha: grava a abertura (origem card) e vai para /radar?cnpj=', async () => {
    renderCard();
    await screen.findByText('Moveis Oito');
    fireEvent.click(screen.getAllByRole('button', { name: 'Abrir ficha' })[1]);
    expect(chamadas('radar_registrar_abertura_empurrada')[0][1]).toEqual({ p_origem: 'card', p_cnpj: '00000000000108' });
    expect(navigate).toHaveBeenCalledWith('/radar?cnpj=00000000000108');
  });

  it('Assumir (ação principal) chama radar_definir_atendimento com o lead da linha', async () => {
    renderCard();
    await screen.findByText('Marcenaria Um');
    fireEvent.click(screen.getAllByRole('button', { name: /Assumir/ })[0]);
    await waitFor(() => expect(chamadas('radar_definir_atendimento')).toHaveLength(1));
    expect(chamadas('radar_definir_atendimento')[0][1]).toEqual({ p_cnpj: '00000000000101', p_acao: 'assumir' });
  });

  it('leitura que FALHOU mostra erro honesto, nunca o vazio "sem leads"', async () => {
    respostas.radar_prospectar_hoje = { data: null, error: { message: 'timeout' } };
    renderCard();
    expect(await screen.findByTestId('prospectar-hoje-erro')).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum lead a contatar/)).toBeNull();
    expect(chamadas('radar_registrar_card_servido')).toHaveLength(0);
  });

  it('sem território (carteira sem município do Radar) é estado distinto de "sem leads"', async () => {
    respostas.radar_prospectar_hoje = { data: { territorio: [], leads: [] }, error: null };
    renderCard();
    expect(await screen.findByText('Sem território no Radar')).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum lead a contatar/)).toBeNull();
  });

  it('território sem lead elegível: vazio operacional, sem gravar "servido"', async () => {
    respostas.radar_prospectar_hoje = { data: { territorio: TERRITORIO, leads: [] }, error: null };
    renderCard();
    expect(await screen.findByText('Nenhum lead a contatar perto da sua carteira')).toBeInTheDocument();
    expect(chamadas('radar_registrar_card_servido')).toHaveLength(0);
  });

  it('lente "Ver como": lê os leads da persona, Assumir desligado, nada gravado no ledger', async () => {
    auth = { role: 'master', commercialRole: null };
    lente = { isImpersonating: true, effectiveUserId: 'vendedora-x' };
    renderCard();
    await screen.findByText('Marcenaria Um');
    expect(chamadas('radar_prospectar_hoje')[0][1]).toEqual({ p_vendedor: 'vendedora-x', p_n: 3 });
    expect(screen.getAllByRole('button', { name: /Assumir/ })[0]).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Abrir ficha' })[0]);
    expect(navigate).toHaveBeenCalledWith('/radar?cnpj=00000000000101');
    expect(chamadas('radar_registrar_abertura_empurrada')).toHaveLength(0);
    expect(chamadas('radar_registrar_card_servido')).toHaveLength(0);
  });

  it('fora do gate do Radar (employee sem cargo de venda): não renderiza nem consulta', () => {
    auth = { role: 'employee', commercialRole: 'operacional' };
    display = { displayRole: 'employee', displayCommercialRole: 'operacional' };
    const { container } = renderCard();
    expect(container).toBeEmptyDOMElement();
    expect(rpc).not.toHaveBeenCalled();
  });
});
