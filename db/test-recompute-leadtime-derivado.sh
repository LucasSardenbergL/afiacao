#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260716200000_reposicao_recompute_leadtime_derivado.sql        ║
# ║      bash db/test-recompute-leadtime-derivado.sh > /tmp/t.log 2>&1; echo $?    ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  O que está em jogo: lt_bruto_dias_uteis é o insumo do motor de reposição      ║
# ║  (decide QUANDO pedir). Um lt curto demais = pedir tarde = ruptura. Por isso    ║
# ║  o teste central NÃO é "recomputa", é "NÃO recomputa quando o t1 é fabricado". ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="recompute-leadtime"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

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
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# Para a falsificação: exige que um assert que era verde fique VERMELHO após a sabotagem.
# ⚠️ Leitura VAZIA é FALHA, nunca prova (lição #1362 do money-path.md: "falsificação só vale
# se o vermelho for do SEU assert"). Se a query quebrar — sabotagem que derruba a função,
# tracking_id errado, typo no nome da coluna — o valor vem "" e um `"" != "NULL"` ingênuo
# daria VERDE, "provando" o nada. O tell é justamente o vazio: exigi-lo não-vazio força o
# vermelho a vir do comportamento sob teste, não do comando quebrado.
neq() {
  if [ -z "$2" ]; then
    bad "$1 — LEITURA VAZIA: a query falhou; isso não é prova de sabotagem (lição #1362)"
  elif [ "$2" != "$3" ]; then
    ok "$1 (sabotagem detectada: veio [$2], não [$3])"
  else
    bad "$1 — SABOTAGEM PASSOU DESPERCEBIDA: assert sem dente"
  fi
}

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migração LÊ mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');

CREATE TABLE public.purchase_orders_tracking (
  id uuid PRIMARY KEY,
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  numero_contrato_fornecedor text,
  nfe_chave_acesso text,
  fornecedor_codigo_omie bigint,
  fornecedor_nome text,
  grupo_leadtime text,
  t1_data_pedido timestamptz NOT NULL,
  t2_data_faturamento timestamptz,
  t3_data_cte timestamptz,
  t4_data_recebimento timestamptz,
  raw_data jsonb
);

CREATE TABLE public.sku_leadtime_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id uuid NOT NULL REFERENCES public.purchase_orders_tracking(id) ON DELETE CASCADE,
  empresa public.empresa_reposicao NOT NULL,
  sku_codigo_omie bigint NOT NULL,
  fornecedor_codigo_omie bigint,
  fornecedor_nome text,
  grupo_leadtime text,
  quantidade_pedida numeric,
  quantidade_recebida numeric,
  valor_unitario numeric,
  valor_total numeric,
  t1_data_pedido timestamptz NOT NULL,
  t2_data_faturamento timestamptz,
  t3_data_cte timestamptz,
  t4_data_recebimento timestamptz,
  lt_bruto_dias_uteis integer,
  lt_faturamento_dias_uteis integer,
  lt_logistica_dias_uteis integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  origem_compra text NOT NULL DEFAULT 'normal',
  CONSTRAINT uq_sku_hist_tracking_sku UNIQUE (tracking_id, sku_codigo_omie)
);
SQL

# dias_uteis_entre: VERBATIM da prod (pg_get_functiondef em 2026-07-16). A migração DEPENDE
# dela; testar contra uma reimplementação minha provaria a minha conta, não o sistema real.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.dias_uteis_entre(inicio timestamptz, fim timestamptz)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  total integer := 0;
  cursor_dia date;
  ultimo_dia date;
BEGIN
  IF inicio IS NULL OR fim IS NULL OR fim < inicio THEN
    RETURN NULL;
  END IF;
  cursor_dia := inicio::date;
  ultimo_dia := fim::date;
  WHILE cursor_dia <= ultimo_dia LOOP
    IF EXTRACT(DOW FROM cursor_dia) NOT IN (0, 6) THEN
      total := total + 1;
    END IF;
    cursor_dia := cursor_dia + interval '1 day';
  END LOOP;
  RETURN GREATEST(total - 1, 0);
END;
$function$;
SQL

# Sentinela do próprio harness: se o calendário do PG local divergir do de prod, TODO
# valor esperado abaixo é lixo. 2026-06-01=seg, 06-05=sex, 06-10=qua (conferido em prod).
SENT_A=$(Pq -c "SELECT public.dias_uteis_entre('2026-06-01'::timestamptz,'2026-06-10'::timestamptz);")
SENT_B=$(Pq -c "SELECT public.dias_uteis_entre('2026-06-05'::timestamptz,'2026-06-01'::timestamptz);")
eq "S0 sentinela: calendário do harness == prod (seg→qua seguinte)" "$SENT_A" "7"
eq "S0 sentinela: data invertida degrada p/ NULL (não fabrica 0)" "${SENT_B:-NULL}" "NULL"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260716200000_reposicao_recompute_leadtime_derivado.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS: um cenário por invariante
# ══════════════════════════════════════════════════════════════════════════════
# Calendário: 2026-06-01 seg · 06-05 sex · 06-10 qua
#   dias_uteis(06-01→06-10)=7 · (06-01→06-05)=4 · (06-05→06-10)=3 · (06-05→06-05)=0
seed() { P -q <<SQL
INSERT INTO public.purchase_orders_tracking
  (id, empresa, omie_codigo_pedido, t1_data_pedido, t2_data_faturamento, t4_data_recebimento, nfe_chave_acesso)
VALUES ('$1', '$2', $3, '$4', '$5', $6, 'nfe-$1');
SQL
}
# $1=id $2=empresa $3=omie_cod $4=trk_t1 $5=trk_t2 $6=trk_t4(quoted|NULL)
seed 'aaaa0001-0000-0000-0000-000000000000' OBEN     100 '2026-06-01' '2026-06-05' "'2026-06-10'"
seed 'aaaa0002-0000-0000-0000-000000000000' OBEN     200 '2026-06-05' '2026-06-05' "'2026-06-10'"
seed 'aaaa0003-0000-0000-0000-000000000000' OBEN     300 '2026-06-01' '2026-06-05' "'2026-06-10'"
seed 'aaaa0004-0000-0000-0000-000000000000' OBEN    -400 '2026-06-05' '2026-06-05' "'2026-06-10'"
seed 'aaaa0005-0000-0000-0000-000000000000' OBEN    -500 '2026-06-01' '2026-06-05' "'2026-06-10'"
seed 'aaaa0006-0000-0000-0000-000000000000' OBEN     600 '2026-06-01' '2026-06-05' "NULL"
seed 'aaaa0007-0000-0000-0000-000000000000' OBEN     700 '2026-06-10' '2026-06-05' "'2026-06-01'"
seed 'aaaa0008-0000-0000-0000-000000000000' OBEN     800 '2026-06-01' '2026-06-05' "'2026-06-10'"
seed 'aaaa0009-0000-0000-0000-000000000000' COLACOR  900 '2026-06-01' '2026-06-05' "'2026-06-10'"
seed 'aaaa0010-0000-0000-0000-000000000000' OBEN   -1000 '2026-06-01' '2026-06-05' "'2026-06-10'"

# hist: $1=tracking $2=empresa $3=h_t1 $4=h_t2 $5=h_t4 $6=lt_b $7=lt_f $8=lt_l
hist() { P -q <<SQL
INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, t1_data_pedido, t2_data_faturamento, t4_data_recebimento,
   lt_bruto_dias_uteis, lt_faturamento_dias_uteis, lt_logistica_dias_uteis, quantidade_recebida, valor_total)
VALUES ('$1', '$2', 777, '$3', '$4', $5, $6, $7, $8, 10, 100);
SQL
}
#         tracking                                 empresa  h_t1         h_t2         h_t4    lt_b  lt_f  lt_l
# 1 REC-OK — Bug A puro: nasceu no faturamento, t4 chegou depois no tracking
hist 'aaaa0001-0000-0000-0000-000000000000' OBEN    '2026-06-01' '2026-06-05' NULL     NULL  NULL  NULL
# 2 MESMO-DIA LEGÍTIMO — pedido real faturado no mesmo dia (t1=t2=tracking.t1, omie>0). DEVE recomputar.
hist 'aaaa0002-0000-0000-0000-000000000000' OBEN    '2026-06-05' '2026-06-05' NULL     NULL  NULL  NULL
# 3 FALLBACK PROVADO — t1 gravado É o faturamento e o tracking tem um t1 real DIFERENTE.
#   Nasceu com lt_bruto=99 (mentira). DEVE anular, não recomputar.
hist 'aaaa0003-0000-0000-0000-000000000000' OBEN    '2026-06-05' '2026-06-05' "'2026-06-10'" 99  0  3
# 4 ÓRFÃ com t1=t2
hist 'aaaa0004-0000-0000-0000-000000000000' OBEN    '2026-06-05' '2026-06-05' "'2026-06-10'" 3   0  3
# 5 ÓRFÃ com t1<>t2 — O FURO QUE O CODEX ACHOU (55 em prod). Gate só-por-datas a deixaria passar.
hist 'aaaa0005-0000-0000-0000-000000000000' OBEN    '2026-06-01' '2026-06-05' NULL     NULL  NULL  NULL
# 6 SEM T4 no tracking — nada a derivar
hist 'aaaa0006-0000-0000-0000-000000000000' OBEN    '2026-06-01' '2026-06-05' NULL     NULL  NULL  NULL
# 7 T4 < T1 — fonte inconsistente (21 em prod)
hist 'aaaa0007-0000-0000-0000-000000000000' OBEN    '2026-06-10' '2026-06-05' NULL     NULL  NULL  NULL
# 8 CONGELADA — lt_bruto=99 gravado ERRADO numa linha confiável. Só o IS DISTINCT FROM a alcança.
hist 'aaaa0008-0000-0000-0000-000000000000' OBEN    '2026-06-01' '2026-06-05' "'2026-06-10'" 99  4  3
# 9 OUTRA EMPRESA — COLACOR não pode ser tocada por um run de OBEN
hist 'aaaa0009-0000-0000-0000-000000000000' COLACOR '2026-06-01' '2026-06-05' NULL     NULL  NULL  NULL
# 10 ÓRFÃ com lt_logistica REAL — a anulação não pode destruí-lo (t2/t4 são verdade)
hist 'aaaa0010-0000-0000-0000-000000000000' OBEN    '2026-06-01' '2026-06-05' "'2026-06-10'" 7   4  3

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
LT() { Pq -c "SELECT coalesce($2::text,'NULL') FROM public.sku_leadtime_history WHERE tracking_id='aaaa$1-0000-0000-0000-000000000000';"; }
# ⚠️ recomputar_leadtime_derivado EXECUTA a cada chamada (é a RPC, não uma view). Ler etapa
# por etapa com um SELECT cada a rodaria N vezes: a 2ª leitura já viria zerada pela 1ª
# execução e o teste de idempotência estaria medindo a rodada N+1 — verde por acidente.
# RUN roda UMA vez e devolve todas as etapas numa linha; val() extrai delas.
RUN() { Pq -c "SELECT string_agg(etapa||'='||valor, ' ' ORDER BY etapa) FROM public.recomputar_leadtime_derivado('$1');"; }
val() { printf '%s\n' "$1" | tr ' ' '\n' | grep "^$2=" | cut -d= -f2; }

echo "── run 1: recomputar_leadtime_derivado('OBEN') ──"
# Roda de verdade (Lei #1: plpgsql é late-bound — CREATE passa com SQL inválido).
RUN1=$(RUN 'OBEN')
echo "  run1: $RUN1"

echo "── escopo do run: exatamente quem devia ser tocado ──"
# Recomputa 5: 0001 (Bug A) · 0002 (mesmo-dia legítimo) · 0006 (sem t4, mas lt_faturamento
# não depende de t4) · 0007 (datas ruins, mas lt_logistica é derivável) · 0008 (congelada).
# Anula 3: 0003 · 0004 · 0010. A 0005 já nasceu NULL ⇒ nada a anular (o guard de
# idempotência a exclui) — o que a prova de que ela não foi RECOMPUTADA é o A5.
eq "A0  run1 recomputa exatamente as 5 confiáveis"        "$(val "$RUN1" 'leadtime_recomputado')"            "5"
eq "A0b run1 anula exatamente as 3 com derivado fabricado" "$(val "$RUN1" 'leadtime_anulado_t1_nao_e_pedido')" "3"

echo "── positivos: o derivado fecha ──"
eq "A1  Bug A: t4 do tracking destrava o lt_bruto"        "$(LT 0001 lt_bruto_dias_uteis)"       "7"
eq "A1b Bug A: lt_faturamento junto (quebrado no Bug B)"  "$(LT 0001 lt_faturamento_dias_uteis)" "4"
eq "A1c Bug A: lt_logistica junto"                        "$(LT 0001 lt_logistica_dias_uteis)"   "3"
eq "A1d Bug A: t4 é COPIADO do tracking p/ a linha"       "$(Pq -c "SELECT t4_data_recebimento::date FROM public.sku_leadtime_history WHERE tracking_id='aaaa0001-0000-0000-0000-000000000000';")" "2026-06-10"
eq "A2  mesmo-dia LEGÍTIMO recomputa (t1=t2=trk.t1, omie>0)" "$(LT 0002 lt_bruto_dias_uteis)"     "3"
eq "A2b mesmo-dia legítimo: lt_faturamento=0 é VERDADE"   "$(LT 0002 lt_faturamento_dias_uteis)" "0"

echo "── negativos: a mentira NÃO nasce e a existente morre ──"
eq "A3  fallback provado: lt_bruto ANULADO (era 99)"      "$(LT 0003 lt_bruto_dias_uteis)"       "NULL"
eq "A3b fallback provado: lt_faturamento ANULADO"         "$(LT 0003 lt_faturamento_dias_uteis)" "NULL"
eq "A4  órfã (t1=t2): lt_bruto ANULADO"                   "$(LT 0004 lt_bruto_dias_uteis)"       "NULL"
eq "A5  órfã com t1<>t2 (furo do Codex): NÃO recomputa"   "$(LT 0005 lt_bruto_dias_uteis)"       "NULL"
eq "A6  sem t4 no tracking: fica NULL (ausente≠zero)"     "$(LT 0006 lt_bruto_dias_uteis)"       "NULL"
eq "A7  t4<t1: degrada p/ NULL (não fabrica 0)"           "$(LT 0007 lt_bruto_dias_uteis)"       "NULL"
eq "A10 anulação PRESERVA lt_logistica (t2/t4 são reais)" "$(LT 0010 lt_logistica_dias_uteis)"   "3"
eq "A10b órfã: lt_bruto anulado mesmo estando 'certo'"    "$(LT 0010 lt_bruto_dias_uteis)"       "NULL"

echo "── convergência e isolamento ──"
eq "A8  CONGELADA: lt errado (99) é CORRIGIDO p/ 7"       "$(LT 0008 lt_bruto_dias_uteis)"       "7"
eq "A9  outra empresa (COLACOR) intocada por run de OBEN" "$(LT 0009 lt_bruto_dias_uteis)"       "NULL"

echo "── observabilidade: NULL é decisão declarada, não bug (lido do PRÓPRIO run1) ──"
eq "A12 conta os NULL honestos que aguardam t4"      "$(val "$RUN1" 'null_honesto_aguardando_t4')"    "1"
eq "A12b conta os NULL honestos de data invertida"   "$(val "$RUN1" 'null_honesto_datas_invertidas')" "1"

echo "── idempotência: a 2ª rodada não toca NADA ──"
RUN2=$(RUN 'OBEN')
echo "  run2: $RUN2"
eq "A11 2ª rodada recomputa 0 linhas"  "$(val "$RUN2" 'leadtime_recomputado')"            "0"
eq "A11b 2ª rodada anula 0 linhas"     "$(val "$RUN2" 'leadtime_anulado_t1_nao_e_pedido')" "0"

echo "── fail-closed: empresa vazia não varre a tabela inteira (SQLSTATE 22023) ──"
R=$(P -tA 2>&1 <<'SQL' || true
DO $$
BEGIN
  PERFORM public.recomputar_leadtime_derivado('');
  RAISE NOTICE 'HARNESS_GATE_NAO_MORDEU';
EXCEPTION
  WHEN invalid_parameter_value THEN   -- 22023: a condição ESPERADA
    RAISE NOTICE 'HARNESS_GATE_MORDEU';
  WHEN OTHERS THEN
    RAISE;                            -- qualquer outro erro é bug do teste → relança
END $$;
SQL
)
# Sentinela anti-teatro: 'HARNESS_GATE_MORDEU' não aparece em lugar nenhum do código sob teste.
case "$R" in
  *HARNESS_GATE_MORDEU*)     ok  "A13 empresa vazia → 22023 (fail-closed)" ;;
  *HARNESS_GATE_NAO_MORDEU*) bad "A13 empresa vazia PASSOU — varreria as duas empresas" ;;
  *)                         bad "A13 erro inesperado no gate: $R" ;;
esac

echo "── grants: o cliente não executa a RPC de escrita ──"
must_fail_role() { if P -q -c "SET ROLE $1; SELECT public.recomputar_leadtime_derivado('OBEN');" >/dev/null 2>&1; then bad "$2 — EXECUTOU"; else ok "$2 (negado)"; fi; }
must_fail_role anon          "A14 anon não executa a RPC"
must_fail_role authenticated "A14b authenticated não executa a RPC"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação: os asserts têm dente? ──"
# Baseline VERDE explícito (lição #1362): prova que o harness RODA e quantos asserts existem
# antes de qualquer sabotagem. Sem ancorar aqui, não há como distinguir "a sabotagem pegou o
# bug" de "o comando quebrou e não testou nada".
echo "  baseline: $PASS asserts verdes / $FAIL vermelhos — as sabotagens abaixo partem daqui"
[ "$FAIL" = "0" ] || { echo "❌ baseline já vermelho — falsificar em cima disto não prova nada"; exit 1; }

# META: o instrumento antes do experimento. Se o neq aceitasse leitura vazia, as 4 sabotagens
# abaixo dariam verde mesmo com a query quebrada. Testa o neq contra o caso que o enganaria.
_F0=$FAIL; _P0=$PASS
neq "(auto-teste do neq — não conta no placar)" "" "X" >/dev/null 2>&1
_NEQ_REJEITOU_VAZIO=$([ "$FAIL" -gt "$_F0" ] && echo 1 || echo 0)
FAIL=$_F0; PASS=$_P0
eq "F0 META: o neq REPROVA leitura vazia (não vira falso-verde)" "$_NEQ_REJEITOU_VAZIO" "1"

restaura_gate() { P -q -f "$MIG"; }

# F1 — gate sempre-confiável (o "recomputa tudo" ingênuo). A3/A4/A5 devem quebrar.
# (Os nomes dos parâmetros têm de ser repetidos: CREATE OR REPLACE recusa renomeá-los.)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.leadtime_t1_e_data_de_pedido(
  p_hist_t1 timestamptz, p_hist_t2 timestamptz, p_tracking_t1 timestamptz, p_omie_codigo_pedido bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public','pg_temp' AS $$ SELECT true $$;
UPDATE public.sku_leadtime_history SET lt_bruto_dias_uteis = 99
 WHERE tracking_id IN ('aaaa0003-0000-0000-0000-000000000000','aaaa0005-0000-0000-0000-000000000000');
SQL
Pq -c "SELECT 1 FROM public.recomputar_leadtime_derivado('OBEN') LIMIT 1;" >/dev/null
neq "F1 gate furado (sempre true) → o fallback vira número" "$(LT 0003 lt_bruto_dias_uteis)" "NULL"
neq "F1b gate furado → a órfã vira número"                  "$(LT 0005 lt_bruto_dias_uteis)" "NULL"
restaura_gate

# F2 — gate SEM a cláusula categórica da órfã (só datas). É o gate que eu ia escrever antes
#      do Codex: A5 (órfã com t1<>t2) tem de ficar VERMELHO.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.leadtime_t1_e_data_de_pedido(
  p_hist_t1 timestamptz, p_hist_t2 timestamptz, p_tracking_t1 timestamptz, p_omie_codigo_pedido bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public','pg_temp' AS $$
  SELECT NOT (p_hist_t1 = p_hist_t2 AND p_hist_t1 IS DISTINCT FROM p_tracking_t1);
$$;
UPDATE public.sku_leadtime_history SET lt_bruto_dias_uteis = NULL WHERE tracking_id='aaaa0005-0000-0000-0000-000000000000';
SQL
Pq -c "SELECT 1 FROM public.recomputar_leadtime_derivado('OBEN') LIMIT 1;" >/dev/null
neq "F2 gate só-por-datas → órfã com t1<>t2 vira número"    "$(LT 0005 lt_bruto_dias_uteis)" "NULL"
restaura_gate

# F3 — gate ingênuo `t1 <> t2` (o meu antes de medir): mata o mesmo-dia LEGÍTIMO (A2).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.leadtime_t1_e_data_de_pedido(
  p_hist_t1 timestamptz, p_hist_t2 timestamptz, p_tracking_t1 timestamptz, p_omie_codigo_pedido bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public','pg_temp' AS $$
  SELECT p_hist_t1 IS DISTINCT FROM p_hist_t2;
$$;
UPDATE public.sku_leadtime_history SET lt_bruto_dias_uteis = NULL, lt_faturamento_dias_uteis = NULL
 WHERE tracking_id='aaaa0002-0000-0000-0000-000000000000';
SQL
Pq -c "SELECT 1 FROM public.recomputar_leadtime_derivado('OBEN') LIMIT 1;" >/dev/null
neq "F3 gate ingênuo (t1<>t2) → perde o mesmo-dia legítimo" "$(LT 0002 lt_bruto_dias_uteis)" "3"
restaura_gate
Pq -c "SELECT 1 FROM public.recomputar_leadtime_derivado('OBEN') LIMIT 1;" >/dev/null
eq  "F3r restaurado: o mesmo-dia legítimo volta a fechar"   "$(LT 0002 lt_bruto_dias_uteis)" "3"

# F4 — troca o IS DISTINCT FROM por `lt_bruto IS NULL` (o congelamento que o Codex previu):
#      a linha CONGELADA com lt errado nunca é corrigida → A8 vermelho.
P -q <<'SQL'
UPDATE public.sku_leadtime_history SET lt_bruto_dias_uteis = 99 WHERE tracking_id='aaaa0008-0000-0000-0000-000000000000';
CREATE OR REPLACE FUNCTION public.recomputar_leadtime_derivado_SABOTADA(p_empresa text) RETURNS void
LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $f$
BEGIN
  UPDATE public.sku_leadtime_history s
  SET lt_bruto_dias_uteis = public.dias_uteis_entre(s.t1_data_pedido, p.t4_data_recebimento)
  FROM public.purchase_orders_tracking p
  WHERE p.id = s.tracking_id AND s.empresa::text = p_empresa
    AND public.leadtime_t1_e_data_de_pedido(s.t1_data_pedido, s.t2_data_faturamento, p.t1_data_pedido, p.omie_codigo_pedido)
    AND s.lt_bruto_dias_uteis IS NULL;   -- ← a versão que CONGELA o erro
END $f$;
SQL
P -q -c "SELECT public.recomputar_leadtime_derivado_SABOTADA('OBEN');"
neq "F4 'WHERE lt IS NULL' → congela o lt errado (não corrige)" "$(LT 0008 lt_bruto_dias_uteis)" "7"
P -q -c "DROP FUNCTION public.recomputar_leadtime_derivado_SABOTADA(text);"
Pq -c "SELECT 1 FROM public.recomputar_leadtime_derivado('OBEN') LIMIT 1;" >/dev/null
eq  "F4r restaurado: o IS DISTINCT FROM corrige o congelado"   "$(LT 0008 lt_bruto_dias_uteis)" "7"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
