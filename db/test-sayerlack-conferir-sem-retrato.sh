#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261116120000_sayerlack_conferir_sem_retrato.sql (Codex revisão final, achado 1)
# ║      bash db/test-sayerlack-conferir-sem-retrato.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-sayerlack-conferir-sem-retrato.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sayerlack-conferir-sem-retrato.sh   (2º idioma)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║   A  aplica sobre a cadeia REAL (importar → conferir fatia 1 → aceitar fatia 2) com o NOTICE de fim, idempotente,
# ║      ACL da porta intacta, PRE anti-deriva aborta.
# ║   I  a importação (mesmo ramo sem retrato) segue gravando pedido + retrato v1 — bate consigo por construção.
# ║   S  pedido do APP sem retrato: valor por SKU, total e condição contra o que o disparador mandaria (unitário sem
# ║      IPI provado × qtde, total provado do protocolo, código da condição); referência ausente/incoerente/de outro
# ║      protocolo, condição ausente ou sem de-para = DIFERENÇA com gate (nunca "bateu", nunca recusa muda); a
# ║      divergência de preço fecha quando o portal volta, e o "Aceitar o portal" segue aceitando.
# ║  Diário: docs/historico/importar-pedido-portal-sayerlack.md
# ╚═════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5821}"
SLUG="sayerlack-conferir-sem-retrato"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C; o idioma do SERVIDOR vem de $LOC
M="$REPO_ROOT/supabase/migrations"
MIG_REAL="$M/20261116120000_sayerlack_conferir_sem_retrato.sql"
CADEIA="$M/20260905090000_sayerlack_custo_portal_cas.sql $M/20260906193522_valor_total_portal_provado.sql
        $M/20261006120000_preco_exato_po_sayerlack_ipi.sql $M/20261014120000_sayerlack_importar_pedido_portal.sql
        $M/20261016013000_sayerlack_importar_pedido_portal_safeupdate.sql $M/20261106140000_sayerlack_importar_portal_revisao.sql
        $M/20261107140000_sayerlack_condicao_portal_onda2.sql $M/20261109120000_sayerlack_condicao_sem_c.sql
        $M/20261111150000_sayerlack_conferir_portal.sql $M/20261111180000_sayerlack_aceitar_portal.sql"
for f in $CADEIA "$MIG_REAL"; do [ -f "$f" ] || { echo "INFRA: ausente: $f"; exit 1; }; done
# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e
# cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA, (3) o assert declarado estava verde
# no controle e virou vermelho, (4) sem ERRO de SQL que o controle não tem. Uma camada por vez.
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_ramo:S2 sem_valor_item_app:S2,S2b sem_total_app:S3 sem_condicao_app:S4 ausente_vira_bateu:S5
              sem_coerencia:S5b sem_protocolo_provado:S6 condicao_nula_bate:S7 depara_vira_bate:S8
              sem_inteiro:S12 semeia_divergente:S2"
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
  sem_ramo)                # o furo: sem retrato, a leitura vira a própria referência de valor/total/condição
    trocar "$MIG" "  IF v_ret.pedido_id IS NULL THEN" "  IF false THEN" ;;
  sem_valor_item_app)
    trocar "$MIG" "         WHERE p.sku IS NULL OR a.sku IS NULL OR abs(p.v - a.v) > 0.005" "         WHERE p.sku IS NULL OR a.sku IS NULL" ;;
  sem_total_app)
    trocar "$MIG" "         WHERE abs(r.valor_total_portal_provado - (p_leitura->>'valor_total')::numeric) > 0.005" "         WHERE false" ;;
  sem_condicao_app)
    trocar "$MIG" "       OR v_cond_omie <> btrim(r.condicao_pagamento_codigo) THEN" "       OR false THEN" ;;
  ausente_vira_bateu)      # referência ausente vira "sem diferença" (Number(null) === 0)
    trocar "$MIG" "    ELSE
      v_diff := COALESCE(v_diff, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'tipo', 'sem_referencia_app'" "    ELSIF false THEN
      v_diff := COALESCE(v_diff, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'tipo', 'sem_referencia_app'" ;;
  sem_coerencia)           # decomposição velha (linha editada depois da prova) aceita como referência
    trocar "$MIG" "                                           AND abs(i.preco_unitario_sem_ipi_portal * i.qtde_final + i.valor_ipi_portal
                                                   - i.valor_linha) <= 0.005, false))" "                                           , false))" ;;
  sem_inteiro)             # quantidade fracionária: o PO manda ceil(qtde) e o valor da referência não é o do PO (Codex P2)
    trocar "$MIG" "                                           AND i.qtde_final = trunc(i.qtde_final)
" "" ;;
  sem_protocolo_provado)   # o total provado de OUTRO protocolo aceito como referência
    trocar "$MIG" "       AND btrim(COALESCE(r.valor_total_portal_provado_protocolo, '')) = v_proto;" "       ;" ;;
  condicao_nula_bate)      # condição ausente no app: NULL <> 'A07' é NULL, e o IF não dispara
    trocar "$MIG" "    IF NULLIF(btrim(COALESCE(r.condicao_pagamento_codigo, '')), '') IS NULL OR v_cond_omie IS NULL" "    IF v_cond_omie IS NULL" ;;
  depara_vira_bate)        # condição do portal sem de-para (v_cond_omie NULL) lida como "sem diferença"
    trocar "$MIG" "    IF NULLIF(btrim(COALESCE(r.condicao_pagamento_codigo, '')), '') IS NULL OR v_cond_omie IS NULL" "    IF NULLIF(btrim(COALESCE(r.condicao_pagamento_codigo, '')), '') IS NULL" ;;
  semeia_divergente)       # o retrato nasce da leitura mesmo com o preço divergente
    trocar "$MIG" "  IF v_ret.pedido_id IS NULL AND v_diff IS NULL AND v_posterior THEN" "  IF v_ret.pedido_id IS NULL AND v_posterior THEN" ;;
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
CREATE TABLE public.sayerlack_portal_evidencia (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, protocolo text);
INSERT INTO public.sayerlack_portal_evidencia (protocolo) VALUES ('2140603'), ('2140603');
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
for f in $CADEIA; do P -q -f "$f" >/dev/null; done

echo "── A: aplicar ──"
if out="$(P -1 -f "$MIG" 2>&1)"; then
  case "$out" in *"CONFERIR_SEM_RETRATO_POS_OK"*) ok "A1 migration aplica com o NOTICE positivo de fim";; *) bad "A1 sem o NOTICE de fim";; esac
else bad "A1 migration NÃO aplicou: $(printf '%s' "$out" | grep -m1 -E 'ERROR|FALHOU' || true)"; fi
# Re-aplicar: com a migration real, o md5 do corpo literal na PRE tem de ser o do corpo aplicado. Sabotada, o corpo
# muda (e o md5 com ele) — aí a cópia leva o md5 vivo, para não confundir a camada sabotada com a PRE.
REAP="$MIG"
if [ -n "$SAB" ]; then
  REAP="$TMP/reaplicar.sql"
  python3 -I - "$MIG" "$REAP" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)'::regprocedure")" <<'PYR'
import re, sys
s = open(sys.argv[1], encoding='utf-8').read()
s = re.sub(r"'f6d244caaf4fc661507cf6bf3fad78d4', '[0-9a-f]{32}'", f"'f6d244caaf4fc661507cf6bf3fad78d4', '{sys.argv[3]}'", s, count=1)
open(sys.argv[2], 'w', encoding='utf-8').write(s)
PYR
fi
if P -1 -q -f "$REAP" >/dev/null 2>&1; then ok "A2 re-aplicar é idempotente (o md5 da PRE é o do corpo)"; else bad "A2 re-aplicar falhou"; fi
{ printf '%s\n' "CREATE OR REPLACE FUNCTION public.sayerlack_conferir_portal(p_pedido_id bigint, p_leitura jsonb, p_evidencia_id bigint, p_origem text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS \$d\$ BEGIN RETURN '{}'::jsonb; END \$d\$;"; cat "$MIG"; } > "$TMP/derivada.sql"
if out="$(P -1 -f "$TMP/derivada.sql" 2>&1)"; then bad "A4 porta derivada NÃO abortou a migration"; else
  case "$out" in *"PRE FALHOU"*) ok "A4 porta derivada aborta na PRE (nada aplicado)";; *) bad "A4 abortou sem a PRE: $(printf '%s' "$out" | grep -m1 ERRO || true)";; esac; fi
FN="public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)"
eq "A3 porta fechada p/ anon+authenticated, aberta p/ service_role" "$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE')::text || has_function_privilege('authenticated','$FN','EXECUTE')::text || has_function_privilege('service_role','$FN','EXECUTE')::text")" "falsefalsetrue"

STAFF="11111111-1111-1111-1111-111111111111"
L() { printf '{"protocolo":"%s","itens":%s,"valor_total":%s,"condicao":"%s","lido_de":"2026-11-09T10:%02d:00Z","lido_ate":"2026-11-09T10:%02d:30Z"}' "$1" "$2" "$3" "$4" "$5" "$5"; }
C() { Pq -c "SELECT public.sayerlack_conferir_portal($1, '$2'::jsonb, ${3:-NULL}, '${4:-redisparo}')" 2>&1 || true; }
campo() { python3 -I -c "import json,sys; v=json.load(sys.stdin).get('$1'); print('null' if v is None else (json.dumps(v,sort_keys=True) if isinstance(v,(list,dict)) else str(v).lower()))" 2>&1; }
tipos() { python3 -I -c "import json,sys; d=json.load(sys.stdin, parse_float=str).get('diferencas') or []; print(';'.join(f\"{x['tipo']}:{x['sku']}:{x['app']}>{x['portal']}\" for x in d))" 2>&1; }
GATE() { Pq -c "SELECT COALESCE(portal_divergencia_aberta_id::text,'-') FROM public.pedido_compra_sugerido WHERE id = $1"; }
NDIV() { Pq -c "SELECT count(*) || '/' || count(*) FILTER (WHERE resolvida_em IS NULL) FROM public.sayerlack_portal_divergencia WHERE pedido_id = $1"; }
NRET() { Pq -c "SELECT count(*) FROM public.sayerlack_portal_retrato WHERE pedido_id = $1"; }
AX() { Pq -c "SET ROLE authenticated; SELECT set_config('test.uid', '$STAFF', false); SELECT public.sayerlack_aceitar_portal($1, $2, 'Confirmado com o vendedor por telefone')" 2>&1 | tail -1 || true; }

echo "── I: a importação passa pelo mesmo ramo ──"
DFA='[{"sku_portal":"DFA.4080LT","qtde_portal":16,"valor_mercadoria":4865.5584}]'
r="$(Pq -c "SELECT public.sayerlack_importar_pedido_portal('2140603', '2026-10-26', 5181.82, '$DFA'::jsonb, '$STAFF', '70 - 7 DIAS')" 2>&1 || true)"
P1="$(printf '%s' "$r" | campo pedido_id)"
eq "I1 importou: pedido + retrato v1 da leitura (o pedido recém-provado bate consigo)" "$(Pq -c "SELECT versao || '|' || origem || '|' || valor_total FROM public.sayerlack_portal_retrato WHERE pedido_id = ${P1:-0}" 2>&1)|$(GATE "${P1:-0}")" "1|importacao|5181.82|-"
eq "I2 a mesma leitura no redisparo bate contra o retrato" "$(C "${P1:-0}" "$(L 2140603 "$DFA" 5181.82 "70 - 7 DIAS" 1)" | campo divergente)" "false"
COND="$(Pq -c "SELECT codigo FROM public.sayerlack_condicao_portal_para_omie('70 - 7 DIAS')")"
eq "I3 a condição do portal '70 - 7 DIAS' é A07 no catálogo da prova" "$COND" "A07"

# Pedidos nascidos no APP, já enviados ao portal com a prova de custo (o que `sayerlack_aplicar_custo_portal` grava):
# DFA 16 × 300,00 sem IPI = 4.800,00 + IPI 312,00 · GL 2 × 100,00 = 200,00 + IPI 13,00 · total provado 5.325,00 ·
# condição A07. Nenhum tem retrato. Variantes: $2 = o que muda.
novo() {  # $1 id · $2 variante
  P -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, status, status_envio_portal, portal_protocolo,
  condicao_pagamento_codigo, condicao_pagamento_descricao, num_parcelas, valor_total, num_skus,
  valor_total_portal_provado, valor_total_portal_provado_em, valor_total_portal_provado_protocolo,
  portal_situacao_codigo, portal_situacao_protocolo)
VALUES ($1, 'OBEN', 'RENNER SAYERLACK S/A', 'falha_envio', 'sucesso_portal', '2160$1', 'A07', 'Para 7 dias', 1, 5325.00, 2,
  5325.00, now(), '2160$1', '1', '2160$1');
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario,
  valor_linha, sku_portal_aprovado, fator_portal_aprovado, preco_unitario_sem_ipi_portal, valor_ipi_portal,
  aliquota_ipi_portal, ncm_ipi_portal)
VALUES ($1, '12101724100', 'DFA', 16, 16, 319.50, 5112.00, 'DFA.4080LT', 1, 300.00, 312.00, 6.5, '38140090'),
       ($1, '12101724200', 'GL',   2,  2, 106.50,  213.00, 'GL.UM',      1, 100.00,  13.00, 6.5, '38140090');
SQL
  case "$2" in
    sem_decomp) Pq -c "UPDATE public.pedido_compra_item SET preco_unitario_sem_ipi_portal = NULL, valor_ipi_portal = NULL, aliquota_ipi_portal = NULL, ncm_ipi_portal = NULL WHERE pedido_id = $1 AND sku_portal_aprovado = 'GL.UM'" >/dev/null ;;
    incoerente) Pq -c "UPDATE public.pedido_compra_item SET qtde_final = 3, valor_linha = 319.50 WHERE pedido_id = $1 AND sku_portal_aprovado = 'GL.UM'" >/dev/null ;;
    outro_proto) Pq -c "UPDATE public.pedido_compra_sugerido SET valor_total_portal_provado_protocolo = '2169999' WHERE id = $1" >/dev/null ;;
    fracionado) Pq -c "UPDATE public.pedido_compra_item SET qtde_final = 2.5, qtde_sugerida = 2.5, preco_unitario_sem_ipi_portal = 80.00 WHERE pedido_id = $1 AND sku_portal_aprovado = 'GL.UM'" >/dev/null ;;
    sem_cond) Pq -c "UPDATE public.pedido_compra_sugerido SET condicao_pagamento_codigo = NULL WHERE id = $1" >/dev/null ;;
  esac
}
IT='[{"sku_portal":"DFA.4080LT","qtde_portal":16,"valor_mercadoria":4800.00},{"sku_portal":"GL.UM","qtde_portal":2,"valor_mercadoria":200.00}]'
CARO='[{"sku_portal":"DFA.4080LT","qtde_portal":16,"valor_mercadoria":4800.01},{"sku_portal":"GL.UM","qtde_portal":2,"valor_mercadoria":200.00}]'
# O preço subiu no portal sem mudar quantidade: DFA 4.800 → 5.100 (IPI 331,50), total 5.644,50.
SUBIU='[{"sku_portal":"DFA.4080LT","qtde_portal":16,"valor_mercadoria":5100.00},{"sku_portal":"GL.UM","qtde_portal":2,"valor_mercadoria":200.00}]'

echo "── S: pedido do app sem retrato ──"
novo 201 ""
r="$(C 201 "$(L 2160201 "$IT" 5325.00 "70 - 7 DIAS" 1)" 1)"
eq "S1 tudo bate (preço sem IPI × qtde, total provado, condição A07): bate e a leitura vira o retrato" "$(printf '%s' "$r" | campo divergente)|$(printf '%s' "$r" | campo retrato_criado)|$(NRET 201)|$(GATE 201)" "false|true|1|-"
novo 202 ""
r="$(C 202 "$(L 2160202 "$SUBIU" 5644.50 "70 - 7 DIAS" 1)")"; D2="$(printf '%s' "$r" | campo divergencia_id)"
eq "S2 preço do item subiu no portal (qtde igual): divergência valor_item + total, gate na linha, SEM retrato" "$(printf '%s' "$r" | tipos)|$(GATE 202)|$(NRET 202)" "valor_item:DFA.4080LT:4800.00>5100.00;valor_total:None:5325.00>5644.50|$D2|0"
novo 203 ""
r="$(C 203 "$(L 2160203 "$CARO" 5325.00 "70 - 7 DIAS" 1)")"
eq "S2b 1 centavo num item (total igual): diferença (sem tolerância de reais)" "$(printf '%s' "$r" | tipos)|$(NRET 203)" "valor_item:DFA.4080LT:4800.00>4800.01|0"
novo 204 ""
r="$(C 204 "$(L 2160204 "$IT" 5325.10 "70 - 7 DIAS" 1)")"
eq "S3 só o total mudou (o IPI mora no total): diferença de total contra o provado" "$(printf '%s' "$r" | tipos)|$(NRET 204)" "valor_total:None:5325.00>5325.10|0"
novo 205 ""
r="$(C 205 "$(L 2160205 "$IT" 5325.00 "28 - 28 DIAS" 1)")"
eq "S4 condição mudou no portal (A28 × A07 do pedido): diferença de condição com os dois textos" "$(printf '%s' "$r" | tipos)|$(NRET 205)" "condicao:None:A07 · Para 7 dias>28 - 28 DIAS|0"
novo 206 sem_decomp
r="$(C 206 "$(L 2160206 "$IT" 5325.00 "70 - 7 DIAS" 1)")"
eq "S5 item sem a decomposição provada: diferença sem_referencia_app, gate na linha, sem retrato (ausente ≠ bateu)" "$(printf '%s' "$r" | tipos)|$([ "$(GATE 206)" != "-" ] && echo gate || echo sem-gate)|$(NRET 206)" "sem_referencia_app:None:None>5325.00|gate|0"
novo 207 incoerente
r="$(C 207 "$(L 2160207 '[{"sku_portal":"DFA.4080LT","qtde_portal":16,"valor_mercadoria":4800.00},{"sku_portal":"GL.UM","qtde_portal":3,"valor_mercadoria":200.00}]' 5325.00 "70 - 7 DIAS" 1)")"
eq "S5b decomposição velha (qtde editada depois da prova): diferença sem_referencia_app" "$(printf '%s' "$r" | tipos)|$(NRET 207)" "sem_referencia_app:None:None>5325.00|0"
novo 208 outro_proto
r="$(C 208 "$(L 2160208 "$IT" 5325.00 "70 - 7 DIAS" 1)")"
eq "S6 total provado de OUTRO protocolo: diferença sem_referencia_app" "$(printf '%s' "$r" | tipos)|$(NRET 208)" "sem_referencia_app:None:None>5325.00|0"
novo 209 sem_cond
r="$(C 209 "$(L 2160209 "$IT" 5325.00 "70 - 7 DIAS" 1)")"
eq "S7 pedido sem código de condição: diferença de condição (app ausente), com gate" "$(printf '%s' "$r" | tipos)|$(NRET 209)|$([ "$(GATE 209)" != "-" ] && echo gate || echo sem-gate)" "condicao:None:None>70 - 7 DIAS|0|gate"
novo 210 ""
r="$(C 210 "$(L 2160210 "$IT" 5325.00 "45 - 45 DIAS" 1)")"
eq "S8 condição do portal sem de-para no Omie: diferença de condição (sem IP007 cru), com gate" "$(printf '%s' "$r" | tipos)|$(NRET 210)|$([ "$(GATE 210)" != "-" ] && echo gate || echo sem-gate)" "condicao:None:A07 · Para 7 dias>45 - 45 DIAS|0|gate"
novo 211 sem_decomp
r="$(C 211 "$(L 2160211 '[{"sku_portal":"DFA.4080LT","qtde_portal":17,"valor_mercadoria":4800.00},{"sku_portal":"GL.UM","qtde_portal":2,"valor_mercadoria":200.00}]' 5325.00 "70 - 7 DIAS" 1)")"
eq "S9 sem referência de valor, mas a quantidade divergiu: a divergência abre do mesmo jeito (gate)" "$(printf '%s' "$r" | tipos)|$([ "$(GATE 211)" != "-" ] && echo gate || echo sem-gate)|$(NRET 211)" "quantidade:DFA.4080LT:16>17;sem_referencia_app:None:None>5325.00|gate|0"
r="$(C 202 "$(L 2160202 "$IT" 5325.00 "70 - 7 DIAS" 5)" 2)"
eq "S10 o portal voltou ao preço do app (leitura posterior): fecha, solta o gate e SÓ AGORA semeia o retrato" "$(printf '%s' "$r" | campo divergente)|$(GATE 202)|$(Pq -c "SELECT resolucao FROM public.sayerlack_portal_divergencia WHERE id = ${D2:-0}")|$(NRET 202)" "false|-|portal_voltou|1"
novo 212 ""
r="$(C 212 "$(L 2160212 "$SUBIU" 5644.50 "70 - 7 DIAS" 1)" 2)"; D12="$(printf '%s' "$r" | campo divergencia_id)"
a="$(AX 212 "${D12:-0}")"
eq "S11 o preço novo pelo Aceitar o portal: aceita, itens reescritos e retrato v1 com origem aceito_portal" "$(printf '%s' "$a" | campo aceito)|$(Pq -c "SELECT trim_scale(preco_unitario_sem_ipi_portal * qtde_final) FROM public.pedido_compra_item WHERE pedido_id = 212 AND sku_portal_aprovado = 'DFA.4080LT'")|$(Pq -c "SELECT string_agg(versao || ':' || origem, ',') FROM public.sayerlack_portal_retrato WHERE pedido_id = 212")" "true|5100|1:aceito_portal"
novo 213 fracionado
r="$(C 213 "$(L 2160213 '[{"sku_portal":"DFA.4080LT","qtde_portal":16,"valor_mercadoria":4800.00},{"sku_portal":"GL.UM","qtde_portal":2.5,"valor_mercadoria":200.00}]' 5325.00 "70 - 7 DIAS" 1)")"
eq "S12 quantidade fracionária no app (o PO manda ceil): não é referência ⇒ diferença sem_referencia_app" "$(printf '%s' "$r" | tipos)|$(NRET 213)" "sem_referencia_app:None:None>5325.00|0"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then echo "RESULTADO: VERMELHO (LC=$LOC)"; exit 1; fi
echo "RESULTADO: VERDE (LC=$LOC)"
