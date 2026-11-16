#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261116130000_sayerlack_cancelado_antes_do_pedido.sql (Codex revisão final, achado 2)
# ║      bash db/test-sayerlack-importar-cancelado.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-sayerlack-importar-cancelado.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sayerlack-importar-cancelado.sh   (2º idioma)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║   A  aplica sobre a cadeia REAL (evidência 7.2 → importar → conferir) com o NOTICE de fim, idempotente, ACL das
# ║      duas assinaturas, PRE anti-deriva, CHECK da coluna, evidência segue imutável.
# ║   X  a importação recusa (IP010 [cancelado_no_portal], nada gravado) se outra leitura do MESMO protocolo viu
# ║      "6" com lido_ate posterior ao início desta; cancelamento anterior, de outro protocolo ou situação ≠ 6 não
# ║      recusa; o wrapper de 6 args (edge ≤ v1.15) recusa qualquer cancelamento registrado; marco no futuro = IP001.
# ║   K  o cancelamento gravado ENQUANTO a importação espera o lock do protocolo é visto (2 conexões).
# ║  Diário: docs/historico/importar-pedido-portal-sayerlack.md
# ╚═════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5861}"
SLUG="sayerlack-importar-cancelado"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C; o idioma do SERVIDOR vem de $LOC
M="$REPO_ROOT/supabase/migrations"
MIG_REAL="$M/20261116130000_sayerlack_cancelado_antes_do_pedido.sql"
EVID="$M/20261111090000_sayerlack_portal_evidencia.sql"
CADEIA="$M/20260905090000_sayerlack_custo_portal_cas.sql $M/20260906193522_valor_total_portal_provado.sql
        $M/20261006120000_preco_exato_po_sayerlack_ipi.sql $M/20261014120000_sayerlack_importar_pedido_portal.sql
        $M/20261016013000_sayerlack_importar_pedido_portal_safeupdate.sql $M/20261106140000_sayerlack_importar_portal_revisao.sql
        $M/20261107140000_sayerlack_condicao_portal_onda2.sql $M/20261109120000_sayerlack_condicao_sem_c.sql
        $M/20261111150000_sayerlack_conferir_portal.sql"
for f in $EVID $CADEIA "$MIG_REAL"; do [ -f "$f" ] || { echo "INFRA: ausente: $f"; exit 1; }; done
# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e
# cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA, (3) o assert declarado estava verde
# no controle e virou vermelho, (4) sem ERRO de SQL que o controle não tem. Uma camada por vez.
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_check:X2,K1 sem_ordem:X3 sem_protocolo:X4 sem_codigo:X5 wrapper_pula:X6 futuro_aceito:X7
              check_antes_do_lock:K1 sem_trigger:K2 sem_veto_claim:K3 sem_ordem_claim:K4 sem_reabertura:K5 claim_sem_lock:K6 marco_nulo_passa:K7 legado_passa:A7"
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
  sem_check)
    trocar "$MIG" "  IF v_cancelado_ate IS NOT NULL THEN" "  IF false THEN" ;;
  sem_ordem)               # qualquer cancelamento, mesmo o anterior a esta leitura, recusaria para sempre
    trocar "$MIG" "     AND (p_lido_de IS NULL OR e.lido_ate > p_lido_de);" "     ;" ;;
  sem_protocolo)
    trocar "$MIG" "   WHERE e.protocolo = p_protocolo
     AND e.situacao_codigo = '6'" "   WHERE true
     AND e.situacao_codigo = '6'" ;;
  sem_codigo)
    trocar "$MIG" "   WHERE e.protocolo = p_protocolo
     AND e.situacao_codigo = '6'
" "   WHERE e.protocolo = p_protocolo
" ;;
  wrapper_pula)            # marco ausente lido como "nada a ordenar" em vez de "qualquer cancelamento"
    trocar "$MIG" "     AND (p_lido_de IS NULL OR e.lido_ate > p_lido_de);" "     AND (p_lido_de IS NOT NULL AND e.lido_ate > p_lido_de);" ;;
  futuro_aceito)           # um marco no futuro faria o IP010 nunca casar
    trocar "$MIG" "  IF p_lido_de IS NOT NULL AND (NOT isfinite(p_lido_de) OR p_lido_de > now() + interval '5 minutes') THEN" "  IF p_lido_de IS NOT NULL AND NOT isfinite(p_lido_de) THEN" ;;
  check_antes_do_lock)     # a consulta à evidência FORA do lock (snapshot de antes da espera)
    python3 -I - "$MIG" <<'PYS'
import sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
a = s.index("  SELECT max(e.lido_ate) INTO v_cancelado_ate"); b = s.index("  END IF;\n", s.index("IP010", a)) + len("  END IF;\n")
bloco = s[a:b]; assert s.count(bloco) == 1
s = s[:a] + s[b:]
lock = "  PERFORM pg_advisory_xact_lock(hashtext('sayerlack_importar_pedido_portal:' || p_protocolo));"
assert s.count(lock) == 1
s = s.replace(lock, bloco + "  PERFORM pg_sleep(0);\n  PERFORM pg_advisory_xact_lock(hashtext('sayerlack_importar_pedido_portal:' || p_protocolo));")
open(p, 'w', encoding='utf-8').write(s)
PYS
    ;;
  sem_trigger)             # a evidência de cancelado não espera a importação em voo (o registrador não acha o pedido)
    trocar "$MIG" "  PERFORM pg_advisory_xact_lock(hashtext('sayerlack_importar_pedido_portal:' || NEW.protocolo));" "  NULL;" ;;
  sem_veto_claim)          # o claim não consome a evidência: o que o registrador perdeu vira PO
    trocar "$MIG" "     AND NOT (importado_portal_em IS NOT NULL AND EXISTS" "     AND NOT (false AND EXISTS" ;;
  sem_ordem_claim)         # qualquer cancelamento, mesmo anterior à leitura que importou, bloquearia para sempre
    trocar "$MIG" "                         OR e.lido_ate > pedido_compra_sugerido.importado_portal_lido_de)" "                         OR true)" ;;
  sem_reabertura)          # re-aberto no portal depois do cancelamento: o veto da evidência imutável prenderia para sempre
    trocar "$MIG" "                                       AND z.situacao_codigo IS NOT NULL AND z.lido_de > e.lido_ate))" "                                       AND false))" ;;
  claim_sem_lock)          # o claim sem a advisory lock: não espera o INSERT de "6" em voo
    trocar "$MIG" "    PERFORM pg_advisory_xact_lock(hashtext('sayerlack_importar_pedido_portal:' || v_proto_lock));" "    NULL;" ;;
  marco_nulo_passa)        # importado pelo wrapper (marco NULL) escapava do veto (Codex rodada 3, P1)
    trocar "$MIG" "     AND NOT (importado_portal_em IS NOT NULL AND EXISTS" "     AND NOT (importado_portal_lido_de IS NOT NULL AND EXISTS" ;;
  legado_passa)            # a PRE do legado ausente: importado antigo disparável escaparia do veto (Codex rodada 4)
    trocar "$MIG" "    RAISE EXCEPTION 'PRE FALHOU: há pedido importado ANTES desta migration ainda disparável (sem PO) — a evidência antiga não tem situacao_codigo e o veto não o cobriria';" "    NULL;" ;;
  *) echo "INFRA: sabotagem desconhecida: $SAB"; exit 1 ;;
esac
if [ -n "$SAB" ]; then
  if cmp -s "$MIG" "$MIG_REAL"; then echo "INFRA: sabotagem $SAB inerte"; exit 1; fi
  echo "SABOTAGEM ATIVA em $SAB"
fi

# ── Banco: papéis do Supabase + o recorte que a cadeia, a fatia 1 e esta migration tocam ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
-- As colunas de prod que a importação, a conferência, o claim e o aceite leem/escrevem (psql-ro 2026-11-09).
CREATE TABLE public.pedido_compra_sugerido (
  id bigserial PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text, data_ciclo date NOT NULL DEFAULT current_date,
  valor_total numeric NOT NULL DEFAULT 0, num_skus integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'pendente_aprovacao',
  canal_usado text, resposta_canal jsonb, omie_pedido_compra_numero text, omie_pedido_compra_id text,
  aprovado_por uuid, aprovado_em timestamptz, condicao_pagamento_codigo text, condicao_pagamento_descricao text,
  num_parcelas integer, condicao_origem text, status_envio_portal text NOT NULL DEFAULT 'nao_aplicavel',
  enviado_portal_em timestamptz, portal_protocolo text, portal_data_entrega date, dias_parcelas text,
  disparo_claim_em timestamptz, disparo_claim_por text, portal_situacao_codigo text, portal_situacao_protocolo text,
  portal_situacao_em timestamptz, atualizado_em timestamptz
);
CREATE TABLE public.pedido_compra_item (
  id bigserial PRIMARY KEY, pedido_id bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text NOT NULL, sku_descricao text, estoque_atual numeric, ponto_pedido numeric, estoque_maximo numeric,
  qtde_sugerida numeric NOT NULL, qtde_final numeric, preco_unitario numeric, valor_linha numeric, primeira_compra boolean,
  ajustado_humano boolean, criado_em timestamptz DEFAULT now(), modo_promocao text, promocao_item_id bigint,
  qtde_sem_promocao numeric, preco_sem_desconto numeric, desconto_perc_aplicado numeric, economia_estimada_valor numeric,
  estoque_fisico numeric, estoque_a_caminho numeric, qtde_sem_teto numeric, teto_cobertura_aplicado boolean NOT NULL DEFAULT false,
  fator_embalagem_portal numeric, sku_portal_aprovado text, fator_portal_aprovado numeric, estoque_comprometido numeric
);
CREATE TABLE public.omie_products (omie_codigo_produto bigint NOT NULL, account text NOT NULL, ncm text, descricao text,
  UNIQUE (omie_codigo_produto, account));
CREATE TABLE public.sku_fornecedor_externo (
  id bigserial PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text NOT NULL, sku_omie text NOT NULL, sku_portal text,
  unidade_portal text NOT NULL DEFAULT 'UN', fator_conversao numeric NOT NULL DEFAULT 1, ativo boolean NOT NULL DEFAULT true
);
CREATE TABLE public.purchase_orders_tracking (id bigserial PRIMARY KEY, empresa text NOT NULL, numero_pedido text,
  numero_contrato_fornecedor text, status text, omie_codigo_integracao text);
CREATE TABLE public.acoes_execucoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), acao text NOT NULL, origem text,
  executado_por uuid, executado_por_nome text, iniciado_em timestamptz, finalizado_em timestamptz, status text, detalhes jsonb);
CREATE SCHEMA IF NOT EXISTS private;
CREATE FUNCTION private.cap_compras_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role IN ('employee','master')) $f$;
CREATE TABLE public.omie_condicao_pagamento_catalogo (empresa text NOT NULL, codigo text NOT NULL, descricao text,
  num_parcelas integer, ativo boolean NOT NULL DEFAULT true);
CREATE TABLE public.sayerlack_varredura_falha (protocolo text PRIMARY KEY, mensagem text, primeira_em timestamptz DEFAULT now(),
  ultima_em timestamptz DEFAULT now(), tentativas integer DEFAULT 1, notificado_em timestamptz, resolvido_em timestamptz);
GRANT SELECT ON public.pedido_compra_sugerido, public.pedido_compra_item, public.omie_products TO service_role;
GRANT UPDATE ON public.pedido_compra_sugerido TO service_role, authenticated;
INSERT INTO public.omie_condicao_pagamento_catalogo (empresa, codigo, descricao, num_parcelas, ativo) VALUES
  ('OBEN', '000', 'A Vista', 1, true), ('OBEN', 'A07', 'Para 7 dias', 1, true), ('OBEN', 'A28', 'Para 28 dias', 1, true),
  ('OBEN', 'A30', 'Para 30 dias (C)', 1, true), ('OBEN', 'T54', 'Para 30 dias', 1, true);
INSERT INTO public.sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, unidade_portal, fator_conversao, ativo) VALUES
  ('OBEN', 'RENNER SAYERLACK S/A', '12101724100', 'DFA.4080LT', 'LT', 1, true),
  ('OBEN', 'RENNER SAYERLACK S/A', '12101724200', 'GL.UM', 'GL', 1, true),
  ('OBEN', 'RENNER SAYERLACK S/A', '12101724300', 'CX.DOIS', 'CX', 2, true);
INSERT INTO public.omie_products (omie_codigo_produto, account, ncm, descricao) VALUES
  (12101724100, 'oben', '3814.00.90', 'DILUENTE PU DFA.4080LT'),
  (12101724200, 'oben', '3814.00.90', 'DILUENTE GL'),
  (12101724300, 'oben', '3814.00.90', 'DILUENTE CX');
INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('11111111-1111-1111-1111-111111111111', 'employee'),
  ('22222222-2222-2222-2222-222222222222', 'customer');
SQL
P -q -f "$EVID" >/dev/null
for f in $CADEIA; do P -q -f "$f" >/dev/null; done

M7="ce4556cbc79994b1061fd64332dd1bc3"
MC="29220979b99f9520183abb68d9ae5301"
F7="public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text,timestamptz)"
F6="public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text)"
echo "── A: aplicar ──"
if out="$(P -1 -f "$MIG" 2>&1)"; then
  case "$out" in *"CANCELADO_ANTES_DO_PEDIDO_POS_OK"*) ok "A1 migration aplica com o NOTICE positivo de fim";; *) bad "A1 sem o NOTICE de fim";; esac
else bad "A1 migration NÃO aplicou: $(printf '%s' "$out" | grep -m1 -E 'ERROR|FALHOU' || true)"; fi
# Re-aplicar: real = o md5 literal da PRE é o do corpo aplicado; sabotada, a cópia leva o md5 vivo (outra camada).
REAP="$MIG"
if [ -n "$SAB" ]; then
  REAP="$TMP/reaplicar.sql"
  sed -e "s/$M7/$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = '$F7'::regprocedure")/g" \
      -e "s/$MC/$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reposicao_claim_disparo(bigint,text)'::regprocedure")/g" "$MIG" > "$REAP"
fi
if P -1 -q -f "$REAP" >/dev/null 2>&1; then ok "A2 re-aplicar é idempotente (o md5 da PRE é o do corpo)"; else bad "A2 re-aplicar falhou"; fi
{ printf '%s\n' "CREATE OR REPLACE FUNCTION $F6 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS \$d\$ BEGIN RETURN '{}'::jsonb; END \$d\$;" | sed 's/(text,date,numeric,jsonb,uuid,text)/(p_protocolo text, p_data_entrega date, p_valor_total numeric, p_itens jsonb, p_operador uuid, p_condicao_portal text)/'; cat "$MIG"; } > "$TMP/derivada.sql"
if out="$(P -1 -f "$TMP/derivada.sql" 2>&1)"; then bad "A4 importação derivada NÃO abortou a migration"; else
  case "$out" in *"PRE FALHOU"*) ok "A4 importação derivada aborta na PRE (nada aplicado)";; *) bad "A4 abortou sem a PRE: $(printf '%s' "$out" | grep -m1 ERRO || true)";; esac; fi
{ printf '%s\n' "INSERT INTO public.pedido_compra_sugerido (empresa, status, portal_protocolo, importado_portal_em) VALUES ('OBEN', 'falha_envio', '2179999', now());"; cat "$REAP"; } > "$TMP/legado.sql"
if out="$(P -1 -f "$TMP/legado.sql" 2>&1)"; then bad "A7 importado antigo disparável NÃO abortou a migration"; else
  case "$out" in *"PRE FALHOU: há pedido importado ANTES"*) ok "A7 importado antigo (sem marco) ainda disparável aborta na PRE (nada aplicado)";; *) bad "A7 abortou sem a PRE do legado: $(printf '%s' "$out" | grep -m1 ERRO || true)";; esac; fi
eq "A3 as 2 assinaturas: fechadas p/ anon+authenticated, abertas p/ service_role" "$(Pq -c "SELECT string_agg(has_function_privilege('anon',f,'EXECUTE')::text || has_function_privilege('authenticated',f,'EXECUTE')::text || has_function_privilege('service_role',f,'EXECUTE')::text, ',') FROM unnest(ARRAY['$F6','$F7']) f")" "falsefalsetrue,falsefalsetrue"

STAFF="11111111-1111-1111-1111-111111111111"
DFA='[{"sku_portal":"DFA.4080LT","qtde_portal":16,"valor_mercadoria":4865.5584}]'
T0="2026-11-01T10"
# Evidência de OUTRA leitura: $1 protocolo · $2 situação (NULL sem aspas) · $3 minuto do lido_ate
E() { Pq -c "INSERT INTO public.sayerlack_portal_evidencia (protocolo, origem, lido_de, lido_ate, leitura_ok, situacao_codigo) VALUES ('$1', 'automatica', '$T0:$(printf %02d "$3"):00Z'::timestamptz - interval '30 seconds', '$T0:$(printf %02d "$3"):00Z', true, $2)" 2>&1 || true; }
# Importa: $1 protocolo · $2 minuto do lido_de (ou um timestamptz literal)
I()  { local de="$2"; case "$de" in *[!0-9]*) ;; *) de="$T0:$(printf %02d "$2"):00Z";; esac
       Pq -c "SELECT public.sayerlack_importar_pedido_portal('$1', '2026-10-26', 5181.82, '$DFA'::jsonb, '$STAFF', '70 - 7 DIAS', '$de'::timestamptz)" 2>&1 || true; }
I6() { Pq -c "SELECT public.sayerlack_importar_pedido_portal('$1', '2026-10-26', 5181.82, '$DFA'::jsonb, '$STAFF', '70 - 7 DIAS')" 2>&1 || true; }
campo() { python3 -I -c "import json,sys; v=json.load(sys.stdin).get('$1'); print('null' if v is None else str(v).lower())" 2>&1; }
NPED() { Pq -c "SELECT count(*) FROM public.pedido_compra_sugerido WHERE portal_protocolo = '$1'"; }
recusa() { local o="$1"; printf '%s' "$(printf '%s' "$o" | sqlstate)"; if grep -qF '[cancelado_no_portal]' <<<"$o"; then printf '|marca'; else printf '|sem-marca'; fi; }

eq "A5 a coluna só aceita 1..7 (CHECK) = 23514" "$(E 2170001 "'9'" 1 | sqlstate)" "23514"
E 2170001 "'1'" 1 >/dev/null
eq "A6 a evidência segue imutável (UPDATE da situação) = 42501" "$(Pq -c "UPDATE public.sayerlack_portal_evidencia SET situacao_codigo = '6' WHERE protocolo = '2170001'" 2>&1 | sqlstate)" "42501"

echo "── X: a importação × o cancelamento visto por outra leitura ──"
eq "X1 sem evidência de cancelamento: importa (7 args)" "$(I 2170011 10 | campo ja_existia)|$(NPED 2170011)" "false|1"
E 2170012 "'6'" 15 >/dev/null
r="$(I 2170012 10)"
eq "X2 outra leitura viu '6' às 10:15, esta começou 10:10: IP010 [cancelado_no_portal], nada gravado" "$(recusa "$r")|$(NPED 2170012)|$(Pq -c "SELECT count(*) FROM public.sayerlack_portal_retrato WHERE protocolo = '2170012'")" "IP010|marca|0|0"
E 2170013 "'6'" 5 >/dev/null
eq "X3 cancelamento visto ANTES do início desta leitura (10:05 < 10:10): importa (a leitura nova decide)" "$(I 2170013 10 | campo ja_existia)|$(NPED 2170013)" "false|1"
E 2170099 "'6'" 15 >/dev/null
eq "X4 cancelamento de OUTRO protocolo: importa" "$(I 2170014 10 | campo ja_existia)|$(NPED 2170014)" "false|1"
E 2170015 "'1'" 15 >/dev/null; E 2170015 NULL 16 >/dev/null
eq "X5 leituras posteriores com situação 1 e ilegível (NULL): importa" "$(I 2170015 10 | campo ja_existia)|$(NPED 2170015)" "false|1"
E 2170016 "'6'" 1 >/dev/null
eq "X6 wrapper de 6 args (edge v1.15, sem marco): qualquer cancelamento registrado recusa" "$(recusa "$(I6 2170016)")|$(NPED 2170016)" "IP010|marca|0"
eq "X6b wrapper de 6 args sem cancelamento algum: importa pelo corpo novo" "$(I6 2170017 | campo ja_existia)|$(NPED 2170017)" "false|1"
eq "X7 início da leitura no futuro (marco inventado) = IP001" "$(I 2170018 "$(Pq -c "SELECT (now() + interval '1 hour')::text")" | sqlstate)|$(NPED 2170018)" "IP001|0"
E 2170011 "'6'" 30 >/dev/null
eq "X8 pedido JÁ existe: segue 'ja_existia' (o veto dele mora na situação do pedido, pelo escritor de sempre)" "$(I 2170011 20 | campo ja_existia)" "true"

echo "── K: o cancelamento gravado durante a espera pelo lock ──"
# Conexão 1 segura o lock do protocolo e, ANTES de soltar, grava a leitura que viu "6"; a importação (lida antes) chega
# no meio, espera o lock e, ao entrar, tem de ver a evidência. Consultada antes do lock, não veria.
( Pq -c "BEGIN; SELECT pg_advisory_xact_lock(hashtext('sayerlack_importar_pedido_portal:2170020')); SELECT pg_sleep(1.5); INSERT INTO public.sayerlack_portal_evidencia (protocolo, origem, lido_de, lido_ate, leitura_ok, situacao_codigo) VALUES ('2170020', 'manual', '$T0:14:30Z', '$T0:15:00Z', true, '6'); COMMIT;" > "$TMP/k.out" 2>&1 ) &
pid_k=$!
sleep 0.6
rk="$(I 2170020 10)"
wait "$pid_k" || true
eq "K1 importação que esperou o lock vê o cancelamento gravado nesse meio: IP010, nada gravado" "$(recusa "$rk")|$(NPED 2170020)" "IP010|marca|0"

echo "── K2: a evidência de cancelado espera a importação em voo; o claim consome a evidência ──"
# X importa e segura a transação; Y grava "6" no meio. Com o trigger, o INSERT de Y espera o commit de X (e então o
# pedido já existe para o registrador de Y). O claim de X tem de recusar pela evidência, mesmo sem o registrador.
( Pq -c "BEGIN; SELECT public.sayerlack_importar_pedido_portal('2170030', '2026-10-26', 5181.82, '$DFA'::jsonb, '$STAFF', '70 - 7 DIAS', '$T0:10:00Z'::timestamptz); SELECT pg_sleep(1.5); COMMIT;" > "$TMP/x.out" 2>&1 ) &
pid_x=$!
sleep 0.6
ny="$(Pq -c "INSERT INTO public.sayerlack_portal_evidencia (protocolo, origem, lido_de, lido_ate, leitura_ok, situacao_codigo) VALUES ('2170030', 'manual', '$T0:14:30Z', '$T0:15:00Z', true, '6'); SELECT count(*) FROM public.pedido_compra_sugerido WHERE portal_protocolo = '2170030';" 2>&1 | tail -1 || true)"
wait "$pid_x" || true
eq "K2 o INSERT do '6' esperou o commit da importação em voo (ao terminar, o pedido já existe)" "$ny|$(NPED 2170030)" "1|1"
P30="$(Pq -c "SELECT id FROM public.pedido_compra_sugerido WHERE portal_protocolo = '2170030'")"
rc="$(Pq -c "SELECT public.reposicao_claim_disparo(${P30:-0}, 'prova')" 2>&1 || true)"
eq "K3 o claim do pedido importado recusa pela evidência de cancelado posterior (sem gravar o claim)" "$(printf '%s' "$rc" | campo claimed)|$(printf '%s' "$rc" | campo bloqueio)|$(Pq -c "SELECT COALESCE(disparo_claim_em::text,'-') FROM public.pedido_compra_sugerido WHERE id = ${P30:-0}")" "false|cancelado_no_portal|-"
P13="$(Pq -c "SELECT id FROM public.pedido_compra_sugerido WHERE portal_protocolo = '2170013'")"
eq "K4 cancelamento ANTERIOR à leitura que importou não bloqueia o claim" "$(Pq -c "SELECT public.reposicao_claim_disparo(${P13:-0}, 'prova')" 2>&1 | campo claimed)" "true"
imp() { Pq -c "SELECT public.sayerlack_importar_pedido_portal('$1', '2026-10-26', 5181.82, '$DFA'::jsonb, '$STAFF', '70 - 7 DIAS', '$T0:10:00Z'::timestamptz)" >/dev/null 2>&1 || true
        Pq -c "SELECT id FROM public.pedido_compra_sugerido WHERE portal_protocolo = '$1'"; }
P41="$(imp 2170041)"; E 2170041 "'6'" 15 >/dev/null; E 2170041 "'1'" 20 >/dev/null
eq "K5 cancelado (10:15) e RE-ABERTO no portal (leitura 10:19:30 com situação 1): o claim volta a valer" "$(Pq -c "SELECT public.reposicao_claim_disparo(${P41:-0}, 'prova')" 2>&1 | campo claimed)" "true"
P40="$(imp 2170040)"
( Pq -c "BEGIN; INSERT INTO public.sayerlack_portal_evidencia (protocolo, origem, lido_de, lido_ate, leitura_ok, situacao_codigo) VALUES ('2170040', 'manual', '$T0:14:30Z', '$T0:15:00Z', true, '6'); SELECT pg_sleep(1.5); COMMIT;" > "$TMP/y.out" 2>&1 ) &
pid_y=$!
sleep 0.6
r6="$(Pq -c "SELECT public.reposicao_claim_disparo(${P40:-0}, 'prova')" 2>&1 || true)"
wait "$pid_y" || true
eq "K6 claim no meio do INSERT do '6' (ainda sem commit): espera a lock e recusa pela evidência" "$(printf '%s' "$r6" | campo claimed)|$(printf '%s' "$r6" | campo bloqueio)" "false|cancelado_no_portal"
I6 2170042 >/dev/null; P42="$(Pq -c "SELECT id FROM public.pedido_compra_sugerido WHERE portal_protocolo = '2170042'")"
E 2170042 "'6'" 50 >/dev/null
r7="$(Pq -c "SELECT public.reposicao_claim_disparo(${P42:-0}, 'prova')" 2>&1 || true)"
eq "K7 importado pelo wrapper (edge v1.15, marco NULL) e '6' registrado depois: o claim recusa" "$(Pq -c "SELECT COALESCE(importado_portal_lido_de::text,'NULL') FROM public.pedido_compra_sugerido WHERE id = ${P42:-0}")|$(printf '%s' "$r7" | campo claimed)|$(printf '%s' "$r7" | campo bloqueio)" "NULL|false|cancelado_no_portal"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then echo "RESULTADO: VERMELHO (LC=$LOC)"; exit 1; fi
echo "RESULTADO: VERDE (LC=$LOC)"
