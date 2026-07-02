import { describe, expect, it } from 'vitest';
import { montarContasUti, UTI_CRITERIOS, type ProfileRow, type ScoreRow, type SnapshotRow, type TituloRow } from '../useUtiContas';

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

const titulo = (cnpj: string, saldo: number): TituloRow => ({ cnpj_cpf: cnpj, saldo });

const snap = (customer: string, mes: string, hadOrder: boolean, eligible = true): SnapshotRow => ({
  customer_user_id: customer,
  mes,
  eligible,
  had_order_in_month: hadOrder,
});

describe('montarContasUti', () => {
  it('entra na UTI com 2 sinais (churn + inadimplência), casando CNPJ normalizado', () => {
    const { contas } = montarContasUti({
      scores: [score({ customer_user_id: 'c1', churn_risk: UTI_CRITERIOS.churnRiskMin })],
      perfis: [perfil({ user_id: 'c1' })],
      // Omie manda formatado diferente do profile — o match é só-dígitos
      titulos: [titulo('12345678000190', 500), titulo('12.345.678/0001-90', 250)],
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
    const { contas } = montarContasUti({
      scores: [score({ customer_user_id: 'c1', churn_risk: 5, health_class: 'critico' })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [],
    });
    expect(contas[0]?.sinalChurn).toBe(true);
  });

  it('1 sinal só = observação, não UTI', () => {
    const { contas } = montarContasUti({
      scores: [score({ customer_user_id: 'c1', churn_risk: 90 })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [],
    });
    expect(contas[0].status).toBe('observacao');
  });

  it('0 sinais = alta (não aparece na lista)', () => {
    const { contas } = montarContasUti({
      scores: [score({ customer_user_id: 'c1', churn_risk: 10 })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [],
    });
    expect(contas).toHaveLength(0);
  });

  it('ausente ≠ zero: cliente sem CNPJ tem sinal de inadimplência null, não false', () => {
    const { contas } = montarContasUti({
      scores: [score({ customer_user_id: 'c1', churn_risk: 90 })],
      perfis: [perfil({ user_id: 'c1', document: null, cnpj: null })],
      titulos: [titulo('12345678000190', 999)],
      snapshots: [],
    });
    expect(contas[0].sinalInadimplencia).toBeNull();
    expect(contas[0].vencido31).toBe(0);
    expect(contas[0].status).toBe('observacao'); // null não conta como sinal ativo
  });

  it('positivação ativa com 2 meses elegíveis sem pedido', () => {
    const { contas } = montarContasUti({
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
    const { contas } = montarContasUti({
      scores: [score({ customer_user_id: 'c1', churn_risk: 90 })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [snap('c1', '2026-06-01', true), snap('c1', '2026-05-01', false)],
    });
    expect(contas[0].sinalPositivacao).toBe(false);
    expect(contas[0].mesesSemPedido).toBe(0);
  });

  it('histórico insuficiente (1 mês elegível) = sem dado, não conclui', () => {
    const { contas } = montarContasUti({
      scores: [score({ customer_user_id: 'c1', churn_risk: 90 })],
      perfis: [perfil({ user_id: 'c1' })],
      titulos: [],
      snapshots: [snap('c1', '2026-06-01', false), snap('c1', '2026-05-01', false, false)],
    });
    expect(contas[0].sinalPositivacao).toBeNull();
    expect(contas[0].mesesSemPedido).toBeNull();
  });

  it('dedup de spine: cliente com score por 2 farmers fica com o de maior prioridade', () => {
    const { contas } = montarContasUti({
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
    const { contas } = montarContasUti({
      scores: [
        score({ customer_user_id: 'c1', churn_risk: 90 }),
        score({ customer_user_id: 'c2', churn_risk: 90 }),
        score({ customer_user_id: 'c3', churn_risk: 90 }),
      ],
      perfis: [
        perfil({ user_id: 'c1', document: '11111111000111' }),
        perfil({ user_id: 'c2', document: '22222222000122' }),
        perfil({ user_id: 'c3', document: '33333333000133' }),
      ],
      titulos: [titulo('22222222000122', 100), titulo('33333333000133', 900)],
      snapshots: [],
    });
    expect(contas.map((c) => c.customerUserId)).toEqual(['c3', 'c2', 'c1']);
  });

  it('frescor: scoresCalculatedAt é o mais recente e positivacaoMes o maior mês', () => {
    const r = montarContasUti({
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
