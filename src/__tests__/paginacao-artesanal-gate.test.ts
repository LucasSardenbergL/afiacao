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

interface Ocorrencia {
  arquivo: string;
  trecho: string;
}

function varrer(padrao: RegExp, allowlist: ReadonlySet<string>): {
  ocorrencias: Ocorrencia[];
  allowlistSemUso: string[];
  varridos: number;
} {
  const ocorrencias: Ocorrencia[] = [];
  const usados = new Set<string>();
  let varridos = 0;
  for (const dir of DIRS) {
    for (const arquivo of listarFontes(dir)) {
      varridos++;
      const fonte = semComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      const m = fonte.match(padrao);
      if (!m) continue;
      if (allowlist.has(arquivo)) {
        usados.add(arquivo);
        continue;
      }
      ocorrencias.push({ arquivo, trecho: m[0].slice(0, 160).replace(/\s+/g, ' ') });
    }
  }
  // Entrada de allowlist que não casa mais é lixo que esconderia uma reintrodução futura
  // no mesmo arquivo — reportar para remoção (mantém a lista mínima e honesta).
  const allowlistSemUso = [...allowlist].filter((a) => !usados.has(a));
  return { ocorrencias, allowlistSemUso, varridos };
}

function formatar(ocorrencias: Ocorrencia[]): string {
  return ocorrencias.map((o) => `\n  - ${o.arquivo}: "${o.trecho}"`).join('');
}

// ── G1: desestruturação que DESCARTA `error` numa instrução com `.range(` ─────────────
// A forma-mãe da classe (F1, controle: sync_addresses pré-#1563): `const { data } =
// await ....range(...)` não tem COMO detectar a página que falha — o error morre na
// desestruturação e `data:null` vira "acabou". Vale para laço E single-shot: mesmo fora
// de laço, um `.range()` cujo error é descartado lê falha como lista vazia.
const G1 = /const\s*\{\s*data(?:\s*:\s*\w+)?\s*\}\s*=\s*await\b[^;]{0,600}?\.range\(/;

// Allowlist G1 — cada entrada exige justificativa; entrada sem uso REPROVA (ver acima).
const G1_ALLOW: ReadonlySet<string> = new Set([
  // .range(1, 1) single-shot deliberado ("a 2ª visita mais recente") para decidir texto
  // de saudação — leitura cosmética, sem laço, sem money-path; falha degrada para o
  // texto default do dashboard. Convertê-la a {data, error} é welcome, não obrigatório.
  'src/hooks/useLastVisit.ts',
]);

// ── G3: coalescência de página (`?? []` / `|| []`) DENTRO de laço com `.range(` ───────
// A forma fina da classe (F3, controle: buscarTodasPaginas pré-#1564): o laço já lança
// em `error`, mas `data ?? []` converte a resposta malformada (`data:null` SEM error) em
// página vazia → EOF falso → o acumulado PARCIAL volta como se fosse a tabela inteira.
// Detecção posicional (não regex única): um `.range(` com `for`/`while` até 300 chars
// ANTES (laço local — callbacks de helper não têm) e `?? []`/`|| []` até 260 chars
// DEPOIS (o acumulador da página). Single-shots e callbacks de helper não casam.
function temG3(fonte: string): boolean {
  let i = -1;
  while ((i = fonte.indexOf('.range(', i + 1)) !== -1) {
    const antes = fonte.slice(Math.max(0, i - 300), i);
    const depois = fonte.slice(i, i + 260);
    if (/\b(for|while)\s*\(/.test(antes) && /(\?\?|\|\|)\s*\[\]/.test(depois)) return true;
  }
  return false;
}

// DÍVIDA G3 (baseline 2026-07-23, varredura completa da classe — chips de erradicação
// por domínio abertos na mesma data). NÃO adicione entradas: arquivo novo com o padrão
// é REINTRODUÇÃO e deve ser corrigido, não baselinado. Remova a entrada ao corrigir o
// arquivo (entrada sem uso reprova, mantendo a lista encolhendo).
const G3_DIVIDA: ReadonlySet<string> = new Set([
  'supabase/functions/ai-ops-agent/index.ts',
  'supabase/functions/algorithm-a-audit/index.ts',
  'supabase/functions/calculate-scores/index.ts',
  'supabase/functions/carteira-rebuild/index.ts',
  'supabase/functions/omie-analytics-sync/index.ts',
  'supabase/functions/omie-financeiro/index.ts',
]);

// ── G4: total de páginas do Omie confiado CRU (`|| 1` / `?? 1` por resposta) ──────────
// nTotPaginas/total_de_paginas é PISO, não verdade (docs/agent/sync.md): resposta
// intermediária sem o campo degrada para 1 e ENCOLHE o teto → o laço completa retrato
// PARCIAL como 'complete' (Codex P1 do #1353). O padrão correto vive em
// supabase/functions/_shared/omie-paginacao.ts: validarTotalPaginas (fail-fast
// anti-runaway) + proximoTotalPaginas (piso monotônico) + avaliarPagina (página vazia
// antes do fim declarado = anomalia, nunca "fim").
const G4 = /(nTotPaginas|total_de_paginas)\s*(\|\||\?\?)\s*1\b/;

// Allowlist PERMANENTE (usos legítimos da forma — não são dívida). O helper
// _shared/omie-paginacao.ts NÃO precisa de entrada: seu `Number(nTot ?? 1)` usa o
// parâmetro `nTot`, que a regex (ancorada nos nomes de campo do Omie) não casa.
const G4_ALLOW: ReadonlySet<string> = new Set([
  // `omieTruncado = (total_de_paginas ?? 1) > 1` é DETECÇÃO de truncamento que alimenta
  // o fail-closed doc-ambíguo (guardrail do edge-money-path-invariants) — não é teto.
  'supabase/functions/omie-sync/index.ts',
  // O `?? 1` monta o total DECLARADO cru que alimenta o guard local (paginacao.ts do
  // próprio edge: piso monotônico + vazia≤piso lança + teto lança — auditado 2026-07-23).
  'supabase/functions/omie-sync-status-produtos/index.ts',
]);

// DÍVIDA G4 (baseline 2026-07-23 — mesma regra da G3_DIVIDA: só encolhe, nunca cresce):
const G4_DIVIDA: ReadonlySet<string> = new Set([
  'supabase/functions/cmc-snapshot-backfill/index.ts',
  'supabase/functions/cmc-snapshot-smoke/index.ts',
  'supabase/functions/omie-analytics-sync/index.ts',
  'supabase/functions/omie-cliente/index.ts',
  'supabase/functions/omie-sync-ctes-recebidos/index.ts',
  'supabase/functions/omie-sync-estoque/index.ts',
  'supabase/functions/omie-sync-metadados/index.ts',
  'supabase/functions/omie-sync-vendas-items/index.ts',
  'supabase/functions/omie-vendas-sync/index.ts',
  'supabase/functions/sync-reprocess/index.ts',
  'supabase/functions/tint-omie-sync/index.ts',
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

  it('G1: nenhum `const { data } = await ....range(` descartando error fora da allowlist', () => {
    const { ocorrencias, allowlistSemUso } = varrer(G1, G1_ALLOW);
    expect(
      ocorrencias,
      `REINTRODUÇÃO da classe (F1 — error descartado na desestruturação; página que falha vira "acabou"). ` +
        `Use fetchAllPages (@/lib/postgrest), fetchAll (_shared/paginate.ts) ou desestruture { data, error } ` +
        `com throw. Sites:${formatar(ocorrencias)}`,
    ).toEqual([]);
    expect(
      allowlistSemUso,
      `entrada(s) de allowlist G1 sem uso — remova para a lista não mascarar reintrodução futura: ${allowlistSemUso.join(', ')}`,
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

  it('G3: nenhum laço `.range(` com `?? []`/`|| []` de página fora da dívida baselinada', () => {
    const ocorrencias: string[] = [];
    const dividaViva = new Set<string>();
    for (const dir of DIRS) {
      for (const arquivo of listarFontes(dir)) {
        if (!temG3(semComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8')))) continue;
        if (G3_DIVIDA.has(arquivo)) dividaViva.add(arquivo);
        else ocorrencias.push(arquivo);
      }
    }
    expect(
      ocorrencias,
      `REINTRODUÇÃO da classe (F3 — \`?? []\` sobre página dentro de laço: data:null sem error vira ` +
        `EOF falso e o acumulado PARCIAL passa por completo). Lance em data==null ou use um helper ` +
        `canônico (fetchAllPages/fetchAll/buscarTodasPaginas/coletarPaginado/paginateAll). ` +
        `Arquivos: ${ocorrencias.join(', ')}`,
    ).toEqual([]);
    const quitados = [...G3_DIVIDA].filter((a) => !dividaViva.has(a));
    expect(
      quitados,
      `dívida G3 quitada — REMOVA da baseline para ela só encolher: ${quitados.join(', ')}`,
    ).toEqual([]);
  });

  it('G4: nenhum total Omie confiado cru (`|| 1` / `?? 1`) fora da allowlist + dívida baselinada', () => {
    const allow = new Set([...G4_ALLOW, ...G4_DIVIDA]);
    const { ocorrencias, allowlistSemUso } = varrer(G4, allow);
    expect(
      ocorrencias,
      `REINTRODUÇÃO da classe (F4 — total do Omie confiado por resposta; intermediária sem o campo ` +
        `encolhe o teto e o parcial completa como 'complete'). Use validarTotalPaginas/proximoTotalPaginas/` +
        `avaliarPagina de _shared/omie-paginacao.ts. Sites:${formatar(ocorrencias)}`,
    ).toEqual([]);
    expect(
      allowlistSemUso,
      `entrada(s) de allowlist/dívida G4 sem uso — remova para a lista só encolher: ${allowlistSemUso.join(', ')}`,
    ).toEqual([]);
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
    expect(temG3(lacoAfetado), 'G3 deixou de casar o laço-controle afetado').toBe(true);
    // Callback de fetchAllPages (sem laço local; o for vive no helper) — não casa:
    const callbackCorreto = `
  const custos = await fetchAllPages(
    (de, ate) =>
      supabase.from('product_costs').select('product_id, cost_final')
        .order('product_id', { ascending: true }).range(de, ate),
    'product_costs/exemplo',
  );
  const mapa = new Map((outraCoisa ?? []).map((x) => [x.id, x]));`;
    expect(temG3(callbackCorreto), 'G3 casa callback de helper — falso positivo de calibração').toBe(false);
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
});
