# Varredura semgrep refeita com o `static-analysis` 1.4.5 pinado (2026-09-27)

> Issue de origem: #2584 (reinstalação pinada da Trail of Bits, PR #2589). Alvo: `main` em `ee75a2a2a`.
> Semgrep 1.168.0 **OSS** (Pro indisponível: sem `semgrep login`), plugin `static-analysis` 1.4.5 do
> marketplace de diretório em `0cc1c73`. Modo *run-all*, 15 scans, `--metrics=off`.

## TL;DR

- **Os 15 rulesets carregaram regras**, reconciliados regra a regra (SARIF × `semgrep --validate`),
  com 0 `failed`, 0 `skipped` e 0 `coveredNothing`. A reconciliação cobre também o que o `partial` do runner NÃO mostra.
- **252 achados** no SARIF mesclado → **2 reais, ambos endurecimento de CI (P3)**. Do semgrep em código
  de produto (front, edges, conector Go): **0 real**. Money-path/authz: **0**.
- **P1 de 2026-05-25 (#288) segue fechado em produção** (`psql-ro`, 4/4 RPCs com gate). **P2 `.or()`
  (#284/#293/#322) não reapareceu**: 39 `.or()` inventariados, 0 injeção estrutural. Sobram 3 brechas
  de **curinga** de ILIKE (P3/P4) que o semgrep não enxerga, achadas pelo inventário.
- **O próprio runner pinado tinha mais um modo de falha silenciosa**, além dos 3 que o fix #250 da
  ToB fechou: rodado da raiz do repo, o `--include` dos rulesets JS/TS escaneia **3 de 1.701 `.ts`**
  (medido). Contorno: rodar de um diretório vazio (ver §Defeitos do runner).

## Por que refazer

A única varredura semgrep anterior (2026-05-25, "auditoria de 3 frentes") rodou com a cópia velha do
plugin (1.2.1), que fazia `semgrep --config <dir>` sem tratar exit code. O
[trailofbits/skills#250](https://github.com/trailofbits/skills/pull/250) mostrou três efeitos. YAML
que não é regra dentro do repo de regras dá exit 7 e zera o ruleset. Regra `mode: join` derruba o
processo. E exit 2 (regra que não compila) era lido como "não rodou". Ou seja: ToB e elttam podiam
não ter contribuído nada, sem aviso. Não sobrou saída daquela varredura no disco, então este doc
guarda os números.

## Como rodou (reproduzível)

Plano (`rulesets.json`), montado pelo algoritmo do `references/rulesets.md` da skill a partir das
linguagens rastreadas (`git ls-files`): TS/TSX 2.775, Go 28 (`connector/sayersync`, que entrou em
2026-06-10, **depois** da auditoria antiga), Python 5 (scripts de lab), GitHub Actions 4.

| unidade | rulesets |
|---|---|
| baseline (sem `--include`) | `p/security-audit`, `p/secrets` |
| javascript (`*.js *.jsx *.mjs *.cjs *.ts *.tsx`) | `p/javascript`, `p/typescript`, `p/react`, `p/nodejs` |
| go / python / github-actions | `p/golang` / `p/python` / `p/github-actions` |
| yaml | `r/yaml`. **`p/yaml` do catálogo da skill dá HTTP 404 no registry** (0 regras) |
| terceiros (sem `--include`) | ToB, elttam, Apiiro (JS/TS) e dgryski, kondukto (Go) |

Execução: `heavy run-scans.sh --mode run-all --jobs 2`, **com o CWD num diretório vazio**. A saída
fica FORA do alvo, no scratchpad da sessão, e por isso `excludePattern` sai vazio. O runner levou
cerca de 10 min, mais a fila do `heavy`. SHAs dos clones: ToB `31390b3a99c0`, elttam `244268562cc9`,
Apiiro `a21246b666f3`, dgryski `db0227c03f4b` e kondukto `e5d446522d9a`.

## Prova de que cada ruleset carregou regras

A régua é o nº de regras em `runs[].tool.driver.rules` do SARIF de cada scan contra o `--validate`
da mesma config (registry) ou do clone já podado (terceiros). A coluna "arquivos" é `paths.scanned`
do JSON: prova que a regra alcançou a linguagem (dgryski/kondukto só abrem os 15 `.go`, o que prova
que só têm regra Go).

| scan | `--validate` | SARIF | arquivos | achados | erro de REGRA no scan |
|---|---:|---:|---:|---:|---|
| `p/security-audit` | 225 | 225 | 5.033 | 19 | — |
| `p/secrets` | 52 | 52 | 5.033 | 0 | — |
| `p/javascript` · `p/typescript` | 74 · 74 | 74 · 74 | 2.776 (ts 1.701) | 0 · 0 | — |
| `p/react` · `p/nodejs` | 4 · 36 | 4 · 36 | 2.776 | 0 · 0 | — |
| `p/golang` · `p/python` | 42 · 151 | 42 · 151 | 15 · 5 | 0 · 3 | — |
| `p/github-actions` · `r/yaml` | 12 · 94 | 12 · 94 | 4 · 4 | 28 · 39 | — |
| ToB | 120 | 120 | 5.033 | 2 | — (podou 27 YAML não-regra) |
| elttam | 106, 12 erros | 94 | 5.033 | 4 | 12 regras **Java** não compilam (sem alvo aqui); podou 14 não-regra + 1 `join` |
| Apiiro | 101 declaradas | 95 | 3.254 | 181 | 4 não compilam: 2 Dart, 1 Java e **1 JS/TS (`javascript-obfuscation-conditions`)**. 101 → 99 ids únicos (2 colisões dir+id, C#/Lua) − 4 = 95 |
| dgryski · kondukto | 66 · 15 | 66 · 16 | 15 · 15 | 4 · 0 | — (os 2 "erros" do `--validate` do kondukto são LINT de cláusula duplicada; a regra roda) |

**Perda real de cobertura de regra para o nosso código: 1 regra** (a JS/TS do Apiiro). O resto que
não compilou é de linguagem ausente.

## Defeitos do runner pinado (e contorno)

1. **`--include` expandido contra o CWD.** Em `build_argv`, o `for g in $includes` (sem `set -f`)
   faz *pathname expansion*: da raiz do repo, `*.js` vira `eslint.config.js postcss.config.js` e
   `*.ts` vira `tailwind.config.ts vite.config.ts vitest.config.ts`. **Medido** com regra trivial de
   TS: lista defeituosa → `ts=3 tsx=1068`; lista correta → `ts=1701 tsx=1068`. Todas as edges
   (`service_role`), hooks, services e `lib/` ficariam fora, e **nada acusa**: `filesScanned > 0`, logo
   não cai em `coveredNothing`. O `--dry-run` mostrou; o controle (mesmo plano, só o CWD muda)
   provou. O workflow `/static-analysis:semgrep-scan` roda com o projeto como CWD, então herda o
   bug. Upstream: **já reportado** em
   [trailofbits/skills#297](https://github.com/trailofbits/skills/issues/297) (aberto em
   2026-09-07; correção `set -f`/`set +f` sugerida e confirmada num comentário de 2026-09-25), e
   ainda não mergeado no `main` = `0cc1c73`. A 1ª busca desta sessão por título NÃO o achou; a
   busca por palavra solta ("glob", "cwd") achou. **Contorno:** `cd "$(mktemp -d)"` antes de chamar
   o `run-scans.sh` (todos os caminhos já são absolutos).
2. **`partial` subnotifica no 1.168.** Regra que não compila sai em `errors[]` com `level: warn` e
   **exit 0**, e o runner só marca `partial` no exit 2. Resultado: `partial:false` nos 15, inclusive
   elttam (12) e Apiiro (4). **`partial:false` não prova que tudo compilou**; a prova é a tabela acima.
3. **`--timeout-threshold 3` (default) abandona o arquivo.** No elttam, `connector/sayersync/sync.go`
   (o arquivo central do conector) bateu 3 timeouts, e o resto das regras daquele ruleset não rodou
   nele. Fecho: re-rodar cada config só nos arquivos com timeout, com
   `--timeout 120 --timeout-threshold 0 -j 1`. Resultado: secrets 2 arq · security-audit 11 · ToB 3 ·
   elttam 11 · javascript 1 · nodejs 3 · react 9 · typescript 1 → **0 timeout restante, 0 achado novo**.
   Apiiro 32 arq → 3 timeouts restantes (heurística de ofuscação), 0 achado novo (ver §Cobertura).
4. **`p/yaml` 404** (catálogo da skill desatualizado) → trocado por `r/yaml` (94 regras). Mesma
   classe de [trailofbits/skills#299](https://github.com/trailofbits/skills/issues/299) (`p/express`
   404). E o teto de 1 MB por arquivo, que descartou o `schema-snapshot.sql` em silêncio, é o
   [trailofbits/skills#298](https://github.com/trailofbits/skills/issues/298).

## Cobertura: o que esta varredura NÃO viu

- **Motor OSS = análise intra-arquivo.** Sem taint entre arquivos (edge → helper → query).
- **Código de teste fora** pelo `.semgrepignore` padrão: os 13 `*_test.go`, `src/test/` e
  `supabase/tests/`. Também ficou fora `supabase/schema-snapshot.sql` (2,1 MB, acima do teto de 1 MB).
  Código de produção: 100% dos arquivos rastreados.
- **SQL/PL-pgSQL (844 arquivos) sem regra.** O semgrep não analisa RLS/`SECURITY DEFINER`, e essa
  frente é dos sentinelas `authz:*:prod`. Shell só pelas regras genéricas e as de bash do Apiiro.
- **Parse parcial** (`PartialParsing`, parser TS do semgrep) em 10 arquivos de produção: `UXRules`,
  `TintApiContract`, `TechnicalDocs`, `RotaPropostas`, `GovernanceAudit`, `AdminReposicaoCadastros`,
  `AdminEstoquePicking`, `AdminAnalyticsSync`, `useBundleEngine` e `KbSpecsForm`. O trecho não parseado
  não foi analisado.
- **Apiiro, 34 timeouts em 32 arquivos:** 30 da heurística `javascript-obfuscation-reconstruction` e 4
  de `dynamic-execution`/`indirect-execution`. O re-scan com 120 s fechou 31 (as 4 de execução
  dinâmica inclusive), com **0 achado novo** (os 23 que ele relatou já estavam no scan principal,
  mesmo regra+arquivo+linha). **Furo residual:** a heurística `javascript-obfuscation-reconstruction`
  não termina em `src/hooks/useBundleEngine.ts`, `src/hooks/useRoutePlanner.ts` e
  `src/__tests__/edge-money-path-invariants.test.ts` nem com 120 s.

## Triagem: 252 → 2 reais

| bucket (regra) | n | veredito | prova |
|---|---:|---|---|
| `generic-one-liners` (Apiiro) | 112 | FP | linha longa: texto de docs, classes Tailwind, texto de recibo |
| `generic-obfuscation-operators` (Apiiro) | 34 | FP | aritmética (aproximação da `erf`) e a regex do "sem registros" do Omie |
| `github-actions-mutable-action-tag` + `third-party-action-not-pinned-to-commit-sha` | 27 + 11 | **REAL — P3** | ver A1 |
| `bash-dynamic-execution-exec-eval` | 16 | FP | `got="$(eval "$3")"` são helpers de asserção de `db/test-*.sh` e harness de teste |
| `javascript-suspicious-declaration-names` | 11 | FP | helpers de data `yyyy`/`ddmmyyyy` |
| `use-of-unsafe-block` (Go) | 9 | FP por desenho | syscalls Windows (DPAPI, recuperação de serviço) exigem `unsafe.Pointer` |
| `string-formatted-query` (Go) | 8 | FP | só entram identificadores via `quoteIdent` (dobra `"`), `NULL` literal e `LIMIT %d` |
| `obfuscation-*` diversos (Apiiro) | 6 | FP | `vi.mock` em teste, fixtures, normalização de texto |
| `dangerous-os-exec-tainted-env-args` (py) | 3 | FP por desenho | wrappers de lab que dão `exec` no argv do chamador |
| `javascript-dynamic-execution-eval-Function` | 2 | FP | sensor local que avalia o `github-script` do próprio repo; `expect.any(Function)` |
| `os-error-is-not-exist` (Go) | 2 | FP | `err` vem direto do `os.ReadFile` (`*PathError` sem wrap) |
| `leaky-time-after` (Go) | 2 | FP | `go 1.26`: desde o 1.23 o runtime coleta timer não disparado |
| `len-cast-to-narrow-int-overflow` (Go) | 2 | FP prático | blob DPAPI e lista de ações do serviço: tamanhos minúsculos |
| `potential-symlink-takeover-with-os.executable` (Go) | 2 | FP prático | auto-update: plantar symlink no diretório do serviço exige admin. Integridade = sha256 do manifesto num bucket público read-only (escrita só `service_role`) |
| `unknown-value-with-script-tag` | 2 | FP | `ToolHistory.tsx` usa `outerHTML` do SVG do `qrcode.react` com textos via `escapeHtml`; o outro é teste que assevera AUSÊNCIA de `<script>` |
| `curl-unencrypted-url` (ToB) | 2 | FP | health-check em `http://localhost`; string de fixture |
| `run-shell-injection` | 1 | **REAL — P3** | ver A2 |

### Achados reais e brechas (por severidade)

- **A1 — P3, supply chain do CI.** 27 `uses:` por tag mutável: `actions/checkout@v5` ×9,
  `oven-sh/setup-bun@v2` ×8, `actions/github-script@v7` ×7 e `denoland/setup-deno@v2` ×3 (os 11 de
  terceiros são o subconjunto de maior risco). Gatilho: tag reescrita no upstream (o caso
  `tj-actions/changed-files`, 2025). Efeito: código arbitrário nos jobs, que têm `contents: read`
  (+ `issues: write` em alguns), nenhum segredo de repo, e o poder de falsear o `validate`. Por que
  não sobe: PR de fork recebe token read-only e o `auto-merge.yml` (o único com escrita) não usa
  action. Correção + gate: pin por SHA. A política de atualização é decisão do founder, porque
  Dependabot abre PR do próprio repo e esses PRs auto-mergeiam.
- **A2 — P3, `.github/workflows/ci.yml:794`. ✅ Corrigido em #2626.** `${{ github.base_ref || 'main' }}`
  interpolado no `run:`. O `base_ref` é o branch-ALVO e precisa existir no repo base, que só quem tem
  escrita cria, então fork não controla. Correção canônica: passar por `env:`. Foi o que o #2626 fez
  (`env: BASE_REF` + `"origin/${BASE_REF}"`). Prova: `p/github-actions` deu 1→0 `run-shell-injection`
  (11 regras, 4 alvos). O parser YAML achou 0 `${{ }}` em `run:`/`script:` nos 82 passos dos 4
  workflows, ou seja, o A2 era o único.
- **B1 — P3, curinga, `supabase/functions/analyze-unified-order/index.ts:39` — ✅ corrigido em #2633
  (classe).** O `sanitizeForPostgrestOr` espelhado na edge **não remove `*`**, que o #1051 acrescentou só em
  `src/lib/postgrest.ts`. Gatilho: termo `***` no texto do pedido. Efeito: `name.ilike.%***%` =
  match-all em `profiles` (≤20 por termo, com `service_role`), ou seja, cliente sugerido errado.
  Não é escalada: a edge é staff-only (`employee`/`master`), e staff já lista perfis pela busca global.
  O outro espelho do mesmo helper para edge (`sanitizeOrTerm` do tool MCP `search-customers`) está
  em dia, com `*` e gate de termo degenerado. A deriva é de UM espelho, e por isso a correção é de
  CLASSE: pôr o helper num bloco `// MIRROR-START` com asserção de paridade em
  `src/__tests__/edge-money-path-invariants.test.ts`.
  **O que a correção achou:** só a regex NÃO fechava o gatilho. `***` sanitiza para vazio, e
  `name.ilike.%%` casa tudo do mesmo jeito (`%%%` já casava antes do #1051). O termo degenerado agora
  é pulado pelo `isSearchablePostgrestTerm` espelhado, nos 3 call sites de termo vindo do texto:
  clientes, produtos e o `stripped`, que precisa de gate próprio porque `..**..**` passa no do termo
  e vira `****`. O tool MCP entrou no mesmo bloco. O gate DESCOBRE cópia nova fora de bloco em
  `src/` e nas edges; o bundle gerado da `mcp` perde os comentários no esbuild e é conferido pelo
  literal da regex. Falsificado por camada, com controle verde na mesma invocação e nos 2 locales,
  inclusive o replay do #1051 (a fonte avança e os espelhos ficam). O Codex achou 7 regressões que o
  gate v1 deixava verdes, todas fechadas antes do merge (as sabotagens estão no PR).
- **B2 — P3, curinga, `src/pages/AdminReposicaoVendaPerdida.tsx:58`.** O único `.ilike` cru de
  `src/`: `%${termo}%` sem `ilikeContainsPattern` (a classe do #1062). Com `**`, match-all limitado
  por RLS, `limit(10)` e `eq(account/ativo)`. O ESLint atual não olha `.ilike`/`.like`.
- **B3 — P4, curinga, `supabase/functions/promocao-extrair-via-vision/index.ts:210`.** "Match exato
  case-insensitive" via `.ilike` sem escapar `%`/`_` do nome que a IA extraiu do documento. No pior
  caso, fornecedor normalizado errado (ou `maybeSingle` erra e cai no match por substring). O fluxo
  é revisado por staff.
- Descartado com prova: `sayerlack-captura-precos:932` (`.ilike("empresa", body.empresa)`). O
  `.eq("empresa", empresa)` literal da linha 922 devolve 0 grupos para `%` e a função sai antes com
  `sem_grupos_ativos`, além do caller ser cron/staff.

## Comparação com a auditoria de 2026-05-25

| item de 25/05 | frente | estado em 2026-09-27 | evidência |
|---|---|---|---|
| P1: 4 RPCs `SECURITY DEFINER` financeiras sem gate (#288) | RLS estática (o semgrep não lê PL/pgSQL) | **fechado e mantido** | `psql-ro` em prod: 4/4 com gate + `COALESCE`, `anon` sem EXECUTE. `fin_estimar_estoque_omie` foi **re-gateada** depois por `private.cap_custo_ler` (E2/FU4). `fin_calcular_confiabilidade` nem dá EXECUTE a `authenticated` |
| P2: injeção de filtro `.or()` em 6 callsites | semgrep | **corrigido e endurecido**: #284 (6 sites), #293 (+3, guard ESLint, edge `analyze-unified-order`), #322 (período do DRE na `omie-financeiro`), #1051 (`*`) | nenhum ruleset atual tem regra para string de filtro PostgREST. A ausência no scan NÃO prova limpeza; quem prova é o inventário abaixo |
| follow-ups do #288 (matviews `fin_analise_cp/cr_dimensoes`, gate de rota `/financeiro`) | RLS | **não verificado aqui** (fora do escopo semgrep) | — |
| — (novo) conector Go `sayersync` | semgrep | 0 real em 17+4+4 achados | tabela de triagem |
| — (novo) workflows do CI | semgrep | A1, A2 (P3) | idem |

### `.or()` × regra ESLint `no-restricted-syntax`

Inventário completo (subagente, conferido por amostragem): **39 `.or()` reais**, 29 em `src/` e 10 em
edges. `src/`: 7 literais, 19 via helper de `@/lib/postgrest` e 3 montados antes (`D`). Os três `D`
são: `BAIXO_GIRO_OR_FILTER` (constante); `buildFamiliaExclusionOrFilter` (constante, que lança em
`,()"`); e o `predicado` do tool MCP `search-customers` (sanitizador inline). Edges: 5 via helper
inlineado (`analyze-unified-order`), 3 template com interpolação (inteiros/datas validados na
`omie-financeiro` e `fin-valor-cockpit`), 1 `D` (bundle MCP) e 1 concatenação (data ISO computada).
**0 injeção estrutural** (`,` `(` `)` chegando crus).

O seletor do ESLint pega só *template literal com interpolação como argumento DIRETO do `.or()` em
`src/`*, e hoje não há nenhum. Ficam fora dele os 3 `D` de `src/`, concatenação e **todas as edges**.
A limpeza de hoje nesses pontos depende de convenção, não de gate. A deriva do B1 mora exatamente
nessa cegueira (helper espelhado na edge, onde o lint não entra).

## Resíduo e próximos passos

- `docs/agent/skills.md` (linha da ToB): contorno do CWD, `partial` que subnotifica e `p/yaml` 404.
- Correções, cada uma no seu PR (chips abertos em 2026-09-27, quem clica é o founder):
  "Passar github.base_ref por env no ci.yml" (A2, ✅ #2626) · "Pôr o sanitizador .or() da
  analyze-unified-order em MIRROR" (B1, classe — ✅ #2633) · "Fechar .ilike cru com curinga
  (AdminReposicaoVendaPerdida)" (B2 + gate ESLint).
- 🧭 Decisões do founder: (a) pin das actions por SHA e a política de atualização (A1); (b) o bug do
  `--include` já estava reportado (#297 da ToB), falta decidir se comentamos com a medida em TS e o
  caminho do workflow; (c) semgrep no CI como 2º eixo de gate (custo de CI × a cegueira do ESLint
  nas edges). B3 (P4) fica como observação.
- Próxima varredura: mesmo plano, `cd "$(mktemp -d)"`, e a tabela de reconciliação SARIF ×
  `--validate` refeita. Sem ela, "0 achado" de um ruleset não prova nada.
- ⚠️ **Os artefatos crus desta varredura também se perderam**, a mesma perda da de maio. SARIF,
  JSON, `scans.json` e as provas viviam no scratchpad da sessão, que o reinício dela apagou (medido:
  o diretório voltou vazio). Sobram os números deste doc. Na próxima, copie o `results.sarif`
  mesclado e o `scans.json` para fora do scratchpad (ex.: `~/.local/share/afiacao/semgrep/<data>/`,
  fora do repo, porque o `p/secrets` pode citar trecho sensível) ANTES de fechar a sessão. Só assim
  dá para fazer o diff achado-a-achado.
