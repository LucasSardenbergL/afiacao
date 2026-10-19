import { describe, expect, it } from 'vitest';
import { clientesDe, comoDecisaoRow, comoLinhaManual, comoLinhaMedicao } from '../borda';
import type { Tables } from '@/integrations/supabase/types';

const decisao: Tables<'raio_x_decisao'> = {
  atualizado_em: '2026-10-18T00:00:00Z', contado_em: null, contado_por: null, credito_troca: null,
  decidido_em: null, decidido_por: null, destino: 'liquidar', empresa: 'oben', fornecedor_informado: null,
  foto_categoria: null, foto_cmc: null, foto_em: null, foto_saldo: null, foto_valor: null, motor_antes: null,
  observacao: null, origem: 'app', qtd_contada: null, sku_codigo_omie: 42, tirou_do_motor: false,
};

describe('borda do Raio-X — o que o cast escondia agora lança nomeando o campo', () => {
  it('decisão válida passa estreitada; destino/origem/empresa fora do vocabulário lançam', () => {
    expect(comoDecisaoRow(decisao).destino).toBe('liquidar');
    expect(comoDecisaoRow({ ...decisao, destino: null }).destino).toBeNull();
    expect(() => comoDecisaoRow({ ...decisao, destino: 'doar' })).toThrow('destino "doar"');
    expect(() => comoDecisaoRow({ ...decisao, origem: 'planilha' })).toThrow('origem "planilha"');
    expect(() => comoDecisaoRow({ ...decisao, empresa: 'OBEN' })).toThrow('empresa "OBEN"');
  });

  it('clientes jsonb: lista bem formada vira ClienteComprador; elemento torto lança; null fica null', () => {
    expect(clientesDe([{ nome: 'A', qtd: 2, ult: '2026-01-01' }, { nome: 'B', qtd: 1 }], 42)).toEqual([
      { nome: 'A', qtd: 2, ult: '2026-01-01' },
      { nome: 'B', qtd: 1, ult: null },
    ]);
    expect(clientesDe(null, 42)).toBeNull();
    expect(() => clientesDe({ nome: 'A' }, 42)).toThrow('não é lista');
    expect(() => clientesDe([{ nome: 'A' }], 42)).toThrow('clientes[0] do SKU 42');
  });

  it('classificação manual e medição estreitam categoria/destino', () => {
    expect(comoLinhaManual({ sku_codigo_omie: 1, categoria: 'mercadoria', motivo: 'x' }).categoria).toBe('mercadoria');
    expect(() => comoLinhaManual({ sku_codigo_omie: 1, categoria: 'servico', motivo: 'x' })).toThrow('categoria manual "servico"');
    const med = {
      compras_apos: [], credito_troca: 0, decidido_em: '2026-01-01', destino: 'trocar', foto_categoria: 'mercadoria',
      foto_cmc: 1, foto_saldo: 2, foto_valor: 2, preco_medio_12m: 3, qtd_vendida: 0, receita: 0, saldo_atual: 2, sku_codigo_omie: 7,
    };
    expect(comoLinhaMedicao(med).destino).toBe('trocar');
    expect(() => comoLinhaMedicao({ ...med, destino: 'sumir' })).toThrow('destino "sumir"');
  });
});
