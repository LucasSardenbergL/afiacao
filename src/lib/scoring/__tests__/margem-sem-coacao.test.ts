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

const RAIZ = resolve(__dirname, '../../../..');

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
        '\n\nUse margemConhecida() de @/lib/scoring/margin. `0` é o veredito ' +
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

// ── Paginação dos consumidores de margem ──────────────────────────────────────
// O PostgREST capa em 1.000 linhas em SILÊNCIO e `.limit(500)` corta antes disso. Nenhum dos
// dois falha, loga ou muda de forma — a lista só vem menor, e a média sai de uma amostra.
// Não há teste unitário viável (a query é feita dentro do hook/componente contra o supabase),
// então o guard é textual: garante que estes três pontos continuam paginando.
//
// Medido em prod (2026-07-21): os três farmers têm 3.858 / 1.528 / 1.246 clientes — todos
// acima do cap —, e as telas liam 500 de 6.632.
describe('consumidores de margem paginam a base inteira', () => {
  const PAGINADOS = [
    ['src/hooks/useTacticalPlan.ts', 'cluster de pares (a régua do veredito de margem)'],
    ['src/components/intelligence/IntelligenceManagerialTab.tsx', 'comparativo entre vendedores'],
    ['src/components/intelligence/IntelligenceStrategicTab.tsx', 'margem bruta média global'],
  ] as const;

  it.each(PAGINADOS)('%s usa fetchAllPages — %s', (relativo) => {
    const fonte = semComentarios(readFileSync(resolve(RAIZ, relativo), 'utf8'));
    expect(
      fonte.includes('fetchAllPages'),
      `${relativo} deixou de paginar. Consulta a farmer_client_scores sem fetchAllPages ` +
        'lê no máximo 1.000 linhas (cap do PostgREST) sem erro nenhum — a média sai de uma ' +
        'amostra e nada na tela indica isso.',
    ).toBe(true);
  });

  // NÃO existe aqui uma asserção "não usa .limit()". Tentei: a chamada é encadeada em várias
  // linhas, então o predicado varria uma janela a partir do `.from('farmer_client_scores')` — e
  // acusou `useTacticalPlan`, onde 5 linhas abaixo há um `.limit(1)` legítimo numa consulta a
  // OUTRA tabela (farmer_algorithm_config). Validador que reprova código correto ensina a
  // ignorar o vermelho, e aí o próximo vermelho — o real — vira ruído (money-path, §"o
  // VALIDADOR mente", #1490). A asserção positiva acima basta: trocar a paginação por .limit()
  // remove o fetchAllPages, e é isso que ela detecta.
});
