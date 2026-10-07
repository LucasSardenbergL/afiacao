# Preço exato no PO Sayerlack — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o PO Sayerlack sai do app com o unitário do portal sem IPI em `nValUnit` e o IPI do item em `nValorIpi`, e a
captura do preço do portal deixa de falhar por causa do IPI.

**Architecture:** a captura (funções puras em `captura-custo.ts`, espelhadas em `src/`) passa a modelar o IPI por NCM
em centavos inteiros e prova `Σ round2(Preço Venda) + Σ IPI = data.value`. A RPC `sayerlack_aplicar_custo_portal`
(mesma assinatura) recebe `{item_id, qtde_final, valor_mercadoria, valor_ipi}`, confere o IPI contra a tabela nova
`ipi_aliquota_ncm` pela função `sayerlack_ipi_itens` e grava a decomposição (escritor único) junto do custo com IPI. O
`disparar-pedidos-aprovados` monta cada item do PO por uma função pura que usa a decomposição quando ela existe.

**Tech Stack:** Supabase/Postgres 17 (plpgsql), Deno (edges), TypeScript strict, vitest, Bun.

**Spec:** [docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md](../specs/2026-10-05-preco-exato-po-sayerlack-design.md)

## Global Constraints

- Código, comentários, commits e PR em **pt-BR**; commit termina com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Ausente ≠ zero**: NCM sem alíquota, leitura que falha ou número inválido nunca vira 0 — vira recusa/`null`.
- IPI do item = `round(round(mercadoria, 2) × alíquota ÷ 100, 2)`, meio centavo para cima, em **centavos inteiros** no TS.
- Tolerância da prova: `tol(n) = 0,005 + 0,0101 · n` (n = nº de linhas).
- Alíquota com **no máximo 2 casas** e em `[0, 100)`.
- `preco_unitario`/`valor_linha` = **custo com IPI**; `valor_linha = round2(mercadoria) + IPI`.
- Escritor único das 4 colunas novas: a RPC.
- O bloco `>>> ESPELHO(captura-custo)` é **idêntico byte a byte** em `captura-custo.ts` e `src/lib/reposicao/sayerlack-scraping-pedido.ts` (edite no Deno, copie para `src/`).
- `test:edges` roda com `--no-remote` — **nunca afrouxe**.
- Nunca editar migration existente; a nova é `supabase/migrations/20261006120000_preco_exato_po_sayerlack_ipi.sql`.
- Bash tool = zsh: nada de `PIPESTATUS`; capture exit com `cmd > arq 2>&1; rc=$?`. Prefixe `heavy` em test/typecheck/build.
- **Commite antes de falsificar.** Falsificação só vale com controle verde na MESMA invocação.
- Não abrir `supabase/schema-snapshot.sql`.

## Review Focus

1. **A função de alíquota devolve menos linhas que os itens** (produto sumiu do cadastro) → o item é "sem alíquota"
   (`ipi_ncm_desconhecido` na edge, CP006 na RPC), nunca IPI 0. Testes: Task 2 (N5, pedido 450) e Task 3 (alíquota null).
2. **PostgREST devolve `numeric` como string** nas colunas novas → o disparo converte; lixo, negativo ou só uma das duas
   colunas → caminho de hoje (sem `nValorIpi`). Teste: Task 5.
3. **Item a 0% medido** → `nValorIpi: 0` explícito (zero medido, não fabricado) e o CHECK aceita IPI 0. Testes: Task 2
   (A3) e Task 5.
4. **Re-captura antes do PO** (reenvio ao portal) → a 2ª chamada regrava igual. Teste: Task 2 (A2).
5. **Pedido COLACOR com SKU que também existe na conta OBEN** com outro NCM → a alíquota é a da conta do pedido.
   Teste: Task 2 (A4 + sabotagens F11/F12).

---

## Mapa de arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `db/fixtures/sayerlack-ipi-backtest-20261005.json` | criar | arquivo-ouro: 29 pedidos reais com o IPI esperado por linha |
| `supabase/migrations/20261006120000_preco_exato_po_sayerlack_ipi.sql` | criar | tabela, colunas + CHECK, `sayerlack_ipi_itens`, RPC v3, ACL, postcondição |
| `db/test-sayerlack-ipi-po.sh` | criar | prova PG17 + paridade com o arquivo-ouro + falsificação |
| `db/nucleo-ci.txt` | modificar | entra a prova nova |
| `supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.ts` | modificar | bloco espelhado: modelo de IPI, prova, derivação, resumo |
| `src/lib/reposicao/sayerlack-scraping-pedido.ts` | modificar | cópia do bloco |
| `supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.test.ts` | reescrever | casos reais (#2459, #3091, #2745) e adversários |
| `src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts` | reescrever | espelho, call-sites, contrato, paridade com o ouro |
| `supabase/functions/enviar-pedido-portal-sayerlack/index.ts` | modificar | lê alíquotas, monta esperados, payload novo; sai `preco_atual` |
| `supabase/functions/enviar-pedido-portal-sayerlack/versao.ts` | modificar | `v1.10-ipi-por-ncm` |
| `supabase/functions/disparar-pedidos-aprovados/produto-po.ts` | criar | item do `IncluirPedCompra` (pura) |
| `supabase/functions/disparar-pedidos-aprovados/produto-po_test.ts` | criar | testes Deno da função pura |
| `supabase/functions/disparar-pedidos-aprovados/index.ts` | modificar | `select("*")` dos itens + `montarProdutoIncluir` |
| `supabase/functions/disparar-pedidos-aprovados/versao.ts` | modificar | `v1.5-ipi-por-item` |
| `scripts/authz-funcoes-fechadas.ts` | modificar | RPC aponta para a migration nova + `sayerlack_ipi_itens` |
| `scripts/audit-custom-migrations.sql`, `docs/migrations-audit.md` | regenerar | `bun run audit:migrations` |
| `docs/agent/reposicao.md`, `docs/historico/sayerlack-captura-custo-cega.md`, `docs/historico/versao-enviar-pedido-portal-sayerlack.md` | modificar | o "ABERTO" vira resolvido; manutenção da tabela; changelog |
| `docs/historico/preco-exato-po-sayerlack.md`, `docs/historico/README.md` | criar / modificar | diário da entrega + índice |

---

### Task 0: Sincronizar com a main

- [ ] **Step 1: trazer a main**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/nervous-dirac-0f8bc6
git fetch origin --quiet && git merge --no-edit origin/main > "$TMPDIR/merge.log" 2>&1; echo "rc=$?"; tail -c 300 "$TMPDIR/merge.log"
```
Expected: `rc=0` (só commits de docs nossos; sem conflito).

- [ ] **Step 2: conferir que ninguém tocou o domínio**

```bash
gh pr list --state open --json number,headRefName,files --jq '.[] | select([.files[].path] | any(test("enviar-pedido-portal-sayerlack|disparar-pedidos-aprovados|sayerlack_aplicar_custo_portal|pedido_compra_item"))) | .number' > "$TMPDIR/prs-dominio.txt" 2>&1; echo "rc=$?"; cat "$TMPDIR/prs-dominio.txt"
git grep -c "sayerlack_ipi_itens\|ipi_aliquota_ncm" origin/main -- supabase src db > /dev/null 2>&1; echo "rc-grep=$? (1 = ninguém entregou isto)"
```
Expected: `rc=0`, lista vazia; `rc-grep=1`.

---

### Task 1: Arquivo-ouro do backtest

**Files:**
- Create: `db/fixtures/sayerlack-ipi-backtest-20261005.json`

**Interfaces:**
- Produces (consumido pelas Tasks 2 e 3): JSON
  `{ fonte, modelo, aliquotas_pct: Record<ncm8, number>, pedidos: [{ pedido_id, total_json, total_modelado, delta,
  linhas: [{ sku_portal, sku_codigo_omie, ncm, qtde_final, qtd_un_raw, preco_un_raw, preco_venda_raw, preco_venda, ipi }] }] }`.
  `ncm` vem pontuado como em `omie_products`; `aliquotas_pct` usa a chave de 8 dígitos.

- [ ] **Step 1: gerar a partir do backtest de prod (scratchpad, `psql-ro` já exportado em `backtest.json`)**

O gerador é uma 3ª implementação, independente, da mesma conta: as Tasks 2 (SQL) e 3 (TS) têm de bater com ele.

```bash
S=/private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-nervous-dirac-0f8bc6/2f9d8a98-9232-4afb-be4b-85e135b05129/scratchpad/sql
cat > "$S/gerar-ouro.ts" <<'TS'
const peds: { id: number; total: number; linhas: { sku: string; omie: string; ncm: string; pv: string; qtd: string; pun: string; qf: number }[] }[] =
  JSON.parse(await Bun.file(`${import.meta.dir}/backtest.json`).text());
const aliquotas_pct: Record<string, number> = {
  '32081010': 3.25, '32081020': 3.25, '32082019': 3.25, '32082020': 3.25, '32089039': 6.5, '38140090': 6.5,
  '32129090': 6.5, '32141020': 1.3, '32149000': 0, '29153999': 0, '32041210': 0, '38089219': 0, '29221919': 0,
};
const brl = (s: string) => Number(s.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
const linhaC = (pv: number) => Math.floor((Math.round(pv * 10000) + 50) / 100);
const ipiC = (lc: number, a: number) => Math.floor((lc * Math.round(a * 100) + 5000) / 10000);
const pedidos = peds.map((p) => {
  let soma = 0;
  const linhas = p.linhas.map((l) => {
    const a = aliquotas_pct[l.ncm.replace(/\D/g, '')];
    if (a === undefined) throw new Error(`NCM sem alíquota: ${l.ncm}`);
    if (!Number.isInteger(Number(l.qf))) throw new Error(`qtde fracionária no pedido ${p.id}`);
    const pv = brl(l.pv); const lc = linhaC(pv); const ic = ipiC(lc, a); soma += lc + ic;
    return { sku_portal: l.sku, sku_codigo_omie: l.omie, ncm: l.ncm, qtde_final: Number(l.qf), qtd_un_raw: l.qtd,
      preco_un_raw: l.pun, preco_venda_raw: l.pv, preco_venda: pv, ipi: ic / 100 };
  });
  const deltaC = Math.abs(soma - Math.round(p.total * 100));
  if (deltaC / 100 > 0.005 + 0.0101 * linhas.length) throw new Error(`pedido ${p.id} fora da tolerância`);
  return { pedido_id: p.id, total_json: p.total, total_modelado: soma / 100, delta: deltaC / 100, linhas };
});
const out = {
  fonte: 'psql-ro 2026-10-05: pedido_compra_sugerido.portal_resposta (itens_capturados = DOM, portal_add_json.value = total cobrado) × pedido_compra_item.sku_portal_aprovado × omie_products.ncm (conta oben); pedidos Sayerlack com protocolo enviados desde 2026-09-06',
  modelo: 'linha = round2(Preço Venda); IPI = round2(linha × alíquota ÷ 100), meio centavo para cima; prova |Σ linha + Σ IPI − total| ≤ 0,005 + 0,0101·n',
  aliquotas_pct, pedidos,
};
const destino = process.argv[2];
await Bun.write(destino, JSON.stringify(out, null, 2) + '\n');
console.log(`pedidos=${pedidos.length} linhas=${pedidos.reduce((s, p) => s + p.linhas.length, 0)} pior_delta=${Math.max(...pedidos.map((p) => p.delta)).toFixed(2)}`);
TS
bun run "$S/gerar-ouro.ts" db/fixtures/sayerlack-ipi-backtest-20261005.json > "$TMPDIR/ouro.log" 2>&1; echo "rc=$?"; cat "$TMPDIR/ouro.log"
```
Expected: `rc=0` e `pedidos=29 linhas=<n> pior_delta=0.02`.

- [ ] **Step 2: sentinela do arquivo**

```bash
bun -e 'const o = JSON.parse(await Bun.file("db/fixtures/sayerlack-ipi-backtest-20261005.json").text()); const p = o.pedidos.find((x) => x.pedido_id === 3091); console.log(o.pedidos.length, Object.keys(o.aliquotas_pct).length, JSON.stringify(p.linhas.map((l) => [l.sku_portal, l.ipi])), p.total_modelado)'
```
Expected: `29 13 [["WJOI.7585GL",7.87],["FC.6902L5",27.75]] 704.74`.

- [ ] **Step 3: commit**

```bash
git add db/fixtures/sayerlack-ipi-backtest-20261005.json
git commit -m "test(fixture): arquivo-ouro do backtest de IPI — 29 pedidos Sayerlack reais com o IPI esperado por linha

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration + prova PG17

**Files:**
- Create: `db/test-sayerlack-ipi-po.sh`
- Create: `supabase/migrations/20261006120000_preco_exato_po_sayerlack_ipi.sql`
- Modify: `db/nucleo-ci.txt`

**Interfaces:**
- Consumes: o arquivo-ouro da Task 1.
- Produces (Tasks 4 e 5 dependem):
  - `public.sayerlack_ipi_itens(p_pedido_id bigint) RETURNS TABLE(item_id bigint, ncm text, aliquota_pct numeric)` (service_role).
  - `public.sayerlack_aplicar_custo_portal(p_pedido_id bigint, p_itens jsonb, p_valor_total numeric) RETURNS integer`,
    payload `[{item_id, qtde_final, valor_mercadoria, valor_ipi}]` (números JSON); SQLSTATE `CP001`–`CP004`, `CP006`, `CP007`.
  - Colunas `pedido_compra_item.{preco_unitario_sem_ipi_portal, valor_ipi_portal, aliquota_ipi_portal, ncm_ipi_portal}`.

- [ ] **Step 1: escrever a prova (falha primeiro: a migration ainda não existe)**

Criar `db/test-sayerlack-ipi-po.sh`:

```bash
#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261006120000_preco_exato_po_sayerlack_ipi.sql                      ║
# ║  ipi_aliquota_ncm (CHECKs + as 13 medidas), a decomposição em pedido_compra_item   ║
# ║  (CHECK as-4-ou-nenhuma), sayerlack_ipi_itens (NCM do cadastro × tabela, conta da  ║
# ║  empresa) e a RPC sayerlack_aplicar_custo_portal v3: payload = pedido inteiro      ║
# ║  {item_id, qtde_final, valor_mercadoria, valor_ipi}, IPI EXATO em centavos, prova  ║
# ║  contra o total cobrado, custo com IPI + decomposição, CP001–CP004/CP006/CP007,    ║
# ║  paridade com os 29 pedidos reais do arquivo-ouro, falsificação por camada.        ║
# ║      bash db/test-sayerlack-ipi-po.sh > /tmp/t.log 2>&1; echo $?                   ║
# ║  (NAO pipe pra tail — engole o exit!=0.) 2º locale (lição #1483):                 ║
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-sayerlack-ipi-po.sh                       ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5474}"
SLUG="sayerlack-ipi-po"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# PGBIN por plataforma (macOS Homebrew / Linux PGDG), major conferida. Fail-closed: PG ausente é ERRO.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

MIG_BASE1="$REPO_ROOT/supabase/migrations/20260905090000_sayerlack_custo_portal_cas.sql"
MIG_BASE2="$REPO_ROOT/supabase/migrations/20260906193522_valor_total_portal_provado.sql"
MIG="$REPO_ROOT/supabase/migrations/20261006120000_preco_exato_po_sayerlack_ipi.sql"
OURO="$REPO_ROOT/db/fixtures/sayerlack-ipi-backtest-20261005.json"
for f in "$MIG_BASE1" "$MIG_BASE2" "$MIG" "$OURO"; do [ -f "$f" ] || { echo "INFRA: ausente: $f"; exit 1; }; done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
# 2º locale (lição #1483): o idioma das mensagens do SERVIDOR; o L0 prova que ele valeu de fato.
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" >/dev/null \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponível neste servidor"; exit 1; }
# -X: sem ~/.psqlrc; só ERROR chega ao cliente (NOTICE é o canal por onde se forja uma linha "ERROR:").
P()  { PGOPTIONS='-c client_min_messages=error' "$PGBIN/psql" -X -v VERBOSITY=default -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# Severidade em C (ERROR) ou pt_BR (ERRO): o 2º locale traduz só o prefixo; a mensagem é nossa e não muda.
linhas_error() { grep -E '^(psql:[^ ]*: )?(ERROR|ERRO|FATAL|PANIC):  |^psql: error: |server closed the connection|connection to server was lost' "$1" | sed -E 's/^psql:[^ ]*: //' | awk 'NR > 1 { printf " ;; " } { printf "%s", $0 }' || true; }

echo "═══ setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ═══"
eq "L0 lc_messages do servidor é o pedido (prova que o 2º locale rodou de fato)" "$(Pq -c "SHOW lc_messages")" "$HARNESS_LC"

# ZONA 1 — pré-requisitos (colunas de prod que a migration lê/altera)
P -q <<'SQL'
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (
  id bigint PRIMARY KEY,
  empresa text NOT NULL DEFAULT 'OBEN',
  omie_pedido_compra_numero text,
  status_envio_portal text NOT NULL DEFAULT 'nao_aplicavel',
  portal_protocolo text,
  valor_total numeric DEFAULT 0
);
CREATE TABLE IF NOT EXISTS public.pedido_compra_item (
  id bigint PRIMARY KEY,
  pedido_id bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text NOT NULL,
  qtde_final numeric,
  preco_unitario numeric,
  valor_linha numeric
);
CREATE TABLE IF NOT EXISTS public.omie_products (
  omie_codigo_produto bigint NOT NULL,
  account text NOT NULL,
  ncm text,
  UNIQUE (omie_codigo_produto, account)
);
-- Em prod o service_role (admin do Supabase) lê estas tabelas; a função de alíquota é SECURITY INVOKER.
GRANT SELECT ON public.pedido_compra_sugerido, public.pedido_compra_item, public.omie_products TO service_role;
SQL

# ZONA 2 — o caminho REAL do SQL Editor: as duas versões anteriores da RPC e, por cima, a migration sob prova.
P -q -f "$MIG_BASE1"
P -q -f "$MIG_BASE2"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_BASE1") + $(basename "$MIG_BASE2") + $(basename "$MIG")"

# ZONA 3 — seed (re-semeável). Números do #3091 (portal 2133415) no pedido 100.
seed() {
P -q <<'SQL'
TRUNCATE public.pedido_compra_item, public.pedido_compra_sugerido, public.omie_products;
INSERT INTO public.pedido_compra_sugerido (id, empresa, omie_pedido_compra_numero, status_envio_portal, portal_protocolo, valor_total) VALUES
  (100, 'OBEN',    NULL,   'sucesso_portal',  'PROTO-100', 0),
  (200, 'OBEN',    '7788', 'sucesso_portal',  'PROTO-200', 0),
  (300, 'OBEN',    NULL,   'enviando_portal', NULL,        0),
  (400, 'OBEN',    NULL,   'sucesso_portal',  'PROTO-400', 0),
  (450, 'OBEN',    NULL,   'sucesso_portal',  'PROTO-450', 0),
  (500, 'OBEN',    NULL,   'sucesso_portal',  'PROTO-500', 0),
  (600, 'OBEN',    NULL,   'sucesso_portal',  'PROTO-600', 0),
  (700, 'COLACOR', NULL,   'sucesso_portal',  'PROTO-700', 0);
INSERT INTO public.pedido_compra_item (id, pedido_id, sku_codigo_omie, qtde_final, preco_unitario, valor_linha) VALUES
  (101, 100, '8689962883', 2,   233.55, 467.10),  -- FC.6902L5, 3208.90.39 (6,5%)
  (102, 100, '8689743214', 1,   275.01, 275.01),  -- WJOI.7585GL, 3208.20.20 (3,25%)
  (201, 200, '8689962883', 1,   10, 10),
  (301, 300, '8689962883', 1,   10, 10),
  (401, 400, '9000000001', 1,   10, 10),          -- NCM 3204.19.20: fora da tabela
  (451, 450, '9000000002', 1,   10, 10),          -- sem produto no cadastro: NCM NULL
  (501, 500, '8689962883', 2.5, 10, 25),          -- quantidade FRACIONÁRIA
  (601, 600, '8690108598', 1,   20, 20),          -- YC.1401VP, 2922.19.19 (0% medido, #2662)
  (701, 700, '9000000003', 1,   10, 10);          -- NCM depende da CONTA: oben 3,25% × colacor 0%
INSERT INTO public.omie_products (omie_codigo_produto, account, ncm) VALUES
  (8689962883, 'oben',    '3208.90.39'),
  (8689962883, 'colacor', '9999.99.99'),          -- conta errada não pode vazar para pedido OBEN
  (8689743214, 'oben',    '3208.20.20'),
  (9000000001, 'oben',    '3204.19.20'),
  (8690108598, 'oben',    '2922.19.19'),
  (9000000003, 'oben',    '3208.10.10'),
  (9000000003, 'colacor', '3214.90.00');
SQL
}
seed
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES ('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('22222222-2222-2222-2222-222222222222', 'customer');
-- Sentinelas MINHAS (nunca texto que o código emite), com a SQLSTATE exata; o veredito é o stdout INTEIRO.
CREATE OR REPLACE FUNCTION public.tentar_rpc(p_pedido bigint, p_itens jsonb, p_total numeric)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $f$
DECLARE n int;
BEGIN
  n := public.sayerlack_aplicar_custo_portal(p_pedido, p_itens, p_total);
  RETURN 'RPC_OK_' || n;
EXCEPTION WHEN OTHERS THEN
  RETURN 'RPC_ERR_' || SQLSTATE;
END $f$;
GRANT EXECUTE ON FUNCTION public.tentar_rpc(bigint, jsonb, numeric) TO PUBLIC;
CREATE OR REPLACE FUNCTION public.tentar_sql(p_cmd text)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $f$
BEGIN
  EXECUTE p_cmd;
  RETURN 'SQL_OK';
EXCEPTION WHEN OTHERS THEN
  RETURN 'SQL_ERR_' || SQLSTATE;
END $f$;
GRANT EXECUTE ON FUNCTION public.tentar_sql(text) TO PUBLIC;
SQL
rpc() { # $1 = argumentos da chamada · $2 = preâmbulo opcional (SET ROLE / GUC)
  local out rc=0
  out="$(printf '%s\nSELECT public.tentar_rpc(%s);\n' "${2:-}" "$1" | P -q -tA 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then printf '%s' "$out"; else printf 'RPC_SEM_MEDICAO_rc%s' "$rc"; fi
}
sql() { # $1 = comando (sem aspas simples externas) · $2 = preâmbulo opcional
  local out rc=0
  out="$(printf '%s\nSELECT public.tentar_sql($c$%s$c$);\n' "${2:-}" "$1" | P -q -tA 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then printf '%s' "$out"; else printf 'SQL_SEM_MEDICAO_rc%s' "$rc"; fi
}
# "id:preco_unitario/valor_linha/sem_ipi/ipi/aliquota/ncm,...|valor_total" — ø = NULL.
estado() { Pq -c "SELECT string_agg(i.id||':'||coalesce(trim_scale(round(i.preco_unitario,4))::text,'ø')||'/'||coalesce(trim_scale(round(i.valor_linha,4))::text,'ø')||'/'||coalesce(trim_scale(round(i.preco_unitario_sem_ipi_portal,4))::text,'ø')||'/'||coalesce(trim_scale(i.valor_ipi_portal)::text,'ø')||'/'||coalesce(trim_scale(i.aliquota_ipi_portal)::text,'ø')||'/'||coalesce(i.ncm_ipi_portal,'ø'), ',' ORDER BY i.id)||'|'||trim_scale(p.valor_total) FROM public.pedido_compra_sugerido p JOIN public.pedido_compra_item i ON i.pedido_id=p.id WHERE p.id=$1 GROUP BY p.valor_total;"; }
provado() { Pq -c "SELECT coalesce(trim_scale(valor_total_portal_provado)::text,'ø')||'|'||coalesce(valor_total_portal_provado_protocolo,'ø')||'|'||CASE WHEN valor_total_portal_provado_em IS NULL THEN 'sem-ts' ELSE 'com-ts' END FROM public.pedido_compra_sugerido WHERE id=$1"; }
aliq() { Pq -c "SELECT coalesce(string_agg(item_id||'|'||coalesce(ncm,'ø')||'|'||coalesce(trim_scale(aliquota_pct)::text,'ø'), ',' ORDER BY item_id), '') FROM public.sayerlack_ipi_itens($1)"; }
SEM_PROVA='ø|ø|sem-ts'
ITENS_100='[{"item_id":101,"qtde_final":2,"valor_mercadoria":426.8652,"valor_ipi":27.75},{"item_id":102,"qtde_final":1,"valor_mercadoria":242.247,"valor_ipi":7.87}]'
INTACTO_100='101:233.55/467.1/ø/ø/ø/ø,102:275.01/275.01/ø/ø/ø/ø|0'
GRAVADO_100='101:227.31/454.62/213.435/27.75/6.5/32089039,102:250.12/250.12/242.25/7.87/3.25/32082020|704.74'

echo "── asserts ──"
# T1 — as 13 alíquotas medidas, 4 confirmadas por NF.
eq "T1 seed: 13 linhas, 4 de NF, valores do backtest" "$(Pq -c "SELECT count(*)||'|'||count(*) FILTER (WHERE fonte='nf')||'|'||string_agg(ncm||'='||trim_scale(aliquota_pct), ',' ORDER BY ncm) FROM public.ipi_aliquota_ncm")" "13|4|29153999=0,29221919=0,32041210=0,32081010=3.25,32081020=3.25,32082019=3.25,32082020=3.25,32089039=6.5,32129090=6.5,32141020=1.3,32149000=0,38089219=0,38140090=6.5"

# T2 — CHECKs da tabela (SQLSTATE 23514), com controle positivo (CHECK que recusa tudo seria teatro).
for caso in \
  "ncm_pontuado|'3208.10.10', 3.25, 'nf', 'x'" \
  "ncm_7_digitos|'3208101', 3.25, 'nf', 'x'" \
  "aliquota_nan|'11111111', 'NaN', 'nf', 'x'" \
  "aliquota_inf|'11111112', 'Infinity', 'nf', 'x'" \
  "aliquota_negativa|'11111113', -1, 'nf', 'x'" \
  "aliquota_100|'11111114', 100, 'nf', 'x'" \
  "aliquota_3_casas|'11111115', 3.255, 'nf', 'x'" \
  "fonte_invalida|'11111116', 1, 'chute', 'x'" \
  "evidencia_branca|'11111117', 1, 'nf', '   '"; do
  nome="${caso%%|*}"; vals="${caso#*|}"
  eq "T2 tabela recusa $nome" "$(sql "INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES ($vals, '2026-10-05')")" "SQL_ERR_23514"
done
eq "T2 controle: alíquota válida de 2 casas entra" "$(sql "INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES ('11111118', 9.75, 'nf', 'NF teste', '2026-10-05')")" "SQL_OK"
P -q -c "DELETE FROM public.ipi_aliquota_ncm WHERE ncm = '11111118'"

# T3 — CHECK da decomposição no item (as 4 ou nenhuma; faixa de cada uma), com controle positivo.
seed
for caso in \
  "so_o_ipi|valor_ipi_portal = 1" \
  "ipi_negativo|preco_unitario_sem_ipi_portal = 1, valor_ipi_portal = -0.01, aliquota_ipi_portal = 3.25, ncm_ipi_portal = '32082020'" \
  "sem_ipi_zero|preco_unitario_sem_ipi_portal = 0, valor_ipi_portal = 1, aliquota_ipi_portal = 3.25, ncm_ipi_portal = '32082020'" \
  "ipi_nan|preco_unitario_sem_ipi_portal = 1, valor_ipi_portal = 'NaN', aliquota_ipi_portal = 3.25, ncm_ipi_portal = '32082020'" \
  "ncm_pontuado|preco_unitario_sem_ipi_portal = 1, valor_ipi_portal = 1, aliquota_ipi_portal = 3.25, ncm_ipi_portal = '3208.20.20'" \
  "aliquota_100|preco_unitario_sem_ipi_portal = 1, valor_ipi_portal = 1, aliquota_ipi_portal = 100, ncm_ipi_portal = '32082020'"; do
  nome="${caso%%|*}"; set_="${caso#*|}"
  eq "T3 item recusa $nome" "$(sql "UPDATE public.pedido_compra_item SET $set_ WHERE id = 101")" "SQL_ERR_23514"
done
eq "T3 controle: IPI 0 medido (as 4 preenchidas) entra" "$(sql "UPDATE public.pedido_compra_item SET preco_unitario_sem_ipi_portal = 1, valor_ipi_portal = 0, aliquota_ipi_portal = 0, ncm_ipi_portal = '32149000' WHERE id = 101")" "SQL_OK"

# L1 — sayerlack_ipi_itens: NCM só dígitos, conta da empresa, NULL quando não sabe.
seed
eq "L1 pedido 100: NCM normalizado e alíquota da tabela" "$(aliq 100)" "101|32089039|6.5,102|32082020|3.25"
eq "L1 NCM fora da tabela ⇒ alíquota NULL" "$(aliq 400)" "401|32041920|ø"
eq "L1 produto fora do cadastro ⇒ NCM e alíquota NULL" "$(aliq 450)" "451|ø|ø"
eq "L1 pedido COLACOR lê o NCM da conta colacor" "$(aliq 700)" "701|32149000|0"
eq "L1 pedido inexistente ⇒ nenhuma linha" "$(aliq 999)" ""

# A1 — caminho feliz (#3091): 426,87 × 6,5% = 27,75 e 242,25 × 3,25% = 7,87; Σ = 704,74 = cobrado.
seed
eq "A1 grava os 2 itens" "$(rpc "100, '$ITENS_100'::jsonb, 704.74")" "RPC_OK_2"
eq "A1 custo com IPI + decomposição + valor_total = Σ valor_linha" "$(estado 100)" "$GRAVADO_100"
eq "A1 provado em coluna dedicada" "$(provado 100)" "704.74|PROTO-100|com-ts"
# A2 — re-captura antes do PO (reenvio): aceita e regrava igual.
eq "A2 re-chamada com omie ainda NULL é aceita" "$(rpc "100, '$ITENS_100'::jsonb, 704.74")" "RPC_OK_2"
eq "A2 estado idêntico" "$(estado 100)" "$GRAVADO_100"
# A3 — 0% medido (#2662): IPI 0 explícito, não ausente.
seed
eq "A3 item a 0% grava" "$(rpc "600, '[{\"item_id\":601,\"qtde_final\":1,\"valor_mercadoria\":13.7103,\"valor_ipi\":0}]'::jsonb, 13.71")" "RPC_OK_1"
eq "A3 IPI 0 medido gravado com a alíquota 0 e o NCM" "$(estado 600)" "601:13.71/13.71/13.71/0/0/29221919|13.71"
# A4 — a alíquota é a da conta do PEDIDO: COLACOR ⇒ 0% (a OBEN seria 3,25%).
seed
eq "A4 COLACOR aceita IPI 0" "$(rpc "700, '[{\"item_id\":701,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":0}]'::jsonb, 100")" "RPC_OK_1"
seed
eq "A4 COLACOR recusa o IPI da conta OBEN (3,25)" "$(rpc "700, '[{\"item_id\":701,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":3.25}]'::jsonb, 103.25")" "RPC_ERR_CP007"
# A5 — tolerância de 2 linhas = 0,0252: 2 centavos passam, 3 não.
seed
eq "A5 cobrado 704,76 (delta 0,02) passa" "$(rpc "100, '$ITENS_100'::jsonb, 704.76")" "RPC_OK_2"
seed
eq "A5 cobrado 704,77 (delta 0,03) reprova" "$(rpc "100, '$ITENS_100'::jsonb, 704.77")" "RPC_ERR_CP007"
eq "A5 nada gravado no reprovado" "$(estado 100)" "$INTACTO_100"
eq "A5 nem o provado" "$(provado 100)" "$SEM_PROVA"

# N1 CP002 — PO Omie já existe (payload VÁLIDO: só o CAS o barra).
seed
eq "N1 PO Omie existente → CP002" "$(rpc "200, '[{\"item_id\":201,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":6.5}]'::jsonb, 106.5")" "RPC_ERR_CP002"
# N2 CP003 — status ≠ sucesso_portal e pedido inexistente.
eq "N2 enviando_portal → CP003" "$(rpc "300, '[{\"item_id\":301,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":6.5}]'::jsonb, 106.5")" "RPC_ERR_CP003"
eq "N2 pedido inexistente → CP003" "$(rpc "999, '[{\"item_id\":1,\"qtde_final\":1,\"valor_mercadoria\":1,\"valor_ipi\":0}]'::jsonb, 1")" "RPC_ERR_CP003"
# N3 CP001 — payload. O "ipi_ausente" é o verde-por-ausência: jsonb_typeof(NULL) <> 'number' daria NULL.
I102='{"item_id":102,"qtde_final":1,"valor_mercadoria":242.247,"valor_ipi":7.87}'
for caso in \
  "vazio|100, '[]'::jsonb, 704.74" \
  "payload_antigo|100, '[{\"item_id\":101,\"preco_unitario\":227.31,\"valor_linha\":454.62},{\"item_id\":102,\"preco_unitario\":250.12,\"valor_linha\":250.12}]'::jsonb, 704.74" \
  "qtde_texto|100, '[{\"item_id\":101,\"qtde_final\":\"2\",\"valor_mercadoria\":426.8652,\"valor_ipi\":27.75},$I102]'::jsonb, 704.74" \
  "mercadoria_nan_texto|100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":\"NaN\",\"valor_ipi\":27.75},$I102]'::jsonb, 704.74" \
  "mercadoria_zero|100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":0,\"valor_ipi\":27.75},$I102]'::jsonb, 704.74" \
  "ipi_negativo|100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":426.8652,\"valor_ipi\":-0.01},$I102]'::jsonb, 704.74" \
  "ipi_ausente|100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":426.8652},$I102]'::jsonb, 704.74" \
  "nao_array|100, '{\"item_id\":101}'::jsonb, 704.74" \
  "total_nan|100, '$ITENS_100'::jsonb, 'NaN'::numeric" \
  "total_inf|100, '$ITENS_100'::jsonb, 'Infinity'::numeric" \
  "total_zero|100, '$ITENS_100'::jsonb, 0" \
  "id_texto|100, '[{\"item_id\":\"abc\",\"qtde_final\":2,\"valor_mercadoria\":426.8652,\"valor_ipi\":27.75},$I102]'::jsonb, 704.74"; do
  nome="${caso%%|*}"; args="${caso#*|}"
  eq "N3 payload $nome → CP001" "$(rpc "$args")" "RPC_ERR_CP001"
done
eq "N3 nada gravado em nenhum caso" "$(estado 100)" "$INTACTO_100"
# N4 CP004 — o pedido inteiro, nada alheio, quantidade ecoada e inteira.
I101='{"item_id":101,"qtde_final":2,"valor_mercadoria":426.8652,"valor_ipi":27.75}'
for caso in \
  "id_repetido|100, '[$I101,$I101]'::jsonb, 908.98" \
  "item_faltando|100, '[$I101]'::jsonb, 454.62" \
  "item_de_outro_pedido|100, '[$I101,{\"item_id\":401,\"qtde_final\":1,\"valor_mercadoria\":10,\"valor_ipi\":0}]'::jsonb, 464.62" \
  "id_inexistente|100, '[$I101,{\"item_id\":9999,\"qtde_final\":1,\"valor_mercadoria\":10,\"valor_ipi\":0}]'::jsonb, 464.62" \
  "qtde_ecoada_divergente|100, '[{\"item_id\":101,\"qtde_final\":3,\"valor_mercadoria\":426.8652,\"valor_ipi\":27.75},$I102]'::jsonb, 704.74"; do
  nome="${caso%%|*}"; args="${caso#*|}"
  eq "N4 $nome → CP004" "$(rpc "$args")" "RPC_ERR_CP004"
done
eq "N4 nada gravado" "$(estado 100)" "$INTACTO_100"
eq "N4 qtde_final fracionária na linha → CP004" "$(rpc "500, '[{\"item_id\":501,\"qtde_final\":2.5,\"valor_mercadoria\":100,\"valor_ipi\":6.5}]'::jsonb, 106.5")" "RPC_ERR_CP004"
eq "N4 fracionária: nada gravado" "$(estado 500)" "501:10/25/ø/ø/ø/ø|0"
# N5 CP006 — sem alíquota: NCM fora da tabela e produto fora do cadastro. Nada gravado, nem o provado.
eq "N5 NCM fora da tabela → CP006" "$(rpc "400, '[{\"item_id\":401,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":0}]'::jsonb, 100")" "RPC_ERR_CP006"
eq "N5 produto sem cadastro → CP006" "$(rpc "450, '[{\"item_id\":451,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":0}]'::jsonb, 100")" "RPC_ERR_CP006"
eq "N5 ROLLBACK do provado" "$(provado 400)" "$SEM_PROVA"
# N6 CP007 — IPI 1 centavo a menos (o total ainda fecharia: só a igualdade EXATA pega).
eq "N6 IPI 27,74 ≠ 27,75 → CP007" "$(rpc "100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":426.8652,\"valor_ipi\":27.74},$I102]'::jsonb, 704.73")" "RPC_ERR_CP007"
eq "N6 nada gravado" "$(estado 100)" "$INTACTO_100"

# P — privilégio da RPC e da função de alíquota.
eq "P1 authenticated sem EXECUTE na RPC → 42501" "$(rpc "100, '$ITENS_100'::jsonb, 704.74" "SET ROLE authenticated;")" "RPC_ERR_42501"
eq "P2 anon sem EXECUTE na RPC → 42501" "$(rpc "100, '$ITENS_100'::jsonb, 704.74" "SET ROLE anon;")" "RPC_ERR_42501"
eq "P3 service_role executa a RPC" "$(rpc "100, '$ITENS_100'::jsonb, 704.74" "SET ROLE service_role;")" "RPC_OK_2"
seed
eq "P4 uid customer → 42501 (gate no corpo)" "$(rpc "100, '$ITENS_100'::jsonb, 704.74" "SET test.uid='22222222-2222-2222-2222-222222222222';")" "RPC_ERR_42501"
eq "P5 authenticated sem EXECUTE em sayerlack_ipi_itens" "$(sql "SELECT * FROM public.sayerlack_ipi_itens(100)" "SET ROLE authenticated;")" "SQL_ERR_42501"
eq "P5 anon sem EXECUTE em sayerlack_ipi_itens" "$(sql "SELECT * FROM public.sayerlack_ipi_itens(100)" "SET ROLE anon;")" "SQL_ERR_42501"
eq "P5 service_role lê as alíquotas" "$(sql "SELECT * FROM public.sayerlack_ipi_itens(100)" "SET ROLE service_role;")" "SQL_OK"

# C1 — corrida com o PO Omie (o CAS re-avalia o predicado depois do commit concorrente).
seed
P -q -c "BEGIN; UPDATE public.pedido_compra_sugerido SET omie_pedido_compra_numero='PO-CORRIDA' WHERE id=100; SELECT pg_sleep(1.5); COMMIT;" &
A_PID=$!
sleep 0.4
R=$(rpc "100, '$ITENS_100'::jsonb, 704.74"); wait "$A_PID"
eq "C1 corrida com o PO Omie → CP002" "$R" "RPC_ERR_CP002"

# G1 — paridade com o arquivo-ouro: os 29 pedidos reais gravam e o IPI do SQL = o do gerador (e o do TS, Task 3).
seed
P -q -v ouro="$(cat "$OURO")" <<'SQL'
CREATE TABLE IF NOT EXISTS public.prova_ouro_doc (doc jsonb);
TRUNCATE public.prova_ouro_doc;
INSERT INTO public.prova_ouro_doc VALUES (:'ouro'::jsonb);
CREATE OR REPLACE FUNCTION public.prova_ouro() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  d jsonb := (SELECT doc FROM public.prova_ouro_doc);
  ped jsonb; lin jsonb; v_payload jsonb; v_res text; v_item bigint; v_seq int;
  v_n int := 0; v_ok int := 0; v_ipi_div int := 0; v_vt_div int := 0; v_erros text := '';
BEGIN
  FOR ped IN SELECT * FROM jsonb_array_elements(d->'pedidos') LOOP
    v_n := v_n + 1; v_payload := '[]'::jsonb; v_seq := 0;
    INSERT INTO public.pedido_compra_sugerido (id, empresa, status_envio_portal, portal_protocolo, valor_total)
      VALUES ((ped->>'pedido_id')::bigint, 'OBEN', 'sucesso_portal', 'OURO-' || (ped->>'pedido_id'), 0);
    FOR lin IN SELECT * FROM jsonb_array_elements(ped->'linhas') LOOP
      v_seq := v_seq + 1;
      v_item := (ped->>'pedido_id')::bigint * 100 + v_seq;
      INSERT INTO public.pedido_compra_item (id, pedido_id, sku_codigo_omie, qtde_final, preco_unitario, valor_linha)
        VALUES (v_item, (ped->>'pedido_id')::bigint, lin->>'sku_codigo_omie', (lin->>'qtde_final')::numeric, 1, 1);
      INSERT INTO public.omie_products (omie_codigo_produto, account, ncm)
        VALUES ((lin->>'sku_codigo_omie')::bigint, 'oben', lin->>'ncm') ON CONFLICT DO NOTHING;
      v_payload := v_payload || jsonb_build_array(jsonb_build_object('item_id', v_item, 'qtde_final', lin->'qtde_final',
        'valor_mercadoria', lin->'preco_venda', 'valor_ipi', lin->'ipi'));
    END LOOP;
    v_res := public.tentar_rpc((ped->>'pedido_id')::bigint, v_payload, (ped->>'total_json')::numeric);
    IF v_res = 'RPC_OK_' || jsonb_array_length(ped->'linhas') THEN v_ok := v_ok + 1;
    ELSE v_erros := v_erros || (ped->>'pedido_id') || ':' || v_res || ' '; END IF;
    v_ipi_div := v_ipi_div + (SELECT count(*) FROM jsonb_array_elements(ped->'linhas') WITH ORDINALITY AS l(lin, ord)
      JOIN public.pedido_compra_item i ON i.id = (ped->>'pedido_id')::bigint * 100 + l.ord
     WHERE i.valor_ipi_portal IS DISTINCT FROM (l.lin->>'ipi')::numeric);
    v_vt_div := v_vt_div + (SELECT count(*) FROM public.pedido_compra_sugerido p
     WHERE p.id = (ped->>'pedido_id')::bigint AND p.valor_total IS DISTINCT FROM (ped->>'total_modelado')::numeric);
  END LOOP;
  RETURN format('pedidos=%s ok=%s ipi_divergente=%s vt_divergente=%s erros=[%s]', v_n, v_ok, v_ipi_div, v_vt_div, trim(v_erros));
END $f$;
SQL
eq "G1 os 29 pedidos reais: todos gravam, IPI e valor_total batem com o ouro" "$(Pq -c "SELECT public.prova_ouro()")" "pedidos=29 ok=29 ipi_divergente=0 vt_divergente=0 erros=[]"

# ZONA 5 — FALSIFICAÇÃO: uma camada por vez, o vermelho CERTO, restaura com a migration REAL.
echo "── falsificação ──"
SAB="$(dirname "$DATA")/sab.sql"
sabota() {
  sed -e "$1" "$MIG" > "$SAB"
  if cmp -s "$MIG" "$SAB"; then echo "  ❌ sabotagem NÃO casou o padrão ($1) — falsificação seria teatro"; FAIL=$((FAIL+1)); return 1; fi
  P -q -f "$SAB"
}
# seed ANTES de reaplicar: uma sabotagem de CHECK (F10) deixa linha que o CHECK real recusaria no ADD CONSTRAINT.
restaura() { seed; P -q -f "$MIG"; seed; }
dente() { if [ "$2" = "$3" ]; then ok "$1 (sabotado ⇒ $2)"; else bad "$1 — sabotado devia dar [$3], veio [$2]"; fi; }

seed; sabota 's/AND p\.omie_pedido_compra_numero IS NULL/AND true/'
dente "F1 sem o CAS de omie, grava com PO existente (N1)" "$(rpc "200, '[{\"item_id\":201,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":6.5}]'::jsonb, 106.5")" "RPC_OK_1"
restaura
sabota 's/IF v_sem_aliquota IS NOT NULL THEN/IF false THEN/'
dente "F2 sem o CP006, a camada de baixo (prova) recusa como CP007 (N5)" "$(rpc "400, '[{\"item_id\":401,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":0}]'::jsonb, 100")" "RPC_ERR_CP007"
restaura
sabota 's/count(\*) FILTER (WHERE c\.ipi_payload IS DISTINCT FROM c\.ipi)/0::bigint/'
dente "F3 sem a igualdade exata do IPI, 27,74 passa (N6)" "$(rpc "100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":426.8652,\"valor_ipi\":27.74},$I102]'::jsonb, 704.73")" "RPC_OK_2"
restaura
sabota 's/abs(v_total_modelado - p_valor_total) > v_tolerancia/false/'
dente "F4 sem a tolerância, 3 centavos passam (A5)" "$(rpc "100, '$ITENS_100'::jsonb, 704.77")" "RPC_OK_2"
restaura
sabota 's/IF v_n <> v_itens_total OR v_pertencem <> v_n THEN/IF false THEN/'
dente "F5 sem a cobertura, metade do pedido grava (N4 item_faltando)" "$(rpc "100, '[$I101]'::jsonb, 454.62")" "RPC_OK_1"
restaura
sabota 's/ AND i\.qtde_final = c\.qtde_eco AND i\.qtde_final = trunc(i\.qtde_final)//'
dente "F6 sem a conferência de quantidade, a fracionária grava (N4)" "$(rpc "500, '[{\"item_id\":501,\"qtde_final\":2.5,\"valor_mercadoria\":100,\"valor_ipi\":6.5}]'::jsonb, 106.5")" "RPC_OK_1"
restaura
sabota 's/REVOKE EXECUTE ON FUNCTION public\.sayerlack_ipi_itens(bigint) FROM anon, authenticated;/GRANT EXECUTE ON FUNCTION public.sayerlack_ipi_itens(bigint) TO authenticated;/; /POST FALHOU: anon\/authenticated executam sayerlack_ipi_itens/s/RAISE EXCEPTION/RAISE NOTICE/'
dente "F7 com GRANT a authenticated, a função de alíquota abre (P5)" "$(sql "SELECT * FROM public.sayerlack_ipi_itens(100)" "SET ROLE authenticated;")" "SQL_OK"
restaura
# F7b — a postcondição aborta o apply sabotado, e o aborto é DELA (a linha ERROR exata).
sed -e 's/REVOKE EXECUTE ON FUNCTION public\.sayerlack_ipi_itens(bigint) FROM anon, authenticated;/GRANT EXECUTE ON FUNCTION public.sayerlack_ipi_itens(bigint) TO authenticated;/' "$MIG" > "$SAB"
if cmp -s "$MIG" "$SAB"; then
  bad "F7b sabotagem NÃO casou o REVOKE — falsificação seria teatro"
elif P -q -f "$SAB" >/dev/null 2>"$SAB.err"; then
  bad "F7b postcondição NÃO abortou com authenticated executando sayerlack_ipi_itens"
else
  F7B="$(linhas_error "$SAB.err")"
  case "$F7B" in
    "ERROR:  POST FALHOU: anon/authenticated executam sayerlack_ipi_itens — REVOKE por nome não pegou"|\
    "ERRO:  POST FALHOU: anon/authenticated executam sayerlack_ipi_itens — REVOKE por nome não pegou")
      ok "F7b postcondição aborta o apply com a função de alíquota aberta" ;;
    *) bad "F7b ERRO ALHEIO à postcondição — veio [${F7B:-<nenhuma linha ERROR>}]" ;;
  esac
fi
restaura
sabota 's/IF auth\.uid() IS NOT NULL$/IF false/'
dente "F8 sem o gate de papel, customer grava (P4)" "$(rpc "100, '$ITENS_100'::jsonb, 704.74" "SET test.uid='22222222-2222-2222-2222-222222222222';")" "RPC_OK_2"
restaura
sabota 's/CHECK (aliquota_pct >= 0 AND aliquota_pct < 100 AND aliquota_pct = round(aliquota_pct, 2))/CHECK (true)/'
dente "F9 sem o CHECK de faixa, NaN entra na tabela (T2)" "$(sql "INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES ('11111111', 'NaN', 'nf', 'x', '2026-10-05')")" "SQL_OK"
P -q -c "DELETE FROM public.ipi_aliquota_ncm WHERE ncm = '11111111'"
restaura
sabota 's/num_nulls(preco_unitario_sem_ipi_portal, valor_ipi_portal, aliquota_ipi_portal, ncm_ipi_portal) IN (0, 4)/true/'
dente "F10 sem o as-4-ou-nenhuma, o IPI sozinho entra (T3)" "$(sql "UPDATE public.pedido_compra_item SET valor_ipi_portal = 1 WHERE id = 101")" "SQL_OK"
restaura
sabota "s/AND op\.account = lower(s\.empresa)/AND op.account = 'oben'/"
dente "F11 conta fixa em oben: o COLACOR passa a exigir 3,25% (A4)" "$(rpc "700, '[{\"item_id\":701,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":0}]'::jsonb, 100")" "RPC_ERR_CP007"
restaura
sabota 's/ AND op\.account = lower(s\.empresa)//'
dente "F12 sem filtro de conta, o NCM da colacor vaza no pedido OBEN (A1)" "$(rpc "100, '$ITENS_100'::jsonb, 704.74")" "RPC_ERR_CP006"
restaura
# Controle: a migration REAL re-aplicada segue verde nos asserts centrais.
eq "FC controle: N4 volta a CP004" "$(rpc "100, '[$I101]'::jsonb, 454.62")" "RPC_ERR_CP004"
eq "FC controle: A1 volta a gravar" "$(rpc "100, '$ITENS_100'::jsonb, 704.74")" "RPC_OK_2"
rm -f "$SAB" "$SAB.err"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
```

- [ ] **Step 2: rodar e ver falhar pelo motivo certo**

```bash
bash db/test-sayerlack-ipi-po.sh > "$TMPDIR/t-ipi.log" 2>&1; echo "rc=$?"; tail -c 300 "$TMPDIR/t-ipi.log"
```
Expected: `rc=1` com `INFRA: ausente: .../20261006120000_preco_exato_po_sayerlack_ipi.sql`.

- [ ] **Step 3: escrever a migration**

Criar `supabase/migrations/20261006120000_preco_exato_po_sayerlack_ipi.sql`:

```sql
-- ============================================================================
-- Preço exato no PO Sayerlack — IPI por NCM na prova do portal e decomposição no item
-- ============================================================================
-- Spec: docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md (decisões do founder, 2026-10-05).
--
-- A "divergência aberta" da captura do portal (captura-custo.ts; #2459: 374,77 cobrados × 362,9698 na linha) é o
-- IPI: o portal cobra Σ Preço Venda (mercadoria, sem IPI) + o IPI de cada item pela alíquota do NCM. No backtest de
-- 29 pedidos (06/09 → 05/10) 13 alíquotas fecham todos em ≤ R$ 0,02. Esta migration:
--   1. cria ipi_aliquota_ncm — alíquota MEDIDA por NCM, com fonte e evidência — e semeia as 13;
--   2. dá a pedido_compra_item a decomposição que o PO usa (unitário sem IPI, IPI da linha, alíquota, NCM), com
--      escritor ÚNICO = a RPC abaixo e o CHECK que a mantém inteira (as 4 ou nenhuma);
--   3. cria sayerlack_ipi_itens(p_pedido_id): a alíquota de cada item (NCM do cadastro × tabela, conta
--      lower(empresa)) — UMA implementação, que a edge usa para calcular e a RPC para conferir;
--   4. reescreve sayerlack_aplicar_custo_portal com a MESMA assinatura: o payload vira o pedido INTEIRO
--      {item_id, qtde_final, valor_mercadoria, valor_ipi}; a RPC confere o IPI contra a tabela (igualdade EXATA —
--      a edge calcula em centavos inteiros, aqui em numeric), prova o total cobrado com a tolerância do
--      arredondamento e grava preco_unitario/valor_linha como CUSTO COM IPI (D1 do founder) junto da decomposição.
--
-- Compatibilidade (spec §5.3 — nenhuma combinação grava número errado): a edge anterior manda
-- {preco_unitario, valor_linha} ⇒ CP001 aqui (captura cega); a edge nova contra a RPC anterior cai em CP001 lá
-- (o payload novo não tem preco_unitario). Ordem segura: este BANCO antes das edges.
--
-- SQLSTATEs (classe CP = Custo do Portal; a edge casa a MARCA, nunca "lançou algo"):
--   CP001  payload inválido: vazio, chave ausente, tipo não-número, ≤ 0, IPI < 0, total não finito ou ≤ 0
--   CP002  PO Omie JÁ existe — recusa idempotente
--   CP003  pedido não elegível (inexistente ou status_envio_portal ≠ 'sucesso_portal')
--   CP004  itens divergentes: id repetido; o payload não é o pedido inteiro; id alheio; qtde_final ecoada ≠ a da
--          linha; qtde_final fracionária (o PO manda ceil — nQtde × nValUnit passaria da mercadoria)
--   CP006  item sem alíquota de IPI conhecida (NCM ausente ou fora de ipi_aliquota_ncm) — ausente ≠ zero
--   CP007  a prova não fecha: IPI do payload ≠ recalculado, ou |Σ(linha + IPI) − total cobrado| > tolerância
-- O CP005 da versão anterior (derivado indeterminado) sai: com o payload cobrindo todos os itens e cada um gravado
-- com valor_linha > 0, ele ficou inalcançável.
--
-- Prova: db/test-sayerlack-ipi-po.sh (PG17 descartável; paridade com os 29 pedidos reais; falsificação).
-- Apply MANUAL (Lovable: SQL Editor → cola → Run). Idempotente.
-- ============================================================================

BEGIN;

-- 1) ── ipi_aliquota_ncm ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ipi_aliquota_ncm (
  ncm           text        PRIMARY KEY,
  aliquota_pct  numeric     NOT NULL,
  fonte         text        NOT NULL,
  evidencia     text        NOT NULL,
  medido_em     date        NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
-- Constraints por DROP IF EXISTS + ADD: re-rodar a migration REAPLICA o contrato.
ALTER TABLE public.ipi_aliquota_ncm DROP CONSTRAINT IF EXISTS ipi_aliquota_ncm_ncm_8_digitos;
ALTER TABLE public.ipi_aliquota_ncm ADD CONSTRAINT ipi_aliquota_ncm_ncm_8_digitos CHECK (ncm ~ '^[0-9]{8}$');
-- `>= 0` e `< 100` juntos barram NaN ('NaN' >= 0 é TRUE em numeric, 'NaN' < 100 é FALSE) e ±Infinity. No máximo 2
-- casas, como a TIPI: é o que deixa o IPI exato em centavos dos DOIS lados.
ALTER TABLE public.ipi_aliquota_ncm DROP CONSTRAINT IF EXISTS ipi_aliquota_ncm_aliquota_faixa;
ALTER TABLE public.ipi_aliquota_ncm ADD CONSTRAINT ipi_aliquota_ncm_aliquota_faixa CHECK (aliquota_pct >= 0 AND aliquota_pct < 100 AND aliquota_pct = round(aliquota_pct, 2));
ALTER TABLE public.ipi_aliquota_ncm DROP CONSTRAINT IF EXISTS ipi_aliquota_ncm_fonte_valida;
ALTER TABLE public.ipi_aliquota_ncm ADD CONSTRAINT ipi_aliquota_ncm_fonte_valida CHECK (fonte IN ('nf', 'portal'));
ALTER TABLE public.ipi_aliquota_ncm DROP CONSTRAINT IF EXISTS ipi_aliquota_ncm_evidencia_nao_vazia;
ALTER TABLE public.ipi_aliquota_ncm ADD CONSTRAINT ipi_aliquota_ncm_evidencia_nao_vazia CHECK (btrim(evidencia) <> '');

ALTER TABLE public.ipi_aliquota_ncm ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ipi_aliquota_ncm FROM anon, authenticated;
GRANT SELECT ON public.ipi_aliquota_ncm TO service_role;

COMMENT ON TABLE public.ipi_aliquota_ncm IS
  'Alíquota de IPI MEDIDA por NCM (8 dígitos) — fonte nf (NF de entrada lida) ou portal (identificada pelo total cobrado). Lida por sayerlack_ipi_itens; a captura do portal a re-prova a cada pedido (soma das linhas + IPI = total cobrado). Escrita: SQL Editor. NCM fora daqui = captura cega ipi_ncm_desconhecido (nunca 0%).';

INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES
  ('32081020', 3.25, 'nf',     'NF 000953881 (Renner Sayerlack, 02/10/2026), tela de recebimento do Omie; backtest de 29 pedidos Sayerlack 06/09–05/10: 19 linhas, a vizinha erra R$ 90,07', '2026-10-05'),
  ('32082020', 3.25, 'nf',     'NF 000953881 (Renner Sayerlack, 02/10/2026), tela de recebimento do Omie; backtest de 29 pedidos: 10 linhas, a vizinha erra R$ 22,75', '2026-10-05'),
  ('32089039', 6.5,  'nf',     'NF 000953881 (Renner Sayerlack, 02/10/2026), tela de recebimento do Omie; backtest de 29 pedidos: 22 linhas, a vizinha erra R$ 109,84', '2026-10-05'),
  ('38140090', 6.5,  'nf',     'NF 000953881 (Renner Sayerlack, 02/10/2026), tela de recebimento do Omie; backtest de 29 pedidos: 13 linhas, a vizinha erra R$ 50,17', '2026-10-05'),
  ('32081010', 3.25, 'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10 (total cobrado × Σ Preço Venda): 30 linhas, a vizinha erra R$ 54,02', '2026-10-05'),
  ('32082019', 3.25, 'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 11 linhas, a vizinha erra R$ 70,35', '2026-10-05'),
  ('32129090', 6.5,  'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 2 linhas, a vizinha erra R$ 12,93', '2026-10-05'),
  ('32141020', 1.3,  'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 1 linha (2% da TIPI com a redução de 35%), a vizinha erra R$ 4,87', '2026-10-05'),
  ('32149000', 0,    'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 13 linhas, a vizinha erra R$ 64,79', '2026-10-05'),
  ('29153999', 0,    'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 7 linhas, a vizinha erra R$ 18,82', '2026-10-05'),
  ('32041210', 0,    'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 2 linhas, a vizinha erra R$ 6,48', '2026-10-05'),
  ('38089219', 0,    'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 1 linha, a vizinha erra R$ 5,91', '2026-10-05'),
  ('29221919', 0,    'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 1 linha de R$ 13,71 (pedido 2662, ×1,0000 exato), a vizinha erra R$ 0,18', '2026-10-05')
ON CONFLICT (ncm) DO NOTHING;

-- 2) ── decomposição no item (escritor ÚNICO: sayerlack_aplicar_custo_portal) ──
ALTER TABLE public.pedido_compra_item
  ADD COLUMN IF NOT EXISTS preco_unitario_sem_ipi_portal numeric,
  ADD COLUMN IF NOT EXISTS valor_ipi_portal              numeric,
  ADD COLUMN IF NOT EXISTS aliquota_ipi_portal           numeric,
  ADD COLUMN IF NOT EXISTS ncm_ipi_portal                text;
ALTER TABLE public.pedido_compra_item DROP CONSTRAINT IF EXISTS pedido_compra_item_ipi_portal_coerente;
ALTER TABLE public.pedido_compra_item ADD CONSTRAINT pedido_compra_item_ipi_portal_coerente CHECK (
  num_nulls(preco_unitario_sem_ipi_portal, valor_ipi_portal, aliquota_ipi_portal, ncm_ipi_portal) IN (0, 4)
  AND (preco_unitario_sem_ipi_portal IS NULL OR (preco_unitario_sem_ipi_portal > 0 AND preco_unitario_sem_ipi_portal < 'Infinity'::numeric))
  AND (valor_ipi_portal IS NULL OR (valor_ipi_portal >= 0 AND valor_ipi_portal < 'Infinity'::numeric))
  AND (aliquota_ipi_portal IS NULL OR (aliquota_ipi_portal >= 0 AND aliquota_ipi_portal < 100))
  AND (ncm_ipi_portal IS NULL OR ncm_ipi_portal ~ '^[0-9]{8}$')
);
COMMENT ON COLUMN public.pedido_compra_item.preco_unitario_sem_ipi_portal IS
  'Unitário SEM IPI provado pelo portal (round2(Preço Venda) ÷ qtde_final) — vai em nValUnit do PO. Escritor único: sayerlack_aplicar_custo_portal. Nulo = sem prova (o PO usa preco_unitario, como antes).';
COMMENT ON COLUMN public.pedido_compra_item.valor_ipi_portal IS
  'IPI da LINHA em R$ (round2(linha × alíquota ÷ 100)) — vai em nValorIpi do PO. 0 = alíquota 0% MEDIDA, nunca ausência. Escritor único: sayerlack_aplicar_custo_portal.';
COMMENT ON COLUMN public.pedido_compra_item.aliquota_ipi_portal IS
  'Alíquota (%) de ipi_aliquota_ncm usada na prova deste item (auditoria — a tabela pode mudar depois). Escritor único: sayerlack_aplicar_custo_portal.';
COMMENT ON COLUMN public.pedido_compra_item.ncm_ipi_portal IS
  'NCM (8 dígitos, do omie_products da conta do pedido) usado na prova deste item. Escritor único: sayerlack_aplicar_custo_portal.';

-- 3) ── a alíquota de cada item — UMA implementação (edge calcula, RPC confere) ──
CREATE OR REPLACE FUNCTION public.sayerlack_ipi_itens(p_pedido_id bigint)
RETURNS TABLE (item_id bigint, ncm text, aliquota_pct numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT i.id,
         n.ncm,
         a.aliquota_pct
    FROM public.pedido_compra_item i
    JOIN public.pedido_compra_sugerido s ON s.id = i.pedido_id
    LEFT JOIN public.omie_products op
      ON op.omie_codigo_produto::text = i.sku_codigo_omie AND op.account = lower(s.empresa)
    CROSS JOIN LATERAL (SELECT NULLIF(regexp_replace(coalesce(op.ncm, ''), '[^0-9]', '', 'g'), '') AS ncm) n
    LEFT JOIN public.ipi_aliquota_ncm a ON a.ncm = n.ncm
   WHERE i.pedido_id = p_pedido_id
   ORDER BY i.id
$function$;
COMMENT ON FUNCTION public.sayerlack_ipi_itens(bigint) IS
  'Por item do pedido: NCM (só dígitos, de omie_products na conta lower(empresa)) e a alíquota de ipi_aliquota_ncm (NULL = NCM ausente ou fora da tabela). Usada pela edge enviar-pedido-portal-sayerlack e pela RPC sayerlack_aplicar_custo_portal. service_role.';
REVOKE ALL ON FUNCTION public.sayerlack_ipi_itens(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sayerlack_ipi_itens(bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_ipi_itens(bigint) TO service_role;

-- 4) ── a RPC de custo, v3 (mesma assinatura) ──
CREATE OR REPLACE FUNCTION public.sayerlack_aplicar_custo_portal(
  p_pedido_id   bigint,
  p_itens       jsonb,
  p_valor_total numeric
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n              integer;
  v_afetadas       integer;
  v_atualizados    integer;
  v_omie           text;
  v_status         text;
  v_ids_distintos  integer;
  v_itens_total    integer;
  v_pertencem      integer;
  v_sem_aliquota   text;
  v_ipi_divergente integer;
  v_total_modelado numeric;
  v_tolerancia     numeric;
BEGIN
  -- Gate de papel (defesa em profundidade; a tranca é o privilégio).
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'employee'::app_role)
              OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- CP001 — payload. Ausente ≠ zero: nada aqui degrada para default.
  IF p_pedido_id IS NULL OR p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' THEN
    RAISE EXCEPTION 'custo_portal: payload inválido (pedido=%, itens=%)',
      coalesce(p_pedido_id::text, 'null'), coalesce(jsonb_typeof(p_itens), 'null') USING ERRCODE = 'CP001';
  END IF;
  v_n := jsonb_array_length(p_itens);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'custo_portal: payload sem itens — a prova cobre o pedido inteiro' USING ERRCODE = 'CP001';
  END IF;
  IF p_valor_total IS NULL OR p_valor_total = 'NaN'::numeric
     OR NOT (p_valor_total > 0 AND p_valor_total < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'custo_portal: valor_total não finito ou ≤ 0 (%)', coalesce(p_valor_total::text, 'null') USING ERRCODE = 'CP001';
  END IF;
  -- Cada item: id inteiro e 3 NÚMEROS JSON. `IS DISTINCT FROM`, nunca `<>`: chave AUSENTE dá jsonb_typeof NULL, e
  -- `NULL <> 'number'` é NULL — o EXISTS leria "nada errado" e o item sem IPI passaria (verde por ausência).
  -- Número JSON nunca é NaN/Infinity (a string "NaN" tem tipo 'string').
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) e
     WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
        OR (e->>'item_id') IS NULL OR (e->>'item_id') !~ '^[0-9]+$'
        OR jsonb_typeof(e->'qtde_final')       IS DISTINCT FROM 'number'
        OR jsonb_typeof(e->'valor_mercadoria') IS DISTINCT FROM 'number'
        OR jsonb_typeof(e->'valor_ipi')        IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'custo_portal: item sem id inteiro ou sem qtde_final/valor_mercadoria/valor_ipi numéricos' USING ERRCODE = 'CP001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) e
     WHERE NOT ((e->>'qtde_final')::numeric > 0 AND (e->>'valor_mercadoria')::numeric > 0 AND (e->>'valor_ipi')::numeric >= 0)
  ) THEN
    RAISE EXCEPTION 'custo_portal: qtde_final/valor_mercadoria ≤ 0 ou valor_ipi < 0 no payload' USING ERRCODE = 'CP001';
  END IF;
  -- CP004 (forma barata): id repetido.
  SELECT count(DISTINCT (e->>'item_id')::bigint) INTO v_ids_distintos FROM jsonb_array_elements(p_itens) e;
  IF v_ids_distintos <> v_n THEN
    RAISE EXCEPTION 'custo_portal: item_id repetido no payload (% ids, % distintos)', v_n, v_ids_distintos USING ERRCODE = 'CP004';
  END IF;

  -- (1) CAS no próprio UPDATE: só grava se AINDA não há PO Omie e o pedido está em sucesso_portal. O row-lock
  -- serializa contra quem grava omie_pedido_compra_numero; sob READ COMMITTED o predicado é reavaliado.
  UPDATE public.pedido_compra_sugerido p
     SET valor_total_portal_provado           = p_valor_total,
         valor_total_portal_provado_em        = now(),
         valor_total_portal_provado_protocolo = p.portal_protocolo
   WHERE p.id = p_pedido_id
     AND p.omie_pedido_compra_numero IS NULL
     AND p.status_envio_portal = 'sucesso_portal';
  GET DIAGNOSTICS v_afetadas = ROW_COUNT;
  IF v_afetadas <> 1 THEN
    SELECT p.omie_pedido_compra_numero, p.status_envio_portal INTO v_omie, v_status
      FROM public.pedido_compra_sugerido p WHERE p.id = p_pedido_id;
    IF FOUND AND v_omie IS NOT NULL THEN
      RAISE EXCEPTION 'custo_portal: pedido % já tem PO Omie (%) — custo não muda mais', p_pedido_id, v_omie USING ERRCODE = 'CP002';
    END IF;
    RAISE EXCEPTION 'custo_portal: pedido % não elegível (status_envio_portal=%)',
      p_pedido_id, coalesce(v_status, 'inexistente') USING ERRCODE = 'CP003';
  END IF;

  -- (2) CP004 — o payload é o pedido INTEIRO: nem item a menos, nem item alheio. A decomposição tem de nascer em
  -- todo item; PO com metade dos itens sem IPI seria o custo misto que o tudo-ou-nada existe para impedir.
  SELECT count(*) INTO v_itens_total FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id;
  SELECT count(*) INTO v_pertencem
    FROM jsonb_array_elements(p_itens) e
    JOIN public.pedido_compra_item i ON i.id = (e->>'item_id')::bigint AND i.pedido_id = p_pedido_id;
  IF v_n <> v_itens_total OR v_pertencem <> v_n THEN
    RAISE EXCEPTION 'custo_portal: o payload (% itens, % do pedido) não é o pedido % inteiro (% itens) — nada gravado',
      v_n, v_pertencem, p_pedido_id, v_itens_total USING ERRCODE = 'CP004';
  END IF;

  -- (3) CP006 — a alíquota de cada item, pela MESMA função que a edge leu. Ausente ≠ zero.
  SELECT string_agg(coalesce(x.ncm, '(sem NCM)'), ', ' ORDER BY x.item_id) INTO v_sem_aliquota
    FROM public.sayerlack_ipi_itens(p_pedido_id) x
   WHERE x.aliquota_pct IS NULL;
  IF v_sem_aliquota IS NOT NULL THEN
    RAISE EXCEPTION 'custo_portal: item sem alíquota de IPI conhecida no pedido % (NCM: %) — nada gravado',
      p_pedido_id, v_sem_aliquota USING ERRCODE = 'CP006';
  END IF;

  -- (4) CP007 — a prova. IPI do item = round(round(mercadoria, 2) × alíquota ÷ 100, 2), meio centavo para cima: a
  -- edge faz a MESMA conta em centavos inteiros, logo a igualdade é EXATA. O total modelado (Σ linha + IPI) fecha
  -- com o cobrado dentro do arredondamento: meio centavo do total + 0,0101 por linha (spec §6).
  SELECT count(*) FILTER (WHERE c.ipi_payload IS DISTINCT FROM c.ipi), sum(c.linha + c.ipi)
    INTO v_ipi_divergente, v_total_modelado
    FROM (
      SELECT (e->>'valor_ipi')::numeric AS ipi_payload,
             round((e->>'valor_mercadoria')::numeric, 2) AS linha,
             round(round((e->>'valor_mercadoria')::numeric, 2) * x.aliquota_pct / 100, 2) AS ipi
        FROM jsonb_array_elements(p_itens) e
        JOIN public.sayerlack_ipi_itens(p_pedido_id) x ON x.item_id = (e->>'item_id')::bigint
    ) c;
  v_tolerancia := 0.005 + 0.0101 * v_n;
  IF v_ipi_divergente <> 0 OR v_total_modelado IS NULL OR abs(v_total_modelado - p_valor_total) > v_tolerancia THEN
    RAISE EXCEPTION 'custo_portal: a prova do IPI não fecha no pedido % (% IPI divergente; modelado %, cobrado %, tolerância %) — nada gravado',
      p_pedido_id, v_ipi_divergente, coalesce(v_total_modelado::text, 'null'), p_valor_total, v_tolerancia USING ERRCODE = 'CP007';
  END IF;

  -- (5) grava a decomposição (o que o PO leva) e o CUSTO COM IPI (o que tela, e-mail e valor_total leem — D1). O
  -- WHERE confere a quantidade: a ecoada pela edge tem de ser a da linha, e inteira — o PO manda
  -- nQtde = ceil(qtde_final); com 3,6 L, `4 × mercadoria ÷ 3,6` passaria 11% da mercadoria.
  UPDATE public.pedido_compra_item i
     SET preco_unitario_sem_ipi_portal = c.linha / i.qtde_final,
         valor_ipi_portal              = c.ipi,
         aliquota_ipi_portal           = c.aliquota_pct,
         ncm_ipi_portal                = c.ncm,
         valor_linha                   = c.linha + c.ipi,
         preco_unitario                = (c.linha + c.ipi) / i.qtde_final
    FROM (
      SELECT (e->>'item_id')::bigint AS item_id,
             (e->>'qtde_final')::numeric AS qtde_eco,
             round((e->>'valor_mercadoria')::numeric, 2) AS linha,
             round(round((e->>'valor_mercadoria')::numeric, 2) * x.aliquota_pct / 100, 2) AS ipi,
             x.aliquota_pct,
             x.ncm
        FROM jsonb_array_elements(p_itens) e
        JOIN public.sayerlack_ipi_itens(p_pedido_id) x ON x.item_id = (e->>'item_id')::bigint
    ) c
   WHERE i.id = c.item_id AND i.pedido_id = p_pedido_id AND i.qtde_final = c.qtde_eco AND i.qtde_final = trunc(i.qtde_final);
  GET DIAGNOSTICS v_atualizados = ROW_COUNT;
  IF v_atualizados <> v_n THEN
    RAISE EXCEPTION 'custo_portal: % de % itens com qtde_final igual à ecoada e inteira no pedido % — nada gravado',
      v_atualizados, v_n, p_pedido_id USING ERRCODE = 'CP004';
  END IF;

  -- (6) o DERIVADO, na mesma transação. Todo item acabou de ganhar valor_linha > 0: a soma não tem NULL.
  UPDATE public.pedido_compra_sugerido
     SET valor_total = (SELECT sum(valor_linha) FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id)
   WHERE id = p_pedido_id;

  RETURN v_atualizados;
END;
$function$;

COMMENT ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) IS
  'Custo do portal Sayerlack com IPI (edge enviar-pedido-portal-sayerlack, service_role): CAS omie IS NULL + sucesso_portal; payload = pedido inteiro {item_id, qtde_final, valor_mercadoria, valor_ipi}; IPI conferido contra ipi_aliquota_ncm (sayerlack_ipi_itens) com igualdade exata; prova contra o total cobrado; grava a decomposição (sem IPI/IPI/alíquota/NCM) e o custo com IPI, e remantém o derivado — uma transação. SQLSTATE CP001–CP004, CP006, CP007.';

-- CREATE OR REPLACE preserva o ACL; reemitir é barato e a postcondição confere.
REVOKE ALL ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) TO service_role;

-- O #2459 caiu em PGRST202 com a função existindo: emitir o reload é o que separa a captura gravar de cair em erro_rpc.
NOTIFY pgrst, 'reload schema';

-- Postcondição: tudo no ar, e a RPC é a NOVA. Colar metade do bloco não pode passar calado.
DO $post$
DECLARE v_rpc oid; v_ipi oid; v_def text;
BEGIN
  IF (SELECT count(*) FROM public.ipi_aliquota_ncm WHERE ncm IN ('32081020','32082020','32089039','38140090','32081010',
        '32082019','32129090','32141020','32149000','29153999','32041210','38089219','29221919')) <> 13 THEN
    RAISE EXCEPTION 'POST FALHOU: ipi_aliquota_ncm sem as 13 alíquotas medidas — a captura ficaria cega por NCM';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ipi_aliquota_ncm'::regclass) THEN
    RAISE EXCEPTION 'POST FALHOU: ipi_aliquota_ncm sem RLS';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pedido_compra_item'
       AND column_name IN ('preco_unitario_sem_ipi_portal', 'valor_ipi_portal', 'aliquota_ipi_portal', 'ncm_ipi_portal')) <> 4 THEN
    RAISE EXCEPTION 'POST FALHOU: as 4 colunas da decomposição não existem em pedido_compra_item';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_compra_item_ipi_portal_coerente'
                   AND conrelid = 'public.pedido_compra_item'::regclass) THEN
    RAISE EXCEPTION 'POST FALHOU: CHECK pedido_compra_item_ipi_portal_coerente ausente';
  END IF;
  SELECT p.oid INTO v_ipi FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sayerlack_ipi_itens' AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint';
  IF v_ipi IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU: sayerlack_ipi_itens(bigint) não existe — a edge cairia em ipi_leitura_falhou';
  END IF;
  IF has_function_privilege('anon', v_ipi, 'EXECUTE') OR has_function_privilege('authenticated', v_ipi, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU: anon/authenticated executam sayerlack_ipi_itens — REVOKE por nome não pegou';
  END IF;
  IF NOT has_function_privilege('service_role', v_ipi, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU: service_role sem EXECUTE em sayerlack_ipi_itens — a edge não leria as alíquotas';
  END IF;
  SELECT p.oid INTO v_rpc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sayerlack_aplicar_custo_portal'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_itens jsonb, p_valor_total numeric';
  IF v_rpc IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU: sayerlack_aplicar_custo_portal(bigint,jsonb,numeric) não existe';
  END IF;
  v_def := pg_get_functiondef(v_rpc);
  IF v_def NOT LIKE '%valor_mercadoria%' OR v_def NOT LIKE '%CP007%' OR v_def NOT LIKE '%sayerlack_ipi_itens%' THEN
    RAISE EXCEPTION 'POST FALHOU: a RPC no ar é a versão ANTERIOR (não cita valor_mercadoria/CP007/sayerlack_ipi_itens)';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_rpc) THEN
    RAISE EXCEPTION 'POST FALHOU: a RPC não é SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_rpc AND proconfig::text LIKE '%search_path=public%') THEN
    RAISE EXCEPTION 'POST FALHOU: search_path da RPC não está preso em public';
  END IF;
  IF has_function_privilege('anon', v_rpc, 'EXECUTE') OR has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU: anon/authenticated ainda executam sayerlack_aplicar_custo_portal — REVOKE por nome não pegou';
  END IF;
  IF NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU: service_role sem EXECUTE — a edge não conseguiria gravar custo';
  END IF;
  RAISE NOTICE 'preco_exato_po_sayerlack_ipi: 13 alíquotas, RLS, decomposição + CHECK, sayerlack_ipi_itens fechada, RPC v3 SECDEF/search_path/ACL ok';
END
$post$;

COMMIT;
```

- [ ] **Step 4: rodar a prova nos dois locales**

```bash
bash db/test-sayerlack-ipi-po.sh > "$TMPDIR/t-ipi.log" 2>&1; rc=$?; echo "rc=$rc"; grep -E "RESULTADO|HARNESS|❌" "$TMPDIR/t-ipi.log" | head -20
HARNESS_LC=pt_BR.UTF-8 bash db/test-sayerlack-ipi-po.sh > "$TMPDIR/t-ipi-br.log" 2>&1; rc=$?; echo "rc-br=$rc"; grep -E "RESULTADO|HARNESS" "$TMPDIR/t-ipi-br.log"
```
Expected: `rc=0` e `rc-br=0`, `RESULTADO: <N> ok / 0 fail`, `✅ HARNESS VERDE`, nenhum `❌`. Anote o N.

- [ ] **Step 5: entrar no núcleo de CI**

Em `db/nucleo-ci.txt`, na seção do eixo de **finitude monetária** (procure o cabeçalho `── Eixo 2`), acrescente
(com o N medido no Step 4):

```text
# Preço exato no PO Sayerlack: a RPC de custo do portal confere o IPI contra ipi_aliquota_ncm (igualdade exata em
# centavos), prova o total cobrado, grava a decomposição sem IPI/IPI e recusa NaN/Infinity/≤0 no payload; paridade
# com os 29 pedidos reais do arquivo-ouro e falsificação inline por camada (docs/historico/preco-exato-po-sayerlack.md).
db/test-sayerlack-ipi-po.sh                <N>
```

Rode o runner só com esta linha para conferir o formato:
```bash
grep -n "test-sayerlack-ipi-po" db/nucleo-ci.txt
```
Expected: 1 linha.

- [ ] **Step 6: commit (antes de qualquer falsificação extra)**

```bash
git add supabase/migrations/20261006120000_preco_exato_po_sayerlack_ipi.sql db/test-sayerlack-ipi-po.sh db/nucleo-ci.txt
git commit -m "feat(reposicao): IPI por NCM na RPC de custo do portal — tabela medida, decomposição no item e prova contra o total cobrado [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Captura pura com IPI (bloco espelhado)

**Files:**
- Modify: `supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.ts` (cabeçalho l.9-28 e o bloco entre os marcadores)
- Modify: `src/lib/reposicao/sayerlack-scraping-pedido.ts` (bloco)
- Rewrite: `supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.test.ts`
- Rewrite: `src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts`

**Interfaces:**
- Consumes: o arquivo-ouro (Task 1).
- Produces (a Task 4 usa):
  - `consolidarLinhasPortal(dom: LinhaDom[], json: AddJsonPortal | null, esperados: ItemEsperado[], leituraIpi: 'ok' | 'falhou'): Consolidacao`
  - `ItemEsperado = { sku_portal: string; qtde_portal: number; ncm: string | null; aliquota_ipi_pct: number | null }`
  - `LinhaPortal = { sku_portal; prz_ent_raw; total_linha: number | null; valor_ipi: number | null }`
  - `ItemPedido = { item_id; sku_codigo_omie; sku_descricao; sku_portal; qtde_final }` (sem `preco_atual`)
  - `derivarCustos(res) → { updates: CustoUpdate[]; pulados }`, `CustoUpdate = { item_id; qtde_final; valor_mercadoria; valor_ipi }`
  - `Consolidacao.ncm_sem_aliquota: string[]`; `checksum` ganha `ipi_modelado` e `total_modelado`
  - `MotivoRpcCusto` ganha `'aliquota_ipi_ausente'` (CP006) e `'prova_ipi_divergente'` (CP007)
  - `centavosDaMercadoria`, `centesimosDaAliquota`, `ipiCentavos`, `toleranciaChecksum` exportadas

- [ ] **Step 1: reescrever o teste Deno (vermelho primeiro)**

Substituir `captura-custo.test.ts` inteiro por:

```ts
// Testa a captura de custo PURA do portal Sayerlack: JSON do "Efetivar" + DOM + o que a edge digitou + a alíquota de
// IPI do NCM de cada item ⇒ linhas com mercadoria (sem IPI) e IPI PROVADOS, ou nada.
// Rodar: deno test supabase/functions/enviar-pedido-portal-sayerlack/
//
// Fatos de prod que estes testes preservam:
//   (2026-09-05, #2443) `value` do item no JSON = Preço UN de TABELA por embalagem — nunca é custo; `data.value` = cobrado.
//   (2026-09-05, #2459) `Preço Venda` do DOM = TOTAL DA LINHA: 142,2554 × 3 × (1 − 14,9488%) = 362,9698.
//   (2026-10-05, backtest de 29 pedidos) data.value = Σ round2(Preço Venda) + Σ IPI por item (alíquota do NCM): a
//     "divergência aberta" do #2459 era o IPI — 362,97 × 3,25% = 11,80 → 374,77. Os casos abaixo são PEDIDOS REAIS.
import {
  casarLinhasComItens, centavosDaMercadoria, centesimosDaAliquota, classificarErroRpcCusto, consolidarLinhasPortal,
  derivarCustos, extrairAddJson, ipiCentavos, parseBRL, parseDiasPrzEnt, resumirCaptura, round2, toleranciaChecksum,
  type AddJsonPortal, type ItemEsperado, type ItemPedido, type LinhaDom, type MotivoRpcCusto,
} from "./captura-custo.ts";

// Asserts LOCAIS de propósito (sem jsr:@std/assert): `deno test --no-remote` roda no `validate` do CI.
function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: esperado ${String(expected)}, veio ${String(actual)}`);
}
function assertPerto(actual: number | null | undefined, expected: number, msg: string, eps = 1e-6) {
  if (typeof actual !== "number" || Math.abs(actual - expected) > eps) throw new Error(`${msg}: esperado ≈${expected}, veio ${String(actual)}`);
}

const dom = (o: Partial<LinhaDom> = {}): LinhaDom => ({ sku_portal: "X", prz_ent_raw: "5", qtd_un_raw: "1", preco_venda_raw: "1,0000", preco_un_raw: "1,0000", ...o });
const item = (o: Partial<ItemPedido> = {}): ItemPedido => ({ item_id: 1, sku_codigo_omie: "1", sku_descricao: "d", sku_portal: "X", qtde_final: 1, ...o });

// #3091 (portal 2133415): IPI misto. A NF 000953881 cobrou o WJOI a 242,25 — o round2 do Preço Venda.
const DOM_3091: LinhaDom[] = [
  dom({ sku_portal: "WJOI.7585GL", qtd_un_raw: "1", preco_un_raw: "284,8248", preco_venda_raw: "242,2470" }),
  dom({ sku_portal: "FC.6902L5", qtd_un_raw: "2", preco_un_raw: "250,9460", preco_venda_raw: "426,8652" }),
];
const JSON_3091: AddJsonPortal = { itens: [{ item: "WJOI.7585GL", value: 284.8248 }, { item: "FC.6902L5", value: 250.946 }], value: 704.74, ordernum: 2133415 };
const ESP_3091: ItemEsperado[] = [
  { sku_portal: "WJOI.7585GL", qtde_portal: 1, ncm: "3208.20.20", aliquota_ipi_pct: 3.25 },
  { sku_portal: "FC.6902L5", qtde_portal: 2, ncm: "3208.90.39", aliquota_ipi_pct: 6.5 },
];
// #2745: as 4 alíquotas (1,3% · 3,25% · 0% · 6,5%); modelado 4413,02 × 4413,01 cobrados — 1 centavo, tolerância 0,0454.
const DOM_2745: LinhaDom[] = [
  dom({ sku_portal: "YL.1424.02GL", qtd_un_raw: "4", preco_un_raw: "110,3076", preco_venda_raw: "375,2718" }),
  dom({ sku_portal: "WJOB.7666GL", qtd_un_raw: "4", preco_un_raw: "310,7957", preco_venda_raw: "1057,3419" }),
  dom({ sku_portal: "DEZ.8014L5", qtd_un_raw: "2", preco_un_raw: "219,5545", preco_venda_raw: "298,7742" }),
  dom({ sku_portal: "FC.6975LT", qtd_un_raw: "5", preco_un_raw: "583,4430", preco_venda_raw: "2481,1264" }),
];
const JSON_2745: AddJsonPortal = {
  itens: [{ item: "YL.1424.02GL", value: 110.3076 }, { item: "WJOB.7666GL", value: 310.7957 }, { item: "DEZ.8014L5", value: 219.5545 }, { item: "FC.6975LT", value: 583.443 }],
  value: 4413.01, ordernum: 2745,
};
const ESP_2745: ItemEsperado[] = [
  { sku_portal: "YL.1424.02GL", qtde_portal: 4, ncm: "3214.10.20", aliquota_ipi_pct: 1.3 },
  { sku_portal: "WJOB.7666GL", qtde_portal: 4, ncm: "3208.20.19", aliquota_ipi_pct: 3.25 },
  { sku_portal: "DEZ.8014L5", qtde_portal: 2, ncm: "2915.39.99", aliquota_ipi_pct: 0 },
  { sku_portal: "FC.6975LT", qtde_portal: 5, ncm: "3208.90.39", aliquota_ipi_pct: 6.5 },
];
// #2459 (portal 2126911, 1 item; WFBT.6045GL = NCM 3208.10.20): o caso que abriu a "divergência".
const DOM_2459: LinhaDom[] = [dom({ sku_portal: "WFBT.6045GL", qtd_un_raw: "3", preco_un_raw: "142,2554", preco_venda_raw: "362,9698" })];
const JSON_2459: AddJsonPortal = { itens: [{ item: "WFBT.6045GL", value: 142.2554 }], value: 374.77, ordernum: 2126911 };
const ESP_2459: ItemEsperado[] = [{ sku_portal: "WFBT.6045GL", qtde_portal: 3, ncm: "3208.10.20", aliquota_ipi_pct: 3.25 }];

// ---------------------------------------------------------------- extrairAddJson
Deno.test("extrairAddJson: lê itens + total do JSON real do form/add (value vem como STRING)", () => {
  const parsed = JSON.parse('{"success":true,"data":{"itens":[{"item":"WP06.3900QT","value":153.203},{"item":"TEH.3505.00BB","value":124.9005}],"value":"1605.67","ordernum":2126906},"nr_pedido":2126906}');
  const j = extrairAddJson(parsed);
  assertEquals(j?.itens.length, 2, "2 itens");
  assertEquals(j?.itens[0].item, "WP06.3900QT", "sku exato");
  assertPerto(j?.itens[0].value, 153.203, "value numérico");
  assertPerto(j?.value, 1605.67, "total do pedido parseado da string");
  assertEquals(j?.ordernum, 2126906, "ordernum");
});
Deno.test("extrairAddJson: '153.203' em string NÃO vira 153203; '1.605,67' pt-BR parseia; lixo vira null (não zero)", () => {
  assertPerto(extrairAddJson({ data: { itens: [{ item: "A", value: "153.203" }], value: "1.605,67" } })?.itens[0].value, 153.203, "ponto decimal");
  assertPerto(extrairAddJson({ data: { itens: [{ item: "A", value: 1 }], value: "1.605,67" } })?.value, 1605.67, "pt-BR");
  assertEquals(extrairAddJson({ data: { itens: [{ item: "A", value: 1 }], value: "abc" } })?.value, null, "lixo → null");
});
Deno.test("extrairAddJson: sem data.itens (ou itens malformados) → null, nunca lista vazia disfarçada", () => {
  assertEquals(extrairAddJson(null), null, "null");
  assertEquals(extrairAddJson({ success: true, message: "Itens salvos na sessão" }), null, "save-tab-preco-session");
  assertEquals(extrairAddJson({ data: { itens: [] } }), null, "itens vazio");
  assertEquals(extrairAddJson({ data: { itens: [{ item: "", value: 1 }] } }), null, "item sem sku");
  assertEquals(extrairAddJson({ data: { itens: [{ item: "A", value: "x" }] } }), null, "value não numérico");
});

// ---------------------------------------------------------------- centavos (a conta que a RPC refaz em numeric)
Deno.test("centavos: o IPI em inteiros bate com o round(numeric, 2) do Postgres na fronteira de meio centavo", () => {
  assertEquals(ipiCentavos(6500, 650), 423, "R$ 65,00 × 6,5% = 4,225 → 4,23");
  assertEquals(round2(round2(65) * 6.5 / 100), 4.22, "o ponto flutuante erra o mesmo caso (é por isso que a conta é inteira)");
  assertEquals(ipiCentavos(42687, 650), 2775, "426,87 × 6,5% = 27,74655 → 27,75");
  assertEquals(ipiCentavos(24225, 325), 787, "242,25 × 3,25% = 7,873125 → 7,87");
  assertEquals(ipiCentavos(1371, 0), 0, "0% medido é 0");
});
Deno.test("centavosDaMercadoria: 4 casas do DOM viram centavos com meio-para-cima; ≤ 0, NaN e Infinity → null", () => {
  assertEquals(centavosDaMercadoria(426.8652), 42687, "426,8652 → 426,87");
  assertEquals(centavosDaMercadoria(100.005), 10001, "meio centavo sobe");
  assertEquals(centavosDaMercadoria(242.247), 24225, "242,247 → 242,25");
  assertEquals(centavosDaMercadoria(0), null, "zero");
  assertEquals(centavosDaMercadoria(-1), null, "negativo");
  assertEquals(centavosDaMercadoria(Number.NaN), null, "NaN");
  assertEquals(centavosDaMercadoria(Number.POSITIVE_INFINITY), null, "Infinity");
});
Deno.test("centesimosDaAliquota: 2 casas em [0, 100); fora disso ou null → null (nunca 0%)", () => {
  assertEquals(centesimosDaAliquota(3.25), 325, "3,25");
  assertEquals(centesimosDaAliquota(1.3), 130, "1,3");
  assertEquals(centesimosDaAliquota(0), 0, "0 medido");
  assertEquals(centesimosDaAliquota(3.255), null, "3 casas");
  assertEquals(centesimosDaAliquota(100), null, "100");
  assertEquals(centesimosDaAliquota(-0.01), null, "negativa");
  assertEquals(centesimosDaAliquota(null), null, "ausente");
});
Deno.test("toleranciaChecksum: meio centavo do total + 0,0101 por linha", () => {
  assertPerto(toleranciaChecksum(1), 0.0151, "1 linha");
  assertPerto(toleranciaChecksum(18), 0.1868, "18 linhas");
});

// ---------------------------------------------------------------- consolidarLinhasPortal — a prova com IPI
Deno.test("1 item (#2459): linha 362,97 + IPI 11,80 = 374,77 exato ⇒ dom_checksum; total_linha é a MERCADORIA (sem IPI)", () => {
  const c = consolidarLinhasPortal(DOM_2459, JSON_2459, ESP_2459, "ok");
  assertEquals(c.fonte, "dom_checksum", "fonte");
  assertPerto(c.linhas[0].total_linha, 362.9698, "mercadoria = Preço Venda, não data.value");
  assertEquals(c.linhas[0].valor_ipi, 11.8, "IPI do item");
  assertEquals(c.checksum.total_modelado, 374.77, "modelado");
  assertEquals(c.checksum.delta_abs, 0, "fecha no centavo");
  assertPerto(c.total_pedido, 374.77, "cobrado provado");
});
Deno.test("N itens (#3091): 426,87 × 6,5% = 27,75 e 242,25 × 3,25% = 7,87 ⇒ 704,74 exato", () => {
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091, "ok");
  assertEquals(c.fonte, "dom_checksum", "fonte");
  assertEquals(c.linhas.map((l) => l.valor_ipi).join(","), "7.87,27.75", "IPI por linha na ordem do JSON");
  assertEquals(c.checksum.ipi_modelado, 35.62, "IPI total");
  assertEquals(c.checksum.total_modelado, 704.74, "modelado");
});
Deno.test("#2745: 4 alíquotas, 1 centavo de arredondamento dentro da tolerância de 4 linhas", () => {
  const c = consolidarLinhasPortal(DOM_2745, JSON_2745, ESP_2745, "ok");
  assertEquals(c.fonte, "dom_checksum", "fonte");
  assertEquals(c.linhas.map((l) => l.valor_ipi).join(","), "4.88,34.36,0,161.27", "1,3% · 3,25% · 0% · 6,5%");
  assertEquals(c.checksum.total_modelado, 4413.02, "modelado");
  assertPerto(c.checksum.delta_abs, 0.01, "delta medido");
  assertPerto(c.checksum.tolerancia_abs, 0.0454, "tolerância de 4 linhas");
});
Deno.test("tolerância: 2 linhas aceitam 2 centavos e recusam 3", () => {
  assertEquals(consolidarLinhasPortal(DOM_3091, { ...JSON_3091, value: 704.76 }, ESP_3091, "ok").fonte, "dom_checksum", "0,02 ≤ 0,0252");
  assertEquals(consolidarLinhasPortal(DOM_3091, { ...JSON_3091, value: 704.77 }, ESP_3091, "ok").motivo, "checksum_divergente", "0,03 > 0,0252");
});
Deno.test("sem o IPI modelado (alíquota 0 informada no #2459) ⇒ checksum_divergente com os R$ 11,80 medidos", () => {
  const c = consolidarLinhasPortal(DOM_2459, JSON_2459, [{ ...ESP_2459[0], aliquota_ipi_pct: 0 }], "ok");
  assertEquals(c.motivo, "checksum_divergente", "a divergência de 2026-09-05, agora explicada");
  assertPerto(c.checksum.delta_abs, 11.8, "delta");
  assertEquals(c.linhas.every((l) => l.total_linha === null && l.valor_ipi === null), true, "nada provado");
});
Deno.test("alíquota errada (6,5% no lugar de 3,25%) ⇒ checksum_divergente: a prova falsifica a tabela", () => {
  const esp = ESP_3091.map((e) => (e.sku_portal === "WJOI.7585GL" ? { ...e, aliquota_ipi_pct: 6.5 } : e));
  assertEquals(consolidarLinhasPortal(DOM_3091, JSON_3091, esp, "ok").motivo, "checksum_divergente", "15,75 − 7,87 = R$ 7,88 de erro");
});
Deno.test("item sem alíquota ⇒ ipi_ncm_desconhecido com os NCMs na lista — nunca IPI 0", () => {
  const esp = ESP_3091.map((e) => (e.sku_portal === "FC.6902L5" ? { ...e, aliquota_ipi_pct: null } : e));
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, esp, "ok");
  assertEquals(c.motivo, "ipi_ncm_desconhecido", "marca do ramo");
  assertEquals(c.ncm_sem_aliquota.join(","), "3208.90.39", "o que cadastrar");
  const sem = consolidarLinhasPortal(DOM_2459, JSON_2459, [{ ...ESP_2459[0], ncm: null, aliquota_ipi_pct: null }], "ok");
  assertEquals(sem.ncm_sem_aliquota.join(","), "(sem NCM)", "produto sem NCM no cadastro");
});
Deno.test("leitura das alíquotas falhou ⇒ ipi_leitura_falhou (não consegui ler ≠ não existe)", () => {
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091, "falhou");
  assertEquals(c.motivo, "ipi_leitura_falhou", "marca do ramo");
  assertEquals(c.ncm_sem_aliquota.length, 0, "não acusa NCM que não foi lido");
});
Deno.test("1 item sem Preço Venda no DOM ⇒ dom_incompleto: data.value cego não prova mais a linha", () => {
  const c = consolidarLinhasPortal([dom({ ...DOM_2459[0], preco_venda_raw: "" })], JSON_2459, ESP_2459, "ok");
  assertEquals(c.motivo, "dom_incompleto", "marca do ramo");
});
Deno.test("1 item com o sku NÃO lido no DOM (defeito histórico): a linha única vale como a dele", () => {
  const c = consolidarLinhasPortal([dom({ ...DOM_2459[0], sku_portal: "" })], JSON_2459, ESP_2459, "ok");
  assertEquals(c.fonte, "dom_checksum", "fonte");
  assertEquals(c.linhas[0].sku_portal, "WFBT.6045GL", "sku vem do JSON");
});
Deno.test("adversário: ler 'Preço UN' no lugar de 'Preço Venda' ⇒ checksum_divergente", () => {
  const d = DOM_3091.map((l) => ({ ...l, preco_venda_raw: l.preco_un_raw }));
  assertEquals(consolidarLinhasPortal(d, JSON_3091, ESP_3091, "ok").motivo, "checksum_divergente", "marca do ramo");
});
Deno.test("adversário: 'Qtd Fat' lida como 'Qtd UN' ⇒ qtd_diverge antes de qualquer soma", () => {
  const d = DOM_3091.map((l, i) => (i === 1 ? { ...l, qtd_un_raw: "4" } : l));
  assertEquals(consolidarLinhasPortal(d, JSON_3091, ESP_3091, "ok").motivo, "qtd_diverge", "marca do ramo");
});
Deno.test("coluna 'Preço UN' do DOM ≠ value do JSON ⇒ preco_un_diverge", () => {
  const d = DOM_3091.map((l) => ({ ...l, preco_un_raw: l.preco_venda_raw }));
  assertEquals(consolidarLinhasPortal(d, JSON_3091, ESP_3091, "ok").motivo, "preco_un_diverge", "marca do ramo");
});
Deno.test("DOM sem sku identificado (N itens) ⇒ dom_incompleto, sem custo; sku vem do JSON", () => {
  const c = consolidarLinhasPortal(DOM_3091.map((l) => ({ ...l, sku_portal: "" })), JSON_3091, ESP_3091, "ok");
  assertEquals(c.motivo, "dom_incompleto", "marca do ramo");
  assertEquals(c.linhas.map((l) => l.sku_portal).join(","), "WJOI.7585GL,FC.6902L5", "sku do JSON");
});
Deno.test("qtd/preço vazios ⇒ dom_incompleto", () => {
  assertEquals(consolidarLinhasPortal(DOM_3091.map((l) => ({ ...l, preco_venda_raw: "" })), JSON_3091, ESP_3091, "ok").motivo, "dom_incompleto", "preço venda");
  assertEquals(consolidarLinhasPortal(DOM_3091.map((l) => ({ ...l, preco_un_raw: "" })), JSON_3091, ESP_3091, "ok").motivo, "dom_incompleto", "preço un");
  assertEquals(consolidarLinhasPortal(DOM_3091.map((l) => ({ ...l, qtd_un_raw: "0" })), JSON_3091, ESP_3091, "ok").motivo, "dom_incompleto", "qtd zero");
});
Deno.test("mesmo sku 2× no DOM ⇒ nunca escolhe uma", () => {
  assertEquals(consolidarLinhasPortal([...DOM_3091, DOM_3091[0]], JSON_3091, ESP_3091, "ok").fonte, "nenhuma", "DOM maior");
  assertEquals(consolidarLinhasPortal([DOM_3091[0], DOM_3091[0]], JSON_3091, ESP_3091, "ok").motivo, "sku_ambiguo", "mesmo tamanho");
});
Deno.test("JSON com sku duplicado ⇒ sku_ambiguo; item a mais/menos que o pedido ⇒ json_diverge_do_pedido", () => {
  const dup: AddJsonPortal = { itens: [JSON_3091.itens[0], JSON_3091.itens[0]], value: 1, ordernum: 1 };
  assertEquals(consolidarLinhasPortal(DOM_3091, dup, ESP_3091, "ok").motivo, "sku_ambiguo", "dup");
  assertEquals(consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091.slice(0, 1), "ok").motivo, "json_diverge_do_pedido", "pedido menor");
  assertEquals(consolidarLinhasPortal(DOM_3091, { ...JSON_3091, itens: JSON_3091.itens.slice(0, 1) }, ESP_3091, "ok").motivo, "json_diverge_do_pedido", "json menor");
});
Deno.test("sem JSON ⇒ sem_json; as linhas do DOM seguem (sku/prz) com mercadoria e IPI null", () => {
  const c = consolidarLinhasPortal(DOM_3091, null, ESP_3091, "ok");
  assertEquals(c.motivo, "sem_json", "marca do ramo");
  assertEquals(c.linhas.every((l) => l.total_linha === null && l.valor_ipi === null), true, "sem custo");
});
Deno.test("total do pedido inválido no JSON ⇒ total_json_invalido", () => {
  assertEquals(consolidarLinhasPortal(DOM_2459, { ...JSON_2459, value: null }, ESP_2459, "ok").motivo, "total_json_invalido", "null");
  assertEquals(consolidarLinhasPortal(DOM_2459, { ...JSON_2459, value: 0 }, ESP_2459, "ok").motivo, "total_json_invalido", "zero");
});

// ---------------------------------------------------------------- casar + derivar
Deno.test("fim a fim #3091: consolida → casa → deriva o payload da RPC (mercadoria + IPI + eco da qtde)", () => {
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091, "ok");
  const m = casarLinhasComItens(c.linhas, [
    item({ item_id: 101, sku_codigo_omie: "8689962883", sku_portal: "FC.6902L5", qtde_final: 2 }),
    item({ item_id: 102, sku_codigo_omie: "8689743214", sku_portal: "WJOI.7585GL", qtde_final: 1 }),
  ]);
  const { updates, pulados } = derivarCustos(m);
  assertEquals(pulados.length, 0, "0 pulados");
  assertEquals(JSON.stringify(updates.sort((a, b) => a.item_id - b.item_id)),
    '[{"item_id":101,"qtde_final":2,"valor_mercadoria":426.8652,"valor_ipi":27.75},{"item_id":102,"qtde_final":1,"valor_mercadoria":242.247,"valor_ipi":7.87}]',
    "o payload EXATO que a RPC recebe");
});
Deno.test("casar: mercadoria e IPI null/Infinity são TERMINAIS", () => {
  const m = casarLinhasComItens([{ sku_portal: "X", prz_ent_raw: "5", total_linha: Number.POSITIVE_INFINITY, valor_ipi: Number.NaN }], [item()]);
  assertEquals(m.casados[0].total_linha, null, "Infinity vira null");
  assertEquals(m.casados[0].valor_ipi, null, "NaN vira null");
});
Deno.test("derivarCustos: IPI ausente/negativo, mercadoria ou qtde inválida ⇒ pulado, nunca update", () => {
  const caso = (total_linha: number | null, valor_ipi: number | null, qtde = 1) =>
    derivarCustos({ casados: [{ item: item({ qtde_final: qtde }), prz_ent: 5, total_linha, valor_ipi }], naoCasados: [], ambiguos: [] });
  assertEquals(caso(100, null).pulados[0]?.motivo, "ipi_invalido", "IPI ausente");
  assertEquals(caso(100, -0.01).pulados[0]?.motivo, "ipi_invalido", "IPI negativo");
  assertEquals(caso(null, 1).pulados[0]?.motivo, "total_invalido", "mercadoria ausente");
  assertEquals(caso(0, 1).pulados[0]?.motivo, "total_invalido", "mercadoria zero");
  assertEquals(caso(100, 1, 0).pulados[0]?.motivo, "qtde_invalida", "qtde zero");
  assertEquals(caso(100, 0).updates.length, 1, "IPI 0 medido é update");
});

// ---------------------------------------------------------------- sensor
const prov = () => {
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091, "ok");
  const m = casarLinhasComItens(c.linhas, [item({ item_id: 101, sku_portal: "FC.6902L5", qtde_final: 2 }), item({ item_id: 102, sku_portal: "WJOI.7585GL" })]);
  return { c, m };
};
const resumo = (o: Partial<Parameters<typeof resumirCaptura>[0]>) => {
  const { c, m } = prov();
  return resumirCaptura({ cons: c, match: m, pulados: [], planejados: 2, atualizados: 2, jaTemOmie: false, nDom: 2, nJson: 2, nItens: 2, ...o });
};
Deno.test("resumirCaptura: pedido inteiro gravado ⇒ não cega, motivo null", () => {
  const r = resumo({});
  assertEquals(r.cego, false, "não cega");
  assertEquals(r.motivo, null, "motivo");
  assertEquals(r.ncm_sem_aliquota.length, 0, "nada a cadastrar");
});
Deno.test("resumirCaptura: ipi_ncm_desconhecido ⇒ cega, com a lista de NCMs no resumo", () => {
  const c = consolidarLinhasPortal(DOM_3091, JSON_3091, ESP_3091.map((e) => ({ ...e, aliquota_ipi_pct: null })), "ok");
  const r = resumo({ cons: c, planejados: 0, atualizados: 0 });
  assertEquals(r.cego, true, "cega");
  assertEquals(r.motivo, "ipi_ncm_desconhecido", "motivo");
  assertEquals(r.ncm_sem_aliquota.join(","), "3208.20.20,3208.90.39", "lista ordenada");
});
Deno.test("resumirCaptura: qualquer item pulado ⇒ cega (o pulo 'sem_mudanca' não existe mais)", () => {
  assertEquals(resumo({ pulados: [{ sku_codigo_omie: "1", motivo: "ipi_invalido" }], planejados: 0, atualizados: 0 }).cego, true, "cega");
});
Deno.test("resumirCaptura: item não casado ⇒ cega (parcial conta)", () => {
  const { c } = prov();
  const m = casarLinhasComItens(c.linhas, [item({ sku_portal: "FC.6902L5" }), item({ item_id: 9, sku_portal: null })]);
  assertEquals(resumo({ match: m, planejados: 1, atualizados: 1 }).cego, true, "cega");
});
Deno.test("resumirCaptura: escrita parcial ⇒ cega escrita_parcial", () => {
  const r = resumo({ planejados: 2, atualizados: 1 });
  assertEquals(r.cego, true, "cega");
  assertEquals(r.motivo, "escrita_parcial", "motivo");
});
Deno.test("resumirCaptura: recusas da RPC viram a MARCA do ramo; CP002 é idempotência (não cega)", () => {
  const casos: [MotivoRpcCusto, string | null, boolean][] = [
    ["itens_divergentes", "CP004", true], ["aliquota_ipi_ausente", "CP006", true], ["prova_ipi_divergente", "CP007", true],
    ["erro_rpc", null, true], ["po_omie_existente", "CP002", false],
  ];
  for (const [motivo, sqlstate, cego] of casos) {
    const r = resumo({ atualizados: 0, erroRpc: { motivo, sqlstate } });
    assertEquals(r.cego, cego, `cego (${motivo})`);
    assertEquals(r.motivo, motivo === "po_omie_existente" ? "ja_tem_omie" : motivo, `motivo (${motivo})`);
  }
});
Deno.test("resumirCaptura: já tem PO Omie ⇒ a captura não grava e não é cega", () => {
  const r = resumo({ jaTemOmie: true, planejados: 0, atualizados: 0 });
  assertEquals(r.cego, false, "não cega");
  assertEquals(r.motivo, "ja_tem_omie", "motivo");
});
Deno.test("classificarErroRpcCusto: CP001–CP004, CP006, CP007; o resto (inclusive o CP005 aposentado) é erro_rpc", () => {
  const mapa: [string | null | undefined, string][] = [
    ["CP001", "payload_invalido"], ["CP002", "po_omie_existente"], ["CP003", "pedido_nao_elegivel"], ["CP004", "itens_divergentes"],
    ["CP006", "aliquota_ipi_ausente"], ["CP007", "prova_ipi_divergente"], ["CP005", "erro_rpc"], ["42501", "erro_rpc"],
    ["cp006", "erro_rpc"], ["", "erro_rpc"], [null, "erro_rpc"], [undefined, "erro_rpc"],
  ];
  for (const [code, motivo] of mapa) assertEquals(classificarErroRpcCusto(code), motivo, String(code));
});

// ---------------------------------------------------------------- parsers
Deno.test("parseBRL: pt-BR (ponto milhar, vírgula decimal); lixo → null", () => {
  assertPerto(parseBRL("R$ 1.633,45"), 1633.45, "brl");
  assertEquals(parseBRL(""), null, "vazio");
  assertEquals(parseBRL("abc"), null, "lixo");
});
Deno.test("parseDiasPrzEnt: inteiro de dias do Prz Ent; vazio/lixo → null (alimenta o gate de grupo)", () => {
  assertEquals(parseDiasPrzEnt("5"), 5, "5");
  assertEquals(parseDiasPrzEnt(" 12 dias "), 12, "com texto");
  assertEquals(parseDiasPrzEnt(""), null, "vazio");
  assertEquals(parseDiasPrzEnt("n/a"), null, "lixo");
});
```

- [ ] **Step 2: rodar e ver falhar (a assinatura nova não existe)**

```bash
deno test --no-remote --allow-read=supabase/functions supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.test.ts > "$TMPDIR/d1.log" 2>&1; echo "rc=$?"; tail -c 600 "$TMPDIR/d1.log"
```
Expected: `rc≠0` com erro de tipo/import (`centavosDaMercadoria` inexistente).

- [ ] **Step 3: reescrever o bloco espelhado em `captura-custo.ts`**

Substituir o cabeçalho (l.9-28) por:

```ts
// Semântica provada em prod:
//   POST /order-creation/form/add → data.itens[{item, value}] + data.value (2026-09-05, #2443 ↔ portal 2126906).
//   `value` do ITEM = Preço UN de TABELA por embalagem (antes do desconto por embalagem e da taxa −2%) — nunca custo.
//   `data.value`   = total COBRADO pelo portal: Σ round2(Preço Venda) + Σ IPI por item (2026-10-05, backtest de 29
//                    pedidos, ≤ R$ 0,02 com 13 alíquotas por NCM — a "divergência aberta" do #2459 era o IPI:
//                    362,97 × 3,25% = 11,80 → 374,77).
//   `Preço Venda` da datatable = TOTAL DA LINHA, sem IPI (#2459: 142,2554 × 3 × (1 − 14,9488%) = 362,9698).
//
// Cadeia de prova (Codex 2026-09-05 + spec docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md):
//   pedido local ↔ JSON ↔ DOM são o MESMO conjunto de SKUs (sem extra, ausência ou duplicata);
//   Qtd UN lida no DOM == quantidade que a edge DIGITOU (prova da quantidade aceita);
//   Preço UN lido no DOM == `value` do JSON do mesmo SKU (prova de que a coluna é a que se pensa);
//   todo item tem alíquota de IPI conhecida (NCM do cadastro × ipi_aliquota_ncm; ausente ≠ zero);
//   1 e N itens ⇒ Σ round2(Preço Venda) + Σ IPI == data.value dentro da tolerância do arredondamento.
//   Qualquer elo faltando ⇒ total_linha = valor_ipi = null em TODAS (ausente ≠ zero).
```

E substituir TODO o conteúdo entre `// >>> ESPELHO(captura-custo) INICIO` e `// <<< ESPELHO(captura-custo) FIM` por:

```ts
// >>> ESPELHO(captura-custo) INICIO
export function parseBRL(s: string): number | null {
  if (typeof s !== 'string') return null;
  const limpo = s.replace(/[^\d,.-]/g, '').trim();
  if (!limpo) return null;
  const normal = limpo.replace(/\./g, '').replace(',', '.'); // pt-BR: ponto=milhar, vírgula=decimal
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

export function parseDiasPrzEnt(s: string): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) ? n : null;
}

/**
 * Linha consolidada. `total_linha` = valor da MERCADORIA (Preço Venda do DOM, sem IPI) e `valor_ipi` = IPI do item,
 * os dois só quando a cadeia de prova fechou; null é TERMINAL (nunca cai em parser de texto).
 */
export interface LinhaPortal { sku_portal: string; prz_ent_raw: string; total_linha: number | null; valor_ipi: number | null; }
export interface ItemPedido {
  item_id: number; sku_codigo_omie: string; sku_descricao: string | null;
  sku_portal: string | null; qtde_final: number;
}
interface Casado { item: ItemPedido; prz_ent: number | null; total_linha: number | null; valor_ipi: number | null; }
export interface ResultadoMatch { casados: Casado[]; naoCasados: ItemPedido[]; ambiguos: ItemPedido[]; }

function normPortal(s: string | null): string { return (s ?? '').trim().toUpperCase(); }
function finitoOuNull(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

export function casarLinhasComItens(linhas: LinhaPortal[], itens: ItemPedido[]): ResultadoMatch {
  const casados: Casado[] = [];
  const naoCasados: ItemPedido[] = [];
  const ambiguos: ItemPedido[] = [];

  const itensPorSku = new Map<string, ItemPedido[]>();
  for (const it of itens) {
    const k = normPortal(it.sku_portal);
    if (!k) { naoCasados.push(it); continue; }
    const arr = itensPorSku.get(k) ?? [];
    arr.push(it); itensPorSku.set(k, arr);
  }
  const linhasPorSku = new Map<string, LinhaPortal[]>();
  for (const ln of linhas) {
    const k = normPortal(ln.sku_portal);
    if (!k) continue;
    const arr = linhasPorSku.get(k) ?? [];
    arr.push(ln); linhasPorSku.set(k, arr);
  }
  for (const [k, its] of itensPorSku) {
    const lns = linhasPorSku.get(k) ?? [];
    if (its.length > 1 || lns.length > 1) { ambiguos.push(...its); continue; }
    if (lns.length === 0) { naoCasados.push(its[0]); continue; }
    casados.push({ item: its[0], prz_ent: parseDiasPrzEnt(lns[0].prz_ent_raw), total_linha: finitoOuNull(lns[0].total_linha), valor_ipi: finitoOuNull(lns[0].valor_ipi) });
  }
  return { casados, naoCasados, ambiguos };
}

/** O que vai à RPC por item: a mercadoria e o IPI PROVADOS + o eco da qtde_final. Os preços (÷ qtde) a RPC deriva. */
export interface CustoUpdate { item_id: number; qtde_final: number; valor_mercadoria: number; valor_ipi: number; }
/** @public — exportado pelo espelho (os testes o consomem). */
export function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

export function derivarCustos(res: ResultadoMatch): { updates: CustoUpdate[]; pulados: { sku_codigo_omie: string; motivo: string }[] } {
  const updates: CustoUpdate[] = [];
  const pulados: { sku_codigo_omie: string; motivo: string }[] = [];
  for (const c of res.casados) {
    const merc = c.total_linha; const ipi = c.valor_ipi; const qtde = c.item.qtde_final;
    if (merc == null || !Number.isFinite(merc) || !(merc > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'total_invalido' }); continue; }
    if (ipi == null || !Number.isFinite(ipi) || ipi < 0) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'ipi_invalido' }); continue; }
    if (!Number.isFinite(qtde) || !(qtde > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'qtde_invalida' }); continue; }
    // Todo item vai, sempre: a decomposição precisa nascer em cada um (o pulo 'sem_mudanca' saiu em 2026-10-05).
    // A RPC deriva os preços em numeric sobre a qtde_final da LINHA — e recusa se este eco divergir dela.
    updates.push({ item_id: c.item.item_id, qtde_final: qtde, valor_mercadoria: merc, valor_ipi: ipi });
  }
  return { updates, pulados };
}

// ---- Fontes: JSON do "Efetivar" (POST /order-creation/form/add) e DOM do #datatable_itens ----

/** Linha crua raspada do `#datatable_itens` (header-matching no browser; células pt-BR). */
export interface LinhaDom {
  sku_portal: string; prz_ent_raw: string;
  qtd_un_raw?: string; preco_venda_raw?: string; preco_un_raw?: string; desconto_raw?: string;
}
/** JSON do portal ao efetivar: `value` do item é preço de TABELA por embalagem; `value` do pedido é o total cobrado. */
export interface AddJsonPortal { itens: { item: string; value: number }[]; value: number | null; ordernum?: number | null; }
/**
 * O que a edge DIGITOU no portal para cada item (sku + quantidade em unidade do PORTAL, já com fator_conversao) e o
 * IPI do NCM do item, lido de `sayerlack_ipi_itens` (a mesma função com que a RPC confere). `aliquota_ipi_pct` null =
 * NCM ausente ou fora de `ipi_aliquota_ncm` — ausente ≠ zero, nunca vira 0%.
 */
export interface ItemEsperado { sku_portal: string; qtde_portal: number; ncm: string | null; aliquota_ipi_pct: number | null; }

/**
 * Extrai {itens, value, ordernum} do JSON parseado da resposta do form/add. AUTOCONTIDA (vai pro browser
 * via toString()). null quando não há `data.itens` válido — "salvo na sessão" (save-tab-preco-session)
 * e qualquer outro POST NÃO viram lista vazia disfarçada de captura.
 */
export function extrairAddJson(parsed: unknown): AddJsonPortal | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const data = (parsed as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const itensRaw = (data as { itens?: unknown }).itens;
  if (!Array.isArray(itensRaw) || itensRaw.length === 0) return null;
  // "153.203" / "1605.67" (JSON do portal) ou "1.605,67" (pt-BR): vírgula presente ⇒ ponto é milhar.
  const num = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || v.trim() === '') return null;
    const s = v.trim();
    const n = Number(s.indexOf(',') !== -1 ? s.replace(/\./g, '').replace(',', '.') : s);
    return Number.isFinite(n) ? n : null;
  };
  const itens: { item: string; value: number }[] = [];
  for (const it of itensRaw) {
    if (!it || typeof it !== 'object') return null;
    const item = String((it as { item?: unknown }).item ?? '').trim().toUpperCase();
    const value = num((it as { value?: unknown }).value);
    if (!item || value == null) return null;
    itens.push({ item, value });
  }
  const value = num((data as { value?: unknown }).value);
  const ordRaw = (data as { ordernum?: unknown }).ordernum;
  const ordernum = typeof ordRaw === 'number' && Number.isFinite(ordRaw) ? ordRaw : (typeof ordRaw === 'string' && /^\d+$/.test(ordRaw) ? Number(ordRaw) : null);
  return { itens, value, ordernum };
}

type FonteCaptura = 'dom_checksum' | 'nenhuma';
type MotivoCaptura =
  | 'sem_json' | 'total_json_invalido' | 'sku_ambiguo' | 'json_diverge_do_pedido'
  | 'dom_incompleto' | 'qtd_diverge' | 'preco_un_diverge'
  | 'ipi_leitura_falhou' | 'ipi_ncm_desconhecido' | 'checksum_divergente';
export interface Consolidacao {
  linhas: LinhaPortal[];
  fonte: FonteCaptura;
  motivo: MotivoCaptura | null;
  /** Total cobrado pelo portal PROVADO (= data.value) — só quando fonte ≠ 'nenhuma'. */
  total_pedido: number | null;
  /** NCMs dos itens sem alíquota (motivo 'ipi_ncm_desconhecido'): o que falta cadastrar em `ipi_aliquota_ncm`. */
  ncm_sem_aliquota: string[];
  checksum: {
    soma_dom: number | null; ipi_modelado: number | null; total_modelado: number | null;
    total_json: number | null; delta_abs: number | null; delta_rel: number | null; tolerancia_abs: number | null;
  };
}

/**
 * Centavos INTEIROS de um valor exibido com até 4 casas (o Preço Venda do portal), meio centavo para cima — o mesmo
 * que `round(numeric, 2)` do Postgres para valor positivo. null = não é valor de mercadoria (≤ 0, NaN, Infinity).
 */
export function centavosDaMercadoria(v: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) return null;
  const dezMilesimos = Math.round(v * 10000); // o DOM exibe 4 casas: v·10⁴ é inteiro a menos de ruído binário
  return Number.isSafeInteger(dezMilesimos) ? Math.floor((dezMilesimos + 50) / 100) : null;
}
/** Alíquota (%) em centésimos de ponto (3,25 → 325). null fora de [0, 100) ou com mais de 2 casas (a tabela proíbe). */
export function centesimosDaAliquota(pct: number | null): number | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct >= 100) return null;
  const c = Math.round(pct * 100);
  return Math.abs(pct * 100 - c) < 1e-6 ? c : null;
}
/**
 * IPI do item em centavos = round(linha × alíquota ÷ 100), meio centavo para cima, só em INTEIROS. Em ponto
 * flutuante, `round2(round2(pv) × alíq)` erra 1 centavo na fronteira de meio centavo (R$ 65,00 × 6,5% = 4,225 dá 4,22;
 * o Postgres dá 4,23 — 76 fronteiras entre R$ 0,01 e R$ 2.000 nas 3 alíquotas medidas), e a RPC, que recalcula em
 * numeric e exige igualdade, recusaria o pedido.
 */
export function ipiCentavos(linhaCentavos: number, aliquotaCentesimos: number): number {
  return Math.floor((linhaCentavos * aliquotaCentesimos + 5000) / 10000);
}
/**
 * Tolerância da prova `Σ round2(PV) + Σ IPI` × `data.value`: meio centavo do total (2 casas) mais, POR LINHA, o
 * arredondamento da linha a centavos (0,005), o do IPI do item (0,005) e o da exibição do Preço Venda em 4 casas
 * (0,00005 × (1 + alíquota), com folga até 100%). Depende do NÚMERO DE LINHAS, não das quantidades (Preço Venda já é
 * o total da linha). Medido no backtest de 29 pedidos (2026-10-05): pior delta R$ 0,02, com até 18 linhas.
 */
export function toleranciaChecksum(nLinhas: number): number {
  return 0.005 + nLinhas * 0.0101;
}
/** Preço UN do DOM (4 casas) vs `value` do JSON (até 4 casas). */
const TOL_PRECO_UN = 0.0001;

/**
 * Consolida DOM + JSON + o que a edge digitou + o IPI de cada item numa lista de LinhaPortal com mercadoria e IPI só
 * quando PROVADOS. Precisão > recall: qualquer elo faltando ⇒ 'nenhuma' + motivo, linhas sem custo (sku/prz seguem
 * úteis ao diagnóstico), e NENHUM item recebe custo — nunca mistura custo novo com custo antigo no mesmo pedido.
 */
export function consolidarLinhasPortal(dom: LinhaDom[], json: AddJsonPortal | null, esperados: ItemEsperado[], leituraIpi: 'ok' | 'falhou'): Consolidacao {
  const semChecksum: Consolidacao['checksum'] = {
    soma_dom: null, ipi_modelado: null, total_modelado: null, total_json: json?.value ?? null, delta_abs: null, delta_rel: null, tolerancia_abs: null,
  };
  const linhaSemCusto = (sku: string, prz: string): LinhaPortal => ({ sku_portal: sku, prz_ent_raw: prz, total_linha: null, valor_ipi: null });
  const domPorSku = new Map<string, LinhaDom[]>();
  for (const d of dom) {
    const k = normPortal(d.sku_portal);
    if (!k) continue;
    const arr = domPorSku.get(k) ?? [];
    arr.push(d); domPorSku.set(k, arr);
  }
  const przDe = (sku: string): string => {
    const ds = domPorSku.get(sku) ?? [];
    if (ds.length === 1) return ds[0].prz_ent_raw ?? '';
    if (ds.length === 0 && dom.length === 1 && esperados.length === 1) return dom[0].prz_ent_raw ?? ''; // única linha, sku não lido
    return '';
  };

  if (!json || json.itens.length === 0) {
    return { linhas: dom.map((d) => linhaSemCusto(normPortal(d.sku_portal), d.prz_ent_raw ?? '')), fonte: 'nenhuma', motivo: 'sem_json', total_pedido: null, ncm_sem_aliquota: [], checksum: semChecksum };
  }
  const skusJson = json.itens.map((i) => normPortal(i.item));
  const linhasSemCusto = skusJson.map((s) => linhaSemCusto(s, przDe(s)));
  const falha = (motivo: MotivoCaptura, checksum = semChecksum, ncmSemAliquota: string[] = []): Consolidacao =>
    ({ linhas: linhasSemCusto, fonte: 'nenhuma', motivo, total_pedido: null, ncm_sem_aliquota: ncmSemAliquota, checksum });

  // (1) JSON é um CONJUNTO (sem duplicata) e igual ao conjunto do pedido local.
  if (new Set(skusJson).size !== skusJson.length) return falha('sku_ambiguo');
  const skusEsperados = esperados.map((e) => normPortal(e.sku_portal));
  if (new Set(skusEsperados).size !== skusEsperados.length || skusEsperados.some((s) => !s)) return falha('json_diverge_do_pedido');
  if (skusEsperados.length !== skusJson.length || skusEsperados.some((s) => skusJson.indexOf(s) === -1)) return falha('json_diverge_do_pedido');
  if (json.value == null || !Number.isFinite(json.value) || !(json.value > 0)) return falha('total_json_invalido');

  // (2) DOM cobre cada SKU exatamente 1× e prova quantidade (== digitada) e coluna de preço (Preço UN == value).
  // Com 1 item o DOM pode não ter lido o sku (defeito histórico): a única linha gravada vale como a dele.
  const qtdPorSku = new Map<string, number>(esperados.map((e) => [normPortal(e.sku_portal), e.qtde_portal]));
  const valuePorSku = new Map<string, number>(json.itens.map((i) => [normPortal(i.item), i.value]));
  if (dom.length !== skusJson.length) return falha('dom_incompleto');
  const linhaDe = (sku: string): LinhaDom | null => {
    const ds = domPorSku.get(sku) ?? [];
    if (ds.length === 1) return ds[0];
    if (ds.length === 0 && skusJson.length === 1 && normPortal(dom[0].sku_portal) === '') return dom[0];
    return null;
  };
  const provadas: { sku: string; qtd: number; precoVenda: number | null }[] = [];
  for (const sku of skusJson) {
    const ds = domPorSku.get(sku) ?? [];
    if (ds.length > 1) return falha('sku_ambiguo');
    const d = linhaDe(sku);
    if (!d) return falha('dom_incompleto');
    const qtd = parseBRL(d.qtd_un_raw ?? '');
    if (qtd == null || !(qtd > 0)) return falha('dom_incompleto');
    const qtdEsperada = qtdPorSku.get(sku);
    if (qtdEsperada == null || !Number.isFinite(qtdEsperada) || Math.abs(qtd - qtdEsperada) > 1e-6) return falha('qtd_diverge');
    const precoUn = parseBRL(d.preco_un_raw ?? '');
    if (precoUn == null) return falha('dom_incompleto');
    if (Math.abs(precoUn - (valuePorSku.get(sku) ?? NaN)) > TOL_PRECO_UN) return falha('preco_un_diverge');
    provadas.push({ sku, qtd, precoVenda: parseBRL(d.preco_venda_raw ?? '') });
  }

  // (3) IPI: a alíquota de cada item, do NCM do cadastro. Ausente ≠ zero — sem alíquota não existe custo provado.
  if (leituraIpi !== 'ok') return falha('ipi_leitura_falhou');
  const aliqPorSku = new Map<string, number | null>(esperados.map((e) => [normPortal(e.sku_portal), centesimosDaAliquota(e.aliquota_ipi_pct)]));
  const semAliquota = esperados.filter((e) => aliqPorSku.get(normPortal(e.sku_portal)) == null);
  if (semAliquota.length > 0) {
    return falha('ipi_ncm_desconhecido', semChecksum, [...new Set(semAliquota.map((e) => e.ncm ?? '(sem NCM)'))].sort());
  }

  // (4) Prova — para 1 e N itens: Σ round2(Preço Venda) + Σ IPI fecha com o total cobrado dentro da tolerância do
  // arredondamento. Preço Venda JÁ É o total da linha (sem IPI); o IPI é o que o portal soma por cima.
  const calc: { pv: number; linha: number; ipi: number }[] = [];
  for (const p of provadas) {
    const linha = p.precoVenda == null ? null : centavosDaMercadoria(p.precoVenda);
    if (linha == null) return falha('dom_incompleto');
    calc.push({ pv: p.precoVenda as number, linha, ipi: ipiCentavos(linha, aliqPorSku.get(p.sku) as number) });
  }
  const modelado = calc.reduce((s, l) => s + l.linha + l.ipi, 0);
  const deltaAbs = Math.abs(modelado - Math.round(json.value * 100)) / 100;
  const tolerancia = toleranciaChecksum(calc.length);
  const checksum: Consolidacao['checksum'] = {
    soma_dom: calc.reduce((s, l) => s + l.pv, 0),
    ipi_modelado: calc.reduce((s, l) => s + l.ipi, 0) / 100,
    total_modelado: modelado / 100,
    total_json: json.value, delta_abs: deltaAbs, delta_rel: deltaAbs / json.value, tolerancia_abs: tolerancia,
  };
  if (deltaAbs > tolerancia) return falha('checksum_divergente', checksum);
  return {
    linhas: skusJson.map((s, i) => ({ sku_portal: s, prz_ent_raw: przDe(s), total_linha: calc[i].pv, valor_ipi: calc[i].ipi / 100 })),
    fonte: 'dom_checksum', motivo: null, total_pedido: json.value, ncm_sem_aliquota: [], checksum,
  };
}

// ---- Sensor: captura com sucesso no portal e algum item SEM custo provado é sinal, não silêncio ----

// ---------------------------------------------------------------- RPC de escrita (tudo-ou-nada)
/**
 * A escrita do custo é UMA RPC transacional (`sayerlack_aplicar_custo_portal`, v3 em 20261006120000): CAS no banco,
 * o pedido INTEIRO no payload, IPI conferido contra `ipi_aliquota_ncm`, prova contra o total cobrado. Ela RECUSA com
 * SQLSTATE própria (classe CP) e faz ROLLBACK de tudo — a edge casa a MARCA do ramo, nunca "lançou algo". Código
 * desconhecido/ausente (inclusive o CP005, aposentado na v3) é `erro_rpc` (transiente, cega), nunca motivo fabricado.
 */
export type MotivoRpcCusto =
  | 'payload_invalido' | 'po_omie_existente' | 'pedido_nao_elegivel' | 'itens_divergentes'
  | 'aliquota_ipi_ausente' | 'prova_ipi_divergente' | 'erro_rpc';
const SQLSTATE_CUSTO_PORTAL: Readonly<Record<string, Exclude<MotivoRpcCusto, 'erro_rpc'>>> = {
  CP001: 'payload_invalido',
  CP002: 'po_omie_existente',
  CP003: 'pedido_nao_elegivel',
  CP004: 'itens_divergentes',
  CP006: 'aliquota_ipi_ausente',
  CP007: 'prova_ipi_divergente',
};
export function classificarErroRpcCusto(code: string | null | undefined): MotivoRpcCusto {
  if (typeof code !== 'string') return 'erro_rpc';
  return SQLSTATE_CUSTO_PORTAL[code] ?? 'erro_rpc';
}

export interface ResumoCaptura {
  fonte: FonteCaptura; motivo: MotivoCaptura | 'ja_tem_omie' | 'escrita_parcial' | MotivoRpcCusto | null;
  /** SQLSTATE devolvida pela RPC de escrita quando ela recusou (auditoria; null = não chamada ou ok). */
  sqlstate_rpc: string | null;
  checksum: Consolidacao['checksum'];
  /** NCMs sem alíquota em `ipi_aliquota_ncm` — a lista acionável do motivo 'ipi_ncm_desconhecido'. */
  ncm_sem_aliquota: string[];
  n_dom: number; n_json: number; n_itens: number;
  casados: number; nao_casados: number; ambiguos: number;
  planejados: number; atualizados: number; pulados: { sku_codigo_omie: string; motivo: string }[];
  /** true = envio bem-sucedido em que ≥1 item ficou sem custo provado/persistido (fora PO Omie já existente). */
  cego: boolean;
}

export function resumirCaptura(p: {
  cons: Consolidacao; match: ResultadoMatch | null; pulados: { sku_codigo_omie: string; motivo: string }[];
  planejados: number; atualizados: number; jaTemOmie: boolean; nDom: number; nJson: number; nItens: number;
  /** Recusa da RPC de escrita (classificada por SQLSTATE) — null quando não foi chamada ou gravou tudo. */
  erroRpc?: { motivo: MotivoRpcCusto; sqlstate: string | null } | null;
}): ResumoCaptura {
  const casados = p.match?.casados.length ?? 0;
  const naoCasados = p.match?.naoCasados.length ?? 0;
  const ambiguos = p.match?.ambiguos.length ?? 0;
  const erroRpc = p.erroRpc ?? null;
  // CP002 = o PO Omie passou a existir entre a leitura em memória e a escrita: a RPC recusou e NADA foi
  // gravado — é a mesma idempotência de `jaTemOmie`, só que provada no banco (não é cegueira).
  const omieNoBanco = erroRpc?.motivo === 'po_omie_existente';
  const escritaParcial = p.atualizados !== p.planejados;
  // Cega = algum item do pedido ficou SEM custo provado/persistido: fonte não provou, não casou, ficou ambíguo, foi
  // pulado (qualquer motivo), casou menos itens do que o pedido tem, a RPC recusou (≠ CP002) ou a escrita ficou
  // parcial. Com PO Omie já existente (memória OU banco) a captura não grava (idempotência, não silêncio).
  const cego = !p.jaTemOmie && !omieNoBanco && (
    p.cons.fonte === 'nenhuma' || naoCasados > 0 || ambiguos > 0 || p.pulados.length > 0 || erroRpc != null || escritaParcial || casados !== p.nItens
  );
  const motivo: ResumoCaptura['motivo'] = p.jaTemOmie || omieNoBanco ? 'ja_tem_omie'
    : erroRpc ? erroRpc.motivo
    : (escritaParcial ? 'escrita_parcial' : p.cons.motivo);
  return {
    fonte: p.cons.fonte, motivo, sqlstate_rpc: erroRpc?.sqlstate ?? null, checksum: p.cons.checksum,
    ncm_sem_aliquota: p.cons.ncm_sem_aliquota,
    n_dom: p.nDom, n_json: p.nJson, n_itens: p.nItens, casados, nao_casados: naoCasados, ambiguos,
    planejados: p.planejados, atualizados: p.atualizados, pulados: p.pulados, cego,
  };
}
// <<< ESPELHO(captura-custo) FIM
```

- [ ] **Step 4: copiar o bloco para o espelho de `src/`**

```bash
bun -e '
const fs = require("node:fs");
const I = "// >>> ESPELHO(captura-custo) INICIO", F = "// <<< ESPELHO(captura-custo) FIM";
const deno = fs.readFileSync("supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.ts", "utf8");
const bloco = deno.slice(deno.indexOf(I), deno.indexOf(F) + F.length);
const alvo = "src/lib/reposicao/sayerlack-scraping-pedido.ts";
const src = fs.readFileSync(alvo, "utf8");
fs.writeFileSync(alvo, src.slice(0, src.indexOf(I)) + bloco + src.slice(src.indexOf(F) + F.length));
console.log("bloco copiado:", bloco.length, "bytes");'
```
Expected: `bloco copiado: <n> bytes` (n > 5000).

- [ ] **Step 5: Deno verde**

```bash
deno test --no-remote --allow-read=supabase/functions supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.test.ts > "$TMPDIR/d2.log" 2>&1; echo "rc=$?"; grep -E "^ok |FAILED|passed|failed" "$TMPDIR/d2.log" | tail -3
```
Expected: `rc=0`, `ok | <n> passed | 0 failed`.

- [ ] **Step 6: reescrever o teste do espelho (src)**

Substituir `src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts` inteiro por:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseBRL, parseDiasPrzEnt, casarLinhasComItens, validarGrupoLeadtime, derivarCustos,
  consolidarLinhasPortal, extrairAddJson, resumirCaptura, round2, toleranciaChecksum, classificarErroRpcCusto,
  centavosDaMercadoria, centesimosDaAliquota, ipiCentavos,
  type ItemPedido, type LinhaPortal, type LinhaDom, type AddJsonPortal, type ItemEsperado,
} from '../sayerlack-scraping-pedido';

const item = (o: Partial<ItemPedido> = {}): ItemPedido => ({
  item_id: 1, sku_codigo_omie: 'OMIE1', sku_descricao: 'd', sku_portal: 'P1', qtde_final: 2, ...o,
});
const linha = (o: Partial<LinhaPortal> = {}): LinhaPortal => ({ sku_portal: 'P1', prz_ent_raw: '8', total_linha: 20, valor_ipi: 0.65, ...o });

// ---------------------------------------------------------------------------------------------
// ESPELHO: a semântica mora no Deno (supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.ts,
// deno test). Este arquivo prova (1) que o bloco espelhado é IDÊNTICO byte a byte, (2) que os call-sites das
// edges consomem o helper (igualdade textual não prova consumo — Codex P2, money-path.md) e (3) a paridade
// com o arquivo-ouro dos 29 pedidos reais, que a prova PG17 (db/test-sayerlack-ipi-po.sh) também confere.
// ---------------------------------------------------------------------------------------------
const RAIZ = resolve(__dirname, '../../../..');
const EDGE_DIR = 'supabase/functions/enviar-pedido-portal-sayerlack';
const ler = (p: string) => readFileSync(resolve(RAIZ, p), 'utf8');
const INICIO = '// >>> ESPELHO(captura-custo) INICIO';
const FIM = '// <<< ESPELHO(captura-custo) FIM';
function bloco(fonte: string, nome: string): string {
  const a = fonte.indexOf(INICIO);
  const b = fonte.indexOf(FIM);
  if (a === -1 || b === -1 || b < a) throw new Error(`${nome}: marcadores do espelho ausentes/invertidos`);
  return fonte.slice(a, b + FIM.length);
}

describe('classificarErroRpcCusto (espelho src): casa a MARCA da SQLSTATE, nunca "lançou algo"', () => {
  it('CP001–CP004, CP006 e CP007 viram o motivo do ramo; o resto (inclusive o CP005 aposentado) vira erro_rpc', () => {
    expect(classificarErroRpcCusto('CP001')).toBe('payload_invalido');
    expect(classificarErroRpcCusto('CP002')).toBe('po_omie_existente');
    expect(classificarErroRpcCusto('CP003')).toBe('pedido_nao_elegivel');
    expect(classificarErroRpcCusto('CP004')).toBe('itens_divergentes');
    expect(classificarErroRpcCusto('CP006')).toBe('aliquota_ipi_ausente');
    expect(classificarErroRpcCusto('CP007')).toBe('prova_ipi_divergente');
    expect(classificarErroRpcCusto('CP005')).toBe('erro_rpc');
    expect(classificarErroRpcCusto('42501')).toBe('erro_rpc');
    expect(classificarErroRpcCusto('cp002')).toBe('erro_rpc');
    expect(classificarErroRpcCusto(undefined)).toBe('erro_rpc');
    expect(classificarErroRpcCusto(null)).toBe('erro_rpc');
  });
});

describe('espelho Deno ↔ src (captura de custo)', () => {
  it('sentinela: o bloco existe nos DOIS arquivos e tem corpo (não é comparação de vazio com vazio)', () => {
    const deno = bloco(ler(`${EDGE_DIR}/captura-custo.ts`), 'deno');
    const src = bloco(ler('src/lib/reposicao/sayerlack-scraping-pedido.ts'), 'src');
    expect(deno.length).toBeGreaterThan(5_000);
    expect(deno).toContain('export function consolidarLinhasPortal(');
    expect(src).toContain('export function consolidarLinhasPortal(');
  });
  it('o bloco espelhado é IDÊNTICO byte a byte (edite no Deno e copie pra cá)', () => {
    const deno = bloco(ler(`${EDGE_DIR}/captura-custo.ts`), 'deno');
    const src = bloco(ler('src/lib/reposicao/sayerlack-scraping-pedido.ts'), 'src');
    expect(src).toBe(deno);
  });
  it('call-site da edge: lê as alíquotas pela função do banco, consolida com o IPI e interpola extrairAddJson no browser', () => {
    const edge = ler(`${EDGE_DIR}/index.ts`);
    expect(edge).toContain('from "./captura-custo.ts"');
    expect(edge).toContain('const extrairAddJson = ${extrairAddJson.toString()};');
    expect(edge).toMatch(/portalAddJson = extrairAddJson\(r\.parsed\)/);
    expect(edge).toMatch(/supabase\.rpc\("sayerlack_ipi_itens", \{ p_pedido_id: pedido\.id \}\)/);
    expect(edge).toMatch(/consolidarLinhasPortal\(capturados, addJson, esperados, eIpi \|\| !Array\.isArray\(ipiRows\) \? 'falhou' : 'ok'\)/);
    expect(edge).toMatch(/casarLinhasComItens\(cons\.linhas, itensParaCusto\)/);
    expect(edge).toContain("'[SENSOR_CAPTURA_CUSTO_CEGA]'");
    expect(edge).toContain('captura_custo: resumo');
    // O defeito histórico: "total" = última célula (coluna de ações). Não pode voltar.
    expect(edge).not.toContain('texts[texts.length - 1]');
    // O pulo 'sem_mudanca' e a leitura de preco_atual que o alimentava saíram: todo item é gravado.
    expect(edge).not.toContain('preco_atual');
    expect(edge).toMatch(/if \(pedidoInteiroProvado\) \{/);
    expect(edge).toMatch(/p_valor_total: cons\.total_pedido/);
  });
  it('call-site da edge: a escrita do custo é UMA RPC transacional (CAS + pedido inteiro + IPI conferido), não update item a item', () => {
    const edge = ler(`${EDGE_DIR}/index.ts`);
    expect(edge).toMatch(/supabase\.rpc\("sayerlack_aplicar_custo_portal", \{\s*p_pedido_id: pedido\.id,\s*p_itens: derivado\.updates,\s*p_valor_total: cons\.total_pedido,/);
    expect(edge).toMatch(/classificarErroRpcCusto\(eRpc\.code\)/);
    expect(edge).toMatch(/resumirCaptura\(\{[^}]*erroRpc/);
    expect(edge).not.toMatch(/\.update\(\{ preco_unitario: u\.preco_unitario/);
    expect(edge).not.toMatch(/\.update\(\{ valor_total: cons\.total_pedido \}\)/);
    expect(edge).toMatch(/cons\.total_pedido != null && match\.naoCasados\.length === 0/);
    expect(edge).toMatch(/&& pulados\.length === 0;/);
  });
  it('call-site do disparo: o item do PO sai de montarProdutoIncluir, lendo a decomposição sem quebrar sem a migration', () => {
    const disparo = ler('supabase/functions/disparar-pedidos-aprovados/index.ts');
    expect(disparo).toContain('from "./produto-po.ts"');
    expect(disparo).toMatch(/\.map\(\(it, idx\) => montarProdutoIncluir\(it, idx\)\)/);
    expect(disparo).not.toMatch(/nValUnit: Number\(it\.preco_unitario\)/);
  });
  it('bloco espelhado NÃO tem crase nem ${ dentro de extrairAddJson (vai pro Browserless por toString)', () => {
    const deno = ler(`${EDGE_DIR}/captura-custo.ts`);
    const a = deno.indexOf('export function extrairAddJson(');
    const b = deno.indexOf('\n}\n', a);
    const corpo = deno.slice(a, b);
    expect(corpo.length).toBeGreaterThan(500);
    expect(corpo).not.toContain('`');
    expect(corpo).not.toContain('${');
  });
});

describe('parseBRL', () => {
  it('parseia formato pt-BR (ponto=milhar, vírgula=decimal)', () => {
    expect(parseBRL('R$ 1.633,45')).toBe(1633.45);
    expect(parseBRL('20,00')).toBe(20);
    expect(parseBRL('1.000')).toBe(1000);
  });
  it('retorna null pra lixo', () => {
    expect(parseBRL('')).toBeNull();
    expect(parseBRL('abc')).toBeNull();
    expect(parseBRL(null as unknown as string)).toBeNull();
  });
});

describe('parseDiasPrzEnt', () => {
  it('extrai o inteiro de dias', () => {
    expect(parseDiasPrzEnt('8')).toBe(8);
    expect(parseDiasPrzEnt('8 dias')).toBe(8);
    expect(parseDiasPrzEnt(' 12 ')).toBe(12);
  });
  it('retorna null pra vazio/sem número', () => {
    expect(parseDiasPrzEnt('')).toBeNull();
    expect(parseDiasPrzEnt('n/a')).toBeNull();
  });
});

describe('casarLinhasComItens', () => {
  it('casa por sku_portal e parseia prz; mercadoria e IPI numéricos passam, null/NaN são terminais', () => {
    const r = casarLinhasComItens([linha()], [item()]);
    expect(r.casados).toHaveLength(1);
    expect(r.casados[0]).toMatchObject({ prz_ent: 8, total_linha: 20, valor_ipi: 0.65 });
    expect(casarLinhasComItens([linha({ total_linha: null })], [item()]).casados[0].total_linha).toBeNull();
    expect(casarLinhasComItens([linha({ valor_ipi: Number.NaN })], [item()]).casados[0].valor_ipi).toBeNull();
  });
  it('item sem linha no portal vira naoCasado', () => {
    const r = casarLinhasComItens([], [item()]);
    expect(r.naoCasados).toHaveLength(1);
    expect(r.casados).toHaveLength(0);
  });
  it('sku_portal em 2 itens vira ambíguo (de-para não é único por sku_portal)', () => {
    const r = casarLinhasComItens([linha()], [item(), item({ item_id: 2, sku_codigo_omie: 'OMIE2' })]);
    expect(r.ambiguos).toHaveLength(2);
    expect(r.casados).toHaveLength(0);
  });
  it('sku_portal em 2 linhas vira ambíguo', () => {
    expect(casarLinhasComItens([linha(), linha()], [item()]).ambiguos).toHaveLength(1);
  });
  it('item com sku_portal nulo vira naoCasado', () => {
    expect(casarLinhasComItens([linha()], [item({ sku_portal: null })]).naoCasados).toHaveLength(1);
  });
});

describe('validarGrupoLeadtime', () => {
  const match = (przs: (number | null)[]) => ({
    casados: przs.map((p, i) => ({ item: item({ item_id: i, sku_codigo_omie: `O${i}` }), prz_ent: p, total_linha: null, valor_ipi: null })),
    naoCasados: [], ambiguos: [],
  });
  it('ok quando todos os prz batem o esperado', () => {
    const r = validarGrupoLeadtime(match([8, 8]), 8);
    expect(r.status).toBe('ok');
    expect(r.mismatches).toHaveLength(0);
  });
  it('mismatch quando ≥1 prz difere', () => {
    const r = validarGrupoLeadtime(match([8, 15]), 8);
    expect(r.status).toBe('mismatch');
    expect(r.mismatches).toEqual([{ sku_codigo_omie: 'O1', prz_ent: 15, lt_esperado: 8 }]);
  });
  it('indisponivel quando ltEsperado é null (sem config de grupo)', () => {
    expect(validarGrupoLeadtime(match([8]), null).status).toBe('indisponivel');
  });
  it('indisponivel quando nada parseável (prz null)', () => {
    expect(validarGrupoLeadtime(match([null]), 8).status).toBe('indisponivel');
  });
  it('prz null não conta como mismatch — só pulado', () => {
    const r = validarGrupoLeadtime(match([8, null]), 8);
    expect(r.status).toBe('ok');
    expect(r.pulados).toEqual(['O1']);
  });
});

describe('derivarCustos', () => {
  const matchCusto = (o: { qtde: number; total: number | null; ipi: number | null }) => ({
    casados: [{ item: item({ item_id: 7, qtde_final: o.qtde }), prz_ent: 8, total_linha: o.total, valor_ipi: o.ipi }],
    naoCasados: [], ambiguos: [],
  });
  it('transporta mercadoria + IPI + o eco da qtde (os preços a RPC deriva)', () => {
    const r = derivarCustos(matchCusto({ qtde: 2, total: 426.8652, ipi: 27.75 }));
    expect(r.updates).toEqual([{ item_id: 7, qtde_final: 2, valor_mercadoria: 426.8652, valor_ipi: 27.75 }]);
  });
  it('todo item vira update, mesmo com o preço já igual (o pulo sem_mudanca saiu)', () => {
    expect(derivarCustos(matchCusto({ qtde: 1, total: 10, ipi: 0 })).updates).toHaveLength(1);
  });
  it('IPI ausente/negativo, mercadoria ou qtde inválida ⇒ pulado, sem fabricar custo', () => {
    expect(derivarCustos(matchCusto({ qtde: 1, total: 10, ipi: null })).pulados[0]).toMatchObject({ motivo: 'ipi_invalido' });
    expect(derivarCustos(matchCusto({ qtde: 1, total: 10, ipi: -1 })).pulados[0]).toMatchObject({ motivo: 'ipi_invalido' });
    expect(derivarCustos(matchCusto({ qtde: 1, total: Number.POSITIVE_INFINITY, ipi: 1 })).pulados[0]).toMatchObject({ motivo: 'total_invalido' });
    expect(derivarCustos(matchCusto({ qtde: 0, total: 10, ipi: 1 })).pulados[0]).toMatchObject({ motivo: 'qtde_invalida' });
  });
});

// Cobertura fina de consolidar/extrair/resumir vive no deno test (captura-custo.test.ts). Aqui o contrato que a
// src consome e a paridade com o arquivo-ouro.
describe('consolidarLinhasPortal (contrato espelhado)', () => {
  const dom = (o: Partial<LinhaDom> = {}): LinhaDom => ({ sku_portal: 'A', prz_ent_raw: '5', qtd_un_raw: '2', preco_venda_raw: '20,0000', preco_un_raw: '12,0000', ...o });
  const json: AddJsonPortal = { itens: [{ item: 'A', value: 12 }, { item: 'B', value: 30 }], value: 80.65, ordernum: 1 };
  const esp: ItemEsperado[] = [
    { sku_portal: 'A', qtde_portal: 2, ncm: '3208.10.20', aliquota_ipi_pct: 3.25 },
    { sku_portal: 'B', qtde_portal: 3, ncm: '3214.90.00', aliquota_ipi_pct: 0 },
  ];
  const domN = [dom(), dom({ sku_portal: 'B', qtd_un_raw: '3', preco_venda_raw: '60,0000', preco_un_raw: '30,0000' })];
  it('N itens com DOM provado e IPI (20 × 3,25% = 0,65; 60 × 0%) ⇒ dom_checksum', () => {
    const c = consolidarLinhasPortal(domN, json, esp, 'ok');
    expect(c.fonte).toBe('dom_checksum');
    expect(c.linhas.map((l) => [l.total_linha, l.valor_ipi])).toEqual([[20, 0.65], [60, 0]]);
    expect(c.checksum.total_modelado).toBe(80.65);
  });
  it('a soma SEM o IPI não fecha: o portal cobra a linha mais o IPI', () => {
    expect(consolidarLinhasPortal(domN, { ...json, value: 80 }, esp, 'ok').motivo).toBe('checksum_divergente');
  });
  it('NCM sem alíquota ⇒ nenhuma/ipi_ncm_desconhecido e a lista do que cadastrar', () => {
    const c = consolidarLinhasPortal(domN, json, [esp[0], { ...esp[1], aliquota_ipi_pct: null }], 'ok');
    expect(c).toMatchObject({ fonte: 'nenhuma', motivo: 'ipi_ncm_desconhecido', ncm_sem_aliquota: ['3214.90.00'] });
  });
  it('defeito de prod (DOM cego, N itens) ⇒ nenhuma/dom_incompleto e zero custo', () => {
    const c = consolidarLinhasPortal([dom({ sku_portal: '' }), dom({ sku_portal: '' })], json, esp, 'ok');
    expect(c).toMatchObject({ fonte: 'nenhuma', motivo: 'dom_incompleto' });
    expect(c.linhas.every((l) => l.total_linha === null && l.valor_ipi === null)).toBe(true);
  });
  it('extrairAddJson devolve null fora do form/add; resumirCaptura marca cega quando a fonte não provou', () => {
    expect(extrairAddJson({ success: true, message: 'Itens salvos na sessão com sucesso.' })).toBeNull();
    const c = consolidarLinhasPortal([], null, esp, 'ok');
    const r = resumirCaptura({ cons: c, match: null, pulados: [], planejados: 0, atualizados: 0, jaTemOmie: false, nDom: 0, nJson: 0, nItens: 2 });
    expect(r).toMatchObject({ cego: true, motivo: 'sem_json', ncm_sem_aliquota: [] });
  });
});

describe('helpers numéricos espelhados', () => {
  it('IPI em centavos inteiros = round(numeric, 2) do Postgres; o ponto flutuante erra a fronteira', () => {
    expect(ipiCentavos(6500, 650)).toBe(423);
    expect(round2(round2(65) * 6.5 / 100)).toBe(4.22);
    expect(centavosDaMercadoria(426.8652)).toBe(42687);
    expect(centesimosDaAliquota(3.25)).toBe(325);
    expect(centesimosDaAliquota(3.255)).toBeNull();
    expect(toleranciaChecksum(3)).toBeCloseTo(0.005 + 3 * 0.0101, 10);
  });
});

interface LinhaOuro { sku_portal: string; ncm: string; qtd_un_raw: string; preco_un_raw: string; preco_venda_raw: string; preco_venda: number; ipi: number }
interface PedidoOuro { pedido_id: number; total_json: number; total_modelado: number; linhas: LinhaOuro[] }
interface ArquivoOuro { aliquotas_pct: Record<string, number>; pedidos: PedidoOuro[] }

describe('paridade com o arquivo-ouro (29 pedidos reais, db/fixtures/sayerlack-ipi-backtest-20261005.json)', () => {
  const ouro = JSON.parse(ler('db/fixtures/sayerlack-ipi-backtest-20261005.json')) as ArquivoOuro;
  const ncm8 = (ncm: string) => ncm.replace(/\D/g, '');
  const montar = (p: PedidoOuro, aliq: (ncm: string) => number | null) => ({
    dom: p.linhas.map((l) => ({ sku_portal: l.sku_portal, prz_ent_raw: '5', qtd_un_raw: l.qtd_un_raw, preco_venda_raw: l.preco_venda_raw, preco_un_raw: l.preco_un_raw })),
    json: { itens: p.linhas.map((l) => ({ item: l.sku_portal, value: parseBRL(l.preco_un_raw) as number })), value: p.total_json, ordernum: p.pedido_id },
    esperados: p.linhas.map((l) => ({ sku_portal: l.sku_portal, qtde_portal: parseBRL(l.qtd_un_raw) as number, ncm: l.ncm, aliquota_ipi_pct: aliq(l.ncm) })),
  });
  const real = (ncm: string) => ouro.aliquotas_pct[ncm8(ncm)] ?? null;
  it('sentinela: 29 pedidos, 13 alíquotas, e o Preço Venda numérico é o parse do texto do DOM', () => {
    expect(ouro.pedidos).toHaveLength(29);
    expect(Object.keys(ouro.aliquotas_pct)).toHaveLength(13);
    for (const p of ouro.pedidos) for (const l of p.linhas) expect(parseBRL(l.preco_venda_raw)).toBe(l.preco_venda);
  });
  it('todo pedido real fecha a prova com IPI e reproduz o IPI de cada linha ao centavo', () => {
    for (const p of ouro.pedidos) {
      const { dom, json, esperados } = montar(p, real);
      const c = consolidarLinhasPortal(dom, json, esperados, 'ok');
      expect(c.fonte, `pedido ${p.pedido_id}`).toBe('dom_checksum');
      expect(c.linhas.map((l) => l.valor_ipi), `pedido ${p.pedido_id}`).toEqual(p.linhas.map((l) => l.ipi));
      expect(c.checksum.total_modelado, `pedido ${p.pedido_id}`).toBe(p.total_modelado);
    }
  });
  it('trocar a alíquota de UM NCM pela vizinha derruba todo pedido que o contém (identificabilidade, em CI)', () => {
    const vizinha: Record<string, number> = { '3.25': 6.5, '6.5': 3.25, '1.3': 0, '0': 1.3 };
    let derrubados = 0;
    for (const alvo of Object.keys(ouro.aliquotas_pct)) {
      const trocada = vizinha[String(ouro.aliquotas_pct[alvo])];
      for (const p of ouro.pedidos.filter((q) => q.linhas.some((l) => ncm8(l.ncm) === alvo))) {
        const { dom, json, esperados } = montar(p, (ncm) => (ncm8(ncm) === alvo ? trocada : real(ncm)));
        expect(consolidarLinhasPortal(dom, json, esperados, 'ok').motivo, `${alvo}→${trocada} no pedido ${p.pedido_id}`).toBe('checksum_divergente');
        derrubados++;
      }
    }
    expect(derrubados).toBeGreaterThan(29); // cada NCM em ≥1 pedido; os comuns em vários
  });
});
```

- [ ] **Step 7: vitest do espelho — a parte de call-site fica vermelha até a Task 4/5**

```bash
heavy bun run test src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts > "$TMPDIR/v1.log" 2>&1; echo "rc=$?"; grep -E "Tests |✓|×|FAIL" "$TMPDIR/v1.log" | tail -12
```
Expected: `rc≠0` com falhas SÓ nos 3 testes de call-site (`sayerlack_ipi_itens`, `preco_atual`, `montarProdutoIncluir`); todo o resto verde (espelho idêntico, paridade 29/29, identificabilidade).

- [ ] **Step 8: commit**

```bash
git add supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.ts supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.test.ts src/lib/reposicao/sayerlack-scraping-pedido.ts src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts
git commit -m "feat(reposicao): a captura do portal modela o IPI por NCM — prova Σ linha + Σ IPI = cobrado, em centavos inteiros [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: A edge de envio usa o IPI

**Files:**
- Modify: `supabase/functions/enviar-pedido-portal-sayerlack/index.ts` (l.1457-1458, l.1821-1829, l.2125-2180)
- Modify: `supabase/functions/enviar-pedido-portal-sayerlack/versao.ts`
- Modify: `docs/historico/versao-enviar-pedido-portal-sayerlack.md`

**Interfaces:**
- Consumes: Task 2 (`sayerlack_ipi_itens`, payload da RPC) e Task 3 (`consolidarLinhasPortal(..., leituraIpi)`, `CustoUpdate`).

- [ ] **Step 1: tirar `preco_atual` de `ItemMapeado`**

Em `index.ts`, apagar estas 2 linhas da interface `ItemMapeado`:

```ts
  // preço unitário atual do item (base da tolerância na captura de custo do portal)
  preco_atual?: number;
```

- [ ] **Step 2: apagar a leitura de `preco_atual` (só alimentava o `sem_mudanca`)**

Apagar o bloco inteiro:

```ts
  // preco_unitario atual (base da tolerância de custo na captura). Independe da RPC trazer ou não.
  {
    const ids = itensList.map((i) => i.item_id);
    if (ids.length > 0) {
      const { data: precos } = await supabase.from("pedido_compra_item").select("id, preco_unitario").in("id", ids);
      const pm = new Map<number, number>((precos ?? []).map((p) => [Number((p as { id: number }).id), Number((p as { preco_unitario: number | null }).preco_unitario ?? 0)]));
      for (const it of itensList) (it as { preco_atual?: number }).preco_atual = pm.get(it.item_id) ?? 0;
    }
  }

```

- [ ] **Step 3: ler as alíquotas, montar os esperados e o payload novo**

Substituir o trecho que vai de `      // O que ESTA execução digitou no portal (sku + qtde em unidade do portal): prova de quantidade aceita.`
até o fim do bloco `if (!jaTemOmie) { ... }` (antes de `const resumo = resumirCaptura({`) por:

```ts
      // IPI de cada item: NCM do cadastro × `ipi_aliquota_ncm`, pela MESMA função com que a RPC confere. Falha de
      // leitura vira 'ipi_leitura_falhou' (não consegui ler ≠ NCM desconhecido) — nunca alíquota 0.
      const { data: ipiRows, error: eIpi } = await supabase.rpc("sayerlack_ipi_itens", { p_pedido_id: pedido.id }) as unknown as {
        data: { item_id: number; ncm: string | null; aliquota_pct: number | string | null }[] | null; error: PostgrestErrorLike | null;
      };
      if (eIpi) console.error(`[envio-portal] Pedido #${pedido.id}: leitura das alíquotas de IPI falhou (${eIpi.code ?? 'sem código'}):`, eIpi.message);
      const ipiPorItem = new Map((ipiRows ?? []).map((r) => [Number(r.item_id), {
        ncm: r.ncm ?? null,
        aliquota_pct: r.aliquota_pct === null || r.aliquota_pct === undefined ? null : Number(r.aliquota_pct),
      }]));
      // O que ESTA execução digitou no portal (sku + qtde em unidade do portal) + o IPI do NCM de cada item.
      // `itemsPortal` nasce de `itensList.map` (passo 3), na MESMA ordem: o índice liga os dois.
      const esperados = itemsPortal.map((p, idx) => {
        const ipi = ipiPorItem.get(itensList[idx].item_id);
        return { sku_portal: p.sku_portal, qtde_portal: p.qtde, ncm: ipi?.ncm ?? null, aliquota_ipi_pct: ipi?.aliquota_pct ?? null };
      });
      const cons = consolidarLinhasPortal(capturados, addJson, esperados, eIpi || !Array.isArray(ipiRows) ? 'falhou' : 'ok');
      let match: ResultadoMatch | null = null;
      let pulados: { sku_codigo_omie: string; motivo: string }[] = [];
      let planejados = 0;
      let atualizados = 0;
      let erroRpc: { motivo: MotivoRpcCusto; sqlstate: string | null } | null = null;
      if (!jaTemOmie) {
        const itensParaCusto: ItemPedido[] = itensList.map((i) => ({
          item_id: i.item_id, sku_codigo_omie: i.sku_codigo_omie, sku_descricao: i.sku_descricao,
          sku_portal: i.sku_portal, qtde_final: Number(i.qtde_final),
        }));
        match = casarLinhasComItens(cons.linhas, itensParaCusto);
        const derivado = derivarCustos(match);
        pulados = derivado.pulados;
        // Só escreve com o pedido INTEIRO provado (fonte ≠ nenhuma ⇒ conjunto local↔JSON↔DOM fechado, IPI de todo item
        // conhecido e a prova com IPI fechando), todo item casado e derivado: nunca custo misto no mesmo PO.
        const pedidoInteiroProvado = cons.fonte !== 'nenhuma' && cons.total_pedido != null && match.naoCasados.length === 0
          && match.ambiguos.length === 0 && match.casados.length === itensParaCusto.length && pulados.length === 0;
        if (pedidoInteiroProvado) {
          planejados = derivado.updates.length;
          {
            // UMA transação: CAS (omie IS NULL + sucesso_portal) no próprio UPDATE + o pedido inteiro (com o eco da
            // qtde_final) + IPI conferido contra a tabela + prova contra o total cobrado + a decomposição e o custo com
            // IPI gravados + o derivado remantido. Recusa = SQLSTATE CP00x + ROLLBACK; `data` = nº de itens gravados.
            // Antes do apply de 20261006120000 a RPC anterior recusa este payload com CP001: captura cega, nunca
            // número errado (a ordem segura é banco → edge).
            const { data: gravados, error: eRpc } = await supabase.rpc("sayerlack_aplicar_custo_portal", {
              p_pedido_id: pedido.id,
              p_itens: derivado.updates,
              p_valor_total: cons.total_pedido,
            }) as unknown as { data: number | null; error: PostgrestErrorLike | null };
            if (eRpc) {
              // Casa a MARCA (SQLSTATE) — código desconhecido é `erro_rpc` (transiente), nunca motivo fabricado.
              erroRpc = { motivo: classificarErroRpcCusto(eRpc.code), sqlstate: eRpc.code ?? null };
              console.error(`[envio-portal] Pedido #${pedido.id}: RPC de custo recusou (${eRpc.code ?? 'sem código'} → ${erroRpc.motivo}):`, eRpc.message);
            } else if (Number(gravados) !== planejados) {
              // Contrato violado (não devia acontecer: a RPC lança quando ROW_COUNT ≠ n) — trate como não gravado.
              erroRpc = { motivo: 'erro_rpc', sqlstate: null };
              console.error(`[envio-portal] Pedido #${pedido.id}: RPC de custo devolveu ${String(gravados)} ≠ planejados ${planejados}`);
            } else {
              atualizados = planejados;
            }
          }
        }
      }
```

- [ ] **Step 4: subir a versão**

Em `versao.ts`: no comentário do resumo, trocar `· v1.8 itens+de-para por caminho único (a RPC inexistente e a instrumentação \`[DEBUG_*]\` saíram).`
por `· v1.8 itens+de-para por caminho único (a RPC inexistente e a instrumentação \`[DEBUG_*]\` saíram) · v1.9 prova sem mudança e sensor do unitário · v1.10 IPI por NCM: a prova soma o IPI e a RPC grava a decomposição.`
e a constante por:

```ts
export const VERSAO = "v1.10-ipi-por-ncm";
```

Em `docs/historico/versao-enviar-pedido-portal-sayerlack.md`, acrescentar no topo da lista de versões:

```markdown
- **v1.10-ipi-por-ncm** (2026-10-06) — a captura do portal modela o IPI: lê `sayerlack_ipi_itens` (NCM do cadastro ×
  `ipi_aliquota_ncm`) e prova `Σ round2(Preço Venda) + Σ IPI = data.value` para 1 e N itens, em centavos inteiros.
  O payload da RPC vira `{item_id, qtde_final, valor_mercadoria, valor_ipi}` do pedido inteiro; saem o pulo
  `sem_mudanca` e a leitura `preco_atual`. **Pré-condição de banco:** `20261006120000_preco_exato_po_sayerlack_ipi.sql`
  (sem ela, CP001 → captura cega, nunca número errado). Spec: `docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md`.
```

- [ ] **Step 5: rodar os gates da edge**

```bash
deno test --no-remote --allow-read=supabase/functions supabase/functions/enviar-pedido-portal-sayerlack/ > "$TMPDIR/d3.log" 2>&1; echo "rc-deno=$?"; grep -E "passed|failed" "$TMPDIR/d3.log" | tail -1
bun run edges:typecheck > "$TMPDIR/tc.log" 2>&1; echo "rc-typecheck=$?"; tail -c 400 "$TMPDIR/tc.log"
bun run edges:sintaxe > "$TMPDIR/sx.log" 2>&1; echo "rc-sintaxe=$?"; tail -c 300 "$TMPDIR/sx.log"
```
Expected: os três `rc=0`.

- [ ] **Step 6: commit**

```bash
git add supabase/functions/enviar-pedido-portal-sayerlack/index.ts supabase/functions/enviar-pedido-portal-sayerlack/versao.ts docs/historico/versao-enviar-pedido-portal-sayerlack.md
git commit -m "feat(enviar-pedido-portal-sayerlack): lê a alíquota de IPI por item e grava o pedido inteiro pela RPC v3 (v1.10) [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: O PO leva `nValUnit` sem IPI + `nValorIpi`

**Files:**
- Create: `supabase/functions/disparar-pedidos-aprovados/produto-po.ts`
- Create: `supabase/functions/disparar-pedidos-aprovados/produto-po_test.ts`
- Modify: `supabase/functions/disparar-pedidos-aprovados/index.ts` (interface `ItemRow` l.84-89, select l.983, `produtos_incluir` l.1119-1128, imports)
- Modify: `supabase/functions/disparar-pedidos-aprovados/versao.ts`

**Interfaces:**
- Consumes: as colunas da Task 2.
- Produces: `montarProdutoIncluir(it: ItemPo, idx: number): ProdutoIncluir`.

- [ ] **Step 1: teste Deno (vermelho)**

Criar `produto-po_test.ts`:

```ts
// Item do IncluirPedCompra: a decomposição provada pelo portal (unitário sem IPI + IPI da linha) vira nValUnit +
// nValorIpi; sem ela, o PO sai como sempre (nValUnit = preco_unitario, SEM nValorIpi — IPI ausente nunca vira 0).
// Rodar: deno test supabase/functions/disparar-pedidos-aprovados/
import { montarProdutoIncluir, type ItemPo } from "./produto-po.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: esperado ${String(expected)}, veio ${String(actual)}`);
}
const base = (o: Partial<ItemPo> = {}): ItemPo => ({ sku_codigo_omie: "8689962883", qtde_final: 2, preco_unitario: 227.31, ...o });

Deno.test("com a decomposição (#3091, FC.6902L5): nValUnit sem IPI + nValorIpi da linha", () => {
  const p = montarProdutoIncluir(base({ preco_unitario_sem_ipi_portal: 213.435, valor_ipi_portal: 27.75 }), 0);
  assertEquals(JSON.stringify(p), '{"cCodIntItem":"ITEM001","nCodProd":8689962883,"nQtde":2,"nValUnit":213.435,"nValorIpi":27.75}', "payload exato");
});
Deno.test("sem decomposição: o PO de sempre — nValUnit = preco_unitario e a chave nValorIpi AUSENTE", () => {
  const p = montarProdutoIncluir(base(), 4);
  assertEquals(p.nValUnit, 227.31, "custo de hoje");
  assertEquals("nValorIpi" in p, false, "IPI ausente não vira 0");
  assertEquals(p.cCodIntItem, "ITEM005", "índice 1-based com 3 dígitos");
});
Deno.test("0% medido: nValorIpi 0 explícito (zero MEDIDO, não fabricado)", () => {
  const p = montarProdutoIncluir(base({ preco_unitario_sem_ipi_portal: 13.71, valor_ipi_portal: 0 }), 0);
  assertEquals(p.nValUnit, 13.71, "unitário");
  assertEquals(p.nValorIpi, 0, "zero medido");
});
Deno.test("PostgREST devolve numeric como string: converte", () => {
  const p = montarProdutoIncluir(base({ preco_unitario_sem_ipi_portal: "213.435", valor_ipi_portal: "27.75" }), 0);
  assertEquals(p.nValUnit, 213.435, "unitário da string");
  assertEquals(p.nValorIpi, 27.75, "IPI da string");
});
Deno.test("decomposição pela metade ou inválida ⇒ caminho de hoje, nunca nValorIpi fabricado", () => {
  const casos: Partial<ItemPo>[] = [
    { valor_ipi_portal: 27.75 },
    { preco_unitario_sem_ipi_portal: 213.435 },
    { preco_unitario_sem_ipi_portal: 0, valor_ipi_portal: 1 },
    { preco_unitario_sem_ipi_portal: 213.435, valor_ipi_portal: -0.01 },
    { preco_unitario_sem_ipi_portal: "abc", valor_ipi_portal: 1 },
    { preco_unitario_sem_ipi_portal: Number.POSITIVE_INFINITY, valor_ipi_portal: 1 },
    { preco_unitario_sem_ipi_portal: 213.435, valor_ipi_portal: "" },
  ];
  for (const c of casos) {
    const p = montarProdutoIncluir(base(c), 0);
    assertEquals(p.nValUnit, 227.31, `nValUnit de hoje (${JSON.stringify(c)})`);
    assertEquals("nValorIpi" in p, false, `sem nValorIpi (${JSON.stringify(c)})`);
  }
});
Deno.test("nQtde segue o backstop de quantidade inteira (ceil)", () => {
  assertEquals(montarProdutoIncluir(base({ qtde_final: 3.99996 }), 0).nQtde, 4, "ceil");
});
```

```bash
deno test --no-remote --allow-read=supabase/functions supabase/functions/disparar-pedidos-aprovados/produto-po_test.ts > "$TMPDIR/p1.log" 2>&1; echo "rc=$?"; tail -c 300 "$TMPDIR/p1.log"
```
Expected: `rc≠0` (módulo `./produto-po.ts` inexistente).

- [ ] **Step 2: a função pura**

Criar `produto-po.ts`:

```ts
// Item do IncluirPedCompra (`produtos_incluir`) — função PURA, testada em ./produto-po_test.ts.
//
// Preço exato do PO Sayerlack (spec docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md §5.4):
// quando a captura do portal provou o preço (RPC sayerlack_aplicar_custo_portal), o item traz a decomposição —
// unitário SEM IPI + IPI da linha — e o PO leva as duas, como a NF: `nValUnit` sem IPI e `nValorIpi`.
// Sem decomposição (fornecedor sem portal, captura cega, banco sem a migration 20261006120000) o PO sai como
// sempre: `nValUnit = preco_unitario` (o custo, que já inclui o IPI quando houve prova) e SEM `nValorIpi` — IPI
// ausente nunca vira 0 fabricado.

export interface ItemPo {
  sku_codigo_omie: string;
  qtde_final: number;
  preco_unitario: number;
  preco_unitario_sem_ipi_portal?: number | string | null;
  valor_ipi_portal?: number | string | null;
}

export interface ProdutoIncluir {
  cCodIntItem: string;
  nCodProd: number;
  nQtde: number;
  nValUnit: number;
  nValorIpi?: number;
}

/** Número finito vindo do PostgREST (numeric chega como number ou string); ausente/lixo ⇒ null, nunca 0. */
function numeroOuNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function montarProdutoIncluir(it: ItemPo, idx: number): ProdutoIncluir {
  const base = {
    cCodIntItem: `ITEM${String(idx + 1).padStart(3, "0")}`,
    nCodProd: Number(it.sku_codigo_omie),
    // [QTDE-INTEIRA] backstop universal: nenhum item de pedido pode ser fracionário. O estoque do Omie vem com poeira
    // decimal (tinta em litros) → qtde_final pode ser 3,99996. ceil aqui pega qualquer fonte (linha legada, edição
    // humana, promo, cold-start), mesmo que a RPC já ceile na origem. Math.ceil (não round) = nunca sub-pedir.
    nQtde: Math.ceil(Number(it.qtde_final)),
  };
  const semIpi = numeroOuNull(it.preco_unitario_sem_ipi_portal);
  const ipi = numeroOuNull(it.valor_ipi_portal);
  if (semIpi !== null && semIpi > 0 && ipi !== null && ipi >= 0) {
    return { ...base, nValUnit: semIpi, nValorIpi: ipi };
  }
  return { ...base, nValUnit: Number(it.preco_unitario) };
}
```

```bash
deno test --no-remote --allow-read=supabase/functions supabase/functions/disparar-pedidos-aprovados/produto-po_test.ts > "$TMPDIR/p2.log" 2>&1; echo "rc=$?"; grep -E "passed|failed" "$TMPDIR/p2.log" | tail -1
```
Expected: `rc=0`, `6 passed | 0 failed`.

- [ ] **Step 3: ligar no `index.ts` do disparo**

(a) Import, junto dos outros imports locais do topo:

```ts
import { montarProdutoIncluir } from "./produto-po.ts";
```

(b) Interface `ItemRow`:

```ts
interface ItemRow {
  sku_codigo_omie: string;
  sku_descricao: string | null;
  qtde_final: number;
  preco_unitario: number;
  // Decomposição do preço provado pelo portal (RPC sayerlack_aplicar_custo_portal): ausente fora do Sayerlack, em
  // captura cega e antes da migration 20261006120000. O PO só a usa com as duas presentes (./produto-po.ts).
  preco_unitario_sem_ipi_portal?: number | string | null;
  valor_ipi_portal?: number | string | null;
}
```

(c) A leitura dos itens do disparo (o `// a. Items`) — trocar

```ts
    const { data: items, error: itErr } = await db
      .from("pedido_compra_item")
      .select("sku_codigo_omie, sku_descricao, qtde_final, preco_unitario")
      .eq("pedido_id", pedido.id);
```
por
```ts
    // `*` de propósito: as colunas da decomposição (preço exato do PO) nascem na migration 20261006120000. Listá-las
    // explicitamente faria o disparo de TODO fornecedor falhar se a edge subisse antes do banco; com `*`, sem a
    // migration elas só não vêm, e o PO sai como sempre (./produto-po.ts).
    const { data: items, error: itErr } = await db
      .from("pedido_compra_item")
      .select("*")
      .eq("pedido_id", pedido.id);
```

(d) `produtos_incluir` — trocar o `.map` inteiro (do `const produtos_incluir = (items as ItemRow[]).map((it, idx) => ({` até o `}));`) por:

```ts
    // Preço exato (spec 2026-10-05): com a decomposição provada pelo portal, nValUnit sem IPI + nValorIpi; sem ela,
    // nValUnit = preco_unitario como sempre. A regra mora em ./produto-po.ts (pura, testada).
    const produtos_incluir = (items as ItemRow[]).map((it, idx) => montarProdutoIncluir(it, idx));
```

- [ ] **Step 4: subir a versão do disparo**

Em `disparar-pedidos-aprovados/versao.ts`, antes de `export const VERSAO`, acrescentar ao comentário:

```ts
 *
 * v1.5 (2026-10-06) — preço exato no PO Sayerlack: o item do IncluirPedCompra sai de `./produto-po.ts`; com a
 * decomposição provada pelo portal (preco_unitario_sem_ipi_portal + valor_ipi_portal) vai nValUnit sem IPI +
 * nValorIpi, sem ela o PO de sempre. A leitura dos itens passou a `select("*")` — sem a migration 20261006120000 as
 * colunas só não vêm. Nenhuma pré-condição de banco para o comportamento de hoje.
```

e trocar a constante:

```ts
export const VERSAO = "v1.5-ipi-por-item";
```

- [ ] **Step 5: gates**

```bash
deno test --no-remote --allow-read=supabase/functions supabase/functions/disparar-pedidos-aprovados/ > "$TMPDIR/p3.log" 2>&1; echo "rc-deno=$?"; grep -E "passed|failed" "$TMPDIR/p3.log" | tail -1
bun run edges:typecheck > "$TMPDIR/tc2.log" 2>&1; echo "rc-typecheck=$?"
heavy bun run test src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts > "$TMPDIR/v2.log" 2>&1; echo "rc-vitest=$?"; grep -E "Tests " "$TMPDIR/v2.log"
```
Expected: os três `rc=0`; o vitest agora verde inteiro (os 3 testes de call-site passam).

- [ ] **Step 6: commit**

```bash
git add supabase/functions/disparar-pedidos-aprovados/produto-po.ts supabase/functions/disparar-pedidos-aprovados/produto-po_test.ts supabase/functions/disparar-pedidos-aprovados/index.ts supabase/functions/disparar-pedidos-aprovados/versao.ts
git commit -m "feat(disparar-pedidos-aprovados): o PO leva nValUnit sem IPI + nValorIpi quando o portal provou o preço (v1.5) [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Registros, docs e todos os gates

**Files:**
- Modify: `scripts/authz-funcoes-fechadas.ts`
- Regenerate: `scripts/audit-custom-migrations.sql`, `docs/migrations-audit.md`
- Modify: `docs/agent/reposicao.md`, `docs/historico/sayerlack-captura-custo-cega.md`, `docs/historico/README.md`
- Create: `docs/historico/preco-exato-po-sayerlack.md`

- [ ] **Step 1: registro de funções fechadas**

Em `scripts/authz-funcoes-fechadas.ts`, trocar a entrada `'public.sayerlack_aplicar_custo_portal'` por (e acrescentar a nova logo abaixo):

```ts
  'public.sayerlack_aplicar_custo_portal': {
    fechadaPor: '20261006120000_preco_exato_po_sayerlack_ipi.sql',
    permitido: PORTA_FECHADA,
    motivo: 'custo do portal em 1 transação (CAS omie IS NULL + pedido inteiro + IPI conferido contra ipi_aliquota_ncm + prova contra o total cobrado + decomposição sem IPI/IPI e custo com IPI) — edge enviar-pedido-portal-sayerlack, service_role',
  },
  'public.sayerlack_ipi_itens': {
    fechadaPor: '20261006120000_preco_exato_po_sayerlack_ipi.sql',
    permitido: PORTA_FECHADA,
    motivo: 'alíquota de IPI por item (NCM do cadastro × ipi_aliquota_ncm) — edge enviar-pedido-portal-sayerlack e a RPC de custo, service_role',
  },
```

```bash
bun run authz:check > "$TMPDIR/authz.log" 2>&1; echo "rc=$?"; tail -c 800 "$TMPDIR/authz.log"
```
Expected: `rc=0`. Se acusar a função ou a tabela nova como não classificada, o próprio achado diz em que lista (`AUTHZ_MANIFEST`/`ACKNOWLEDGED_SENSITIVE`/`AUTHZ_TABELAS_FECHADAS`) — acrescente seguindo a entrada vizinha de `sayerlack_aplicar_custo_portal` e rode de novo até `rc=0`.

- [ ] **Step 2: audit de migrations custom**

```bash
bun run audit:migrations > "$TMPDIR/audit.log" 2>&1; echo "rc=$?"; tail -c 300 "$TMPDIR/audit.log"
git diff --stat -- scripts/audit-custom-migrations.sql docs/migrations-audit.md
```
Expected: `rc=0`; diff nos dois arquivos com `20261006120000`, `sayerlack_ipi_itens`, `ipi_aliquota_ncm` e o hash novo da RPC.

- [ ] **Step 3: docs de domínio**

(a) `docs/agent/reposicao.md`, no bullet `[2026-09-05] \`Preço Venda\` da datatable é o TOTAL DA LINHA`: trocar
`⚠️ **ABERTO:** o portal cobrou \`data.value\` **374,77**` por
`✅ **RESOLVIDO (2026-10-05): era o IPI** — 362,97 × 1,0325 = 374,77 (bullet do preço exato abaixo). Antes: o portal cobrou \`data.value\` **374,77**`.

(b) Logo depois desse bullet, acrescentar:

```markdown
- **[2026-10-05] Preço exato no PO — a "divergência aberta" era o IPI por NCM.** Backtest de 29 pedidos: 13 alíquotas
  medidas fecham todos em ≤ R$ 0,02. A prova da captura é `Σ round2(Preço Venda) + Σ IPI = data.value` (tolerância
  0,005 + 0,0101·n), para 1 e N itens, com o IPI em **centavos inteiros** (TS = SQL exato — em float a fronteira de
  meio centavo erra 1 centavo). Alíquota: `ipi_aliquota_ncm` (NCM do `omie_products` na conta `lower(empresa)`, via
  `sayerlack_ipi_itens`). A RPC grava a decomposição em `pedido_compra_item.{preco_unitario_sem_ipi_portal,
  valor_ipi_portal, aliquota_ipi_portal, ncm_ipi_portal}` (escritor único) e mantém `preco_unitario`/`valor_linha`
  como **custo com IPI**; o PO leva `nValUnit` sem IPI + `nValorIpi` (`disparar-pedidos-aprovados/produto-po.ts`).
  **NCM fora da tabela ⇒ captura cega `ipi_ncm_desconhecido`, com a lista em `captura_custo.ncm_sem_aliquota`** —
  cadastrar a alíquota lida numa NF: `INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia,
  medido_em) VALUES ('<8 dígitos>', <pct>, 'nf', 'NF <nº> (<data>), item <sku>', '<data da leitura>');`. Decreto
  que mude alíquota aparece como `checksum_divergente` nos pedidos daquele NCM. Spec:
  `docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md` · diário: `docs/historico/preco-exato-po-sayerlack.md`.
```

(c) `docs/historico/sayerlack-captura-custo-cega.md`: acrescentar no fim:

```markdown
## Adendo (2026-10-05): a divergência era o IPI

Os R$ 11,80 do #2459 (`374,77 − 362,9698`) são o IPI do NCM 3208.10.20 a 3,25%: `round2(362,9698) = 362,97`,
`362,97 × 3,25% = 11,80`, `362,97 + 11,80 = 374,77`. O backtest de 29 pedidos (06/09 → 05/10) fechou todos em
≤ R$ 0,02 com 13 alíquotas por NCM, e a captura passou a modelar o IPI — `dom_checksum` para 1 e N itens,
`json_total_unico` aposentado. Detalhe: `docs/historico/preco-exato-po-sayerlack.md`.
```

(d) Criar `docs/historico/preco-exato-po-sayerlack.md`:

```markdown
# Preço exato no PO Sayerlack: a "divergência aberta" era o IPI por NCM

> Entrega de 2026-10-05/06. Spec: [2026-10-05-preco-exato-po-sayerlack-design.md](../superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md).

## O defeito (medido)

- O PO nascia com o preço do motor (CMC ou média histórica) e `nValorIpi = 0`; na NF 000953881 o unitário do PO errou
  de −18,2% a +9,7%.
- A captura do portal falhou fechado em 24 de 28 pedidos desde 06/09 (`checksum_divergente`): o portal cobra a soma
  das linhas MAIS o IPI. O pedido de 1 item passava, mas embutia o IPI no `nValUnit`.

## A prova

- Backtest sobre os 29 pedidos com protocolo (DOM + `data.value` + NCM do cadastro): o modelo da NF-e (linha e IPI
  arredondados por item) fecha 29/29 em ≤ R$ 0,02 com 13 alíquotas; trocar qualquer uma pela vizinha erra ≥ R$ 4,87
  (2922.19.19: R$ 0,18, 1 linha). Nenhuma regra de arredondamento reproduz o portal exato — a tolerância é derivada.
- Em ponto flutuante, `round2(round2(pv) × alíq)` erra 1 centavo nas fronteiras de meio centavo (76 entre R$ 0,01 e
  R$ 2.000 nas 3 alíquotas) — por isso o IPI é calculado em centavos inteiros na edge e a RPC exige igualdade.
- Arquivo-ouro: `db/fixtures/sayerlack-ipi-backtest-20261005.json`, conferido pelo vitest (TS) e pelo PG17 (SQL).

## Decisões do founder

- `preco_unitario`/`valor_linha` seguem como custo com IPI; a decomposição vai em colunas novas que o PO usa.
- A tabela nasce com as 13 alíquotas medidas (4 confirmadas pela NF 000953881).
- Codex: o desenho foi pelo Caminho B (cota em 92%, exit 79); o adversarial de código rodou com o teto furado.

## Implantação (founder)

1. Migration `20261006120000_preco_exato_po_sayerlack_ipi.sql` no SQL Editor (ou envelope da sessão).
2. Edges que `bun run pendencias:deploy` apontar: `disparar-pedidos-aprovados` (v1.5) e
   `enviar-pedido-portal-sayerlack` (v1.10). Antes: `git log -S montarProdutoIncluir -- supabase/functions/disparar-pedidos-aprovados/index.ts`
   e `git log -S sayerlack_ipi_itens -- supabase/functions/enviar-pedido-portal-sayerlack/index.ts` na main.
3. 1º PO real com `nValorIpi`: combinado com o founder.

## Como medir (rode com `psql-ro`)

```sql
-- captura por fonte/motivo desde o deploy (esperado: dom_checksum, cego=false)
SELECT s.portal_resposta->'captura_custo'->>'fonte' AS fonte, s.portal_resposta->'captura_custo'->>'motivo' AS motivo,
       count(*) FROM pedido_compra_sugerido s
 WHERE s.enviado_portal_em >= '<instante do deploy>' AND s.portal_protocolo IS NOT NULL GROUP BY 1, 2;
-- NCMs a cadastrar (captura cega por alíquota)
SELECT DISTINCT jsonb_array_elements_text(s.portal_resposta->'captura_custo'->'ncm_sem_aliquota') AS ncm
  FROM pedido_compra_sugerido s WHERE s.portal_resposta->'captura_custo'->>'motivo' = 'ipi_ncm_desconhecido';
-- decomposição gravada
SELECT i.pedido_id, count(*) AS itens, count(i.valor_ipi_portal) AS com_ipi, sum(i.valor_ipi_portal) AS ipi
  FROM pedido_compra_item i JOIN pedido_compra_sugerido s ON s.id = i.pedido_id
 WHERE s.enviado_portal_em >= '<instante do deploy>' GROUP BY 1 ORDER BY 1 DESC LIMIT 10;
```
```

(e) `docs/historico/README.md`: acrescentar a linha da tabela logo abaixo da de `sayerlack-captura-custo-cega.md`:

```markdown
| [preco-exato-po-sayerlack.md](preco-exato-po-sayerlack.md) | a classe **"divergência de natureza não identificada" num money-path é hipótese a MEDIR, não ruído a tolerar** (2026-10-05): os 3,25% que reprovavam a captura do portal eram o IPI por NCM — backtest de 29 pedidos fechou em ≤ R$ 0,02 com 13 alíquotas; IPI em centavos inteiros (o float erra a fronteira de meio centavo); PO com `nValUnit` sem IPI + `nValorIpi` |
```

- [ ] **Step 4: todos os gates locais**

```bash
bun run test:edges > "$TMPDIR/g1.log" 2>&1; echo "rc-test-edges=$?"; grep -E "passed|failed" "$TMPDIR/g1.log" | tail -1
bun run edges:typecheck > "$TMPDIR/g2.log" 2>&1; echo "rc-edges-typecheck=$?"
bun run edges:sintaxe > "$TMPDIR/g3.log" 2>&1; echo "rc-edges-sintaxe=$?"
bun lint > "$TMPDIR/g4.log" 2>&1; echo "rc-lint=$?"; tail -c 400 "$TMPDIR/g4.log"
heavy bun run typecheck > "$TMPDIR/g5.log" 2>&1; echo "rc-typecheck=$?"; tail -c 400 "$TMPDIR/g5.log"
heavy bun run test > "$TMPDIR/g6.log" 2>&1; echo "rc-vitest=$?"; grep -E "Test Files|Tests " "$TMPDIR/g6.log"
bun run sonda:bump > "$TMPDIR/g7.log" 2>&1; echo "rc-sonda-bump=$?"; tail -c 300 "$TMPDIR/g7.log"
bun run sonda:fingerprint -- --write > "$TMPDIR/g8.log" 2>&1; echo "rc-fp-write=$?"; bun run sonda:fingerprint > "$TMPDIR/g8b.log" 2>&1; echo "rc-fp=$?"
bun run authz:check > "$TMPDIR/g9.log" 2>&1; echo "rc-authz=$?"
bun run docs:indice > "$TMPDIR/g10.log" 2>&1; echo "rc-docs-indice=$?"
bun run docs:citacoes > "$TMPDIR/g11.log" 2>&1; echo "rc-docs-citacoes=$?"; tail -c 600 "$TMPDIR/g11.log"
bun run docs:links > "$TMPDIR/g12.log" 2>&1; echo "rc-docs-links=$?"
bunx knip > "$TMPDIR/g13.log" 2>&1; echo "rc-knip=$?"; tail -c 400 "$TMPDIR/g13.log"
bun run lint:shell > "$TMPDIR/g14.log" 2>&1; echo "rc-lint-shell=$?"; tail -c 400 "$TMPDIR/g14.log"
bash db/test-sayerlack-ipi-po.sh > "$TMPDIR/g15.log" 2>&1; echo "rc-pg=$?"; grep -E "RESULTADO" "$TMPDIR/g15.log"
```
Expected: TODOS `rc=0`. `docs:citacoes` vermelho = citação `arquivo:linha` de um dos arquivos mexidos que deslocou: abra a
mensagem, ajuste o número de linha no doc citante para onde o trecho citado está agora e rode de novo.
`sonda:fingerprint -- --write` grava o hash das 2 edges no mapa — o arquivo que ele toca entra no commit.

- [ ] **Step 5: commit**

```bash
git add -A scripts/authz-funcoes-fechadas.ts scripts/audit-custom-migrations.sql docs/migrations-audit.md docs/agent/reposicao.md docs/historico/ supabase/functions/
git status --short
git commit -m "docs(reposicao): preço exato no PO — registros (authz, audit), sonda e diário; o 'ABERTO' do Preço Venda era o IPI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(Confira no `git status --short` que só entraram arquivos desta entrega.)

---

### Task 7: Falsificação do lado TS

**Files:** nenhum novo (script no scratchpad; restaura com `git checkout --` dos alvos depois de cada rodada — por isso o commit da Task 6 vem antes).

- [ ] **Step 1: rodada com controle verde na MESMA invocação**

```bash
S=/private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-nervous-dirac-0f8bc6/2f9d8a98-9232-4afb-be4b-85e135b05129/scratchpad
cat > "$S/falsifica-ts.sh" <<'SH'
#!/usr/bin/env bash
set -uo pipefail
ALVO=supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.ts
PO=supabase/functions/disparar-pedidos-aprovados/produto-po.ts
roda() { deno test --no-remote --allow-read=supabase/functions supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.test.ts supabase/functions/disparar-pedidos-aprovados/produto-po_test.ts > "$TMPDIR/fz.log" 2>&1; echo $?; }
git diff --quiet -- "$ALVO" "$PO" || { echo "ABORTA: alvos sujos antes de sabotar"; exit 2; }
[ "$(roda)" = "0" ] || { echo "ABORTA: controle NÃO está verde"; exit 2; }
echo "controle verde ($(grep -Eo '[0-9]+ passed' "$TMPDIR/fz.log" | head -1))"
dentes=0; total=0
sab() { # $1 arquivo · $2 nome · $3 perl
  total=$((total+1)); cp "$1" "$TMPDIR/orig.ts"; perl -0pi -e "$3" "$1"
  if cmp -s "$1" "$TMPDIR/orig.ts"; then echo "  ❌ $2: sabotagem não aplicou"; else
    if [ "$(roda)" != "0" ] && grep -q "FAILED\|failed" "$TMPDIR/fz.log" && ! grep -q "error: TS\|SyntaxError" "$TMPDIR/fz.log"; then echo "  ✅ $2: vermelho"; dentes=$((dentes+1)); else echo "  ❌ $2: VERDE ou erro alheio (sem dente)"; fi
  fi
  git checkout -- "$1"
}
sab "$ALVO" "ipi em float"            's/return Math\.floor\(\(linhaCentavos \* aliquotaCentesimos \+ 5000\) \/ 10000\);/return Math.round(linhaCentavos * aliquotaCentesimos \/ 10000);/'
sab "$ALVO" "tolerância frouxa"       's/return 0\.005 \+ nLinhas \* 0\.0101;/return 0.5;/'
sab "$ALVO" "sem IPI na soma"         's/s \+ l\.linha \+ l\.ipi, 0\)/s + l.linha, 0)/'
sab "$ALVO" "NCM ausente vira 0%"     's/centesimosDaAliquota\(e\.aliquota_ipi_pct\)\]/centesimosDaAliquota(e.aliquota_ipi_pct ?? 0)]/'
sab "$ALVO" "leitura falha ignorada"  "s/if \(leituraIpi !== 'ok'\) return falha\('ipi_leitura_falhou'\);//"
sab "$ALVO" "1 item cego de novo"     's/if \(linha == null\) return falha\(.dom_incompleto.\);/if (linha == null) continue;/'
sab "$ALVO" "IPI negativo derivado"   's/ipi == null \|\| !Number\.isFinite\(ipi\) \|\| ipi < 0/ipi == null || !Number.isFinite(ipi)/'
sab "$ALVO" "CP007 sem marca"         "s/CP007: 'prova_ipi_divergente',//"
sab "$PO"   "IPI fabricado 0"         's/return \{ \.\.\.base, nValUnit: Number\(it\.preco_unitario\) \};/return { ...base, nValUnit: Number(it.preco_unitario), nValorIpi: 0 };/'
sab "$PO"   "metade da decomposição"  's/semIpi !== null && semIpi > 0 && ipi !== null && ipi >= 0/semIpi !== null \&\& semIpi > 0/'
git diff --quiet -- "$ALVO" "$PO" && echo "restauração conferida (alvos limpos)" || echo "❌ ALVOS SUJOS DEPOIS DA RODADA"
echo "SABOTAGENS: $dentes/$total com vermelho"
[ "$dentes" = "$total" ]
SH
bash "$S/falsifica-ts.sh" > "$TMPDIR/fts.log" 2>&1; echo "rc=$?"; cat "$TMPDIR/fts.log"
```
Expected: `rc=0`, `controle verde`, cada sabotagem `✅ … vermelho`, `restauração conferida`, `SABOTAGENS: 10/10 com vermelho`.
Sabotagem que fique VERDE é teste faltando: escreva o teste que a pega (no arquivo de teste da camada) e rode de novo.

- [ ] **Step 2: rodar nos dois locales** (lição #1483)

```bash
LC_ALL=C bash "$S/falsifica-ts.sh" > "$TMPDIR/fts-c.log" 2>&1; echo "rc-C=$?"
LC_ALL=pt_BR.UTF-8 bash "$S/falsifica-ts.sh" > "$TMPDIR/fts-br.log" 2>&1; echo "rc-BR=$?"
git status --short
```
Expected: `rc-C=0`, `rc-BR=0`, `git status` limpo.

---

### Task 8: Codex adversarial no diff (com o teto furado, decisão do founder)

- [ ] **Step 1: prompt e disparo em background**

```bash
S=/private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-nervous-dirac-0f8bc6/2f9d8a98-9232-4afb-be4b-85e135b05129/scratchpad
git diff origin/main...HEAD --stat > "$S/diff-stat.txt"
cat > "$S/codex-codigo-prompt.txt" <<'TXT'
Responda em português brasileiro. Revisor ADVERSARIAL do DIFF desta branch contra origin/main (money-path). Somente
leitura. NÃO abra supabase/schema-snapshot.sql. Leia a spec docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md
e o diff (`git diff origin/main...HEAD`). Foque em: (1) a RPC em supabase/migrations/20261006120000_preco_exato_po_sayerlack_ipi.sql —
guards que NULL/NaN atravessam, ordem dos passos, ROW_COUNT, CAS, ACL, postcondição; (2) igualdade TS×SQL do IPI
(captura-custo.ts ipiCentavos/centavosDaMercadoria × round(numeric,2)); (3) a edge enviar-pedido-portal-sayerlack/index.ts —
alinhamento itemsPortal↔itensList por índice, leitura que falha virando ausência, payload; (4) disparar-pedidos-aprovados —
select("*"), montarProdutoIncluir, PO com metade dos itens decompostos; (5) testes que passam por ausência ou falsificação
sem dente (db/test-sayerlack-ipi-po.sh, captura-custo.test.ts, produto-po_test.ts, o vitest do espelho). Formato: achados
P0/P1/P2 com arquivo:linha, efeito concreto e correção; depois o que você CONCEDE; última linha VEREDITO: APROVADO |
APROVADO COM AJUSTES | REPROVADO.
TXT
CODEX_ASYNC_TETO_SALDO=0 scripts/codex-async.sh -r max - < "$S/codex-codigo-prompt.txt" > "$S/codex-codigo.out" 2>&1; echo "rc-codex=$?"
```
Rodar com `run_in_background: true`. Expected: `rc-codex=0` e `VEREDITO:` no fim de `codex-codigo.out`.

- [ ] **Step 2: apresentar o parecer CRU + a calibração separada; corrigir P0/P1 com teste; re-rodar a Task 6 Step 4**

Registrar na spec §10 (`Código: <id·pp> · VEREDITO …`) e commitar.

---

### Task 9: PR

- [ ] **Step 1: re-conferir a main e os PRs imediatamente antes**

```bash
git fetch origin --quiet && git merge --no-edit origin/main > "$TMPDIR/m2.log" 2>&1; echo "rc-merge=$?"
gh pr list --state open --json number,files --jq '.[] | select([.files[].path] | any(test("enviar-pedido-portal-sayerlack|disparar-pedidos-aprovados|20261006120000"))) | .number'
git grep -c "sayerlack_ipi_itens" origin/main -- supabase > /dev/null 2>&1; echo "rc-grep=$? (1 = ninguém entregou)"
```
Expected: `rc-merge=0`, lista vazia, `rc-grep=1`. Se o merge trouxe algo, re-rodar a Task 6 Step 4.

- [ ] **Step 2: push e PR (não-draft: auto-merge quando o `validate` passar)**

```bash
git push -u origin claude/preco-exato-po-sayerlack > "$TMPDIR/push.log" 2>&1; echo "rc-push=$?"
gh pr create --title "feat(reposicao): preço exato no PO Sayerlack — IPI por NCM na captura do portal e nValorIpi no PO [money-path]" --body-file "$S/pr-body.md"
```
O corpo (`$S/pr-body.md`) tem, nesta ordem: resumo; evidência (backtest 29/29 ≤ R$ 0,02; 13 alíquotas; cobertura 152/157); decisões
do founder (D1, D2); o que muda em cada camada; validação local (cada gate com rc); falsificação (PG e TS, n/n);
`Codex: desenho=sem-codex · código=<id·pp> · extra=nenhum` e `sem-codex: desenho — cota 92% > teto 85% (janela reabre 09/10 19:30); Caminho B pela RÉGUA da spec §4, decisão do founder`;
**camadas de deploy (founder)**: migration → edges de `bun run pendencias:deploy` (+ `git log -S`), 1º PO real combinado;
as queries de antes/depois; e a linha crua na coluna 1, fora de bloco de código:

```text
Ordem entre edges: nenhuma
```

e o fecho `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: ligar o Auto-fix e acompanhar**

`mcp__ccd_pr__get_status` (e `bind_pr` se preciso) → `mcp__ccd_pr__set_monitor` com `auto_fix` + `address_comments`.
