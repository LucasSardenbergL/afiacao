import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ItensDoPlano, PlanoDoEvento } from '@/lib/radar/sucessao-plano';

/**
 * A tela do plano de rateio: os estados (sem plano, vigente, revogado, evento sem declaração ativa, antiga sem compra
 * antes do corte), a publicação com a revisão esperada lida e as regras do rascunho, as recusas do servidor
 * (`revisao_mudou` e cia.) como aviso — nunca "publicado" —, o aviso honesto do reprocesso (até 1 min) e a lente
 * "Ver como" (só leitura: nada habilita, nada chama a escrita).
 */
let lente = false;
let plano: PlanoDoEvento;
let itens: ItensDoPlano;
const publicar = vi.fn();
const revogar = vi.fn();
const track = vi.fn();
const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: lente }) }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));
const ok = (data: unknown) => ({
  data, isPending: false, isLoading: false, isError: false, isSuccess: true, isFetching: false, error: null,
  status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1, refetch: vi.fn(),
});
vi.mock('@/queries/useRadarSucessoes', () => ({
  useRadarPlanoSucessao: () => ({ plano: ok(plano), itens: ok(itens) }),
  useRadarPublicarPlano: () => ({ isPending: false, mutateAsync: publicar }),
  useRadarRevogarPlano: () => ({ isPending: false, mutateAsync: revogar }),
}));

import { RadarSucessaoPlano } from '../RadarSucessaoPlano';

const NOV2 = '22222222000122';
const NOV1 = '69491768000101';
const semPlano = (): PlanoDoEvento => ({ eventoId: 'ev1', revisao: 0, revogado: false, regras: [], revisoes: [] });
const vigente = (): PlanoDoEvento => ({
  eventoId: 'ev1', revisao: 2, revogado: false,
  regras: [{ empresa: 'oben', omieCodigoProduto: 1004, descricao: 'VERNIZ A', novoDocumento: NOV2, destinoSucessaoId: 'd2',
    origem: 'familia', familia: 'VERNIZ', destinoEstado: 'ativa', destinoImpedimento: null }],
  revisoes: [
    { revisao: 2, revoga: false, motivo: 'acerto', publicadoPorNome: 'Gestor', publicadoEm: '2026-11-07T15:00:00Z', regras: 1 },
    { revisao: 1, revoga: false, motivo: null, publicadoPorNome: 'Lucas', publicadoEm: '2026-11-06T15:00:00Z', regras: 3 },
  ],
});
const baseItens = (o: Partial<ItensDoPlano> = {}): ItensDoPlano => ({
  eventoId: 'ev1', ativo: true, tipo: 'cisao', dataCorte: '2026-10-06', antigoDocumento: '03166577000166',
  antigoNome: 'DIVIMOVEIS', antigoResolvido: true,
  destinos: [
    { destinoSucessaoId: 'd1', novoDocumento: NOV1, novoNome: 'MARQUES', estado: 'declarada', impedimento: 'novo_sem_cadastro' },
    { destinoSucessaoId: 'd2', novoDocumento: NOV2, novoNome: 'NOVA DOIS', estado: 'ativa', impedimento: null },
  ],
  itens: [
    { empresa: 'oben', omieCodigoProduto: 1001, descricao: 'PROD 1001', familia: 'OUTRA', pedidos: 3, ultimoPedido: '2026-08-01' },
    { empresa: 'oben', omieCodigoProduto: 1004, descricao: 'VERNIZ A', familia: 'VERNIZ', pedidos: 4, ultimoPedido: '2026-08-02' },
    { empresa: 'oben', omieCodigoProduto: 1005, descricao: 'VERNIZ B', familia: 'VERNIZ', pedidos: 2, ultimoPedido: '2026-07-02' },
  ],
  sugestoesHoje: { herdadas: 3, mostradas: 1 },
  ...o,
});

const tela = () => render(<RadarSucessaoPlano eventoId="ev1" aberto onFechar={() => {}} />);
const escolher = (rotulo: string, valor: string) => fireEvent.change(screen.getByLabelText(rotulo), { target: { value: valor } });

beforeEach(() => {
  lente = false;
  plano = semPlano();
  itens = baseItens();
  publicar.mockReset(); revogar.mockReset(); track.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});

describe('RadarSucessaoPlano', () => {
  it('sem plano: diz que tudo fica com a antiga, mostra o sensor do dia e o destino pendente', () => {
    tela();
    expect(screen.getByTestId('radar-plano-estado').textContent).toContain('Sem plano publicado: todo o histórico fica com a antiga.');
    expect(screen.getByTestId('radar-plano-sensor').textContent).toContain('3 sugestão(ões) herdada(s)');
    expect(screen.getByTestId('radar-plano-sensor').textContent).toContain('1 já mostrada(s)');
    expect(screen.getByText(/MARQUES ainda não herda: falta o cadastro no Omie/)).toBeTruthy();
    expect(screen.getByTestId('radar-plano-resumo').textContent).toBe('3 ficam com a antiga');
    // nada mudou → não publica
    expect((screen.getByTestId('radar-plano-publicar') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('radar-plano-revogar')).toBeNull();
    expect(track).toHaveBeenCalledWith('radar.sucessao_plano_aberto', { lente: false });
  });

  it('publica com a revisão esperada LIDA e as regras do rascunho (família virou itens); avisa o reprocesso', async () => {
    publicar.mockResolvedValue({ ok: true, revisao: 1 });
    tela();
    escolher('Destino da família VERNIZ', NOV2);
    escolher('Destino de PROD 1001', NOV1);
    expect(screen.getByTestId('radar-plano-resumo').textContent).toBe('2 itens para NOVA DOIS · 1 item para MARQUES · 0 ficam com a antiga');
    fireEvent.change(screen.getByLabelText('Motivo desta revisão (opcional)'), { target: { value: ' combinado com o dono ' } });
    fireEvent.click(screen.getByTestId('radar-plano-publicar'));
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(1));
    expect(publicar).toHaveBeenCalledWith({
      eventoId: 'ev1', revisao: 0, motivo: 'combinado com o dono',
      regras: [
        { empresa: 'oben', omie_codigo_produto: 1001, novo_documento: NOV1 },
        { empresa: 'oben', omie_codigo_produto: 1004, novo_documento: NOV2 },
        { empresa: 'oben', omie_codigo_produto: 1005, novo_documento: NOV2 },
      ],
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Plano publicado (revisão 1)', {
      description: 'As sugestões de hoje se atualizam em até 1 minuto.',
    }));
  });

  it('recusa revisao_mudou vira aviso (nunca "publicado")', async () => {
    publicar.mockResolvedValue({ ok: false, motivo: 'revisao_mudou', revisao: 1, detalhe: null });
    tela();
    escolher('Destino de PROD 1001', NOV2);
    fireEvent.click(screen.getByTestId('radar-plano-publicar'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(
      'Outra pessoa publicou ou revogou este plano agora há pouco. Recarreguei: confira e publique de novo.'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('recusa com detalhe (regra_conflitante) cita o item', async () => {
    publicar.mockResolvedValue({ ok: false, motivo: 'regra_conflitante', revisao: null, detalhe: 'oben:1004' });
    tela();
    escolher('Destino de PROD 1001', NOV2);
    fireEvent.click(screen.getByTestId('radar-plano-publicar'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('O mesmo item foi para duas empresas novas: oben:1004.'));
  });

  it('erro de verdade (rede/permissão) vira erro, não aviso', async () => {
    publicar.mockRejectedValue(new Error('forbidden: gestor/master only'));
    tela();
    escolher('Destino de PROD 1001', NOV2);
    fireEvent.click(screen.getByTestId('radar-plano-publicar'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível publicar o plano', {
      description: 'forbidden: gestor/master only',
    }));
  });

  it('plano vigente: carrega o rascunho do plano, mostra quem publicou, o histórico e permite revogar com motivo', async () => {
    plano = vigente();
    revogar.mockResolvedValue({ ok: true, revisao: 3 });
    tela();
    expect(screen.getByTestId('radar-plano-estado').textContent).toContain('Plano vigente: revisão 2, 1 item(ns), publicado por Gestor em 07/11/2026.');
    expect((screen.getByLabelText('Destino de VERNIZ A') as HTMLSelectElement).value).toBe(NOV2);
    expect(screen.getByTestId('radar-plano-revisoes').textContent).toContain('Revisão 2 · 1 item(ns) · Gestor em 07/11/2026: acerto');
    expect(screen.getByTestId('radar-plano-publicar').textContent).toContain('Publicar revisão 3');
    fireEvent.click(screen.getByTestId('radar-plano-revogar'));
    const confirmar = await screen.findByTestId('radar-plano-revogar-confirmar');
    expect((confirmar as HTMLButtonElement).disabled).toBe(true);   // motivo obrigatório
    fireEvent.change(screen.getByLabelText('Por que revogar o plano?'), { target: { value: 'combinado errado' } });
    fireEvent.click(confirmar);
    await waitFor(() => expect(revogar).toHaveBeenCalledWith({ eventoId: 'ev1', revisao: 2, motivo: 'combinado errado' }));
  });

  it('revogar recusado (sem_plano) vira aviso', async () => {
    plano = vigente();
    revogar.mockResolvedValue({ ok: false, motivo: 'sem_plano', revisao: null, detalhe: null });
    tela();
    fireEvent.click(screen.getByTestId('radar-plano-revogar'));
    fireEvent.change(await screen.findByLabelText('Por que revogar o plano?'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('radar-plano-revogar-confirmar'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Não há plano vigente para revogar.'));
  });

  it('plano revogado: diz que voltou tudo à antiga e começa sem destino; não oferece revogar de novo', () => {
    plano = { ...vigente(), revisao: 3, revogado: true, regras: [] };
    tela();
    expect(screen.getByTestId('radar-plano-estado').textContent).toContain('Plano revogado (revisão 3): todo o histórico voltou para a antiga.');
    expect((screen.getByLabelText('Destino de VERNIZ A') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('radar-plano-revogar')).toBeNull();
  });

  it('evento sem declaração ativa: estado vazio, sem editor', () => {
    itens = { ...baseItens(), ativo: false, destinos: [], itens: [] };
    tela();
    expect(screen.getByText('Sucessão sem declaração ativa')).toBeTruthy();
    expect(screen.queryByTestId('radar-plano-publicar')).toBeNull();
  });

  it('antiga sem compra antes do corte: estado vazio, nada a publicar', () => {
    itens = baseItens({ itens: [] });
    tela();
    expect(screen.getByText('Nenhuma compra antes do corte')).toBeTruthy();
    expect((screen.getByTestId('radar-plano-publicar') as HTMLButtonElement).disabled).toBe(true);
  });

  it('antiga não resolvida no cadastro: avisa e não publica', () => {
    itens = baseItens({ antigoResolvido: false });
    tela();
    escolher('Destino de PROD 1001', NOV2);
    expect(screen.getByText(/não aponta para um cliente único/)).toBeTruthy();
    expect((screen.getByTestId('radar-plano-publicar') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lente "Ver como": só leitura — seletores travados, sem publicar/revogar, nenhuma escrita', () => {
    lente = true;
    plano = vigente();
    tela();
    expect(screen.getByTestId('radar-plano-lente').textContent).toContain('só leitura');
    expect((screen.getByLabelText('Destino de VERNIZ A') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByTestId('radar-plano-publicar')).toBeNull();
    expect(screen.queryByTestId('radar-plano-revogar')).toBeNull();
    expect(screen.queryByLabelText('Destino da família VERNIZ')).toBeNull();
    expect(publicar).not.toHaveBeenCalled();
    expect(revogar).not.toHaveBeenCalled();
  });
});
