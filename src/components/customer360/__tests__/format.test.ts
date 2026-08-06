import { describe, it, expect } from 'vitest';
import { formatarFracaoPct, churnTone } from '../format';

/**
 * Estes dois formatadores nasceram de UMA função que adivinhava a unidade do valor
 * (`formatPctMaybe`, com `v > 1 ? v : v * 100`). A adivinhação erra sempre que o valor legítimo
 * cai do outro lado da fronteira — e as duas entradas reais caem em lados OPOSTOS: taxa de
 * conversão e variação MoM são FRAÇÃO; `farmer_client_scores.churn_risk` é PERCENTUAL.
 *
 * Por isso são duas funções com contrato no nome, e não uma com heurística: no call-site,
 * `formatarFracaoPct(x)` diz qual unidade `x` tem — `formatPctMaybe(x)` não dizia.
 */
describe('formatarFracaoPct — entrada é FRAÇÃO, sempre × 100', () => {
  it('converte fração em percentual', () => {
    expect(formatarFracaoPct(0.3)).toBe('30%');
    expect(formatarFracaoPct(0.155)).toBe('15.5%');
    expect(formatarFracaoPct(0)).toBe('0%');
  });

  it('não trunca fração MAIOR que 1 — o bug que motivou o contrato', () => {
    // `variacaoPct` (lib/dashboard/team-kpis) é (atual−anterior)/anterior: não tem teto.
    // Sob a heurística antiga tudo acima de 1 caía no ramo "já é percentual" e saía com DUAS
    // ordens de grandeza a menos.
    expect(formatarFracaoPct(1)).toBe('100%');
    expect(formatarFracaoPct(2)).toBe('200%');
    // Pior caso REAL medido em prod (2026-07-21): colacor no dia 01/07/2026 cresceu 11.553%
    // sobre o mesmo período de junho, e o tile exibia "115.5%".
    expect(formatarFracaoPct(115.53)).toBe('11553%');
  });

  it('preserva o sinal de fração negativa', () => {
    expect(formatarFracaoPct(-0.25)).toBe('-25%');
  });

  it('devolve travessão para ausente — nunca 0%', () => {
    expect(formatarFracaoPct(null)).toBe('—');
    expect(formatarFracaoPct(undefined)).toBe('—');
    expect(formatarFracaoPct(NaN)).toBe('—');
  });
});

describe('churnTone — entrada é PERCENTUAL 0–100', () => {
  it('usa o valor como percentual, sem multiplicar', () => {
    // Faixa real da coluna em prod (2026-07-21): mín. 33, máx. 100, média 96,03.
    expect(churnTone(96)).toEqual({ label: '96% risco churn', className: 'text-status-error-bold' });
    expect(churnTone(33)).toEqual({ label: '33% risco churn', className: 'text-status-success-bold' });
  });

  it('não inverte risco BAIXO em máximo — defesa hoje inerte', () => {
    // Sob a heurística antiga, 1 não passava no `> 1` e virava "100% risco churn" em VERMELHO:
    // o menor risco possível exibido como o maior, com o tom de alarme junto. Nenhuma linha em
    // prod está hoje na faixa 0–1 (0 de 6.632), então isto é defesa do futuro, não correção de
    // sintoma observado — o produtor pode passar a emitir a faixa baixa sem avisar o consumidor.
    expect(churnTone(1)).toEqual({ label: '1% risco churn', className: 'text-status-success-bold' });
    expect(churnTone(0)).toEqual({ label: '0% risco churn', className: 'text-status-success-bold' });
  });

  it('classifica pelas faixas de atenção', () => {
    expect(churnTone(70).className).toBe('text-status-error-bold');
    expect(churnTone(40).className).toBe('text-status-warning-bold');
    expect(churnTone(39).className).toBe('text-status-success-bold');
  });

  it('devolve travessão para ausente', () => {
    expect(churnTone(null).label).toBe('—');
    expect(churnTone(NaN).label).toBe('—');
  });
});
