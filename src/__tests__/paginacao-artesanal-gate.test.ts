import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ── GATE ESTRUTURAL da classe "laço de paginação artesanal que trata página com falha
// como fim da lista" (money-path §6/§7/§8) ─────────────────────────────────────────────
//
// A classe custou ~20 PRs corrigidos um a um (#1338, #1425, #1471, #1500, #1524, #1545,
// #1550, #1557 [6 laços], #1562, #1563 ["7º laço"], #1564) — cada fix esperou o próximo
// sintoma doer em produção. Página perdida não some da tela: vira "SKU sem custo" (infla
// margem), "cliente sem carteira" (troca o escopo do cálculo) ou "não comprou" carimbado
// em snapshot. Meta-regra do repo: classe com contramedida TEXTUAL reincide; classe com
// gate ESTRUTURAL para. Este arquivo é o gate.
//
// CONTRATO canônico de paginação (o que os helpers implementam):
//   - página com `error`  → LANÇA (nunca break/return do acumulado parcial);
//   - `data == null` SEM `error` → LANÇA (resposta malformada ≠ fim; `?? []` é o furo);
//   - fim legítimo: SÓ `data: []` / página curta;
//   - teto defensivo esgotado → LANÇA (fim-por-exaustão ≠ fim-da-fonte; §8).
//
// Por que TEXTUAL (readFileSync, padrão edge-money-path-invariants/edge-parse-parity):
// metade dos sites vive em edges Deno que o vitest não executa e o tsc do app não checa —
// um teste que lê FONTE cobre as duas metades com um contrato só, e roda no CI `validate`.

const RAIZ = resolve(__dirname, '../..');

// Diretórios varridos. scripts/ entra por completude (varredura 2026-07-23: zero sites lá,
// mas código novo de script que pagine PostgREST deve obedecer o mesmo contrato).
const DIRS = ['src', 'supabase/functions', 'scripts'];

const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.test\.|_test\.|\.d\.ts$|__tests__|\.stories\.)/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    const abs = resolve(RAIZ, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listarFontes(rel, acc);
    } else if (EXT.test(nome) && !IGNORAR.test(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

// Remove comentários de LINHA INTEIRA (^\s*//…) e blocos /* … */ antes de aplicar os
// padrões — sem isso, prosa que DESCREVE o defeito (ex.: o cabeçalho de
// _shared/mapas-paginados.ts, que cita `const { data } = await ...range(...)` de
// propósito) dispararia o gate (lição #1472/#1488: assert sobre fonte roda com
// comentários removidos; comentário que satisfaz/dispara o fiscal é falso sinal).
// Comentário no FIM de linha de código sobrevive de propósito: removê-lo por regex
// mutilaria strings com `//` (URLs de import Deno), e os padrões abaixo são multiline
// ancorados em código — não casam prosa de fim de linha.
function semComentarios(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

// Conta TODAS as ocorrências do padrão por arquivo (não só a primeira). A baseline é por
// CONTAGEM, não por caminho (achado Codex xhigh): baseline por-arquivo aceitaria um 2º
// laço proibido nascer num arquivo já listado sem nada ficar vermelho. Com contagem:
// crescer REPROVA (reintrodução), diminuir REPROVA pedindo a atualização da baseline
// (a lista só encolhe, e encolhe REGISTRADO).
function contarPorArquivo(contar: (fonte: string) => number): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const dir of DIRS) {
    for (const arquivo of listarFontes(dir)) {
      const n = contar(semComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8')));
      if (n > 0) mapa.set(arquivo, n);
    }
  }
  return mapa;
}

function contarRegex(padrao: RegExp): (fonte: string) => number {
  return (fonte) => {
    const g = new RegExp(padrao.source, padrao.flags.includes('g') ? padrao.flags : padrao.flags + 'g');
    return [...fonte.matchAll(g)].length;
  };
}

// Compara o medido com a baseline e devolve os desvios nos DOIS sentidos.
function desvios(
  medido: Map<string, number>,
  baseline: ReadonlyMap<string, number>,
): { reintroducoes: string[]; quitacoes: string[] } {
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

// ── G1: desestruturação que DESCARTA `error` numa instrução com `.range(` ─────────────
// A forma-mãe da classe (F1, controle: sync_addresses pré-#1563): `const { data } =
// await ....range(...)` não tem COMO detectar a página que falha — o error morre na
// desestruturação e `data:null` vira "acabou". Vale para laço E single-shot: mesmo fora
// de laço, um `.range()` cujo error é descartado lê falha como lista vazia.
const G1 = /const\s*\{\s*data(?:\s*:\s*\w+)?\s*\}\s*=\s*await\b[^;]{0,600}?\.range\(/;

// Allowlist G1 (por CONTAGEM) — cada entrada exige justificativa; contagem menor que a
// registrada REPROVA pedindo atualização (lista só encolhe, registrado).
const G1_ALLOW: ReadonlyMap<string, number> = new Map([
  // .range(1, 1) single-shot deliberado ("a 2ª visita mais recente") para decidir texto
  // de saudação — leitura cosmética, sem laço, sem money-path; falha degrada para o
  // texto default do dashboard. Convertê-la a {data, error} é welcome, não obrigatório.
  ['src/hooks/useLastVisit.ts', 1],
]);

// ── G3: coalescência de página (`?? []` / `|| []`) DENTRO de laço com `.range(` ───────
// A forma fina da classe (F3, controle: buscarTodasPaginas pré-#1564): o laço já lança
// em `error`, mas `data ?? []` converte a resposta malformada (`data:null` SEM error) em
// página vazia → EOF falso → o acumulado PARCIAL volta como se fosse a tabela inteira.
// Detecção posicional (não regex única): um `.range(` com `for`/`while` até 300 chars
// ANTES (laço local — callbacks de helper não têm) e `?? []`/`|| []` até 260 chars
// DEPOIS (o acumulador da página). Single-shots e callbacks de helper não casam.
function contarG3(fonte: string): number {
  let i = -1;
  let n = 0;
  while ((i = fonte.indexOf('.range(', i + 1)) !== -1) {
    const antes = fonte.slice(Math.max(0, i - 300), i);
    const depois = fonte.slice(i, i + 260);
    if (/\b(for|while)\s*\(/.test(antes) && /(\?\?|\|\|)\s*\[\]/.test(depois)) n++;
  }
  return n;
}

// DÍVIDA G3 (baseline por CONTAGEM, 2026-07-23 — chips de erradicação por domínio
// abertos na mesma data). NÃO adicione entradas nem aumente contagens: crescer é
// REINTRODUÇÃO. Ao quitar (contagem cair), o teste reprova pedindo a atualização —
// a lista só encolhe, e encolhe registrado (achado Codex: baseline por arquivo
// aceitaria um laço NOVO nascer em arquivo já listado).
const G3_DIVIDA: ReadonlyMap<string, number> = new Map([
  // Quitados (erradicação scoring/carteira/batch, #1596): ai-ops-agent, algorithm-a-audit,
  // calculate-scores, carteira-rebuild — convertidos a fetchAll/throw/failLease.
  // Quitado (erradicação das 3 edges de sync Omie, #1597): omie-analytics-sync (5→0) — os
  // 5 laços viraram chamadas a `fetchAll` (_shared/paginate.ts), que lança em erro E em
  // data:null.
  // Quitado (erradicação das EDGES FINANCEIRAS, este PR): omie-financeiro (1→0) — o laço do
  // carregarBaixaMapDRE (baixaMap parcial no DRE-caixa) delegado ao mesmo `fetchAll`.
  // Os três PRs nasceram do mesmo chip-mãe (#1581) e conflitaram AQUI por editar linhas
  // vizinhas; a resolução é UNIÃO — as listas de quitação são disjuntas e todas valem
  // (money-path §9: conflito entre dois fixes da mesma classe não se resolve por lado).
  // A dívida G3 chegou a ZERO: a próxima entrada aqui é reintrodução, não herança.
]);

// F2 residual SEM regra automatizada (decisão registrada, respondendo ao challenge do
// Codex): a forma `if (!x || x.length === 0) break`/`hasMore=false` colapsando
// data:null com fim sobrevive hoje só no omie-malha-sync ~:145 — os 3 laços keyset das
// edges de sync Omie (omie-cliente :362/:948/:1154 e omie-vendas-sync :955) foram
// convertidos na continuação do #1581 para `if (x == null) throw` + `if (x.length === 0)`,
// que separa resposta MALFORMADA de fim legítimo sem perder o cursor keyset (design
// legítimo: keyset ≠ offset, não vira fetchAll). A regex genérica do padrão casa ~13 usos LEGÍTIMOS de
// "lista vazia → nada a fazer" fora de laço de paginação (medido 2026-07-23) e uma
// versão posicional fina o bastante seria frágil; a morte da forma vem da CONVERSÃO
// para helpers (que os chips executam), e G1/G3/G4 barram as formas grepáveis.

// ── G4: total de páginas do Omie confiado CRU (`|| 1` / `?? 1` por resposta) ──────────
// nTotPaginas/total_de_paginas é PISO, não verdade (docs/agent/sync.md): resposta
// intermediária sem o campo degrada para 1 e ENCOLHE o teto → o laço completa retrato
// PARCIAL como 'complete' (Codex P1 do #1353). O padrão correto vive em
// supabase/functions/_shared/omie-paginacao.ts: validarTotalPaginas (fail-fast
// anti-runaway) + proximoTotalPaginas (piso monotônico) + avaliarPagina (página vazia
// antes do fim declarado = anomalia, nunca "fim").
//
// ⚠️ O `[^;]{0,60}?` (era `\s*`) foi ENDURECIDO em DOIS passos na continuação do #1581:
//  (1) `\s*` → aceitar o que houver entre o campo e o operador: a forma dominante nas edges de
//      venda/financeiro é `(result.total_de_paginas as number) || 1`, e o CAST fazia a regex
//      NÃO casar — o gate media 0 num arquivo com 5 sites vivos (omie-financeiro). Detector que
//      não enxerga a forma real do repo é falso-VERDE, a família do "O DETECTOR mente".
//      Medido: +5 em omie-financeiro, +1 em omie-vendas-sync, zero falso positivo.
//  (2) permitir NEWLINE (achado Codex deste PR): `(… as number)\n  || 1` é o que o formatador
//      automático produz quando a linha passa do limite, e a versão anterior (`[^;\n]`) deixava
//      passar. Medido no repo inteiro: ZERO diferença de contagem — não gera falso positivo aqui.
// O `;` continua excluído: é ele que impede o padrão de atravessar para o statement vizinho.
//
// LIMITAÇÃO CONHECIDA (registrada, não é descuido — a solução completa exigiria AST/dataflow):
//  · falso POSITIVO possível em objeto literal — `{ pages: result.total_de_paginas, n: x || 1 }`
//    casa sem ser fallback de total (não existe no repo hoje; se aparecer, vai para a allowlist);
//  · falso NEGATIVO via ALIAS — `const t = result.total_de_paginas; … t || 1` escapa, porque o
//    nome do campo não está na mesma expressão.
const G4 = /(nTotPaginas|total_de_paginas)[^;]{0,60}?(\|\||\?\?)\s*1\b/;

// Allowlist PERMANENTE por contagem (usos legítimos da forma — não são dívida). O helper
// _shared/omie-paginacao.ts NÃO precisa de entrada: seu `Number(nTot ?? 1)` usa o
// parâmetro `nTot`, que a regex (ancorada nos nomes de campo do Omie) não casa.
const G4_ALLOW: ReadonlyMap<string, number> = new Map([
  // `omieTruncado = (total_de_paginas ?? 1) > 1` é DETECÇÃO de truncamento que alimenta
  // o fail-closed doc-ambíguo (guardrail do edge-money-path-invariants) — não é teto.
  ['supabase/functions/omie-sync/index.ts', 1],
  // O `?? 1` monta o total DECLARADO cru que alimenta o guard local (paginacao.ts do
  // próprio edge: piso monotônico + vazia≤piso lança + teto lança — auditado 2026-07-23).
  ['supabase/functions/omie-sync-status-produtos/index.ts', 1],
  // syncPedidos (~:1159) — `só p/ log/ETA, NÃO decide completude`, auditado na continuação
  // do #1581: a autoridade de fim é `classifyPedidosPage` (pagination.ts: fim REAL = null/
  // vazia-que-não-contradiz; vazia que CONTRADIZ = anomalia → pausa) e `complete = reachedEnd`.
  // O valor só alcança um console.log e o campo informativo do retorno. Revelado pelo
  // endurecimento da regex acima (o cast o escondia).
  ['supabase/functions/omie-vendas-sync/index.ts', 1],
]);

// DÍVIDA G4 (baseline por CONTAGEM, 2026-07-23 — mesma regra da G3_DIVIDA):
const G4_DIVIDA: ReadonlyMap<string, number> = new Map([
  ['supabase/functions/cmc-snapshot-backfill/index.ts', 1],
  ['supabase/functions/cmc-snapshot-smoke/index.ts', 1],
  // omie-analytics-sync (3→0), omie-cliente (1→0) e omie-vendas-sync (1→0, o `|| 1` do
  // backfill_tint_cor) QUITADOS na continuação do #1581 — os totais passaram a
  // proximoTotalPaginas + avaliarPagina. O que resta do vendas-sync é a entrada de
  // G4_ALLOW acima (log/ETA), não dívida.
  ['supabase/functions/omie-sync-ctes-recebidos/index.ts', 1],
  ['supabase/functions/omie-sync-estoque/index.ts', 2],
  ['supabase/functions/omie-sync-metadados/index.ts', 1],
  ['supabase/functions/omie-sync-vendas-items/index.ts', 1],
  ['supabase/functions/sync-reprocess/index.ts', 1],
  ['supabase/functions/tint-omie-sync/index.ts', 1],
  // QUITADA (chip das EDGES FINANCEIRAS, este PR): a dívida de 5 que o #1597 baselinou ao
  // consertar o detector eram os 5 `(… as number) || 1` do omie-financeiro — agora
  // `proximoTotalPaginas` (piso monotônico) + `avaliarPagina`/sonda. Ciclo completo da
  // erradicação em dois PRs: um conserta o DETECTOR e baselina o que ele revela, o outro
  // corrige o revelado e tira a entrada. A lista só encolhe, e encolheu registrado.
]);

describe('gate estrutural: paginação artesanal que trata falha como fim (classe #1338→#1564)', () => {
  it('sentinela: o walker anda de verdade (glob quebrado = verde eterno, ausência de sinal ≠ aprovação)', () => {
    const fontes = DIRS.flatMap((d) => listarFontes(d));
    // Piso deliberadamente FOLGADO (o repo tem ~2k fontes): se o walker quebrar e listar
    // quase nada, isto fica vermelho antes de qualquer regra "passar" por vacuidade.
    expect(fontes.length, 'walker listou fontes de menos — glob/recursão quebrada').toBeGreaterThan(500);
    expect(fontes, 'o helper das edges sumiu da varredura').toContain('supabase/functions/_shared/paginate.ts');
    expect(fontes, 'o helper de src/ sumiu da varredura').toContain('src/lib/postgrest.ts');
  });

  it('G1: nenhum `const { data } = await ....range(` descartando error além da allowlist', () => {
    const { reintroducoes, quitacoes } = desvios(contarPorArquivo(contarRegex(G1)), G1_ALLOW);
    expect(
      reintroducoes,
      `REINTRODUÇÃO da classe (F1 — error descartado na desestruturação; página que falha vira "acabou"). ` +
        `Use fetchAllPages (@/lib/postgrest), fetchAll (_shared/paginate.ts) ou desestruture { data, error } ` +
        `com throw. Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);
    expect(
      quitacoes,
      `contagem G1 abaixo da allowlist — atualize/remova a entrada para a lista não mascarar ` +
        `reintrodução futura: ${quitacoes.join(', ')}`,
    ).toEqual([]);
  });

  it('G1 (controle de calibração): a forma pré-fix do #1563 é detectada', () => {
    // O trecho REAL removido pelo #1563 (sync_addresses) — se o padrão G1 não casar isto,
    // o gate perdeu o dente e TODO verde dele é vácuo.
    const preFix1563 = `
        let allAddressUserIds: string[] = [];
        let addrOffset = 0;
        while (true) {
          const { data: addrPage } = await adminClient
            .from("addresses")
            .select("user_id")
            .range(addrOffset, addrOffset + 999);
          if (!addrPage || addrPage.length === 0) break;
        }`;
    expect(G1.test(preFix1563), 'G1 deixou de casar o controle pré-fix do #1563').toBe(true);
    // E o pós-fix (callback de fetchAll, sem desestruturação de data) NÃO casa:
    const posFix1563 = `
        const addressRows = await fetchAll<{ user_id: string }>(
          (from, to) =>
            adminClient
              .from("addresses")
              .select("user_id")
              .order("id", { ascending: true })
              .range(from, to),
          "sync_addresses: user_ids com endereço",
        );`;
    expect(G1.test(posFix1563), 'G1 casa o pós-fix do #1563 — falso positivo de calibração').toBe(false);
  });

  it('G3: nenhum laço `.range(` com `?? []`/`|| []` de página além da dívida baselinada', () => {
    const { reintroducoes, quitacoes } = desvios(contarPorArquivo(contarG3), G3_DIVIDA);
    expect(
      reintroducoes,
      `REINTRODUÇÃO da classe (F3 — \`?? []\` sobre página dentro de laço: data:null sem error vira ` +
        `EOF falso e o acumulado PARCIAL passa por completo). Lance em data==null ou use um helper ` +
        `canônico (fetchAllPages/fetchAll/buscarTodasPaginas/coletarPaginado/paginateAll). ` +
        `Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);
    expect(
      quitacoes,
      `dívida G3 quitada (total ou parcial) — ATUALIZE a baseline para ela só encolher: ${quitacoes.join(', ')}`,
    ).toEqual([]);
  });

  it('G4: nenhum total Omie confiado cru (`|| 1` / `?? 1`) além da allowlist + dívida baselinada', () => {
    const base = new Map([...G4_ALLOW, ...G4_DIVIDA]);
    const { reintroducoes, quitacoes } = desvios(contarPorArquivo(contarRegex(G4)), base);
    expect(
      reintroducoes,
      `REINTRODUÇÃO da classe (F4 — total do Omie confiado por resposta; intermediária sem o campo ` +
        `encolhe o teto e o parcial completa como 'complete'). Use validarTotalPaginas/proximoTotalPaginas/` +
        `avaliarPagina de _shared/omie-paginacao.ts. Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);
    expect(
      quitacoes,
      `dívida/allowlist G4 quitada (total ou parcial) — ATUALIZE a baseline para ela só encolher: ${quitacoes.join(', ')}`,
    ).toEqual([]);
  });

  it('G4 (controle de calibração): as DUAS formas do total cru são detectadas — inclusive com cast', () => {
    // Sem este controle o G4 é falso-VERDE por construção: a regex `\s*` original media 0 em
    // omie-financeiro (5 sites vivos) e em omie-vendas-sync porque o cast fica ENTRE o campo e
    // o `||`. "Detectou a morte" e "está quebrado" têm de ser distinguíveis (money-path §"O
    // DETECTOR mente"): estes asserts fixam o detector contra as formas REAIS do repo.
    const semCast = `      totalPaginas = result.total_de_paginas || 1;`;
    const comCast = `    totalPaginas = (result.total_de_paginas as number) || 1;`;
    const comCastBang = `    totalPaginas = (result!.total_de_paginas as number) || 1;`;
    const comCastNTot = `    totalPaginas = (result.nTotPaginas as number) || 1;`;
    const coalesce = `      const total = result.total_de_paginas ?? 1;`;
    // Quebra de linha antes do `||` — o que o formatador automático produz numa linha longa.
    // Achado Codex deste PR: a 1ª versão do endurecimento excluía `\n` e deixava passar.
    const multilinha = `    totalPaginas = (result.total_de_paginas as number)\n      || 1;`;
    for (const [rotulo, amostra] of [
      ['sem cast (forma-mãe)', semCast],
      ['com cast `as number`', comCast],
      ['com cast e non-null `!`', comCastBang],
      ['com cast, campo nTotPaginas', comCastNTot],
      ['coalesce `?? 1`', coalesce],
      ['cast + quebra de linha antes do `||`', multilinha],
    ] as const) {
      expect(G4.test(amostra), `G4 deixou de casar o controle: ${rotulo}`).toBe(true);
    }
    // E o pós-fix (piso monotônico + teto fail-fast) NÃO casa — senão o gate ficaria vermelho
    // sobre o código CORRETO e a saída seria afrouxar a regra (falso-VERMELHO, §#1483).
    const posFix = `      totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, MAX_PAGINAS_LISTAGEM);`;
    expect(G4.test(posFix), 'G4 casa o pós-fix — falso positivo de calibração').toBe(false);
    // Guard do endurecimento: o `[^;\n]` não pode atravessar statement e casar um `|| 1` de
    // OUTRA instrução (isso transformaria vizinhança inocente em ofensa).
    const doisStatements = `    const t = result.total_de_paginas; const fator = escala || 1;`;
    expect(G4.test(doisStatements), 'G4 atravessou `;` — o padrão pega statement vizinho').toBe(false);
  });

  it('G3 (controle de calibração): laço com `?? []` de página é detectado; callback de helper não', () => {
    // Forma REAL do somarSaldoPorStatus pré-fix (2026-07-23) — laço + range + coalesce:
    const lacoAfetado = `
  for (;;) {
    const { data, error } = await supabase
      .from(tabela)
      .select('saldo')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error('x');
    const rows = (data ?? []) as Array<{ saldo: number | null }>;
    if (rows.length < PAGE) break;
  }`;
    expect(contarG3(lacoAfetado) > 0, 'G3 deixou de casar o laço-controle afetado').toBe(true);
    // Callback de fetchAllPages (sem laço local; o for vive no helper) — não casa:
    const callbackCorreto = `
  const custos = await fetchAllPages(
    (de, ate) =>
      supabase.from('product_costs').select('product_id, cost_final')
        .order('product_id', { ascending: true }).range(de, ate),
    'product_costs/exemplo',
  );
  const mapa = new Map((outraCoisa ?? []).map((x) => [x.id, x]));`;
    expect(contarG3(callbackCorreto), 'G3 casa callback de helper — falso positivo de calibração').toBe(0);
  });

  // ── G2: contract-pins — os helpers canônicos mantêm o contrato que a classe exige ────
  // Cada pin ancora numa string EXCLUSIVA do ramo que protege (ASCII no que o assert
  // exige, caixa fixa, sem -i — lição #1483). Se alguém "simplificar" um helper de volta
  // ao `?? []`, é aqui que fica vermelho — não em produção três semanas depois.
  const pins: Array<{ arquivo: string; presente: RegExp; motivo: string }> = [
    {
      arquivo: 'supabase/functions/_shared/paginate.ts',
      presente: /if \(data == null\) throw new Error\(`\$\{label\}: data null sem error/,
      motivo: 'fetchAll voltaria a converter data:null em pagina vazia (EOF falso)',
    },
    {
      arquivo: 'src/lib/scoring/rpcPaginada.ts',
      presente: /throw new Error\(`\$\{rotulo\} pág\.\$\{pagina\}: data null sem error/,
      motivo: 'coletarPaginado voltaria a converter data:null em pagina vazia (EOF falso)',
    },
    {
      arquivo: 'supabase/functions/calculate-scores/index.ts',
      presente: /if \(data == null\) throw new Error\(`\$\{fn\} pág\.\$\{pg\}: data null sem error/,
      motivo: 'o espelho carregarRpcPaginada voltaria a engolir data:null (o src/ lança e o edge nao)',
    },
    {
      arquivo: 'src/services/financeiroService.ts',
      presente: /if \(data == null\) throw new Error\(`Falha ao carregar \$\{contexto\}: data=null sem error/,
      motivo: 'buscarTodasPaginas perderia o fix do #1564 (o ?? [] fechava o laco parcial)',
    },
    {
      arquivo: 'src/lib/postgrest.ts',
      presente: /devolveu data null sem error/,
      motivo: 'fetchAllPages perderia a rejeicao de resposta malformada (#1550/#1560)',
    },
    {
      arquivo: 'src/hooks/unifiedOrder/catalog-helpers.ts',
      presente: /throw new Error\(\s*`paginateAll: teto de maxPages atingido/,
      motivo: 'paginateAll voltaria a RETORNAR o parcial ao esgotar o teto (#1562, money-path §8)',
    },
    // ── Continuação #1581 (edges scoring/carteira/batch) — laços LOCAIS remanescentes.
    // Achado Codex P2 do PR: sem pin, reverter um guard `data == null` destes laços passaria
    // verde em G1/G3/VIGIADAS_ORDER (a forma `if (!data) break` não tem regra automatizada —
    // ver o comentário F2 acima). Âncora em trecho ASCII, caixa fixa, exclusivo do ramo (#1483).
    {
      arquivo: 'supabase/functions/carteira-rebuild/index.ts',
      presente: /if \(data == null\) \{ console\.error\('\[carteira-rebuild\] load aliases: data null sem error'\); return await failLease\('aliases: data null sem error/,
      motivo: 'aliases: data:null sem error voltaria a encerrar o laco com aliasMap PARCIAL (clone re-exposto)',
    },
    {
      arquivo: 'supabase/functions/carteira-rebuild/index.ts',
      presente: /if \(data == null\) \{ console\.error\('\[carteira-rebuild\] load ledger: data null sem error'\); return await failLease\('ledger: data null sem error/,
      motivo: 'ledger: membroIds truncado engana ate a pos-condicao D4 (ela compara contra o conjunto truncado)',
    },
    {
      arquivo: 'supabase/functions/carteira-rebuild/index.ts',
      presente: /if \(data == null\) \{ console\.error\('\[carteira-rebuild\] load proof oben: data null sem error'\); return await failLease\('proof oben: data null sem error/,
      motivo: 'proof oben: truncada rebaixaria membro a orfao/Hunter em massa',
    },
    {
      arquivo: 'supabase/functions/carteira-rebuild/index.ts',
      presente: /if \(data == null\) \{ console\.error\('\[carteira-rebuild\] load flaggeds: data null sem error'\); return await failLease\('flaggeds: data null sem error/,
      motivo: 'flaggeds: truncado re-elegeria fornecedor excluido da carteira',
    },
    {
      arquivo: 'supabase/functions/sinais-batch/index.ts',
      presente: /if \(data == null\) \{\s*\n\s*return new Response\(JSON\.stringify\(\{ ok: false, error: `farmer_calls /,
      motivo: 'sinais-batch: data:null sem error voltaria a fechar a varredura PARCIAL como completa',
    },
    {
      arquivo: 'supabase/functions/ai-ops-agent/index.ts',
      presente: /if \(aPage == null\) throw new Error\(`carteira_assignments /,
      motivo: 'keyset do ownerMap: data:null sem error truncaria o mapa e as decisoes sairiam com farmer_id null',
    },
    // Ordem COMPOSTA (chave total) pinada onde UMA coluna não é única (achado Codex P2:
    // VIGIADAS_ORDER só exige ALGUM .order — remover o desempate passaria verde).
    {
      arquivo: 'supabase/functions/sinais-batch/index.ts',
      presente: /\.order\('started_at', \{ ascending: false \}\)\s*\n\s*\.order\('id', \{ ascending: true \}\)/,
      motivo: 'sem o desempate por id, started_at empatado pula/duplica linhas entre paginas',
    },
    {
      arquivo: 'supabase/functions/tactical-plans-batch/index.ts',
      presente: /\.order\('customer_user_id', \{ ascending: true \}\)\s*\n\s*\.range\(from, to\)/,
      motivo: 'a chave do batch tem de ser customer_user_id (UNIQUE e IMUTAVEL) imediatamente antes do range',
    },
  ];

  for (const pin of pins) {
    it(`G2 pin: ${pin.arquivo} mantém o contrato (${pin.motivo})`, () => {
      const fonte = semComentarios(readFileSync(resolve(RAIZ, pin.arquivo), 'utf8'));
      expect(pin.presente.test(fonte), `sumiu o guard: ${pin.motivo}`).toBe(true);
    });
  }

  it('G2 anti-regressão: nenhum helper canônico de paginação volta ao `?? []`/`|| []` sobre a página', () => {
    // Só os arquivos-helper (a forma é legítima noutros contextos, ex. mapear resultado
    // de RPC single-shot). Nos helpers de paginação ela é SEMPRE o furo do EOF falso.
    const helpers = [
      'supabase/functions/_shared/paginate.ts',
      'src/lib/scoring/rpcPaginada.ts',
      'src/lib/postgrest.ts',
    ];
    for (const arquivo of helpers) {
      const fonte = semComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      expect(
        /\bdata\s*(\?\?|\|\|)\s*\[\]/.test(fonte),
        `${arquivo}: voltou o \`data ?? []\` — data:null sem error viraria EOF falso de novo`,
      ).toBe(false);
    }
  });

  it('G2 anti-sabotagem: TODO ramo `x == null` dos arquivos pinados ABORTA (nunca break/continue)', () => {
    // Achado Codex (2×). Primeira rodada: `if (data == null) break;` ANTES do
    // `if (data == null) throw ...` satisfaria o pin de PRESENÇA com o throw morto.
    // Segunda rodada (challenge deste PR): a versão anterior deste teste cobria só 5 arquivos e
    // só a variável literal `data` — deixava de fora carteira-rebuild, sinais-batch e o keyset do
    // ai-ops-agent (que usa `aPage`), justamente os 6 pins novos. Um `break` inserido lá passava
    // verde em G1, G3, VIGIADAS_ORDER e no pin de presença.
    //
    // A regra NÃO pode ser "nenhum return": os guards CORRETOS de carteira-rebuild e sinais-batch
    // abortam com `return await failLease(...)` / `return new Response(...)`. O invariante real é
    // que o ramo ABORTE — throw, failLease ou Response de erro. `break`/`continue` (e `return` nu)
    // continuam a leitura como se a página malformada fosse fim.
    const pinados = [
      'supabase/functions/_shared/paginate.ts',
      'src/lib/scoring/rpcPaginada.ts',
      'supabase/functions/calculate-scores/index.ts',
      'src/services/financeiroService.ts',
      'src/lib/postgrest.ts',
      'supabase/functions/carteira-rebuild/index.ts',
      'supabase/functions/sinais-batch/index.ts',
      'supabase/functions/ai-ops-agent/index.ts',
    ];
    // Nomes de página realmente usados nestes laços (não um `\w+` solto, que casaria
    // comparações de domínio como `if (cod == null)` e daria falso-VERMELHO).
    const VARS = /if\s*\(\s*(data|aPage|sPage|page|batch|batch2|rows|linhas)\s*==\s*null\s*\)/g;
    // O predicado é de ORDEM, não de presença — e isto NÃO é sofisticação gratuita: a primeira
    // versão perguntava "existe break na janela?" e ficou vermelha no baseline em paginate.ts e
    // financeiroService.ts, porque a janela alcançava o `break` LEGÍTIMO do fim-de-página
    // (`if (rows.length < PAGE) break`) que vem 3 linhas abaixo do guard. Assert que mede além do
    // ramo é falso-VERMELHO (irmão do que mede prosa — §"O ALVO mente"). O que importa é o que
    // vem PRIMEIRO depois do `if (x == null)`: se for abortar, o guard está vivo; se for
    // break/continue, o aborto pinado logo abaixo é código morto.
    const ABORTO = /\bthrow\b|failLease\s*\(|new Response\s*\(/;
    const ENGOLE = /\b(break|continue)\b/;
    const ofensas: string[] = [];
    for (const arquivo of pinados) {
      const fonte = semComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      for (const m of fonte.matchAll(VARS)) {
        const ramo = fonte.slice(m.index!, m.index! + 240);
        const iAborto = ramo.search(ABORTO);
        const iEngole = ramo.search(ENGOLE);
        if (iAborto < 0) {
          ofensas.push(`${arquivo}: \`${m[0]}\` não aborta (sem throw/failLease/Response)`);
        } else if (iEngole >= 0 && iEngole < iAborto) {
          ofensas.push(`${arquivo}: \`${m[0]}\` ENGOLE (break/continue ANTES do aborto)`);
        }
      }
    }
    expect(
      ofensas,
      `ramo de página malformada que NÃO aborta — o throw/failLease pinado vira código morto e ` +
        `data:null volta a ser lido como fim da lista: ${ofensas.join(' | ')}`,
    ).toEqual([]);
  });

  it('G2: a chave de paginação do tactical-plans-batch não volta a ser o `farmer_id` (MUTÁVEL)', () => {
    // Achado do challenge /codex, confirmado em prod: o trigger trg_carteira_reconcile_score_owner
    // faz `SET farmer_id = EXCLUDED.farmer_id` em farmer_client_scores a cada mudança de dono, e o
    // carteira-rebuild roda 07:30 UTC — 30min ANTES deste batch. Ordenar por (farmer_id, ...) é
    // ordem TOTAL mas não ESTÁVEL: a linha que troca de farmer entre dois offsets muda de posição
    // e some (cliente sem plano) ou duplica (disputa o TOP_N 2×). Um pin de presença de
    // `.order('customer_user_id')` não barra alguém REACRESCENTAR o farmer_id antes dele — por
    // isso este é um pin de AUSÊNCIA. Total ≠ estável: a chave tem de ser IMUTÁVEL.
    const fonte = semComentarios(
      readFileSync(resolve(RAIZ, 'supabase/functions/tactical-plans-batch/index.ts'), 'utf8'),
    );
    expect(
      /\.order\(\s*['"]farmer_id['"]/.test(fonte),
      'voltou o .order(farmer_id): coluna MUTÁVEL na chave de paginação — o trigger de carteira ' +
        'move a linha entre páginas e o cliente some ou duplica no TOP_N',
    ).toBe(false);
  });
});
