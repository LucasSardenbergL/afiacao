#!/usr/bin/env bash
# PROVA PG17 com FALSIFICAÇÃO — DRE v1.17: 1.03.01 (devolução de compra) → cmv (linha redutora).
#   PG_LOCALE=C LC_ALL=C bash db/test-fin-dre-cmv-redutora.sh > "$TMPDIR/t.log" 2>&1; echo "exit=$?"
#   PG_LOCALE=pt_BR.UTF-8 LC_ALL=pt_BR.UTF-8 bash db/test-fin-dre-cmv-redutora.sh …
# Cobre db/2026-11-27-fin-dre-cmv-redutora.sql aplicado como o `db:aplicar` (1 transação).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5487}"
SLUG="fin-dre-cmv-redutora"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
PG_LOCALE="${PG_LOCALE:-C}"
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$PG_LOCALE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

SCRIPT="$REPO_ROOT/db/2026-11-27-fin-dre-cmv-redutora.sql"
[ -f "$SCRIPT" ] || { echo "FALTA $SCRIPT"; exit 2; }
FONTE="$(sed -n "s/^  v_fonte_esperada  constant text := '\([0-9a-f]\{64\}\)';\$/\1/p" "$SCRIPT")"
VERSAO="$(sed -n "s/^  v_versao_esperada constant text := '\([^']*\)';\$/\1/p" "$SCRIPT")"
[ ${#FONTE} -eq 64 ] && [ -n "$VERSAO" ] || { echo "versão/fonte esperadas não encontradas no script"; exit 2; }
# A fonte do script tem de ser a do fingerprint COMMITADO da edge (senão a precondição barraria a prod).
FP_REPO="$(grep '"omie-financeiro"' "$REPO_ROOT/supabase/functions/_shared/sonda-fingerprints.ts" | grep -o '[0-9a-f]\{64\}')"
VERSAO_REPO="$(sed -n 's/^export const VERSAO = "\([^"]*\)";$/\1/p' "$REPO_ROOT/supabase/functions/omie-financeiro/versao.ts")"
echo "═══ setup pronto (PG17 :$PORT, locale $PG_LOCALE) ═══"
eq "Z0 lc_collate do cluster é o pedido" "$(Pq -c "SELECT datcollate FROM pg_database WHERE datname = current_database();")" "$PG_LOCALE"
eq "Z1 fonte do script = fingerprint commitado da edge" "$FONTE" "$FP_REPO"
eq "Z2 versão do script = VERSAO commitada da edge" "$VERSAO" "$VERSAO_REPO"

# Tabelas como em PROD (psql-ro 2026-11-27): UNIQUE(company, omie_codigo), notas/updated_at.
P -q <<'SQL'
CREATE TABLE public.fin_categoria_dre_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL, omie_codigo text NOT NULL, dre_linha text NOT NULL, notas text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (company, omie_codigo));
CREATE TABLE public.fin_categorias (company text, omie_codigo text, descricao text);
CREATE TABLE public.deploy_atestacoes (request_id text, observado_em timestamptz, edge text, versao text, fonte text, via text);
CREATE FUNCTION public.deploy_atestacoes_janela_viva()
  RETURNS TABLE(request_id text, observado_em timestamptz, edge text, versao text, fonte text, via text)
  LANGUAGE sql AS $$ SELECT NULL::text, NULL::timestamptz, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $$;
SQL
seed() {
  P -q <<'SQL'
TRUNCATE public.fin_categoria_dre_mapping, public.fin_categorias, public.deploy_atestacoes;
INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha, notas) VALUES
  ('colacor', '1.03.01', 'outras_receitas', 'mapa-proprio 2026-11-22'),
  ('oben',    '1.03.01', 'outras_receitas', 'mapa-proprio 2026-11-22'),
  ('colacor', '1.01.01', 'receita_bruta',   'controle');
INSERT INTO public.fin_categorias VALUES
  ('colacor', '1.03.01', 'Devoluções de Compra de Mercadoria de Revenda'),
  ('oben',    '1.03.01', 'Devoluções de Compra de Mercadoria de Revenda');
SQL
}
atesta() { P -q -c "INSERT INTO public.deploy_atestacoes VALUES ('r-$RANDOM', now(), 'omie-financeiro', '$1', '$2', 'sonda');"; }
aplica() { P -q --single-transaction -f "${1:-$SCRIPT}"; }
L() { Pq -c "SELECT dre_linha FROM public.fin_categoria_dre_mapping WHERE company='$1' AND omie_codigo='$2';"; }
falha_com() { # $1 rótulo · $2 marca esperada · $3 arquivo (opcional)
  local out
  if out=$(aplica "${3:-}" 2>&1); then bad "$1: APLICOU"; return; fi
  case "$out" in *"$2"*) ok "$1: abortou ($2)" ;; *) bad "$1: outro motivo: ${out:0:200}" ;; esac
  eq "$1: rollback (colacor intacta)" "$(L colacor 1.03.01)" "outras_receitas"
  eq "$1: rollback (oben intacta)" "$(L oben 1.03.01)" "outras_receitas"
}

echo "── precondição ──"
seed;                                   falha_com "P1 sem atestação" "precondicao: omie-financeiro servida"
seed; atesta "v1.16-mov-chave-ncodbaixa" "$FONTE"; falha_com "P2 motor v1.16 (soma sem sinal)" "precondicao: omie-financeiro servida"
seed; atesta "$VERSAO" "$(printf '0%.0s' {1..64})"; falha_com "P3 v1.17 com fonte errada" "precondicao: omie-financeiro servida"

echo "── aplicação ──"
seed; atesta "$VERSAO" "$FONTE"
aplica && ok "A0 aplicou (controle verde, mesma invocação)"
eq "A1 colacor 1.03.01 → cmv" "$(L colacor 1.03.01)" "cmv"
eq "A2 oben 1.03.01 → cmv" "$(L oben 1.03.01)" "cmv"
eq "A3 controle intocado" "$(L colacor 1.01.01)" "receita_bruta"
eq "A4 nota registra a decisão" "$(Pq -c "SELECT count(*) FROM public.fin_categoria_dre_mapping WHERE omie_codigo='1.03.01' AND notas LIKE 'cmv-redutora 2026-11-27%';")" "2"
aplica && ok "A5 reaplicação idempotente"
eq "A6 continua 2 pares em cmv" "$(Pq -c "SELECT count(*) FROM public.fin_categoria_dre_mapping WHERE omie_codigo='1.03.01' AND dre_linha='cmv';")" "2"

echo "── anti-deriva ──"
seed; atesta "$VERSAO" "$FONTE"
P -q -c "UPDATE public.fin_categoria_dre_mapping SET dre_linha='despesas_administrativas' WHERE company='oben' AND omie_codigo='1.03.01';"
if out=$(aplica 2>&1); then bad "D1 deriva: APLICOU"; else case "$out" in *"postcondicao: 1 de 2"*) ok "D1 deriva (oben mudou por outra mão) aborta" ;; *) bad "D1 outro motivo: ${out:0:200}" ;; esac; fi
eq "D1 rollback (colacor intacta)" "$(L colacor 1.03.01)" "outras_receitas"
eq "D1 deriva preservada (oben)" "$(L oben 1.03.01)" "despesas_administrativas"
seed; atesta "$VERSAO" "$FONTE"
P -q -c "UPDATE public.fin_categorias SET descricao='Entrada de Aplicação' WHERE company='colacor' AND omie_codigo='1.03.01';"
falha_com "D2 descrição do Omie mudou" "postcondicao: descricao do Omie"

echo "── falsificação (cópias sabotadas têm de ficar VERMELHAS) ──"
sab() { # $1 rótulo · $2 sed · $3 marca esperada
  local f="$TMPD/sab.sql"
  sed "$2" "$SCRIPT" > "$f"
  if cmp -s "$f" "$SCRIPT"; then bad "F-$1: sed não aplicou"; return; fi
  seed; atesta "v1.16-mov-chave-ncodbaixa" "$FONTE"
  P -q -c "UPDATE public.fin_categorias SET descricao='Outra' WHERE company='oben' AND omie_codigo='1.03.01';"
  if out=$(aplica "$f" 2>&1); then bad "F-$1: sabotada PASSOU"; return; fi
  case "$out" in *"$3"*) ok "F-$1: ficou vermelha ($3)" ;; *) bad "F-$1: outro motivo: ${out:0:200}" ;; esac
}
sab "sem-precondicao" "s/  IF v.versao IS DISTINCT FROM v_versao_esperada OR v.fonte IS DISTINCT FROM v_fonte_esperada THEN/  IF false THEN/" "postcondicao: descricao do Omie"
sab "sem-post-descricao" "s/  IF v_desc IS DISTINCT FROM 2 THEN/  IF false THEN/" "precondicao: omie-financeiro servida"

echo "═══ $PASS ok · $FAIL falha(s) ═══"
[ "$FAIL" -eq 0 ] && echo "TESTE_CMV_REDUTORA_OK"
[ "$FAIL" -eq 0 ]
