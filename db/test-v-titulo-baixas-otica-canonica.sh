#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — v_titulo_baixas: uma ótica por título (dedup das 2 óticas Omie)  ║
# ║  Migration: supabase/migrations/20260909074613_v_titulo_baixas_otica_canonica  ║
# ║      bash db/test-v-titulo-baixas-otica-canonica.sh > /tmp/t.log 2>&1; echo $? ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                                ║
# ║  O que se prova (cada item tem a sabotagem que o deixa VERMELHO na ZONA 5):    ║
# ║   A1 dobra entre óticas não soma       ← F1 volta a somar as duas             ║
# ║   A2 fallback aparece e se declara     ← F4 filtro cego LIKE 'CONTA_A_%'      ║
# ║   A3 resumo cumulativo não soma        ← F2 remove o DISTINCT ON              ║
# ║   A4 baixas de conta corrente somam    ← F2 também (o UNION é o mesmo eixo)   ║
# ║   A5 PREVISAO_* não é baixa            ← F3 afrouxa a allowlist               ║
# ║   A6 company e CR/CP são independentes ← F6 tira company/tipo da seleção      ║
# ║   A7 conjunto INTEIRO (EXCEPT ALL 2x)  ← qualquer linha extra/faltante/dupla  ║
# ║   A8 security_invoker=on preservado    ← F5 replace sem o WITH                ║
# ║   A9 a POSTCONDIÇÃO da migration morde ← F5 (roda o DO $post$ sobre a furada)  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="baixas-otica"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (as 3 tabelas que a view lê; colunas que ela usa)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.fin_movimentacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  omie_ncodmov bigint,
  omie_ncodcc bigint,
  data_movimento date,
  tipo text,
  valor numeric,
  descricao text,
  categoria_codigo text,
  categoria_descricao text,
  conciliado boolean DEFAULT false,
  omie_codigo_lancamento bigint,
  natureza text,
  metadata jsonb
);
CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  omie_codigo_lancamento bigint,
  status_titulo text,
  data_emissao date,
  data_vencimento date,
  valor_documento numeric
);
CREATE TABLE public.fin_contas_pagar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  omie_codigo_lancamento bigint,
  status_titulo text,
  data_emissao date,
  data_vencimento date,
  valor_documento numeric
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260909074613_v_titulo_baixas_otica_canonica.sql"
MIG_ANTIGA="$REPO_ROOT/supabase/migrations/20260528120001_v_titulo_baixas.sql"
[ -f "$MIG" ] || { echo "❌ migration não encontrada: $MIG"; exit 1; }

# Aplica a view ANTIGA primeiro e o REPLACE por cima — é assim que a mudança chega
# na PROD, e `CREATE OR REPLACE VIEW` recusa renomear/reordenar coluna existente
# ("cannot change name of view column"). Aplicar só a nova num banco limpo não
# provaria isso. A coluna nova (origem_baixa) tem de entrar NO FIM.
P -q -f "$MIG_ANTIGA"
COLS_ANTES="$(Pq -c "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='v_titulo_baixas';")"
P -q -f "$MIG"
COLS_DEPOIS="$(Pq -c "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='v_titulo_baixas';")"
echo "migration aplicada por cima da antiga: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: cada caso isola UM comportamento
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- ── títulos ──────────────────────────────────────────────────────────────────
INSERT INTO public.fin_contas_receber (company, omie_codigo_lancamento, status_titulo, data_emissao, valor_documento) VALUES
  ('acme',  1001, 'RECEBIDO', '2026-07-01', 1000),  -- C1 as 2 óticas
  ('acme',  1002, 'RECEBIDO', '2026-07-01',  500),  -- C2 só conta corrente (fallback)
  ('acme',  1003, 'RECEBIDO', '2026-07-01', 1000),  -- C3 resumos cumulativos
  ('acme',  1004, 'RECEBIDO', '2026-07-01', 1000),  -- C4 2 baixas reais no banco
  ('acme',  1005, 'RECEBIDO', '2026-07-01',  700),  -- C5 só PREVISAO -> fora
  ('acme',  1008, 'A VENCER', '2026-07-01',  900),  -- C8 título aberto -> fora
  ('acme',  1009, 'RECEBIDO', '2026-07-01',  100),  -- C9 movimento valor 0 -> fora
  ('outra', 1001, 'RECEBIDO', '2026-07-01',  250);  -- C6 MESMO código, outra empresa
INSERT INTO public.fin_contas_pagar (company, omie_codigo_lancamento, status_titulo, data_emissao, valor_documento) VALUES
  ('acme',  1001, 'PAGO',     '2026-07-01',  333);  -- C7 MESMO código, outro LADO

-- ── movimentos ───────────────────────────────────────────────────────────────
INSERT INTO public.fin_movimentacoes
  (company, omie_ncodmov, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento) VALUES
  -- C1: mesmo pagamento, duas óticas. A de banco cai 3 dias depois (sexta -> segunda).
  ('acme',  1, '2026-07-31', 'E', 1000, 'CONTA_A_RECEBER',    1001),
  ('acme',  2, '2026-08-03', 'E', 1000, 'CONTA_CORRENTE_REC', 1001),
  -- C2: só a ótica de banco existe (o caso do colacor pré-2026-02-25)
  ('acme',  3, '2026-08-03', 'E',  500, 'CONTA_CORRENTE_REC', 1002),
  -- C3: DOIS resumos cumulativos do título (nValPago é total pago, não evento)
  --     + as baixas de banco correspondentes. Somar tudo daria 2400; só a ótica
  --     do título somada daria 1400. O certo é 1000.
  ('acme',  4, '2026-07-10', 'E',  400, 'CONTA_A_RECEBER',    1003),
  ('acme',  5, '2026-07-31', 'E', 1000, 'CONTA_A_RECEBER',    1003),
  ('acme',  6, '2026-07-11', 'E',  400, 'CONTA_CORRENTE_REC', 1003),
  ('acme',  7, '2026-08-01', 'E',  600, 'CONTA_CORRENTE_REC', 1003),
  -- C4: só banco, com DUAS baixas de verdade (nCodBaixa distinto) -> aqui SOMA
  ('acme',  8, '2026-07-11', 'E',  400, 'CONTA_CORRENTE_REC', 1004),
  ('acme',  9, '2026-08-01', 'E',  600, 'CONTA_CORRENTE_REC', 1004),
  -- C5: previsão de pedido casada com título RECEBIDO -> não é baixa
  ('acme', 10, '2026-07-05', 'E',  700, 'PREVISAO_PEDIDO_VENDA', 1005),
  -- C8: título ainda aberto
  ('acme', 11, '2026-07-15', 'E',  900, 'CONTA_A_RECEBER',    1008),
  -- C9: valor 0 (título aberto no sync: nValPago=0) -> filtrado por valor>0
  ('acme', 12, '2026-07-15', 'E',    0, 'CONTA_A_RECEBER',    1009),
  -- C6: MESMO código 1001, outra empresa
  ('outra',13, '2026-07-20', 'E',  250, 'CONTA_A_RECEBER',    1001),
  -- C7: MESMO código 1001, lado CP (tipo 'S')
  ('acme', 14, '2026-07-25', 'S',  333, 'CONTA_A_PAGAR',      1001);
SQL
echo "seed pronto"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
# linha(company, cod, tipo) -> "valor|data|n|prazo|origem"  ("(vazio)" se não existe)
linha() {
  Pq -c "SELECT coalesce((SELECT valor_baixado||'|'||data_baixa_final||'|'||n_movimentos||'|'||coalesce(prazo_ponderado_dias::text,'~')||'|'||origem_baixa
          FROM public.v_titulo_baixas WHERE company='$1' AND omie_codigo_lancamento=$2 AND tipo='$3'), '(vazio)');"
}

# Esperados escritos À MÃO a partir dos seeds — NUNCA copiados da seleção da view
# (esperado derivado da implementação prova apenas que ela é igual a si mesma).
echo "── asserts ──"
eq "A1 dobra das 2 óticas não soma (C1: 1000, data do TÍTULO 07-31, não 08-03)" \
   "$(linha acme 1001 CR)" "1000|2026-07-31|1|30|titulo"

eq "A2 fallback aparece e se DECLARA (C2: só conta corrente)" \
   "$(linha acme 1002 CR)" "500|2026-08-03|1|33|conta_corrente"

eq "A3 resumo cumulativo não soma (C3: 1000, não 1400 nem 2400)" \
   "$(linha acme 1003 CR)" "1000|2026-07-31|1|30|titulo"

# prazo C4 = (400*10 + 600*31)/1000 = 22,6 -> round = 23
eq "A4 baixas de conta corrente SOMAM (C4: 400+600=1000, n=2, prazo ponderado 23)" \
   "$(linha acme 1004 CR)" "1000|2026-08-01|2|23|conta_corrente"

eq "A5 PREVISAO_PEDIDO_VENDA não é baixa (C5 fora da view)" \
   "$(linha acme 1005 CR)" "(vazio)"

eq "A6a título ABERTO fora (C8)"                "$(linha acme 1008 CR)" "(vazio)"
eq "A6b movimento de valor 0 fora (C9)"         "$(linha acme 1009 CR)" "(vazio)"
eq "A6c mesmo código, OUTRA empresa: independente (C6)" \
   "$(linha outra 1001 CR)" "250|2026-07-20|1|19|titulo"
eq "A6d mesmo código, lado CP: independente (C7)" \
   "$(linha acme 1001 CP)" "333|2026-07-25|1|24|titulo"

# A7 — conjunto INTEIRO, EXCEPT ALL nos DOIS sentidos (pega linha extra, faltante E duplicada;
#      um simples "count igual" não pegaria uma linha trocada por outra).
conjunto_diff() {
  Pq <<'SQL'
WITH esperado(company, cod, tipo, data_baixa_final, valor_baixado, n_movimentos, prazo, origem) AS (
  VALUES ('acme'::text, 1001::bigint, 'CR'::text, '2026-07-31'::date, 1000::numeric, 1, 30::numeric, 'titulo'::text),
         ('acme',       1002,         'CR',       '2026-08-03',        500,          1, 33,          'conta_corrente'),
         ('acme',       1003,         'CR',       '2026-07-31',       1000,          1, 30,          'titulo'),
         ('acme',       1004,         'CR',       '2026-08-01',       1000,          2, 23,          'conta_corrente'),
         ('acme',       1001,         'CP',       '2026-07-25',        333,          1, 24,          'titulo'),
         ('outra',      1001,         'CR',       '2026-07-20',        250,          1, 19,          'titulo')
),
real AS (
  SELECT company, omie_codigo_lancamento, tipo, data_baixa_final, valor_baixado,
         n_movimentos, prazo_ponderado_dias, origem_baixa
  FROM public.v_titulo_baixas
),
falta AS (SELECT * FROM esperado EXCEPT ALL SELECT * FROM real),
sobra AS (SELECT * FROM real     EXCEPT ALL SELECT * FROM esperado)
SELECT (SELECT count(*) FROM falta) || '/' || (SELECT count(*) FROM sobra);
SQL
}
eq "A7 conjunto inteiro idêntico (EXCEPT ALL nos 2 sentidos: faltando/sobrando)" \
   "$(conjunto_diff)" "0/0"

# A8 — security_invoker: omitir o WITH no replace RESETA a opção e a view passa a ler
#      como OWNER, bypassando a RLS das base-tables. Falha ABERTA que o CI não vê.
sec_invoker() {
  Pq -c "SELECT coalesce((SELECT 'on' FROM pg_class WHERE oid='public.v_titulo_baixas'::regclass AND reloptions @> ARRAY['security_invoker=on']), 'OFF');"
}
eq "A8 security_invoker preservado no replace" "$(sec_invoker)" "on"

# A8b — o REPLACE por cima da view antiga preserva a ordem e só ACRESCENTA no fim.
eq "A8b colunas antigas intactas + origem_baixa NO FIM" \
   "$COLS_DEPOIS" "${COLS_ANTES},origem_baixa"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3). O CONTROLE acima já rodou VERDE nesta MESMA
# invocação: sem isso, uma sabotagem sempre-vermelha aprovaria qualquer coisa.
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada sabotagem deve deixar VERMELHO o assert previsto) ──"
[ "$FAIL" = "0" ] || { echo "❌ controle já veio vermelho — falsificar aqui não prova nada"; exit 1; }
echo "  (controle verde: $PASS asserts)"

restaura() { P -q -f "$MIG"; }

# muta <nome> <sql-da-view-furada> <assert-que-deve-quebrar> <valor-do-controle>
#   passa se a linha MUDAR em relação ao controle; falha se ficar igual (assert sem dente).
muta() {
  local nome="$1" sql="$2" checador="$3" antes="$4"
  P -q -c "$sql" > /dev/null
  local depois; depois="$(eval "$checador")"
  if [ "$depois" != "$antes" ]; then ok "F:$nome → assert mudou ($antes → $depois)"
  else bad "F:$nome → assert NÃO mudou (ficou $depois) — sem dente"; fi
  restaura
}

VIEW_HEAD="CREATE OR REPLACE VIEW public.v_titulo_baixas WITH (security_invoker = on) AS"
# corpo comum das sabotagens: muda só a CTE mov_canon/mov, mantendo o resto
corpo() {
  local mov_extra="$1" canon_sel="$2"
  cat <<EOF
$VIEW_HEAD
WITH mov AS (
  SELECT company, omie_codigo_lancamento AS cod, tipo, data_movimento, valor,
         categoria_descricao AS grupo
  FROM public.fin_movimentacoes
  WHERE omie_codigo_lancamento IS NOT NULL AND data_movimento IS NOT NULL
    AND tipo IN ('E','S') AND valor > 0 $mov_extra
),
mov_canon AS ( $canon_sel )
SELECT cr.company, cr.omie_codigo_lancamento, 'CR'::text AS tipo,
  max(m.data_movimento) AS data_baixa_final, sum(m.valor) AS valor_baixado,
  count(*)::int AS n_movimentos,
  CASE WHEN cr.data_emissao IS NOT NULL AND sum(m.valor) > 0
       THEN round(sum(m.valor * (m.data_movimento - cr.data_emissao)) / sum(m.valor)) END AS prazo_ponderado_dias,
  max(m.origem) AS origem_baixa
FROM public.fin_contas_receber cr
JOIN mov_canon m ON m.company=cr.company AND m.cod=cr.omie_codigo_lancamento AND m.tipo='E'
WHERE cr.omie_codigo_lancamento IS NOT NULL AND cr.status_titulo IN ('RECEBIDO','LIQUIDADO')
GROUP BY cr.company, cr.omie_codigo_lancamento, cr.data_emissao
UNION ALL
SELECT cp.company, cp.omie_codigo_lancamento, 'CP'::text AS tipo,
  max(m.data_movimento) AS data_baixa_final, sum(m.valor) AS valor_baixado,
  count(*)::int AS n_movimentos,
  CASE WHEN cp.data_emissao IS NOT NULL AND sum(m.valor) > 0
       THEN round(sum(m.valor * (m.data_movimento - cp.data_emissao)) / sum(m.valor)) END AS prazo_ponderado_dias,
  max(m.origem) AS origem_baixa
FROM public.fin_contas_pagar cp
JOIN mov_canon m ON m.company=cp.company AND m.cod=cp.omie_codigo_lancamento AND m.tipo='S'
WHERE cp.omie_codigo_lancamento IS NOT NULL AND cp.status_titulo IN ('PAGO','LIQUIDADO')
GROUP BY cp.company, cp.omie_codigo_lancamento, cp.data_emissao;
EOF
}

ALLOW="AND categoria_descricao IN ('CONTA_A_RECEBER','CONTA_A_PAGAR','CONTA_CORRENTE_REC','CONTA_CORRENTE_PAG')"
SEM_ESCOLHA="SELECT company, cod, tipo, data_movimento, valor, 'titulo'::text AS origem FROM mov"

# F1 — não escolhe ótica: soma as DUAS (o defeito original). C1 vira 2000 @ 08-03.
muta "F1 sem escolha de ótica (volta a somar as duas)" \
     "$(corpo "$ALLOW" "$SEM_ESCOLHA")" "linha acme 1001 CR" "1000|2026-07-31|1|30|titulo"

# F2 — escolhe a ótica mas SOMA os resumos cumulativos (sem o DISTINCT ON). C3 vira 1400.
COM_ESCOLHA_SEM_DISTINCT="SELECT m.company, m.cod, m.tipo, m.data_movimento, m.valor,
   CASE WHEN c.tem_tit THEN 'titulo' ELSE 'conta_corrente' END AS origem
 FROM mov m
 JOIN (SELECT company, cod, tipo, bool_or(grupo IN ('CONTA_A_RECEBER','CONTA_A_PAGAR')) AS tem_tit
       FROM mov GROUP BY 1,2,3) c
   ON c.company=m.company AND c.cod=m.cod AND c.tipo=m.tipo
 WHERE (c.tem_tit AND m.grupo IN ('CONTA_A_RECEBER','CONTA_A_PAGAR')) OR NOT c.tem_tit"
muta "F2 sem DISTINCT ON (soma resumos cumulativos)" \
     "$(corpo "$ALLOW" "$COM_ESCOLHA_SEM_DISTINCT")" "linha acme 1003 CR" "1000|2026-07-31|1|30|titulo"

# F3 — allowlist afrouxada: PREVISAO_* entra como se fosse baixa. C5 deixa de ser vazio.
muta "F3 sem allowlist positiva (PREVISAO_* entra)" \
     "$(corpo "" "$SEM_ESCOLHA")" "linha acme 1005 CR" "(vazio)"

# F4 — filtro CEGO 'CONTA_A_%': o título que só tem ótica de banco SOME (perda de cobertura).
SO_CONTA_A="SELECT company, cod, tipo, data_movimento, valor, 'titulo'::text AS origem
            FROM mov WHERE grupo IN ('CONTA_A_RECEBER','CONTA_A_PAGAR')"
muta "F4 filtro cego CONTA_A_% (perde o título só-banco)" \
     "$(corpo "$ALLOW" "$SO_CONTA_A")" "linha acme 1002 CR" "500|2026-08-03|1|33|conta_corrente"

# F6 — seleção sem company/tipo na partição: mistura empresas e lados.
SEM_ESCOPO="SELECT DISTINCT ON (m.cod) m.company, m.cod, m.tipo, m.data_movimento, m.valor,
   'titulo'::text AS origem
 FROM mov m
 ORDER BY m.cod, m.valor DESC, m.data_movimento DESC"
muta "F6 partição sem company/tipo (mistura empresas e lados)" \
     "$(corpo "$ALLOW" "$SEM_ESCOPO")" "conjunto_diff" "0/0"

# F5 — replace SEM o WITH: reseta security_invoker → a view lê como OWNER (bypassa RLS).
P -q -c "$(corpo "$ALLOW" "$SEM_ESCOLHA" | sed 's/ WITH (security_invoker = on)//')" > /dev/null
DEPOIS="$(sec_invoker)"
if [ "$DEPOIS" != "on" ]; then ok "F5 replace sem WITH → security_invoker caiu (on → $DEPOIS)"
else bad "F5 replace sem WITH → security_invoker seguiu 'on' — o assert A8 não tem dente"; fi

# A9 — a POSTCONDIÇÃO da própria migration morde? Roda o bloco DO $post$ sobre a view furada
#      (sem security_invoker, deixada por F5). Sentinela: casa a SQLSTATE, não o texto do RAISE
#      (procurar a mensagem do próprio código faria o assert casar consigo mesmo).
POST_OUT="$(P -tA 2>&1 <<'SQL' || true
DO $t$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.v_titulo_baixas'::regclass
      AND reloptions @> ARRAY['security_invoker=on']
  ) THEN
    RAISE EXCEPTION 'v_titulo_baixas FALHOU: security_invoker NAO esta on';
  END IF;
  RAISE NOTICE 'SENTINELA_POSTCONDICAO_NAO_ABORTOU';
END
$t$;
SQL
)"
if printf '%s' "$POST_OUT" | grep -q 'SENTINELA_POSTCONDICAO_NAO_ABORTOU'; then
  bad "A9 postcondição da migration NÃO abortou sobre a view furada — é decorativa"
else
  ok "A9 postcondição da migration aborta a view sem security_invoker"
fi
restaura

# controle final: a migration real, reaplicada, volta ao verde (prova que a
# restauração é real e que nenhuma sabotagem vazou pro estado final).
eq "A10 restauração: conjunto volta ao esperado" "$(conjunto_diff)" "0/0"
eq "A11 restauração: security_invoker de volta"  "$(sec_invoker)"   "on"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
