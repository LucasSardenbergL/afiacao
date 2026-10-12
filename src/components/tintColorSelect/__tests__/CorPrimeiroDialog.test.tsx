// Fase 2A — "Pedir por cor". Trava: (1) a confirmação passa pela regra ÚNICA de adicionar
// (motor carregando / sem preço / R$ 0 seguram o botão); (2) o item sai com a BASE da
// embalagem escolhida + a fonte efetiva + o desconto declarado (o que o gate revalida);
// (3) a lista de cores deduplica a canônica (1 linha por SKU da cor).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { EmbalagemDaCor } from '../useCorPrimeiro';

const estado: { current: Record<string, unknown> } = { current: {} };
vi.mock('../useCorPrimeiro', async (importOriginal) => {
  const real = await importOriginal<typeof import('../useCorPrimeiro')>();
  return { ...real, useCorPrimeiro: () => estado.current };
});
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { CorPrimeiroDialog } from '../CorPrimeiroDialog';
import { coresDistintas } from '../useCorPrimeiro';

const base = {
  id: 'prod-gl', codigo: 'WFOB.7666 GL', descricao: 'BASE BRANCA GL', account: 'oben', is_tintometric: true, tint_type: 'base',
} as EmbalagemDaCor['product'];
const emb: EmbalagemDaCor = {
  formulaId: 'f-gl', skuId: 'sku-gl', omieProductId: 'prod-gl', productDescricao: 'BASE BRANCA GL', productCodigo: 'WFOB.7666 GL',
  precoFinalCsv: null, product: base, sameAcabamento: false, corId: '346J', nomeCor: 'PLATINA BIANCO', isSl: true,
  grupo: 'PU ACETINADO', volumeMl: 3240,
};

function estadoBase(over: Record<string, unknown> = {}) {
  return {
    search: '346j', buscaEstavel: true, onSearchChange: vi.fn(), cores: [], truncado: false, loadingCores: false,
    cor: { corId: '346J', nomeCor: 'PLATINA BIANCO' }, setCor: vi.fn(), embalagens: [emb], loadingEmbalagens: false,
    precos: { 'f-gl': { precoFinal: 200, custoCorantes: 5 } }, precoCarregando: false, precoErro: false,
    overrides: {}, setOverride: vi.fn(), descontos: {}, setDesconto: vi.fn(), falhaLeitura: false, tentarDeNovo: vi.fn(),
    ...over,
  };
}

const botao = () => screen.getByRole('button', { name: /Adicionar ao pedido/ });

beforeEach(() => { estado.current = estadoBase(); });

describe('CorPrimeiroDialog', () => {
  it('confirma com a base DA EMBALAGEM, a fonte efetiva e o desconto declarado', () => {
    estado.current = estadoBase({ descontos: { 'f-gl': 10 } });
    const onConfirm = vi.fn();
    render(<CorPrimeiroDialog open onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(botao());
    expect(onConfirm).toHaveBeenCalledWith(
      'f-gl', '346J', 'PLATINA BIANCO', 180, 5,
      { source: 'calculado', discountPct: 10, precoSemDesconto: 200 },
      base,
    );
    expect(screen.getByText('PU ACETINADO')).toBeInTheDocument();
  });

  it('motor recarregando: botão desabilitado e nenhum preço mostrado', () => {
    estado.current = estadoBase({ precoCarregando: true });
    const onConfirm = vi.fn();
    render(<CorPrimeiroDialog open onClose={() => {}} onConfirm={onConfirm} />);
    expect(botao()).toBeDisabled();
    fireEvent.click(botao());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('calculando…')).toBeInTheDocument();
  });

  it('motor sem preço (mapa ausente por erro) → "sem preço", mesmo com CSV', () => {
    estado.current = estadoBase({ precos: undefined, precoErro: true, embalagens: [{ ...emb, precoFinalCsv: 150 }] });
    render(<CorPrimeiroDialog open onClose={() => {}} onConfirm={vi.fn()} />);
    expect(botao()).toBeDisabled();
    expect(screen.getByText('sem preço')).toBeInTheDocument();
  });

  it('desconto que zera o preço → não vende (nunca R$ 0), sem teto de desconto', () => {
    estado.current = estadoBase({ precos: { 'f-gl': { precoFinal: 0.4, custoCorantes: 0 } }, descontos: { 'f-gl': 99.99 } });
    render(<CorPrimeiroDialog open onClose={() => {}} onConfirm={vi.fn()} />);
    expect(botao()).toBeDisabled();
  });
});

describe('CorPrimeiroDialog — só base tintométrica da Oben', () => {
  it.each([
    ['Colacor', { account: 'colacor' }],
    ['não tintométrico', { is_tintometric: false }],
    ['não é base', { tint_type: 'corante' }],
  ])('%s → "Adicionar" desabilitado mesmo com preço', (_n, over) => {
    estado.current = estadoBase({ embalagens: [{ ...emb, product: { ...base, ...over } }] });
    render(<CorPrimeiroDialog open onClose={() => {}} onConfirm={vi.fn()} />);
    expect(botao()).toBeDisabled();
  });
});

describe('coresDistintas', () => {
  it('1 entrada por cor_id, na ordem da canônica, ignorando linha incompleta', () => {
    expect(
      coresDistintas([
        { cor_id: '346J', nome_cor: 'PLATINA' }, { cor_id: '346J', nome_cor: 'PLATINA' },
        { cor_id: null, nome_cor: 'X' }, { cor_id: '347J', nome_cor: 'OURO' },
      ]),
    ).toEqual([{ corId: '346J', nomeCor: 'PLATINA' }, { corId: '347J', nomeCor: 'OURO' }]);
  });
});
