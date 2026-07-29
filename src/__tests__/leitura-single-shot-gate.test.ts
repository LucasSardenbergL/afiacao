import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ── GATE ESTRUTURAL da classe "leitura single-shot cuja FALHA vira ZERO" ─────────────
//
// Irmã não-paginada da classe dos ~20 PRs de paginação (money-path §6/§7/§9). Lá a página
// que falhava virava "fim da lista"; aqui a LEITURA que falha vira "a tabela está vazia":
//
//     const saldo_cc = (ccRes.data ?? []).reduce(...)   // error descartado → 0
//
// O gate de paginação (paginacao-artesanal-gate.test.ts) NÃO enxerga estes sites: todos
// os padrões dele exigem `.range(`, e single-shot não tem laço nenhum. Instância-âncora:
// fin-cashflow-engine/carregarDados, 6 leituras — saldo em conta, eventos recorrentes e
// eventuais, estoque, CMV TTM e config — que alimentavam a projeção de 13 semanas, a NCG
// e os dias de cobertura. Uma falha transitória de RLS/timeout saía como caixa ZERO, com
// resposta 200, e o cron diário PERSISTIA o resultado em fin_projecao_snapshots +
// fin_alertas (alerta de caixa negativo falso, disparado por erro de transporte).
//
// CONTRATO (o que `_shared/leitura-critica.ts` implementa) — três estados que o `?? 0`
// colapsava num só:
//   - `error` presente                → LANÇA (o valor é DESCONHECIDO, não zero);
//   - `data` null/[] SEM `error`      → ausência LEGÍTIMA, o fallback do caller vale;
//   - a linha existe e vale 0         → zero de verdade, atravessa intacto.
//
// ESCOPO: só `supabase/functions/`. Em `src/` a mesma forma textual (`x.data ?? []`) é
// dominada por objetos do react-query, que expõem `error` num campo À PARTE e por isso
// são legítimos — a assinatura NÃO discrimina lá (medição 2026-07-28: 127 ocorrências em
// 56 arquivos, mistura real de afetados como `useTeamKpis`/`useGamificationScore` com
// falsos positivos como `usePontoEquilibrio`). Baselinar src/ sem triar tornaria o gate
// vermelho em código legítimo, que é o defeito que "ensina a ignorar o vermelho"
// (money-path: "o VALIDADOR mente"). A erradicação de src/ tem chip próprio, e o
// pré-requisito dele é refinar a assinatura para exigir origem em `await supabase.from`.

const RAIZ = resolve(__dirname, '../..');
const DIRS = ['supabase/functions'];
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

// Comentários fora antes de medir: sem isso a prosa que DESCREVE o defeito (o cabeçalho
// de leitura-critica.ts cita `?? []` de propósito) dispara o gate — o assert mediria o
// texto que o próprio fix escreveu (money-path #1472/#1488).
function semComentarios(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

// ── G5: `.data` coalescido — o `error` nunca foi consultado ──────────────────────────
// As formas REAIS do repo, todas medidas antes de fixar o padrão (lição do G4, cujo `\s*`
// não atravessava ` as number)` e media 0 em arquivo com 6 sites vivos):
//   `.data ?? []`   `.data || []`   `.data ?? {}`   `.data ?? 0`   `.data ?? null`
//   `.data as { valor?: number } | null`        (cast que ADMITE o null e segue)
//   `(x.data as DadosBase['prazos']) ?? null`   (cast e só DEPOIS o coalesce)
// A última forma custou uma rodada vermelha: a 1ª versão exigia `| null` dentro do cast e
// media 0 justamente na linha do `prazos`. Mesma armadilha do G4 (`\s*` que não atravessa
// ` as number)`) — controle de calibração com as formas REAIS, não só a canônica.
// O `(?<!\?)` exclui `objeto?.data`, que é encadeamento opcional sobre um valor já lido
// (ex.: `origemEmail?.data`), não o `.data` de uma resposta PostgREST.
// `[^;\n]` e não `[^;]`: o ramo do cast NÃO pode atravessar linha. Com `[^;]`, o match de
// `header.data as unknown as PedidoProgramado,` — que não tem coalescência nenhuma e NÃO é a
// classe — se estica por duas linhas até o `??` seguinte e ENGOLE o `envios.data ?? []` de
// baixo, que é a classe. Um falso match acidental escondendo um legítimo (medido em
// usePedidosProgramados na triagem de src/). Contagem das edges: idêntica antes e depois, em
// todos os 7 arquivos da baseline — o refino não reescreve a dívida, só para de mentir.
const G5 = /(?<!\?)\.data\s*(?:(?:\?\?|\|\|)\s*(?:\[\]|\{\}|0\b|null\b)|as\s[^;\n]{0,90}?(?:\|\s*null|\?\?))/;

// Baseline por CONTAGEM (não por caminho): um 2º site nascendo num arquivo já listado
// REPROVA. Contagem menor também reprova, pedindo a atualização — a lista só encolhe, e
// encolhe registrada. Varredura de 2026-07-28, com veredito individual de cada site:
//
//  visit-score-recalc-client (6) — L215 classCfgRes e L218 scoresRes JÁ-CORRETOS (o
//      arquivo checa .error dos dois e degrada de propósito, fail-safe do shadow-mode);
//      L219 visitsRes, L220 ordersRes, L221 addressRes, L222 profileRes AFETADOS
//      (nenhum checa .error → "nunca visitou"/"0 pedidos" fabricados no scoring).
//  visit-score-recalc-batch (2)  — L107 callsRes, L114 visitsRes AFETADOS.
//  omie-financeiro (2)           — L1744 cfgRes TOLERADO (coluna opcional dre_tributario:
//      quando não existe o PostgREST devolve ERRO, e checá-lo derrubaria a engine);
//      L1747 histRes JÁ-CORRETO (`if (histRes.error) throw` na linha acima).
//  carteira-rebuild (1)          — L438 mapRes JÁ-CORRETO (failLease acima).
//  whatsapp-send-template (1)    — L145 insRes JÁ-CORRETO (checa .error logo abaixo,
//      inclusive o 23505 da idempotência).
//  omie-sync-vendas-items (1)    — L369 FALSO POSITIVO: `result` é resposta da API Omie
//      (OmieNfResponseData), não do PostgREST; não há `error` a consultar.
//  fin-cashflow-engine (0)       — era 7 antes desta entrega: 6 passaram a exigirLeitura/
//      tolerarLeitura e o folhaCatRes virou tolerarColunaAusente (que tolera SÓ os códigos
//      de coluna inexistente e lança em timeout/RLS). Arquivo QUITADO, fora da baseline.
//
// ⇒ 6 AFETADOS, todos no domínio scoring/farmer, com chip de erradicação próprio.
const G5_BASELINE: ReadonlyMap<string, number> = new Map([
  ['supabase/functions/carteira-rebuild/index.ts', 1],
  ['supabase/functions/omie-financeiro/index.ts', 2],
  ['supabase/functions/omie-sync-vendas-items/index.ts', 1],
  ['supabase/functions/visit-score-recalc-batch/index.ts', 2],
  ['supabase/functions/visit-score-recalc-client/index.ts', 6],
  ['supabase/functions/whatsapp-send-template/index.ts', 1],
]);

function contarPorArquivo(padrao: RegExp): Map<string, number> {
  const mapa = new Map<string, number>();
  const g = new RegExp(padrao.source, 'g');
  for (const dir of DIRS) {
    for (const arquivo of listarFontes(dir)) {
      const fonte = semComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      const n = [...fonte.matchAll(g)].length;
      if (n > 0) mapa.set(arquivo, n);
    }
  }
  return mapa;
}

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

// ── G6: a MESMA classe em `src/` — a ORIGEM é que discrimina ─────────────────────────
//
// O cabeçalho acima explicava por que `src/` tinha ficado de fora: lá a mesma forma textual
// é DOMINADA por objetos do react-query, que expõem `error` num campo à parte e por isso são
// legítimos (`rateioQ.data ?? null` num `useMemo` não descarta erro nenhum). Baselinar `src/`
// por contagem deixaria ~69 sites de código CORRETO vermelhos — o defeito que ensina a
// ignorar o vermelho. A triagem de 2026-07-28 resolveu isso: o que discrimina não é a forma,
// é a ORIGEM do identificador antes do `.data`.
//
// Por isso aqui a regra é SEMÂNTICA, não uma lista de arquivos:
//   origem PostgREST (awaited)  +  `.error` NUNCA mencionado no arquivo  ⇒  REPROVA
//   origem react-query (hook)                                           ⇒  ignorado
// Assim código novo em react-query nunca fica vermelho, e uma leitura crua nova
// (`const x = await supabase.from(…)` + `x.data ?? []` sem consultar `x.error`) fica vermelha
// NA HORA — sem precisar de baseline nova.
//
// Medição de 2026-07-28 sobre `src/`: 130 ocorrências / 57 arquivos ⇒ 69 `hook` (ignorados),
// 31 origem-PostgREST com `.error` consultado (legítimos) e 30 AFETADOS, erradicados nas
// Fases 1-4 (#1604, #1605, #1606, #1607).
const DIRS_SRC = ['src'];

const IDENT = /^[A-Za-z_$][\w$]*$/;
const escId = (s: string) => s.replace(/\$/g, '\\$');

// O argumento de tipo é OPCIONAL no padrão: sem o `(?:<…>)?` o `useQuery<ActiveOverride|null>(`
// de usePeriodOverride/useUnifiedOrder/FinanceiroValor não casava e o hook caía em
// "indefinido" — a mesma armadilha do G4 (o padrão que não atravessa a forma REAL do repo).
const declHook = (id: string) =>
  new RegExp(
    `\\bconst\\s+${id}\\s*=\\s*use[A-Z]\\w*\\s*(?:<[^>(]{0,160}>)?\\s*\\(` +
      `|\\bconst\\s*\\{[^}]{0,200}\\b${id}\\b[^}]{0,200}\\}\\s*=\\s*use[A-Z]\\w*\\s*(?:<[^>(]{0,160}>)?\\s*\\(`,
  );

type Origem = 'hook' | 'postgrest' | 'indefinido';

function origemDe(fonte: string, ident: string): Origem {
  if (!IDENT.test(ident)) return 'indefinido';
  const id = escId(ident);
  if (declHook(id).test(fonte)) return 'hook';
  if (new RegExp(`\\bconst\\s+${id}\\s*=\\s*await\\b`).test(fonte)) return 'postgrest';
  // `const [a, X, b] = await Promise.all([…])` — a forma mais comum da classe neste repo.
  for (const m of fonte.matchAll(/\bconst\s*\[([^\]]*)\]\s*=\s*await\b/g)) {
    if (m[1].split(',').some((p) => p.trim().replace(/\s*[:=][\s\S]*$/, '') === ident)) {
      return 'postgrest';
    }
  }
  // `let X = supabase.from(…)` montado antes e awaited dentro de um Promise.all (useTeamKpis).
  if (new RegExp(`\\b(?:let|const)\\s+${id}\\s*=\\s*\\w+[\\s\\S]{0,60}?\\.from\\s*\\(`).test(fonte)) {
    return 'postgrest';
  }
  return 'indefinido';
}

// Basta a MENÇÃO de `X.error` no arquivo: o gate cobra que alguém tenha OLHADO o erro, não a
// forma do tratamento — lançar, degradar com motivo ou tolerar são decisões do consumidor
// (money-path §7: "consertar o helper não conserta a tela").
const erroConsultado = (fonte: string, ident: string) =>
  IDENT.test(ident) && new RegExp(`\\b${escId(ident)}\\.error\\b`).test(fonte);

/** Sites de `src/` com origem PostgREST cujo `error` ninguém consultou. */
function sitesCrusEmSrc(): Map<string, number> {
  const mapa = new Map<string, number>();
  const g = new RegExp(G5.source, 'g');
  for (const dir of DIRS_SRC) {
    for (const arquivo of listarFontes(dir)) {
      const fonte = semComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      let n = 0;
      for (const m of fonte.matchAll(g)) {
        const antes = fonte.slice(0, m.index);
        const ident = (antes.match(/([A-Za-z_$][\w$]*)\s*$/) ?? [])[1] ?? '?';
        // `(await supabase.from(…)).data` — sem variável, o `error` é inalcançável por
        // construção. Conta como cru (foi assim que os 2 sites de usePedidosProgramados
        // escaparam de qualquer checagem até o #1605).
        const inline = ident === '?' && antes.trimEnd().endsWith(')') && /await[\s\S]{0,400}$/.test(antes);
        if (inline) { n++; continue; }
        if (origemDe(fonte, ident) === 'postgrest' && !erroConsultado(fonte, ident)) n++;
      }
      if (n > 0) mapa.set(arquivo, n);
    }
  }
  return mapa;
}

// Dívida TRIADA de `src/` — cada entrada com o veredito de por que continua aqui. Não é
// "ainda não olhei": é "olhei e decidi". A lista só encolhe, e encolhe registrada.
const SRC_BASELINE: ReadonlyMap<string, number> = new Map([
  // TOLERADO com justificativa NO CÓDIGO: o selo "inativo no Omie" é informativo e o próprio
  // arquivo documenta a degradação ("falha da query degrada em silêncio (sem selo) — a
  // barreira money-path é a trava do disparo", que vive em disparo-gate-helpers). Decisão do
  // autor, com barreira real noutro lugar.
  ['src/components/reposicao/pedidos/useDetalhesModal.ts', 2],
]);

// Fora da baseline por DESENHO, não por esquecimento — a origem não resolve para PostgREST e
// o G6 nem os conta (documentado aqui para a próxima varredura não os "redescobrir"):
//   `useCustomerSelection` (`localPriceResult`) e `reposicao/pedidos/shared.ts` (`settled.value`)
//     vêm de `Promise.allSettled`, que não expõe `.error` — o erro JÁ é tratado por outra via
//     (`failedIdxs` / `status === 'rejected'`).
//   `useAnalyticsSync` (`query.state.data`) e `FinanceiroValor` (`q.data`, com `q` vindo de um
//     array de objetos) são react-query lidos por caminho que a resolução textual não segue.
//   `useProductCatalog` e `useUtiContas` já consultam o `error` na linha de cima.

describe('gate estrutural: leitura single-shot que trata falha como zero (irmã da classe #1338→#1598)', () => {
  it('sentinela: o walker anda de verdade (glob quebrado = verde eterno; ausência de sinal ≠ aprovação)', () => {
    const fontes = DIRS.flatMap((d) => listarFontes(d));
    expect(fontes.length).toBeGreaterThan(80);
    expect(fontes).toContain('supabase/functions/fin-cashflow-engine/index.ts');
  });

  it('G5: nenhuma leitura single-shot coalescida além da baseline triada', () => {
    const { reintroducoes, quitacoes } = desvios(contarPorArquivo(G5), G5_BASELINE);
    expect(
      reintroducoes,
      'Leitura nova descartando `error`: `x.data ?? []` não distingue "falhou" de "vazio". ' +
        'Use exigirLeitura/tolerarLeitura de _shared/leitura-critica.ts.',
    ).toEqual([]);
    expect(
      quitacoes,
      'Site quitado (ou arquivo movido): atualize G5_BASELINE — a lista só encolhe, e encolhe registrada.',
    ).toEqual([]);
  });

  it('G5 (controle de calibração): as formas REAIS do repo são detectadas — e a pós-fix não', () => {
    // Pré-fix: as 6 leituras do fin-cashflow-engine antes desta entrega, verbatim.
    const preFix = [
      `const saldo_cc = ((ccRes.data ?? []) as Array<{ saldo_atual?: number | null }>)`,
      `const cmv_ttm = ((dreRes.data ?? []) as Array<{ cmv?: number }>)`,
      `eventos_rec: (recRes.data ?? []) as unknown as EventoRecorrente[],`,
      `const estoque_valor = Number((estoqueRes.data as { valor?: number } | null)?.valor ?? 0);`,
      `const prazos = (prazosRes.data as DadosBase['prazos']) ?? null;`,
      // Formas irmãs medidas em OUTRAS edges — sem elas o gate teria o furo do G4.
      `const address = (addressRes.data ?? {}) as Record<string, unknown>;`,
      `const tools = toolsRes.data || [];`,
      `const total = somaRes.data ?? 0;`,
    ];
    for (const linha of preFix) {
      expect(G5.test(linha), `deveria casar: ${linha}`).toBe(true);
    }

    // Pós-fix: o erro passa pelo helper ANTES do fallback — nada a casar.
    const posFix = [
      `const saldo_cc = ((exigirLeitura(ccRes, 'fin_contas_correntes') ?? []) as Array<{ saldo_atual?: number | null }>)`,
      `const estoqueRow = exigirLeitura(estoqueRes, 'fin_estoque_valor') as { valor?: number } | null;`,
      `const prazosLeitura = tolerarLeitura(prazosRes, 'v_capital_giro_prazos');`,
      // Encadeamento opcional sobre valor já lido não é resposta PostgREST.
      `p_origem_email_data: origemEmail?.data ?? null,`,
    ];
    for (const linha of posFix) {
      expect(G5.test(linha), `NÃO deveria casar: ${linha}`).toBe(false);
    }
  });

  it('G5 pin: as 6 leituras corrigidas do fin-cashflow-engine não voltam ao `?? 0` cru', () => {
    const fonte = semComentarios(
      readFileSync(resolve(RAIZ, 'supabase/functions/fin-cashflow-engine/index.ts'), 'utf8'),
    );
    // Pin por FONTE nomeada (não por contagem): o gate genérico não protege QUAL leitura
    // ficou coberta — trocar uma por outra manteria a contagem em 1. Money-path: "gate de
    // forma não protege a ESCOLHA; quando a chave é a defesa, pine a chave".
    for (const tabela of [
      'fin_contas_correntes',
      'fin_eventos_recorrentes',
      'fin_eventos_eventuais',
      'fin_estoque_valor',
      'fin_dre_snapshots',
      'fin_config_cashflow',
    ]) {
      expect(
        new RegExp(`exigirLeitura\\([A-Za-z]+Res, '${tabela}'\\)`).test(fonte),
        `${tabela} deixou de passar por exigirLeitura — a falha volta a virar zero`,
      ).toBe(true);
    }
    // A que degrada em vez de lançar continua degradando COM motivo.
    expect(/tolerarLeitura\([A-Za-z]+Res, 'v_capital_giro_prazos'\)/.test(fonte)).toBe(true);
    // E a coluna opcional continua tolerando SÓ coluna ausente (não qualquer erro).
    expect(/tolerarColunaAusente\(folhaCatRes,/.test(fonte)).toBe(true);
    // Nenhum `.data` cru sobrou no arquivo-âncora: o pin acima garante QUAIS fontes estão
    // cobertas, este garante que não nasceu uma 9ª leitura fora do contrato.
    expect(fonte.match(/(?<!\?)\.data\s*(?:\?\?|\|\|)/g) ?? []).toEqual([]);
  });

  // ── G6 — `src/` ────────────────────────────────────────────────────────────────────
  it('G6 sentinela: o walker anda em src/ também (glob quebrado = verde eterno)', () => {
    const fontes = DIRS_SRC.flatMap((d) => listarFontes(d));
    expect(fontes.length).toBeGreaterThan(500);
    expect(fontes).toContain('src/hooks/useTeamKpis.ts');
  });

  it('G6: nenhuma leitura PostgREST em src/ descarta o `error` além da dívida triada', () => {
    const { reintroducoes, quitacoes } = desvios(sitesCrusEmSrc(), SRC_BASELINE);
    expect(
      reintroducoes,
      'Leitura nova em src/ descartando `error`: `const x = await supabase.from(...)` seguido ' +
        'de `x.data ?? []` sem NINGUÉM consultar `x.error` — "falhou" fica indistinguível de ' +
        '"vazio". Consulte o erro (throw dentro do queryFn, ou degrade para null COM motivo). ' +
        'Objeto de react-query não cai aqui: ele expõe `error` à parte.',
    ).toEqual([]);
    expect(
      quitacoes,
      'Site quitado (ou arquivo movido): atualize SRC_BASELINE — a lista só encolhe, e encolhe registrada.',
    ).toEqual([]);
  });

  it('G6 (controle de calibração): discrimina PostgREST de react-query nas formas REAIS', () => {
    // AFETADOS reais, verbatim do pré-fix das Fases 1-4: origem awaited, `error` nunca olhado.
    const afetados = [
      `const [toolsRes, qualityRes] = await Promise.all([\n  supabase.from('user_tools').select('id'),\n]);\nconst tools = toolsRes.data || [];`,
      `const [salesRes, callsRes] = await Promise.all([qSales, supabase.from('farmer_calls').select('x')]);\nconst a = (callsRes.data ?? []).map((r) => r.farmer_id);`,
      `const cmResp = await supabase.from('v_sku_parametros_sugeridos').select('x');\n((cmResp.data ?? []) as unknown as ParamRow[]).forEach(() => {});`,
    ];
    for (const src of afetados) {
      const ident = (src.match(/([A-Za-z_$][\w$]*)\.data/) ?? [])[1] ?? '?';
      expect(origemDe(src, ident), `${ident} deveria ser postgrest`).toBe('postgrest');
      expect(erroConsultado(src, ident), `${ident} não consulta .error`).toBe(false);
    }

    // FALSOS POSITIVOS reais (usePontoEquilibrio/useUnifiedOrder): react-query, `error` à
    // parte. Se algum destes virar 'postgrest', o gate começa a reprovar código correto — é
    // exatamente o cenário que manteve src/ fora do gate até aqui.
    const legitimos = [
      `const rateioQ = useCustoRateio(company, 'folha');\nconst row = rateioQ.data ?? null;`,
      `const snaps = useSnapshotsTTM(company);\nreturn { meses: snaps.data ?? [] };`,
      `const cats = useQuery({ queryKey: ['x'] });\nconst descPorCod = cats.data ?? {};`,
      // Com argumento de TIPO — a forma que fazia o padrão ingênuo falhar.
      `const obenFormasQuery = useQuery<FormaPagamento[]>({ queryKey: ['f'] });\nconst f = obenFormasQuery.data || [];`,
    ];
    for (const src of legitimos) {
      const ident = (src.match(/([A-Za-z_$][\w$]*)\.data/g) ?? []).slice(-1)[0]?.replace('.data', '') ?? '?';
      expect(origemDe(src, ident), `${ident} deveria ser hook (react-query)`).toBe('hook');
    }

    // E o pós-fix de uma leitura PostgREST: o `error` foi consultado → sai do escopo do G6
    // mesmo mantendo o `?? []` (o fallback continua válido para ausência LEGÍTIMA).
    const posFix = `const cmResp = await supabase.from('v').select('x');\nif (cmResp.error) throw cmResp.error;\nconst m = cmResp.data ?? [];`;
    expect(origemDe(posFix, 'cmResp')).toBe('postgrest');
    expect(erroConsultado(posFix, 'cmResp')).toBe(true);
  });

  it('G6 (falsificação): reintroduzir a classe num arquivo real REPROVA', () => {
    // Sem esta prova o gate é decoração: um walker quebrado, um padrão que não casa a forma
    // real ou uma origem mal resolvida dariam verde eterno. Aqui o defeito é injetado no
    // TEXTO de um arquivo que o gate realmente varre, e o veredito tem de virar.
    const arquivoReal = resolve(RAIZ, 'src/hooks/useTeamKpis.ts');
    const fonte = semComentarios(readFileSync(arquivoReal, 'utf8'));
    const sabotado = `${fonte}\nasync function _sabotagem() {\n  const novoRes = await supabase.from('sales_orders').select('id');\n  return novoRes.data ?? [];\n}\n`;

    const g = new RegExp(G5.source, 'g');
    const crus = [...sabotado.matchAll(g)].filter((m) => {
      const antes = sabotado.slice(0, m.index);
      const ident = (antes.match(/([A-Za-z_$][\w$]*)\s*$/) ?? [])[1] ?? '?';
      return origemDe(sabotado, ident) === 'postgrest' && !erroConsultado(sabotado, ident);
    });
    expect(crus.length, 'a leitura crua injetada TEM de ser detectada').toBeGreaterThan(0);

    // E o contrapositivo: a MESMA leitura, com o `error` consultado, não acusa.
    const corrigido = sabotado.replace(
      `return novoRes.data ?? [];`,
      `if (novoRes.error) throw novoRes.error;\n  return novoRes.data ?? [];`,
    );
    const crusDepois = [...corrigido.matchAll(new RegExp(G5.source, 'g'))].filter((m) => {
      const antes = corrigido.slice(0, m.index);
      const ident = (antes.match(/([A-Za-z_$][\w$]*)\s*$/) ?? [])[1] ?? '?';
      return origemDe(corrigido, ident) === 'postgrest' && !erroConsultado(corrigido, ident);
    });
    expect(crusDepois.length, 'consultar o `error` tem de zerar o achado').toBe(0);
  });
});
