import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Guard de REGRESSÃO textual sobre a UNIDADE de `farmer_client_scores.churn_risk`.
//
// A coluna é PERCENTUAL 0–100. Medido em prod (2026-07-21): 6.632/6.632 linhas acima de 1,
// mínimo 33, máximo 100, média 96,03 — zero nulos, zero zeros. Mesmo assim dois consumidores a
// liam como FRAÇÃO e multiplicavam por 100: `Customer360View` exibia "9600%" e mantinha o realce
// de perigo (`churn_risk > 0.5`) permanentemente ligado.
//
// Por que textual: a unidade não está no tipo. `churn_risk` é `number` de um lado e do outro, e
// `number * 100` é `number` — o typecheck fica verde em ambas as leituras. Foi assim que as duas
// convenções opostas conviveram no mesmo código lendo a mesma coluna. Mesma razão do irmão
// `margem-sem-coacao.test.ts` (também sobre farmer_client_scores).
//
// Escopo deliberadamente estreito: só a MULTIPLICAÇÃO da coluna de churn, nos arquivos listados.
// Quem tem teste unitário próprio (`churnTone`, em customer360/format) não entra aqui — lá o
// contrato é verificado por comportamento, que é mais forte que texto.

const RAIZ = resolve(__dirname, '../../../..');

/** Consumidores de `churn_risk` sem teste unitário próprio (componente/hook com query no meio). */
const CONSUMIDORES = [
  'src/components/adminCustomers/Customer360View.tsx',
  'src/components/farmer/ClientesAPositivarCard.tsx',
  'src/components/farmer/tacticalPlan/useFarmerTacticalPlan.ts',
  'src/hooks/useFarmerPerformance.ts',
];

/** Remove comentários antes de casar: um `* 100` citado em comentário que explica o bug
 *  produziria falso-vermelho. Mesma lição do #1488 — assert sobre texto mede prosa se não
 *  normalizar antes. */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Casa a coluna de churn multiplicada por 100 — a conversão fração→percentual de um valor que
 *  JÁ é percentual.
 *
 *  ⚠️ Ancorado no NOME do campo, não num `* 100` solto: multiplicar por 100 é legítimo em toda
 *  parte do app, e um predicado que varre a vizinhança reprova código correto e ensina a ignorar
 *  o vermelho — aí o próximo vermelho, o real, vira ruído (money-path, §"o VALIDADOR mente",
 *  #1490). Tolera o `?? 0` no meio (`(c.churn_risk ?? 0) * 100`), que é a forma que apareceria
 *  num refactor. */
const MULTIPLICACAO = /(?:churn_risk|churnRisk)\s*(?:\?\?\s*[\d.]+\s*)?\)?\s*\*\s*100/;

describe('consumidores de churn_risk não tratam a coluna como fração', () => {
  it.each(CONSUMIDORES)('%s não multiplica churn_risk por 100', (relativo) => {
    const fonte = semComentarios(readFileSync(resolve(RAIZ, relativo), 'utf8'));
    const ofensoras = fonte
      .split('\n')
      .map((linha, i) => ({ linha: linha.trim(), n: i + 1 }))
      .filter(({ linha }) => MULTIPLICACAO.test(linha));

    expect(
      ofensoras,
      `churn_risk tratado como fração em ${relativo}:\n` +
        ofensoras.map((o) => `  linha ${o.n}: ${o.linha}`).join('\n') +
        '\n\nA coluna é PERCENTUAL 0–100 (prod: mín. 33, máx. 100, média 96). ' +
        'Multiplicar por 100 exibe "9600%". Para formatar, use churnTone ' +
        '(@/components/customer360/format), que declara a unidade no contrato.',
    ).toEqual([]);
  });
});

describe('o guard textual tem dente', () => {
  // Falsificação embutida: se o regex parasse de casar (typo, refactor do padrão), a suíte acima
  // ficaria verde para sempre e ninguém notaria. Estes casos fixam o que ele detecta.
  it('detecta as formas que já existiram no código', () => {
    // A forma exata que estava em Customer360View.tsx:135 antes desta correção.
    expect(MULTIPLICACAO.test('value={`${(score.churn_risk * 100).toFixed(0)}%`}')).toBe(true);
    expect(MULTIPLICACAO.test('const pct = s.churn_risk * 100;')).toBe(true);
    expect(MULTIPLICACAO.test('(c.churn_risk ?? 0) * 100')).toBe(true);
    expect(MULTIPLICACAO.test('Math.round(churnRisk * 100)')).toBe(true);
  });

  it('não acusa uso legítimo', () => {
    expect(MULTIPLICACAO.test('churnTone(s?.churn_risk ?? null)')).toBe(false);
    expect(MULTIPLICACAO.test('(c.churn_risk ?? 0) >= 60')).toBe(false);
    expect(MULTIPLICACAO.test('Number(c.churn_risk || 100) < 30')).toBe(false);
    // Outra coluna multiplicada por 100 é legítima — o guard é da coluna de churn, não do `* 100`.
    expect(MULTIPLICACAO.test('const share = ratio * 100;')).toBe(false);
    expect(MULTIPLICACAO.test('score.health_score * 100')).toBe(false);
  });

  it('ignora multiplicação citada em comentário (senão o próprio aviso vira vermelho)', () => {
    const fonte = semComentarios('// nunca faça churn_risk * 100 aqui\nconst x = 1;');
    expect(MULTIPLICACAO.test(fonte)).toBe(false);
  });
});
