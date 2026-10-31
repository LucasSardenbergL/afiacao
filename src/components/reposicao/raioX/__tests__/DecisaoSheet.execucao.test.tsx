/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReposicaoEmpresaProvider } from '@/contexts/ReposicaoEmpresaContext';
import type { DecisaoRow, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { decisao } from '@/lib/reposicao/raio-x/__tests__/fixtures';

/**
 * Seção "Execução" do Sheet (pacote 2): `raio_x_planejar` com estado completo, piso/canal só no liquidar,
 * número pt-BR inválido não sai do cliente, só aparece para decisão GRAVADA de destino executável.
 */

type Resp = { data: unknown; error: unknown };
const rpc = vi.hoisted(() => vi.fn((_nome: string, _args: Record<string, unknown>): Promise<Resp> => Promise.resolve({ data: {}, error: null })));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (nome: string, args: Record<string, unknown>) => rpc(nome, args) },
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const track = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a), captureException: vi.fn() }));
vi.mock('@/lib/time/sp-day', async (orig) => ({ ...(await orig<typeof import('@/lib/time/sp-day')>()), hojeSP: () => '2026-11-01' }));

import { DecisaoSheet } from '../DecisaoSheet';

const itemRX = (p: Partial<ItemRaioX> = {}): ItemRaioX => ({
  sku_codigo_omie: 1, codigo: 'C1', descricao: 'VERNIZ X', familia: null, tipo_produto: '00', ativo: true,
  saldo: 10, cmc: 5, unidade_estoque: 'UN', unidades_venda: ['UN'], no_motor: true, tipo_reposicao: 'normal',
  classe_abc: null, cadastro_em: null, ult_entrada: null, fornecedor: 'SAYERLACK', q12: 0, ncli: 0,
  ult_venda: null, preco_medio_12m: 9, clientes: [], synced_at: null, habilitado_reposicao_automatica: true,
  valor: 6000, cobertura: null, categoria: 'mercadoria', motivo_categoria: '', parado: true,
  destino_sugerido: 'liquidar', motivo_destino: '', alerta_recompra: null, top: true, top_atual: true, entrou_no_top: false, ...p,
});

const EQUIPE = [
  { user_id: 'u-ana', nome: 'Ana' },
  { user_id: 'u-bia', nome: 'Bia' },
];

function abrir(d: DecisaoRow | undefined, item = itemRX(), taxa: number | null = 0.18) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ReposicaoEmpresaProvider value={{ empresa: 'OBEN', setEmpresa: () => {} }}>
        <DecisaoSheet empresa="oben" item={item} decisao={d} onClose={onClose} taxa={taxa} equipe={EQUIPE} />
      </ReposicaoEmpresaProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

const salvarExec = () => screen.getByRole('button', { name: 'Salvar execução' }) as HTMLButtonElement;
const argsDe = (nome: string) => rpc.mock.calls.filter((c) => c[0] === nome).map((c) => c[1]);
const liquidar = decisao(1, { destino: 'liquidar', decidido_por: 'u-ana', decidido_em: '2026-10-30T00:00:00Z' });

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(() => Promise.resolve({ data: {}, error: null }));
  toast.error.mockReset();
  toast.success.mockReset();
  track.mockReset();
});

describe('DecisaoSheet — execução', () => {
  it('sem decisão gravada ou destino sem execução: a seção não aparece', () => {
    abrir(undefined);
    expect(screen.queryByRole('region', { name: 'Execução' })).toBeNull();
  });

  it('estratégico não tem execução', () => {
    abrir(decisao(1, { destino: 'estrategico' }));
    expect(screen.queryByRole('button', { name: 'Salvar execução' })).toBeNull();
  });

  it('plano novo: padrões (quem decidiu, hoje + 14) salváveis sem toque; manda o estado completo', async () => {
    const { onClose } = abrir(liquidar);
    expect(salvarExec().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/Preço piso/), { target: { value: '7,5' } });
    fireEvent.change(screen.getByLabelText('Canal'), { target: { value: 'outlet_queima' } });
    fireEvent.click(salvarExec());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_planejar')).toEqual([{
      p_empresa: 'oben', p_sku: 1, p_preco_piso: 7.5, p_canal: 'outlet_queima', p_responsavel: 'u-ana',
      p_prazo: '2026-11-15', p_concluido: false, p_atualizado_em: '2026-10-14T00:00:00Z',
    }]);
    expect(argsDe('raio_x_decidir')).toEqual([]);
    expect(track).toHaveBeenCalledWith('raio_x.plano', expect.objectContaining({ empresa: 'oben', tem_piso: true, canal: 'outlet_queima' }));
  });

  it('piso: mostra a unidade de venda e as referências; inválido não envia', () => {
    abrir(liquidar);
    expect(screen.getByLabelText('Preço piso (R$ por UN)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Preço piso/), { target: { value: '7.5' } });
    fireEvent.click(salvarExec());
    expect(screen.getByText(/número inválido/)).toBeTruthy();
    expect(argsDe('raio_x_planejar')).toEqual([]);
  });

  it('venda dirigida: sem piso nem canal; piso gravado de um liquidar antigo nunca é reenviado', async () => {
    const { onClose } = abrir(decisao(1, {
      destino: 'venda_dirigida', preco_piso: 3, canal_liquidacao: 'outro', responsavel: 'u-bia', prazo: '2026-11-20',
    }));
    expect(screen.queryByLabelText(/Preço piso/)).toBeNull();
    expect(salvarExec().disabled).toBe(true); // plano já gravado: exige toque
    fireEvent.click(screen.getByLabelText('executado'));
    fireEvent.click(salvarExec());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_planejar')).toEqual([{
      p_empresa: 'oben', p_sku: 1, p_preco_piso: null, p_canal: null, p_responsavel: 'u-bia',
      p_prazo: '2026-11-20', p_concluido: true, p_atualizado_em: '2026-10-14T00:00:00Z',
    }]);
  });

  it('plano existente: responsável/prazo apagados de propósito NÃO voltam ao padrão ao editar o piso', async () => {
    const { onClose } = abrir(decisao(1, { destino: 'liquidar', decidido_por: 'u-ana', preco_piso: 5 }));
    expect((screen.getByLabelText('Responsável') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Prazo') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText(/Preço piso/), { target: { value: '6' } });
    fireEvent.click(salvarExec());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_planejar')[0]).toEqual(expect.objectContaining({ p_preco_piso: 6, p_responsavel: null, p_prazo: null }));
  });

  it('rascunho cruzado: mexer na decisão trava "Salvar execução" e vice-versa (fechar descartaria o outro)', () => {
    abrir(liquidar);
    fireEvent.change(screen.getByLabelText('Observação'), { target: { value: 'cliente Fulano' } });
    expect(salvarExec().disabled).toBe(true);
    expect(screen.getByText(/salve a decisão antes da execução/)).toBeTruthy();
  });

  it('rascunho na execução trava "Salvar decisão"', () => {
    abrir(liquidar);
    fireEvent.change(screen.getByLabelText('Canal'), { target: { value: 'outro' } });
    expect((screen.getByRole('button', { name: 'Salvar decisão' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/salve a execução antes da decisão/)).toBeTruthy();
  });

  it('RX003 (outro operador gravou no meio) vira mensagem própria', async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { code: 'RX003', message: 'raio_x: decisao mudou' } }));
    abrir(liquidar);
    fireEvent.click(salvarExec());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Outra pessoa mudou esta decisão — recarregue antes de salvar a execução'));
  });

  it('executado antes de re-decidir (destino mudou) nasce desmarcado', () => {
    abrir(decisao(1, {
      destino: 'trocar', responsavel: 'u-bia', prazo: '2026-11-20',
      decidido_em: '2026-11-01T00:00:00Z', concluido_em: '2026-10-20T00:00:00Z',
    }));
    expect((screen.getByLabelText('executado') as HTMLInputElement).checked).toBe(false);
  });

  it('RX002 (decisão desfeita) vira mensagem própria', async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { code: 'RX002', message: 'raio_x: sem decisao' } }));
    abrir(liquidar);
    fireEvent.click(salvarExec());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Esta decisão foi desfeita — grave o destino antes do plano'));
  });

  it('custo de esperar no cabeçalho; sem taxa não exibe número (nunca R$ 0)', () => {
    abrir(liquidar);
    expect(screen.getByText(/custa ~R\$\s?90\/mês parado/)).toBeTruthy();
  });

  it('sem taxa: sem custo de esperar', () => {
    abrir(liquidar, itemRX(), null);
    expect(screen.queryByText(/mês parado/)).toBeNull();
  });
});
