#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261111140000_sayerlack_conferir_portal.sql (revisão 2, item 5.2 / 5B, fatia 1)
# ║      bash db/test-sayerlack-conferir-portal.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-sayerlack-conferir-portal.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sayerlack-conferir-portal.sh   (2º idioma)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║   A  aplica (sobre a cadeia REAL da RPC de importar) com o NOTICE de fim, idempotente, ACL: a porta só para
# ║      service_role; retrato/divergência sem INSERT/UPDATE para ninguém além da porta.
# ║   I  a importação grava o retrato da leitura que criou o pedido, na MESMA transação.
# ║   C  conferência: SKU/qtde contra o próprio pedido (qtde_final × fator), valor por SKU, total e condição contra
# ║      o retrato; ausente nunca é "bateu"; o mesmo diff não empilha; leitura antiga não fecha a aberta; portal
# ║      voltou fecha e solta o gate; claim pendente não impede gravar o gate; recusa sem PO/status; entrada 22023.
# ║   K  claim: recusa divergência aberta no MESMO WHERE que grava — inclusive a gravada durante a espera pela trava
# ║      (2 conexões); mensagem 'alterado_no_portal' com a pendência.
# ║  Diário: docs/historico/importar-pedido-portal-sayerlack.md
# ╚═════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5781}"
SLUG="sayerlack-conferir-portal"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C; o idioma do SERVIDOR vem de $LOC
M="$REPO_ROOT/supabase/migrations"
MIG_REAL="$M/20261111140000_sayerlack_conferir_portal.sql"
CADEIA="$M/20260905090000_sayerlack_custo_portal_cas.sql $M/20260906193522_valor_total_portal_provado.sql
        $M/20261006120000_preco_exato_po_sayerlack_ipi.sql $M/20261014120000_sayerlack_importar_pedido_portal.sql
        $M/20261016013000_sayerlack_importar_pedido_portal_safeupdate.sql $M/20261106140000_sayerlack_importar_portal_revisao.sql
        $M/20261107140000_sayerlack_condicao_portal_onda2.sql $M/20261109120000_sayerlack_condicao_sem_c.sql"
for f in $CADEIA "$MIG_REAL"; do [ -f "$f" ] || { echo "INFRA: ausente: $f"; exit 1; }; done
# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e
# cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA, (3) o assert declarado estava verde
# no controle e virou vermelho, (4) sem ERRO de SQL que o controle não tem. Uma camada por vez.
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_gate_claim:K1,K3 gate_por_not_exists:K3 sem_retrato_importacao:I1 sem_ordem:C9
              ausente_vira_bateu:C7 sem_full_join:C5 sem_valor_item:C3 tolerancia_frouxa:C3b sem_condicao:C4
              sem_total:C4b mesmo_diff_empilha:C2b sem_status:C11 pendente_nao_grava:C12"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    vermelhos="$(grep -Eo '^  ❌ [A-Z][0-9]+b? ' "$log" | grep -Eo '[A-Z][0-9]+b?' | tr '\n' ' ' || true)"
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
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# SETUP
# ══════════════════════════════════════════════════════════════════
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone='UTC';" >/dev/null
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA -q -v VERBOSITY=verbose "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
sqlstate() { local s; s="$(grep -o -E '^[A-Z]+:  [0-9A-Z]{5}' | grep -o -E '[0-9A-Z]{5}$' | head -1 || true)"; printf '%s' "${s:-SEM_SQLSTATE}"; }
trocar() {  # $1 arquivo, $2 de, $3 para — o padrão tem de ocorrer exatamente 1×
  python3 -I - "$1" "$2" "$3" <<'PYSAB'
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, 'w', encoding='utf-8').write(s.replace(de, para))
PYSAB
}

# ── Sabotagem (no modo normal, SABOTAGEM vazia = a migration real) ──
MIG="$TMP/migration.sql"
cp "$MIG_REAL" "$MIG"
SAB="${SABOTAGEM:-}"
case "$SAB" in
  "") ;;
  sem_gate_claim)
    trocar "$MIG" "     AND portal_divergencia_aberta_id IS NULL
  RETURNING" "  RETURNING" ;;
  gate_por_not_exists)  # o desenho ingênuo: o veto lê a OUTRA tabela (snapshot velho no EvalPlanQual)
    trocar "$MIG" "     AND portal_divergencia_aberta_id IS NULL
  RETURNING" "     AND NOT EXISTS (SELECT 1 FROM public.sayerlack_portal_divergencia d
                      WHERE d.pedido_id = p_pedido_id AND d.resolvida_em IS NULL)
     AND 'portal_divergencia_aberta_id IS NULL' IS NOT NULL
  RETURNING" ;;
  sem_retrato_importacao)
    trocar "$MIG" "  v_conf := public.sayerlack_conferir_portal(" "  v_conf := '{\"conferido\":true,\"divergente\":false}'::jsonb; PERFORM jsonb_build_array("
    trocar "$MIG" "    RAISE EXCEPTION 'C7 FALHOU: a importação não grava o retrato';" "    NULL;" ;;
  sem_ordem)
    trocar "$MIG" "  IF v_aberta.id IS NOT NULL AND (v_de IS NULL OR v_aberta.lido_ate IS NULL OR v_de <= v_aberta.lido_ate) THEN" "  IF false THEN" ;;
  ausente_vira_bateu)
    trocar "$MIG" "    SELECT 'item_sem_mapa_portal', 'item ' || a.id, NULL, NULL FROM app_item a WHERE a.ausente" "    SELECT 'item_sem_mapa_portal', 'item ' || a.id, NULL, NULL FROM app_item a WHERE false" ;;
  sem_full_join)
    trocar "$MIG" "      FROM app a FULL JOIN portal p ON p.sku = a.sku" "      FROM app a LEFT JOIN portal p ON p.sku = a.sku" ;;
  sem_valor_item)
    trocar "$MIG" "     WHERE p.sku IS NULL OR t.sku IS NULL OR abs(p.v - t.v) > 0.005" "     WHERE p.sku IS NULL OR t.sku IS NULL" ;;
  tolerancia_frouxa)
    trocar "$MIG" "     WHERE p.sku IS NULL OR t.sku IS NULL OR abs(p.v - t.v) > 0.005" "     WHERE p.sku IS NULL OR t.sku IS NULL OR abs(p.v - t.v) > 1.00" ;;
  sem_condicao)
    trocar "$MIG" "    SELECT 'condicao', NULL, NULL, NULL WHERE v_ret.condicao_normalizada IS DISTINCT FROM v_norm" "    SELECT 'condicao', NULL, NULL, NULL WHERE false" ;;
  sem_total)
    trocar "$MIG" "     WHERE abs(v_ret.valor_total - (p_leitura->>'valor_total')::numeric) > 0.005" "     WHERE false" ;;
  mesmo_diff_empilha)
    trocar "$MIG" "  IF v_diff IS NOT NULL AND v_aberta.id IS NOT NULL AND v_aberta.diferencas = v_diff" "  IF false AND v_aberta.diferencas = v_diff" ;;
  sem_status)
    trocar "$MIG" "  IF r.status IS NULL OR r.status NOT IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'status_nao_conferivel'" "  IF r.status IS NULL THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'status_nao_conferivel'" ;;
  pendente_nao_grava)  # o desenho da 1ª rodada: claim aberto ⇒ sai sem escrever (Codex 5.2 P1)
    trocar "$MIG" "  IF r.status IS NULL OR r.status NOT IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'status_nao_conferivel'" "  IF r.disparo_claim_em IS NOT NULL THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'disparo_pendente');
  END IF;
  IF r.status IS NULL OR r.status NOT IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'status_nao_conferivel'" ;;
  *) echo "INFRA: sabotagem desconhecida: $SAB"; exit 1 ;;
esac
if [ -n "$SAB" ]; then
  if cmp -s "$MIG" "$MIG_REAL"; then echo "INFRA: sabotagem $SAB inerte"; exit 1; fi
  echo "SABOTAGEM ATIVA em $SAB"
fi

# ── Banco: papéis do Supabase + o recorte que a cadeia de importar e esta migration tocam ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
-- As colunas de prod que a importação, a conferência e o claim leem/escrevem (psql-ro 2026-11-09).
CREATE TABLE public.pedido_compra_sugerido (
  id bigserial PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text, data_ciclo date NOT NULL DEFAULT current_date,
  valor_total numeric NOT NULL DEFAULT 0, num_skus integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'pendente_aprovacao',
  canal_usado text, resposta_canal jsonb, omie_pedido_compra_numero text, omie_pedido_compra_id text,
  aprovado_por uuid, aprovado_em timestamptz, condicao_pagamento_codigo text, condicao_pagamento_descricao text,
  num_parcelas integer, condicao_origem text, status_envio_portal text NOT NULL DEFAULT 'nao_aplicavel',
  enviado_portal_em timestamptz, portal_protocolo text, portal_data_entrega date, dias_parcelas text,
  disparo_claim_em timestamptz, disparo_claim_por text, portal_situacao_codigo text, portal_situacao_protocolo text,
  portal_situacao_em timestamptz
);
CREATE TABLE public.pedido_compra_item (
  id bigserial PRIMARY KEY, pedido_id bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text NOT NULL, sku_descricao text, qtde_sugerida numeric NOT NULL, qtde_final numeric,
  preco_unitario numeric, valor_linha numeric, teto_cobertura_aplicado boolean NOT NULL DEFAULT false,
  sku_portal_aprovado text, fator_portal_aprovado numeric
);
CREATE TABLE public.omie_products (omie_codigo_produto bigint NOT NULL, account text NOT NULL, ncm text, descricao text,
  UNIQUE (omie_codigo_produto, account));
CREATE TABLE public.sku_fornecedor_externo (
  id bigserial PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text NOT NULL, sku_omie text NOT NULL, sku_portal text,
  unidade_portal text NOT NULL DEFAULT 'UN', fator_conversao numeric NOT NULL DEFAULT 1, ativo boolean NOT NULL DEFAULT true
);
CREATE TABLE public.purchase_orders_tracking (id bigserial PRIMARY KEY, empresa text NOT NULL, numero_pedido text,
  numero_contrato_fornecedor text);
CREATE SCHEMA IF NOT EXISTS private;
CREATE FUNCTION private.cap_compras_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role IN ('employee','master')) $f$;
CREATE TABLE public.omie_condicao_pagamento_catalogo (empresa text NOT NULL, codigo text NOT NULL, descricao text,
  num_parcelas integer, ativo boolean NOT NULL DEFAULT true);
CREATE TABLE public.sayerlack_varredura_falha (protocolo text PRIMARY KEY, mensagem text, primeira_em timestamptz DEFAULT now(),
  ultima_em timestamptz DEFAULT now(), tentativas integer DEFAULT 1, notificado_em timestamptz, resolvido_em timestamptz);
-- 7.2: só a chave que a FK precisa.
CREATE TABLE public.sayerlack_portal_evidencia (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, protocolo text);
INSERT INTO public.sayerlack_portal_evidencia (protocolo) VALUES ('2140603');
GRANT SELECT ON public.pedido_compra_sugerido, public.pedido_compra_item, public.omie_products TO service_role;
GRANT UPDATE ON public.pedido_compra_sugerido TO service_role, authenticated;
INSERT INTO public.omie_condicao_pagamento_catalogo (empresa, codigo, descricao, num_parcelas, ativo) VALUES
  ('OBEN', '000', 'A Vista', 1, true), ('OBEN', 'A07', 'Para 7 dias', 1, true), ('OBEN', 'A28', 'Para 28 dias', 1, true),
  ('OBEN', 'A30', 'Para 30 dias (C)', 1, true), ('OBEN', 'T54', 'Para 30 dias', 1, true);
INSERT INTO public.sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, unidade_portal, fator_conversao, ativo) VALUES
  ('OBEN', 'RENNER SAYERLACK S/A', '12101724100', 'DFA.4080LT', 'LT', 1, true);
INSERT INTO public.omie_products (omie_codigo_produto, account, ncm, descricao) VALUES
  (12101724100, 'oben', '3814.00.90', 'DILUENTE PU DFA.4080LT');
INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('11111111-1111-1111-1111-111111111111', 'employee');
SQL
for f in $CADEIA; do P -q -f "$f" >/dev/null; done

echo "── A: aplicar ──"
if out="$(P -1 -f "$MIG" 2>&1)"; then
  case "$out" in *"CONFERIR_PORTAL_POS_OK"*) ok "A1 migration aplica com o NOTICE positivo de fim";; *) bad "A1 sem o NOTICE de fim";; esac
else bad "A1 migration NÃO aplicou: $(printf '%s' "$out" | grep -m1 -E 'ERROR|FALHOU' || true)"; fi
if P -1 -q -f "$MIG" >/dev/null 2>&1; then ok "A2 re-aplicar é idempotente"; else bad "A2 re-aplicar falhou"; fi
FN="public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)"
eq "A3 porta fechada p/ anon+authenticated, aberta p/ service_role" "$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE')::text || has_function_privilege('authenticated','$FN','EXECUTE')::text || has_function_privilege('service_role','$FN','EXECUTE')::text")" "falsefalsetrue"
eq "A4 service_role não escreve no retrato nem na divergência (só a porta) = 42501" "$(Pq -c "SET ROLE service_role; INSERT INTO public.sayerlack_portal_divergencia (pedido_id, protocolo, retrato_versao, leitura, diferencas) VALUES (1, 'x', 1, '{}', '[{}]')" 2>&1 | sqlstate)" "42501"

# Leitura: $1 protocolo · $2 itens (json) · $3 total · $4 condição · $5 minuto do lido_de (lido_ate = +1 min)
L() { printf '{"protocolo":"%s","itens":%s,"valor_total":%s,"condicao":"%s","lido_de":"2026-11-09T10:%02d:00Z","lido_ate":"2026-11-09T10:%02d:30Z"}' "$1" "$2" "$3" "$4" "$5" "$5"; }
C() { Pq -c "SELECT public.sayerlack_conferir_portal($1, '$2'::jsonb, ${3:-NULL}, '${4:-redisparo}')" 2>&1 || true; }
campo() { python3 -I -c "import json,sys; v=json.load(sys.stdin).get('$1'); print('null' if v is None else (json.dumps(v,sort_keys=True) if isinstance(v,(list,dict)) else str(v).lower()))" 2>&1; }
tipos() { python3 -I -c "import json,sys; d=json.load(sys.stdin, parse_float=str).get('diferencas') or []; print(';'.join(f\"{x['tipo']}:{x['sku']}:{x['app']}>{x['portal']}\" for x in d))" 2>&1; }
GATE() { Pq -c "SELECT COALESCE(portal_divergencia_aberta_id::text,'-') FROM public.pedido_compra_sugerido WHERE id = $1"; }
NDIV() { Pq -c "SELECT count(*) || '/' || count(*) FILTER (WHERE resolvida_em IS NULL) FROM public.sayerlack_portal_divergencia WHERE pedido_id = $1"; }
K() { Pq -c "SELECT public.reposicao_claim_disparo($1, 'prova')" 2>&1 || true; }

echo "── I: a importação grava o retrato ──"
DFA='[{"sku_portal":"DFA.4080LT","qtde_portal":16,"valor_mercadoria":4865.5584}]'
r="$(Pq -c "SELECT public.sayerlack_importar_pedido_portal('2140603', '2026-10-26', 5181.82, '$DFA'::jsonb, '11111111-1111-1111-1111-111111111111', '70 - 7 DIAS')" 2>&1 || true)"
P1="$(printf '%s' "$r" | campo pedido_id)"
eq "I1 importou e o retrato v1 nasceu da leitura que criou o pedido" "$(Pq -c "SELECT versao || '|' || origem || '|' || valor_total || '|' || condicao_normalizada || '|' || (itens->0->>'sku_portal') || '|' || (itens->0->>'qtde_portal') FROM public.sayerlack_portal_retrato WHERE pedido_id = ${P1:-0}" 2>&1)" "1|importacao|5181.82|7 DIAS|DFA.4080LT|16"
eq "I2 importação nova não abre divergência nem gate" "$(NDIV "${P1:-0}")|$(GATE "${P1:-0}")" "0/0|-"
L1="$(L 2140603 "$DFA" 5181.82 "70 - 7 DIAS" 1)"

echo "── C: conferência ──"
r="$(C "$P1" "$L1")"
eq "C1 mesma leitura no redisparo: bate, não recria o retrato" "$(printf '%s' "$r" | campo divergente)|$(printf '%s' "$r" | campo retrato_criado)|$(GATE "$P1")" "false|false|-"
L2="$(L 2140603 '[{"sku_portal":"DFA.4080LT","qtde_portal":17,"valor_mercadoria":4865.5584}]' 5181.82 "70 - 7 DIAS" 2)"
r="$(C "$P1" "$L2")"; D1="$(printf '%s' "$r" | campo divergencia_id)"
eq "C2 quantidade mudou no portal: divergência com o diff e gate na linha" "$(printf '%s' "$r" | tipos)|$(GATE "$P1")" "quantidade:DFA.4080LT:16>17|$D1"
r="$(C "$P1" "$(L 2140603 '[{"sku_portal":"DFA.4080LT","qtde_portal":17,"valor_mercadoria":4865.5584}]' 5181.82 "70 - 7 DIAS" 3)")"
eq "C2b o mesmo diff de novo não empilha linha" "$(printf '%s' "$r" | campo divergencia_id)|$(NDIV "$P1")" "$D1|1/1"
eq "K1 claim recusa o pedido com divergência aberta e não grava o claim" "$(K "$P1" | campo bloqueio)|$(Pq -c "SELECT COALESCE(disparo_claim_em::text,'-') FROM public.pedido_compra_sugerido WHERE id = $P1")" "alterado_no_portal|-"
r="$(C "$P1" "$(L 2140603 "$DFA" 5181.82 "70 - 7 DIAS" 2)")"
eq "C9 leitura NÃO posterior à da aberta (lido_de ≤ lido_ate dela) não fecha: leitura_antiga, gate fica" "$(printf '%s' "$r" | campo motivo)|$(GATE "$P1")|$(NDIV "$P1")" "leitura_antiga|$D1|1/1"
r="$(C "$P1" "$(L 2140603 "$DFA" 5181.82 "70 - 7 DIAS" 5)")"
eq "C10 portal voltou (leitura posterior): fecha, solta o gate, o claim volta a valer" "$(printf '%s' "$r" | campo divergente)|$(GATE "$P1")|$(Pq -c "SELECT resolucao FROM public.sayerlack_portal_divergencia WHERE id = $D1")|$(K "$P1" | campo claimed)" "false|-|portal_voltou|true"

# Pedidos nascidos no app (sem retrato): o SKU do portal e o fator vêm do selo da aprovação.
P -q <<'SQL' >/dev/null
INSERT INTO public.pedido_compra_sugerido (id, empresa, status, portal_protocolo, omie_pedido_compra_id, disparo_claim_em) VALUES
  (101, 'OBEN', 'falha_envio',                 '2150101', NULL,   NULL),  -- base: 2 SKUs
  (102, 'OBEN', 'aprovado_aguardando_disparo', '2150102', NULL,   NULL),  -- item sem selo do portal
  (103, 'OBEN', 'aprovado_aguardando_disparo', '2150103', NULL,   NULL),  -- portal ganha/perde SKU
  (104, 'OBEN', 'aprovado_aguardando_disparo', '2150104', '9104', NULL),  -- já tem PO
  (105, 'OBEN', 'disparado',                   '2150105', NULL,   NULL),  -- status não conferível
  (106, 'OBEN', 'aprovado_aguardando_disparo', '2150106', NULL,   now() - interval '10 minutes');  -- claim aberto
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final, sku_portal_aprovado, fator_portal_aprovado)
SELECT p, s.omie, s.q, s.q, s.portal, s.fator FROM unnest(ARRAY[101,103,104,105,106]) AS p,
  (VALUES ('1', 10::numeric, 'cx.cinco', 0.2::numeric), ('2', 1, 'GL.UM', 1)) AS s(omie, q, portal, fator);
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final, sku_portal_aprovado, fator_portal_aprovado) VALUES
  (102, '1', 10, 10, 'CX.CINCO', 0.2), (102, '2', 1, 1, NULL, NULL);
SQL
IT='[{"sku_portal":"CX.CINCO","qtde_portal":2,"valor_mercadoria":100.00},{"sku_portal":"GL.UM","qtde_portal":1,"valor_mercadoria":50.00}]'
r="$(C 101 "$(L 2150101 "$IT" 160.00 "70 - 7 DIAS" 1)" 1)"
eq "C1b pedido do app, 1ª leitura: qtde_final × fator (10 × 0,2 = 2 CX) bate e a leitura vira o retrato" "$(printf '%s' "$r" | campo divergente)|$(printf '%s' "$r" | campo retrato_criado)|$(Pq -c "SELECT origem || '|' || evidencia_id FROM public.sayerlack_portal_retrato WHERE pedido_id = 101")" "false|true|redisparo|1"
r="$(C 101 "$(L 2150101 '[{"sku_portal":"CX.CINCO","qtde_portal":2,"valor_mercadoria":100.02},{"sku_portal":"GL.UM","qtde_portal":1,"valor_mercadoria":50.00}]' 160.00 "70 - 7 DIAS" 2)")"
eq "C3 preço de um SKU mudou 2 centavos (mesmo total): diferença de valor por item" "$(printf '%s' "$r" | tipos)" "valor_item:CX.CINCO:100.00>100.02"
r="$(C 101 "$(L 2150101 '[{"sku_portal":"CX.CINCO","qtde_portal":2,"valor_mercadoria":100.50},{"sku_portal":"GL.UM","qtde_portal":1,"valor_mercadoria":50.00}]' 160.00 "70 - 7 DIAS" 3)")"
eq "C3b preço mudou 50 centavos: diferença (sem tolerância de reais)" "$(printf '%s' "$r" | tipos)|$(NDIV 101)" "valor_item:CX.CINCO:100.00>100.50|2/1"
r="$(C 101 "$(L 2150101 "$IT" 160.00 "28 - 28 DIAS" 4)")"
eq "C4 condição mudou: diferença de condição com os dois textos" "$(printf '%s' "$r" | tipos)" "condicao:None:70 - 7 DIAS>28 - 28 DIAS"
r="$(C 101 "$(L 2150101 "$IT" 161.30 "70 - 7 DIAS" 5)")"
eq "C4b total mudou (o IPI mora no total): diferença de total" "$(printf '%s' "$r" | tipos)" "valor_total:None:160.00>161.30"
r="$(C 101 "$(L 2150101 "$IT" 160.00 " 70 -  7 dias " 6)")"
eq "C4c mesma condição com caixa e espaços diferentes: bate (normalizada) e fecha a aberta" "$(printf '%s' "$r" | campo divergente)|$(GATE 101)|$(NDIV 101)" "false|-|4/0"
r="$(C 102 "$(L 2150102 "$IT" 160.00 "70 - 7 DIAS" 1)")"
eq "C7 item do pedido sem SKU do portal/fator: diferença 'sem mapa', nunca 'bateu'" "$(printf '%s' "$r" | python3 -I -c "import json,sys; print(','.join(sorted({x['tipo'] for x in json.load(sys.stdin)['diferencas']})))" 2>&1)" "item_sem_mapa_portal,sku_novo_no_portal"
r="$(C 103 "$(L 2150103 "$IT" 160.00 "70 - 7 DIAS" 1)")"
r="$(C 103 "$(L 2150103 '[{"sku_portal":"CX.CINCO","qtde_portal":2,"valor_mercadoria":100.00},{"sku_portal":"GL.UM","qtde_portal":1,"valor_mercadoria":50.00},{"sku_portal":"NOVO.LT","qtde_portal":3,"valor_mercadoria":9.00}]' 160.00 "70 - 7 DIAS" 2)")"
eq "C5 portal ganhou um SKU: sku novo e valor do item novo" "$(printf '%s' "$r" | tipos)" "sku_novo_no_portal:NOVO.LT:None>3;valor_item:NOVO.LT:None>9.00"
r="$(C 103 "$(L 2150103 '[{"sku_portal":"CX.CINCO","qtde_portal":2,"valor_mercadoria":100.00}]' 160.00 "70 - 7 DIAS" 3)")"
eq "C6 portal perdeu um SKU: substitui a aberta (sku fora do portal)" "$(printf '%s' "$r" | tipos)|$(NDIV 103)" "sku_fora_do_portal:GL.UM:1>None;valor_item:GL.UM:50.00>None|2/1"
eq "C8 pedido com PO: não confere" "$(C 104 "$(L 2150104 "$IT" 160.00 "70 - 7 DIAS" 1)" | campo motivo)" "tem_po"
eq "C11 status fora do disparo: não confere nem semeia" "$(C 105 "$(L 2150105 "$IT" 160.00 "70 - 7 DIAS" 1)" | campo motivo)|$(Pq -c "SELECT count(*) FROM public.sayerlack_portal_retrato WHERE pedido_id = 105")" "status_nao_conferivel|0"
r="$(C 106 "$(L 2150106 '[{"sku_portal":"CX.CINCO","qtde_portal":4,"valor_mercadoria":100.00},{"sku_portal":"GL.UM","qtde_portal":1,"valor_mercadoria":50.00}]' 160.00 "70 - 7 DIAS" 1)")"
eq "C12 claim aberto não impede: a divergência grava o gate e volta a pendência" "$(printf '%s' "$r" | campo divergente)|$([ "$(GATE 106)" != "-" ] && echo gate || echo sem-gate)|$([ "$(printf '%s' "$r" | campo pendente_desde)" != "null" ] && echo pendente || echo sem-pendente)" "true|gate|pendente"
r="$(K 106)"
eq "K2 claim com pendência + divergência: recusa 'alterado_no_portal' COM pendente_desde (a edge concilia só por consulta)" "$(printf '%s' "$r" | campo claimed)|$(printf '%s' "$r" | campo bloqueio)|$([ "$(printf '%s' "$r" | campo pendente_desde)" != "null" ] && echo pendente || echo sem-pendente)" "false|alterado_no_portal|pendente"

echo "── E: entrada ──"
eq "E1 leitura sem condição = 22023" "$(C 101 '{"protocolo":"2150101","itens":[{"sku_portal":"X","qtde_portal":1,"valor_mercadoria":1}],"valor_total":1}' | sqlstate)" "22023"
eq "E2 leitura de outro protocolo = 22023" "$(C 101 "$(L 2150199 "$IT" 160.00 "70 - 7 DIAS" 9)" | sqlstate)" "22023"
eq "E3 quantidade em texto = 22023 (sem 22P02)" "$(C 101 '{"protocolo":"2150101","itens":[{"sku_portal":"X","qtde_portal":"1","valor_mercadoria":1}],"valor_total":1,"condicao":"70 - 7 DIAS"}' | sqlstate)" "22023"
eq "E4 intervalo invertido = 22023" "$(C 101 '{"protocolo":"2150101","itens":[{"sku_portal":"X","qtde_portal":1,"valor_mercadoria":1}],"valor_total":1,"condicao":"70 - 7 DIAS","lido_de":"2026-11-09T11:00:00Z","lido_ate":"2026-11-09T10:00:00Z"}' | sqlstate)" "22023"
eq "E5 origem desconhecida = 22023" "$(C 101 "$(L 2150101 "$IT" 160.00 "70 - 7 DIAS" 9)" NULL tela | sqlstate)" "22023"
eq "E6 authenticated não executa = 42501" "$(Pq -c "SET ROLE authenticated; SELECT public.sayerlack_conferir_portal(101, '{}'::jsonb, NULL, 'redisparo')" 2>&1 | sqlstate)" "42501"

echo "── K: claim × conferência em 2 conexões ──"
# A conferência trava a linha, grava o gate e segura a transação; o claim chega no meio, espera a trava e, ao
# destravar, o EvalPlanQual relê a LINHA: tem de ver o gate e recusar. Com o veto lendo a outra tabela, passaria.
P -q -c "INSERT INTO public.pedido_compra_sugerido (id, empresa, status, portal_protocolo) VALUES (107, 'OBEN', 'aprovado_aguardando_disparo', '2150107');
         INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final, sku_portal_aprovado, fator_portal_aprovado) VALUES (107, '1', 10, 10, 'CX.CINCO', 0.2);" >/dev/null
( Pq -c "BEGIN; SELECT public.sayerlack_conferir_portal(107, '$(L 2150107 '[{"sku_portal":"CX.CINCO","qtde_portal":3,"valor_mercadoria":1}]' 1 "70 - 7 DIAS" 1)'::jsonb, NULL, 'redisparo'); SELECT pg_sleep(1.5); COMMIT;" > "$TMP/a.out" 2>&1 ) &
pid_a=$!
sleep 0.6
rb="$(K 107)"
wait "$pid_a" || true
eq "K3 claim que esperou a trava da conferência vê o gate e recusa" "$(grep -o '"divergente": [a-z]*' "$TMP/a.out" | head -1)|$(printf '%s' "$rb" | campo claimed)|$(Pq -c "SELECT COALESCE(disparo_claim_em::text,'-') FROM public.pedido_compra_sugerido WHERE id = 107")" '"divergente": true|false|-'

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then echo "RESULTADO: VERMELHO (LC=$LOC)"; exit 1; fi
echo "RESULTADO: VERDE (LC=$LOC)"
