#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261111110000_sayerlack_vincular_po_manual.sql (revisão 2, item 7.1)
# ║      bash db/test-sayerlack-vincular-po-manual.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-sayerlack-vincular-po-manual.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sayerlack-vincular-po-manual.sh   (2º idioma)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║   A  aplica com o NOTICE de fim, idempotente, ACL (só service_role).
# ║   V  porta: contrato por TOKEN exato (composto "a / b" vale; substring não), AFI-<id> próprio vale; recusa
# ║      claim aberto, PO no app, status não vinculável, candidato ambíguo, PO de outro pedido (AFI-<outro> ou já
# ║      vinculado), PO cancelado/outra empresa; conteúdo: SKU, quantidade e valor (tolerância por unidade) —
# ║      ausente nunca é zero; trilha em acoes_execucoes com antes/depois; recusa não muda nada.
# ║  Diário: docs/historico/importar-pedido-portal-sayerlack.md
# ╚═════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5761}"
SLUG="sayerlack-vincular-po-manual"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C; o idioma do SERVIDOR vem de $LOC
MIG_REAL="$REPO_ROOT/supabase/migrations/20261111110000_sayerlack_vincular_po_manual.sql"
[ -f "$MIG_REAL" ] || { echo "INFRA: ausente: $MIG_REAL"; exit 1; }
# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e
# cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA, (3) o assert declarado estava verde
# no controle e virou vermelho, (4) sem ERRO de SQL que o controle não tem. Uma camada por vez.
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_veto_claim:V4 contrato_por_substring:V3 sem_ambiguo:V7 sem_dono_afi:V8 sem_dono_vinculado:V9
              sem_qtde:V10 sem_full_join:V11 tolerancia_frouxa:V13 ausente_vira_zero:V15,V16 sem_trilha:V1c
              cancelado_vale:V18 sem_status:V6"
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
    trocar "$MIG" "     AND status = r.status
     AND disparo_claim_em IS NULL
" "     AND status = r.status
" ;;
  contrato_por_substring)  # o desenho ingênuo: LIKE no contrato
    trocar "$MIG" "                      WHERE btrim(c.n) = v_proto));" "                      WHERE t.numero_contrato_fornecedor LIKE '%' || v_proto || '%'));" ;;
  sem_ambiguo)
    trocar "$MIG" "  IF v_n > 1 THEN" "  IF false THEN" ;;
  sem_dono_afi)
    trocar "$MIG" "     AND btrim(v_po.omie_codigo_integracao) <> 'AFI-' || r.id THEN" "     AND false THEN" ;;
  sem_dono_vinculado)
    trocar "$MIG" "  IF v_dono IS NOT NULL THEN" "  IF false THEN" ;;
  sem_qtde)
    trocar "$MIG" "      OR j.qtde_app <> j.qtde_po
" "" ;;
  sem_full_join)
    trocar "$MIG" "      FROM app a FULL JOIN po o ON o.sku = a.sku" "      FROM app a LEFT JOIN po o ON o.sku = a.sku" ;;
  tolerancia_frouxa)
    trocar "$MIG" "GREATEST(0.01, j.qtde_po * 0.005)" "GREATEST(1.00, j.qtde_po * 0.005)" ;;
  ausente_vira_zero)  # o PO ilegível/ausente vira "conjunto vazio" e o item sem qtde vira 0
    trocar "$MIG" "  IF NOT v_po_ok OR NOT v_app_ok THEN" "  IF false THEN"
    trocar "$MIG" "    SELECT (e->>'nCodProd') AS sku, sum((e->>'nQtde')::numeric) AS q, sum((e->>'nValTot')::numeric) AS v
      FROM jsonb_array_elements(v_prod) e GROUP BY 1" "    SELECT (e->>'nCodProd') AS sku, sum(CASE WHEN jsonb_typeof(e->'nQtde') = 'number' THEN (e->>'nQtde')::numeric ELSE 0 END) AS q, sum(CASE WHEN jsonb_typeof(e->'nValTot') = 'number' THEN (e->>'nValTot')::numeric ELSE 0 END) AS v
      FROM jsonb_array_elements(COALESCE(v_prod, '[]'::jsonb)) e GROUP BY 1" ;;
  sem_trilha)
    trocar "$MIG" "  INSERT INTO public.acoes_execucoes (acao, origem, executado_por, iniciado_em, finalizado_em, status, detalhes)
  VALUES (" "  v_exec := NULL; PERFORM ("
    trocar "$MIG" "  RETURNING id INTO v_exec;" "  ;" ;;
  cancelado_vale)
    trocar "$MIG" "     AND t.status::text IS DISTINCT FROM 'CANCELADO'
" "" ;;
  sem_status)
    trocar "$MIG" "  IF r.status IS NULL OR r.status NOT IN ('aprovado_aguardando_disparo', 'falha_envio') THEN" "  IF r.status IS NULL THEN" ;;
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
CREATE TYPE public.status_pedido_compra AS ENUM ('CRIADO', 'FATURADO', 'EM_TRANSPORTE', 'RECEBIDO', 'CANCELADO', 'DIVERGENCIA');
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN', 'COLACOR');
CREATE TABLE public.purchase_orders_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint, omie_codigo_integracao text, numero_pedido text, status public.status_pedido_compra,
  numero_contrato_fornecedor text, raw_data jsonb, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY, empresa text NOT NULL, status text NOT NULL, portal_protocolo text,
  omie_pedido_compra_id text, omie_pedido_compra_numero text, omie_registrado_em timestamptz,
  disparo_claim_em timestamptz, disparo_claim_por text, atualizado_em timestamptz
);
CREATE TABLE public.pedido_compra_item (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, pedido_id bigint NOT NULL, sku_codigo_omie text,
  qtde_final numeric, preco_unitario numeric
);
CREATE TABLE public.acoes_execucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), acao text NOT NULL,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem = ANY (ARRAY['manual', 'automatica'])),
  executado_por uuid, executado_por_nome text, iniciado_em timestamptz NOT NULL DEFAULT now(), finalizado_em timestamptz,
  status text NOT NULL DEFAULT 'executando' CHECK (status = ANY (ARRAY['executando', 'sucesso', 'erro'])), detalhes jsonb
);

-- Pedidos: protocolo 21420NN para o pedido NN. Cada um varia UMA condição.
INSERT INTO public.pedido_compra_sugerido(id, empresa, status, portal_protocolo, omie_pedido_compra_id, disparo_claim_em)
SELECT v.id, v.emp, v.st, v.prot, v.po, v.claim FROM (VALUES
  (1,  'OBEN', 'aprovado_aguardando_disparo', '2142001', NULL,   NULL::timestamptz),  -- casa: vincula
  (2,  'OBEN', 'falha_envio',                 '2142002', '',     NULL),               -- composto "a / b", casa
  (3,  'OBEN', 'aprovado_aguardando_disparo', '2142003', '0',    NULL),               -- contrato 21420031 (substring)
  (4,  'OBEN', 'aprovado_aguardando_disparo', '2142004', NULL,   now() - interval '3 hours'), -- claim aberto
  (5,  'OBEN', 'disparado',                   '2142005', '9005', NULL),               -- já tem PO
  (6,  'OBEN', 'pendente_aprovacao',          '2142006', NULL,   NULL),               -- status não vinculável
  (7,  'OBEN', 'aprovado_aguardando_disparo', '2142007', NULL,   NULL),               -- 2 POs com o protocolo
  (8,  'OBEN', 'aprovado_aguardando_disparo', '2142008', NULL,   NULL),               -- PO com AFI-999
  (9,  'OBEN', 'aprovado_aguardando_disparo', '2142009', NULL,   NULL),               -- PO já do pedido 50
  (10, 'OBEN', 'aprovado_aguardando_disparo', '2142010', NULL,   NULL),               -- quantidade diverge
  (11, 'OBEN', 'aprovado_aguardando_disparo', '2142011', NULL,   NULL),               -- PO com SKU a mais
  (12, 'OBEN', 'aprovado_aguardando_disparo', '2142012', NULL,   NULL),               -- valor: 1 centavo (tolera)
  (13, 'OBEN', 'aprovado_aguardando_disparo', '2142013', NULL,   NULL),               -- valor: 6 centavos em 2 un.
  (14, 'OBEN', 'aprovado_aguardando_disparo', '2142014', NULL,   NULL),               -- valor: R$0,40 em 100 un. (tolera)
  (15, 'OBEN', 'aprovado_aguardando_disparo', '2142015', NULL,   NULL),               -- PO sem produtos_consulta
  (16, 'OBEN', 'aprovado_aguardando_disparo', '2142016', NULL,   NULL),               -- PO com nQtde texto
  (17, 'OBEN', 'aprovado_aguardando_disparo', '2142017', NULL,   NULL),               -- item do app sem preço
  (18, 'OBEN', 'aprovado_aguardando_disparo', '2142018', NULL,   NULL),               -- só PO CANCELADO
  (19, 'OBEN', 'aprovado_aguardando_disparo', '2142019', NULL,   NULL),               -- PO de outra empresa
  (20, 'OBEN', 'aprovado_aguardando_disparo', '2142020', NULL,   NULL),               -- AFI-20 sem contrato, casa
  (21, 'COLACOR', 'aprovado_aguardando_disparo', '2142021', NULL, NULL),              -- pedido de outra empresa
  (50, 'OBEN', 'disparado',                   '2142050', '7009', NULL)                -- dono do PO 7009
) AS v(id, emp, st, prot, po, claim);

-- Itens do app: SKU 111 (2 un. × 10,00) e 222 (1 un. × 5,50) — salvo onde o caso pede outra coisa.
INSERT INTO public.pedido_compra_item(pedido_id, sku_codigo_omie, qtde_final, preco_unitario)
SELECT p.id, s.sku, s.q, s.pr FROM public.pedido_compra_sugerido p,
  (VALUES ('111', 2::numeric, 10.00::numeric), ('222', 1, 5.50)) AS s(sku, q, pr)
 WHERE p.id NOT IN (14, 17, 50);
INSERT INTO public.pedido_compra_item(pedido_id, sku_codigo_omie, qtde_final, preco_unitario) VALUES
  (14, '111', 100, 10.1234),   -- 1012,34
  (17, '111', 2, NULL);

CREATE FUNCTION pg_temp.prod(VARIADIC x jsonb[]) RETURNS jsonb LANGUAGE sql AS $f$ SELECT jsonb_build_object('produtos_consulta', to_jsonb(x)) $f$;
CREATE TEMP TABLE padrao AS SELECT pg_temp.prod('{"nCodProd":111,"nQtde":2,"nValTot":20.00}', '{"nCodProd":222,"nQtde":1,"nValTot":5.50}') AS rd;

INSERT INTO public.purchase_orders_tracking(empresa, status, omie_codigo_pedido, numero_pedido, omie_codigo_integracao, numero_contrato_fornecedor, raw_data)
SELECT v.emp::public.empresa_reposicao, v.st::public.status_pedido_compra, v.cod, v.num, v.integ, v.contrato, COALESCE(v.rd, (SELECT rd FROM padrao))
  FROM (VALUES
  ('OBEN', 'CRIADO',    7001::bigint, 'M1',  NULL::text, '2142001',            NULL::jsonb),
  ('OBEN', 'RECEBIDO',  7002, 'M2',  'sugc_x',  '2141999 / 2142002',  NULL),
  ('OBEN', 'CRIADO',    7003, 'M3',  NULL,      '21420031',           NULL),
  ('OBEN', 'CRIADO',    7004, 'M4',  NULL,      '2142004',            NULL),
  ('OBEN', 'CRIADO',    7071, 'M71', NULL,      '2142007',            NULL),
  ('OBEN', 'CRIADO',    7072, 'M72', NULL,      '2142007/2142099',    NULL),
  ('OBEN', 'CRIADO',    7008, 'M8',  'AFI-999', '2142008',            NULL),
  ('OBEN', 'CRIADO',    7009, 'M9',  NULL,      '2142009',            NULL),
  ('OBEN', 'CRIADO',    7010, 'M10', NULL,      '2142010',            pg_temp.prod('{"nCodProd":111,"nQtde":4,"nValTot":40.00}', '{"nCodProd":222,"nQtde":1,"nValTot":5.50}')),
  ('OBEN', 'CRIADO',    7011, 'M11', NULL,      '2142011/2142098',    pg_temp.prod('{"nCodProd":111,"nQtde":2,"nValTot":20.00}', '{"nCodProd":222,"nQtde":1,"nValTot":5.50}', '{"nCodProd":333,"nQtde":1,"nValTot":7.00}')),
  ('OBEN', 'CRIADO',    7012, 'M12', NULL,      '2142012',            pg_temp.prod('{"nCodProd":111,"nQtde":2,"nValTot":20.01}', '{"nCodProd":222,"nQtde":1,"nValTot":5.50}')),
  ('OBEN', 'CRIADO',    7013, 'M13', NULL,      '2142013',            pg_temp.prod('{"nCodProd":111,"nQtde":2,"nValTot":20.06}', '{"nCodProd":222,"nQtde":1,"nValTot":5.50}')),
  ('OBEN', 'CRIADO',    7014, 'M14', NULL,      '2142014',            pg_temp.prod('{"nCodProd":111,"nQtde":100,"nValTot":1012.74}')),
  ('OBEN', 'CRIADO',    7015, 'M15', NULL,      '2142015',            '{"cabecalho_consulta":{}}'),
  ('OBEN', 'CRIADO',    7016, 'M16', NULL,      '2142016',            pg_temp.prod('{"nCodProd":111,"nQtde":"2","nValTot":20.00}', '{"nCodProd":222,"nQtde":1,"nValTot":5.50}')),
  ('OBEN', 'CRIADO',    7017, 'M17', NULL,      '2142017',            NULL),
  ('OBEN', 'CANCELADO', 7018, 'M18', NULL,      '2142018',            NULL),
  ('COLACOR', 'CRIADO', 7019, 'M19', NULL,      '2142019',            NULL),
  ('OBEN', 'CRIADO',    7020, 'M20', 'AFI-20',  NULL,                 NULL),
  ('OBEN', 'CRIADO',    7021, 'M21', NULL,      '2142021',            NULL)
  ) AS v(emp, st, cod, num, integ, contrato, rd);
SQL

echo "── A: aplicar ──"
if out="$(P -1 -f "$MIG" 2>&1)"; then
  case "$out" in *"VINCULAR_PO_MANUAL_POS_OK"*) ok "A1 migration aplica com o NOTICE positivo de fim";; *) bad "A1 sem o NOTICE de fim";; esac
else bad "A1 migration NÃO aplicou: $(printf '%s' "$out" | grep -m1 -E 'ERROR|FALHOU' || true)"; fi
if P -1 -q -f "$MIG" >/dev/null 2>&1; then ok "A2 re-aplicar é idempotente"; else bad "A2 re-aplicar falhou"; fi
FN="public.sayerlack_vincular_po_manual(bigint,uuid,text)"
eq "A3 porta fechada p/ anon+authenticated, aberta p/ service_role" "$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE')::text || has_function_privilege('authenticated','$FN','EXECUTE')::text || has_function_privilege('service_role','$FN','EXECUTE')::text")" "falsefalsetrue"

ATOR="00000000-0000-0000-0000-0000000000aa"
# $1 pedido, $2 ator (ou NULL), $3 origem → jsonb devolvido (ou o erro)
V() { Pq -c "SELECT public.sayerlack_vincular_po_manual($1, ${2:-NULL}, '${3:-importar}')" 2>&1 || true; }
campo() { python3 -I -c "import json,sys; v=json.load(sys.stdin).get('$1'); print('null' if v is None else (json.dumps(v) if isinstance(v,(list,dict)) else str(v).lower()))" 2>&1; }
ST() { Pq -c "SELECT status || '|' || COALESCE(omie_pedido_compra_id,'-') || '|' || COALESCE(omie_pedido_compra_numero,'-') || '|' || COALESCE(disparo_claim_em::text,'-') FROM public.pedido_compra_sugerido WHERE id = $1" 2>&1 || true; }
NTRILHA() { Pq -c "SELECT count(*) FROM public.acoes_execucoes WHERE acao='sayerlack_vincular_po_manual' AND (detalhes->>'pedido_id')::bigint = $1"; }

echo "── V: porta ──"
r="$(V 1 "'$ATOR'::uuid")"
eq "V1 PO manual com o protocolo e o mesmo conteúdo: vincula" "$(printf '%s' "$r" | campo vinculado)|$(printf '%s' "$r" | campo po_numero)" "true|m1"
eq "V1b pedido vira disparado com o PO do Omie" "$(ST 1)" "disparado|7001|M1|-"
eq "V1c trilha com ator, origem, antes e depois" "$(Pq -c "SELECT origem || '|' || executado_por::text || '|' || status || '|' || (detalhes->'antes'->>'status') || '|' || (detalhes->'depois'->>'omie_pedido_compra_id') || '|' || (detalhes->>'origem') FROM public.acoes_execucoes WHERE (detalhes->>'pedido_id')::bigint = 1")" "manual|$ATOR|sucesso|aprovado_aguardando_disparo|7001|importar"
eq "V1d de novo: já tem PO, nenhuma trilha nova" "$(V 1 | campo motivo)|$(NTRILHA 1)" "tem_po|1"
r="$(V 2 NULL varredura)"
eq "V2 contrato composto 'a / b' (falha_envio, PO vazio): vincula e marca composto" "$(printf '%s' "$r" | campo vinculado)|$(printf '%s' "$r" | campo contrato_composto)|$(ST 2)" "true|true|disparado|7002|M2|-"
eq "V2b varredura sem ator: trilha automática" "$(Pq -c "SELECT origem || '|' || COALESCE(executado_por::text,'-') FROM public.acoes_execucoes WHERE (detalhes->>'pedido_id')::bigint = 2")" "automatica|-"
eq "V3 protocolo como SUBSTRING do contrato não vale ('0' conta como sem PO)" "$(V 3 | campo motivo)|$(ST 3)" "sem_po_manual|aprovado_aguardando_disparo|0|-|-"
r="$(V 4)"
eq "V4 claim de disparo aberto (3 h) recusa e não muda nada" "$(printf '%s' "$r" | campo motivo)|$(NTRILHA 4)|$(Pq -c "SELECT status || '|' || COALESCE(omie_pedido_compra_id,'-') || '|' || (disparo_claim_em IS NOT NULL)::text FROM public.pedido_compra_sugerido WHERE id=4")" "disparo_pendente|0|aprovado_aguardando_disparo|-|true"
eq "V5 com PO no app recusa" "$(V 5 | campo motivo)" "tem_po"
eq "V6 status pendente_aprovacao recusa" "$(V 6 | campo motivo)|$(ST 6)" "status_nao_vinculavel|pendente_aprovacao|-|-|-"
eq "V7 dois POs vivos com o protocolo: ambíguo" "$(V 7 | campo motivo)|$(ST 7)" "po_ambiguo|aprovado_aguardando_disparo|-|-|-"
eq "V8 PO com AFI-<outro pedido> recusa" "$(V 8 | campo motivo)|$(ST 8)" "po_de_outro_pedido|aprovado_aguardando_disparo|-|-|-"
eq "V9 PO já vinculado a outro pedido recusa" "$(V 9 | campo motivo)|$(ST 9)" "po_de_outro_pedido|aprovado_aguardando_disparo|-|-|-"
r="$(V 10)"
eq "V10 quantidade diverge: recusa com o diff" "$(printf '%s' "$r" | campo motivo)|$(printf '%s' "$r" | python3 -I -c "import json,sys; d=json.load(sys.stdin)['diferencas']; print(';'.join(f\"{x['sku']}:{x['qtde_app']}>{x['qtde_po']}\" for x in d))")|$(ST 10)" "conteudo_divergente|111:2>4|aprovado_aguardando_disparo|-|-|-"
r="$(V 11)"
eq "V11 PO com SKU a mais (composto com o item do outro protocolo) recusa" "$(printf '%s' "$r" | campo motivo)|$(printf '%s' "$r" | python3 -I -c "import json,sys; d=json.load(sys.stdin)['diferencas']; print(';'.join(f\"{x['sku']}:{x['qtde_app']}>{x['qtde_po']}\" for x in d))")|$(ST 11)" "conteudo_divergente|333:None>1|aprovado_aguardando_disparo|-|-|-"
eq "V12 valor a 1 centavo: tolera e vincula" "$(V 12 | campo vinculado)" "true"
eq "V13 valor a 6 centavos em 2 un.: recusa" "$(V 13 | campo motivo)|$(ST 13)" "conteudo_divergente|aprovado_aguardando_disparo|-|-|-"
eq "V14 valor a R\$0,40 em 100 un. (meio centavo por unidade): vincula" "$(V 14 | campo vinculado)" "true"
eq "V15 PO sem produtos_consulta: ausente, não 'casou'" "$(V 15 | campo motivo)|$(ST 15)" "conteudo_ausente|aprovado_aguardando_disparo|-|-|-"
eq "V16 PO com nQtde texto e item do app sem preço: ausente, sem 22P02" "$(V 16 | campo motivo)|$(V 17 | campo motivo)" "conteudo_ausente|conteudo_ausente"
eq "V18 só PO CANCELADO no espelho: sem PO manual" "$(V 18 | campo motivo)" "sem_po_manual"
eq "V19 PO de outra empresa e pedido de outra empresa" "$(V 19 | campo motivo)|$(V 21 | campo motivo)" "sem_po_manual|sem_protocolo_do_portal"
eq "V20 PO com o próprio AFI-<id> (resposta perdida), sem contrato: vincula" "$(V 20 | campo vinculado)|$(ST 20)" "true|disparado|7020|M20|-"
eq "V21 inexistente recusa" "$(V 999 | campo motivo)" "pedido_nao_encontrado"
eq "V22 origem desconhecida = 22023" "$(Pq -c "SELECT public.sayerlack_vincular_po_manual(1, NULL, 'tela')" 2>&1 | sqlstate)" "22023"
eq "V23 authenticated não executa = 42501" "$(Pq -c "SET ROLE authenticated; SELECT public.sayerlack_vincular_po_manual(1, NULL, 'importar')" 2>&1 | sqlstate)" "42501"
eq "V24 uma trilha por vínculo (1, 2, 12, 14, 20)" "$(Pq -c "SELECT string_agg(detalhes->>'pedido_id', ',' ORDER BY (detalhes->>'pedido_id')::int) FROM public.acoes_execucoes")" "1,2,12,14,20"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then echo "RESULTADO: VERMELHO (LC=$LOC)"; exit 1; fi
echo "RESULTADO: VERDE (LC=$LOC)"
