import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IdentifiedProductsList, IdentifiedServicesList } from '../IdentifiedItemsLists';
import { type AIProduct, type AIService, type Product, type UserTool } from '../types';
import { fmt } from '../helpers';

// O `fmt` (toLocaleString pt-BR) põe um espaço NÃO-SEPARÁVEL depois de "R$", e o getByText compara com o
// texto NORMALIZADO (espaços em sequência, NBSP incluso, viram 1 espaço). Comparar com o `fmt` cru nunca
// casa — e aí todo `queryByText(...).toBeNull()` passaria por CEGUEIRA. Normaliza do mesmo jeito.
const txt = (v: number) => `${fmt(v)}/un`.replace(/\s+/g, ' ');

const catalog: Product[] = [
  { id: 'p1', codigo: 'C1', descricao: 'Disco de corte 7"', valor_unitario: 25, estoque: 10, account: 'oben' },
];

// O preço de NASCIMENTO (getProductPrice) difere de propósito da tabela (25): é o que discrimina
// "exibe o preço que o carrinho grava" de "exibe a tabela do catálogo".
const precoNascimentoPorId = (id: string): number | null => (id === 'p1' ? 18.5 : null);

describe('IdentifiedProductsList', () => {
  it('mostra contagem, descrição (do catálogo), quantidade e badge de conta', () => {
    const items: AIProduct[] = [
      { product_id: 'p1', codigo: 'C1', descricao: 'fallback', quantity: 3, account: 'oben' },
    ];
    render(<IdentifiedProductsList items={items} catalog={catalog} onRemove={() => {}} precoNascimentoPorId={precoNascimentoPorId} />);
    expect(screen.getByText('Produtos (1)')).toBeTruthy();
    expect(screen.getByText('Disco de corte 7"')).toBeTruthy();
    expect(screen.getByText('Qtd: 3')).toBeTruthy();
    expect(screen.getByText('Oben')).toBeTruthy();
  });

  it('usa descricao do item quando não há match no catálogo e mostra Colacor', () => {
    const items: AIProduct[] = [
      { product_id: 'x', codigo: 'CX', descricao: 'Item avulso', quantity: 1, account: 'colacor' },
    ];
    render(<IdentifiedProductsList items={items} catalog={catalog} onRemove={() => {}} precoNascimentoPorId={precoNascimentoPorId} />);
    expect(screen.getByText('Item avulso')).toBeTruthy();
    expect(screen.getByText('Colacor')).toBeTruthy();
  });

  it('dispara onRemove com o índice', () => {
    const onRemove = vi.fn();
    const items: AIProduct[] = [
      { product_id: 'p1', codigo: 'C1', descricao: 'd', quantity: 1, account: 'oben' },
    ];
    render(<IdentifiedProductsList items={items} catalog={catalog} onRemove={onRemove} precoNascimentoPorId={precoNascimentoPorId} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  // ── preço: a IA não precifica — o painel mostra o preço com que o item VAI NASCER no carrinho ──
  const p1: AIProduct[] = [{ product_id: 'p1', codigo: 'C1', descricao: 'd', quantity: 1, account: 'oben' }];

  it('exibe o preço de NASCIMENTO (getProductPrice) — não a tabela do catálogo nem o selo "Preço cliente"', () => {
    render(<IdentifiedProductsList items={p1} catalog={catalog} onRemove={() => {}} precoNascimentoPorId={precoNascimentoPorId} />);
    expect(screen.getByText(txt(18.5))).toBeTruthy();
    expect(screen.queryByText(txt(25))).toBeNull();
    expect(screen.queryByText('Preço cliente')).toBeNull();
  });

  it('um unit_price vindo da IA (edge VELHA ainda deployada) NÃO é exibido: o número é o de nascimento', () => {
    const daEdgeVelha = [{ ...p1[0], unit_price: 999 }] as unknown as AIProduct[];
    render(<IdentifiedProductsList items={daEdgeVelha} catalog={catalog} onRemove={() => {}} precoNascimentoPorId={precoNascimentoPorId} />);
    expect(screen.queryByText(txt(999))).toBeNull();
    expect(screen.getByText(txt(18.5))).toBeTruthy();
  });

  it('preço de partida não firme (precoLoading): NÃO exibe número algum', () => {
    render(<IdentifiedProductsList items={p1} catalog={catalog} onRemove={() => {}} precoNascimentoPorId={precoNascimentoPorId} precoLoading />);
    expect(screen.getByText('calculando preço…')).toBeTruthy();
    expect(screen.queryByText(/\/un/)).toBeNull();
  });

  it('fora do catálogo carregado (null): NÃO exibe número — nem a tabela, nem 0', () => {
    const fora: AIProduct[] = [{ product_id: 'x', codigo: 'CX', descricao: 'Avulso', quantity: 1, account: 'colacor' }];
    render(<IdentifiedProductsList items={fora} catalog={catalog} onRemove={() => {}} precoNascimentoPorId={precoNascimentoPorId} />);
    expect(screen.queryByText(/\/un/)).toBeNull();
  });

  it('preço de nascimento 0 é EXIBIDO como 0 (o painel mostra o que o carrinho grava; quem barra ≤0 é o submit)', () => {
    render(<IdentifiedProductsList items={p1} catalog={catalog} onRemove={() => {}} precoNascimentoPorId={() => 0} />);
    expect(screen.getByText(txt(0))).toBeTruthy();
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
