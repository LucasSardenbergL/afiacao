import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Guard de REGRESSÃO textual sobre os consumidores de margem que não têm teste unitário
// próprio (hooks com query no meio do caminho, componentes de KPI).
//
// Por que textual: o tipo `number | null` NÃO protege contra `|| 0` e `?? 0` — a coerção
// produz `number`, perfeitamente tipada, e o typecheck passa verde. Foi exatamente assim
// que a coação sobreviveu até aqui. E a lição da cadeia dos bundles é que basta UM `|| 0`
// a montante para tornar inerte o guard que está a jusante (useBundleEngine matava o null
// antes de classificarPerfilCliente poder decidir não decidir).
//
// Escopo deliberadamente estreito: só a coação da COLUNA de margem, nos arquivos listados.
// Não é um linter de estilo — é a trava do invariante "ausente ≠ zero" no money-path.

const RAIZ = resolve(__dirname, '../../..');

/** Arquivos que leem a margem do score e já foram migrados para o helper. */
const CONSUMIDORES = [
  'src/hooks/useBundleEngine.ts',
  'src/hooks/useTacticalPlan.ts',
  'src/hooks/useFarmerScoring.ts',
  'src/lib/carteira/escopo-clientes.ts',
  'src/components/adminCustomers/Customer360View.tsx',
  'src/components/customer360/CustomerHero.tsx',
  'src/components/intelligence/IntelligenceManagerialTab.tsx',
  'src/components/intelligence/IntelligenceStrategicTab.tsx',
  'src/components/farmer/bundles/CustomerBundleCard.tsx',
  'src/components/farmer/copilot/useFarmerCopilot.ts',
];

/** Remove comentários antes de casar: um `|| 0` citado em comentário explicando o bug
 *  produziria falso-vermelho, e o inverso (código escondido em comentário) não existe.
 *  Mesma lição do #1488 — assert sobre texto mede prosa se não normalizar antes. */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Casa coação aplicada à margem PERCENTUAL do cliente — e SÓ a ela.
 *
 *  ⚠️ Escopado a nomes exatos de propósito. A primeira versão casava `[mM]argin` solto e
 *  acusou `actual_margin || 0` e `bundle_incremental_margin || 0`, que são valores em R$ —
 *  para os quais `|| 0` é legítimo (somatório de dinheiro). Predicado que varre a vizinhança
 *  reprova código correto e ensina a ignorar o vermelho (money-path §"o VALIDADOR mente",
 *  #1490). Se um campo percentual novo aparecer, acrescente-o aqui explicitamente. */
const CAMPOS = [
  'gross_margin_pct',
  'grossMarginPct',
  'current_margin_pct',
  'currentMarginPct',
  'marginPct',
  'clusterMargin',
];
const COACAO = new RegExp(`(?:${CAMPOS.join('|')})\\s*(?:\\|\\||\\?\\?)\\s*0`);

describe('consumidores de margem não coagem ausência para zero', () => {
  it.each(CONSUMIDORES)('%s não contém `margem || 0` nem `margem ?? 0`', (relativo) => {
    const fonte = semComentarios(readFileSync(resolve(RAIZ, relativo), 'utf8'));
    const linhas = fonte.split('\n');
    const ofensoras = linhas
      .map((linha, i) => ({ linha: linha.trim(), n: i + 1 }))
      .filter(({ linha }) => COACAO.test(linha));

    expect(
      ofensoras,
      `Coação de margem reintroduzida em ${relativo}:\n` +
        ofensoras.map((o) => `  linha ${o.n}: ${o.linha}`).join('\n') +
        '\n\nUse margemConhecida() de @/lib/margem. `0` é o veredito ' +
        '"cliente não-lucrativo"; ausência é null.',
    ).toEqual([]);
  });
});

describe('o guard textual tem dente', () => {
  // Falsificação embutida: se o regex parasse de casar (typo, refactor do padrão), a suíte
  // acima ficaria verde para sempre e ninguém notaria. Estes casos fixam o que ele detecta.
  it('detecta as formas de coação que já existiram no código', () => {
    expect(COACAO.test('Number(score.gross_margin_pct || 0)')).toBe(true);
    expect(COACAO.test('s.gross_margin_pct ?? 0')).toBe(true);
    expect(COACAO.test('data.grossMarginPct || 0')).toBe(true);
    expect(COACAO.test('const marginPct = Number(score?.gross_margin_pct || 0);')).toBe(true);
  });

  it('não acusa uso legítimo', () => {
    expect(COACAO.test('margemConhecida(score.gross_margin_pct)')).toBe(false);
    expect(COACAO.test('const categoryCount = Number(score.category_count || 0);')).toBe(false);
    expect(COACAO.test('formatarMargemPct(plan.currentMarginPct)')).toBe(false);
  });

  it('ignora coação citada em comentário (senão o próprio aviso vira vermelho)', () => {
    const fonte = semComentarios('// evite gross_margin_pct || 0 aqui\nconst x = 1;');
    expect(COACAO.test(fonte)).toBe(false);
  });
});
