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
  it('(a) Oben: parcelas separadas (estoque reduzido · receita · crédito), critério da meta e contradição clicável', () => {
    const linhas = [
      linha(1, { destino: 'venda_dirigida', saldo_atual: 5, qtd_vendida: 5, receita: 250, preco_medio_12m: 50 }), // vendido 500
      linha(2, { destino: 'liquidar', foto_cmc: 60, saldo_atual: 5, qtd_vendida: 5, receita: 100, preco_medio_12m: 50, compras_apos: ['2026-09-10T12:00:00Z'] }), // liquidado 300 (5 x 60) + contradição
      linha(3, { destino: 'trocar', credito_troca: 300 }),
    ];
    const onFiltrarSku = vi.fn();
    render(<RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="oben" codigos={codigos} onFiltrarSku={onFiltrarSku} />);
    const valorDe = (rotulo: RegExp) => screen.getByText(rotulo).closest('div')!.textContent ?? '';
    const reais = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(n);
    expect(valorDe(/^Vendido \(a custo\)$/)).toContain(reais(500));
    expect(valorDe(/^Liquidado/)).toContain(reais(300));
    const parcelas = screen.getByTestId('parcelas-liberado');
    const parcela = (rotulo: RegExp) => within(parcelas).getByText(rotulo).closest('div')!.textContent ?? '';
    expect(parcela(/^Estoque reduzido \(a custo\)/)).toContain(reais(800));
    expect(parcela(/^Receita das vendas/)).toContain(reais(350)); // 5 × 50 + 5 × 20
    expect(parcela(/^Crédito de troca informado/)).toContain(reais(300));
    // critério da meta INALTERADO (estoque reduzido + crédito), rotulado como critério — nunca "caixa"
    expect(screen.getByText(/no critério da meta/).parentElement!.textContent).toContain(reais(1100));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('60000');
    expect(screen.queryByText(/caixa liberado/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /A2/ }));
    expect(onFiltrarSku).toHaveBeenCalledWith(2);
  });

  it('(b) Colacor: "saiu do estoque (sem NF para atribuir" e nunca a palavra "vendido"', () => {
    const linhas = [linha(1, { destino: 'trocar', credito_troca: 300, saldo_atual: 4, qtd_vendida: null, receita: null, preco_medio_12m: null, compras_apos: null })];
    const { container } = render(<RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="colacor" codigos={codigos} onFiltrarSku={vi.fn()} />);
    expect(screen.getByText(/saiu do estoque \(sem NF para atribuir/i)).toBeTruthy();
    expect(screen.getByText(/Crédito de troca informado/)).toBeTruthy();
    // sem NF: estoque reduzido e receita ausentes ("—"), nunca R$ 0
    const parcelas = screen.getByTestId('parcelas-liberado');
    expect(within(parcelas).getByText(/^Estoque reduzido/).closest('div')!.textContent).toContain('—');
    expect(within(parcelas).getByText(/^Receita das vendas/).closest('div')!.textContent).toContain('—');
    expect(container.textContent?.toLowerCase()).not.toContain('vendido');
  });

  it('(c) liberado e "distorce o DIO" ficam em blocos distintos, sem soma', () => {
    const linhas = [linha(3, { destino: 'trocar', credito_troca: 300 })];
    const p = placar([], new Map());
    p.distorceDio = 7000;
    render(
      <>
        <RaioXPlacar placar={p} />
        <RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="oben" codigos={codigos} onFiltrarSku={vi.fn()} />
      </>,
    );
    const caixa = screen.getByRole('region', { name: 'Liberado pelas decisões' });
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

  it('ausente ≠ zero: SKUs sem medição e sem custo não viram "R$ 0 na foto"', () => {
    const linhas = [
      linha(1, { saldo_atual: null, foto_valor: null }),
      linha(2, { saldo_atual: null, foto_valor: null }),
    ];
    render(<RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="oben" codigos={codigos} onFiltrarSku={vi.fn()} />);
    const aviso = screen.getByText(/sem medição/).textContent ?? '';
    expect(aviso).toContain('2 sem custo');
    expect(aviso).not.toContain('R$');
  });

  it('sem medição com custo mostra o R$ da foto e soma à parte os sem custo', () => {
    const linhas = [
      linha(1, { saldo_atual: null, foto_valor: 1000 }),
      linha(2, { saldo_atual: null, foto_valor: null }),
    ];
    render(<RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="oben" codigos={codigos} onFiltrarSku={vi.fn()} />);
    const aviso = screen.getByText(/sem medição/).textContent ?? '';
    expect(aviso).toMatch(/R\$\s*1\.000 na foto, mais 1 sem custo/);
  });

  it('ausente ≠ zero: sem permissão de compras, recomprado vira "—"', () => {
    const linhas = [linha(1, { destino: 'venda_dirigida', saldo_atual: 5, qtd_vendida: 5, receita: 250, compras_apos: null })];
    render(<RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="oben" codigos={codigos} onFiltrarSku={vi.fn()} />);
    const linhaRecomprado = screen.getByText(/^Recomprado/).closest('div')!;
    expect(linhaRecomprado.textContent).toContain('—');
  });
});

describe('pacote 2 — piso, custo de esperar e execução', () => {
  it('liquidou abaixo do piso: lista clicável só onde a comparação é honesta (uma unidade de venda)', async () => {
    const { decisao } = await import('@/lib/reposicao/raio-x/__tests__/fixtures');
    const linhas = [
      linha(1, { destino: 'liquidar', saldo_atual: 6, qtd_vendida: 4, receita: 32 }), // 8/un < piso 10
      linha(2, { destino: 'liquidar', saldo_atual: 6, qtd_vendida: 4, receita: 32 }), // duas unidades: sem comparação
      linha(3, { destino: 'liquidar', saldo_atual: 6, qtd_vendida: 4, receita: 48 }), // 12/un >= piso
    ];
    const decisoes = new Map([1, 2, 3].map((s) => [s, decisao(s, { destino: 'liquidar', preco_piso: 10 })]));
    const unidadesVenda = new Map<number, string[] | null>([[1, ['UN']], [2, ['UN', 'CX']], [3, ['UN']]]);
    const onFiltrarSku = vi.fn();
    render(<RaioXCaixaLiberado linhas={linhas} isLoading={false} erro={null} empresa="oben" codigos={codigos}
      onFiltrarSku={onFiltrarSku} decisoes={decisoes} unidadesVenda={unidadesVenda} />);
    expect(screen.getByText('Liquidou abaixo do preço piso')).toBeTruthy();
    const itens = screen.getAllByRole('button', { name: /vendido a/ });
    expect(itens).toHaveLength(1);
    expect(itens[0].textContent).toContain('A1');
    fireEvent.click(itens[0]);
    expect(onFiltrarSku).toHaveBeenCalledWith(1);
  });

  it('placar: custo de esperar e execução; sem taxa (null) não mostra número', () => {
    const p = placar([], new Map());
    const execucao = { executaveis: 4, concluidas: 1, vencidas: 2, semResponsavel: 1 };
    const { rerender } = render(<RaioXPlacar placar={p} custoPendenteMes={1234} execucao={execucao} />);
    expect(screen.getByTestId('placar-custo-esperar').textContent).toMatch(/1\.234/);
    expect(screen.getByTestId('placar-execucao').textContent).toBe('Execução: 1 de 4 executadas · 2 vencida(s) · 1 sem responsável');
    rerender(<RaioXPlacar placar={p} custoPendenteMes={null} execucao={{ executaveis: 0, concluidas: 0, vencidas: 0, semResponsavel: 0 }} />);
    expect(screen.queryByTestId('placar-custo-esperar')).toBeNull();
    expect(screen.queryByTestId('placar-execucao')).toBeNull();
  });
});
