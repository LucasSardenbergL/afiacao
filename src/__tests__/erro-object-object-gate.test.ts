import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Gate estrutural da classe "[object Object]" no tratamento de erro.
//
// A classe: `err instanceof Error ? err.message : String(err)` era o idiom do repo, e ele
// falha **justamente no erro mais comum desta camada**. Sem `.throwOnError()`, o `error`
// do supabase-js NÃO é um `Error`: é um objeto plano `{message, details, hint, code}`
// parseado do JSON (node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts:185
// `error = JSON.parse(body)`; só vira `PostgrestError` no :212, sob `shouldThrowOnError`).
// Logo todo `throw error` / `throw rpcError` cai no ramo `String(err)` e a pessoa lê
// literalmente **"[object Object]"** no toast, no lugar da recusa da RPC ou da RLS.
//
// É a mesma família do "Edge Function returned a non-2xx status code" que
// `@/lib/invoke-function` já resolve do outro lado da fronteira, e a mesma do money-path
// §6/§11: o dado acionável EXISTE, o servidor mandou, e ele morre na fronteira — a
// vendedora fica sem saber se tenta de novo ou avisa a equipe.
//
// Instância que originou o helper: #1642 (useTacticalPlan.generatePlan/recordResult).
// Erradicação em src/: este PR (89 sítios / 47 arquivos).
//
// Por que TEXTUAL (readFileSync, padrão paginacao-artesanal-gate/escrita-critica-gate):
// metade dos sítios vive em edges Deno que o vitest não executa e o tsc do app não checa —
// um teste que lê FONTE cobre as duas metades num contrato só, dentro do CI `validate`.

const RAIZ = resolve(__dirname, '../..');
const DIRS = ['src', 'supabase/functions', 'scripts'];
const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.test\.|_test\.|\.d\.ts$|__tests__|\.stories\.)/;

// Os helpers são a ÚNICA fonte legítima de `String(err)` no repo: é o ramo de último recurso
// DELES, que só roda para primitivo não-objeto (número, symbol, boolean) — exatamente o
// caso em que `String()` produz texto útil e nunca "[object Object]".
//
// São DOIS porque Deno não importa de `src/`: o de `_shared` é o espelho verbatim que o
// comentário de A_DIVIDA aqui embaixo pedia ("as ~93 edges Deno […] precisam de um
// `_shared/erro-mensagem.ts` próprio"). Sem ele, um sítio NOVO em edge só tinha duas saídas:
// reintroduzir o idiom (vermelho, correto) ou driblar o regex renomeando a variável (verde,
// mentira). A isenção vale para o ARQUIVO INTEIRO — mantenha os dois helpers pequenos e sem
// outra lógica, porque o que entrar neles deixa de ser fiscalizado.
const HELPERS: ReadonlySet<string> = new Set([
  'src/lib/erro-mensagem.ts',
  'supabase/functions/_shared/erro-mensagem.ts',
]);

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    const st = statSync(resolve(RAIZ, rel));
    if (st.isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listarFontes(rel, acc);
    } else if (EXT.test(nome) && !IGNORAR.test(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

// Comentários removidos ANTES de medir — e aqui isso não é zelo teórico: o #1642 deixou o
// idiom citado em prosa em useTacticalPlan.ts (linhas 670/742) para explicar o que foi
// consertado, e a primeira varredura desta classe acusou essas duas linhas. O fiscal não
// pode medir a explicação do bug (mesma lição de #1472/#1488 e do gate irmão).
// O stripper é COMPARTILHADO (`@/lib/gates/limpeza-fonte`) e entende string/template/regex:
// a cópia local aqui limpava bloco com regex, e um `/*` dentro de string pareava com o `*/`
// seguinte apagando o miolo do arquivo ANTES de o fiscal olhar (classe medida em 2026-08-20).

// ── A: ternário cujo ramo "não é Error" cai em String() ───────────────────────────────
// Casa as duas formas que produzem "[object Object]": `? x.message : String(x)` e o
// embrulho `? x : new Error(String(x))` (achado em useCrossSellEngine — a regex estreita
// do briefing não pegava).
const A = /instanceof\s+Error\s*\?[^;]{0,240}?String\s*\(/g;

// ── C: String(err) cru, sem nem tentar o instanceof ───────────────────────────────────
// Mais direto que A: em objeto plano, `String(error)` JÁ É "[object Object]".
const C = /(?<![.\w$])String\s*\(\s*(err|error|erro)\s*\)/g;

// ── B: fallback literal — a PORTA DE FUGA deste gate ──────────────────────────────────
// `? x.message : 'Erro ao salvar'` não imprime "[object Object]", então não é esta classe;
// mas é como se dribla o gate: o dev vê vermelho e troca o `String(x)` por um literal, e a
// recusa da RLS morre igual — só que calada. Ratchet mais frouxo de propósito (ver abaixo).
const B = /instanceof\s+Error\s*\?\s*[\w$.]+\.message\s*:\s*['"`]/g;

function contar(re: RegExp, fonte: string): number {
  return [...removerComentarios(fonte).matchAll(re)].length;
}

function contarPorArquivo(re: RegExp): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const dir of DIRS) {
    for (const arquivo of listarFontes(dir)) {
      if (HELPERS.has(arquivo)) continue;
      const n = contar(re, readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      if (n > 0) mapa.set(arquivo, n);
    }
  }
  return mapa;
}

// DÍVIDA baselinada por CONTAGEM POR ARQUIVO (não por presença — achado do gate irmão:
// baseline por caminho deixaria um 2º sítio nascer num arquivo já listado sem nada ficar
// vermelho). Crescer REPROVA (reintrodução); diminuir REPROVA pedindo a atualização da
// lista — ela só encolhe, e encolhe REGISTRADO.
//
// ⚠️ NÃO é atestado de inofensividade: é a fronteira medida em 2026-08-03. `src/` está em
// ZERO (qualquer entrada nova de src/ aqui é reintrodução). O que resta são as ~93 edges
// Deno, que precisam de um `_shared/erro-mensagem.ts` próprio — fase 2, com chip.
const A_DIVIDA: ReadonlyMap<string, number> = new Map([
  ['supabase/functions/_shared/omie-falha.ts', 1],
  ['supabase/functions/ai-ops-agent/index.ts', 1],
  ['supabase/functions/algorithm-a-audit/index.ts', 1],
  ['supabase/functions/analyze-unified-order/index.ts', 1],
  ['supabase/functions/calculate-scores/index.ts', 5],
  ['supabase/functions/carteira-positivacao-snapshot/index.ts', 1],
  ['supabase/functions/cep-geo-resolver/index.ts', 2],
  ['supabase/functions/cmc-snapshot-backfill/index.ts', 2],
  ['supabase/functions/cmc-snapshot-smoke/index.ts', 2],
  ['supabase/functions/disparar-pedidos-aprovados/index.ts', 4],
  ['supabase/functions/dispatch-notifications/index.ts', 1],
  ['supabase/functions/enviar-pedido-portal-sayerlack/index.ts', 5],
  ['supabase/functions/fin-funding/index.ts', 1],
  ['supabase/functions/fin-valor-cockpit/index.ts', 1],
  ['supabase/functions/generate-tactical-plan/index.ts', 1],
  ['supabase/functions/gerar-pedidos-diario/index.ts', 1],
  ['supabase/functions/kb-extract-specs/index.ts', 1],
  ['supabase/functions/omie-analytics-sync/index.ts', 1],
  ['supabase/functions/omie-analytics-sync/politica-retry.ts', 1],
  ['supabase/functions/omie-aplicar-parametros/index.ts', 1],
  ['supabase/functions/omie-cliente/index.ts', 1],
  ['supabase/functions/omie-financeiro/index.ts', 1],
  ['supabase/functions/omie-malha-sync/index.ts', 2],
  ['supabase/functions/omie-nfe-recebimento-sync/index.ts', 3],
  ['supabase/functions/omie-sync-ctes-recebidos/index.ts', 2],
  ['supabase/functions/omie-sync-estoque/index.ts', 4],
  ['supabase/functions/omie-sync-metadados/index.ts', 1],
  ['supabase/functions/omie-sync-nfes-recebidas/index.ts', 8],
  ['supabase/functions/omie-sync-pedidos-compra/index.ts', 9],
  ['supabase/functions/omie-sync-sku-items/index.ts', 4],
  ['supabase/functions/omie-sync-status-produtos/index.ts', 4],
  ['supabase/functions/omie-sync-vendas-items/index.ts', 2],
  ['supabase/functions/omie-sync/index.ts', 4],
  ['supabase/functions/omie-vendas-sync/index.ts', 10],
  ['supabase/functions/omie-webhook/index.ts', 2],
  ['supabase/functions/pedido-programado-enviar/index.ts', 1],
  ['supabase/functions/pedido-programado-extrair/index.ts', 1],
  ['supabase/functions/process-nfe/index.ts', 7],
  ['supabase/functions/promocao-extrair-via-vision/index.ts', 2],
  ['supabase/functions/reposicao-depara-sayerlack-auto/index.ts', 1],
  // 1→3 é REVELAÇÃO, não reintrodução (2026-08-20): o stripper regex desta suíte apagava
  // 1.041 das 1.226 linhas deste arquivo — o `/*` do `*/*` no header Accept pareava com o
  // primeiro `*/` real e o fiscal media 15% do arquivo. Com `@/lib/gates/limpeza-fonte` os
  // sítios das linhas 737 e 986 apareceram; nasceram com o arquivo, ninguém os reintroduziu.
  ['supabase/functions/sayerlack-captura-precos/index.ts', 3],
  ['supabase/functions/scoring-recalc-batch/index.ts', 1],
  ['supabase/functions/scoring-recalc-client/index.ts', 1],
  ['supabase/functions/sync-reprocess/index.ts', 3],
  ['supabase/functions/tactical-plans-batch/index.ts', 2],
  ['supabase/functions/tint-omie-sync/index.ts', 1],
  ['supabase/functions/tint-sync-agent/index.ts', 2],
  ['supabase/functions/visit-score-recalc-batch/index.ts', 2],
  ['supabase/functions/visit-score-recalc-client/index.ts', 1],
]);

const C_DIVIDA: ReadonlyMap<string, number> = new Map([
  ['supabase/functions/_shared/omie-falha.ts', 1],
  ['supabase/functions/ai-ops-agent/index.ts', 1],
  ['supabase/functions/algorithm-a-audit/index.ts', 1],
  ['supabase/functions/calculate-scores/index.ts', 1],
  ['supabase/functions/cep-geo-resolver/index.ts', 1],
  ['supabase/functions/dispatch-notifications/index.ts', 1],
  ['supabase/functions/enviar-pedido-portal-sayerlack/index.ts', 3],
  ['supabase/functions/omie-analytics-sync/index.ts', 6],
  ['supabase/functions/omie-analytics-sync/politica-retry.ts', 1],
  ['supabase/functions/omie-aplicar-parametros/index.ts', 1],
  ['supabase/functions/omie-financeiro/index.ts', 2],
  ['supabase/functions/omie-nfe-recebimento/index.ts', 2],
  ['supabase/functions/omie-nfe-reconcile/index.ts', 2],
  ['supabase/functions/omie-nfe-webhook/index.ts', 1],
  ['supabase/functions/omie-sync-estoque/index.ts', 4],
  ['supabase/functions/omie-sync-metadados/index.ts', 2],
  ['supabase/functions/omie-sync-nfes-recebidas/index.ts', 5],
  ['supabase/functions/omie-sync-pedidos-compra/index.ts', 9],
  ['supabase/functions/omie-sync-status-produtos/index.ts', 2],
  ['supabase/functions/omie-sync-vendas-items/index.ts', 2],
  ['supabase/functions/omie-sync/index.ts', 3],
  ['supabase/functions/omie-vendas-sync/index.ts', 2],
  ['supabase/functions/omie-webhook/index.ts', 2],
  ['supabase/functions/process-recurring-orders/index.ts', 1],
  ['supabase/functions/promocao-extrair-via-vision/index.ts', 3],
  // Entrada NOVA por REVELAÇÃO (2026-08-20), não por regressão: o `String(err)` cru da linha
  // 659 estava dentro da região que o stripper regex apagava antes de o fiscal olhar.
  ['supabase/functions/sayerlack-captura-precos/index.ts', 1],
  ['supabase/functions/scoring-recalc-batch/index.ts', 1],
  ['supabase/functions/scoring-recalc-client/index.ts', 1],
  ['supabase/functions/sync-reprocess/index.ts', 3],
  ['supabase/functions/tint-omie-sync/index.ts', 1],
  ['supabase/functions/visit-score-recalc-batch/index.ts', 1],
  ['supabase/functions/visit-score-recalc-client/index.ts', 1],
]);

function desvios(medido: Map<string, number>, baseline: ReadonlyMap<string, number>) {
  const reintroducoes: string[] = [];
  const quitacoes: string[] = [];
  for (const [arquivo, n] of medido) {
    const base = baseline.get(arquivo) ?? 0;
    if (n > base) reintroducoes.push(`${arquivo} (${base}→${n})`);
    else if (n < base) quitacoes.push(`${arquivo} (${base}→${n})`);
  }
  for (const [arquivo, base] of baseline) {
    if (!medido.has(arquivo)) quitacoes.push(`${arquivo} (${base}→0)`);
  }
  return { reintroducoes, quitacoes };
}

const COMO_CORRIGIR =
  'use mensagemDeErro(err) ?? "<fallback do contexto>" (@/lib/erro-mensagem): o `error` do ' +
  'supabase-js é objeto PLANO, não Error, e String() nele rende "[object Object]"';

describe('gate estrutural: "[object Object]" no tratamento de erro (classe #1642)', () => {
  // Ausência de sinal NÃO é aprovação: se o walker parar de achar arquivos (glob quebrado,
  // DIRS renomeado), tudo fica verde para sempre. Este é o denominador do gate.
  it('sentinela: o walker anda de verdade', () => {
    const fontes = DIRS.flatMap((d) => listarFontes(d));
    expect(fontes.length).toBeGreaterThan(500);
    expect(fontes).toContain('src/hooks/useTacticalPlan.ts');
    expect(fontes.filter((f) => f.startsWith('supabase/functions/')).length).toBeGreaterThan(80);
  });

  it('A: nenhum `instanceof Error ? … : String(…)` além da dívida baselinada', () => {
    const { reintroducoes, quitacoes } = desvios(contarPorArquivo(A), A_DIVIDA);
    expect(reintroducoes, `idiom "[object Object]" reintroduzido — ${COMO_CORRIGIR}`).toEqual([]);
    expect(quitacoes, 'dívida quitada: ATUALIZE A_DIVIDA (a lista só encolhe, e encolhe registrada)').toEqual([]);
  });

  it('C: nenhum `String(err)` cru além da dívida baselinada', () => {
    const { reintroducoes, quitacoes } = desvios(contarPorArquivo(C), C_DIVIDA);
    expect(reintroducoes, `String() cru em erro — ${COMO_CORRIGIR}`).toEqual([]);
    expect(quitacoes, 'dívida quitada: ATUALIZE C_DIVIDA (a lista só encolhe, e encolhe registrada)').toEqual([]);
  });

  it('src/ está em ZERO — a erradicação do front não pode regredir por arquivo novo', () => {
    const sujos = [...contarPorArquivo(A), ...contarPorArquivo(C)].filter(([f]) => f.startsWith('src/'));
    expect(sujos.map(([f, n]) => `${f} (${n})`), COMO_CORRIGIR).toEqual([]);
  });

  // Calibração: um detector precisa provar que enxerga a forma que ele deve barrar E que
  // NÃO barra a forma corrigida — senão "não achou nada" e "está quebrado" são o mesmo
  // output (lição do detector que comparava catálogo com string literal, #1488).
  it('controle de calibração: casa a forma pré-fix, não casa a pós-fix nem a prosa', () => {
    const preFix = `const msg = err instanceof Error ? err.message : String(err);`;
    const preFixEmbrulho = `setErro(error instanceof Error ? error : new Error(String(error)));`;
    const preFixMultilinha = `
      toast.error('Falhou', {
        description: e instanceof Error
          ? e.message
          : String(e),
      });`;
    const preFixCru = `toast.error('Erro no sync', { description: String(error) });`;
    const posFix = `const msg = mensagemDeErro(err) ?? 'Erro sem mensagem';`;
    const comentario = `      //     \`err instanceof Error ? … : String(err)\` de antes rendia "[object Object]"`;

    expect(contar(A, preFix), 'a forma-mãe da classe tem de ser detectada').toBe(1);
    expect(contar(A, preFixEmbrulho), 'o embrulho new Error(String(x)) é a mesma classe').toBe(1);
    expect(contar(A, preFixMultilinha), 'quebra de linha não pode escapar do gate').toBe(1);
    expect(contar(C, preFixCru), 'String(error) cru tem de ser detectado').toBe(1);
    expect(contar(A, posFix) + contar(C, posFix), 'a forma corrigida não pode acusar').toBe(0);
    expect(contar(A, comentario) + contar(C, comentario), 'prosa que CITA o idiom não pode acusar').toBe(0);
  });

  // Porta de fuga: trocar o `String(x)` por um literal apaga o "[object Object]" da tela e
  // o vermelho deste gate, mas a recusa da RLS morre igual. Ratchet por TOTAL (não por
  // arquivo) de propósito: ao contrário de A/C, o fallback literal às vezes é a decisão
  // CERTA — há sítios onde a frase curada em pt-BR ("Verifique sua permissão: só gestão
  // define tier") serve melhor que `new row violates row-level security policy for …`.
  // Cada sítio é decisão de PRODUTO, não conversão mecânica; o teto só impede que a
  // dívida cresça enquanto a triagem não acontece (chip da fase 2).
  it('B (porta de fuga): o fallback literal não cresce em src/', () => {
    const total = [...contarPorArquivo(B)]
      .filter(([f]) => f.startsWith('src/'))
      .reduce((s, [, n]) => s + n, 0);
    expect(
      total,
      'fallback literal novo em src/: se veio de um `String(err)` que este gate barrou, ' +
        `a troca certa é ${COMO_CORRIGIR}. Se for frase curada deliberada, suba o teto com justificativa.`,
    ).toBeLessThanOrEqual(90);
  });

  // O gate acima é textual; esta é a asserção de COMPORTAMENTO que ele protege. Se alguém
  // "simplificar" o helper para `String(err)`, o gate textual continuaria verde.
  it('o helper nunca devolve "[object Object]" para o erro plano do PostgREST', () => {
    const postgrestPlano = { message: 'permission denied for table fin_balanco_inputs', code: '42501' };
    expect(postgrestPlano).not.toBeInstanceOf(Error);
    expect(String(postgrestPlano)).toBe('[object Object]');
    expect(mensagemDeErro(postgrestPlano)).toBe('permission denied for table fin_balanco_inputs');
    expect(mensagemDeErro({ code: '42501' })).toBeNull();
  });
});
