import { describe, expect, it } from 'vitest';
import {
  montarContasUti,
  UTI_CRITERIOS,
  type AliasRow,
  type ProfileRow,
  type ScoreRow,
  type SnapshotRow,
  type TituloRow,
  type VinculoRow,
} from '../useUtiContas';

const score = (over: Partial<ScoreRow> & { customer_user_id: string }): ScoreRow => ({
  farmer_id: 'farmer-1',
  health_score: 50,
  health_class: 'estavel',
  priority_score: 10,
  churn_risk: 0,
  days_since_last_purchase: 10,
  calculated_at: '2026-07-01T00:00:00Z',
  ...over,
});

const perfil = (over: Partial<ProfileRow> & { user_id: string }): ProfileRow => ({
  name: 'Cliente Teste',
  razao_social: null,
  document: '12.345.678/0001-90',
  cnpj: null,
  ...over,
});

// O título do Omie NÃO traz documento (cnpj_cpf = '' em 100% da prod): só empresa + código do cadastro.
const titulo = (company: string, codigo: number | null, saldo: number | null): TituloRow => ({
  company,
  omie_codigo_cliente: codigo,
  saldo,
});

const vinculo = (account: string, codigo: number, userId: string): VinculoRow => ({
  account,
  omie_codigo_cliente: codigo,
  user_id: userId,
});

const alias = (aliasUserId: string, canonicalUserId: string, status = 'active'): AliasRow => ({
  alias_user_id: aliasUserId,
  canonical_user_id: canonicalUserId,
  status,
});

// c1 = código 100 na oben e 200 na colacor; c2 = 300 na oben; c3 = 400 na oben.
const VINCULOS: VinculoRow[] = [
  vinculo('oben', 100, 'c1'),
  vinculo('colacor', 200, 'c1'),
  vinculo('oben', 300, 'c2'),
  vinculo('oben', 400, 'c3'),
];

const montar = (input: Partial<Parameters<typeof montarContasUti>[0]>) =>
  montarContasUti({ scores: [], perfis: [], titulos: [], vinculos: VINCULOS, aliases: [], snapshots: [], ...input });

const snap = (customer: string, mes: string, hadOrder: boolean, eligible = true): SnapshotRow => ({
  customer_user_id: customer,
  mes,
  eligible,
  had_order_in_month: hadOrder,
});

describe('montarContasUti', () => {
  it('entra na UTI com 2 sinais (churn + inadimplência), casando por empresa + código Omie (soma do grupo)', () => {
    const { contas } = montar({
      scores: [score({ customer_user_id: 'c1', churn_risk: UTI_CRITERIOS.churnRiskMin })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [titulo('oben', 100, 500), titulo('colacor', 200, 250)],
      snapshots: [],
    });
    expect(contas).toHaveLength(1);
    expect(contas[0].status).toBe('uti');
    expect(contas[0].sinalChurn).toBe(true);
    expect(contas[0].sinalInadimplencia).toBe(true);
    expect(contas[0].vencido31).toBe(750);
    expect(contas[0].sinalPositivacao).toBeNull(); // sem snapshot = sem dado, não false
  });

  it('health_class critico ativa churn mesmo com churn_risk baixo', () => {
    const { contas } = montar({
      scores: [score({ customer_user_id: 'c1', churn_risk: 5, health_class: 'critico' })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [],
    });
    expect(contas[0]?.sinalChurn).toBe(true);
  });

  it('1 sinal só = observação, não UTI', () => {
    const { contas } = montar({
      scores: [score({ customer_user_id: 'c1', churn_risk: 90 })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [],
    });
    expect(contas[0].status).toBe('observacao');
  });

  it('0 sinais = alta (não aparece na lista)', () => {
    const { contas } = montar({
      scores: [score({ customer_user_id: 'c1', churn_risk: 10 })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [],
    });
    expect(contas).toHaveLength(0);
  });

  it('reprodução do Codex: cliente SEM documento no profile ainda casa pelo código (uti/true/750)', () => {
    const { contas } = montar({
      scores: [score({ customer_user_id: 'c1', churn_risk: 90 })],
      perfis: [perfil({ user_id: 'c1', document: '', cnpj: null })],
      titulos: [titulo('oben', 100, 500), titulo('colacor', 200, 250)],
      snapshots: [],
    });
    expect([contas[0].status, contas[0].sinalInadimplencia, contas[0].vencido31]).toEqual(['uti', true, 750]);
  });

  it('positivação ativa com 2 meses elegíveis sem pedido', () => {
    const { contas } = montar({
      scores: [score({ customer_user_id: 'c1', churn_risk: 90 })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [snap('c1', '2026-06-01', false), snap('c1', '2026-05-01', false), snap('c1', '2026-04-01', true)],
    });
    expect(contas[0].sinalPositivacao).toBe(true);
    expect(contas[0].mesesSemPedido).toBe(2);
    expect(contas[0].status).toBe('uti');
  });

  it('positivação com pedido no mês mais recente fica false (não null)', () => {
    const { contas } = montar({
      scores: [score({ customer_user_id: 'c1', churn_risk: 90 })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [snap('c1', '2026-06-01', true), snap('c1', '2026-05-01', false)],
    });
    expect(contas[0].sinalPositivacao).toBe(false);
    expect(contas[0].mesesSemPedido).toBe(0);
  });

  it('histórico insuficiente (1 mês elegível) = sem dado, não conclui', () => {
    const { contas } = montar({
      scores: [score({ customer_user_id: 'c1', churn_risk: 90 })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [snap('c1', '2026-06-01', false), snap('c1', '2026-05-01', false, false)],
    });
    expect(contas[0].sinalPositivacao).toBeNull();
    expect(contas[0].mesesSemPedido).toBeNull();
  });

  it('dedup de spine: cliente com score por 2 farmers fica com o de maior prioridade', () => {
    const { contas } = montar({
      scores: [
        score({ customer_user_id: 'c1', farmer_id: 'farmer-a', priority_score: 5, churn_risk: 90 }),
        score({ customer_user_id: 'c1', farmer_id: 'farmer-b', priority_score: 20, churn_risk: 90 }),
      ],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [],
    });
    expect(contas).toHaveLength(1);
    expect(contas[0].farmerId).toBe('farmer-b');
  });

  it('ordena por sinais ativos e depois por exposição vencida', () => {
    const { contas } = montar({
      scores: [
        score({ customer_user_id: 'c1', churn_risk: 90 }),
        score({ customer_user_id: 'c2', churn_risk: 90 }),
        score({ customer_user_id: 'c3', churn_risk: 90 }),
      ],
      perfis: [perfil({ user_id: 'c1' }), perfil({ user_id: 'c2' }), perfil({ user_id: 'c3' })],
      titulos: [titulo('oben', 300, 100), titulo('oben', 400, 900)],
      snapshots: [],
    });
    expect(contas.map((c) => c.customerUserId)).toEqual(['c3', 'c2', 'c1']);
  });

  it('frescor: scoresCalculatedAt é o mais recente e positivacaoMes o maior mês', () => {
    const r = montar({
      scores: [
        score({ customer_user_id: 'c1', churn_risk: 90, calculated_at: '2026-06-01T00:00:00Z' }),
        score({ customer_user_id: 'c2', churn_risk: 90, calculated_at: '2026-07-01T12:00:00Z' }),
      ],
      perfis: [],
      titulos: [],
      snapshots: [snap('c1', '2026-05-01', true), snap('c1', '2026-06-01', true)],
    });
    expect(r.scoresCalculatedAt).toBe('2026-07-01T12:00:00Z');
    expect(r.positivacaoMes).toBe('2026-06-01');
  });
});

describe('montarContasUti — atribuição por código Omie (ausente ≠ zero)', () => {
  const churn = (id: string) => score({ customer_user_id: id, churn_risk: 90 });

  it('atribuição completa: cliente sem título vencido é adimplente observado (false/0), não "sem dado"', () => {
    const r = montar({ scores: [churn('c1'), churn('c2')], titulos: [titulo('oben', 300, 100)] });
    const c1 = r.contas.find((c) => c.customerUserId === 'c1');
    expect([c1?.sinalInadimplencia, c1?.vencido31]).toEqual([false, 0]);
    expect(r.recebiveisSemCliente).toEqual({ titulos: 0, saldo: 0 });
  });

  it('título com código SEM vínculo: suspende o "ok" de quem não tem dívida atribuída (null), e a dívida atribuída segue sinal', () => {
    const r = montar({
      scores: [churn('c1'), churn('c2')],
      titulos: [titulo('oben', 300, 100), titulo('oben', 999, 40)],
    });
    const c1 = r.contas.find((c) => c.customerUserId === 'c1');
    const c2 = r.contas.find((c) => c.customerUserId === 'c2');
    expect([c1?.sinalInadimplencia, c1?.vencido31, c1?.status]).toEqual([null, null, 'observacao']);
    expect([c2?.sinalInadimplencia, c2?.vencido31, c2?.status]).toEqual([true, 100, 'uti']);
    expect(r.recebiveisSemCliente).toEqual({ titulos: 1, saldo: 40 });
  });

  it('título sem código Omie também é órfão (não some)', () => {
    const r = montar({ scores: [churn('c1')], titulos: [titulo('oben', null, 70)] });
    expect(r.contas[0].sinalInadimplencia).toBeNull();
    expect(r.recebiveisSemCliente).toEqual({ titulos: 1, saldo: 70 });
  });

  it('código igual em empresas diferentes NÃO mistura donos (a chave é empresa + código)', () => {
    // 100 na oben é c1; 100 na colacor_sc não tem vínculo → órfão, não vai para c1.
    const r = montar({ scores: [churn('c1')], titulos: [titulo('colacor_sc', 100, 60)] });
    expect([r.contas[0].sinalInadimplencia, r.contas[0].vencido31]).toEqual([null, null]);
    expect(r.recebiveisSemCliente.titulos).toBe(1);
  });

  it('vínculo ambíguo (2 users no mesmo cadastro) não escolhe um: título vira órfão', () => {
    const r = montar({
      scores: [churn('c1'), churn('c2')],
      vinculos: [...VINCULOS, vinculo('oben', 100, 'c2')],
      titulos: [titulo('oben', 100, 500)],
    });
    for (const c of r.contas) expect([c.sinalInadimplencia, c.vencido31]).toEqual([null, null]);
    expect(r.recebiveisSemCliente).toEqual({ titulos: 1, saldo: 500 });
  });

  it('saldo nulo não vira 0: o título conta como sem cliente identificado', () => {
    const r = montar({ scores: [churn('c1')], titulos: [titulo('oben', 100, null)] });
    expect(r.contas[0].sinalInadimplencia).toBeNull();
    expect(r.recebiveisSemCliente.titulos).toBe(1);
  });

  it('alias fiscal ATIVO: título do cadastro-alias soma no canônico e o score-clone sai do spine', () => {
    const r = montar({
      scores: [churn('c1'), score({ customer_user_id: 'a1', churn_risk: 100, priority_score: 999 })],
      vinculos: [...VINCULOS, vinculo('colacor_sc', 500, 'a1')],
      aliases: [alias('a1', 'c1')],
      titulos: [titulo('oben', 100, 500), titulo('colacor_sc', 500, 250)],
    });
    expect(r.contas.map((c) => c.customerUserId)).toEqual(['c1']);
    expect([r.contas[0].sinalInadimplencia, r.contas[0].vencido31]).toEqual([true, 750]);
    expect(r.recebiveisSemCliente.titulos).toBe(0);
  });

  it('alias ativo cujo canônico NÃO está no spine: a linha do alias fica e enxerga a dívida do canônico', () => {
    const r = montar({
      scores: [score({ customer_user_id: 'a1', churn_risk: 100 })],
      aliases: [alias('a1', 'c1')],
      titulos: [titulo('oben', 100, 500)],
    });
    expect(r.contas.map((c) => [c.customerUserId, c.vencido31, c.status])).toEqual([['a1', 500, 'uti']]);
  });

  it('alias em CONFLITO: identidade ambígua → título órfão e o próprio cliente "sem dado"', () => {
    const r = montar({
      scores: [churn('a1'), churn('c2')],
      vinculos: [...VINCULOS, vinculo('colacor_sc', 500, 'a1')],
      aliases: [alias('a1', 'c1', 'conflict')],
      titulos: [titulo('colacor_sc', 500, 250)],
    });
    const a1 = r.contas.find((c) => c.customerUserId === 'a1');
    expect([a1?.sinalInadimplencia, a1?.vencido31]).toEqual([null, null]);
    expect(r.recebiveisSemCliente).toEqual({ titulos: 1, saldo: 250 });
  });

  it('alias INATIVO não dobra: o título fica com o user do vínculo', () => {
    const r = montar({
      scores: [churn('a1'), churn('c1')],
      vinculos: [...VINCULOS, vinculo('colacor_sc', 500, 'a1')],
      aliases: [alias('a1', 'c1', 'inactive')],
      titulos: [titulo('colacor_sc', 500, 250)],
    });
    const porId = Object.fromEntries(r.contas.map((c) => [c.customerUserId, c.vencido31]));
    expect(porId).toEqual({ a1: 250, c1: 0 });
  });
});
