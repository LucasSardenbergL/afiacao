import { describe, it, expect } from 'vitest';
import { churnConhecido, proporcaoChurnBaixo } from '../churn';

/**
 * `churn_risk` está 100% preenchido em prod hoje (6.633/6.633), então estes testes fixam
 * comportamento que ainda não é exercido por dado real — são a prova de que a DEFESA funciona no
 * dia em que o produtor mudar, não a prova de um bug corrente. A distinção está no helper.
 */
describe('churnConhecido', () => {
  it('preserva 0 como veredito conhecido, não como ausência', () => {
    // O ponto central: 0 é "cliente sem risco", o MELHOR resultado. Tratá-lo como ausente foi
    // exatamente o que `churn_risk || 100` fazia — invertia o melhor cliente no pior.
    expect(churnConhecido(0)).toBe(0);
  });

  it('devolve o número quando conhecido', () => {
    expect(churnConhecido(96)).toBe(96);
    expect(churnConhecido('33')).toBe(33);
  });

  it('devolve null para ausente ou não-finito', () => {
    expect(churnConhecido(null)).toBeNull();
    expect(churnConhecido(undefined)).toBeNull();
    expect(churnConhecido(NaN)).toBeNull();
    expect(churnConhecido(Infinity)).toBeNull();
  });
});

describe('o guard relacional que o helper existe para permitir', () => {
  it('fixa o hazard: `null < 30` é TRUE em JS (null coage a 0)', () => {
    // Não é curiosidade — é a razão de o helper devolver null em vez de um número. Um consumidor
    // que faça `if (churn < 30)` direto sobre a coluna classifica o NÃO-MEDIDO como risco baixo.
    expect((null as unknown as number) < 30).toBe(true);
  });

  it('com o helper, ausente não passa por risco baixo — a checagem fica explícita', () => {
    const desconhecido = churnConhecido(null);
    expect(desconhecido != null && desconhecido < 30).toBe(false);

    const conhecidoBaixo = churnConhecido(10);
    expect(conhecidoBaixo != null && conhecidoBaixo < 30).toBe(true);

    // E 0 — o melhor cliente — continua contando como risco baixo, não como ausência.
    const semRisco = churnConhecido(0);
    expect(semRisco != null && semRisco < 30).toBe(true);
  });
});

describe('proporcaoChurnBaixo', () => {
  it('conta numerador e denominador sobre a MESMA base conhecida', () => {
    // 2 conhecidos abaixo de 30 (10, 20), 2 conhecidos acima (80, 90), 2 desconhecidos.
    const r = proporcaoChurnBaixo([10, 20, 80, 90, null, undefined], 30);
    expect(r).toEqual({ abaixo: 2, comRisco: 4 });
    // 2/4 = 50%. A forma errada (denominador = 6) daria 33% — plausível e sistematicamente baixo.
    expect(Math.round((r.abaixo / r.comRisco) * 100)).toBe(50);
  });

  it('conta o risco ZERO como baixo — não como desconhecido', () => {
    const r = proporcaoChurnBaixo([0, 90], 30);
    expect(r).toEqual({ abaixo: 1, comRisco: 2 });
  });

  it('não classifica desconhecido como risco baixo', () => {
    // `null < 30` é true em JS. Sem o guard, estes dois entrariam como "churn baixo".
    const r = proporcaoChurnBaixo([null, undefined], 30);
    expect(r).toEqual({ abaixo: 0, comRisco: 0 });
  });

  it('devolve base zero quando nenhum risco é conhecido (o consumidor decide o que exibir)', () => {
    expect(proporcaoChurnBaixo([], 30)).toEqual({ abaixo: 0, comRisco: 0 });
  });
});
