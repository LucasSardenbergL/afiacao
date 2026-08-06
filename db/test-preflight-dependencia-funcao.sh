#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — db/preflight-dependencia-funcao.sql tem DENTE                    ║
# ║   bash db/test-preflight-dependencia-funcao.sh > /tmp/t.log 2>&1; echo $?      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
# Uma varredura de inventário falha de DOIS jeitos, e os dois são caros:
#   (a) FALSO-NEGATIVO — não acusa um dependente real ⇒ o DROP/move passa e quebra prod
#       silenciosamente (foi o FU7: 4 callers PL/pgSQL invisíveis, #1421→#1423).
#   (b) FALSO-POSITIVO — acusa um vizinho de nome parecido ⇒ inventário inflado sugere
#       acoplamento inexistente (foi o P0-B-bis: `ilike` inflou 3 "bloqueadores" p/ 6).
# Este harness prova os dois sentidos, reconstruindo o estado REAL do incidente.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5474}"
DATA="$(mktemp -d "/tmp/pgtest-preflight-func.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-preflight-func.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
tem()   { if echo "$2" | grep -q "$3"; then ok "$1"; else bad "$1 — '$3' AUSENTE da saída"; fi; }
naotem(){ if echo "$2" | grep -q "$3"; then bad "$1 — '$3' PRESENTE (não devia)"; else ok "$1"; fi; }

# ══════════════════════════════════════════════════════════════════════════════
# CENÁRIO — reconstrói o estado pós-#1421 / pré-#1423 (o momento da quebra)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA private;
-- Stub de `cron.job`: a prod tem pg_cron e o preflight varre `cron.job.command` (SQL inline
-- é uma classe que não é pg_proc nem pg_views). Num PG17 limpo a relação não existe e, como
-- a varredura é um UNION ALL, o bloco ausente aborta a QUERY INTEIRA — foi o que aconteceu
-- na 1ª rodada deste harness, e o sintoma foi "todos os asserts vermelhos", não "um a menos".
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE TABLE public.alvo_tbl (id int primary key, customer_user_id uuid, dono uuid);
CREATE TABLE public.outra_tbl (id int primary key, k text, c_uuid uuid, d_uuid uuid);

-- o helper, JÁ movido p/ private (o que o #1421 fez).
-- ⚠️ IMMUTABLE aqui, STABLE na prod: só para o cenário poder criar um índice-expressão
-- (o PG exige IMMUTABLE em índice) e exercitar aquele bloco da varredura. A varredura é
-- TEXTUAL — volatilidade não a afeta, então a troca não enfraquece nenhum assert.
CREATE FUNCTION private.carteira_visivel_para(_c uuid, _u uuid) RETURNS boolean
  LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO 'public' AS $f$ SELECT true $f$;

-- ⚠️ VIZINHO HOMÔNIMO por PREFIXO: existe de verdade, não pode entrar no inventário do alvo.
CREATE FUNCTION public.carteira_visivel_para_completa(_u uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION public.usa_so_o_vizinho() RETURNS boolean
  LANGUAGE plpgsql AS $f$ BEGIN RETURN public.carteira_visivel_para_completa(gen_random_uuid()); END $f$;

-- CALLER 1: qualificado com o schema ANTIGO ⇒ QUEBRADO (o caso dos 4 do FU7)
CREATE FUNCTION public.caller_quebrado() RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $f$ BEGIN RETURN public.carteira_visivel_para(gen_random_uuid(), gen_random_uuid()); END $f$;

-- CALLER 2: NÃO-qualificado + search_path sem `private` ⇒ TAMBÉM quebrado, e sem `public.`
--           no texto: só o bloco de não-qualificado o encontra.
CREATE FUNCTION public.caller_nao_qualificado() RETURNS boolean
  LANGUAGE plpgsql SET search_path TO 'public'
  AS $f$ BEGIN RETURN carteira_visivel_para(gen_random_uuid(), gen_random_uuid()); END $f$;

-- CALLER 3: não-qualificado MAS com `private` no search_path ⇒ funciona (não é bloqueador,
--           mas TEM de aparecer no inventário — é dependente).
CREATE FUNCTION public.caller_searchpath_ok() RETURNS boolean
  LANGUAGE plpgsql SET search_path TO 'public, private'
  AS $f$ BEGIN RETURN carteira_visivel_para(gen_random_uuid(), gen_random_uuid()); END $f$;

-- TRIGGER que executa a função-alvo (classe própria: tgfoid)
CREATE FUNCTION public.trg_usa_alvo() RETURNS trigger
  LANGUAGE plpgsql AS $f$ BEGIN PERFORM private.carteira_visivel_para(NEW.customer_user_id, NEW.dono); RETURN NEW; END $f$;
CREATE TRIGGER trg_no_alvo BEFORE INSERT ON public.alvo_tbl FOR EACH ROW EXECUTE FUNCTION public.trg_usa_alvo();

-- POLICY de INSERT: polqual é NULL, a chamada vive SÓ no WITH CHECK (o falso rótulo corrigido)
ALTER TABLE public.alvo_tbl ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_insert_wc ON public.alvo_tbl FOR INSERT
  WITH CHECK (private.carteira_visivel_para(customer_user_id, dono));
CREATE POLICY pol_select_using ON public.alvo_tbl FOR SELECT
  USING (private.carteira_visivel_para(customer_user_id, dono));

-- VIEW que chama
CREATE VIEW public.v_usa_alvo AS
  SELECT t.id FROM public.alvo_tbl t WHERE private.carteira_visivel_para(t.customer_user_id, t.dono);

-- DEFAULT de coluna + CHECK constraint + índice-expressão
ALTER TABLE public.outra_tbl ADD COLUMN vis boolean DEFAULT private.carteira_visivel_para(gen_random_uuid(), gen_random_uuid());
CREATE INDEX idx_expr ON public.outra_tbl ((private.carteira_visivel_para(c_uuid, d_uuid)));

-- ⚠️ um AGREGADO no banco: pg_get_functiondef explode nele e aborta a varredura inteira
--    se o filtro pg_aggregate não estiver lá. É o bug que mordeu 2× na sessão do FU7.
CREATE AGGREGATE public.meu_agg (int) (SFUNC = int4pl, STYPE = int, INITCOND = '0');
SQL
echo "cenário montado (estado pós-#1421 / pré-#1423)"

# `|| true`: a varredura pode sair !=0 e o `set -e` mataria o harness antes dos asserts —
# o assert D3 é quem julga se houve ERROR, não o exit code do psql.
OUT="$(P -tA -v alvo=carteira_visivel_para -f "$REPO_ROOT/db/preflight-dependencia-funcao.sql" 2>&1 || true)"
echo "$OUT" | head -20

echo ""
echo "── A. NÃO tem falso-negativo: acha toda classe de dependente ──"
tem "A1 caller QUALIFICADO com schema antigo (os 4 do FU7)" "$OUT" "caller_quebrado"
tem "A2 caller NÃO-qualificado (invisível a um grep por 'public.')" "$OUT" "caller_nao_qualificado"
tem "A3 caller que funciona por search_path estendido (dependente, não bloqueador)" "$OUT" "caller_searchpath_ok"
naotem "A4 trigger NÃO entra quando o alvo não é a trigger function (é trg_usa_alvo que chama)" "$OUT" "trg_no_alvo"
tem   "A4b quem o trigger executa aparece como rotina chamadora" "$OUT" "trg_usa_alvo"
tem "A5 policy de SELECT (USING)" "$OUT" "pol_select_using"
tem "A6 policy de INSERT (só WITH CHECK)" "$OUT" "pol_insert_wc"
tem "A7 view" "$OUT" "v_usa_alvo"
tem "A8 índice-expressão" "$OUT" "idx_expr"
tem "A9 default de coluna" "$OUT" "vis"

echo ""
echo "── B. o diagnóstico é CORRETO, não só presente ──"
tem "B1 caller_quebrado rotulado QUALIFICADO com o schema errado" "$OUT" "caller_quebrado|chama QUALIFICADO: public"
tem "B2 caller_nao_qualificado rotulado NÃO-QUALIFICADO"          "$OUT" "caller_nao_qualificado|chama NÃO-QUALIFICADO"
# ⚠️ o PG grava o proconfig QUOTED quando o valor tem vírgula: search_path="public, private".
# Um assert que espera sem aspas falha com o preflight CERTO — mordido aqui.
tem "B3 search_path do caller aparece (é o que decide se resolve)" "$OUT" 'search_path="public, private"' 
tem "B4 policy INSERT NÃO é rotulada 'não-qualificado' (bug corrigido)" "$OUT" "pol_insert_wc.*QUALIFICADO: private"
tem "B5 policy INSERT marcada como só-WITH-CHECK"                 "$OUT" "só WITH CHECK"

echo ""
echo "── C. NÃO tem falso-positivo: o vizinho homônimo fica FORA ──"
naotem "C1 carteira_visivel_para_completa não entra (word-boundary)" "$OUT" "carteira_visivel_para_completa"
naotem "C2 quem usa só o vizinho não entra"                         "$OUT" "usa_so_o_vizinho"

echo ""
echo "── D. a varredura sobrevive ao que já a quebrou antes ──"
tem "D1 rodou até o fim (agregado no banco não abortou)" "$OUT" "caller_quebrado"
if echo "$OUT" | grep -qi "is an aggregate function"; then bad "D2 explodiu no agregado"; else ok "D2 nenhum erro de agregado"; fi
if echo "$OUT" | grep -qi "^ERROR"; then bad "D3 saída tem ERROR"; else ok "D3 saída limpa"; fi

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO — sabota cada defesa e exige que o assert correspondente vire vermelho
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── FALSIFICAÇÃO ──"

# F1: troca o word-boundary por ILIKE (o bug do P0-B-bis) ⇒ C1 tem de quebrar
SAB="$(mktemp /tmp/sab-XXXX.sql)"
# ⚠️ ILIKE, não `~*`: em regex o `%` é literal, então `~* '%nome%'` não casa NADA e a
# sabotagem sairia inócua — "F1 verde" provando o nada. Mordido ao escrever este harness.
sed "s/~ :'alvo_re'/ilike ('%'||:'alvo'||'%')/g; s/~ :'alvo_qual'/ilike ('%'||:'alvo'||'%')/g; s/~ :'alvo_nu'/ilike ('%'||:'alvo'||'%')/g" \
  "$REPO_ROOT/db/preflight-dependencia-funcao.sql" > "$SAB"
OUT_SAB="$(P -tA -v alvo=carteira_visivel_para -f "$SAB" 2>&1 || true)"
if echo "$OUT_SAB" | grep -q "carteira_visivel_para_completa\|usa_so_o_vizinho"; then
  ok "F1 sem word-boundary o vizinho INVADE o inventário → C1/C2 têm dente"
else
  bad "F1 sabotagem não mudou nada — C1/C2 não provam o word-boundary"
fi
rm -f "$SAB"

# F2: remove o filtro de agregado ⇒ D2 tem de quebrar
SAB2="$(mktemp /tmp/sab2-XXXX.sql)"
# ⚠️ a defesa PRIMÁRIA é `prokind in ('f','p')` — agregado é prokind='a'. Sabotar só o
# filtro pg_aggregate (redundante, defesa em profundidade) deixa o teste verde por engano.
sed "s/and p.oid not in (select aggfnoid from pg_aggregate)//g; s/and p.prokind in ('f','p')//g" \
  "$REPO_ROOT/db/preflight-dependencia-funcao.sql" > "$SAB2"
OUT_SAB2="$(P -tA -v alvo=carteira_visivel_para -f "$SAB2" 2>&1 || true)"
if echo "$OUT_SAB2" | grep -qi "aggregate function"; then
  ok "F2 sem prokind+pg_aggregate a varredura EXPLODE no agregado → D2 tem dente"
else
  bad "F2 sabotagem não explodiu — D2 não prova a exclusão de agregado"
fi
rm -f "$SAB2"

# F3: o teste-do-teste — some com o caller e o assert que o procura tem de cair
P -q -c "DROP FUNCTION public.caller_quebrado();"
OUT_F3="$(P -tA -v alvo=carteira_visivel_para -f "$REPO_ROOT/db/preflight-dependencia-funcao.sql" 2>&1)"
if echo "$OUT_F3" | grep -q "caller_quebrado"; then
  bad "F3 caller dropado ainda aparece — a varredura lê estado velho"
else
  ok "F3 caller dropado some do inventário → A1 reflete o banco, não um cache"
fi

echo ""
echo "═══ RESULTADO: $PASS ok, $FAIL falhas ═══"
[ "$FAIL" -eq 0 ] || exit 1
