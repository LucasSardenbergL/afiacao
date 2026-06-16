import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CondicaoPagamentoPanel } from '../CondicaoPagamentoPanel';
import type { PedidoSugerido, CondicaoPagamento } from '../types';

const condicoes: CondicaoPagamento[] = [
  { codigo: '000', descricao: 'À vista', num_parcelas: 1, dias_parcelas: '0' },
  { codigo: '030', descricao: '30 dias', num_parcelas: 1, dias_parcelas: '30' },
];

function ped(partial: Partial<PedidoSugerido>): PedidoSugerido {
  return partial as unknown as PedidoSugerido;
}

function setup(overrides: Partial<React.ComponentProps<typeof CondicaoPagamentoPanel>> = {}) {
  const props: React.ComponentProps<typeof CondicaoPagamentoPanel> = {
    pedido: ped({ status: 'pendente_aprovacao', condicao_origem: null, condicao_pagamento_codigo: null, condicao_pagamento_descricao: null }),
    podeEditarCondicao: true,
    condicaoCodigo: '',
    onCondicaoChange: vi.fn(),
    condicoes,
    condicaoSelecionada: null,
    condicaoMudou: false,
    salvarCondicaoPending: false,
    onSalvarCondicao: vi.fn(),
    ...overrides,
  };
  render(<CondicaoPagamentoPanel {...props} />);
  return props;
}

describe('CondicaoPagamentoPanel', () => {
  it('em modo editável sem condição: mostra o aviso de disparo', () => {
    setup();
    expect(screen.getByText(/Sem condição selecionada o disparo ao Omie falhará/)).toBeTruthy();
  });

  it('em modo não editável: mostra a condição definida ou "não definida"', () => {
    setup({
      podeEditarCondicao: false,
      pedido: ped({ status: 'disparado', condicao_pagamento_codigo: null, condicao_pagamento_descricao: null }),
    });
    expect(screen.getByText('não definida')).toBeTruthy();
  });

  it('mostra o botão Salvar quando aprovado, condição mudou e selecionada; dispara onSalvarCondicao', () => {
    const props = setup({
      pedido: ped({ status: 'aprovado_aguardando_disparo', condicao_origem: null }),
      condicaoCodigo: '030',
      condicaoSelecionada: condicoes[1],
      condicaoMudou: true,
    });
    const btn = screen.getByRole('button', { name: /Salvar/ });
    fireEvent.click(btn);
    expect(props.onSalvarCondicao).toHaveBeenCalledTimes(1);
  });

  it('mostra a origem como badge quando presente', () => {
    setup({ pedido: ped({ status: 'pendente_aprovacao', condicao_origem: 'ia_sugerida' }) });
    expect(screen.getByText(/origem: ia_sugerida/)).toBeTruthy();
  });
});
