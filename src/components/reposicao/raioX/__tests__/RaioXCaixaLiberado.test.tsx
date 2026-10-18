/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { LinhaMedicao } from '@/lib/reposicao/raio-x/tipos';
import { placar } from '@/lib/reposicao/raio-x/placar';
import { RaioXPlacar } from '../RaioXPlacar';
import { RaioXCaixaLiberado } from '../RaioXCaixaLiberado';

function linha(sku: number, extra: Partial<LinhaMedicao> = {}): LinhaMedicao {
  return {
    sku_codigo_omie: sku, destino: 'trocar', decidido_em: '2026-09-01T12:00:00Z',
    foto_saldo: 10, foto_cmc: 100, foto_valor: 1000, foto_categoria: 'mercadoria', credito_troca: null,
    saldo_atual: 10, qtd_vendida: 0, receita: 0, preco_medio_12m: 50, compras_apos: [], ...extra,
  };
}
const codigos = new Map([[1, 'A1'], [2, 'A2'], [3, 'A3']]);

describe('RaioXCaixaLiberado', () => {
  it('(a) Oben: vendido/liquidado/trocado, barra contra R$ 60.000 e contradição clicável filtra pelo SKU', () => {
    const linhas = [
      linha(1, { destino: 'venda_dirigida', saldo_atual: 5, qtd_vendida: 5, receita: 250, preco_medio_12m: 50 }), // vendido 500
      linha(2, { destino: 'liquidar', foto_cmc: 60, saldo_atual: 5, qtd_vendida: 5, receita: 100, preco_medio_12m: 50, compras_apos: ['2026-09-10T12:00:00Z'] }), // liquidado 300 (5 x 60) + contradição
      linha(3, { destino: 'trocar', credito_troca: 300 }),
    ];
    const onFiltrarSku = vi.fn();
    render(<RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="oben" codigos={codigos} onFiltrarSku={onFiltrarSku} />);
    const valorDe = (rotulo: RegExp) => screen.getByText(rotulo).closest('div')!.textContent ?? '';
    const reais = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(n);
    expect(valorDe(/^Vendido$/)).toContain(reais(500));
    expect(valorDe(/^Liquidado/)).toContain(reais(300));
    expect(valorDe(/^Trocado/)).toContain(reais(300));
    expect(screen.getByText(/de R\$ 60\.000/).parentElement!.textContent).toContain(reais(1100));
    expect(screen.getByText(/de R\$ 60\.000/)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('60000');
    fireEvent.click(screen.getByRole('button', { name: /A2/ }));
    expect(onFiltrarSku).toHaveBeenCalledWith(2);
  });

  it('(b) Colacor: "saiu do estoque (sem NF para atribuir" e nunca a palavra "vendido"', () => {
    const linhas = [linha(1, { destino: 'trocar', credito_troca: 300, saldo_atual: 4, qtd_vendida: null, receita: null, preco_medio_12m: null, compras_apos: null })];
    const { container } = render(<RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="colacor" codigos={codigos} onFiltrarSku={vi.fn()} />);
    expect(screen.getByText(/saiu do estoque \(sem NF para atribuir/i)).toBeTruthy();
    expect(screen.getByText(/Trocado/)).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain('vendido');
  });

  it('(c) caixa liberado e "distorce o DIO" ficam em blocos distintos, sem soma', () => {
    const linhas = [linha(3, { destino: 'trocar', credito_troca: 300 })];
    const p = placar([], new Map());
    p.distorceDio = 7000;
    render(
      <>
        <RaioXPlacar placar={p} />
        <RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="oben" codigos={codigos} onFiltrarSku={vi.fn()} />
      </>,
    );
    const caixa = screen.getByRole('region', { name: 'Caixa liberado' });
    const placarEl = screen.getByRole('region', { name: 'Placar do Raio-X' });
    expect(caixa.contains(placarEl)).toBe(false);
    expect(within(caixa).queryByText(/distorce o DIO/)).toBeNull();
    expect(within(placarEl).getByText(/distorce o DIO/)).toBeTruthy();
    expect(within(caixa).getAllByText(/R\$\s*300/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/R\$\s*7\.300/)).toBeNull();
  });

  it('erro honesto: falha na RPC mostra mensagem, nunca card zerado', () => {
    render(<RaioXCaixaLiberado linhas={undefined} isLoading={false} erro={new Error('boom')} empresa="oben" codigos={codigos} onFiltrarSku={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Não foi possível medir/);
    expect(screen.queryByText(/R\$\s*0/)).toBeNull();
  });

  it('ausente ≠ zero: sem permissão de compras, recomprado vira "—"', () => {
    const linhas = [linha(1, { destino: 'venda_dirigida', saldo_atual: 5, qtd_vendida: 5, receita: 250, compras_apos: null })];
    render(<RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="oben" codigos={codigos} onFiltrarSku={vi.fn()} />);
    const linhaRecomprado = screen.getByText(/^Recomprado/).closest('div')!;
    expect(linhaRecomprado.textContent).toContain('—');
  });
});
