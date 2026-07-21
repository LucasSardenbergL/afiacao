import { describe, it, expect } from 'vitest';
import { selectObjective, clampRecencyCapDays } from '../objective';

describe('clampRecencyCapDays', () => {
  it('default 180 quando ausente/null/NaN (money-path: Number(null)===0 fabricaria fronteira de 30)', () => {
    expect(clampRecencyCapDays(undefined)).toBe(180);
    expect(clampRecencyCapDays(null)).toBe(180);
    expect(clampRecencyCapDays('abc')).toBe(180);
    expect(clampRecencyCapDays(NaN)).toBe(180);
  });

  it('passa valor válido (string ou número) e arredonda', () => {
    expect(clampRecencyCapDays(180)).toBe(180);
    expect(clampRecencyCapDays('365')).toBe(365);
    expect(clampRecencyCapDays(90.6)).toBe(91);
  });

  it('guardrail [30, 999]', () => {
    expect(clampRecencyCapDays(10)).toBe(30);
    expect(clampRecencyCapDays(5000)).toBe(999);
  });
});

describe('selectObjective — fronteira recuperacao/reativacao ancorada no teto de recência', () => {
  const cap = 180; // hs_recency_cap_days default

  it('reativacao SOMENTE quando days >= cap (recência saturada em 0 → dormência plena vence churn)', () => {
    expect(selectObjective(70, 0, 30, 30, 180, cap)).toBe('reativacao');
    // Um dia antes do teto: recência ainda viva → lente de churn.
    expect(selectObjective(70, 0, 30, 30, 179, cap)).toBe('recuperacao');
  });

  it('mata o degrau artificial dos 90 dias: 90..179 são consistentemente recuperacao', () => {
    // Bug antigo (daysSince > 90): 90→recuperacao, 91→reativacao (flip de 1 dia).
    expect(selectObjective(70, 0, 30, 30, 90, cap)).toBe('recuperacao');
    expect(selectObjective(70, 0, 30, 30, 91, cap)).toBe('recuperacao');
    expect(selectObjective(70, 0, 30, 30, 120, cap)).toBe('recuperacao');
  });

  it('resgata o cliente dormente-mas-forte (churn baixo) que o churn>60 perderia', () => {
    // Recência 0 mas histórico ótimo → churn ~25; sem o gate de dias viraria upsell (errado).
    // O gate de dias vem ANTES do churn de propósito.
    expect(selectObjective(25, 0, 50, 30, 200, cap)).toBe('reativacao');
  });

  it('a fronteira ACOMPANHA o teto (dinâmico): retune de T move o corte — prova que 180 hardcoded estaria errado', () => {
    // Com T=365, 200 dias ainda não satura → recuperacao, não reativacao.
    expect(selectObjective(70, 0, 30, 30, 200, 365)).toBe('recuperacao');
    expect(selectObjective(70, 0, 30, 30, 365, 365)).toBe('reativacao');
    // O caso que um `daysSince >= 180` fixo classificaria erradamente como reativacao:
    expect(selectObjective(70, 0, 30, 30, 180, 365)).toBe('recuperacao');
  });

  it('sem_historico → ativacao, PRECEDE tudo (mesmo days>=cap e churn alto)', () => {
    expect(selectObjective(95, 5, 10, 30, 999, cap, 'sem_historico')).toBe('ativacao');
    // ativo/stale/null não disparam ativacao → a regra de recência segue valendo
    expect(selectObjective(70, 0, 30, 30, 180, cap, 'ativo')).toBe('reativacao');
    expect(selectObjective(70, 0, 30, 30, 180, cap, null)).toBe('reativacao');
  });

  it('preserva as demais regras na ordem (churn > mixGap > margem > upsell)', () => {
    expect(selectObjective(70, 5, 30, 30, 10, cap)).toBe('recuperacao');        // churn>60 vence mixGap
    expect(selectObjective(50, 5, 30, 30, 10, cap)).toBe('expansao_mix');       // mixGap>3
    expect(selectObjective(50, 2, 20, 30, 10, cap)).toBe('consolidacao_margem'); // margem < cluster*0.8 (24)
    expect(selectObjective(50, 2, 30, 30, 10, cap)).toBe('upsell_premium');     // nada dispara
  });

  it('teto ausente → default 180 via clamp: cliente em 180d sem config ainda reativa', () => {
    expect(selectObjective(70, 0, 30, 30, 180, clampRecencyCapDays(undefined))).toBe('reativacao');
    expect(selectObjective(70, 0, 30, 30, 179, clampRecencyCapDays(undefined))).toBe('recuperacao');
  });
});

describe('selectObjective — cluster AUSENTE (null) degrada honesto (money-path: ausente ≠ fabricado)', () => {
  const cap = 180;

  it('cluster null NÃO dispara consolidacao_margem — nem com margem negativa (null não coage a 0)', () => {
    // Antes o caller passava 25 mágico p/ carteira vazia; agora passa null quando o cluster do
    // dono não existe. A margem negativa é o discriminador: sem o guard, `-5 < null*0.8 (=0)`
    // viraria consolidacao a esmo.
    expect(selectObjective(0, 0, 10, null, 0, cap)).toBe('upsell_premium');
    expect(selectObjective(0, 0, -5, null, 0, cap)).toBe('upsell_premium');
  });

  it('cluster presente baixo ainda dispara consolidacao quando margem < cluster*0.8', () => {
    expect(selectObjective(0, 0, 10, 25, 0, cap)).toBe('consolidacao_margem'); // 10 < 20
  });

  it('margem do CLIENTE null NÃO dispara consolidacao_margem (null < 24 é true em JS)', () => {
    // Simétrico ao cluster ausente, e a via que o #1495 abre: pós-produtor, ~84% dos clientes
    // ficam sem margem. Sem o guard, `null < cluster*0.8` coage null a 0 e TODO cliente sem
    // custo apurado receberia o objetivo "consolidar margem" — uma tese sobre a margem dele
    // afirmada justamente por não conhecê-la.
    expect(selectObjective(50, 2, null, 30, 10, cap)).toBe('upsell_premium');
    expect(selectObjective(0, 0, null, 25, 0, cap)).toBe('upsell_premium');
  });

  it('margem 0 CONHECIDA continua disparando consolidacao (0 é veredito, não ausência)', () => {
    expect(selectObjective(0, 0, 0, 25, 0, cap)).toBe('consolidacao_margem'); // 0 < 20
  });
});
