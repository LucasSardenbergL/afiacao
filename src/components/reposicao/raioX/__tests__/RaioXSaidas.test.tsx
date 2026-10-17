import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { classificar } from '@/lib/reposicao/raio-x/classificar';
import { decisao, fato, HOJE, mapaDecisoes } from '@/lib/reposicao/raio-x/__tests__/fixtures';
import { csvTroca, listaTroca } from '@/lib/reposicao/raio-x/saidas';

/** Saídas do Raio-X: troca (CSV, ausente ≠ zero) e venda dirigida (1 missão por cliente, todos os SKUs). */

let dialogProps: { alvos: { sku_codigo_omie: number; capital_excedente: number | null }[]; tituloPrefixo?: string; onCriada?: () => void } | null;
vi.mock('@/components/reposicao/baixoGiro/DesovaMissaoDialog', () => ({
  DesovaMissaoDialog: (p: NonNullable<typeof dialogProps> & { open: boolean }) => {
    dialogProps = p.open ? p : null;
    return null;
  },
}));
const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a), captureException: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { RaioXSaidas } from '../RaioXSaidas';

const CLIENTE = [{ nome: 'ACME', ult: '2026-09-01', qtd: 2 }];
const itens = classificar([
  fato({ sku_codigo_omie: 1, codigo: 'A1', cmc: 10, q12: 1, clientes: CLIENTE }),
  fato({ sku_codigo_omie: 2, codigo: 'A2', cmc: 5, q12: 1, clientes: CLIENTE }),
  fato({ sku_codigo_omie: 3, codigo: 'A3', cmc: null, q12: 1, clientes: CLIENTE }),
  fato({ sku_codigo_omie: 4, codigo: 'T1', cmc: 7, fornecedor: 'SAPIRANGA' }),
  fato({ sku_codigo_omie: 5, codigo: 'T2', cmc: null, fornecedor: 'SAPIRANGA' }),
], new Map(), 'oben', HOJE);
const decisoes = mapaDecisoes(
  decisao(1, { destino: 'venda_dirigida' }), decisao(2, { destino: 'venda_dirigida' }), decisao(3, { destino: 'venda_dirigida' }),
  decisao(4, { destino: 'trocar' }), decisao(5, { destino: 'trocar' }),
);

beforeEach(() => { dialogProps = null; track.mockClear(); });

describe('RaioXSaidas', () => {
  it('(c) "Criar missão" do cliente abre o diálogo com os 3 SKUs dele e o prefixo do cliente', () => {
    render(<RaioXSaidas itens={itens} decisoes={decisoes} empresa="oben" />);
    fireEvent.click(screen.getByRole('button', { name: 'Criar missão' }));
    expect(dialogProps?.alvos.map((a) => a.sku_codigo_omie).sort()).toEqual([1, 2, 3]);
    expect(dialogProps?.tituloPrefixo).toBe('Cliente ACME');
    // item sem custo segue null no alvo: nunca R$ 0 fabricado
    expect(dialogProps?.alvos.find((a) => a.sku_codigo_omie === 3)?.capital_excedente).toBeNull();
  });

  it('grupo de venda dirigida com parte sem custo mostra piso "≥ … (parcial)"; sem nenhum custo, "sem custo"', () => {
    const { unmount } = render(<RaioXSaidas itens={itens} decisoes={decisoes} empresa="oben" />);
    expect(screen.getByText(/3 SKU\(s\) · ≥ .*15.* \(parcial\)/)).toBeTruthy();
    unmount();
    const so = classificar([fato({ sku_codigo_omie: 3, codigo: 'A3', cmc: null, q12: 1, clientes: CLIENTE })], new Map(), 'oben', HOJE);
    render(<RaioXSaidas itens={so} decisoes={mapaDecisoes(decisao(3, { destino: 'venda_dirigida' }))} empresa="oben" />);
    expect(screen.getByText(/1 SKU\(s\) · sem custo — não avaliado/)).toBeTruthy();
  });

  it('missão criada dispara raio_x.missao_criada com empresa e nº de SKUs', () => {
    render(<RaioXSaidas itens={itens} decisoes={decisoes} empresa="oben" />);
    fireEvent.click(screen.getByRole('button', { name: 'Criar missão' }));
    dialogProps?.onCriada?.();
    expect(track).toHaveBeenCalledWith('raio_x.missao_criada', { empresa: 'oben', skus: 3 });
  });

  it('lista de troca: item sem custo mostra "sem custo — não avaliado"', () => {
    render(<RaioXSaidas itens={itens} decisoes={decisoes} empresa="oben" />);
    expect(screen.getAllByText(/sem custo — não avaliado/).length).toBeGreaterThan(0);
  });

  it('(d) CSV da troca tem o cabeçalho certo e valor null vira célula vazia (nunca 0)', () => {
    const csv = csvTroca(listaTroca(itens, decisoes));
    const [cab, ...linhas] = csv.split('\n');
    expect(cab).toBe('codigo;descricao;saldo;valor;fornecedor');
    expect(linhas).toContain('T1;PRODUTO;10,00;70,00;SAPIRANGA');
    expect(linhas).toContain('T2;PRODUTO;10,00;;SAPIRANGA');
  });

  it('CSV neutraliza fórmula e escapa ";" na descrição', () => {
    const l = [{ sku_codigo_omie: 1, codigo: 'X', descricao: '=1+1;"x"', saldo: 1, valor: null, fornecedor: 'F' }];
    expect(csvTroca(l).split('\n')[1]).toBe(`X;"'=1+1;""x""";1,00;;F`);
  });
});
