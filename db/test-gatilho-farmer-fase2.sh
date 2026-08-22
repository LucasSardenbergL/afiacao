#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — db/gatilho-farmer-fase2.sql (o VEREDITO, nao os insumos)            ║
# ║      bash db/test-gatilho-farmer-fase2.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
# ║  (NAO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                      ║
# ║                                                                               ║
# ║  O que se prova: um denominador produzido por UM UNICO ator nao vira          ║
# ║  conclusao populacional. O ramo `MONOUSUARIO` precede `ENCERRE` (universal,   ║
# ║  exige amostra) e NAO precede `DECIDA` (existencial, basta uma ocorrencia)    ║
# ║  nem `CONTAMINADO` (insumo furado invalida tudo antes).                       ║
# ║                                                                               ║
# ║  Roda o ARQUIVO REAL do gatilho — nunca uma transcricao dele: teste sobre     ║
# ║  copia aprova a copia, e a copia nao e o que o founder executa.               ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATILHO="$REPO_ROOT/db/gatilho-farmer-fase2.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5474}"
SLUG="gatilho-fase2"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$GATILHO" ] || { echo "gatilho ausente: $GATILHO"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# usado SO na falsificacao: espelha eq() mas com o veredito INVERTIDO (queremos vermelho).
eq_esperando_vermelho() {
  if [ "$2" = "$3" ]; then bad "FALSIFICACAO SEM DENTE: $1 continuou [$2] com o gatilho sabotado"
  else ok "falsificacao mordeu: $1 virou [$2] (integro seria [$3])"; fi
}

# ════════════════════════════════════════════════════════
# ZONA 1 — schema MINIMO, espelhando o de prod (medido via psql-ro em 21/08)
# ════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.farmer_geracao_execucoes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  motor          text NOT NULL,
  farmer_id      uuid NOT NULL,
  run_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  resultado      text NOT NULL,
  linhas_geradas integer NOT NULL DEFAULT 0,
  completude     text NOT NULL,
  motivo         text,
  insumos        jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculado_em   timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT farmer_geracao_execucoes_check CHECK (
    motor = ANY (ARRAY['cross_sell','bundle'])
    AND resultado = ANY (ARRAY['linhas','vazio'])
    AND completude = ANY (ARRAY['completo','degradado','desconhecido'])
  )
);
CREATE TABLE public.farmer_client_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL
);

-- Insumo "saudavel", com a forma EXATA que o gatilho exige de um vazio julgavel — medida
-- lendo a condicao de `vazios_completos`, nao suposta: cobertura declarada (senao cai em
-- `AGUARDE (cliente velho)`, que compartilha a 1a palavra com o `AGUARDE` generico e
-- mascararia qual ramo respondeu), `scores.n > 0` e `vendaveis.n > 0` (sem os dois o vazio
-- nao e julgavel e o ramo `DECIDA` nunca dispara), e nenhum n = 1000 (que acionaria o cap).
-- A 1a versao desta fixture omitia scores/vendaveis: o C5 reprovou e o defeito era AQUI.
CREATE FUNCTION fx(p_motor text, p_farmer uuid, p_n int DEFAULT 1, p_resultado text DEFAULT 'linhas',
                   p_insumos jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO public.farmer_geracao_execucoes (motor, farmer_id, resultado, linhas_geradas, completude, insumos)
  SELECT p_motor, p_farmer, p_resultado, CASE WHEN p_resultado='vazio' THEN 0 ELSE 3 END, 'completo',
         COALESCE(p_insumos, '{"carteira_com_historico_utilizavel": {"n": 42}, "scores": {"n": 87},
                       "vendaveis": {"n": 12}, "pedidos": {"n": 861}}'::jsonb)
  FROM generate_series(1, p_n);
END $f$;

CREATE FUNCTION carteira(p_quantos int) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO public.farmer_client_scores (farmer_id)
  SELECT ('00000000-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid
  FROM generate_series(1, p_quantos) g;
END $f$;

CREATE FUNCTION reset() RETURNS void LANGUAGE sql AS
  $f$ TRUNCATE public.farmer_geracao_execucoes, public.farmer_client_scores $f$;
SQL

A='00000000-0000-0000-0000-000000000001'   # farmer 1 (o unico executor, nos casos monousuario)
B='00000000-0000-0000-0000-000000000002'   # farmer 2

# Extrai a PALAVRA do veredito (ASCII, caixa fixa) do motor pedido, rodando o gatilho REAL.
# Corta no 1o token — 'SEM'/'ZERADO' levam o 2o junto porque o veredito deles tem duas palavras.
veredito() { # $1 = motor, $2 = arquivo do gatilho (default: o real)
  Pq -f "${2:-$GATILHO}" \
    | awk -F'|' -v m="$1" '$1==m {print $NF}' \
    | awk '{ if ($1=="SEM" || $1=="ZERADO") print $1" "$2; else print $1 }' \
    | tr -d '('
}

echo "=== setup pronto (PG17 :$PORT) ==="

# ════════════════════════════════════════════════════════
# ZONA 2 — o ramo novo: 1 ator nao e populacao
# ════════════════════════════════════════════════════════
echo "-- C1: 3 execucoes, 1 farmer, 3 com carteira -> MONOUSUARIO"
P -q -c "SELECT reset(); SELECT carteira(3); SELECT fx('cross_sell','$A',3);"
eq "C1 cross_sell" "$(veredito cross_sell)" "MONOUSUARIO"

echo "-- C2: mesmas 3 execucoes repartidas em 2 farmers -> NAO e monousuario"
P -q -c "SELECT reset(); SELECT carteira(3); SELECT fx('cross_sell','$A',2); SELECT fx('cross_sell','$B',1);"
eq "C2 cross_sell (2 atores)" "$(veredito cross_sell)" "AGUARDE"

echo "-- C3: 1 executor, mas a carteira TEM 1 farmer so — ele E a populacao, nao ha vies"
P -q -c "SELECT reset(); SELECT carteira(1); SELECT fx('cross_sell','$A',3);"
eq "C3 cross_sell (populacao=1)" "$(veredito cross_sell)" "AGUARDE"

# ════════════════════════════════════════════════════════
# ZONA 3 — ORDEM: o que o ramo novo pode e o que NAO pode atropelar
# ════════════════════════════════════════════════════════
echo "-- C4: 20 julgaveis de UM ator -> MONOUSUARIO vence ENCERRE (universal exige amostra)"
P -q -c "SELECT reset(); SELECT carteira(3); SELECT fx('cross_sell','$A',20);"
eq "C4 cross_sell (20 de 1 ator)" "$(veredito cross_sell)" "MONOUSUARIO"

echo "-- C5: existencia sobrevive — 1 vazio+completo COM cobertura, mesmo de 1 ator so"
P -q -c "SELECT reset(); SELECT carteira(3); SELECT fx('cross_sell','$A',1,'vazio');"
eq "C5 cross_sell (vazio julgavel)" "$(veredito cross_sell)" "DECIDA"

echo "-- C6: insumo furado continua acima de tudo — cap ATIVO com 1 ator so"
P -q -c "SELECT reset(); SELECT carteira(3); SELECT fx('cross_sell','$A',3);
         SELECT fx('cross_sell','$A',1,'linhas','{\"carteira_com_historico_utilizavel\": {\"n\": 42}, \"scores\": {\"n\": 87}, \"vendaveis\": {\"n\": 12}, \"pedidos\": {\"n\": 1000}}'::jsonb);"
eq "C6 cross_sell (cap ativo)" "$(veredito cross_sell)" "CONTAMINADO"

echo "-- C7: motor que nunca rodou continua aparecendo (ausente != zero)"
P -q -c "SELECT reset(); SELECT carteira(3); SELECT fx('cross_sell','$A',3);"
eq "C7 bundle (nunca rodou)" "$(veredito bundle)" "SEM DENOMINADOR"

# ════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICACAO: sem o ramo, o C4 encerra a linha com n=1
# ════════════════════════════════════════════════════════
# Sabota uma COPIA — o arquivo real nunca e tocado, entao nao ha restaurar() para falhar.
SABOTADO="$(mktemp "/tmp/gatilho-sabotado-XXXXXX.sql")"
python3 - "$GATILHO" "$SABOTADO" <<'PY'
import sys
ini = "    WHEN farmers = 1 AND farmers_com_carteira > 1 THEN"
fim = "    WHEN julgaveis >= 20 THEN"
s = open(sys.argv[1]).read()
a = s.index(ini); b = s.index(fim, a)
open(sys.argv[2], "w").write(s[:a] + s[b:])
PY
echo "-- C4': o MESMO fixture do C4, com o ramo MONOUSUARIO removido"
P -q -c "SELECT reset(); SELECT carteira(3); SELECT fx('cross_sell','$A',20);"
SAB="$(veredito cross_sell "$SABOTADO")"
eq_esperando_vermelho "C4 (20 de 1 ator)" "$SAB" "MONOUSUARIO"
eq "C4' sabotado encerra a linha com n=1" "$SAB" "ENCERRE"
rm -f "$SABOTADO"

echo "════════════════════════════════════"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
