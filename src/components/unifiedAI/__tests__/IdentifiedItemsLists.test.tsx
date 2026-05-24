import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IdentifiedProductsList, IdentifiedServicesList } from '../IdentifiedItemsLists';
import { type AIProduct, type AIService, type Product, type UserTool } from '../types';

const catalog: Product[] = [
  { id: 'p1', codigo: 'C1', descricao: 'Disco de corte 7"', valor_unitario: 25, estoque: 10, account: 'oben' },
];

describe('IdentifiedProductsList', () => {
  it('mostra contagem, descrição (do catálogo), quantidade e badge de conta', () => {
    const items: AIProduct[] = [
      { product_id: 'p1', codigo: 'C1', descricao: 'fallback', quantity: 3, account: 'oben' },
    ];
    render(<IdentifiedProductsList items={items} catalog={catalog} onRemove={() => {}} />);
    expect(screen.getByText('Produtos (1)')).toBeTruthy();
    expect(screen.getByText('Disco de corte 7"')).toBeTruthy();
    expect(screen.getByText('Qtd: 3')).toBeTruthy();
    expect(screen.getByText('Oben')).toBeTruthy();
  });

  it('usa descricao do item quando não há match no catálogo e mostra Colacor', () => {
    const items: AIProduct[] = [
      { product_id: 'x', codigo: 'CX', descricao: 'Item avulso', quantity: 1, account: 'colacor' },
    ];
    render(<IdentifiedProductsList items={items} catalog={catalog} onRemove={() => {}} />);
    expect(screen.getByText('Item avulso')).toBeTruthy();
    expect(screen.getByText('Colacor')).toBeTruthy();
  });

  it('dispara onRemove com o índice', () => {
    const onRemove = vi.fn();
    const items: AIProduct[] = [
      { product_id: 'p1', codigo: 'C1', descricao: 'd', quantity: 1, account: 'oben' },
    ];
    render(<IdentifiedProductsList items={items} catalog={catalog} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});

describe('IdentifiedServicesList', () => {
  const userTools: UserTool[] = [
    { id: 'ut1', tool_category_id: 'c1', generated_name: 'Serra circular', custom_name: null, quantity: null, tool_categories: null },
  ];

  it('mostra nome da ferramenta, descrição do serviço e quantidade', () => {
    const items: AIService[] = [
      { userToolId: 'ut1', omie_codigo_servico: 99, servico_descricao: 'Afiação', quantity: 2 },
    ];
    render(<IdentifiedServicesList items={items} userTools={userTools} />);
    expect(screen.getByText('Serviços de Afiação (1)')).toBeTruthy();
    expect(screen.getByText('Serra circular')).toBeTruthy();
    expect(screen.getByText('Serviço: Afiação')).toBeTruthy();
    expect(screen.getByText('Qtd: 2')).toBeTruthy();
  });

  it('usa fallback Ferramenta quando não acha o userTool', () => {
    const items: AIService[] = [
      { userToolId: 'zzz', omie_codigo_servico: 1, servico_descricao: 'X', quantity: 1 },
    ];
    render(<IdentifiedServicesList items={items} userTools={userTools} />);
    expect(screen.getByText('Ferramenta')).toBeTruthy();
  });
});
