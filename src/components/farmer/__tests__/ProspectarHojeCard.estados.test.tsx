import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Radar D2 — card "Prospectar hoje". O HOOK roda de verdade; só o supabase é mockado (por nome de RPC), para provar a
 * tradução RPC → tela: erro não vira "sem leads" (ausente ≠ zero), sem território ≠ sem leads, a ação principal
 * (Assumir) e o link da ficha (/radar?cnpj=) gravam no ledger, e a lente "Ver como" lê a persona sem gravar nada.
 */

type Resposta = { data: unknown; error: { message: string } | null };
const respostas: Record<string, Resposta> = {};
// Encadeável como o cliente real (`.rpc().order().range()` — a leitura da posse usa).
const rpc = vi.fn((nome: string, _args?: unknown) => {
  const r = Promise.resolve(respostas[nome] ?? { data: null, error: { message: `sem mock: ${nome}` } });
  return Object.assign(r, { order() { return this; }, range() { return this; } });
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (n: string, a?: unknown) => rpc(n, a) } }));

let auth = { role: 'employee', commercialRole: 'farmer' as string | null };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
let display = { displayRole: 'employee', displayCommercialRole: 'farmer' as string | null };
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: () => display }));
let lente = { isImpersonating: false, effectiveUserId: 'eu' };
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => lente }));
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  Link: ({ to, children, ...p }: { to: string; children: ReactNode }) => <a href={to} {...p}>{children}</a>,
}));
// O sensor é da sessão H: aqui ele é controlável, para provar o contrato (só marca "registrado" com confirmação).
const sensor = vi.fn((_n: number): unknown => undefined);
vi.mock('@/queries/useRadarRegistroEmpurrado', () => ({
  registrarCardServido: (n: number) => sensor(n),
  registrarAberturaEmpurrada: (a: unknown) => rpc('radar_registrar_abertura_empurrada', {
    p_origem: (a as { origem: string }).origem, p_cnpj: (a as { cnpj: string }).cnpj,
  }),
}));
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

function renderCard(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return { qc, ...render(<QueryClientProvider client={qc}><ProspectarHojeCard /></QueryClientProvider>) };
}
const chamadas = (nome: string) => rpc.mock.calls.filter((c) => c[0] === nome);

beforeEach(() => {
  rpc.mockClear(); navigate.mockClear(); track.mockClear();
  sensor.mockReset(); sensor.mockImplementation((n: number) => rpc('radar_registrar_card_servido', { p_n_leads: n }));
  for (const k of Object.keys(respostas)) delete respostas[k];
  auth = { role: 'employee', commercialRole: 'farmer' };
  display = { displayRole: 'employee', displayCommercialRole: 'farmer' };
  lente = { isImpersonating: false, effectiveUserId: 'eu' };
  respostas.radar_prospectar_hoje = { data: { territorio: TERRITORIO, leads: TRES }, error: null };
  respostas.radar_registrar_card_servido = { data: { ok: true, registrado: true }, error: null };
  respostas.radar_registrar_abertura_empurrada = { data: { ok: true, registrado: true, do_destinatario: true }, error: null };
  respostas.radar_definir_atendimento = { data: { ok: true, renovado: false, ja_livre: false, expira_em: '2026-11-13T12:00:00Z' }, error: null };
  respostas.radar_atendimentos_ativos = { data: [], error: null };
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

  it('depois de Assumir: a linha vira "com você" (link p/ Meus atendimentos), sem 2º Assumir, e o card é relido', async () => {
    const { qc } = renderCard();
    await screen.findByText('Marcenaria Um');
    const invalidar = vi.spyOn(qc, 'invalidateQueries');
    fireEvent.click(screen.getAllByRole('button', { name: /Assumir/ })[0]);
    const chip = await screen.findByTestId('prospectar-hoje-com-voce');
    expect(chip).toHaveAttribute('href', '/radar?visao=meus');
    expect(screen.getAllByRole('button', { name: /Assumir/ })).toHaveLength(2);
    await waitFor(() => expect(invalidar).toHaveBeenCalledWith({ queryKey: ['radar', 'prospectar-hoje'] }));
    await waitFor(() => expect(chamadas('radar_prospectar_hoje').length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId('prospectar-hoje-meus')).toHaveTextContent('(1 assumido agora)');
  });

  it('lead que JÁ é meu (posse viva ou marcado com_voce pela RPC) nasce "com você", nunca "Assumir"', async () => {
    respostas.radar_atendimentos_ativos = { data: [{ cnpj: '00000000000108', dono_user_id: 'eu', dono_nome: 'Eu',
      assumido_em: '2026-11-06T12:00:00Z', expira_em: '2026-11-13T12:00:00Z', eh_meu: true }], error: null };
    respostas.radar_prospectar_hoje = { data: { territorio: TERRITORIO, leads: [TRES[0], TRES[1], { ...TRES[2], com_voce: true }] }, error: null };
    renderCard();
    await waitFor(() => expect(screen.getAllByTestId('prospectar-hoje-com-voce')).toHaveLength(2));
    expect(screen.getAllByRole('button', { name: /Assumir/ })).toHaveLength(1);
  });

  it('lead passado pelo gestor (atribuido) leva o selo', async () => {
    respostas.radar_prospectar_hoje = { data: { territorio: TERRITORIO, leads: [{ ...TRES[0], atribuido: true }, TRES[1]] }, error: null };
    renderCard();
    expect(await screen.findByTestId('prospectar-hoje-atribuido')).toHaveTextContent('passado pelo gestor');
    expect(screen.getAllByTestId('prospectar-hoje-atribuido')).toHaveLength(1);
  });

  it('sensor que FALHOU não marca "registrado": a próxima leitura tenta de novo', async () => {
    sensor.mockImplementation(() => Promise.resolve(false));
    const { qc } = renderCard();
    await screen.findByText('Marcenaria Um');
    await waitFor(() => expect(sensor).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(track).toHaveBeenCalledWith('radar.prospectar_hoje_sensor_falhou', {}));
    sensor.mockImplementation(() => Promise.resolve({ ok: true }));
    respostas.radar_prospectar_hoje = { data: { territorio: TERRITORIO, leads: TRES.slice(0, 2) }, error: null };
    await qc.invalidateQueries({ queryKey: ['radar', 'prospectar-hoje'] });
    await waitFor(() => expect(sensor).toHaveBeenCalledTimes(2));
    expect(sensor).toHaveBeenLastCalledWith(2);
  });

  it('sensor confirmado (true) não registra de novo na releitura', async () => {
    sensor.mockImplementation(() => Promise.resolve(true));
    const { qc } = renderCard();
    await screen.findByText('Marcenaria Um');
    await waitFor(() => expect(sensor).toHaveBeenCalledTimes(1));
    respostas.radar_prospectar_hoje = { data: { territorio: TERRITORIO, leads: TRES.slice(0, 2) }, error: null };
    await qc.invalidateQueries({ queryKey: ['radar', 'prospectar-hoje'] });
    await screen.findByText('Moveis Oito');
    await waitFor(() => expect(screen.getAllByTestId('prospectar-hoje-lead')).toHaveLength(2));
    expect(sensor).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['nao_e_vendedor', /papel de vendedor/],
    ['sem_carteira', /carteira está vazia/],
    ['carteira_sem_municipio', /não têm endereço em um município do Radar/],
  ])('sem território com motivo %s: a copy diz o porquê', async (motivo, texto) => {
    respostas.radar_prospectar_hoje = { data: { territorio: [], leads: [], territorio_motivo: motivo }, error: null };
    renderCard();
    expect(await screen.findByText('Sem território no Radar')).toBeInTheDocument();
    expect(screen.getByText(texto)).toBeInTheDocument();
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
