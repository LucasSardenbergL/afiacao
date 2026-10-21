import { describe, expect, it } from 'vitest';
import type { Tables } from '@/integrations/supabase/types';
import {
  lerFundingInputsSalvos, paraAlerta, paraAntecipacao, paraCashflowConfig, paraCustoTipo, paraDivida,
  paraEventoEventual, paraEventoRecorrente,
} from './borda-tabelas';

const divida = (over: Partial<Tables<'fin_dividas'>> = {}): Tables<'fin_dividas'> => ({
  id: 'd1', company: 'oben', credor: 'Banco X', tipo: 'capital_giro', principal_contratado: 100000,
  saldo_devedor_informado: null, saldo_devedor_data_base: null, cp_inclusion_status: 'nao_sei',
  cp_inclusion_ate: null, data_contratacao: '2026-01-10', cet_aa: null, indexador: null,
  coobrigada_por: null, garantias: null, observacao: null, ativo: true, updated_at: '2026-10-01', updated_by: 'u1',
  ...over,
});

describe('paraDivida', () => {
  it('vocabulário de CHECK válido passa e preserva as demais colunas (payload do upsert não muda)', () => {
    const d = paraDivida(divida({ coobrigada_por: 'colacor_sc' }));
    expect(d.coobrigada_por).toBe('colacor_sc');
    expect(d).toMatchObject({ updated_by: 'u1', principal_contratado: 100000 });
  });

  it('coobrigada_por NULL é contrato', () => {
    expect(paraDivida(divida()).coobrigada_por).toBeNull();
  });

  it('valor fora do CHECK LANÇA nomeando a coluna', () => {
    expect(() => paraDivida(divida({ company: 'matriz' }))).toThrow('fin_dividas d1.company: valor fora do vocabulário "matriz"');
    expect(() => paraDivida(divida({ tipo: 'leasing' }))).toThrow('fin_dividas d1.tipo: valor fora do vocabulário "leasing"');
    expect(() => paraDivida(divida({ cp_inclusion_status: 'talvez' }))).toThrow('.cp_inclusion_status: valor fora do vocabulário "talvez"');
    expect(() => paraDivida(divida({ coobrigada_por: 'x' }))).toThrow('.coobrigada_por: valor fora do vocabulário "x"');
  });
});

describe('paraAntecipacao', () => {
  const op = (over: Partial<Tables<'fin_antecipacoes'>> = {}): Tables<'fin_antecipacoes'> => ({
    id: 'a1', company: 'colacor', banco: null, tipo: 'duplicata', valor_bruto: 1000, custos_avulsos: 0,
    valor_liquido: 970, data_operacao: '2026-10-01', data_vencimento: '2026-11-01', operacao_origem_id: null,
    referencia: null, observacao: null, deleted_at: null, created_at: '', created_by: null, updated_at: '', updated_by: null,
    ...over,
  });
  it('válida passa; tipo fora do CHECK LANÇA', () => {
    expect(paraAntecipacao(op()).tipo).toBe('duplicata');
    expect(() => paraAntecipacao(op({ tipo: 'factoring' }))).toThrow('fin_antecipacoes a1.tipo: valor fora do vocabulário "factoring"');
  });
});

describe('paraCustoTipo', () => {
  it('company `_default` é domínio legítimo (linha-base), só o tipo passa pela guarda', () => {
    expect(paraCustoTipo({ company: '_default', categoria_codigo: '2.01', tipo: 'fixo', observacao: null }).company).toBe('_default');
    expect(() => paraCustoTipo({ company: 'oben', categoria_codigo: '2.01', tipo: 'semi', observacao: null })).toThrow(
      'fin_dre_custo_tipo oben/2.01.tipo: valor fora do vocabulário "semi"',
    );
  });
});

describe('eventos e alertas', () => {
  it('evento eventual: tipo e status guardados', () => {
    const ev: Tables<'fin_eventos_eventuais'> = {
      id: 'e1', company: 'oben', descricao: 'x', valor: 10, tipo: 'saida', categoria_dre: null, data_prevista: '2026-10-01',
      data_realizada: null, status: 'previsto', observacao: null, created_at: '', updated_at: '', criado_por: null,
    };
    expect(paraEventoEventual(ev).status).toBe('previsto');
    expect(() => paraEventoEventual({ ...ev, status: 'pago' })).toThrow('fin_eventos_eventuais e1.status: valor fora do vocabulário "pago"');
  });

  it('evento recorrente: tipo guardado', () => {
    const ev: Tables<'fin_eventos_recorrentes'> = {
      id: 'r1', company: 'oben', descricao: 'aluguel', valor: 10, tipo: 'saida', categoria_dre: null, is_folha: false,
      dia_do_mes: 5, inicio: '2026-01-01', fim: null, ativo: true, observacao: null, created_at: '', updated_at: '', criado_por: null,
    };
    expect(() => paraEventoRecorrente({ ...ev, tipo: 'ambos' })).toThrow('fin_eventos_recorrentes r1.tipo: valor fora do vocabulário "ambos"');
  });

  it('alerta: severidade guardada; contexto NULL passa, array LANÇA', () => {
    const al: Tables<'fin_alertas'> = {
      id: 'x1', company: 'oben', tipo: 'caixa_negativo', severidade: 'critico', mensagem: 'm', valor: null, threshold: null,
      contexto: { semana: 3 }, criado_em: '', dismissed_at: null, dismissed_by: null, dismissed_until: null,
      acknowledged_at: null, acknowledged_by: null, resolvido_em: null, email_enfileirado_em: null,
    };
    expect(paraAlerta(al).contexto).toEqual({ semana: 3 });
    expect(paraAlerta({ ...al, contexto: null }).contexto).toBeNull();
    expect(() => paraAlerta({ ...al, contexto: [1] })).toThrow('fin_alertas x1.contexto: esperava objeto, veio array');
    expect(() => paraAlerta({ ...al, severidade: 'alta' })).toThrow('fin_alertas x1.severidade: valor fora do vocabulário "alta"');
  });
});

describe('paraCashflowConfig', () => {
  // Forma real das 3 linhas de prod (2026-10-20).
  const cfg: Tables<'fin_config_cashflow'> = {
    company: 'oben',
    overrides_cenario: {
      otimista: { inadimplencia_pct_delta: -50, recebimento_no_prazo_pct_delta: 10 },
      pessimista: { inadimplencia_pct_delta: 50, recebimento_no_prazo_pct_delta: -15 },
    },
    thresholds: {
      dias_cobertura_min: 30, ncg_deficit_alerta: 0, inadimplencia_max_pct: 10, caixa_negativo_semanas: 4,
      concentracao_top1_max_pct: 20, pmr_crescimento_max_pct_90d: 15,
    },
    adiantamento_categorias_codigos: [], folha_categorias_codigos: [], dre_tributario: {}, updated_at: '', updated_by: null,
  };

  it('forma de prod passa intacta (ncg_deficit_alerta = 0 é zero MEDIDO, não default)', () => {
    const c = paraCashflowConfig(cfg);
    expect(c.thresholds.ncg_deficit_alerta).toBe(0);
    expect(c.overrides_cenario.pessimista.recebimento_no_prazo_pct_delta).toBe(-15);
  });

  it('chave desconhecida é PRESERVADA (o dialog regrava o jsonb inteiro)', () => {
    const c = paraCashflowConfig({
      ...cfg,
      thresholds: { ...(cfg.thresholds as Record<string, number>), novo_limite: 7 },
      overrides_cenario: { ...(cfg.overrides_cenario as Record<string, object>), base: { x: 1 } },
    });
    expect(c.thresholds).toMatchObject({ novo_limite: 7, dias_cobertura_min: 30 });
    expect(c.overrides_cenario).toMatchObject({ base: { x: 1 } });
  });

  it('limite ausente LANÇA (o dialog não edita um limite inventado)', () => {
    const { dias_cobertura_min: _omitido, ...semDias } = cfg.thresholds as Record<string, number>;
    expect(() => paraCashflowConfig({ ...cfg, thresholds: semDias })).toThrow(
      'fin_config_cashflow oben.thresholds.dias_cobertura_min: esperava número, veio ausente',
    );
    expect(() => paraCashflowConfig({ ...cfg, overrides_cenario: { otimista: {} } })).toThrow(
      'fin_config_cashflow oben.overrides_cenario.otimista.recebimento_no_prazo_pct_delta: esperava número, veio ausente',
    );
  });
});

describe('lerFundingInputsSalvos', () => {
  it('`{}` (estado real de prod) ⇒ objeto vazio, SEM chaves undefined que apagariam os DEFAULTS no merge', () => {
    const v = lerFundingInputsSalvos({}, 'f');
    expect(v).toEqual({});
    expect(Object.keys(v)).toEqual([]);
  });

  it('parcial em profundidade passa só o que foi gravado', () => {
    const v = lerFundingInputsSalvos({ fontes: { antecipacao: { taxa_desconto_mensal_perc: 1.8 } }, reserva_dias_min: 20 }, 'f');
    expect(v).toEqual({ fontes: { antecipacao: { taxa_desconto_mensal_perc: 1.8 } }, reserva_dias_min: 20 });
  });

  it('tipo trocado LANÇA', () => {
    expect(() => lerFundingInputsSalvos({ reserva_dias_min: '15' }, 'f')).toThrow('f.reserva_dias_min: esperava número, veio string');
    expect(() => lerFundingInputsSalvos({ fontes: { antecipacao: { tipo: 'cessao' } } }, 'f')).toThrow(
      'f.fontes.antecipacao.tipo: valor fora do vocabulário "cessao"',
    );
    expect(() => lerFundingInputsSalvos(null, 'f')).toThrow('f: esperava objeto, veio null');
  });
});
