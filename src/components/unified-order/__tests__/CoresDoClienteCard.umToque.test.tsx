// Fase 2A — "Cores do cliente" em 1 toque. Trava: o botão de 1 toque SÓ aparece com
// preço pronto; "calculando" e "sem atalho" mostram o caminho de sempre (o diálogo).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CoresDoClienteCard } from '../CoresDoClienteCard';
import { chaveUmToque, type UmToquePronto } from '@/hooks/unifiedOrder/useCoresDoClienteUmToque';
import type { CorDoCliente } from '@/lib/tint/cores-do-cliente';
import type { Product } from '@/hooks/useUnifiedOrder';

const oc = (pv: string) => ({
  data: '2026-09-01T10:00:00Z', baseDescricao: 'WFOB.7666 BASE BRANCA GL', quantidade: 2, pv, account: 'oben', omieCodigoProduto: 9001,
});
const cor: CorDoCliente = { nome: '346J - PLATINA BIANCO', ocorrencias: [oc('101'), oc('102'), oc('103')] };
const product = { id: 'p1', descricao: 'WFOB.7666 BASE BRANCA GL' } as Product;
const pronto: UmToquePronto = {
  formulaId: 'f1', corId: '346J', nomeCor: 'PLATINA BIANCO', preco: 150.1, fonte: 'tabela', custoCorantes: 3, product,
};

function renderCard() {
  const onRepetirCor = vi.fn();
  const onAdicionarUmToque = vi.fn();
  render(
    <CoresDoClienteCard
      cores={[cor]} coresFiltradas={[cor]} busca="" onBuscaChange={() => {}} isLoading={false}
      onRepetirCor={onRepetirCor}
      umToque={{ [chaveUmToque(cor.nome, 0)]: pronto, [chaveUmToque(cor.nome, 1)]: 'carregando' }}
      onAdicionarUmToque={onAdicionarUmToque}
    />,
  );
  return { onRepetirCor, onAdicionarUmToque };
}

describe('CoresDoClienteCard — 1 toque', () => {
  it('ocorrência com preço pronto: 1 toque adiciona com a fórmula e o preço do motor', () => {
    const { onAdicionarUmToque, onRepetirCor } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Adicionar 346J por R\$\s?150,10/ }));
    expect(onAdicionarUmToque).toHaveBeenCalledWith(pronto, cor.ocorrencias[0]);
    expect(onRepetirCor).not.toHaveBeenCalled();
  });

  it('"Ajustar" abre o diálogo completo da mesma ocorrência', () => {
    const { onRepetirCor } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Ajustar' }));
    expect(onRepetirCor).toHaveBeenCalledWith(cor, cor.ocorrencias[0]);
  });

  it('carregando e sem atalho: só "Pedir de novo" (diálogo), nenhum 1 toque a mais', () => {
    renderCard();
    expect(screen.getAllByRole('button', { name: /Adicionar 346J/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Pedir de novo/ })).toHaveLength(2);
    expect(screen.getByText('calculando…')).toBeInTheDocument();
  });
});
