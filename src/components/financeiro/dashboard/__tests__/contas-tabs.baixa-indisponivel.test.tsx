import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  BAIXA_OMIE_LIST,
  MOTIVO_BAIXA_NAO_INGERIDA,
  type ProcedenciaBaixa,
} from '@/lib/financeiro/procedencia-baixa';

/** A MESMA tela no dia em que a ingestão da baixa existir — só a declaração de fonte muda. */
const FONTE_COM_BAIXA: ProcedenciaBaixa = {
  fonte: 'teste/fonte que ingere a baixa',
  ingereBaixa: true,
  motivo: null,
};

/**
 * As abas "Contas a Receber"/"a Pagar" de `/financeiro` exibiam TRÊS superfícies alimentadas por
 * colunas que o ingest nunca preencheu (#396 — LIST do Omie não devolve a baixa; 0 em 100% do
 * acervo, medido em prod 2026-09-09): o card "Recebido"/"Pago", o card "Saldo" (coluna GERADA a
 * partir da baixa, logo o valor de face inteiro até para liquidado) e a coluna homônima de cada
 * LINHA. Um card degradado ao lado de linhas dizendo "R$ 0,00" seria lido como bug da tela.
 *
 * ⚠️ O gatilho é a PROCEDÊNCIA que o dashboard declarou (`motivoBaixa`), nunca `v === 0`. O
 * último bloco é o CONTROLE: com a baixa disponível, zero é um FATO e tem de aparecer como
 * moeda — degradá-lo mentiria no sentido oposto.
 */

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({}) },
}));

import { ContasReceberTab } from '../ContasReceberTab';
import { ContasPagarTab } from '../ContasPagarTab';

/* eslint-disable @typescript-eslint/no-explicit-any */
const CR_LIQUIDADO = [{
  id: 'cr-1', company: 'colacor', nome_cliente: 'ACME', cnpj_cpf: '00.000.000/0001-00',
  numero_documento: 'NF-1', numero_pedido: null, data_emissao: '2026-01-01',
  data_vencimento: '2026-02-01', data_recebimento: '2026-02-01',
  valor_documento: 1_000, valor_recebido: 0, saldo: 1_000,
  status_titulo: 'RECEBIDO', categoria_descricao: 'VENDA', categoria_codigo: '1.01',
}] as any;

const CP_LIQUIDADO = [{
  id: 'cp-1', company: 'colacor', nome_fornecedor: 'FORN', cnpj_cpf: '00.000.000/0001-00',
  numero_documento: 'NF-9', data_emissao: '2026-01-01', data_vencimento: '2026-02-01',
  data_pagamento: '2026-02-01',
  valor_documento: 2_000, valor_pago: 0, saldo: 2_000,
  status_titulo: 'PAGO', categoria_descricao: 'INSUMO', categoria_codigo: '2.01',
}] as any;

const noop = () => {};
const propsCR = (crTotals: any) => ({
  crFilter: 'all', setCrFilter: noop, crDateFrom: '', setCrDateFrom: noop,
  crDateTo: '', setCrDateTo: noop, contasReceber: CR_LIQUIDADO, crTotals,
  view: 'colacor' as const, loading: false, onAudit: noop,
});
const propsCP = (cpTotals: any) => ({
  cpFilter: 'all', setCpFilter: noop, cpDateFrom: '', setCpDateFrom: noop,
  cpDateTo: '', setCpDateTo: noop, contasPagar: CP_LIQUIDADO, cpTotals,
  view: 'colacor' as const, loading: false, onAudit: noop,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * O VALOR do card, lido pela estrutura: "Recebido"/"Saldo" também são cabeçalho de tabela, e
 * casar pelo texto solto pegaria o `<th>` — asserção que passaria pelo motivo errado.
 */
function valorDoCard(rotulo: string): string {
  const rotulos = screen.getAllByText(rotulo).filter(el => el.tagName === 'P');
  expect(rotulos.length).toBe(1);
  const valor = rotulos[0].nextElementSibling;
  expect(valor).not.toBeNull();
  return valor!.textContent ?? '';
}

/** As células da LINHA do título, por posição — casar por texto pegaria outra coluna. */
function celulasDaLinha(nome: string): string[] {
  const linha = screen.getByText(nome).closest('tr');
  expect(linha).not.toBeNull();
  return within(linha as HTMLElement)
    .getAllByRole('cell')
    .map(c => c.textContent ?? '');
}

describe('aba Contas a Receber — fonte sem ingestão da baixa', () => {
  const totais = { valor: 1_000, baixa: null, saldo: null, procedencia: BAIXA_OMIE_LIST };

  it('mostra "—" nos cards Recebido e Saldo, e o valor medido em Valor Total', () => {
    render(<ContasReceberTab {...propsCR(totais)} />);

    expect(valorDoCard('Recebido')).toBe('—');
    expect(valorDoCard('Saldo')).toBe('—');
    expect(valorDoCard('Valor Total')).toContain('1.000,00');
  });

  it('mostra "—" também nas células da linha — nunca R$ 0,00 nem o valor de face como saldo', () => {
    render(<ContasReceberTab {...propsCR(totais)} />);
    const cels = celulasDaLinha('ACME');

    expect(cels[2]).toContain('1.000,00'); // Valor: medido, fica
    expect(cels[3]).toBe('—');             // Recebido
    expect(cels[4]).toBe('—');             // Saldo
  });

  it('DIZ por que degradou — um "—" mudo é lido como bug da tela', () => {
    render(<ContasReceberTab {...propsCR(totais)} />);

    expect(screen.getByText(new RegExp(MOTIVO_BAIXA_NAO_INGERIDA, 'i'))).toBeTruthy();
  });
});

describe('aba Contas a Pagar — fonte sem ingestão da baixa', () => {
  const totais = { valor: 2_000, baixa: null, saldo: null, procedencia: BAIXA_OMIE_LIST };

  it('mostra "—" nos cards Pago e Saldo', () => {
    render(<ContasPagarTab {...propsCP(totais)} />);

    expect(valorDoCard('Pago')).toBe('—');
    expect(valorDoCard('Saldo')).toBe('—');
  });

  it('mostra "—" nas células da linha e diz por quê', () => {
    render(<ContasPagarTab {...propsCP(totais)} />);
    const cels = celulasDaLinha('FORN');

    expect(cels[2]).toContain('2.000,00');
    expect(cels[3]).toBe('—');
    expect(cels[4]).toBe('—');
    expect(screen.getByText(new RegExp(MOTIVO_BAIXA_NAO_INGERIDA, 'i'))).toBeTruthy();
  });
});

describe('CONTROLE — fonte confiável: zero é FATO e aparece como R$ 0,00', () => {
  it('recebe 0 medido e exibe moeda no card e na linha, sem aviso de indisponibilidade', () => {
    render(<ContasReceberTab {...propsCR({ valor: 1_000, baixa: 0, saldo: 1_000, procedencia: FONTE_COM_BAIXA })} />);

    expect(valorDoCard('Recebido')).toContain('0,00');
    expect(valorDoCard('Recebido')).not.toBe('—');
    expect(celulasDaLinha('ACME')[3]).not.toBe('—');
    expect(screen.queryByText(new RegExp(MOTIVO_BAIXA_NAO_INGERIDA, 'i'))).toBeNull();
  });

  it('ramo de contas a pagar com 0 medido idem', () => {
    render(<ContasPagarTab {...propsCP({ valor: 2_000, baixa: 0, saldo: 2_000, procedencia: FONTE_COM_BAIXA })} />);

    expect(valorDoCard('Pago')).toContain('0,00');
    expect(celulasDaLinha('FORN')[3]).not.toBe('—');
    expect(screen.queryByText(new RegExp(MOTIVO_BAIXA_NAO_INGERIDA, 'i'))).toBeNull();
  });
});
