# Gêmeos push/pull — contagem única na fonte · Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada venda do Omie contada no máximo 1× no universo canônico, com uma trava estrutural, para que o app possa gravar `order_date_kpi` num PR seguinte sem reintroduzir a duplicata.

**Architecture:** Coluna derivada `sales_orders.gemeo_importado_id` + 3 triggers (`SECURITY DEFINER`) que zeram o kpi da linha do app quando a importada do mesmo `(account, omie_pedido_id)` existe, com advisory lock por pedido para a corrida push×import. Índice único parcial (1 kpi por pedido Omie) e CHECK como trava de fundo. Backlog dos 25 pares na mesma migration, com postcondição. O corpo do importador NÃO muda.

**Tech Stack:** PostgreSQL 17 (prod 17.6, Supabase/Lovable), PL/pgSQL, harness bash `db/test-*.sh` + `db/lib/pg-harness.sh`, `bun run db:aplicar`, `psql-ro`.

**Spec:** `docs/superpowers/specs/2026-10-01-gemeos-push-pull-contagem-unica-design.md`

## Global Constraints

- Responder/escrever em pt-BR (código, commits, PR).
- Migration de nome custom `YYYYMMDDHHMMSS_sales_orders_gemeo_importado_contagem_unica.sql`, timestamp **maior** que a última de `supabase/migrations/` no instante da criação; SEM `BEGIN/COMMIT` (o `db:aplicar` fornece a transação); idempotente; postcondição `DO $post$ … RAISE EXCEPTION`.
- Migration committed é IMUTÁVEL para o Edit/Write (hook `migration-immutability-guard.sh`). Correção antes do merge/apply = desfazer o commit da migration (`git reset --soft`) e reescrever; depois do apply = migration NOVA.
- Toda função `SECURITY DEFINER` com `SET search_path TO 'public'`; `REVOKE ALL … FROM PUBLIC, anon, authenticated`.
- `LIKE 'omie\_%'` sempre com o `_` escapado (gate `pattern-like-cru`).
- Prova: `psql -X` em TODA chamada (#2696); `-v ON_ERROR_STOP=1`; marcador `PASS=N  FAIL=M`; sem `date` de calendário no shell; juiz de falsificação no idioma de `db/test-data-health-vendas-empurradas.sh` (`SABOTAGENS="nome:A<n>,…"`).
- Codex: cota em `SALDO_ALTO` até **03/10 19:11** → PR em **DRAFT** até o adversarial no diff rodar (`scripts/codex-async.sh -r max`, em background). Registro no PR: `Codex: desenho=sem-codex (SALDO_ALTO 86%, Caminho B — spec §7) · código=<id·pp> · extra=nenhum` e `REVISÃO INDEPENDENTE PENDENTE` até o código rodar.
- Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; PR termina com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Prefixe com `heavy` todo `bun run test`/vitest/typecheck (M2 8 GB).

## Review Focus

1. **Duas linhas do app com o MESMO pedido Omie** (reenvio que gravou o mesmo pid): a importada tem de marcar as duas → pinado no A5 (backlog) da Task 1.
2. **Linha do app que já NASCE com pid** (INSERT, não UPDATE) com a importada existente → pinado no A17.
3. **Mesmo `omie_pedido_id` em contas diferentes** (colacor × oben): não são gêmeos → pinado no A8.
4. **Escritor que muda hash/pid de uma importada EXISTENTE** (one-off de renamespace): os triggers da importada são só de INSERT — limite conhecido, documentado no histórico (Task 4); o CHECK canônico já amarra hash a pid.
5. **Apply concorrente com o cron do importador**: `SET LOCAL lock_timeout = '5s'` na migration → falha limpa (exit 4 do `db:aplicar`) em vez de enfileirar a tabela; o ensaio da Task 3 mede.

---

### Task 1: A prova (vermelha) — `db/test-gemeos-push-pull-contagem-unica.sh`

**Files:**
- Create: `db/test-gemeos-push-pull-contagem-unica.sh`

**Interfaces:**
- Consumes: migrations reais `supabase/migrations/20260907220000_pedido_venda_coerencia_agregado.sql`, `*_desconto_valor_atravessa_os_escritores.sql` (última definição de `criar_pedidos_com_itens(p_pedidos jsonb)`, retorno `{inserted, repaired, items, skipped_complete, skipped_no_items, divergence, failed[]}`), e a da Task 2 localizada por `find … -name "*_sales_orders_gemeo_importado_contagem_unica.sql" | sort | tail -1`.
- Produces: 29 asserts `A1`–`A29`; modo `--falsificar` com 8 sabotagens; variáveis de ambiente `PGPORT_TEST`, `SABOTAGEM`, `HARNESS_LOCALE`.

- [ ] **Step 1: Escrever a prova**

```bash
#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — gêmeos push/pull de sales_orders: contagem única na fonte, com FALSIFICAÇÃO
# ║      bash db/test-gemeos-push-pull-contagem-unica.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-gemeos-push-pull-contagem-unica.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-gemeos-push-pull-contagem-unica.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Sobre a migration REAL (*_sales_orders_gemeo_importado_contagem_unica.sql) e a RPC REAL do
# ║  importador (criar_pedidos_com_itens), com o trigger de coerência da prod:
# ║   · backlog: par idêntico, par reaproveitado (cliente diferente), par recente (kpi só na importada),
# ║     duas linhas do app no mesmo pedido, app sem gêmeo, orçamento/rascunho, mesmo pid em contas
# ║     diferentes — ponteiro e kpi como na spec §5.3;
# ║   · regime: import depois do push COM kpi no app (o PR seguinte), push depois do import, linha do
# ║     app que nasce com pid, reimport, delete + reimport, escrita direta de kpi, papel sem EXECUTE;
# ║   · corrida nos dois sentidos, determinística (bandeira + pg_stat_activity): o advisory lock é o
# ║     mecanismo, não a sorte;
# ║   · a trava estrutural (índice único, CHECK), o dente da postcondição, e reaplicar = no-op.
# ║  Spec: docs/superpowers/specs/2026-10-01-gemeos-push-pull-contagem-unica-design.md
# ╚═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5561}"
SLUG="gemeos-push-pull"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

# ════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar — o laço de db/test-data-health-vendas-empurradas.sh, verbatim no método: controle
# VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e cada sabotagem só conta se
# (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle), (3) CADA assert declarado
# estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o controle não tem.
# docs/historico/falsificacao-exit-nao-e-dente.md
# ════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="derivar_sem_zerar_kpi:A16,A17,A20 derivar_sem_lock:A22 importada_antes_sem_lock:A23
              importada_antes_sem_zerar:A12,A14 importada_depois_sem_toque:A13,A19
              sem_indice:A24,A26 sem_check:A25 pos_sem_dente:A27"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha sozinha aprovaria"
    echo "     todas as sabotagens por vermelhidão constante, não por dente)."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando antes de sabotar."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    vermelhos="$(grep -Eo '^  ❌ A[0-9]+ ' "$log" | grep -Eo 'A[0-9]+' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão ocorre|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de SQL ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou:$faltam · vermelhos: ${vermelhos:-nenhum}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  echo
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
# PG DESCARTÁVEL: durabilidade desligada (não muda nada do que é provado); deadlock_timeout curto.
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c deadlock_timeout=200ms" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
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

# SQLSTATE da saída de erro (ASCII, invariante a lc_messages). NUNCA deixa a linha do servidor no log:
# o juiz do --falsificar conta 'ERROR:  ' e uma sabotagem bem-sucedida não pode parecer erro de SQL.
sqlstate() { local s; s="$(grep -o -E '^[A-Z]+:  [0-9A-Z]{5}' | grep -o -E '[0-9A-Z]{5}$' | head -1 || true)"; printf '%s' "${s:-SEM_SQLSTATE}"; }
rodar() { local out; if out="$(P -q -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo OK; else printf '%s\n' "$out" | sqlstate; fi; }

MIG_COER="$REPO_ROOT/supabase/migrations/20260907220000_pedido_venda_coerencia_agregado.sql"
MIG_RPC="$(find "$REPO_ROOT/supabase/migrations" -name "*_desconto_valor_atravessa_os_escritores.sql" | sort | tail -1)"
MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_sales_orders_gemeo_importado_contagem_unica.sql" | sort | tail -1)"
for m in "$MIG_COER" "$MIG_RPC" "$MIG"; do
  [ -n "$m" ] && [ -f "$m" ] || { echo "❌ migration ausente: [$m] — a prova testaria o NADA"; exit 1; }
done

c1="11111111-1111-1111-1111-111111111111"    # cliente A (a ART MÓVEIS do caso real)
c2="22222222-2222-2222-2222-222222222222"    # cliente B (a FRANCCINO)
sys="33333333-3333-3333-3333-333333333333"   # usuário de sistema do importador
vend="44444444-4444-4444-4444-444444444444"  # vendedor (linha do app)
p1="aaaaaaaa-0000-0000-0000-000000000001"    # produto 555
app() { echo "a0000000-0000-0000-0000-000000000$1"; }   # id da linha do app do pedido $1 (3 dígitos)
imp() { echo "b0000000-0000-0000-0000-000000000$1"; }   # id da importada SEMEADA do pedido $1

echo "═══ setup PG17 :$PORT · locale do servidor=$LOC ═══"
# ── schema mínimo fiel à prod nas colunas/índices/constraints que importam ──────────────────────────
P -q <<'SQL'
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint, account text);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, created_by uuid NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0, discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rascunho', notes text,
  omie_pedido_id bigint, omie_numero_pedido text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  account text NOT NULL DEFAULT 'oben', hash_payload text,
  customer_address text, customer_phone text, order_date_kpi date, deleted_at timestamptz,
  omie_payload jsonb, omie_response jsonb, omie_reconciliado_em timestamptz,
  CONSTRAINT sales_orders_hash_omie_canonico CHECK (hash_payload IS NULL OR hash_payload NOT LIKE 'omie\_%'
    OR (omie_pedido_id IS NOT NULL AND hash_payload = 'omie_' || account || '_' || omie_pedido_id)));
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
CREATE UNIQUE INDEX uniq_sales_orders_omie_pedido_id
  ON public.sales_orders (account, omie_pedido_id) WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.updated_at := now(); RETURN NEW; END $f$;
CREATE TRIGGER update_sales_orders_updated_at BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric, discount numeric DEFAULT 0,
  desconto_valor numeric, omie_codigo_item bigint,
  created_at timestamptz DEFAULT now(), hash_payload text);
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, product_id uuid NOT NULL, unit_price numeric NOT NULL,
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now());
SQL
# a cadeia REAL que a prod executou, na ordem lexical: coerência (DEFERRED) → importador
P -q -1 -f "$MIG_COER" >/dev/null
P -q -1 -f "$MIG_RPC" >/dev/null

# ── backlog como a prod tinha ANTES desta entrega (importadas semeadas sem order_items: a coerência
#    só exige quando há linhas) ─────────────────────────────────────────────────────────────────────
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$c1'),('$c2'),('$sys'),('$vend') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id, omie_codigo_produto, account) VALUES ('$p1', 555, 'oben');
INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, account, omie_pedido_id,
                                 hash_payload, omie_payload, order_date_kpi, created_at) VALUES
  ('$(app 101)', '$c1', '$vend', 'enviado',   527.20, 'oben',    101,  NULL,            '{}', '2026-04-06', '2026-04-06 13:49Z'),
  ('$(imp 101)', '$c1', '$sys',  'faturado',  600,    'oben',    101,  'omie_oben_101', NULL, '2026-04-06', '2026-04-06 12:00Z'),
  ('$(app 102)', '$c1', '$vend', 'enviado',   527.20, 'oben',    102,  NULL,            '{}', '2026-04-06', '2026-04-06 13:55Z'),
  ('$(imp 102)', '$c2', '$sys',  'faturado',  560,    'oben',    102,  'omie_oben_102', NULL, '2026-04-06', '2026-04-06 12:00Z'),
  ('$(app 103)', '$c1', '$vend', 'enviado',   240,    'oben',    103,  NULL,            '{}', NULL,         '2026-06-10 11:43Z'),
  ('$(imp 103)', '$c1', '$sys',  'faturado',  339.10, 'oben',    103,  'omie_oben_103', NULL, '2026-06-10', '2026-06-10 12:00Z'),
  ('$(app 104)', '$c1', '$vend', 'enviado',   314.40, 'oben',    104,  NULL,            '{}', '2026-04-06', '2026-04-06 18:55Z'),
  ('$(app 105)', '$c1', '$vend', 'orcamento', 4660,   'oben',    NULL, NULL,            NULL, NULL,         '2026-06-12 15:00Z'),
  ('$(app 106)', '$c1', '$vend', 'rascunho',  10,     'oben',    NULL, NULL,            NULL, NULL,         '2026-06-12 15:05Z'),
  ('$(app 107)', '$c1', '$vend', 'enviado',   50,     'colacor', 107,  NULL,            '{}', '2026-04-07', '2026-04-07 14:00Z'),
  ('$(imp 107)', '$c2', '$sys',  'faturado',  70,     'oben',    107,  'omie_oben_107', NULL, '2026-04-07', '2026-04-07 12:00Z'),
  ('$(app 108)', '$c1', '$vend', 'enviado',   25,     'oben',    108,  NULL,            '{}', '2026-04-08', '2026-04-08 10:00Z'),
  ('a1000000-0000-0000-0000-000000000108', '$c1', '$vend', 'enviado', 25, 'oben', 108, NULL, '{}', '2026-04-08', '2026-04-08 10:05Z'),
  ('$(imp 108)', '$c1', '$sys',  'faturado',  30,     'oben',    108,  'omie_oben_108', NULL, '2026-04-08', '2026-04-08 12:00Z');
SQL
# MOLDE = schema + cadeia + backlog, SEM a migration desta entrega: o A27 parte daqui.
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T prove molde

echo "═══ migration desta entrega: $(basename "$MIG") ═══"
eq "A1 a migration aplica e a postcondição passa" "$(P -q -1 -f "$MIG" >/dev/null 2>&1 && echo OK || echo FALHOU)" "OK"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# SABOTAGEM — no BANCO, recriando a função com UM trecho trocado; o repo nunca é tocado. O padrão
# tem de ocorrer exatamente 1× no corpo (substituição que não pega deixaria a suíte verde).
# ════════════════════════════════════════════════════════════════════════════════════════════════
trocar() {  # $1 arquivo, $2 de, $3 para — o padrão tem de ocorrer exatamente 1×
  python3 - "$1" "$2" "$3" <<'PYSAB'
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, "w").write(s.replace(de, para))
PYSAB
}
sabotar() {
  local fn="$1" de="$2" para="$3" tmp
  tmp="$(mktemp "/tmp/sab-${SLUG}.XXXXXX")"
  awk -v fn="CREATE OR REPLACE FUNCTION public.${fn}(" \
      'index($0,fn)==1{f=1} f{print} f && /^\$function\$;$/{exit}' "$MIG" > "$tmp"
  trocar "$tmp" "$de" "$para" || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× em $fn"; rm -f "$tmp"; exit 9; }
  P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
  echo "⚠️  SABOTAGEM ATIVA em $fn — a suíte abaixo DEVE ficar vermelha"
}

case "${SABOTAGEM:-}" in
  "") ;;
  derivar_sem_zerar_kpi)
    sabotar sales_orders_gemeo_app_derivar "    NEW.order_date_kpi := NULL;" "    NULL;" ;;
  derivar_sem_lock)
    sabotar sales_orders_gemeo_app_derivar "  PERFORM pg_advisory_xact_lock(hashtextextended(" "  PERFORM (hashtextextended(" ;;
  importada_antes_sem_lock)
    sabotar sales_orders_gemeo_importada_antes "  PERFORM pg_advisory_xact_lock(hashtextextended(" "  PERFORM (hashtextextended(" ;;
  importada_antes_sem_zerar)
    sabotar sales_orders_gemeo_importada_antes "     SET order_date_kpi = NULL" "     SET order_date_kpi = a.order_date_kpi" ;;
  importada_depois_sem_toque)
    sabotar sales_orders_gemeo_importada_depois "     AND a.gemeo_importado_id IS DISTINCT FROM NEW.id;" "     AND false;" ;;
  sem_indice)
    P -q -c "DROP INDEX public.uniq_sales_orders_kpi_por_pedido_omie;"
    echo "⚠️  SABOTAGEM ATIVA em uniq_sales_orders_kpi_por_pedido_omie (índice removido) — a suíte abaixo DEVE ficar vermelha" ;;
  sem_check)
    P -q -c "ALTER TABLE public.sales_orders DROP CONSTRAINT sales_orders_gemeo_e_recibo;"
    echo "⚠️  SABOTAGEM ATIVA em sales_orders_gemeo_e_recibo (CHECK removido) — a suíte abaixo DEVE ficar vermelha" ;;
  pos_sem_dente) ;;   # aplicada no A27, sobre a CÓPIA da migration
  *) echo "❌ sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac

# ── leituras ───────────────────────────────────────────────────────────────────────────────────────
# 't' quando a linha do app $1 está marcada: sem kpi e apontando para a importada do mesmo pedido.
marcada() { Pq -c "SELECT (a.order_date_kpi IS NULL AND i.id IS NOT NULL AND a.gemeo_importado_id IS NOT DISTINCT FROM i.id)
  FROM public.sales_orders a LEFT JOIN public.sales_orders i ON i.account = a.account AND i.hash_payload LIKE 'omie\_%'
   AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id WHERE a.id = '$1';"; }
kpi_ptr() { Pq -c "SELECT coalesce(order_date_kpi::text, 'nulo') || '|' || CASE WHEN gemeo_importado_id IS NULL THEN 'nulo' ELSE 'ptr' END
  FROM public.sales_orders WHERE id = '$1';"; }
dup_kpi() { Pq -c "SELECT count(*) FROM (SELECT 1 FROM public.sales_orders WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL
  GROUP BY account, omie_pedido_id HAVING count(*) > 1) d;"; }
foto() { Pq -c "SELECT md5(string_agg(id || ':' || coalesce(order_date_kpi::text, '-') || ':' || coalesce(gemeo_importado_id::text, '-')
  || ':' || status || ':' || total, ',' ORDER BY id)) FROM public.sales_orders;"; }

echo "═══ backlog ═══"
eq "A2 par idêntico: a linha do app perde o kpi e aponta para a importada" "$(marcada "$(app 101)")" "t"
eq "A3 par reaproveitado (cliente diferente no Omie): a linha do app também sai" "$(marcada "$(app 102)")" "t"
eq "A4 par recente (kpi só na importada): a linha do app ganha o ponteiro" "$(marcada "$(app 103)")" "t"
eq "A5 duas linhas do app no MESMO pedido: as duas saem" \
   "$(marcada "$(app 108)")|$(marcada a1000000-0000-0000-0000-000000000108)" "t|t"
eq "A6 app sem gêmeo conserva o kpi e não ganha ponteiro" "$(kpi_ptr "$(app 104)")" "2026-04-06|nulo"
eq "A7 orçamento e rascunho (sem pid) ficam intactos" \
   "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id IN ('$(app 105)', '$(app 106)') AND (gemeo_importado_id IS NOT NULL OR order_date_kpi IS NOT NULL);")" "0"
eq "A8 mesmo pid em CONTAS diferentes não é gêmeo" "$(kpi_ptr "$(app 107)")" "2026-04-07|nulo"
eq "A9 as importadas ficam intactas" \
   "$(Pq -c "SELECT string_agg(omie_pedido_id || ':' || order_date_kpi, ',' ORDER BY omie_pedido_id) FROM public.sales_orders WHERE hash_payload LIKE 'omie\_%';")" \
   "101:2026-04-06,102:2026-04-06,103:2026-06-10,107:2026-04-07,108:2026-04-08"
eq "A10 invariante: nenhum pedido Omie com 2 linhas com kpi" "$(dup_kpi)" "0"
# antes: 2.728,80 (527,20×2 + 25×2 do app contados de novo); depois: só a venda (importada, ou o app sem gêmeo).
eq "A11 universo canônico de abril (só kpi) conta cada venda 1×" \
   "$(Pq -c "SELECT sum(total) FROM public.sales_orders WHERE status NOT IN ('cancelado','rascunho','pendente','orcamento') AND deleted_at IS NULL AND order_date_kpi >= DATE '2026-04-01' AND order_date_kpi < DATE '2026-05-01';")" "1624.40"

echo "═══ regime: a RPC real do importador ═══"
payload() {  # $1 = pid, $2 = total → 1 pedido do Omie, items-jsonb ≡ itens (o trigger de coerência exige)
  printf '%s' "'[{\"customer_user_id\":\"$c1\",\"created_by\":\"$sys\",\"account\":\"oben\",\"hash_payload\":\"omie_oben_${1}\",\"omie_pedido_id\":${1},\"omie_numero_pedido\":\"${1}\",\"status\":\"importado\",\"order_date_kpi\":\"2026-10-01\",\"created_at\":\"2026-10-01T12:00:00Z\",\"subtotal\":${2},\"discount\":0,\"total\":${2},\"items\":[{\"omie_codigo_produto\":555,\"quantidade\":1,\"valor_unitario\":${2},\"desconto\":0}],\"itens\":[{\"omie_codigo_produto\":555,\"quantity\":1,\"unit_price\":${2},\"discount\":0,\"hash_payload\":\"omie_oben_${1}_555\"}]}]'::jsonb"
}
rpc() { Pq -c "SELECT (r->>'inserted') || '|' || (r->>'skipped_complete') || '|' || jsonb_array_length(r->'failed')
  FROM (SELECT public.criar_pedidos_com_itens($(payload "$1" "$2")) AS r) x;"; }
nova_app() { Pq -c "INSERT INTO public.sales_orders (customer_user_id, created_by, status, total) VALUES ('$c1', '$vend', 'rascunho', $1) RETURNING id;"; }
write_back() {  # $1 = id da linha do app, $2 = pid → o UPDATE do push, COM kpi (o cenário do PR seguinte)
  echo "UPDATE public.sales_orders SET omie_pedido_id = $2, omie_numero_pedido = '$2', status = 'enviado', omie_payload = '{}'::jsonb, order_date_kpi = DATE '2026-10-01' WHERE id = '$1';"
}

A201="$(nova_app 100)"
P -q -c "$(write_back "$A201" 201)"     # push: a linha do app ganha pid E kpi (ainda sem importada)
eq "A12 a RPC importa o pedido cujo app tem pid+kpi (inserted=1, sem falha)" "$(rpc 201 100)" "1|0|0"
eq "A13 depois do import a linha do app perde o kpi e aponta para a importada" "$(marcada "$A201")" "t"
eq "A14 a importada nasce com o kpi do Omie" "$(Pq -c "SELECT order_date_kpi FROM public.sales_orders WHERE hash_payload = 'omie_oben_201';")" "2026-10-01"
antes="$(foto)"
r15="$(rpc 201 100)"
eq "A15 reimport pela RPC é idempotente (skipped_complete=1, estado idêntico)" "$r15|$([ "$(foto)" = "$antes" ] && echo igual || echo mudou)" "0|1|0|igual"

P -q -c "SELECT public.criar_pedidos_com_itens($(payload 202 80));" >/dev/null
A202="$(nova_app 80)"
r16="$(rodar "$(write_back "$A202" 202)")"
eq "A16 push DEPOIS do import: o write-back passa e a linha do app já sai marcada" "$r16|$(marcada "$A202")" "OK|t"

P -q -c "SELECT public.criar_pedidos_com_itens($(payload 109 40));" >/dev/null
r17="$(rodar "INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, omie_pedido_id, omie_payload, order_date_kpi) VALUES ('c0000000-0000-0000-0000-000000000109', '$c1', '$vend', 'enviado', 40, 109, '{}', DATE '2026-10-01');")"
eq "A17 linha do app que JÁ NASCE com pid (importada existente) nasce marcada" "$r17|$(marcada c0000000-0000-0000-0000-000000000109)" "OK|t"

r18="$(rodar "DELETE FROM public.sales_orders WHERE hash_payload = 'omie_oben_202';")"
eq "A18 apagar a importada zera o ponteiro e a linha do app segue sem kpi" "$r18|$(kpi_ptr "$A202")" "OK|nulo|nulo"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 202 80));" >/dev/null
eq "A19 reimportar refaz o ponteiro para a NOVA importada" "$(marcada "$A202")" "t"

r20="$(rodar "UPDATE public.sales_orders SET order_date_kpi = DATE '2026-10-02' WHERE id = '$A201';")"
eq "A20 gravar kpi direto numa linha do app marcada não pega (o trigger devolve NULL)" "$r20|$(kpi_ptr "$A201")" "OK|nulo|ptr"

P -q <<'SQL'
CREATE ROLE escritor_sem_exec NOLOGIN;
GRANT USAGE ON SCHEMA public TO escritor_sem_exec;
GRANT SELECT, INSERT, UPDATE ON public.sales_orders TO escritor_sem_exec;
SQL
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 301 60));" >/dev/null
A301="$(nova_app 60)"
sem_exec="$(Pq -c "SELECT has_function_privilege('escritor_sem_exec', 'public.sales_orders_gemeo_app_derivar()', 'EXECUTE');")"
r21="$(rodar "SET ROLE escritor_sem_exec; $(write_back "$A301" 301)")"
eq "A21 papel SEM EXECUTE nas funções escreve a linha do app e o trigger dispara mesmo assim" "$sem_exec|$r21|$(marcada "$A301")" "f|OK|t"

echo "═══ corrida: o advisory lock serializa write-back e importador ═══"
P -q -c "CREATE TABLE public._prova_bandeira (id int);"
Pbg() {  # $1 = application_name, $2 = SQL → conexão própria (para segurar transação ou esperar lock)
  PGAPPNAME="$1" "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q -tA -c "$2"
}
SEGURAR='DO $w$ BEGIN WHILE NOT EXISTS (SELECT 1 FROM public._prova_bandeira) LOOP PERFORM pg_sleep(0.02); END LOOP; END $w$;'
esperar() {  # $1 = application_name, $2 = condição sobre pg_stat_activity (alias a). Nunca aborta a suíte.
  local i=0
  while [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity a WHERE a.application_name = '$1' AND ($2);")" != "1" ]; do
    i=$((i+1)); if [ "$i" -gt 400 ]; then echo "  (timeout esperando $1: $2)"; return 0; fi
    sleep 0.05
  done
}
corrida() {  # $1 = SQL que SEGURA a transação aberta, $2 = SQL que deve ESPERAR → "rc|saída-ou-SQLSTATE"
  P -q -c "DELETE FROM public._prova_bandeira;"
  ( Pbg prova_segura "BEGIN; $1 $SEGURAR COMMIT;" > "$TMP/segura.out" 2>&1 || true ) &
  esperar prova_segura "a.wait_event = 'PgSleep'"
  ( if Pbg prova_espera "$2" > "$TMP/espera.out" 2>&1; then echo 0; else echo 1; fi > "$TMP/espera.rc" ) &
  esperar prova_espera "a.wait_event_type = 'Lock'"
  P -q -c "INSERT INTO public._prova_bandeira VALUES (1);"
  wait || true
  local rc saida
  rc="$(cat "$TMP/espera.rc")"
  if [ "$rc" = 0 ]; then saida="$(grep -v '^$' "$TMP/espera.out" | tail -1 || true)"; else saida="$(sqlstate < "$TMP/espera.out")"; fi
  printf '%s|%s' "$rc" "$saida"
}
A401="$(nova_app 90)"
r22="$(corrida "SELECT public.criar_pedidos_com_itens($(payload 401 90));" "$(write_back "$A401" 401)")"
eq "A22 corrida (o importador segura a transação): o write-back ESPERA o lock e sai marcado" "${r22%%|*}|$(marcada "$A401")" "0|t"
A402="$(nova_app 91)"
r23="$(corrida "$(write_back "$A402" 402)" "SELECT public.criar_pedidos_com_itens($(payload 402 91))->>'inserted';")"
eq "A23 corrida (o write-back segura a transação): o importador ESPERA o lock e insere" "$r23|$(marcada "$A402")" "0|1|t"

echo "═══ a trava estrutural ═══"
P -q -c "ALTER TABLE public.sales_orders DISABLE TRIGGER trg_sales_orders_gemeo_app;"
r24="$(rodar "UPDATE public.sales_orders SET order_date_kpi = DATE '2026-10-01', gemeo_importado_id = NULL WHERE id = '$A201';")"
A501="$(Pq -c "INSERT INTO public.sales_orders (customer_user_id, created_by, status, total, omie_pedido_id, omie_payload, order_date_kpi) VALUES ('$c1', '$vend', 'enviado', 5, 501, '{}', DATE '2026-10-01') RETURNING id;")"
r25="$(rodar "UPDATE public.sales_orders SET gemeo_importado_id = '$(imp 101)' WHERE id = '$A501';")"
# arruma o que uma sabotagem tenha deixado passar (trigger ainda DESLIGADO), religa e re-deriva
P -q -c "UPDATE public.sales_orders SET gemeo_importado_id = NULL, order_date_kpi = NULL WHERE id IN ('$A201', '$A501');"
P -q -c "ALTER TABLE public.sales_orders ENABLE TRIGGER trg_sales_orders_gemeo_app;"
P -q -c "UPDATE public.sales_orders SET omie_pedido_id = omie_pedido_id WHERE id IN ('$A201', '$A501');"
eq "A24 sem o trigger, um 2º kpi no mesmo pedido Omie esbarra no índice único (23505)" "$r24" "23505"
eq "A25 sem o trigger, ponteiro + kpi esbarra no CHECK (23514)" "$r25" "23514"

# A26: o que a spec §5.2 promete para a corrida que escapar — o índice faz o importador pular SÓ aquele
# pedido (G8 registra a SQLSTATE) e o vizinho do mesmo lote entra. Com o trigger "antes" desligado, o
# pedido 601 (app com pid+kpi) bate no índice; o 602 é limpo.
P -q -c "ALTER TABLE public.sales_orders DISABLE TRIGGER trg_sales_orders_gemeo_importada_antes;"
A601="$(nova_app 61)"
P -q -c "$(write_back "$A601" 601)"
lote="$(Pq -c "SELECT (r->>'inserted') || '|' || jsonb_array_length(r->'failed') || '|' || coalesce(r->'failed'->0->>'sqlstate', '-')
  FROM (SELECT public.criar_pedidos_com_itens( ($(payload 601 61)) || ($(payload 602 62)) ) AS r) x;")"
P -q -c "ALTER TABLE public.sales_orders ENABLE TRIGGER trg_sales_orders_gemeo_importada_antes;"
P -q -c "UPDATE public.sales_orders SET omie_pedido_id = omie_pedido_id WHERE id = '$A601';"   # re-deriva
eq "A26 a RPC sob o índice: o pedido que bateria nele vai para failed (23505) e o vizinho do lote entra" "$lote" "1|1|23505"

echo "═══ a postcondição tem dente ═══"
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pos
cp "$MIG" "$TMP/mig-pos.sql"
trocar "$TMP/mig-pos.sql" "   AND (a.gemeo_importado_id IS DISTINCT FROM i.id OR a.order_date_kpi IS NOT NULL);" "   AND a.order_date_kpi IS NOT NULL;" \
  || { echo "❌ o backfill da migration mudou de forma — o A27 não consegue montar o caso"; exit 1; }
if [ "${SABOTAGEM:-}" = "pos_sem_dente" ]; then
  trocar "$TMP/mig-pos.sql" "v_sem_ptr <> 0 OR " "" || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na postcondição"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em postcondição (sem_ponteiro fora do IF) — a suíte abaixo DEVE ficar vermelha"
fi
out27="$("$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d pos -v ON_ERROR_STOP=1 -q -1 -f "$TMP/mig-pos.sql" 2>&1 || true)"
case "$out27" in
  *"POS FALHOU gemeos"*"sem_ponteiro=1 "*) r27="recusou:sem_ponteiro=1" ;;
  *"POS FALHOU gemeos"*) r27="recusou:outro_motivo" ;;
  *) if [ -z "$out27" ]; then r27="aplicou"; else r27="erro:$(printf '%s\n' "$out27" | sqlstate)"; fi ;;
esac
eq "A27 backfill que esquece o par sem kpi é recusado pela postcondição (sem_ponteiro=1)" "$r27" "recusou:sem_ponteiro=1"

eq "A28 invariante final: nenhum pedido Omie com 2 linhas com kpi" "$(dup_kpi)" "0"
antes="$(foto)"
r29="$(P -q -1 -f "$MIG" >/dev/null 2>&1 && echo OK || echo FALHOU)"
eq "A29 reaplicar a migration é no-op (aplica e não muda nenhuma linha)" "$r29|$([ "$(foto)" = "$antes" ] && echo igual || echo mudou)" "OK|igual"

echo
echo "PASS=${PASS}  FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
```

- [ ] **Step 2: Rodar e ver vermelho pelo motivo certo**

Run: `chmod +x db/test-gemeos-push-pull-contagem-unica.sh && bash db/test-gemeos-push-pull-contagem-unica.sh > /tmp/gemeos.log 2>&1; echo "exit=$?"; tail -3 /tmp/gemeos.log`
Expected: `exit=1` com `❌ migration ausente: [] — a prova testaria o NADA` (a migration da Task 2 ainda não existe). Qualquer outro erro = consertar a prova antes de seguir.

### Task 2: A migration (verde) + falsificação + núcleo

**Files:**
- Create: `supabase/migrations/<TS>_sales_orders_gemeo_importado_contagem_unica.sql`
- Modify: `db/nucleo-ci.txt` (1 linha nova, junto das provas de pedido)

**Interfaces:**
- Consumes: a prova da Task 1.
- Produces: coluna `sales_orders.gemeo_importado_id uuid`; funções `public.sales_orders_gemeo_app_derivar()`, `public.sales_orders_gemeo_importada_antes()`, `public.sales_orders_gemeo_importada_depois()`; triggers `trg_sales_orders_gemeo_app`, `trg_sales_orders_gemeo_importada_antes`, `trg_sales_orders_gemeo_importada_depois`; índices `idx_sales_orders_app_pedido_omie`, `uniq_sales_orders_kpi_por_pedido_omie`; CHECK `sales_orders_gemeo_e_recibo`; marca de erro da postcondição `POS FALHOU gemeos: dup_kpi=% sem_ponteiro=% …`.

- [ ] **Step 1: Gerar o timestamp que ordena depois da última migration**

Run: `TS=$(date +%Y%m%d%H%M%S); LAST=$(find supabase/migrations -name '*.sql' | sed 's#.*/##' | sort | tail -1 | cut -c1-14); echo "candidato=$TS ultima=$LAST"`
Expected: `candidato` > `ultima` (senão use `ultima + 1`).

- [ ] **Step 2: Escrever a migration**

```sql
-- ============================================================================================
-- <TS> · sales_orders: gêmeos push/pull — contagem única na fonte  [MONEY-PATH]
-- Spec:  docs/superpowers/specs/2026-10-01-gemeos-push-pull-contagem-unica-design.md
-- Prova: db/test-gemeos-push-pull-contagem-unica.sh (PG17: migration real + RPC real do importador)
--
-- O QUE: o pedido que o app empurra ao Omie (linha do APP: hash_payload nulo) e o MESMO pedido
-- trazido pelo importador (linha IMPORTADA: hash 'omie_<account>_<omie_pedido_id>') são duas linhas.
-- Com order_date_kpi nas duas, o universo canônico conta a venda 2x (abril/2026: 22 pares,
-- R$ 12.840,46). A IMPORTADA é a autoridade (é o que o Omie fatura; a do app pode até ser de outro
-- cliente depois que o pedido é reaproveitado no Omie). A linha do app continua existindo (recibo de
-- envio: vendedor, checkout, edição pelo id dela), mas quando a importada existe ela perde o kpi e
-- aponta para a gêmea. O índice único garante no máximo 1 linha com kpi por pedido Omie, venha a
-- escrita de onde vier; os triggers mantêm a marca para qualquer escritor.
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação
-- (não há BEGIN/COMMIT aqui). Idempotente: reaplicar não muda nada. A postcondição no fim aborta
-- tudo se o estado final não for o desenhado.
-- ============================================================================================

-- ALTER/CREATE TRIGGER/CREATE INDEX em sales_orders: não fila atrás de transação longa
SET LOCAL lock_timeout = '5s';

-- 1) coluna DERIVADA: o único escritor é trg_sales_orders_gemeo_app (valor escrito por fora é recalculado)
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS gemeo_importado_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sales_orders.gemeo_importado_id IS
  'Só em linha do APP (hash_payload nulo): a linha IMPORTADA do mesmo (account, omie_pedido_id). Preenchida = esta linha é recibo de envio, sem order_date_kpi, fora do universo de vendas. Derivada por trg_sales_orders_gemeo_app; não escreva.';

-- 2) índice de apoio: os triggers da importada acham as linhas do app sem varrer a tabela
CREATE INDEX IF NOT EXISTS idx_sales_orders_app_pedido_omie
  ON public.sales_orders (account, omie_pedido_id)
  WHERE hash_payload IS NULL AND omie_pedido_id IS NOT NULL;

-- 3) funções dos triggers. SECURITY DEFINER: a derivação não pode depender da RLS de quem escreve.
CREATE OR REPLACE FUNCTION public.sales_orders_gemeo_app_derivar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gemeo uuid;
BEGIN
  -- Linha do app ainda não empurrada: não há gêmea possível.
  IF NEW.omie_pedido_id IS NULL THEN
    NEW.gemeo_importado_id := NULL;
    RETURN NEW;
  END IF;
  -- Serializa com o trigger da importada do MESMO pedido (write-back x importador). Quem chega
  -- depois vê o commit do outro: o SELECT abaixo roda com snapshot novo, depois do lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('sales_orders.gemeo:' || NEW.account || ':' || NEW.omie_pedido_id, 0));
  SELECT i.id INTO v_gemeo
    FROM public.sales_orders i
   WHERE i.account = NEW.account
     AND i.hash_payload LIKE 'omie\_%'
     AND i.hash_payload = 'omie_' || NEW.account || '_' || NEW.omie_pedido_id;
  NEW.gemeo_importado_id := v_gemeo;
  IF v_gemeo IS NOT NULL THEN
    NEW.order_date_kpi := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sales_orders_gemeo_importada_antes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Mesmo lock do trigger da linha do app (ver sales_orders_gemeo_app_derivar).
  PERFORM pg_advisory_xact_lock(hashtextextended('sales_orders.gemeo:' || NEW.account || ':' || NEW.omie_pedido_id, 0));
  -- ANTES da inserção: o índice único é imediato e barraria a importada se a linha do app ainda
  -- tivesse kpi. Dispara também quando o INSERT ... ON CONFLICT DO NOTHING acaba não inserindo —
  -- coerente: a importada já existe, e a linha do app não pode ter kpi.
  UPDATE public.sales_orders a
     SET order_date_kpi = NULL
   WHERE a.account = NEW.account
     AND a.omie_pedido_id = NEW.omie_pedido_id
     AND a.hash_payload IS NULL
     AND a.order_date_kpi IS NOT NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sales_orders_gemeo_importada_depois()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- DEPOIS da inserção (a FK exige a importada existindo): toca as linhas do app do mesmo pedido
  -- para o trigger delas derivar o ponteiro.
  UPDATE public.sales_orders a
     SET gemeo_importado_id = NEW.id
   WHERE a.account = NEW.account
     AND a.omie_pedido_id = NEW.omie_pedido_id
     AND a.hash_payload IS NULL
     AND a.gemeo_importado_id IS DISTINCT FROM NEW.id;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.sales_orders_gemeo_app_derivar() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_orders_gemeo_importada_antes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_orders_gemeo_importada_depois() FROM PUBLIC, anon, authenticated;

-- 4) triggers
CREATE OR REPLACE TRIGGER trg_sales_orders_gemeo_app
  BEFORE INSERT OR UPDATE OF omie_pedido_id, account, hash_payload, order_date_kpi, gemeo_importado_id
  ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.hash_payload IS NULL)
  EXECUTE FUNCTION public.sales_orders_gemeo_app_derivar();

CREATE OR REPLACE TRIGGER trg_sales_orders_gemeo_importada_antes
  BEFORE INSERT ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.hash_payload LIKE 'omie\_%' AND NEW.omie_pedido_id IS NOT NULL)
  EXECUTE FUNCTION public.sales_orders_gemeo_importada_antes();

CREATE OR REPLACE TRIGGER trg_sales_orders_gemeo_importada_depois
  AFTER INSERT ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.hash_payload LIKE 'omie\_%' AND NEW.omie_pedido_id IS NOT NULL)
  EXECUTE FUNCTION public.sales_orders_gemeo_importada_depois();

-- 5) backlog: as linhas do app que JÁ têm a importada (25 em 2026-09-30; 22 com kpi). O trigger 1
--    deriva o mesmo resultado; o SET explícito documenta a intenção.
UPDATE public.sales_orders a
   SET gemeo_importado_id = i.id,
       order_date_kpi     = NULL
  FROM public.sales_orders i
 WHERE a.hash_payload IS NULL
   AND a.omie_pedido_id IS NOT NULL
   AND i.account = a.account
   AND i.hash_payload LIKE 'omie\_%'
   AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id
   AND (a.gemeo_importado_id IS DISTINCT FROM i.id OR a.order_date_kpi IS NOT NULL);

-- 6) a trava: no máximo 1 linha com kpi por pedido Omie (depois do backfill, senão o backlog a barra)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_kpi_por_pedido_omie
  ON public.sales_orders (account, omie_pedido_id)
  WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL;

-- 7) a marca é auto-consistente: ponteiro só em linha do app, e nunca junto com kpi
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.sales_orders'::regclass
                    AND conname = 'sales_orders_gemeo_e_recibo') THEN
    ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_gemeo_e_recibo
      CHECK (gemeo_importado_id IS NULL
             OR (hash_payload IS NULL AND order_date_kpi IS NULL AND gemeo_importado_id <> id));
  END IF;
END
$chk$;

-- 8) postcondição: aborta a transação inteira se o estado final não for o desenhado
DO $post$
DECLARE
  v_dup        bigint;
  v_sem_ptr    bigint;
  v_ptr_errado bigint;
  v_ptr_kpi    bigint;
  v_obj        int;
BEGIN
  SELECT count(*) INTO v_dup FROM (
    SELECT 1 FROM public.sales_orders
     WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL
     GROUP BY account, omie_pedido_id HAVING count(*) > 1) d;
  SELECT count(*) INTO v_sem_ptr
    FROM public.sales_orders a
    JOIN public.sales_orders i
      ON i.account = a.account AND i.hash_payload LIKE 'omie\_%'
     AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id
   WHERE a.hash_payload IS NULL AND a.omie_pedido_id IS NOT NULL
     AND a.gemeo_importado_id IS DISTINCT FROM i.id;
  SELECT count(*) INTO v_ptr_errado
    FROM public.sales_orders a
   WHERE a.gemeo_importado_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.sales_orders i
                      WHERE i.id = a.gemeo_importado_id AND i.account = a.account
                        AND i.omie_pedido_id = a.omie_pedido_id AND i.hash_payload LIKE 'omie\_%');
  SELECT count(*) INTO v_ptr_kpi
    FROM public.sales_orders WHERE gemeo_importado_id IS NOT NULL AND order_date_kpi IS NOT NULL;
  SELECT (SELECT count(*) FROM pg_trigger
           WHERE tgrelid = 'public.sales_orders'::regclass AND NOT tgisinternal
             AND tgname IN ('trg_sales_orders_gemeo_app', 'trg_sales_orders_gemeo_importada_antes',
                            'trg_sales_orders_gemeo_importada_depois'))
       + (SELECT count(*) FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname IN ('uniq_sales_orders_kpi_por_pedido_omie', 'idx_sales_orders_app_pedido_omie'))
       + (SELECT count(*) FROM pg_constraint
           WHERE conrelid = 'public.sales_orders'::regclass AND conname = 'sales_orders_gemeo_e_recibo')
    INTO v_obj;
  IF v_dup <> 0 OR v_sem_ptr <> 0 OR v_ptr_errado <> 0 OR v_ptr_kpi <> 0 OR v_obj <> 6 THEN
    RAISE EXCEPTION 'POS FALHOU gemeos: dup_kpi=% sem_ponteiro=% ponteiro_errado=% ponteiro_com_kpi=% objetos=%/6',
      v_dup, v_sem_ptr, v_ptr_errado, v_ptr_kpi, v_obj;
  END IF;
END
$post$;
```

(Substitua `<TS>` no cabeçalho pelo timestamp do Step 1.)

- [ ] **Step 3: Rodar a prova — verde**

Run: `bash db/test-gemeos-push-pull-contagem-unica.sh > /tmp/gemeos.log 2>&1; echo "exit=$?"; grep -E '❌|PASS=' /tmp/gemeos.log`
Expected: `exit=0` e `PASS=29  FAIL=0`.

- [ ] **Step 4: Rodar no 2º idioma do servidor**

Run: `HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-gemeos-push-pull-contagem-unica.sh > /tmp/gemeos-ptbr.log 2>&1; echo "exit=$?"; grep -E '❌|PASS=' /tmp/gemeos-ptbr.log`
Expected: `exit=0` e `PASS=29  FAIL=0`.

- [ ] **Step 5: Falsificar (nos dois idiomas)**

Run: `bash db/test-gemeos-push-pull-contagem-unica.sh --falsificar > /tmp/gemeos-f.log 2>&1; echo "exit=$?"; grep -E 'controle|SABOTAGENS|❌' /tmp/gemeos-f.log`
Expected: `exit=0`, `controle VERDE (29 asserts)`, `SABOTAGENS: 8 vermelhas / 0 falhas`.
Run: `HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-gemeos-push-pull-contagem-unica.sh --falsificar > /tmp/gemeos-f-ptbr.log 2>&1; echo "exit=$?"; grep -E 'SABOTAGENS' /tmp/gemeos-f-ptbr.log`
Expected: `exit=0`, `SABOTAGENS: 8 vermelhas / 0 falhas`.

- [ ] **Step 6: Registrar no núcleo do CI**

Acrescentar em `db/nucleo-ci.txt`, logo depois da linha de `db/test-data-health-vendas-empurradas.sh`:

```text
# gêmeos push/pull de sales_orders — contagem única na fonte (marca + triggers + índice único),
# com a RPC real do importador e corrida determinística. 8 sabotagens, uma camada por vez.
db/test-gemeos-push-pull-contagem-unica.sh   29  falsificar=8
```

Run: `bash db/roda-nucleo-ci.sh --lista > /tmp/nucleo.log 2>&1; echo "exit=$?"; grep -n gemeos /tmp/nucleo.log`
Expected: `exit=0` e a prova listada com mínimo 29 asserts e `falsificar=8` (o runner não filtra uma prova só: a execução real é a dos Steps 3 e 5).

- [ ] **Step 7: Commit**

```bash
git add db/test-gemeos-push-pull-contagem-unica.sh supabase/migrations/*_sales_orders_gemeo_importado_contagem_unica.sql db/nucleo-ci.txt
git commit -m "fix(sales-orders): gêmeos push/pull contam 1× — marca na linha do app + índice único de kpi por pedido Omie [money-path]

Coluna derivada gemeo_importado_id + 3 triggers (advisory lock por pedido) + índice
único parcial + CHECK; backlog dos 25 pares com postcondição. Prova PG17 com a RPC
real do importador: 29 asserts, 8 sabotagens, C e pt_BR.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Gates locais + pré-voo contra a prod

**Files:**
- Modify (gerados): `docs/migrations-audit.md`, `scripts/audit-custom-migrations.sql`

- [ ] **Step 1: Audit das migrations custom**

Run: `bun run audit:migrations; echo "exit=$?"`
Expected: `exit=0`; os dois arquivos gerados passam a citar os objetos novos.

- [ ] **Step 2: Gates do repo**

Run: `bun run lint:shell; echo "exit=$?"` → Expected: `exit=0`.
Run: `heavy bun run test > /tmp/vitest.log 2>&1; echo "exit=$?"; grep -E 'Test Files|Tests ' /tmp/vitest.log` → Expected: `exit=0` (cobre `falsificar-exige-assert`, fuso/relógio, `pattern-like-cru`, gates do núcleo).

- [ ] **Step 3: Colisão multi-sessão**

Run: `bun run wt:preflight supabase/migrations/*_sales_orders_gemeo_importado_contagem_unica.sql --full; echo "exit=$?"`
Expected: 🟢 ou 🟡. 🔴 = PARE e coordene.

- [ ] **Step 4: Pré-voo de dados (psql-ro, só leitura)**

```bash
~/.config/afiacao/psql-ro -q -X -v ON_ERROR_STOP=1 -At <<'SQL'
-- (a) depois do backfill, nenhum pedido Omie fica com 2 kpi (senão o CREATE UNIQUE INDEX cai)
SELECT 'dup_pos_backfill=' || count(*) FROM (
  SELECT 1 FROM public.sales_orders s
   WHERE s.omie_pedido_id IS NOT NULL AND s.order_date_kpi IS NOT NULL
     AND NOT (s.hash_payload IS NULL AND EXISTS (
           SELECT 1 FROM public.sales_orders i WHERE i.account = s.account AND i.hash_payload LIKE 'omie\_%'
              AND i.hash_payload = 'omie_' || s.account || '_' || s.omie_pedido_id))
   GROUP BY s.account, s.omie_pedido_id HAVING count(*) > 1) d;
-- (b) quantas linhas o backfill toca / quantos kpi zera
SELECT 'backfill_ponteiros=' || count(*) || ' kpi_zerados=' || count(*) FILTER (WHERE a.order_date_kpi IS NOT NULL)
  FROM public.sales_orders a JOIN public.sales_orders i
    ON i.account = a.account AND i.hash_payload LIKE 'omie\_%' AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id
 WHERE a.hash_payload IS NULL AND a.omie_pedido_id IS NOT NULL;
-- (c) nada desta entrega existe ainda
SELECT 'ja_existe=' || (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
          AND table_name = 'sales_orders' AND column_name = 'gemeo_importado_id');
SELECT 'FIM-OK';
SQL
```
Expected: `dup_pos_backfill=0`, `backfill_ponteiros=25 kpi_zerados=22`, `ja_existe=0`, `FIM-OK`.

- [ ] **Step 5: Retrato ANTES (para a validação externa da Task 6)**

```bash
mkdir -p docs/historico/anexos
~/.config/afiacao/psql-ro -q -X -v ON_ERROR_STOP=1 -At -F ';' > docs/historico/anexos/gemeos-antes.csv <<'SQL'
SELECT 'canonico' AS serie, customer_user_id, to_char(date_trunc('month', order_date_kpi), 'YYYY-MM') AS mes, sum(total)
  FROM public.sales_orders
 WHERE status NOT IN ('cancelado','rascunho','pendente','orcamento') AND deleted_at IS NULL
   AND order_date_kpi >= DATE '2026-03-01' AND order_date_kpi < DATE '2026-10-01'
 GROUP BY 2, 3
UNION ALL
SELECT 'congelado', NULL, to_char(mes, 'YYYY-MM'), sum(revenue_month)
  FROM public.carteira_positivacao_snapshot WHERE mes >= DATE '2026-03-01' GROUP BY 3
UNION ALL
SELECT 'kpi_antes_app', id, order_date_kpi::text, total
  FROM public.sales_orders a
 WHERE a.hash_payload IS NULL AND a.omie_pedido_id IS NOT NULL AND a.order_date_kpi IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.sales_orders i WHERE i.account = a.account AND i.hash_payload LIKE 'omie\_%'
                 AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id)
ORDER BY 1, 3, 2;
SQL
echo "exit=$?"; grep -c '^kpi_antes_app;' docs/historico/anexos/gemeos-antes.csv
```
Expected: `exit=0` e `22` (as 22 datas que o backfill zera — o registro de reversão).

- [ ] **Step 6: Ensaio na prod (roda e faz ROLLBACK)**

Run: `bun run db:aplicar supabase/migrations/<TS>_sales_orders_gemeo_importado_contagem_unica.sql --ensaio; echo "exit=$?"`
Expected: `exit=0` (postcondição verde contra os dados reais; nada gravado). `4` = a postcondição ou um lock recusou: ler a mensagem, não seguir.

- [ ] **Step 7: Commit dos gerados e do retrato**

```bash
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql docs/historico/anexos/gemeos-antes.csv
git commit -m "chore(audit): migration dos gêmeos no inventário + retrato ANTES para a validação externa

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Histórico, `database.md` e PR em DRAFT

**Files:**
- Create: `docs/historico/gemeos-push-pull-contagem-unica.md`
- Modify: `docs/historico/README.md` (1 linha no índice, depois da de `venda-empurrada-sem-gemeo.md`)
- Modify: `docs/agent/database.md` (o bullet "`sales_orders` tem GÊMEOS push/pull", §5)

- [ ] **Step 1: Escrever o histórico** — seções: *O que se mediu* (tabela da spec §2 + as 4 correções da §3), *A decisão* (D1–D4), *O conserto* (coluna, triggers, índice, CHECK, backfill), *A prova* (29 asserts, 8 sabotagens, os 2 idiomas, o spike S1–S9 com o deadlock S9), *Reversão* (aponta `anexos/gemeos-antes.csv` e o SQL: `DROP TRIGGER` ×3, `DROP INDEX` ×2, `ALTER TABLE … DROP CONSTRAINT sales_orders_gemeo_e_recibo`, `ALTER TABLE … DROP COLUMN gemeo_importado_id`, `UPDATE … SET order_date_kpi = <data do anexo> WHERE id = <id do anexo>` — founder, SQL Editor), *Limites conhecidos* (Review Focus 4 e 5; os 12 consumidores por `created_at`), *O que o PR do kpi precisa* (spec §8), *Codex* (`desenho=sem-codex …`, `REVISÃO INDEPENDENTE PENDENTE`), *Lições* (1. o congelado que parecia duplicado estava incompleto; 2. "não é a mesma venda" — pedido reaproveitado no Omie; 3. o deadlock só aparece com kpi gravado DEPOIS do pid).

- [ ] **Step 2: Atualizar o bullet do `database.md` §5** — trocar o texto atual por:

```markdown
- ⚠️ **`sales_orders` tem GÊMEOS push/pull — resolvidos pela MARCA na linha do app (desde `<TS>`).** O pedido que o app empurra ao Omie volta pelo importador como OUTRA linha (mesmo `(account, omie_pedido_id)`, hash `omie_…`). A importada é a autoridade; a do app vira recibo: `gemeo_importado_id` aponta para a importada e o `order_date_kpi` dela fica NULO (triggers `trg_sales_orders_gemeo_*`, para qualquer escritor), e `uniq_sales_orders_kpi_por_pedido_omie` impede 2 linhas com kpi no mesmo pedido. ⇒ o app PODE gravar kpi, desde que **no INSERT ou no MESMO UPDATE do write-back que seta o pid** — kpi gravado num UPDATE posterior de linha já empurrada inverte a ordem de lock com o importador (40P01, sem duplicata). Consumidor por `created_at`/`COALESCE` ainda conta a linha do app: filtre `gemeo_importado_id IS NULL` ou date só por kpi. → [gemeos-push-pull-contagem-unica.md](../historico/gemeos-push-pull-contagem-unica.md)
```

- [ ] **Step 3: Índice do histórico** — linha nova em `docs/historico/README.md`:

```markdown
| [gemeos-push-pull-contagem-unica.md](gemeos-push-pull-contagem-unica.md) | 2026-10-01: o chip 1 do irmão acima — a venda empurrada pelo app e o gêmeo do importador contam **1×** na fonte: ponteiro + kpi nulo no recibo, índice único de kpi por pedido Omie, triggers com advisory lock. Abril −R$ 12.840,46, 0 positivação; o congelado de abril estava incompleto, não duplicado. |
```

- [ ] **Step 4: Commit, push e PR DRAFT**

```bash
git add docs/historico/gemeos-push-pull-contagem-unica.md docs/historico/README.md docs/agent/database.md
git commit -m "docs(historico): gêmeos push/pull — medição, decisão, prova e reversão [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git fetch -q origin main && git log --oneline HEAD..origin/main | head -20   # re-conferir colisão antes do PR
git push -u origin HEAD
gh pr create --draft --title "fix(sales-orders): gêmeos push/pull contam 1× na fonte [money-path]" --body-file /tmp/pr-gemeos.md
```

Corpo (`/tmp/pr-gemeos.md`): resumo; efeito medido (−R$ 12.840,46 em abril, 0 positivação, 0 "1ª compra"); `## ⚠️ ATENÇÃO: migration manual` (merge NÃO aplica; a sessão aplica via `db:aplicar` depois do Codex; ensaio verde na Task 3); prova + falsificação (contagens); `Codex: desenho=sem-codex (SALDO_ALTO 86%, Caminho B — spec §7) · código=? · extra=nenhum` + `REVISÃO INDEPENDENTE PENDENTE — adversarial no diff após 03/10 19:11; PR fica DRAFT até lá`; fora do escopo (spec §9); `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 5: Ligar o monitor do app** — `ccd_pr.get_status` (bind se preciso) e `set_monitor` com `auto_fix` + `address_comments`.

### Task 5: Codex adversarial no diff (a partir de 03/10 19:11)

- [ ] **Step 1: Montar o prompt** — `scratchpad/codex-adversarial.md` com o filesystem boundary, a proibição do `schema-snapshot.sql`, a seção `RÉGUA:` da spec §7 (verbatim), os fatos medidos da spec §2–§3, e: "revise o DIFF desta branch contra origin/main (`git diff origin/main...HEAD -- supabase/migrations db/test-gemeos-push-pull-contagem-unica.sh`); tente quebrar corrida, semântica de trigger, a prova (onde passaria verde por cegueira) e a ordem irreversível; P0/P1/P2 com evidência".
- [ ] **Step 2: Rodar em background** — `scripts/codex-async.sh -r max -t 1500 - < scratchpad/codex-adversarial.md > scratchpad/codex-adversarial.out 2>&1` com `run_in_background: true`. Exit 79/75 de novo → PR segue DRAFT; não pular.
- [ ] **Step 3: Apresentar o parecer CRU + a calibração SEPARADA** (o que o Codex disse × o que eu decido) e tratar os achados. Mudança na migration antes do merge/apply: `git reset --soft` do commit da migration, reescrever, rodar Task 2 Steps 3–5 de novo, recommitar (force-push na branch do PR). Registrar no PR `código=<id·pp>` copiando o cabeçalho do `codex-async.sh`.

### Task 6: Merge, apply e validação externa

- [ ] **Step 1: Pronto para merge** — `gh pr ready <nº>`; CI `validate` verde → auto-merge (squash).
- [ ] **Step 2: Sincronizar e aplicar** — worktree na `origin/main`; `bun run db:aplicar supabase/migrations/<TS>_sales_orders_gemeo_importado_contagem_unica.sql; echo "exit=$?"` → Expected `exit=0` (3 = já aplicado; 4 = rollback provado; 5 = DESCONHECIDO → não reaplicar, investigar).
- [ ] **Step 3: Validação externa (psql-ro, outra conexão)** — rodar a MESMA consulta da Task 3 Step 5 para `docs/historico/anexos/gemeos-depois.csv` e comparar com o `antes`:

```bash
diff <(grep '^canonico_mes;' docs/historico/anexos/gemeos-antes.csv) <(grep '^canonico_mes;' docs/historico/anexos/gemeos-depois.csv)
diff <(grep '^congelado;' docs/historico/anexos/gemeos-antes.csv) <(grep '^congelado;' docs/historico/anexos/gemeos-depois.csv); echo "congelado_igual_exit=$?"
```
Expected (corrigido na revisão final — o anexo tem `canonico_mes`/`congelado` por mês; o retrato por cliente ficou fora do git): só `canonico_mes;;2026-04` muda (509153.36 → 496312.90, −12.840,46, mesma contagem de clientes); os outros meses iguais a um retrato "antes" tirado na hora do apply (setembro/outubro andam com as importações novas); `congelado_igual_exit=0`; os 22 ids `kpi_antes_app` com kpi nulo e ponteiro; e `SELECT count(*) FROM sales_orders WHERE gemeo_importado_id IS NOT NULL` = 25, `… AND order_date_kpi IS NOT NULL` = 0.
- [ ] **Step 4: Fechar o histórico** — anexar o `depois`, a saída do `db:aplicar` e a validação ao histórico; PR de docs (não-draft, auto-merge).
