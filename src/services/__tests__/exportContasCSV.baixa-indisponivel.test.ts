import { describe, it, expect, vi } from 'vitest';

/**
 * O CSV é o caminho que SAI da tela: vira anexo, planilha e decisão, e leva o número para longe
 * de qualquer aviso que a página exiba. Ele carregava as colunas de baixa cruas de
 * `fin_contas_{receber,pagar}` — 0 em 100% do acervo, porque o LIST do Omie não devolve a baixa
 * (#396) — e o `saldo` gerado a partir delas, que devolve o valor de face até para liquidado.
 *
 * ⚠️ O gatilho é a PROCEDÊNCIA declarada, nunca `valor === 0`: o último bloco é o CONTROLE.
 */

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({}) },
}));

import { exportContasReceberCSV, exportContasPagarCSV } from '@/services/financeiroService';
import {
  BAIXA_OMIE_LIST,
  MOTIVO_BAIXA_NAO_INGERIDA,
  type ProcedenciaBaixa,
} from '@/lib/financeiro/procedencia-baixa';

const FONTE_COM_BAIXA: ProcedenciaBaixa = {
  fonte: 'teste/fonte que ingere a baixa',
  ingereBaixa: true,
  motivo: null,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const cr = (over: Record<string, unknown> = {}) => ({
  id: '1', company: 'colacor', nome_cliente: 'ACME', cnpj_cpf: '00.000.000/0001-00',
  numero_documento: 'NF-1', numero_pedido: null, data_emissao: '2026-01-01',
  data_vencimento: '2026-02-01', data_recebimento: '2026-02-01',
  valor_documento: 1_000, valor_recebido: 0, saldo: 1_000,
  status_titulo: 'RECEBIDO', categoria_descricao: 'VENDA', categoria_codigo: '1.01',
  ...over,
}) as any;

const cp = (over: Record<string, unknown> = {}) => ({
  id: '1', company: 'colacor', nome_fornecedor: 'FORN', cnpj_cpf: '00.000.000/0001-00',
  numero_documento: 'NF-9', data_emissao: '2026-01-01', data_vencimento: '2026-02-01',
  data_pagamento: '2026-02-01',
  valor_documento: 2_000, valor_pago: 0, saldo: 2_000,
  status_titulo: 'PAGO', categoria_descricao: 'INSUMO', categoria_codigo: '2.01',
  ...over,
}) as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Célula por índice de coluna — casar por texto pegaria "0" de qualquer outra coluna. */
function celulas(csv: string, linha: number): string[] {
  return csv.split('\n')[linha].split(',');
}

describe('CSV de contas — fonte sem ingestão da baixa', () => {
  it('não exporta o 0 fabricado de Recebido nem o saldo cheio: exporta o motivo', () => {
    const csv = exportContasReceberCSV([cr()], BAIXA_OMIE_LIST);
    const cols = celulas(csv, 1);

    expect(cols).toContain(MOTIVO_BAIXA_NAO_INGERIDA);
    expect(cols[8]).toBe('1000');                        // Valor: medido, fica
    expect(cols[9]).toBe(MOTIVO_BAIXA_NAO_INGERIDA);     // Recebido
    expect(cols[10]).toBe(MOTIVO_BAIXA_NAO_INGERIDA);    // Saldo
  });

  it('degrada Pago e Saldo no ramo de contas a pagar', () => {
    const cols = celulas(exportContasPagarCSV([cp()], BAIXA_OMIE_LIST), 1);

    expect(cols[7]).toBe('2000');                        // Valor
    expect(cols[8]).toBe(MOTIVO_BAIXA_NAO_INGERIDA);     // Pago
    expect(cols[9]).toBe(MOTIVO_BAIXA_NAO_INGERIDA);     // Saldo
  });

  it('o motivo não quebra a coluna do CSV', () => {
    const csv = exportContasReceberCSV([cr()], BAIXA_OMIE_LIST);
    const [cab, linha] = csv.split('\n');

    expect(linha.split(',').length).toBe(cab.split(',').length);
  });
});

describe('CONTROLE — fonte confiável: zero é FATO e vai como número', () => {
  it('recebido 0 medido sai como 0, nunca como o texto de indisponibilidade', () => {
    const cols = celulas(exportContasReceberCSV([cr()], FONTE_COM_BAIXA), 1);

    expect(cols[9]).toBe('0');
    expect(cols[10]).toBe('1000');
    expect(cols.join(',')).not.toContain(MOTIVO_BAIXA_NAO_INGERIDA);
  });

  it('pago 0 medido sai como 0 no ramo de contas a pagar', () => {
    const cols = celulas(exportContasPagarCSV([cp()], FONTE_COM_BAIXA), 1);

    expect(cols[8]).toBe('0');
    expect(cols[9]).toBe('2000');
  });

  it('valores não-zero com fonte confiável passam intactos', () => {
    const cols = celulas(
      exportContasReceberCSV([cr({ valor_recebido: 400, saldo: 600 })], FONTE_COM_BAIXA),
      1,
    );

    expect(cols[9]).toBe('400');
    expect(cols[10]).toBe('600');
  });
});
