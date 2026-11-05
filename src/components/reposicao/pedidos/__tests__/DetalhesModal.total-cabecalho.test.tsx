// C6 do plano v6 (TOTAL-EDITADO): o "Valor total" do cabeçalho do pedido de reposição
// voltava ao total ANTIGO quando o editado era zero — `formatBRL(totalAtual || valor_total)`
// trata 0 como ausente. Zero editado é valor legítimo; ausente de verdade é só quando os
// itens ainda não chegaram (ou falharam), e aí o cabeçalho mostra o total GRAVADO.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PedidoSugerido } from '../types';

const estadoHook: { itensEstado: 'carregando' | 'erro' | 'ok'; totalAtual: number } = {
  itensEstado: 'ok',
  totalAtual: 0,
};

vi.mock('../useDetalhesModal', () => ({
  useDetalhesModal: () => {
    const mutacao = { isPending: false, mutate: vi.fn() };
    return {
      condicoes: [],
      isLoading: estadoHook.itensEstado === 'carregando',
      itensEstado: estadoHook.itensEstado,
      refetchItens: vi.fn(),
      motivoBloqueioAprov: null,
      edits: {},
      onEditQty: vi.fn(),
      onBlurQty: vi.fn(),
      precoEdits: {},
      onEditPreco: vi.fn(),
      obs: '',
      setObs: vi.fn(),
      condicaoCodigo: null,
      setCondicaoCodigo: vi.fn(),
      removerItem: null,
      setRemoverItem: vi.fn(),
      descontinuarItem: null,
      setDescontinuarItem: vi.fn(),
      linhas: [],
      totalAtual: estadoHook.totalAtual,
      condicaoSelecionada: null,
      condicaoMudou: false,
      salvarMutation: mutacao,
      salvarCondicaoMutation: mutacao,
      aprovarMutation: mutacao,
      removerItemMutation: mutacao,
      descontinuarMutation: mutacao,
      podeEditar: true,
      podeEditarCondicao: false,
      podeEditarPreco: false,
      selecionados: new Set<number>(),
      toggleSelecionado: vi.fn(),
      toggleTodos: vi.fn(),
      linhasSelecionadas: [],
      confirmarRemocaoLote: false,
      setConfirmarRemocaoLote: vi.fn(),
      removerLoteMutation: mutacao,
    };
  },
}));

// Painéis filhos não entram na asserção (cada um tem teste próprio) e trariam supabase/queries.
vi.mock('../PortalStatusPanel', () => ({ PortalStatusPanel: () => null }));
vi.mock('../HistoricoAcoesPanel', () => ({ HistoricoAcoesPanel: () => null }));
vi.mock('../CondicaoPagamentoPanel', () => ({ CondicaoPagamentoPanel: () => null }));
vi.mock('../ItensTable', () => ({ ItensTable: () => null }));
vi.mock('../EmbalagemPanel', () => ({ EmbalagemPanel: () => null }));
vi.mock('../ConfirmacaoDialogs', () => ({
  RemoverItemDialog: () => null,
  DescontinuarItemDialog: () => null,
  RemoverItensLoteDialog: () => null,
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { DetalhesModal } from '../DetalhesModal';

const pedido = {
  id: 42,
  fornecedor_nome: 'Sayerlack',
  status: 'pendente_aprovacao',
  empresa: 'OBEN',
  grupo_codigo: null,
  num_skus: 3,
  valor_total: 1234.5,
  horario_corte_planejado: null,
} as unknown as PedidoSugerido;

// Intl pt-BR usa espaço não-separável entre "R$" e o número; normaliza para casar ASCII.
function valorCabecalho(): string {
  return (screen.getByTestId('valor-total-cabecalho').textContent ?? '').replace(/\s/g, ' ');
}

function renderizar() {
  render(<DetalhesModal pedido={pedido} open onOpenChange={vi.fn()} onApproved={vi.fn()} />);
}

describe('DetalhesModal — Valor total do cabeçalho (C6)', () => {
  beforeEach(() => {
    estadoHook.itensEstado = 'ok';
    estadoHook.totalAtual = 0;
  });

  it('editado zero (todas as quantidades zeradas) mostra R$ 0,00, não o total antigo', () => {
    estadoHook.totalAtual = 0;
    renderizar();
    expect(valorCabecalho()).toBe('R$ 0,00');
  });

  it('editado diferente do gravado mostra o recalculado', () => {
    estadoHook.totalAtual = 99.9;
    renderizar();
    expect(valorCabecalho()).toBe('R$ 99,90');
  });

  it('itens ainda carregando: mostra o total gravado (o recalculado não existe ainda)', () => {
    estadoHook.itensEstado = 'carregando';
    renderizar();
    expect(valorCabecalho()).toBe('R$ 1.234,50');
  });

  it('itens falharam: mostra o total gravado, não um zero fabricado', () => {
    estadoHook.itensEstado = 'erro';
    renderizar();
    expect(valorCabecalho()).toBe('R$ 1.234,50');
  });
});
