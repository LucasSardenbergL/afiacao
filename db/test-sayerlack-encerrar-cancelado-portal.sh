#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261110100000_sayerlack_encerrar_cancelado_no_portal.sql (Onda 5A fatia 2, item 5.3)
# ║      bash db/test-sayerlack-encerrar-cancelado-portal.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-sayerlack-encerrar-cancelado-portal.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sayerlack-encerrar-cancelado-portal.sh   (2º idioma)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║   P  porta: só master, só com prova "ausente" do AFI-<id>, só OBEN+protocolo+sucesso_portal+sem PO+6 do
# ║      protocolo atual, recusa pendência de disparo (qualquer idade) e PO no espelho (AFI ou contrato).
# ║   G  guarda da tabela: pedido com protocolo e sem PO não vira cancelad% nem é apagado fora da porta —
# ║      nem em duas instruções (trocar status_envio_portal/status antes); a GUC não sobra aberta.
# ║   T  trilha imutável e não gravável por authenticated.
# ║   A  ACL.
# ║  Diário: docs/historico/importar-pedido-portal-sayerlack.md
# ╚═════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5731}"
SLUG="sayerlack-encerrar-cancelado-portal"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C; o idioma do SERVIDOR vem de $LOC
MIG_REAL="$REPO_ROOT/supabase/migrations/20261110100000_sayerlack_encerrar_cancelado_no_portal.sql"
[ -f "$MIG_REAL" ] || { echo "INFRA: ausente: $MIG_REAL"; exit 1; }

# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e
# cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA, (3) o assert declarado estava verde
# no controle e virou vermelho, (4) sem ERRO de SQL que o controle não tem. Uma camada por vez.
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_veto_claim:P6 sem_espelho_afi:P9 sem_espelho_contrato:P10 sem_master:P3 prova_sem_codigo:P4b
              sem_guarda:G1,G4 guarda_por_status:G2,G3 guc_nao_limpa:G8 trilha_mutavel:T1,T2 sem_seis:P8"
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
  sem_veto_claim)
    trocar "$MIG" "  IF r.disparo_claim_em IS NOT NULL THEN
    RETURN" "  IF false THEN
    RETURN"
    trocar "$MIG" "     AND disparo_claim_em IS NULL
     AND portal_situacao_codigo = '6';" "     AND portal_situacao_codigo = '6';"
    trocar "$MIG" "  IF v_src NOT LIKE '%IF r.disparo_claim_em IS NOT NULL THEN%' THEN" "  IF false THEN" ;;
  sem_espelho_afi)
    trocar "$MIG" "       AND (btrim(COALESCE(t.omie_codigo_integracao, '')) = 'AFI-' || r.id
            OR EXISTS" "       AND (false
            OR EXISTS" ;;
  sem_espelho_contrato)
    trocar "$MIG" "                        WHERE btrim(c.n) = r.portal_protocolo))" "                        WHERE false))" ;;
  sem_master)
    trocar "$MIG" "  IF NOT public.has_role(p_ator, 'master'::app_role) THEN" "  IF false THEN" ;;
  prova_sem_codigo)
    trocar "$MIG" "     OR p_prova_omie->>'codigo_integracao' IS DISTINCT FROM ('AFI-' || p_pedido_id) THEN" "     THEN" ;;
  sem_guarda)
    trocar "$MIG" "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__veta_encerrar_aceito_no_portal();" \
      "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__veta_encerrar_aceito_no_portal();
ALTER TABLE public.pedido_compra_sugerido DISABLE TRIGGER trg_veta_encerrar_aceito_no_portal;"
    trocar "$MIG" "                   AND tgrelid = 'public.pedido_compra_sugerido'::regclass AND tgenabled <> 'D') THEN" \
      "                   AND tgrelid = 'public.pedido_compra_sugerido'::regclass AND tgenabled <> 'D') AND false THEN" ;;
  guarda_por_status)  # o desenho v1: predicado pelo estado do portal, que staff troca numa instrução anterior
    trocar "$MIG" "  IF btrim(COALESCE(OLD.portal_protocolo, '')) = '' THEN" \
      "  IF btrim(COALESCE(OLD.portal_protocolo, '')) = '' OR OLD.status_envio_portal IS DISTINCT FROM 'sucesso_portal'
     OR OLD.status NOT IN ('aprovado_aguardando_disparo', 'falha_envio') THEN" ;;
  guc_nao_limpa)
    trocar "$MIG" "  PERFORM set_config('app.sayerlack_encerrar_cancelado', '', true);
  IF v_n <> 1 THEN" "  IF v_n <> 1 THEN" ;;
  trilha_mutavel)
    trocar "$MIG" "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__trilha_encerramento_imutavel();" \
      "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__trilha_encerramento_imutavel();
ALTER TABLE public.sayerlack_encerramento_cancelado_portal DISABLE TRIGGER trg_trilha_encerramento_imutavel;"
    trocar "$MIG" "                   AND tgrelid = 'public.sayerlack_encerramento_cancelado_portal'::regclass AND tgenabled <> 'D') THEN" \
      "                   AND tgrelid = 'public.sayerlack_encerramento_cancelado_portal'::regclass AND tgenabled <> 'D') AND false THEN" ;;
  sem_seis)
    trocar "$MIG" "  IF r.portal_situacao_codigo IS DISTINCT FROM '6' OR r.portal_situacao_protocolo IS DISTINCT FROM r.portal_protocolo THEN" \
      "  IF r.portal_situacao_protocolo IS DISTINCT FROM r.portal_protocolo AND false THEN"
    trocar "$MIG" "     AND disparo_claim_em IS NULL
     AND portal_situacao_codigo = '6';" "     AND disparo_claim_em IS NULL;" ;;
  *) echo "INFRA: sabotagem desconhecida: $SAB"; exit 1 ;;
esac
if [ -n "$SAB" ]; then
  if cmp -s "$MIG" "$MIG_REAL"; then echo "INFRA: sabotagem $SAB inerte"; exit 1; fi
  echo "SABOTAGEM ATIVA em $SAB"
fi

# ── Banco: papéis do Supabase + o recorte das tabelas que a migration toca ──
P -q <<'SQL' >/dev/null
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-0000000000aa', 'master'),
                                     ('00000000-0000-0000-0000-0000000000bb', 'employee');
CREATE TYPE public.po_status AS ENUM ('CRIADO', 'FATURADO', 'RECEBIDO', 'CANCELADO');
CREATE TYPE public.empresa_t AS ENUM ('OBEN', 'COLACOR');
CREATE TABLE public.purchase_orders_tracking (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, empresa public.empresa_t NOT NULL, status public.po_status,
  omie_codigo_integracao text, numero_contrato_fornecedor text
);
CREATE TABLE public.sync_state (entity_type text, account text, status text, last_sync_at timestamptz);
INSERT INTO public.sync_state VALUES ('pedidos_compra', 'oben', 'complete', '2026-11-08 02:15:00+00');
CREATE TABLE public.pedido_compra_sugerido (
  id                        bigint PRIMARY KEY,
  empresa                   text NOT NULL,
  status                    text NOT NULL,
  status_envio_portal       text,
  portal_protocolo          text,
  omie_pedido_compra_id     text,
  disparo_claim_em          timestamptz,
  disparo_claim_por         text,
  portal_situacao_codigo    text,
  portal_situacao_texto     text,
  portal_situacao_em        timestamptz,
  portal_situacao_ate       timestamptz,
  portal_situacao_protocolo text,
  cancelado_por             text,
  cancelado_em              timestamptz,
  justificativa_cancelamento text,
  portal_proximo_retry_em   timestamptz,
  atualizado_em             timestamptz
);
-- 6 = cancelado no portal (protocolo atual); os demais variam UMA condição cada.
INSERT INTO public.pedido_compra_sugerido(id, empresa, status, status_envio_portal, portal_protocolo, omie_pedido_compra_id,
  disparo_claim_em, portal_situacao_codigo, portal_situacao_texto, portal_situacao_em, portal_situacao_ate, portal_situacao_protocolo)
SELECT v.id, v.emp, v.st, v.sep, v.prot, v.po, v.claim, v.cod, CASE WHEN v.cod IS NULL THEN NULL ELSE v.cod || ' - x' END,
       CASE WHEN v.cod IS NULL THEN NULL ELSE '2026-11-09 15:00+00'::timestamptz END,
       CASE WHEN v.cod IS NULL THEN NULL ELSE '2026-11-09 15:02+00'::timestamptz END, CASE WHEN v.cod IS NULL THEN NULL ELSE v.prot END
  FROM (VALUES
    (1,  'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141001', NULL,   NULL::timestamptz, '6'),
    (2,  'OBEN',    'falha_envio',                 'sucesso_portal', '2141002', '',     NULL,              '6'),
    (3,  'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141003', '0',    NULL,              '6'),
    (4,  'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141004', NULL,   now() - interval '3 hours', '6'),
    (5,  'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141005', '9001', NULL,              '6'),
    (6,  'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141006', NULL,   NULL,              '1'),
    (7,  'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141007', NULL,   NULL,              NULL),
    (8,  'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141008', NULL,   NULL,              '6'),
    (9,  'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141009', NULL,   NULL,              '6'),
    (10, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141010', NULL,   NULL,              '6'),
    (11, 'OBEN',    'disparado',                   'sucesso_portal', '2141011', NULL,   NULL,              '6'),
    (12, 'OBEN',    'aprovado_aguardando_disparo', 'enviado_portal', '2141012', NULL,   NULL,              '6'),
    (13, 'COLACOR', 'aprovado_aguardando_disparo', 'sucesso_portal', '2141013', NULL,   NULL,              '6'),
    (20, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141020', NULL,   NULL,              NULL),
    (21, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141021', NULL,   NULL,              NULL),
    (22, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141022', NULL,   NULL,              NULL),
    (23, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141023', NULL,   NULL,              NULL),
    (24, 'OBEN',    'aprovado_aguardando_disparo', 'nao_aplicavel',  NULL,      NULL,   NULL,              NULL),
    (25, 'OBEN',    'disparado',                   'sucesso_portal', '2141025', '9025', NULL,              NULL),
    (26, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141026', NULL,   NULL,              NULL),
    (27, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141027', NULL,   NULL,              NULL)
  ) AS v(id, emp, st, sep, prot, po, claim, cod);
UPDATE public.pedido_compra_sugerido SET portal_situacao_protocolo = '2141999' WHERE id = 8;  -- 6 de OUTRO protocolo
INSERT INTO public.purchase_orders_tracking(empresa, status, omie_codigo_integracao, numero_contrato_fornecedor) VALUES
  ('OBEN',    'CRIADO',    'AFI-9',   NULL),                -- 9: PO com o código do app no espelho
  ('OBEN',    'CRIADO',    'MANUAL',  '2140000 / 2141010'), -- 10: PO manual com o protocolo no contrato
  ('OBEN',    'CANCELADO', 'AFI-2',   '2141002'),           -- 2: só PO CANCELADO no espelho → não impede
  ('COLACOR', 'CRIADO',    'AFI-3',   '2141003');           -- 3: outra empresa → não impede
SQL

echo "── A: aplicar ──"
if out="$(P -1 -f "$MIG" 2>&1)"; then
  case "$out" in *"POSTCONDICAO_OK sayerlack encerrar cancelado no portal"*) ok "A1 migration aplica com o NOTICE positivo de fim";; *) bad "A1 sem o NOTICE de fim";; esac
else bad "A1 migration NÃO aplicou: $(printf '%s' "$out" | grep -m1 -E 'ERROR|FALHOU' || true)"; fi
if P -1 -q -f "$MIG" >/dev/null 2>&1; then ok "A2 re-aplicar é idempotente"; else bad "A2 re-aplicar falhou"; fi
FN="public.sayerlack_encerrar_cancelado_no_portal(bigint,uuid,text,jsonb,uuid)"
eq "A3 porta fechada p/ anon+authenticated, aberta p/ service_role" "$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE')::text || has_function_privilege('authenticated','$FN','EXECUTE')::text || has_function_privilege('service_role','$FN','EXECUTE')::text")" "falsefalsetrue"
eq "A4 trilha: authenticated só lê" "$(Pq -c "SELECT has_table_privilege('authenticated','public.sayerlack_encerramento_cancelado_portal','SELECT')::text || has_table_privilege('authenticated','public.sayerlack_encerramento_cancelado_portal','INSERT')::text || has_table_privilege('authenticated','public.sayerlack_encerramento_cancelado_portal','UPDATE')::text || has_table_privilege('authenticated','public.sayerlack_encerramento_cancelado_portal','DELETE')::text")" "truefalsefalsefalse"

MASTER="00000000-0000-0000-0000-0000000000aa"
EMPREG="00000000-0000-0000-0000-0000000000bb"
prova() { printf '{"tipo":"ausente","codigo_integracao":"AFI-%s","fault":"ERROR: pedido nao cadastrado [AFI-%s]"}' "$1" "$1"; }
# $1 pedido, $2 ator, $3 prova jsonb → jsonb devolvido (ou o erro)
E() { Pq -c "SELECT public.sayerlack_encerrar_cancelado_no_portal($1, '$2'::uuid, 'Fornecedor confirmou o cancelamento por telefone', '$3'::jsonb, NULL)" 2>&1 || true; }
campo() { python3 -I -c "import json,sys; v=json.load(sys.stdin).get('$1'); print('null' if v is None else str(v).lower())" 2>&1; }
ST() { Pq -c "SELECT status || '|' || COALESCE(status_envio_portal,'-') FROM public.pedido_compra_sugerido WHERE id = $1" 2>&1 || true; }

echo "── P: porta ──"
r="$(E 1 "$MASTER" "$(prova 1)")"
eq "P1 cancelado no portal, sem PO, sem pendência: encerra" "$(printf '%s' "$r" | campo encerrado)" "true"
eq "P1b status cancelado_humano, portal segue sucesso_portal (o fato)" "$(ST 1)" "cancelado_humano|sucesso_portal"
eq "P1c trilha com ator, protocolo, prova e sync do espelho" "$(Pq -c "SELECT ator::text || '|' || protocolo || '|' || (prova_omie->>'tipo') || '|' || espelho_sync_status FROM public.sayerlack_encerramento_cancelado_portal WHERE pedido_id = 1")" "$MASTER|2141001|ausente|complete"
eq "P2 PO vazio ('') e '0' contam como sem PO" "$(E 2 "$MASTER" "$(prova 2)" | campo encerrado)|$(E 3 "$MASTER" "$(prova 3)" | campo encerrado)" "true|true"
eq "P3 ator sem master = 42501" "$(E 6 "$EMPREG" "$(prova 6)" | sqlstate)" "42501"
eq "P4 prova que não é 'ausente' = 22023" "$(E 20 "$MASTER" '{"tipo":"indeterminado","codigo_integracao":"AFI-20"}' | sqlstate)" "22023"
eq "P4b prova 'ausente' de OUTRO pedido = 22023" "$(E 1 "$MASTER" "$(prova 5)" | sqlstate)|$(E 9 "$MASTER" "$(prova 1)" | sqlstate)" "22023|22023"
eq "P5 justificativa curta = 22023" "$(Pq -c "SELECT public.sayerlack_encerrar_cancelado_no_portal(20, '$MASTER'::uuid, 'curta', '$(prova 20)'::jsonb, NULL)" 2>&1 | sqlstate)" "22023"
r="$(E 4 "$MASTER" "$(prova 4)")"
eq "P6 pendência de disparo aberta (mesmo de 3 h) recusa e não muda nada" "$(printf '%s' "$r" | campo motivo)|$(ST 4)" "disparo_pendente|aprovado_aguardando_disparo|sucesso_portal"
eq "P7 com PO no app recusa" "$(E 5 "$MASTER" "$(prova 5)" | campo motivo)" "tem_po"
eq "P8 situação 1, sem situação e 6 de outro protocolo recusam" "$(E 6 "$MASTER" "$(prova 6)" | campo motivo)|$(E 7 "$MASTER" "$(prova 7)" | campo motivo)|$(E 8 "$MASTER" "$(prova 8)" | campo motivo)" "nao_cancelado_no_portal|nao_cancelado_no_portal|nao_cancelado_no_portal"
eq "P9 PO com AFI-<id> no espelho recusa" "$(E 9 "$MASTER" "$(prova 9)" | campo motivo)" "po_no_espelho"
eq "P10 PO manual com o protocolo no contrato ('a / b') recusa" "$(E 10 "$MASTER" "$(prova 10)" | campo motivo)" "po_no_espelho"
eq "P11 disparado e enviado_portal recusam" "$(E 11 "$MASTER" "$(prova 11)" | campo motivo)|$(E 12 "$MASTER" "$(prova 12)" | campo motivo)" "status_nao_encerravel|portal_nao_confirmado"
eq "P12 outra empresa recusa" "$(E 13 "$MASTER" "$(prova 13)" | campo motivo)" "sem_protocolo_do_portal"
eq "P13 encerrar de novo recusa (status já cancelado)" "$(E 1 "$MASTER" "$(prova 1)" | campo motivo)" "status_nao_encerravel"
eq "P14 inexistente recusa" "$(E 999 "$MASTER" "$(prova 999)" | campo motivo)" "pedido_nao_encontrado"
eq "P15 uma trilha por encerramento" "$(Pq -c "SELECT string_agg(pedido_id::text, ',' ORDER BY pedido_id) FROM public.sayerlack_encerramento_cancelado_portal")" "1,2,3"

echo "── G: guarda da tabela ──"
eq "G1 UPDATE cru para cancelado_humano = 42501" "$(Pq -c "UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id=20" 2>&1 | sqlstate)" "42501"
eq "G2 trocar status_envio_portal antes não fura (2 instruções)" "$(Pq -c "UPDATE public.pedido_compra_sugerido SET status_envio_portal='nao_aplicavel' WHERE id=21" >/dev/null 2>&1; Pq -c "UPDATE public.pedido_compra_sugerido SET status='cancelado' WHERE id=21" 2>&1 | sqlstate)" "42501"
eq "G3 passar por status intermediário não fura" "$(Pq -c "UPDATE public.pedido_compra_sugerido SET status='pendente_aprovacao' WHERE id=22" >/dev/null 2>&1; Pq -c "UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id=22" 2>&1 | sqlstate)" "42501"
eq "G4 DELETE de pedido com protocolo e sem PO = 42501" "$(Pq -c "DELETE FROM public.pedido_compra_sugerido WHERE id=23" 2>&1 | sqlstate)" "42501"
eq "G5 sem protocolo e com PO seguem livres" "$(Pq -c "UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id IN (24,25) RETURNING id" 2>&1 | tr '\n' ',')" "24,25,"
eq "G6 outras colunas seguem livres" "$(Pq -c "UPDATE public.pedido_compra_sugerido SET atualizado_em=now() WHERE id=26 RETURNING id" 2>&1)" "26"
eq "G7 SQL Editor: GUC com o id libera; com outro id não" "$(Pq -c "BEGIN; SET LOCAL app.sayerlack_encerrar_cancelado = '999'; UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id=26; COMMIT;" 2>&1 | sqlstate)|$(Pq -c "BEGIN; SET LOCAL app.sayerlack_encerrar_cancelado = '26'; UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id=26; COMMIT; SELECT status FROM public.pedido_compra_sugerido WHERE id=26;" 2>&1 | tail -1)" "42501|cancelado_humano"
Pq -c "UPDATE public.pedido_compra_sugerido SET portal_situacao_codigo='6', portal_situacao_texto='6 - x', portal_situacao_em='2026-11-09 15:00+00', portal_situacao_ate='2026-11-09 15:02+00', portal_situacao_protocolo=portal_protocolo WHERE id=27" >/dev/null
eq "G8 a porta não deixa a GUC aberta na transação" "$(Pq -c "BEGIN; SELECT public.sayerlack_encerrar_cancelado_no_portal(27, '$MASTER'::uuid, 'Fornecedor confirmou o cancelamento por telefone', '$(prova 27)'::jsonb, NULL); DELETE FROM public.pedido_compra_sugerido WHERE id=27; COMMIT;" 2>&1 | sqlstate)" "42501"

echo "── T: trilha ──"
eq "T1 UPDATE na trilha = 42501" "$(Pq -c "UPDATE public.sayerlack_encerramento_cancelado_portal SET justificativa='x' WHERE pedido_id=1" 2>&1 | sqlstate)" "42501"
eq "T2 DELETE na trilha = 42501" "$(Pq -c "DELETE FROM public.sayerlack_encerramento_cancelado_portal WHERE pedido_id=1" 2>&1 | sqlstate)" "42501"
eq "T3 authenticated não grava na trilha = 42501" "$(Pq -c "SET ROLE authenticated; INSERT INTO public.sayerlack_encerramento_cancelado_portal(pedido_id, protocolo, status_antes, situacao_texto, situacao_lida_de, situacao_lida_ate, prova_omie, ator, justificativa) VALUES (1,'1','x','x',now(),now(),'{}','$MASTER','xxxxxxxxxxxx')" 2>&1 | sqlstate)" "42501"
eq "T4 authenticated master lê a trilha (RLS)" "$(Pq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '$MASTER'; SELECT count(*) FROM public.sayerlack_encerramento_cancelado_portal; COMMIT;" 2>&1 | grep -E '^[0-9]+$' | tail -1)" "3"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then echo "RESULTADO: VERMELHO (LC=$LOC)"; exit 1; fi
echo "RESULTADO: VERDE — test-sayerlack-encerrar-cancelado-portal (LC=$LOC)"
