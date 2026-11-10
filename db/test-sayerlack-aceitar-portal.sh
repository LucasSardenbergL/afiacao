#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261111180000_sayerlack_aceitar_portal.sql (revisão 2, item 5.2 / 5B, fatia 2)
# ║      bash db/test-sayerlack-aceitar-portal.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-sayerlack-aceitar-portal.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sayerlack-aceitar-portal.sh   (2º idioma)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║   A  aplica (sobre a cadeia REAL: importar + fatia 1) com o NOTICE de fim, idempotente, ACL: a RPC para
# ║      authenticated (gate staff dentro), a porta e o helper fechados.
# ║   R  recusas: não-staff, justificativa, divergência que a tela não viu, situação ≠ 1/5, claim aberto, PO no
# ║      espelho (Codex c), PO no pedido, sem divergência; nada escrito em nenhuma.
# ║   S  aceite: itens e cabeçalho reescritos da leitura da divergência, custo pela MESMA prova (IPI), condição pelo
# ║      de-para (30 DIAS → T54), retrato v+1 com o marco, divergência 'aceito_portal' com o ator, gate solto,
# ║      trilha com o antes e o depois; o estoque do motor herdado; o re-disparo (releitura) bate e o claim passa.
# ║   F  leitura que não vira pedido (de-para, fração, prova do custo) desfaz TUDO.
# ║   P  porta: modo aceito só com o GUC da RPC; itens que não batem = AP009; leitura antiga depois do aceite não
# ║      reabre (Codex b); "mesmo diff" com conteúdo novo substitui (Codex a) e com o mesmo conteúdo não empilha.
# ║   K  2 conexões: a releitura substitui a divergência enquanto o aceite espera a trava ⇒ divergencia_mudou.
# ║  Diário: docs/historico/importar-pedido-portal-sayerlack.md
# ╚════════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5821}"
SLUG="sayerlack-aceitar-portal"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C; o idioma do SERVIDOR vem de $LOC
M="$REPO_ROOT/supabase/migrations"
MIG_REAL="$M/20261111180000_sayerlack_aceitar_portal.sql"
CADEIA="$M/20260905090000_sayerlack_custo_portal_cas.sql $M/20260906193522_valor_total_portal_provado.sql
        $M/20261006120000_preco_exato_po_sayerlack_ipi.sql $M/20261014120000_sayerlack_importar_pedido_portal.sql
        $M/20261016013000_sayerlack_importar_pedido_portal_safeupdate.sql $M/20261106140000_sayerlack_importar_portal_revisao.sql
        $M/20261107140000_sayerlack_condicao_portal_onda2.sql $M/20261109120000_sayerlack_condicao_sem_c.sql
        $M/20261111150000_sayerlack_conferir_portal.sql"
for f in $CADEIA "$MIG_REAL"; do [ -f "$f" ] || { echo "INFRA: ausente: $f"; exit 1; }; done
# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e
# cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA, (3) o assert declarado estava verde
# no controle e virou vermelho, (4) sem ERRO de SQL que o controle não tem. Uma camada por vez.
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_gate_staff:R1 sem_divergencia_vista:R3 sem_situacao:R4 sem_claim:R5 sem_po_espelho:R6
              sem_custo:S2 trilha_sem_antes:S5 sem_guc:P1 aceito_sem_diff:P2 sem_marco:P3
              dedupe_sem_conteudo:P4 herda_promocao:S6 retrato_sem_marco:S3"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -Ec '(ERROR|ERRO):  ' "$LOGDIR/controle.log" || true)"
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
    erros_sql="$(grep -Ec '(ERROR|ERRO):  ' "$log" || true)"
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
    elif [ "$erros_sql" -gt "$erros_controle" ]; then  # MENOS erro é legítimo: a sabotagem tira um RAISE esperado
      echo "  ❌ $sab — vermelha com ERRO de SQL a mais ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 -E '(ERROR|ERRO):  ' "$log" || true; } | sed 's/^/       /'
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
  sem_gate_staff)  # o POS AC4 pega isto ao aplicar; neutralizado para provar a camada do assert (uma por vez)
    trocar "$MIG" "  IF v_ator IS NULL OR NOT (public.has_role(v_ator, 'employee'::app_role) OR public.has_role(v_ator, 'master'::app_role)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[ACEITAR-STAFF] só staff aceita o pedido do portal';" "  IF v_ator IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[ACEITAR-STAFF] só staff aceita o pedido do portal';" ;;
  sem_divergencia_vista)
    trocar "$MIG" "  IF r.portal_divergencia_aberta_id IS DISTINCT FROM p_divergencia_id THEN" "  IF false THEN"
    trocar "$MIG" "  SELECT * INTO d FROM public.sayerlack_portal_divergencia WHERE id = p_divergencia_id FOR UPDATE;" "  SELECT * INTO d FROM public.sayerlack_portal_divergencia WHERE id = r.portal_divergencia_aberta_id FOR UPDATE;" ;;
  sem_situacao)
    trocar "$MIG" "  IF r.portal_situacao_codigo IS NULL OR r.portal_situacao_codigo NOT IN ('1', '5')
     OR r.portal_situacao_protocolo IS DISTINCT FROM r.portal_protocolo THEN" "  IF false THEN" ;;
  sem_claim)
    trocar "$MIG" "  IF r.disparo_claim_em IS NOT NULL THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'disparo_pendente'" "  IF false THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'disparo_pendente'"
    trocar "$MIG" "     AND disparo_claim_em IS NULL
     AND portal_divergencia_aberta_id = d.id" "     AND portal_divergencia_aberta_id = d.id" ;;
  sem_po_espelho)
    trocar "$MIG" "  IF v_po_espelho IS NOT NULL THEN" "  IF false THEN" ;;
  sem_custo)  # o custo provisório (sem IPI) ficaria como o do PO
    trocar "$MIG" "  v_atualizados := public.sayerlack_aplicar_custo_portal(r.id, v_payload, v_total);" "  v_atualizados := v_n;" ;;
  trilha_sem_antes)
    trocar "$MIG" "            'antes', v_antes, 'depois', v_depois))" "            'depois', v_depois))" ;;
  sem_guc)  # a porta entraria no modo aceito para qualquer service_role
    trocar "$MIG" "    v_guc := NULLIF(current_setting('app.sayerlack_aceitar_portal', true), '');" "    v_guc := COALESCE(NULLIF(current_setting('app.sayerlack_aceitar_portal', true), ''), r.id || ':' || v_aberta.id || ':11111111-1111-1111-1111-111111111111');" ;;
  aceito_sem_diff)
    trocar "$MIG" "    IF v_diff IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'AP009'," "    IF false THEN
      RAISE EXCEPTION USING ERRCODE = 'AP009'," ;;
  sem_marco)  # o desenho antes do Codex b: sem aberta, qualquer leitura é posterior
    trocar "$MIG" "             AND (v_marco IS NULL OR (p_origem = 'redisparo' AND v_de IS NOT NULL AND v_de > v_marco));" "             AND true;" ;;
  retrato_sem_marco)
    trocar "$MIG" "           GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate)
    RETURNING * INTO v_ret;" "           NULL
    RETURNING * INTO v_ret;" ;;
  dedupe_sem_conteudo)  # o "mesmo diff" da fatia 1 (Codex a)
    trocar "$MIG" "     AND public.sayerlack__portal_leitura_conteudo(v_aberta.leitura) = public.sayerlack__portal_leitura_conteudo(p_leitura) THEN" "     THEN" ;;
  herda_promocao)  # herdar o desconto do preço antigo como se valesse para o novo
    trocar "$MIG" "    estoque_comprometido, qtde_sem_teto, teto_cobertura_aplicado, fator_embalagem_portal
  )" "    estoque_comprometido, qtde_sem_teto, teto_cobertura_aplicado, fator_embalagem_portal, desconto_perc_aplicado
  )"
    trocar "$MIG" "a.qtde_sem_teto, coalesce(a.teto_cobertura_aplicado, false), a.fator_embalagem_portal
    FROM" "a.qtde_sem_teto, coalesce(a.teto_cobertura_aplicado, false), a.fator_embalagem_portal, a.desconto_perc_aplicado
    FROM" ;;
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
  case "$out" in *"ACEITAR_PORTAL_POS_OK"*) ok "A1 migration aplica com o NOTICE positivo de fim";; *) bad "A1 sem o NOTICE de fim";; esac
else bad "A1 migration NÃO aplicou: $(printf '%s' "$out" | grep -m1 -E 'ERROR|FALHOU' || true)"; fi
if P -1 -q -f "$MIG" >/dev/null 2>&1; then ok "A2 re-aplicar é idempotente"; else bad "A2 re-aplicar falhou"; fi
AC="public.sayerlack_aceitar_portal(bigint,bigint,text)"
FN="public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)"
HP="public.sayerlack__portal_leitura_conteudo(jsonb)"
eq "A3 RPC: anon não, authenticated sim; porta e helper fechados para authenticated" "$(Pq -c "SELECT has_function_privilege('anon','$AC','EXECUTE')::text || has_function_privilege('authenticated','$AC','EXECUTE')::text || has_function_privilege('authenticated','$FN','EXECUTE')::text || has_function_privilege('authenticated','$HP','EXECUTE')::text")" "falsetruefalsefalse"

STAFF="11111111-1111-1111-1111-111111111111"
CLI="22222222-2222-2222-2222-222222222222"
# Leitura: $1 protocolo · $2 itens (json) · $3 total · $4 condição · $5 minuto do lido_de (lido_ate = +30 s)
L() { printf '{"protocolo":"%s","itens":%s,"valor_total":%s,"condicao":"%s","lido_de":"2026-11-09T10:%02d:00Z","lido_ate":"2026-11-09T10:%02d:30Z"}' "$1" "$2" "$3" "$4" "$5" "$5"; }
C() { Pq -c "SELECT public.sayerlack_conferir_portal($1, '$2'::jsonb, ${3:-NULL}, '${4:-redisparo}')" 2>&1 || true; }
# Aceite como o usuário $4 (default staff), autenticado: $1 pedido · $2 divergência · $3 justificativa
AX() { Pq -c "SET ROLE authenticated; SELECT set_config('test.uid', '${4:-$STAFF}', false); SELECT public.sayerlack_aceitar_portal($1, $2, '${3:-Confirmado com o vendedor por telefone}')" 2>&1 | tail -1 || true; }
AXerr() { Pq -c "SET ROLE authenticated; SELECT set_config('test.uid', '${4:-$STAFF}', false); SELECT public.sayerlack_aceitar_portal($1, $2, '${3:-Confirmado com o vendedor por telefone}')" 2>&1 || true; }
campo() { python3 -I -c "import json,sys; v=json.load(sys.stdin).get('$1'); print('null' if v is None else (json.dumps(v,sort_keys=True) if isinstance(v,(list,dict)) else str(v).lower()))" 2>&1; }
GATE() { Pq -c "SELECT COALESCE(portal_divergencia_aberta_id::text,'-') FROM public.pedido_compra_sugerido WHERE id = $1"; }
NDIV() { Pq -c "SELECT count(*) || '/' || count(*) FILTER (WHERE resolvida_em IS NULL) FROM public.sayerlack_portal_divergencia WHERE pedido_id = $1"; }
K() { Pq -c "SELECT public.reposicao_claim_disparo($1, 'prova')" 2>&1 || true; }
ITENS() { Pq -c "SELECT string_agg(sku_portal_aprovado || ':' || trim_scale(qtde_final) || ':' || trim_scale(valor_linha), ';' ORDER BY sku_portal_aprovado) FROM public.pedido_compra_item WHERE pedido_id = $1"; }
NEXEC() { Pq -c "SELECT count(*) FROM public.acoes_execucoes WHERE acao = 'sayerlack_aceitar_portal'"; }
# Importa um pedido do portal e põe a situação lida (1 = Aberto) — o pedido nasce com retrato v1.
importar() {  # $1 protocolo
  local r; r="$(Pq -c "SELECT public.sayerlack_importar_pedido_portal('$1', '2026-10-26', 5181.82, '[{\"sku_portal\":\"DFA.4080LT\",\"qtde_portal\":16,\"valor_mercadoria\":4865.5584}]'::jsonb, '$STAFF', '70 - 7 DIAS')" 2>&1 || true)"
  local id; id="$(printf '%s' "$r" | campo pedido_id)"
  Pq -c "UPDATE public.pedido_compra_sugerido SET portal_situacao_codigo = '1', portal_situacao_protocolo = portal_protocolo WHERE id = ${id:-0}" >/dev/null
  printf '%s' "$id"
}

# A leitura NOVA do portal: DFA 16 → 17 (R$ 5.100,00) + GL.UM 2 (R$ 200,00), condição 30 DIAS. IPI 6,5% (NCM 38140090):
# 5100 + 331,50 + 200 + 13,00 = 5.644,50 — o total que o portal cobraria.
NOVO='[{"sku_portal":"DFA.4080LT","qtde_portal":17,"valor_mercadoria":5100.00},{"sku_portal":"GL.UM","qtde_portal":2,"valor_mercadoria":200.00}]'
TOT=5644.50

echo "── R: recusas (nada escrito) ──"
P1="$(importar 2140603)"
Pq -c "UPDATE public.pedido_compra_item SET estoque_atual = 7, ponto_pedido = 12, desconto_perc_aplicado = 9 WHERE pedido_id = $P1" >/dev/null
r="$(C "$P1" "$(L 2140603 "$NOVO" "$TOT" "30 DIAS" 2)" 2)"; D1="$(printf '%s' "$r" | campo divergencia_id)"
eq "R0 a releitura do portal abre a divergência com o gate" "$(printf '%s' "$r" | campo divergente)|$(GATE "$P1")" "true|$D1"
# A marca do ramo, não só "lançou 42501": a RPC de custo também barra não-staff (2ª camada) e esconderia o gate.
eq "R1 não-staff (customer) = 42501 do gate da RPC [ACEITAR-STAFF]" "$(r1="$(AXerr "$P1" "$D1" "Confirmado com o vendedor" "$CLI")"; printf '%s' "$(printf '%s' "$r1" | sqlstate)"; case "$r1" in *'[ACEITAR-STAFF]'*) printf '|marca';; *) printf '|sem-marca';; esac)" "42501|marca"
eq "R2 justificativa curta = 22023" "$(AXerr "$P1" "$D1" "curta" | sqlstate)" "22023"
eq "R3 divergência que a tela NÃO viu (id antigo): divergencia_mudou" "$(AX "$P1" 999 | campo motivo)" "divergencia_mudou"
Pq -c "UPDATE public.pedido_compra_sugerido SET portal_situacao_codigo = '6' WHERE id = $P1" >/dev/null
eq "R4 situação 6 (cancelado) no portal: situacao_nao_aceitavel" "$(AX "$P1" "$D1" | campo motivo)" "situacao_nao_aceitavel"
Pq -c "UPDATE public.pedido_compra_sugerido SET portal_situacao_codigo = '5', disparo_claim_em = now() WHERE id = $P1" >/dev/null
eq "R5 claim aberto: disparo_pendente" "$(AX "$P1" "$D1" | campo motivo)" "disparo_pendente"
Pq -c "UPDATE public.pedido_compra_sugerido SET disparo_claim_em = NULL WHERE id = $P1;
       INSERT INTO public.purchase_orders_tracking (empresa, numero_pedido, numero_contrato_fornecedor, status) VALUES ('OBEN', '9001', '2199999/2140603', 'PENDENTE')" >/dev/null
eq "R6 PO lançado à mão no espelho (contrato composto): po_no_espelho" "$(AX "$P1" "$D1" | campo motivo)" "po_no_espelho"
Pq -c "UPDATE public.purchase_orders_tracking SET status = 'CANCELADO' WHERE numero_pedido = '9001';
       UPDATE public.pedido_compra_sugerido SET omie_pedido_compra_id = '777' WHERE id = $P1" >/dev/null
eq "R7 pedido com PO: tem_po" "$(AX "$P1" "$D1" | campo motivo)" "tem_po"
Pq -c "UPDATE public.pedido_compra_sugerido SET omie_pedido_compra_id = NULL WHERE id = $P1" >/dev/null
eq "R8 nenhuma recusa escreveu: itens antigos, gate, sem trilha" "$(ITENS "$P1")|$(GATE "$P1")|$(NEXEC)" "DFA.4080LT:16:5181.82|$D1|0"

echo "── S: aceite ──"
r="$(AX "$P1" "$D1")"
eq "S1 aceito, retrato v2, o pedido e a trilha" "$(printf '%s' "$r" | campo aceito)|$(printf '%s' "$r" | campo retrato_versao)|$(NEXEC)" "true|2|1"
eq "S2 itens da leitura com o custo pela prova (IPI 6,5% dentro) e o cabeçalho: total, provado, num_skus, condição 30 DIAS → T54" "$(ITENS "$P1")|$(Pq -c "SELECT trim_scale(valor_total) || '|' || trim_scale(valor_total_portal_provado) || '|' || num_skus || '|' || condicao_pagamento_codigo || '|' || condicao_portal_lida FROM public.pedido_compra_sugerido WHERE id = $P1")" "DFA.4080LT:17:5431.5;GL.UM:2:213|5644.5|5644.5|2|T54|30 DIAS"
eq "S3 retrato v2 'aceito_portal' com a evidência da divergência e o marco = fim da leitura aceita" "$(Pq -c "SELECT origem || '|' || evidencia_id || '|' || trim_scale(valor_total) || '|' || to_char(leitura_lido_ate AT TIME ZONE 'UTC', 'HH24:MI:SS') FROM public.sayerlack_portal_retrato WHERE pedido_id = $P1 AND versao = 2")" "aceito_portal|2|5644.5|10:02:30"
eq "S4 divergência fechada 'aceito_portal' com o ator; gate solto" "$(Pq -c "SELECT resolucao || '|' || resolvida_por FROM public.sayerlack_portal_divergencia WHERE id = $D1")|$(GATE "$P1")" "aceito_portal|$STAFF|-"
eq "S5 trilha com o ANTES (1 item, 16) e o DEPOIS (2 itens), a justificativa e o ator" "$(Pq -c "SELECT executado_por || '|' || trim_scale((detalhes->'antes'->'itens'->0->>'qtde_final')::numeric) || '|' || jsonb_array_length(detalhes->'depois'->'itens') || '|' || (detalhes->>'justificativa') || '|' || (detalhes->'antes'->'cabecalho'->>'condicao_pagamento_codigo') FROM public.acoes_execucoes WHERE acao = 'sayerlack_aceitar_portal'")" "$STAFF|16|2|Confirmado com o vendedor por telefone|A07"
eq "S6 item do mesmo SKU herda o estoque do motor, não o desconto do preço antigo; item novo nasce com qtde_sugerida = qtde" "$(Pq -c "SELECT string_agg(sku_portal_aprovado || ':' || COALESCE(trim_scale(estoque_atual)::text,'-') || ':' || COALESCE(trim_scale(desconto_perc_aplicado)::text,'-') || ':' || trim_scale(qtde_sugerida), ';' ORDER BY sku_portal_aprovado) FROM public.pedido_compra_item WHERE pedido_id = $P1")" "DFA.4080LT:7:-:16;GL.UM:-:-:2"
r="$(C "$P1" "$(L 2140603 "$NOVO" "$TOT" "30 DIAS" 5)" 2)"
eq "S7 o re-disparo (releitura posterior) bate com o pedido aceito e o claim passa" "$(printf '%s' "$r" | campo divergente)|$(K "$P1" | campo claimed)" "false|true"
Pq -c "UPDATE public.pedido_compra_sugerido SET disparo_claim_em = NULL, disparo_claim_por = NULL WHERE id = $P1" >/dev/null
eq "S8 aceitar de novo, sem divergência: sem_divergencia (e nenhuma 2ª trilha)" "$(AX "$P1" "$D1" | campo motivo)|$(NEXEC)" "sem_divergencia|1"

echo "── P: porta ──"
r="$(C "$P1" "$(L 2140603 '[{"sku_portal":"DFA.4080LT","qtde_portal":16,"valor_mercadoria":4865.5584}]' 5181.82 "70 - 7 DIAS" 1)" 1)"
eq "P3 leitura ANTIGA (10:01, anterior ao aceite) chegando depois: leitura_antiga, não reabre nem empilha (Codex b)" "$(printf '%s' "$r" | campo motivo)|$(GATE "$P1")|$(NDIV "$P1")" "leitura_antiga|-|1/0"
P2="$(importar 2140604)"
r="$(C "$P2" "$(L 2140604 "$NOVO" "$TOT" "30 DIAS" 2)")"; D2="$(printf '%s' "$r" | campo divergencia_id)"
eq "P1 a porta em modo aceito, sem o GUC da RPC (service_role direto) = 42501" "$(Pq -c "SET ROLE service_role; SELECT public.sayerlack_conferir_portal($P2, (SELECT leitura FROM public.sayerlack_portal_divergencia WHERE id = $D2), NULL, 'aceito_portal')" 2>&1 | sqlstate)|$(GATE "$P2")" "42501|$D2"
eq "P2 modo aceito com os itens NÃO reescritos (o pedido antigo) = AP009, nada gravado" "$(Pq -c "SELECT set_config('app.sayerlack_aceitar_portal', '$P2:$D2:$STAFF', false); SELECT public.sayerlack_conferir_portal($P2, (SELECT leitura FROM public.sayerlack_portal_divergencia WHERE id = $D2), NULL, 'aceito_portal')" 2>&1 | sqlstate)|$(GATE "$P2")|$(Pq -c "SELECT count(*) FROM public.sayerlack_portal_retrato WHERE pedido_id = $P2")" "AP009|$D2|1"
# Pedido nascido no app (sem retrato): a 1ª leitura diverge em quantidade; outra, posterior, com a MESMA quantidade e
# outro preço/total/condição — sem retrato isso não entra no diff, mas a leitura guardada já não é a do portal.
P -q -c "INSERT INTO public.pedido_compra_sugerido (id, empresa, status, status_envio_portal, portal_protocolo) VALUES (301, 'OBEN', 'aprovado_aguardando_disparo', 'sucesso_portal', '2150301');
         INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final, sku_portal_aprovado, fator_portal_aprovado) VALUES (301, '12101724200', 12, 12, 'GL.UM', 1);" >/dev/null
r1="$(C 301 "$(L 2150301 '[{"sku_portal":"GL.UM","qtde_portal":24,"valor_mercadoria":240.00}]' 255.60 "70 - 7 DIAS" 1)")"
r2="$(C 301 "$(L 2150301 '[{"sku_portal":"GL.UM","qtde_portal":24,"valor_mercadoria":240.00}]' 255.60 "70 - 7 DIAS" 2)")"
eq "P5 o mesmo diff com o MESMO conteúdo não empilha (fatia 1 intacta)" "$(printf '%s' "$r2" | campo divergencia_id)|$(NDIV 301)" "$(printf '%s' "$r1" | campo divergencia_id)|1/1"
r3="$(C 301 "$(L 2150301 '[{"sku_portal":"GL.UM","qtde_portal":24,"valor_mercadoria":300.00}]' 319.50 "28 - 28 DIAS" 3)")"
eq "P4 o mesmo diff com preço/total/condição NOVOS substitui a aberta: novo id, a leitura guardada é a nova (Codex a)" "$([ "$(printf '%s' "$r3" | campo divergencia_id)" != "$(printf '%s' "$r1" | campo divergencia_id)" ] && echo novo-id || echo mesmo-id)|$(NDIV 301)|$(Pq -c "SELECT leitura->>'valor_total' FROM public.sayerlack_portal_divergencia WHERE pedido_id = 301 AND resolvida_em IS NULL")" "novo-id|2/1|319.50"

echo "── F: leitura que não vira pedido desfaz tudo ──"
F1="$(importar 2140605)"
r="$(C "$F1" "$(L 2140605 '[{"sku_portal":"SEM.MAPA","qtde_portal":1,"valor_mercadoria":10.00}]' 10.65 "70 - 7 DIAS" 2)")"; DF1="$(printf '%s' "$r" | campo divergencia_id)"
eq "F1 SKU do portal sem de-para = IP002; itens, gate e trilha intactos" "$(AXerr "$F1" "$DF1" | sqlstate)|$(ITENS "$F1")|$(GATE "$F1")|$(NEXEC)" "IP002|DFA.4080LT:16:5181.82|$DF1|1"
F2="$(importar 2140606)"
r="$(C "$F2" "$(L 2140606 '[{"sku_portal":"CX.DOIS","qtde_portal":3,"valor_mercadoria":30.00}]' 31.95 "70 - 7 DIAS" 2)")"; DF2="$(printf '%s' "$r" | campo divergencia_id)"
eq "F2 quantidade que não vira inteira no Omie (3 ÷ fator 2) = IP003" "$(AXerr "$F2" "$DF2" | sqlstate)|$(GATE "$F2")" "IP003|$DF2"
F3="$(importar 2140607)"
r="$(C "$F3" "$(L 2140607 "$NOVO" 5700.00 "30 DIAS" 2)")"; DF3="$(printf '%s' "$r" | campo divergencia_id)"
eq "F3 total do portal que a prova do IPI não fecha = CP007; nada gravado" "$(AXerr "$F3" "$DF3" | sqlstate)|$(ITENS "$F3")|$(GATE "$F3")|$(Pq -c "SELECT count(*) FROM public.sayerlack_portal_retrato WHERE pedido_id = $F3")" "CP007|DFA.4080LT:16:5181.82|$DF3|1"

echo "── K: releitura × aceite em 2 conexões ──"
# A releitura do portal trava o pedido e SUBSTITUI a divergência (preço novo); o aceite da antiga chega no meio,
# espera a trava e, ao destravar, tem de ver o gate novo: divergencia_mudou — nunca aplicar a leitura que o humano viu
# por cima da que o portal mostra agora.
K1="$(importar 2140608)"
r="$(C "$K1" "$(L 2140608 "$NOVO" "$TOT" "30 DIAS" 2)")"; DK="$(printf '%s' "$r" | campo divergencia_id)"
( Pq -c "BEGIN; SELECT public.sayerlack_conferir_portal($K1, '$(L 2140608 '[{"sku_portal":"DFA.4080LT","qtde_portal":17,"valor_mercadoria":5200.00},{"sku_portal":"GL.UM","qtde_portal":2,"valor_mercadoria":200.00}]' 5751.00 "30 DIAS" 4)'::jsonb, NULL, 'redisparo'); SELECT pg_sleep(1.5); COMMIT;" > "$TMP/k.out" 2>&1 ) &
pid_a=$!
sleep 0.6
rb="$(AX "$K1" "$DK")"
wait "$pid_a" || true
eq "K2 aceite que esperou a releitura vê a divergência nova e recusa (divergencia_mudou); nada aplicado" "$(printf '%s' "$rb" | campo motivo)|$(ITENS "$K1")|$([ "$(GATE "$K1")" != "$DK" ] && [ "$(GATE "$K1")" != "-" ] && echo gate-novo || echo gate-errado)" "divergencia_mudou|DFA.4080LT:16:5181.82|gate-novo"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then echo "RESULTADO: VERMELHO (LC=$LOC)"; exit 1; fi
echo "RESULTADO: VERDE (LC=$LOC)"
