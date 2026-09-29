#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — v_reposicao_sku_fora_do_motor                                    ║
# ║  supabase/migrations/20260929003006_reposicao_v_sku_fora_do_motor.sql          ║
# ║      bash db/test-v-sku-fora-do-motor.sh > /tmp/t.log 2>&1; rc=$?              ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
# O sensor é o espelho do WHERE do motor (gerar_pedidos_sugeridos_ciclo, CTE sku_base) com o flag
# INVERTIDO. O que ele precisa provar:
#   · cada filtro do motor derruba a linha certa — um filtro a menos e o sensor denuncia como
#     "esquecido" um SKU que o motor barraria de qualquer jeito (405ML, inativo no Omie, galão…);
#   · o flag invertido: SKU ligado NÃO aparece; ligado = NULL aparece (o motor exige TRUE);
#   · os COALESCE(…, true) do motor: SKU sem linha no Omie APARECE (espelho, não "precisão");
#   · security_invoker=on: staff vê, authenticated sem staff não vê, anon nem lê;
#   · a postcondição da migration tem dente (A1/A2/A3 abortam o apply sabotado).
# Falsificação: UMA camada por vez, com CONTROLE verde na MESMA invocação do laço (sem sabotagem,
# o mesmo veredito tem de passar — senão um veredito sempre-vermelho aprovaria toda sabotagem).
set -euo pipefail

# ── arranque PG17 descartável (idêntico aos outros harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="v-sku-fora-do-motor"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
# Default privileges do Supabase: tabela/view nova nasce com GRANT para anon/authenticated. Sem isto o
# REVOKE do anon na migration seria no-op aqui e a asserção de anon não teria dente.
P -q -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: as 6 tabelas que a view lê, com os tipos de PROD (medidos 2026-09-29)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.sku_parametros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text,
  tipo_reposicao text DEFAULT 'automatica',
  habilitado_reposicao_automatica boolean DEFAULT false,
  ponto_pedido numeric, estoque_maximo numeric, demanda_dias_com_movimento integer
);
CREATE TABLE public.omie_products (
  omie_codigo_produto bigint, account text, descricao text, ativo boolean,
  familia text, tipo_produto text, metadata jsonb
);
CREATE TABLE public.sku_status_omie (empresa text, sku_codigo_omie text, ativo_no_omie boolean);
CREATE TABLE public.familia_nao_comprada (id bigserial PRIMARY KEY, empresa text, familia text);
CREATE TABLE public.sku_embalagem_equivalencia (
  empresa text, grupo_id uuid, sku_codigo_omie text, fator_para_base numeric, ativo boolean
);
CREATE TABLE public.eventos_outlier (
  id bigserial PRIMARY KEY, empresa text, sku_codigo_omie text, tipo text, status text
);
-- RLS de staff em sku_parametros (a de prod usa has_role(); aqui a GUC test.staff faz o papel).
ALTER TABLE public.sku_parametros ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_select ON public.sku_parametros FOR SELECT
  USING (current_setting('test.staff', true) = '1');
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (o .sql commitado, com BEGIN/COMMIT e a postcondição)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260929003006_reposicao_v_sku_fora_do_motor.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: um SKU por filtro (OBEN salvo indicação). Base = passa em TUDO.
# ══════════════════════════════════════════════════════════════════════════════
# stdout descartado (os SELECT do helper imprimem linhas vazias); erro continua no stderr.
P -q >/dev/null <<'SQL'
-- helper de seed: SKU "bom" em sku_parametros + produto ativo no Omie; cada caso estraga UMA coisa.
CREATE FUNCTION pg_temp.sku(p_sku bigint, p_empresa text DEFAULT 'OBEN') RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.sku_parametros
    (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, tipo_reposicao,
     habilitado_reposicao_automatica, ponto_pedido, estoque_maximo, demanda_dias_com_movimento)
  VALUES (p_empresa, p_sku, 'ITEM ' || p_sku, 'RENNER SAYERLACK S/A', 'automatica', false, 3, 7, 5);
  INSERT INTO public.omie_products (omie_codigo_produto, account, descricao, ativo, familia, tipo_produto)
  VALUES (p_sku, lower(p_empresa), 'ITEM ' || p_sku, true, 'Catalisadores PU', '00');
$f$;

SELECT pg_temp.sku(s) FROM generate_series(1001, 1022) s;
SELECT pg_temp.sku(2001, 'COLACOR');
SELECT pg_temp.sku(8689781893);   -- o 405ML real que a postcondição A3 vigia

-- 1001 BOM (controle positivo)                                          → DENTRO
UPDATE public.sku_parametros SET habilitado_reposicao_automatica = true  WHERE sku_codigo_omie = 1002; -- ligado → FORA
UPDATE public.sku_parametros SET habilitado_reposicao_automatica = NULL  WHERE sku_codigo_omie = 1003; -- NULL → DENTRO
UPDATE public.sku_parametros SET tipo_reposicao = 'descontinuado'        WHERE sku_codigo_omie = 1004; -- FORA
UPDATE public.sku_parametros SET tipo_reposicao = NULL                   WHERE sku_codigo_omie = 1005; -- NULL=automatica → DENTRO
UPDATE public.sku_parametros SET fornecedor_nome = NULL                  WHERE sku_codigo_omie = 1006; -- FORA
UPDATE public.sku_parametros SET fornecedor_nome = '   '                 WHERE sku_codigo_omie = 1007; -- FORA
UPDATE public.omie_products  SET familia = 'Familia Vetada'              WHERE omie_codigo_produto = 1008;
INSERT INTO public.familia_nao_comprada (empresa, familia) VALUES ('OBEN', 'Familia Vetada');        -- 1008 FORA
UPDATE public.omie_products  SET ativo = false                           WHERE omie_codigo_produto = 1009; -- FORA
DELETE FROM public.omie_products                                         WHERE omie_codigo_produto = 1010; -- sem produto → DENTRO (espelho do COALESCE)
INSERT INTO public.sku_status_omie VALUES ('OBEN', '1011', false);                                     -- 1011 FORA
UPDATE public.omie_products  SET descricao = 'BASE WJOI.7585 405ML'      WHERE omie_codigo_produto IN (1012, 8689781893); -- FORA
UPDATE public.omie_products  SET descricao = 'VERNIZ XYZ 450ML'          WHERE omie_codigo_produto = 1013; -- FORA
UPDATE public.omie_products  SET tipo_produto = '04'                     WHERE omie_codigo_produto = 1014; -- FORA
UPDATE public.omie_products  SET tipo_produto = NULL, metadata = '{"tipo_produto":"04"}' WHERE omie_codigo_produto = 1015; -- FORA
INSERT INTO public.sku_embalagem_equivalencia VALUES ('oben', gen_random_uuid(), '1016', 4, true);     -- galão ativo → FORA
INSERT INTO public.sku_embalagem_equivalencia VALUES ('oben', gen_random_uuid(), '1017', 4, false);    -- galão INATIVO → DENTRO
UPDATE public.sku_parametros SET ponto_pedido = NULL                     WHERE sku_codigo_omie = 1018; -- FORA
UPDATE public.sku_parametros SET estoque_maximo = NULL                   WHERE sku_codigo_omie = 1019; -- FORA
UPDATE public.sku_parametros SET demanda_dias_com_movimento = 0          WHERE sku_codigo_omie = 1020; -- FORA
UPDATE public.sku_parametros SET demanda_dias_com_movimento = NULL       WHERE sku_codigo_omie = 1021; -- FORA
-- 1022: o produto só existe INATIVO noutra conta — o recorte por account não pode deixá-lo vazar p/ OBEN.
UPDATE public.omie_products  SET account = 'colacor', ativo = false      WHERE omie_codigo_produto = 1022; -- → DENTRO
-- eventos: 1001 com reativação PENDENTE; 1003 com uma já decidida (não conta)
INSERT INTO public.eventos_outlier (empresa, sku_codigo_omie, tipo, status) VALUES
  ('OBEN', '1001', 'sku_reativado_omie', 'pendente'),
  ('OBEN', '1003', 'sku_reativado_omie', 'aceito'),
  ('OBEN', '1005', 'sku_inativado_omie', 'pendente');   -- outro tipo: não conta
SQL

ESPERADO_CONJUNTO="COLACOR:2001,OBEN:1001,OBEN:1003,OBEN:1005,OBEN:1010,OBEN:1017,OBEN:1022"
ESPERADO_FLAGS="1001=t,1003=f,1005=f"

# ── vereditos (usados no assert E na falsificação — o mesmo código julga os dois) ──
conjunto() {
  Pq -c "SELECT coalesce(string_agg(empresa || ':' || sku_codigo_omie, ',' ORDER BY empresa, sku_codigo_omie), '')
         FROM public.v_reposicao_sku_fora_do_motor;"
}
flags() {
  Pq -c "SELECT coalesce(string_agg(sku_codigo_omie || '=' || CASE WHEN reativado_omie_pendente THEN 't' ELSE 'f' END,
                                    ',' ORDER BY sku_codigo_omie), '')
         FROM public.v_reposicao_sku_fora_do_motor WHERE sku_codigo_omie IN (1001, 1003, 1005);"
}
# linhas vistas por um authenticated SEM staff (security_invoker=on ⇒ o RLS de sku_parametros vale ⇒ 0)
nao_staff() {
  Pq -c "SET ROLE authenticated; SELECT count(*) FROM public.v_reposicao_sku_fora_do_motor;"
}
# anon lendo a view: ANON_NEGADO se o GRANT barrar (42501); qualquer outro erro RE-LANÇA.
anon_le() {
  P -tA 2>&1 <<'SQL' || true
SET ROLE anon;
DO $a$
BEGIN
  PERFORM 1 FROM public.v_reposicao_sku_fora_do_motor;
  RAISE NOTICE 'VEREDITO_ANON_LEU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'VEREDITO_ANON_NEGADO';
  WHEN OTHERS THEN RAISE;
END
$a$;
SQL
}
anon_veredito() {
  local out
  out="$(anon_le)"
  case "$out" in
    *"NOTICE:  VEREDITO_ANON_NEGADO"*) echo "negado" ;;
    *"NOTICE:  VEREDITO_ANON_LEU"*)    echo "leu" ;;
    *)                                  echo "erro:${out:0:160}" ;;
  esac
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
eq "A1 conjunto (cada filtro do motor derruba a sua linha; flag NULL, tipo NULL, sem produto, galão inativo e conta alheia ficam)" \
   "$(conjunto)" "$ESPERADO_CONJUNTO"
eq "A2 reativado_omie_pendente (só evento sku_reativado_omie PENDENTE conta)" "$(flags)" "$ESPERADO_FLAGS"
eq "A3 security_invoker=on" \
   "$(Pq -c "SELECT 'security_invoker=on' = ANY (coalesce(reloptions, '{}')) FROM pg_class WHERE relname = 'v_reposicao_sku_fora_do_motor';")" "t"
eq "A4 staff (authenticated + RLS de staff) vê o conjunto inteiro" \
   "$(Pq -c "SET test.staff = '1'; SET ROLE authenticated; SELECT count(*) FROM public.v_reposicao_sku_fora_do_motor;" | tail -1)" "7"
eq "A5 authenticated SEM staff não vê nada (RLS atravessa a view)" "$(nao_staff | tail -1)" "0"
eq "A6 anon não lê (42501, capturado pela SQLSTATE)" "$(anon_veredito)" "negado"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO: uma camada por vez, CONTROLE verde na mesma invocação
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (sabota 1 camada → o veredito da camada tem de ficar VERMELHO) ──"
# A definição da view, extraída do arquivo REAL (do CREATE até o 1º ';'). Sabotar é reescrever essa
# string e recriar a view — a migration no disco nunca é tocada.
VIEW_SQL="$(awk '/^CREATE OR REPLACE VIEW/{f=1} f{print} f && /;/{exit}' "$MIG")"
case "$VIEW_SQL" in
  *"demanda_dias_com_movimento, 0) > 0;"*) ;;
  *) bad "extração da view não chegou ao fim do WHERE — falsificação abortada"; VIEW_SQL="" ;;
esac

aplicar_view() { printf '%s\n' "$1" | P -q >/dev/null 2>&1; }
veredito() {   # $1 = conjunto | flags | rls → 0 se o veredito bate com o esperado
  case "$1" in
    conjunto) [ "$(conjunto)" = "$ESPERADO_CONJUNTO" ] ;;
    flags)    [ "$(flags)" = "$ESPERADO_FLAGS" ] ;;
    rls)      [ "$(nao_staff | tail -1)" = "0" ] ;;
  esac
}

# nome | expressão sed sobre a view | veredito que a camada protege
CAMADAS=(
  "controle||conjunto"
  "flag invertido|s/WHERE sp.habilitado_reposicao_automatica IS NOT TRUE/WHERE true/|conjunto"
  "tipo_reposicao|/COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'/d|conjunto"
  "fornecedor (NULL e branco; o IS NOT NULL sozinho é redundante com o btrim)|/sp.fornecedor_nome IS NOT NULL/d;/btrim(sp.fornecedor_nome)/d|conjunto"
  "fornecedor em branco|/btrim(sp.fornecedor_nome)/d|conjunto"
  "familia_nao_comprada|/fnc.id IS NULL/d|conjunto"
  "ativo no Omie|/COALESCE(op.ativo, true) = true/d|conjunto"
  "ativo_no_omie|/COALESCE(sso.ativo_no_omie, true) = true/d|conjunto"
  "fracionado 450ML|/NOT ILIKE '%450ML'/d|conjunto"
  "fracionado 405ML|/NOT ILIKE '%405ML'/d|conjunto"
  "tipo_produto 04|/<> '04'/d|conjunto"
  "galão fator>1|s/eq.fator_para_base > 1/eq.fator_para_base > 99/|conjunto"
  "galão só se equivalência ATIVA|/AND eq.ativo = true/d|conjunto"
  "ponto de pedido|/sp.ponto_pedido IS NOT NULL/d|conjunto"
  "estoque máximo|/sp.estoque_maximo IS NOT NULL/d|conjunto"
  "vendeu em 90d|s/demanda_dias_com_movimento, 0) > 0;/demanda_dias_com_movimento, 0) >= 0;/|conjunto"
  "recorte por conta Omie|/AND op.account = lower(sp.empresa)/d|conjunto"
  "evento só PENDENTE|/AND e.status = 'pendente'/d|flags"
  "security_invoker|s/security_invoker = on/security_invoker = off/|rls"
)

if [ -n "$VIEW_SQL" ]; then
  for camada in "${CAMADAS[@]}"; do
    IFS='|' read -r nome expr alvo <<< "$camada"
    if [ "$nome" = "controle" ]; then
      if aplicar_view "$VIEW_SQL" && veredito "$alvo"; then ok "F0 controle: view verdadeira, veredito verde"
      else bad "F0 controle VERMELHO sem sabotagem — o veredito não distingue nada, falsificação inválida"; fi
      continue
    fi
    sabotada="$(printf '%s\n' "$VIEW_SQL" | sed -e "$expr")"
    if [ "$sabotada" = "$VIEW_SQL" ]; then bad "F [$nome]: o sed não casou — sabotagem inexistente"; continue; fi
    if ! aplicar_view "$sabotada"; then bad "F [$nome]: a view sabotada nem compila — falsificação inválida"; continue; fi
    if veredito "$alvo"; then bad "F [$nome]: sabotada e o veredito [$alvo] seguiu VERDE — camada sem dente"
    else ok "F [$nome]: sabotada → [$alvo] vermelho"; fi
  done
  aplicar_view "$VIEW_SQL" || bad "restauração da view verdadeira falhou"
  if veredito conjunto && veredito flags && veredito rls; then ok "F restaurada: view verdadeira de volta, tudo verde"
  else bad "F restaurada: a view verdadeira não voltou ao verde"; fi
fi

# anon: o dente é o REVOKE (fora da string da view). Sabota regrantando; exige 'leu'; restaura.
P -q -c "GRANT SELECT ON public.v_reposicao_sku_fora_do_motor TO anon;"
eq "F [REVOKE anon]: com o GRANT de volta, anon LÊ (o assert A6 tem dente)" "$(anon_veredito)" "leu"
P -q -c "REVOKE ALL ON public.v_reposicao_sku_fora_do_motor FROM anon;"
eq "F [REVOKE anon] restaurado" "$(anon_veredito)" "negado"

# A postcondição da migration tem dente? Aplica a migration INTEIRA sabotada: tem de abortar com o
# rótulo da asserção certa. Sentinela = o rótulo 'Ax FALHOU' que só a postcondição emite.
postcondicao_aborta() {   # $1 = expressão sed sobre o arquivo da migration · $2 = rótulo esperado
  local out
  out="$(sed -e "$1" "$MIG" | P -q 2>&1 >/dev/null || true)"
  case "$out" in *"ERROR:  $2 FALHOU"*) return 0 ;; *) return 1 ;; esac
}
if postcondicao_aborta 's/security_invoker = on/security_invoker = off/' "A1"; then ok "P1 postcondição A1 aborta a view sem security_invoker"
else bad "P1 postcondição A1 NÃO abortou a view sem security_invoker"; fi
P -q -c "GRANT SELECT ON public.v_reposicao_sku_fora_do_motor TO anon;"
if postcondicao_aborta 's/FROM PUBLIC, anon, authenticated;/FROM PUBLIC, authenticated;/' "A2"; then ok "P2 postcondição A2 aborta anon com SELECT"
else bad "P2 postcondição A2 NÃO abortou anon com SELECT"; fi
P -q -c "REVOKE ALL ON public.v_reposicao_sku_fora_do_motor FROM anon;"
if postcondicao_aborta "/NOT ILIKE '%405ML'/d" "A3"; then ok "P3 postcondição A3 aborta o 405ML no sensor"
else bad "P3 postcondição A3 NÃO abortou o 405ML no sensor"; fi
# e a migration verdadeira, re-aplicada por cima de tudo, passa (idempotência + estado final bom)
if P -q -f "$MIG" >/dev/null 2>&1; then ok "P4 migration verdadeira re-aplicada: postcondição verde (idempotente)"
else bad "P4 a migration verdadeira falhou ao ser re-aplicada"; fi
eq "P5 depois da re-aplicação, o conjunto é o esperado" "$(conjunto)" "$ESPERADO_CONJUNTO"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
