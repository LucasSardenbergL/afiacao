#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════════
# PROVA PG17 — skill CFO: o caixa REAL de 90 dias soma SÓ a ótica BANCÁRIA
# SQL sob teste: .claude/skills/cfo-colacor/assets/sql/01-caixa-13-semanas.sql, bloco (c)
# Roda:  bash db/test-cfo-caixa-90d-otica.sh > /tmp/t.log 2>&1; echo "exit=$?"
#        (NÃO pipe pra tail — engole o exit≠0.)
#
# O bloco é EXTRAÍDO do arquivo da skill (do cabeçalho "-- (c) " até o "-- (d) ") e executado
# como está, nunca uma cópia: quem editar a skill e reintroduzir a dobra fica vermelho aqui.
#
# Por que existe: `fin_movimentacoes` guarda o MESMO pagamento do Omie sob duas óticas
# (`CONTA_A_*` = lançamento do título, `CONTA_CORRENTE_*` = lançamento no banco) e ainda
# PREVISÕES (`PREVISAO_*`, tipo E com valor>0). O bloco somava tudo — medido na PROD em
# 2026-09-10: entradas de 90d R$ 2,57 M contra R$ 1,14 M da ótica bancária (+124,7%).
# Histórico: docs/historico/fin-movimentacoes-duas-oticas-do-mesmo-pagamento.md
#
# O que se prova — cada item com a sabotagem que o deixa VERMELHO e o número previsto:
#   A1-A4  entradas/saídas/fluxo/movimentos só do banco   ← F1 sem allowlist (3000 → 7050)
#                                                          ← F5 o SQL de antes (3000 → 7300)
#   A1     PREVISÃO não é caixa                           ← F2 allowlist por negação (→ 4000)
#   A1     baixas parciais do mesmo título SOMAM          ← F4 "dedup" por título (→ 2600)
#   A5-A6  sem título (transferência/tarifa) fica FORA do ← F3 sem o filtro de título (→ 3250)
#          fluxo, mas VISÍVEL nas colunas sem_titulo_*
#   A7     o último movimento é o do BANCO                ← F5 (hoje-3 → hoje-1, o título aberto)
#   A8     as empresas não se misturam
# Controle: o bloco real roda VERDE antes das sabotagens e de novo depois delas, na mesma
# invocação — sabotar sem linha de base verde é teatro (CLAUDE.md, "Teste SQL negativo").
# ════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5498}"
SLUG="cfo-caixa-90d"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência
# POSITIVA de que a major é a esperada. Fail-closed: PG ausente é ERRO, nunca skip.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITO: a tabela que o bloco lê, com os tipos da PROD
# (information_schema medido via psql-ro em 2026-09-10)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.fin_movimentacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  data_movimento date NOT NULL,
  tipo text,
  valor numeric NOT NULL,
  categoria_descricao text,
  omie_codigo_lancamento bigint
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — O SQL SOB TESTE: extraído do arquivo da skill
# ══════════════════════════════════════════════════════════════════════════════
SKILL_SQL="$REPO_ROOT/.claude/skills/cfo-colacor/assets/sql/01-caixa-13-semanas.sql"
[ -f "$SKILL_SQL" ] || { echo "❌ SQL da skill não encontrado: $SKILL_SQL"; exit 1; }
BLOCO="$(awk '/^-- \(c\) /{f=1} /^-- \(d\) /{f=0} f' "$SKILL_SQL")"

# Fail-closed na extração: se os cabeçalhos mudarem, o bloco sai vazio ou errado e a prova
# tem de reprovar — nunca "passar" medindo um SQL que não é o da skill.
if [ -n "$BLOCO" ] && printf '%s' "$BLOCO" | grep -q 'FROM fin_movimentacoes'; then
  ok "A0 bloco (c) extraído da skill e lê fin_movimentacoes"
else
  bad "A0 bloco (c) NÃO extraído — os cabeçalhos '-- (c) '/'-- (d) ' mudaram?"
  echo "RESULTADO: $PASS ok / $FAIL fail"; exit 1
fi

# (Re)cria a view `bloco_c` com o SQL dado. O `;` final sai para caber no CREATE VIEW.
# Cada sabotagem parte de uma cópia NOVA do bloco real (nada vaza de uma para a outra).
carrega() {
  P -q -c "DROP VIEW IF EXISTS bloco_c;"
  printf 'CREATE VIEW bloco_c AS\n%s;\n' "${1%;*}" | P -q -f -
}
# Uma coluna da view para uma empresa; NULL vira o texto NULL (ausente ≠ zero, também aqui).
col() { Pq -c "SELECT coalesce(($1)::text, 'NULL') FROM bloco_c WHERE company = '$2';"; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: cada caso isola UM comportamento (datas relativas a hoje)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO public.fin_movimentacoes (company, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento) VALUES
  -- C1 o mesmo recebimento nas duas óticas (o banco credita no dia útil seguinte)
  ('acme', CURRENT_DATE - 10, 'E', 1000, 'CONTA_A_RECEBER',        1001),
  ('acme', CURRENT_DATE -  9, 'E', 1000, 'CONTA_CORRENTE_REC',     1001),
  -- C2 par divergente em VALOR e DATA (21,3% / 39,4% dos pares na PROD): vale o do banco
  ('acme', CURRENT_DATE - 20, 'E', 1050, 'CONTA_A_RECEBER',        1002),
  ('acme', CURRENT_DATE - 17, 'E', 1000, 'CONTA_CORRENTE_REC',     1002),
  -- C3 duas baixas PARCIAIS no banco (eventos distintos) + o resumo cumulativo do título
  ('acme', CURRENT_DATE - 30, 'E', 1000, 'CONTA_A_RECEBER',        1003),
  ('acme', CURRENT_DATE - 40, 'E',  400, 'CONTA_CORRENTE_REC',     1003),
  ('acme', CURRENT_DATE - 29, 'E',  600, 'CONTA_CORRENTE_REC',     1003),
  -- C4/C5 PREVISÕES: tipo E, valor>0, título preenchido — e não é dinheiro que entrou
  ('acme', CURRENT_DATE -  5, 'E',  700, 'PREVISAO_PEDIDO_VENDA',  1004),
  ('acme', CURRENT_DATE -  5, 'E',  300, 'PREVISAO_ORDEM_SERVICO', 1005),
  -- C6/C7 banco SEM título: transferência entre contas / tarifa (fora do fluxo operacional)
  ('acme', CURRENT_DATE -  3, 'E',  250, 'CONTA_CORRENTE_REC',     NULL),
  ('acme', CURRENT_DATE -  3, 'S',  250, 'CONTA_CORRENTE_PAG',     NULL),
  -- C8 o mesmo pagamento nas duas óticas
  ('acme', CURRENT_DATE - 15, 'S',  800, 'CONTA_A_PAGAR',          2001),
  ('acme', CURRENT_DATE - 15, 'S',  800, 'CONTA_CORRENTE_PAG',     2001),
  -- C9 fora da janela de 90 dias
  ('acme', CURRENT_DATE - 120, 'E', 9999, 'CONTA_CORRENTE_REC',    1009),
  -- C10 título ABERTO na ótica do título (nValPago = 0) — a data mais recente da empresa
  ('acme', CURRENT_DATE -  1, 'E',    0, 'CONTA_A_RECEBER',        1010),
  -- B  outra empresa, mesmo desenho de duas óticas
  ('beta', CURRENT_DATE -  2, 'E',  100, 'CONTA_A_RECEBER',        3001),
  ('beta', CURRENT_DATE -  1, 'E',  100, 'CONTA_CORRENTE_REC',     3001),
  ('beta', CURRENT_DATE -  2, 'S',   40, 'CONTA_A_PAGAR',          4001),
  ('beta', CURRENT_DATE -  2, 'S',   40, 'CONTA_CORRENTE_PAG',     4001);
SQL
HOJE_MENOS_1="$(Pq -c "SELECT (CURRENT_DATE - 1)::text;")"
HOJE_MENOS_3="$(Pq -c "SELECT (CURRENT_DATE - 3)::text;")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS sobre o bloco REAL (esperados escritos à mão a partir do seed)
# ══════════════════════════════════════════════════════════════════════════════
echo "── bloco real da skill ──"
carrega "$BLOCO"
eq "A1 acme entradas = só banco com título (1000+1000+400+600)" "$(col entradas_caixa_90d acme)" "3000.00"
eq "A2 acme saídas = só banco com título"                       "$(col saidas_caixa_90d acme)"   "800.00"
eq "A3 acme fluxo líquido"                                       "$(col fluxo_liquido_90d acme)"  "2200.00"
eq "A4 acme movimentos (banco com título, na janela)"            "$(col movimentos acme)"         "5"
eq "A5 acme transferência/tarifa que ENTRA fica visível à parte" "$(col sem_titulo_entradas_90d acme)" "250.00"
eq "A6 acme transferência/tarifa que SAI fica visível à parte"   "$(col sem_titulo_saidas_90d acme)"   "250.00"
eq "A7 acme último movimento é o do BANCO"                       "$(col ultimo_movimento acme)"   "$HOJE_MENOS_3"
eq "A8 beta entradas/saídas/fluxo/movimentos independentes"      "$(col "entradas_caixa_90d::text || '/' || saidas_caixa_90d || '/' || fluxo_liquido_90d || '/' || movimentos" beta)" "100.00/40.00/60.00/2"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO: cada sabotagem tem de levar o assert ao número PREVISTO
# ══════════════════════════════════════════════════════════════════════════════
# A sabotagem é uma substituição de TEXTO sobre o bloco real. Se o texto não casar (o bloco
# mudou de forma), a sabotagem vira no-op e a falsificação perde o dente sem ninguém ver —
# por isso "não casou" é FALHA, não pulo.
sabota() { # <rótulo> <trecho-original> <trecho-sabotado>
  local sab="${BLOCO//"$2"/$3}"
  if [ "$sab" = "$BLOCO" ]; then
    bad "$1 — a sabotagem NÃO casou o texto do bloco; atualize a falsificação"
    return 1
  fi
  carrega "$sab"
}

echo "── F1 sem a allowlist de ótica: as duas óticas e as previsões somam ──"
if sabota "F1" "categoria_descricao IN ('CONTA_CORRENTE_REC', 'CONTA_CORRENTE_PAG')" "true"; then
  eq "F1 entradas vão a 7050 (a dobra)"  "$(col entradas_caixa_90d acme)" "7050.00"
  eq "F1 saídas vão a 1600 (a dobra)"    "$(col saidas_caixa_90d acme)"   "1600.00"
fi

echo "── F2 allowlist trocada por negação: PREVISÃO entra como caixa ──"
if sabota "F2" "categoria_descricao IN ('CONTA_CORRENTE_REC', 'CONTA_CORRENTE_PAG')" "categoria_descricao NOT LIKE 'CONTA_A_%'"; then
  eq "F2 entradas vão a 4000 (+700 +300 de previsão)" "$(col entradas_caixa_90d acme)" "4000.00"
fi

echo "── F3 sem o filtro de título: transferência/tarifa vira fluxo ──"
if sabota "F3" "(omie_codigo_lancamento IS NOT NULL)" "true"; then
  eq "F3 entradas vão a 3250"                 "$(col entradas_caixa_90d acme)"      "3250.00"
  eq "F3 a coluna à parte some (vira NULL)"   "$(col sem_titulo_entradas_90d acme)" "NULL"
fi

echo "── F4 'dedup' por título: as baixas parciais colapsam ──"
if sabota "F4" "FROM fin_movimentacoes" "FROM (SELECT DISTINCT ON (company, categoria_descricao, omie_codigo_lancamento) * FROM fin_movimentacoes ORDER BY company, categoria_descricao, omie_codigo_lancamento, valor DESC) m"; then
  eq "F4 entradas vão a 2600 (some a baixa de 400)" "$(col entradas_caixa_90d acme)" "2600.00"
fi

echo "── F5 o SQL de ANTES (retrato do bloco até 2026-09-10) ──"
carrega "$(cat <<'SQL'
SELECT company,
       round(sum(valor) FILTER (WHERE tipo = 'E')::numeric,2) AS entradas_caixa_90d,
       round(sum(valor) FILTER (WHERE tipo = 'S')::numeric,2) AS saidas_caixa_90d,
       round((sum(valor) FILTER (WHERE tipo = 'E')
            - sum(valor) FILTER (WHERE tipo = 'S'))::numeric,2) AS fluxo_liquido_90d,
       count(*)            AS movimentos,
       max(data_movimento) AS ultimo_movimento
FROM fin_movimentacoes
WHERE data_movimento >= CURRENT_DATE - interval '90 days'
GROUP BY company ORDER BY company;
SQL
)"
eq "F5 entradas de antes = 7300 (duas óticas + previsão + transferência)" "$(col entradas_caixa_90d acme)" "7300.00"
eq "F5 saídas de antes = 1850"                                          "$(col saidas_caixa_90d acme)"   "1850.00"
eq "F5 movimentos de antes = 14"                                        "$(col movimentos acme)"         "14"
eq "F5 último movimento de antes = o título aberto (hoje-1)"            "$(col ultimo_movimento acme)"   "$HOJE_MENOS_1"

# Controle final: o bloco real, recarregado, volta ao verde — prova que a restauração é
# real e que nenhuma sabotagem vazou para o estado final.
echo "── controle: bloco real de novo ──"
carrega "$BLOCO"
eq "C1 restauração: entradas voltam a 3000" "$(col entradas_caixa_90d acme)" "3000.00"
eq "C2 restauração: saídas voltam a 800"    "$(col saidas_caixa_90d acme)"   "800.00"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
