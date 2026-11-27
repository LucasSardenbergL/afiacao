// PR 3.1 do Novo Pedido ("IA honesta"): o anúncio e o sensor contam o que ENTROU, não o que foi
// pedido. Antes, `confirmItems` dizia "N item(ns) adicionado(s)" com N = itens da análise.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/invoke-function', () => ({ invokeFunction: invokeMock }));

import { useUnifiedAIAssistant } from '../useUnifiedAIAssistant';
import type { RelatorioAdicaoIA, UnifiedAIAssistantProps } from '../types';

const RESPOSTA = {
  products: [
    { product_id: 'p1', codigo: 'C1', descricao: 'Disco', quantity: 2, quantidade_inferida: false, account: 'oben' },
    { product_id: 'p2', codigo: 'C2', descricao: 'Lixa', quantity: 1, quantidade_inferida: true, account: 'oben' },
  ],
  services: [],
  suggestions: [],
  descartados: [{ descricao: 'Afiar serra', motivo: 'a ferramenta não está no cadastro deste cliente' }],
  message: 'ok',
};

function montar(relatorio: RelatorioAdicaoIA) {
  const aoSensor = vi.fn();
  const onItemsIdentified = vi.fn(() => relatorio);
  const props: UnifiedAIAssistantProps = {
    products: [], userTools: [], onItemsIdentified, hasCustomerSelected: true,
    precoNascimentoPorId: () => 10, aoSensor,
  };
  const { result } = renderHook(() => useUnifiedAIAssistant(props));
  return { result, aoSensor, onItemsIdentified };
}

async function analisar(result: ReturnType<typeof montar>['result']) {
  act(() => result.current.setText('2 discos e uma lixa'));
  await act(async () => { await result.current.analyze(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockResolvedValue(RESPOSTA);
});

describe('useUnifiedAIAssistant — anúncio honesto', () => {
  it('guarda os descartados da edge para o painel', async () => {
    const { result } = montar({ itens: [], tintas: [] });
    await analisar(result);
    expect(result.current.descartadosIA).toEqual(RESPOSTA.descartados);
  });

  it('1 entrou e 1 não: o sensor conta 1 (não 2) e o toast é de ressalva', async () => {
    const { result, aoSensor } = montar({
      itens: [
        { tipo: 'produto', descricao: 'Disco', desfecho: 'adicionado', quantidade: 2, quantidadeInferida: false },
        { tipo: 'produto', descricao: 'Lixa', desfecho: 'descartado', quantidade: 1, quantidadeInferida: true, motivo: 'fora do catálogo' },
      ],
      tintas: [],
    });
    await analisar(result);
    act(() => result.current.confirmItems());
    expect(aoSensor).toHaveBeenCalledWith('novo_pedido.ia_itens_adicionados', expect.objectContaining({ n: 1, nao_entraram: 1 }));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledWith('Itens adicionados com ressalvas', { description: '1 adicionado(s) · 1 não entrou(aram)' });
    // Saída que recomeça: a análise velha sai, o resultado por item fica.
    expect(result.current.identifiedProducts).toEqual([]);
    expect(result.current.relatorio?.itens).toHaveLength(2);
  });

  it('nada entrou: toast de erro e os itens FICAM no painel para tentar de novo', async () => {
    const { result } = montar({
      itens: [{ tipo: 'produto', descricao: 'Disco', desfecho: 'descartado', quantidade: 2, quantidadeInferida: false, motivo: 'o pedido está sendo enviado' }],
      tintas: [],
    });
    await analisar(result);
    act(() => result.current.confirmItems());
    expect(toastMock.error).toHaveBeenCalledWith('Nenhum item entrou no pedido', expect.anything());
    expect(result.current.identifiedProducts).toHaveLength(2);
  });

  it('tudo entrou com quantidade dita: toast de sucesso', async () => {
    const { result } = montar({
      itens: [{ tipo: 'produto', descricao: 'Disco', desfecho: 'adicionado', quantidade: 2, quantidadeInferida: false }],
      tintas: [],
    });
    await analisar(result);
    act(() => result.current.confirmItems());
    expect(toastMock.success).toHaveBeenCalledWith('Itens adicionados!', { description: '1 adicionado(s)' });
  });
});
