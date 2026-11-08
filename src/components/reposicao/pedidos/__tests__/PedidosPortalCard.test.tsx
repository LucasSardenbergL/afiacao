import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Card "Pedidos do portal Sayerlack" + diálogo de importar (revisão Fable+Codex 2026-11). O supabase é mockado; os
 * componentes rodam de verdade.
 */
let respostaRpc: { data: unknown; error: unknown } = { data: null, error: null };
let respostaInvoke: { data: unknown; error: unknown } = { data: null, error: null };
const rpc = vi.fn(() => Promise.resolve(respostaRpc));
const invoke = vi.fn(() => Promise.resolve(respostaInvoke));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...(a as [])),
    functions: { invoke: (...a: unknown[]) => invoke(...(a as [])) },
  },
}));
vi.mock('@/components/execucoes/UltimaExecucao', () => ({ UltimaExecucao: () => null }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { PedidosPortalCard } from '../PedidosPortalCard';
import { painelV2 } from './painel-portal-fixture';
import { ImportarPedidoPortalDialog } from '../ImportarPedidoPortalDialog';

function renderizar(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { rpc.mockClear(); invoke.mockReset(); invoke.mockImplementation(() => Promise.resolve(respostaInvoke)); });

describe('PedidosPortalCard', () => {
  it('mostra a pendência do cron com o motivo e o botão de importar de novo, que abre o diálogo já com o número', async () => {
    respostaRpc = { data: painelV2({ pendencias: [{ protocolo: '2140762', mensagem: 'NCM 32091020 sem alíquota', tentativas: 2 }], total_pendencias: 1, pendentes_unicos: 1 }), error: null };
    renderizar(<PedidosPortalCard />);
    expect(await screen.findByText('Pedido 2140762')).toBeTruthy();
    expect(screen.getByText('NCM 32091020 sem alíquota')).toBeTruthy();
    expect(screen.getByText(/1 pendente/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Importar de novo' }));
    expect(((await screen.findByLabelText('Nº do pedido no portal')) as HTMLInputElement).value).toBe('2140762');
  });

  it('pedido no app sem pedido de compra aparece com link e com a falha do mesmo protocolo DENTRO da linha', async () => {
    respostaRpc = { data: painelV2({
      sem_po: [{ pedido_id: 3700, protocolo: '2141500', status: 'falha_envio', origem: 'app', desde: '2026-11-09T10:00:00Z', pendencia_mensagem: 'disparo falhou', pendencia_tentativas: 2 }],
      total_sem_po: 1, pendentes_unicos: 1,
    }), error: null };
    renderizar(<PedidosPortalCard />);
    const link = await screen.findByRole('link', { name: '#3700' });
    expect(link.getAttribute('href')).toBe('/admin/reposicao/pedidos?id=3700');
    expect(screen.getByText(/Enviado pelo app/)).toBeTruthy();
    expect(screen.getByText(/disparo falhou · 2 tentativas/)).toBeTruthy();
    expect(screen.getByText(/1 pendente$/)).toBeTruthy();
  });

  it('"Nada pendente" só com rodada efetiva em dia; sem prova diz que não pode afirmar', async () => {
    respostaRpc = { data: painelV2(), error: null };
    const { unmount } = renderizar(<PedidosPortalCard />);
    expect(await screen.findByText('Nada pendente do portal.')).toBeTruthy();
    expect(screen.getByTestId('pedidos-portal-consultado').textContent).toMatch(/Consultado às/);
    unmount();
    respostaRpc = { data: painelV2({ rodada: { em_dia: false, ultima_efetiva: null, ultima: null } }), error: null };
    renderizar(<PedidosPortalCard />);
    expect((await screen.findByTestId('pedidos-portal-veredito')).getAttribute('data-tom')).toBe('sem_prova');
    expect(screen.queryByText('Nada pendente do portal.')).toBeNull();
  });

  it('leitura falha, {} ou contrato v1 NUNCA dizem "nada pendente"', async () => {
    for (const r of [{ data: null, error: { message: 'permission denied' } }, { data: {}, error: null }, { data: { pendencias: [], sem_po: [], importados: [] }, error: null }]) {
      respostaRpc = r;
      const { unmount } = renderizar(<PedidosPortalCard />);
      expect(await screen.findByText(/Não consegui ler os pedidos do portal/)).toBeTruthy();
      expect(screen.queryByText('Nada pendente do portal.')).toBeNull();
      unmount();
    }
  });

  it('última rodada falhou depois da efetiva: alerta e sem "nada pendente"', async () => {
    const rodada = { ...(painelV2().rodada as object), ultima: { id: 'b', em: '2026-11-09T20:31:00Z', status: 'erro', erro: 'login recusado' } };
    respostaRpc = { data: painelV2({ rodada }), error: null };
    renderizar(<PedidosPortalCard />);
    expect((await screen.findByTestId('pedidos-portal-ultima-falhou')).textContent).toContain('login recusado');
    expect(screen.queryByText('Nada pendente do portal.')).toBeNull();
  });

  it('6.5/6.8/6.11: corte visível, sensor de alíquota e cancelado com pedido de compra', async () => {
    respostaRpc = { data: painelV2({
      pendencias: [{ protocolo: '1', mensagem: 'x' }], total_pendencias: 61, pendentes_unicos: 62,
      cancelado_com_po: [{ pedido_id: 9, protocolo: '7000006', omie_numero: '1291', situacao_em: '2026-11-09T15:30:00Z' }], total_cancelado_com_po: 1,
      sem_aliquota: { skus: 13, ncms: ['27101230', '32091010'] },
    }), error: null };
    renderizar(<PedidosPortalCard />);
    expect(await screen.findByText('Mostrando 1 de 61.')).toBeTruthy();
    expect(screen.getByTestId('pedidos-portal-sem-aliquota').textContent).toContain('13 SKUs Sayerlack sem alíquota de IPI (NCM 27101230, 32091010)');
    expect(screen.getByText('Cancelado no portal, mas com pedido de compra no Omie')).toBeTruthy();
    expect(screen.getByText(/pedido de compra 1291/)).toBeTruthy();
    expect(screen.queryByText(/\bPO\b/)).toBeNull(); // 6.9: vocabulário único
  });
});

describe('ImportarPedidoPortalDialog', () => {
  it('sucesso traz link "Abrir pedido" e a condição de pagamento', async () => {
    respostaInvoke = {
      data: { ok: true, etapa: 'concluido', pedido_id: 3644, omie_numero: '1291', valor_total: 3238.63, condicao: 'A07 · Para 7 dias', mensagem: 'ok' },
      error: null,
    };
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} protocoloInicial="2141068" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Importar' }));
    const link = await screen.findByRole('link', { name: /Abrir pedido #3644/ });
    expect(link.getAttribute('href')).toBe('/admin/reposicao/pedidos?id=3644');
    expect(screen.getByText('A07 · Para 7 dias')).toBeTruthy();
  });

  it('erro de transporte SEM corpo vira "não sei se entrou" (aviso), nunca "não foi importado"', async () => {
    respostaInvoke = { data: null, error: { message: 'Failed to send a request to the Edge Function' } };
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} protocoloInicial="2141068" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Importar' }));
    const res = await screen.findByTestId('importar-portal-resultado');
    expect(res.getAttribute('data-tom')).toBe('aviso');
    expect(screen.getByText('Não sei se o pedido 2141068 entrou')).toBeTruthy();
    expect(screen.queryByText(/não foi importado/)).toBeNull();
  });

  it('SKU sem de-para mostra o atalho para o Mapeamento de SKU', async () => {
    respostaInvoke = { data: { ok: false, etapa: 'importacao', sqlstate: 'IP002', mensagem: 'sem de-para: X' }, error: null };
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} protocoloInicial="2141068" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Importar' }));
    const link = await screen.findByRole('link', { name: 'Abrir Mapeamento de SKU' });
    expect(link.getAttribute('href')).toBe('/admin/sku-mapeamento');
  });

  it('durante a importação o X some e o tempo decorrido aparece', async () => {
    let soltar: (v: { data: unknown; error: unknown }) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((r) => { soltar = r; }));
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} protocoloInicial="2141068" />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Importar' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close' })).toBeNull());
    expect(screen.getByText(/Não feche esta janela/)).toBeTruthy();
    soltar({ data: { ok: true, etapa: 'concluido', pedido_id: 1 }, error: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy());
  });

  it('8.5: vários números rodam UM POR VEZ, cada um com o seu resultado e o seu "Importar de novo"', async () => {
    const soltar: Record<string, (v: { data: unknown; error: unknown }) => void> = {};
    invoke.mockImplementation(((_nome: string, opts: { body: { protocolo: string } }) =>
      new Promise((r) => { soltar[opts.body.protocolo] = r; })) as never);
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('Nº do pedido no portal'), { target: { value: '2141068, 2141069' } });
    fireEvent.click(screen.getByRole('button', { name: 'Importar 2' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(Object.keys(soltar)).toEqual(['2141068']); // o 2º só sai depois do 1º responder
    soltar['2141068']({ data: { ok: true, etapa: 'concluido', pedido_id: 1, omie_numero: '9' }, error: null });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    soltar['2141069']({ data: {}, error: null });
    await waitFor(() => expect(screen.getAllByTestId('importar-portal-resultado')).toHaveLength(2));
    const tons = screen.getAllByTestId('importar-portal-resultado').map((el) => el.getAttribute('data-tom'));
    expect(tons).toEqual(['sucesso', 'aviso']);
    expect(screen.getByText('Não sei se o pedido 2141069 entrou')).toBeTruthy();
    // recuperação só do número que não fechou
    const repetir = screen.getAllByRole('button', { name: /Importar de novo/ });
    expect(repetir).toHaveLength(1);
    fireEvent.click(repetir[0]);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect((invoke.mock.calls[2] as unknown as [string, { body: { protocolo: string } }])[1].body.protocolo).toBe('2141069');
    soltar['2141069']({ data: { ok: true, etapa: 'concluido', pedido_id: 2 }, error: null });
    await waitFor(() => expect(screen.getAllByTestId('importar-portal-resultado').map((el) => el.getAttribute('data-tom'))).toEqual(['sucesso', 'sucesso']));
  });

  it('número inválido na lista bloqueia o envio e é mostrado', async () => {
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('Nº do pedido no portal'), { target: { value: '2141068 12' } });
    expect(screen.getByText(/Não é número do portal .*: 12/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Importar/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('B8: situação lida e não gravada aparece no resultado', async () => {
    invoke.mockImplementation(() => Promise.resolve({ data: { ok: true, etapa: 'concluido', pedido_id: 1, situacao_portal: 'Cancelado', situacao_gravada: 'erro' }, error: null }));
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} protocoloInicial="2141068" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Importar' }));
    expect((await screen.findByTestId('importar-portal-aviso-situacao')).textContent).toContain('não foi gravada');
  });
});
