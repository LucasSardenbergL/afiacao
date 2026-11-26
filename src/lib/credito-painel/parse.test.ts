import { describe, expect, it } from 'vitest';
import type { Json } from '@/integrations/supabase/types';
import { brl, int, lerPainelCredito, num } from './parse';

// Forma devolvida por credito_painel_resumo hoje em prod (sem limite, sem sombra, sem fila).
const base = {
  gerado_em: '2026-11-25T12:00:00Z',
  hoje_sp: '2026-11-25',
  periodo_dias: 90,
  frescor_cr: { oben: '2026-11-25T11:00:00Z' },
  exposicao: {
    totais: { grupos: 2, aberto_conhecido: 1500, vencido_conhecido: 1000, vencido_60_conhecido: 1000,
              titulos_indeterminados: 1, grupos_com_limite: 0, grupos_vencido_60: 1 },
    reservas: { disponivel: false, motivo: 'reserva não medida' },
    grupos: [
      { grupo_user_id: 'g1', nome: 'C', empresas: ['oben', 'colacor_sc'], parcial_colacor_sc: true, titulos: 3,
        titulos_indeterminados: 1, aberto_conhecido: 1500, vencido_conhecido: 1000, vencido_60_conhecido: 1000,
        titulos_vencidos_60: 1, dias_maior_atraso: 70, reservado: null, limite_brl: null, uso_pct: null },
      { grupo_user_id: null, nome: 'sem id' },
    ],
    grupos_omitidos: 0,
    nao_consolidados: [{ motivo: 'sem_grupo', pares: 1, titulos: 1, aberto_conhecido: 300, titulos_indeterminados: 0 }],
  },
  bloqueios: {
    log_total_historico: 0,
    pedidos_app_periodo: { oben: 3 },
    por_acao: [],
    recentes: [],
    gate_v2: { disponivel: false, motivo: 'enforcement liga no PR 6' },
  },
  limites: { disponivel: false, motivo: 'nenhum limite vigente', vigentes: 0, propostas: {} },
  concordancia: { disponivel: false, motivo: 'sensor do PR 5', sombra: { disponivel: false, motivo: 'sem sombra' } },
  fila: { disponivel: false, motivo: 'fila nasce no PR 6' },
  liberados_atrasaram: {
    definicao: 'def', cobertura: { parcial: true, motivo: 'Colacor SC fora' },
    liberados: 3, liberados_valor: 3100, por_via: { piso: 3 }, com_titulo: 3, maturados: 0, atrasados: 0,
    saldo_atrasado_conhecido: null, titulos_atrasados_sem_saldo: 0, taxa_atraso_pct: null, lista: [],
  },
} as const;

describe('lerPainelCredito', () => {
  it('ausente vira null, nunca 0', () => {
    const p = lerPainelCredito(base as unknown as Json);
    const g = p.exposicao.grupos[0];
    expect(g.reservado).toBeNull();
    expect(g.limiteBrl).toBeNull();
    expect(g.usoPct).toBeNull();
    expect(p.liberados.taxaAtrasoPct).toBeNull();
    expect(p.liberados.saldoAtrasadoConhecido).toBeNull();
  });

  it('linha sem grupo_user_id é descartada (não vira grupo fantasma)', () => {
    expect(lerPainelCredito(base as unknown as Json).exposicao.grupos).toHaveLength(1);
  });

  it('blocos sem fonte chegam como indisponível COM o motivo do banco', () => {
    const p = lerPainelCredito(base as unknown as Json);
    expect(p.limites).toMatchObject({ disponivel: false, motivo: 'nenhum limite vigente' });
    expect(p.exposicao.reservas).toMatchObject({ disponivel: false, motivo: 'reserva não medida' });
    expect(p.fila).toMatchObject({ disponivel: false, motivo: 'fila nasce no PR 6' });
    expect(p.concordancia.concordancia).toMatchObject({ disponivel: false, motivo: 'sensor do PR 5' });
    expect(p.concordancia.sombra).toMatchObject({ disponivel: false, motivo: 'sem sombra' });
    expect(p.bloqueios.gateV2).toMatchObject({ disponivel: false });
    // nenhuma proposta no banco: o mapa vazio não vira "0 pendentes"
    expect(p.limites.propostasPendentes).toBeNull();
  });

  it('`disponivel` não-booleano é indisponível (fail-closed na leitura)', () => {
    const raw = { ...base, fila: { disponivel: 'sim', abertas: 4 } };
    expect(lerPainelCredito(raw as unknown as Json).fila).toMatchObject({ disponivel: false });
  });

  it('sombra do PR 5: v2 × piso com piso ausente fica null, não "liberou"', () => {
    const raw = { ...base, concordancia: { ...base.concordancia, sombra: { disponivel: true, pvs: 2,
      por_faixa: [{ faixa: 'amarelo', motivo: 'sem_limite', decisoes: 2 }],
      v2_x_piso: [{ faixa: 'amarelo', piso_bloqueado: null, decisoes: 1 }, { faixa: 'amarelo', piso_bloqueado: false, decisoes: 1 }] } } };
    const s = lerPainelCredito(raw as unknown as Json).concordancia.sombra;
    expect(s.disponivel).toBe(true);
    if (!s.disponivel) throw new Error('sombra deveria estar disponível');
    expect(s.pvs).toBe(2);
    expect(s.v2XPiso.map((v) => v.pisoBloqueado)).toEqual([null, false]);
  });

  it('concordância IA × regra: % sem comparável fica null e linha sem risco é descartada', () => {
    const raw = { ...base, concordancia: { ...base.concordancia, disponivel: true, in_sample: true, aviso: 'descritivo',
      janela: { vencimento_de: '2026-08-28', vencimento_ate: '2026-11-10', tolerancia_dias: 5 },
      grupos_com_proposta: 1, grupos_com_desfecho: 0, titulos_sem_desfecho: 0,
      concordancia_piso: { comparaveis: 0, concordam: 0, fora_da_comparacao: 1, concordancia_pct: null },
      por_risco: [{ risco: 'alto', grupos: 1, titulos: 4, valor: 1000, atraso_pct: 50, atraso_grave_pct: 30 }, { grupos: 9 }],
      ia_x_piso: [{ ia_restringe: true, piso_hoje: null, grupos: 1, atraso_pct: null }],
      prospectivo: { titulos_maduros: 0, por_ia: [] } } };
    const c = lerPainelCredito(raw as unknown as Json).concordancia.concordancia;
    if (!c.disponivel) throw new Error('concordância deveria estar disponível');
    expect(c.concordanciaPiso.pct).toBeNull();
    expect(c.concordanciaPiso.fora).toBe(1);
    expect(c.porRisco).toHaveLength(1);
    expect(c.porRisco[0].atrasoPct).toBe(50);
    expect(c.iaXPiso[0]).toMatchObject({ iaRestringe: true, pisoHoje: null, atrasoPct: null });
    expect(c.prospectivo.titulosMaduros).toBe(0);
    expect(c.janela.toleranciaDias).toBe(5);
  });

  it('fila disponível lê os números', () => {
    const raw = { ...base, fila: { disponivel: true, abertas: 2, aberta_mais_antiga: '2026-11-25T10:00:00Z', decididas_periodo: 5 } };
    expect(lerPainelCredito(raw as unknown as Json).fila).toEqual({
      disponivel: true, abertas: 2, abertaMaisAntiga: '2026-11-25T10:00:00Z', decididasPeriodo: 5,
    });
  });

  it('marca parcial SC e cobertura parcial dos liberados', () => {
    const p = lerPainelCredito(base as unknown as Json);
    expect(p.exposicao.grupos[0].parcialColacorSc).toBe(true);
    expect(p.liberados.coberturaParcial).toBe(true);
  });

  it('bloco obrigatório ausente lança com a marca do ramo (não devolve painel zerado)', () => {
    const { exposicao: _e, ...semExp } = base;
    expect(() => lerPainelCredito(semExp as unknown as Json)).toThrow(/bloco obrigatório ausente/);
    expect(() => lerPainelCredito(null)).toThrow(/resposta vazia/);
  });
});

describe('formatação sem fabricar zero', () => {
  it('num aceita number/string numérica e recusa o resto', () => {
    expect(num(12.5)).toBe(12.5);
    expect(num('7')).toBe(7);
    expect(num('')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(Number.NaN)).toBeNull();
  });
  it('brl/int de null é travessão; parcial prefixa ≥', () => {
    expect(brl(null)).toBe('—');
    expect(int(null)).toBe('—');
    expect(brl(1000, true).startsWith('≥ ')).toBe(true);
    expect(brl(0)).not.toBe('—');
  });
});
