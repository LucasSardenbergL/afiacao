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
# Histórico: docs/historico/cfo-caixa-90d-somava-as-duas-oticas.md
#
# O que se prova — cada item com a sabotagem que o deixa VERMELHO e o número previsto
# (entradas operacionais da acme: 3090 no bloco real):
#   A1-A4  só a ótica bancária entra                  ← F1 sem allowlist (→ 7250) · F5 o SQL de antes (→ 7500)
#   A1     allowlist POSITIVA e EXATA                 ← F2 negação (→ 4150) · F2b prefixo (→ 3150)
#                                                     ← F2c "… OR categoria IS NULL" (→ 3140)
#   A1     baixas parciais do mesmo título SOMAM      ← F4 "dedup" por título (→ 2690)
#   A1     a janela é de 90 dias, fronteira incluída  ← F7 89 dias (→ 3000)
#   A2     convenção de sinal: S é saída (|valor|)    ← F6 sem o abs (saídas 830 → 770)
#   A5-A6  sem título fica FORA do operacional, mas   ← F3 sem o filtro de título (→ 3340)
#          VISÍVEL, cada tipo na sua coluna           ← F8 a coluna de saída soma entrada (70 → 250)
#   A8     a liquidez por CNPJ soma o banco INTEIRO   ← F9 o total só com título (2440 → 2260)
#   A7     o último movimento é o do BANCO            ← F5 (hoje-3 → hoje-1, o título aberto)
#   A9-A10 as empresas não se misturam
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
aborta() { echo "RESULTADO: $PASS ok / $FAIL fail"; echo "❌ HARNESS VERMELHO"; exit 1; }

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

# Fail-closed na extração: cada cabeçalho aparece UMA vez e na ordem certa. Renomear o "(d)"
# faria o recorte engolir os blocos seguintes; duplicar o "(c)" faria medir o bloco errado.
N_INI="$(awk '/^-- \(c\) /{n++} END{print n+0}' "$SKILL_SQL")"
N_FIM="$(awk '/^-- \(d\) /{n++} END{print n+0}' "$SKILL_SQL")"
L_INI="$(awk '/^-- \(c\) /{print NR; exit}' "$SKILL_SQL")"
L_FIM="$(awk '/^-- \(d\) /{print NR; exit}' "$SKILL_SQL")"
BLOCO="$(awk '/^-- \(c\) /{f=1} /^-- \(d\) /{f=0} f' "$SKILL_SQL")"
if [ "$N_INI" = "1" ] && [ "$N_FIM" = "1" ] && [ "$L_INI" -lt "$L_FIM" ] \
   && printf '%s' "$BLOCO" | grep -q 'FROM fin_movimentacoes'; then
  ok "A0 bloco (c) extraído entre marcadores únicos e em ordem (linhas $L_INI..$L_FIM)"
else
  bad "A0 extração inválida — '-- (c) ' ×$N_INI, '-- (d) ' ×$N_FIM; o recorte não é o bloco (c)"
  aborta
fi

# (Re)cria a view `bloco_c` com o SQL dado. O `;` final sai para caber no CREATE VIEW.
# Cada sabotagem parte de uma cópia NOVA do bloco real (nada vaza de uma para a outra).
# O retorno é explícito: chamada dentro de `if`, a função roda com o `set -e` suspenso.
carrega() {
  P -q -c "DROP VIEW IF EXISTS bloco_c;" || return 1
  printf 'CREATE VIEW bloco_c AS\n%s;\n' "${1%;*}" | P -q -f - || return 1
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
  -- C6/C7 banco SEM título: transferência / tarifa — valores ASSIMÉTRICOS de propósito, para
  -- uma coluna que somasse o tipo errado não coincidir com a certa
  ('acme', CURRENT_DATE -  3, 'E',  250, 'CONTA_CORRENTE_REC',     NULL),
  ('acme', CURRENT_DATE -  3, 'S',   70, 'CONTA_CORRENTE_PAG',     NULL),
  -- C8 o mesmo pagamento nas duas óticas
  ('acme', CURRENT_DATE - 15, 'S',  800, 'CONTA_A_PAGAR',          2001),
  ('acme', CURRENT_DATE - 15, 'S',  800, 'CONTA_CORRENTE_PAG',     2001),
  -- C9 muito fora da janela
  ('acme', CURRENT_DATE - 120, 'E', 9999, 'CONTA_CORRENTE_REC',    1009),
  -- C10 título ABERTO na ótica do título (nValPago = 0) — a data mais recente da empresa
  ('acme', CURRENT_DATE -  1, 'E',    0, 'CONTA_A_RECEBER',        1010),
  -- C11/C12 a FRONTEIRA da janela: hoje-90 entra, hoje-91 não
  ('acme', CURRENT_DATE - 90, 'E',   90, 'CONTA_CORRENTE_REC',     1011),
  ('acme', CURRENT_DATE - 91, 'E', 5000, 'CONTA_CORRENTE_REC',     1012),
  -- C13 ótica AUSENTE (categoria nula) com título — não se sabe o que é, fica fora
  ('acme', CURRENT_DATE -  4, 'E',   50, NULL,                     1013),
  -- C14 ótica DESCONHECIDA com o prefixo bancário — allowlist exata, não por prefixo
  ('acme', CURRENT_DATE -  4, 'E',   60, 'CONTA_CORRENTE_TRF',     1014),
  -- C15 valor NEGATIVO numa saída: S é saída qualquer que seja o sinal (espelha o
  -- Math.abs do helper do produto). Zero negativos na PROD hoje — é cobertura defensiva.
  ('acme', CURRENT_DATE -  6, 'S',  -30, 'CONTA_CORRENTE_PAG',     2015),
  -- B  outra empresa, mesmo desenho, com uma tarifa sem título
  ('beta', CURRENT_DATE -  2, 'E',  100, 'CONTA_A_RECEBER',        3001),
  ('beta', CURRENT_DATE -  1, 'E',  100, 'CONTA_CORRENTE_REC',     3001),
  ('beta', CURRENT_DATE -  2, 'S',   40, 'CONTA_A_PAGAR',          4001),
  ('beta', CURRENT_DATE -  2, 'S',   40, 'CONTA_CORRENTE_PAG',     4001),
  ('beta', CURRENT_DATE -  2, 'S',   15, 'CONTA_CORRENTE_PAG',     NULL);
SQL
HOJE_MENOS_1="$(Pq -c "SELECT (CURRENT_DATE - 1)::text;")"
HOJE_MENOS_3="$(Pq -c "SELECT (CURRENT_DATE - 3)::text;")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS sobre o bloco REAL (esperados escritos à mão a partir do seed)
# ══════════════════════════════════════════════════════════════════════════════
echo "── bloco real da skill ──"
carrega "$BLOCO" || { bad "A0b o bloco real NÃO carregou como view"; aborta; }
eq "A1 acme entradas = banco com título (1000+1000+400+600+90)" "$(col entradas_caixa_90d acme)"            "3090.00"
eq "A2 acme saídas = banco com título (800 + |−30|)"            "$(col saidas_caixa_90d acme)"              "830.00"
eq "A3 acme fluxo líquido operacional"                           "$(col fluxo_liquido_90d acme)"             "2260.00"
eq "A4 acme movimentos (banco com título, na janela)"            "$(col movimentos acme)"                    "7"
eq "A5 acme sem título que ENTRA, à parte"                       "$(col sem_titulo_entradas_90d acme)"       "250.00"
eq "A6 acme sem título que SAI, à parte"                         "$(col sem_titulo_saidas_90d acme)"         "70.00"
eq "A7 acme último movimento é o do BANCO"                       "$(col ultimo_movimento acme)"              "$HOJE_MENOS_3"
eq "A8 acme liquidez = banco inteiro ((3090+250) − (830+70))"   "$(col fluxo_liquido_banco_total_90d acme)" "2440.00"
eq "A9 beta operacional independente (E/S/fluxo/movimentos)"     "$(col "entradas_caixa_90d::text || '/' || saidas_caixa_90d || '/' || fluxo_liquido_90d || '/' || movimentos" beta)" "100.00/40.00/60.00/2"
eq "A10 beta sem título e liquidez (tarifa de 15)"               "$(col "coalesce(sem_titulo_entradas_90d::text, 'NULL') || '/' || sem_titulo_saidas_90d || '/' || fluxo_liquido_banco_total_90d" beta)" "NULL/15.00/45.00"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO: cada sabotagem tem de levar o assert ao número PREVISTO
# ══════════════════════════════════════════════════════════════════════════════
# A sabotagem é uma substituição de TEXTO sobre o bloco real. Se o texto não casar (o bloco
# mudou de forma), a sabotagem vira no-op e a falsificação perde o dente sem ninguém ver —
# por isso "não casou" é FALHA, não pulo. Idem "não carregou": sem isso, os asserts da
# sabotagem seriam pulados em silêncio e a prova sairia verde com menos asserts.
# A substituição NÃO leva aspas no 3º termo: há bash que as preserva literalmente (medido aqui:
# `true` virava `"true"`, um identificador). E o `patsub_replacement` (bash ≥ 5.2) faria um `&`
# da substituição virar o texto casado — desligado para o trecho sabotado valer como escrito.
shopt -u patsub_replacement 2>/dev/null || true
sabota() { # <rótulo> <trecho-original> <trecho-sabotado>
  local sab="${BLOCO//"$2"/$3}"
  if [ "$sab" = "$BLOCO" ]; then
    bad "$1 — a sabotagem NÃO casou o texto do bloco; atualize a falsificação"
    return 1
  fi
  if ! carrega "$sab"; then
    bad "$1 — o SQL sabotado NÃO carregou; a falsificação não mediu nada"
    return 1
  fi
}
ALLOW="categoria_descricao IN ('CONTA_CORRENTE_REC', 'CONTA_CORRENTE_PAG')"

echo "── F1 sem a allowlist de ótica: as duas óticas e as previsões somam ──"
if sabota "F1" "$ALLOW" "true"; then
  eq "F1 entradas vão a 7250 (a dobra)" "$(col entradas_caixa_90d acme)" "7250.00"
  eq "F1 saídas vão a 1630 (a dobra)"   "$(col saidas_caixa_90d acme)"   "1630.00"
fi

echo "── F2 allowlist trocada por negação: PREVISÃO e ótica desconhecida entram ──"
if sabota "F2" "$ALLOW" "categoria_descricao NOT LIKE 'CONTA_A_%'"; then
  eq "F2 entradas vão a 4150 (+700 +300 de previsão, +60 desconhecida)" "$(col entradas_caixa_90d acme)" "4150.00"
fi

echo "── F2b allowlist por PREFIXO: a ótica desconhecida CONTA_CORRENTE_TRF entra ──"
if sabota "F2b" "$ALLOW" "categoria_descricao LIKE 'CONTA_CORRENTE%'"; then
  eq "F2b entradas vão a 3150 (+60)" "$(col entradas_caixa_90d acme)" "3150.00"
fi

echo "── F2c allowlist alargada com '… OR categoria IS NULL' (o literal original SOBREVIVE) ──"
if sabota "F2c" "$ALLOW" "($ALLOW OR categoria_descricao IS NULL)"; then
  eq "F2c entradas vão a 3140 (+50 de ótica ausente)" "$(col entradas_caixa_90d acme)" "3140.00"
fi

echo "── F3 sem o filtro de título: transferência/tarifa vira fluxo operacional ──"
if sabota "F3" "(omie_codigo_lancamento IS NOT NULL)" "true"; then
  eq "F3 entradas vão a 3340"                 "$(col entradas_caixa_90d acme)"      "3340.00"
  eq "F3 a coluna à parte some (vira NULL)"   "$(col sem_titulo_entradas_90d acme)" "NULL"
fi

echo "── F4 'dedup' por título: as baixas parciais colapsam ──"
if sabota "F4" "FROM fin_movimentacoes" "FROM (SELECT DISTINCT ON (company, categoria_descricao, omie_codigo_lancamento) * FROM fin_movimentacoes ORDER BY company, categoria_descricao, omie_codigo_lancamento, valor DESC) m"; then
  eq "F4 entradas vão a 2690 (some a baixa de 400)" "$(col entradas_caixa_90d acme)" "2690.00"
fi

echo "── F6 sem o abs: a saída negativa abate em vez de somar ──"
if sabota "F6" "abs(valor)" "valor"; then
  eq "F6 saídas vão a 770 (800 − 30)" "$(col saidas_caixa_90d acme)" "770.00"
fi

echo "── F7 janela de 89 dias: a fronteira (hoje-90) cai fora ──"
if sabota "F7" "interval '90 days'" "interval '89 days'"; then
  eq "F7 entradas vão a 3000 (−90)" "$(col entradas_caixa_90d acme)" "3000.00"
fi

echo "── F8 a coluna de saída sem título soma ENTRADA ──"
if sabota "F8" "NOT com_titulo AND tipo = 'S'" "NOT com_titulo AND tipo = 'E'"; then
  eq "F8 sem_titulo_saidas vai a 250" "$(col sem_titulo_saidas_90d acme)" "250.00"
fi

echo "── F9 a liquidez por CNPJ calculada só com título (esquece transferência/tarifa) ──"
if sabota "F9" " AS fluxo_liquido_banco_total_90d" " AS total_verdadeiro_renomeado, round((sum(valor) FILTER (WHERE com_titulo AND tipo = 'E') - sum(valor) FILTER (WHERE com_titulo AND tipo = 'S'))::numeric,2) AS fluxo_liquido_banco_total_90d"; then
  eq "F9 liquidez vai a 2260 (= o operacional)" "$(col fluxo_liquido_banco_total_90d acme)" "2260.00"
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
)" || { bad "F5 o SQL de antes NÃO carregou"; aborta; }
eq "F5 entradas de antes = 7500 (duas óticas + previsão + transferência)" "$(col entradas_caixa_90d acme)" "7500.00"
eq "F5 saídas de antes = 1640"                                          "$(col saidas_caixa_90d acme)"   "1640.00"
eq "F5 movimentos de antes = 18"                                        "$(col movimentos acme)"         "18"
eq "F5 último movimento de antes = o título aberto (hoje-1)"            "$(col ultimo_movimento acme)"   "$HOJE_MENOS_1"

# Controle final: o bloco real, recarregado, volta ao verde — prova que a restauração é
# real e que nenhuma sabotagem vazou para o estado final.
echo "── controle: bloco real de novo ──"
carrega "$BLOCO" || { bad "C0 o bloco real NÃO recarregou"; aborta; }
eq "C1 restauração: entradas voltam a 3090" "$(col entradas_caixa_90d acme)"            "3090.00"
eq "C2 restauração: saídas voltam a 830"    "$(col saidas_caixa_90d acme)"              "830.00"
eq "C3 restauração: liquidez volta a 2440"  "$(col fluxo_liquido_banco_total_90d acme)" "2440.00"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
