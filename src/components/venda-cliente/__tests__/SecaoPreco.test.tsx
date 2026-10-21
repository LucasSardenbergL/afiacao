import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { SugestaoItem } from '@/lib/venda-cliente/sugestoes';
import type { PrecoAlvo } from '@/lib/venda-cliente/preco';
import type { TopProduto } from '@/lib/venda-cliente/historico';
import { SecaoPreco } from '../SecaoPreco';

function item(id: string, codigo: number, descricao: string): SugestaoItem {
  return {
    id, tipo: 'preco', empresa: 'oben', omieCodigoProduto: codigo, descricao, familia: null,
    qtdRef: null, valorRef: null, precoAlvo: 99, cadenciaDias: null,
  };
}

const itens = [item('p1', 10, 'Verniz PU'), item('p2', 20, 'Thinner 5L')];
const alvo = (codigo: number, faixa: PrecoAlvo['faixaMargem'], ultimo: number | null = 200): PrecoAlvo => ({
  empresa: 'oben', omieCodigoProduto: codigo, ultimoPreco: ultimo, precoAlvo: 230, faixaMargem: faixa, validoAte: '2026-12-31',
});
const produtos: TopProduto[] = [
  { codigo: 20, nome: 'Thinner 5L', vezes: 3, ultimoPreco: 88.9, ultimaData: '2026-09-01' },
];

function linha(nome: string) {
  return screen.getByText(nome).closest('li') as HTMLElement;
}

describe('SecaoPreco', () => {
  it('onda_preco=false → não renderiza', () => {
    const { container } = render(
      <SecaoPreco ondaLigada={false} itens={itens} alvos={[alvo(10, 'verde')]} loading={false} erro={false} produtos={produtos} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('SKU com repasse vigente: último preço, preço alvo, faixa e validade', () => {
    render(<SecaoPreco ondaLigada itens={itens} alvos={[alvo(10, 'verde')]} loading={false} erro={false} produtos={produtos} />);
    const l = linha('Verniz PU');
    expect(within(l).getByText(/último R\$\s*200,00/)).toBeInTheDocument();
    expect(within(l).getByText(/alvo R\$\s*230,00/)).toBeInTheDocument();
    expect(within(l).getByText('Margem saudável')).toBeInTheDocument();
    expect(within(l).getByText(/válido até 31\/12\/2026/)).toBeInTheDocument();
  });

  it('SKU sem repasse (revogado/vencido/alcançado desde a geração) → mostra só o último preço', () => {
    render(<SecaoPreco ondaLigada itens={itens} alvos={[alvo(10, 'verde')]} loading={false} erro={false} produtos={produtos} />);
    const l = linha('Thinner 5L');
    expect(within(l).getByText(/último R\$\s*88,90/)).toBeInTheDocument();
    expect(within(l).queryByText(/alvo/)).toBeNull();
    expect(within(l).queryByText(/Margem/)).toBeNull();
    expect(within(l).queryByText(/válido até/)).toBeNull();
  });

  it('leitura do alvo falhou → só último preço, com aviso (nunca um alvo que não leu)', () => {
    render(<SecaoPreco ondaLigada itens={itens} alvos={null} loading={false} erro produtos={produtos} />);
    expect(screen.queryByText(/alvo R\$/)).toBeNull();
    expect(screen.getByText(/Não consegui confirmar o preço aprovado/)).toBeInTheDocument();
    // sem histórico para o SKU 10: "—", nunca R$ 0,00
    expect(within(linha('Verniz PU')).getByText('último —')).toBeInTheDocument();
    expect(screen.queryByText(/R\$\s*0,00/)).toBeNull();
  });

  it('nunca renderiza as palavras "custo" nem "markup" (nem piso), em nenhuma faixa', () => {
    for (const faixa of ['verde', 'amarelo', 'vermelho', 'neutro'] as const) {
      const { unmount } = render(
        <SecaoPreco ondaLigada itens={itens} alvos={[alvo(10, faixa), alvo(20, faixa, null)]} loading={false} erro={false} produtos={produtos} />,
      );
      const texto = (document.body.textContent ?? '') + Array.from(document.querySelectorAll('[title]')).map((e) => e.getAttribute('title')).join(' ');
      expect(texto, faixa).not.toMatch(/custo|markup|piso|cmc/i);
      unmount();
    }
  });
});
