#!/usr/bin/env bash
# PROVA — 20261104120000_hot_contas_pagar_sem_indice_carimbo.sql (plano v5, lote 11 — D1, só CP)
#
# Medido em 2026-11-04 (psql-ro): fin_contas_pagar tem 0 HOT em 140.777 updates — btree NA coluna de
# carimbo (updated_at) que o sync FULL regrava em toda linha, 2×/dia. A migration dropa o índice e põe
# fillfactor 80 (molde: 20261101222916, B2/B9). Esta prova sobe CP com o FORMATO da prod (colunas, saldo
# gerado, os 8 índices, nº de linhas por empresa, largura ~170 B), aquece com o estado de HOJE (ff100 +
# índice), aplica o ARQUIVO REAL e continua o ciclo do sync como a edge omie-financeiro o faz: upsert
# PostgREST (INSERT … ON CONFLICT (company, omie_codigo_lancamento) DO UPDATE SET <todas as colunas do
# payload> = EXCLUDED), 1 statement autocommit por página Omie de 100 títulos, em ordem de chave, empresa
# por empresa; VACUUM entre ciclos (na prod o autovacuum roda logo após o ciclo: last_autovacuum 08:02).
# Por ciclo, 20 títulos abertos viram de status (A VENCER → VENCE HOJE → ATRASADO, relativo ao dia, como a
# Omie devolve) — coluna indexada, update não-HOT legítimo, fica DENTRO do denominador.
# Os triggers trg_period_lock/trg_audit ficam fora: retornam na 1ª linha para service_role (o sync) e não
# tocam NEW. Cada ciclo começa com CHECKPOINT: na prod o ciclo de ~2,5 min cai depois de um checkpoint, e o
# WAL medido inclui as imagens de página inteira (FPI) — o número de laboratório não é previsão da prod,
# que se mede depois do apply. Cenário favorável declarado: sem snapshot longo segurando versões mortas.
# fin_contas_receber entra no template só para provar que a migration NÃO a toca (decisão medida: CR fica).
#
#   CTRL_HOT0   antes da migration, o HOT do ciclo é 0 (controle: o assert de HOT pode cair)
#   DENOM       todo ciclo medido tem n_tup_upd = nº de linhas (estatística publicada e completa)
#   HOT         depois, os 3 últimos de 8 ciclos têm HOT ≥ 98% (com a virada de status dentro)
#   WAL         o WAL do último ciclo cai para < 30% do ciclo de controle
#   HEAP        o heap não passa de +10% em NENHUM dos 8 ciclos (transição incluída; sem VACUUM FULL)
#   LINHA       toda linha tem o carimbo do último ciclo e os valores de negócio intactos (md5);
#               uma página NÃO confirmada mantém o carimbo anterior (a confirmação segue por linha)
#   MAX         max(updated_at) = carimbo do último ciclo — o que o _data_health_compute lê (26 h)
#   CR_INTACTO  fin_contas_receber segue com idx_fin_contas_receber_updated_at e sem reloptions
#   IDEMP       re-aplicar a migration é no-op (sem erro)
#   SQLEDITOR   o arquivo roda como 1 query multi-statement (transação implícita do SQL Editor)
#   NOWAIT      com CP ocupada, a migration aborta com 55P03 e NADA muda
#   ATOMICO     toda guarda abaixo, ao abortar, deixa o índice de CP e o fillfactor como estavam
#
# Falsificações (cópias da migration em $TMP — o repo nunca é tocado), depois do controle verde NA MESMA
# invocação. GUARDA (pós-condição intacta, a migration TEM de abortar com a marca do ramo):
#   G1 sem o DROP                                  → "POS: fin_contas_pagar.updated_at ainda indexada por idx_fin_contas_pagar_updated_at"
#   G2 fillfactor 90                               → "POS: fin_contas_pagar sem fillfactor=80"
#   G3 índice parcial novo com WHERE updated_at    → "ainda indexada por idx_z" (pg_depend, não indkey)
#   G4 índice novo com INCLUDE (updated_at)        → "ainda indexada por idx_i"
#   G5 índice de expressão sobre updated_at        → "ainda indexada por idx_e"
#   G6 nome do índice apontando para OUTRA tabela  → "PRE: idx_fin_contas_pagar_updated_at existe mas NAO e de fin_contas_pagar"
#                                                     (e o índice alheio sobrevive)
# CAUSA (pós-condição removida, a medição TEM de cair):
#   C1 sem o DROP                                  → HOT do último ciclo < 10%
#   C2 sem fillfactor (só o DROP)                  → algum dos 3 últimos ciclos < 98% (ping-pong parcial)
#
# Uso: db/test-hot-contas-pagar.sh  (PGPORT_TEST=<porta>)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5476}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-hotcp.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261104120000_hot_contas_pagar_sem_indice_carimbo.sql"
export LC_ALL=C LANG=C PGTZ=UTC

[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP -c autovacuum=off" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -q -A -t -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }

FALHAS=0
ok()   { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FALHAS=$((FALHAS + 1)); }

N_COLACOR=11902; N_SC=1007; N_OBEN=3413   # linhas por empresa na prod (psql-ro, 2026-11-04)
N=$((N_COLACOR + N_SC + N_OBEN))

# ── template: CP e CR com colunas e índices da prod, ff100 ────────────────────────────────────────────
PA -d postgres -c "CREATE DATABASE tpl"
PA -d tpl <<SQL >/dev/null
CREATE TABLE public.fin_contas_pagar (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, company text NOT NULL, omie_codigo_lancamento bigint NOT NULL,
  omie_codigo_cliente_fornecedor bigint, nome_fornecedor text, cnpj_cpf text, numero_documento text,
  numero_documento_fiscal text, data_emissao date, data_vencimento date, data_pagamento date, data_previsao date,
  valor_documento numeric DEFAULT 0, valor_pago numeric DEFAULT 0, valor_desconto numeric, valor_juros numeric,
  valor_multa numeric, saldo numeric GENERATED ALWAYS AS (valor_documento - COALESCE(valor_pago, (0)::numeric)) STORED,
  status_titulo text DEFAULT 'ABERTO', categoria_codigo text, categoria_descricao text, departamento text,
  centro_custo text, observacao text, omie_ncodcc bigint, codigo_barras text, tipo_documento text, id_origem text,
  metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX fin_contas_pagar_company_omie_codigo_lancamento_key ON public.fin_contas_pagar (company, omie_codigo_lancamento);
CREATE INDEX idx_fin_contas_pagar_updated_at ON public.fin_contas_pagar (updated_at);
CREATE INDEX idx_fin_cp_categoria ON public.fin_contas_pagar (company, categoria_codigo);
CREATE INDEX idx_fin_cp_company ON public.fin_contas_pagar (company);
CREATE INDEX idx_fin_cp_fornecedor ON public.fin_contas_pagar (company, omie_codigo_cliente_fornecedor);
CREATE INDEX idx_fin_cp_status ON public.fin_contas_pagar (company, status_titulo);
CREATE INDEX idx_fin_cp_vencimento ON public.fin_contas_pagar (company, data_vencimento);

CREATE TABLE public.fin_contas_receber (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, company text NOT NULL, omie_codigo_lancamento bigint NOT NULL,
  status_titulo text, updated_at timestamptz DEFAULT now(), UNIQUE (company, omie_codigo_lancamento));
CREATE INDEX idx_fin_contas_receber_updated_at ON public.fin_contas_receber (updated_at);
INSERT INTO public.fin_contas_receber (company, omie_codigo_lancamento, status_titulo)
SELECT 'oben', g, 'RECEBIDO' FROM generate_series(1, 500) g;

-- linhas com a largura e a distribuição da prod (pg_stats: ~170 B; ~6% abertos, o resto PAGO)
INSERT INTO public.fin_contas_pagar (company, omie_codigo_lancamento, omie_codigo_cliente_fornecedor, nome_fornecedor,
  cnpj_cpf, numero_documento, numero_documento_fiscal, data_emissao, data_vencimento, data_pagamento, data_previsao,
  valor_documento, valor_pago, status_titulo, categoria_codigo, categoria_descricao, id_origem, metadata, updated_at)
SELECT e.company, 9000000000 + g, 1000 + g % 860, '', '', 'D' || g, CASE WHEN g % 3 = 0 THEN NULL ELSE 'NF' || g END,
       date '2024-01-01' + g % 700, date '2024-02-01' + g % 700, NULL, date '2024-02-01' + g % 700,
       (g % 9973) / 3.0, 0, CASE WHEN g % 16 = 0 THEN 'A VENCER' ELSE 'PAGO' END,
       '2.01.' || lpad((g % 120)::text, 2, '0'), '', 'CPP',
       jsonb_build_object('parcela', '001/001', 'total_parcelas', 1), '2026-11-01 00:00+00'
  FROM (VALUES ('colacor', $N_COLACOR), ('colacor_sc', $N_SC), ('oben', $N_OBEN)) e(company, n),
       generate_series(1, e.n) g;
SQL

# Ciclo do sync: por empresa, páginas de 100 em ordem de chave, 1 statement autocommit por página (o
# upsert do PostgREST), payload com as colunas que a edge manda; 20 abertos viram de status. Depois VACUUM.
# $3 = nº de linhas de colacor a PULAR no começo (página não confirmada; 0 = nenhuma).
# Imprime <upd>|<hot> wal=<bytes> heap=<páginas>.
NL=$'\n'
ciclo() {
  local db="$1" stamp="$2" pula="${3:-0}" sql="" emp n ini off
  sql+="CHECKPOINT;${NL}"
  sql+="SELECT pg_stat_reset();${NL}"
  sql+="SELECT pg_current_wal_lsn() AS lsn0 \\gset${NL}"
  for emp in colacor:$N_COLACOR colacor_sc:$N_SC oben:$N_OBEN; do
    n="${emp#*:}"; emp="${emp%%:*}"; ini=0
    [ "$emp" = colacor ] && ini="$pula"
    for off in $(seq "$ini" 100 $((n - 1))); do
      sql+="INSERT INTO public.fin_contas_pagar AS t (company, omie_codigo_lancamento, omie_codigo_cliente_fornecedor,
  nome_fornecedor, cnpj_cpf, numero_documento, numero_documento_fiscal, data_emissao, data_vencimento, data_pagamento,
  data_previsao, valor_documento, valor_pago, status_titulo, categoria_codigo, categoria_descricao, departamento,
  centro_custo, observacao, omie_ncodcc, codigo_barras, tipo_documento, id_origem, metadata, updated_at)
SELECT company, omie_codigo_lancamento, omie_codigo_cliente_fornecedor, nome_fornecedor, cnpj_cpf, numero_documento,
       numero_documento_fiscal, data_emissao, data_vencimento, data_pagamento, data_previsao, valor_documento, valor_pago,
       CASE WHEN status_titulo <> 'PAGO' AND omie_codigo_lancamento % 50 = (extract(hour FROM timestamptz '$stamp')::int % 50)
            THEN CASE status_titulo WHEN 'A VENCER' THEN 'VENCE HOJE' WHEN 'VENCE HOJE' THEN 'ATRASADO' ELSE 'A VENCER' END
            ELSE status_titulo END,
       categoria_codigo, categoria_descricao, departamento, centro_custo, observacao, omie_ncodcc, codigo_barras,
       tipo_documento, id_origem, metadata, '$stamp'
  FROM public.fin_contas_pagar WHERE company = '$emp' ORDER BY omie_codigo_lancamento OFFSET $off LIMIT 100
ON CONFLICT (company, omie_codigo_lancamento) DO UPDATE SET
  omie_codigo_cliente_fornecedor = EXCLUDED.omie_codigo_cliente_fornecedor, nome_fornecedor = EXCLUDED.nome_fornecedor,
  cnpj_cpf = EXCLUDED.cnpj_cpf, numero_documento = EXCLUDED.numero_documento,
  numero_documento_fiscal = EXCLUDED.numero_documento_fiscal, data_emissao = EXCLUDED.data_emissao,
  data_vencimento = EXCLUDED.data_vencimento, data_pagamento = EXCLUDED.data_pagamento,
  data_previsao = EXCLUDED.data_previsao, valor_documento = EXCLUDED.valor_documento, valor_pago = EXCLUDED.valor_pago,
  status_titulo = EXCLUDED.status_titulo, categoria_codigo = EXCLUDED.categoria_codigo,
  categoria_descricao = EXCLUDED.categoria_descricao, departamento = EXCLUDED.departamento,
  centro_custo = EXCLUDED.centro_custo, observacao = EXCLUDED.observacao, omie_ncodcc = EXCLUDED.omie_ncodcc,
  codigo_barras = EXCLUDED.codigo_barras, tipo_documento = EXCLUDED.tipo_documento, id_origem = EXCLUDED.id_origem,
  metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at;${NL}"
    done
  done
  sql+="SELECT pg_current_wal_lsn() - :'lsn0'::pg_lsn AS wal \\gset${NL}"
  sql+="VACUUM public.fin_contas_pagar;${NL}"
  sql+="SELECT pg_stat_force_next_flush();${NL}"
  sql+="SELECT pg_stat_clear_snapshot();${NL}"
  sql+="SELECT n_tup_upd || '|' || n_tup_hot_upd || ' wal=' || :'wal' || ' heap=' || pg_relation_size('public.fin_contas_pagar') / 8192
  FROM pg_stat_user_tables WHERE relname = 'fin_contas_pagar';${NL}"
  PA -d "$db" <<<"$sql" | tail -1
}

upd()  { echo "${1%%|*}"; }
hot()  { local x="${1#*|}"; echo "${x%% *}"; }
pct()  { echo $(( $(hot "$1") * 1000 / $(upd "$1") )); }          # em décimos de %
walb() { local x="${1#*wal=}"; echo "${x%% *}"; }
heap() { echo "${1#*heap=}"; }
fmt()  { echo "$(( $1 / 10 )).$(( $1 % 10 ))%"; }

# Aquecimento com o estado de HOJE (ff100 + índice): 4 ciclos.
for c in 1 2 3 4; do L="$(ciclo tpl "2026-11-01 0$c:00+00")"; done
L_CTRL="$L"
echo "controle (ciclo 4, antes): $L_CTRL"
PA -d postgres -c "ALTER DATABASE tpl IS_TEMPLATE true" >/dev/null

echo "== CONTROLE =="
if [ "$(upd "$L_CTRL")" = "$N" ]; then ok "DENOM controle = $N"; else fail "DENOM controle: $L_CTRL"; fi
if [ "$(hot "$L_CTRL")" = "0" ]; then ok "CTRL_HOT0"; else fail "CTRL_HOT0: $L_CTRL"; fi
WAL_CTRL="$(walb "$L_CTRL")"; HEAP_CTRL="$(heap "$L_CTRL")"

# roda 8 ciclos pós-migration num db; imprime as linhas dos 3 últimos (c6 c7 c8), separadas por ';', e
# grava o maior heap dos 8 em $TMP/<db>.heapmax
ciclos_pos() {
  local db="$1" c L ult="" hmax=0
  for c in $(seq 1 8); do
    L="$(ciclo "$db" "2026-11-02 $(printf %02d "$c"):00+00")"; echo "    pos c$c: $L" >&2
    [ "$(heap "$L")" -gt "$hmax" ] && hmax="$(heap "$L")"
    [ "$c" -ge 6 ] && ult+="$L;"
  done
  echo "$hmax" >"$TMP/$db.heapmax"
  echo "${ult%;}"
}
# todos os 3 últimos com denominador cheio e HOT ≥ 98%? (imprime o pior em décimos de %)
pior_pct() { local l p m=1000; IFS=';' read -ra l <<<"$1"; for x in "${l[@]}"; do p="$(pct "$x")"; [ "$p" -lt "$m" ] && m="$p"; done; echo "$m"; }
denom_ok() { local l; IFS=';' read -ra l <<<"$1"; for x in "${l[@]}"; do [ "$(upd "$x")" = "$N" ] || return 1; done; }

echo "== MIGRATION REAL (transação implícita, como o SQL Editor) =="
PA -d postgres -c "CREATE DATABASE m TEMPLATE tpl"
if PA -d m -c "$(cat "$MIG")" >"$TMP/apply.log" 2>&1; then ok "SQLEDITOR aplica como 1 query"; else fail "SQLEDITOR: $(cat "$TMP/apply.log")"; fi
if PA -d m -c "$(cat "$MIG")" >"$TMP/apply2.log" 2>&1; then ok "IDEMP re-aplicar"; else fail "IDEMP: $(cat "$TMP/apply2.log")"; fi
U="$(ciclos_pos m)"
if denom_ok "$U"; then ok "DENOM pos = $N nos 3 ultimos"; else fail "DENOM pos: $U"; fi
P="$(pior_pct "$U")"
if [ "$P" -ge 980 ]; then ok "HOT pior dos 3 ultimos ciclos = $(fmt "$P")"; else fail "HOT pior dos 3 ultimos = $(fmt "$P") (< 98%)"; fi
L8="${U##*;}"
if [ $(( $(walb "$L8") * 100 )) -lt $(( WAL_CTRL * 30 )) ]; then ok "WAL ciclo: $WAL_CTRL -> $(walb "$L8") bytes"; else fail "WAL ciclo: $WAL_CTRL -> $(walb "$L8")"; fi
HMAX="$(cat "$TMP/m.heapmax")"
if [ $(( HMAX * 100 )) -le $(( HEAP_CTRL * 110 )) ]; then ok "HEAP $HEAP_CTRL -> max $HMAX paginas nos 8 ciclos"; else fail "HEAP cresceu: $HEAP_CTRL -> max $HMAX"; fi

# LINHA / MAX: valores de negócio intactos e carimbo do último ciclo em TODA linha
NEG="md5(string_agg(company||omie_codigo_lancamento||coalesce(omie_codigo_cliente_fornecedor::text,'')||numero_documento||coalesce(numero_documento_fiscal,'')||data_vencimento||valor_documento||saldo||categoria_codigo||metadata::text, ',' ORDER BY company, omie_codigo_lancamento))"
if [ "$(PA -d tpl -c "SELECT $NEG FROM public.fin_contas_pagar")" = "$(PA -d m -c "SELECT $NEG FROM public.fin_contas_pagar")" ]; then
  ok "LINHA valores de negocio intactos"; else fail "LINHA valores de negocio mudaram"; fi
R="$(PA -d m -c "SELECT count(*) FILTER (WHERE updated_at = '2026-11-02 08:00+00') || '|' || max(updated_at) FROM public.fin_contas_pagar")"
if [ "$R" = "$N|2026-11-02 08:00:00+00" ]; then ok "LINHA carimbo do ultimo ciclo em toda linha + MAX"; else fail "LINHA carimbo/MAX: $R"; fi
L="$(ciclo m "2026-11-02 09:00+00" 300)"
R="$(PA -d m -c "SELECT count(*) FILTER (WHERE updated_at = '2026-11-02 08:00+00') || '|' || count(*) FILTER (WHERE updated_at = '2026-11-02 09:00+00') || '|' || max(updated_at) FROM public.fin_contas_pagar")"
if [ "$R" = "300|$((N - 300))|2026-11-02 09:00:00+00" ]; then ok "LINHA pagina nao confirmada mantem o carimbo + MAX"; else fail "LINHA parcial/MAX: $R"; fi
R="$(PA -d m -c "SELECT (SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_fin_contas_receber_updated_at') || '|' || coalesce((SELECT reloptions::text FROM pg_class WHERE oid = 'public.fin_contas_receber'::regclass), 'null')")"
if [ "$R" = "1|null" ]; then ok "CR_INTACTO indice do carimbo e reloptions do CR"; else fail "CR_INTACTO: $R"; fi

echo "== NOWAIT: tabela ocupada aborta tudo =="
PA -d postgres -c "CREATE DATABASE l TEMPLATE tpl"
PA -d l -c "BEGIN; LOCK TABLE public.fin_contas_pagar IN ACCESS SHARE MODE; SELECT pg_sleep(8); COMMIT;" >/dev/null 2>&1 &
SEGURA=$!
for _ in $(seq 1 50); do
  [ "$(PA -d l -c "SELECT count(*) FROM pg_locks WHERE relation = 'public.fin_contas_pagar'::regclass AND granted AND pid <> pg_backend_pid()")" = "1" ] && break
  sleep 0.1
done
if PA -d l -v VERBOSITY=verbose -c "$(cat "$MIG")" >"$TMP/lock.log" 2>&1; then
  fail "NOWAIT: aplicou com a tabela ocupada"
elif grep -q '55P03' "$TMP/lock.log" &&
     [ "$(PA -d l -c "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_fin_contas_pagar_updated_at'") $(PA -d l -c "SELECT coalesce(reloptions::text, 'null') FROM pg_class WHERE oid = 'public.fin_contas_pagar'::regclass")" = "1 null" ]; then
  ok "NOWAIT 55P03 e a tabela intacta"
else fail "NOWAIT: $(cat "$TMP/lock.log")"; fi
wait "$SEGURA" || true

# ── Falsificações ─────────────────────────────────────────────────────────────────────────────────────
[ "$FALHAS" -eq 0 ] || { echo "CONTROLE VERMELHO ($FALHAS) — falsificacoes nao rodam"; exit 1; }

# estado de CP: <nº de índices de CP chamados idx_fin_contas_pagar_updated_at>|<reloptions>
estado_cp() { PA -d "$1" -c "SELECT (SELECT count(*) FROM pg_indexes WHERE tablename = 'fin_contas_pagar' AND indexname = 'idx_fin_contas_pagar_updated_at') || '|' || coalesce((SELECT reloptions::text FROM pg_class WHERE oid = 'public.fin_contas_pagar'::regclass), 'null')"; }
guarda() {   # $1 nome · $2 arquivo mutante · $3 marca esperada no erro · $4 SQL de preparo (opcional)
  PA -d postgres -c "CREATE DATABASE $1 TEMPLATE tpl"
  [ -n "${4:-}" ] && PA -d "$1" -c "$4" >/dev/null
  local antes; antes="$(estado_cp "$1")"
  if PA -d "$1" -c "$(cat "$2")" >"$TMP/$1.log" 2>&1; then fail "$1: mutante APLICOU"
  elif ! grep -qF "$3" "$TMP/$1.log"; then fail "$1 abortou por outro motivo: $(cat "$TMP/$1.log")"
  elif [ "$(estado_cp "$1")" != "$antes" ]; then fail "$1 abortou mas NAO desfez: $antes -> $(estado_cp "$1")"
  else ok "$1 abortou e ATOMICO ($antes): $3"; fi
}
sem_pos() { sed '/^DO \$post\$/,$d' "$1"; }

sed '/^DROP INDEX IF EXISTS public.idx_fin_contas_pagar_updated_at;/d' "$MIG" >"$TMP/g1.sql"
guarda g1 "$TMP/g1.sql" "POS: fin_contas_pagar.updated_at ainda indexada por idx_fin_contas_pagar_updated_at"
sed 's/^ALTER TABLE public.fin_contas_pagar SET (fillfactor = 80);/ALTER TABLE public.fin_contas_pagar SET (fillfactor = 90);/' "$MIG" >"$TMP/g2.sql"
guarda g2 "$TMP/g2.sql" "POS: fin_contas_pagar sem fillfactor=80"
awk '/^DO \$post\$$/ { print "CREATE INDEX idx_z ON public.fin_contas_pagar (company) WHERE updated_at IS NOT NULL;" } { print }' "$MIG" >"$TMP/g3.sql"
guarda g3 "$TMP/g3.sql" "POS: fin_contas_pagar.updated_at ainda indexada por idx_z"
awk '/^DO \$post\$$/ { print "CREATE INDEX idx_i ON public.fin_contas_pagar (company) INCLUDE (updated_at);" } { print }' "$MIG" >"$TMP/g4.sql"
guarda g4 "$TMP/g4.sql" "POS: fin_contas_pagar.updated_at ainda indexada por idx_i"
awk '/^DO \$post\$$/ { print "CREATE INDEX idx_e ON public.fin_contas_pagar ((updated_at AT TIME ZONE '"'"'UTC'"'"'));" } { print }' "$MIG" >"$TMP/g5.sql"
guarda g5 "$TMP/g5.sql" "POS: fin_contas_pagar.updated_at ainda indexada por idx_e"
guarda g6 "$MIG" "PRE: idx_fin_contas_pagar_updated_at existe mas NAO e de fin_contas_pagar" \
  "DROP INDEX public.idx_fin_contas_pagar_updated_at; CREATE INDEX idx_fin_contas_pagar_updated_at ON public.fin_contas_receber (status_titulo)"
if [ "$(PA -d g6 -c "SELECT count(*) FROM pg_indexes WHERE tablename = 'fin_contas_receber' AND indexname = 'idx_fin_contas_pagar_updated_at'")" = "1" ]; then
  ok "G6 o indice alheio sobreviveu"; else fail "G6 o DROP derrubou o indice de OUTRA tabela"; fi

echo "== CAUSA (sem pos-condicao) =="
sem_pos "$MIG" | sed '/^DROP INDEX IF EXISTS public.idx_fin_contas_pagar_updated_at;/d' >"$TMP/c1.sql"
PA -d postgres -c "CREATE DATABASE c1 TEMPLATE tpl"; PA -d c1 -c "$(cat "$TMP/c1.sql")" >/dev/null
U="$(ciclos_pos c1 2>/dev/null)"; P="$(pct "${U##*;}")"
if denom_ok "$U" && [ "$P" -lt 100 ]; then ok "C1 sem DROP: HOT do ultimo ciclo = $(fmt "$P")"; else fail "C1 nao caiu: $U"; fi
sem_pos "$MIG" | sed '/^ALTER TABLE public.fin_contas_pagar SET (fillfactor = 80);/d' >"$TMP/c2.sql"
PA -d postgres -c "CREATE DATABASE c2 TEMPLATE tpl"; PA -d c2 -c "$(cat "$TMP/c2.sql")" >/dev/null
U="$(ciclos_pos c2 2>/dev/null)"; P="$(pior_pct "$U")"
if denom_ok "$U" && [ "$P" -lt 980 ]; then ok "C2 sem fillfactor: pior dos 3 ultimos = $(fmt "$P") ($U)"; else fail "C2 nao caiu: $U"; fi

if [ "$FALHAS" -eq 0 ]; then echo "PROVA OK — test-hot-contas-pagar"; else echo "PROVA FALHOU ($FALHAS)"; exit 1; fi
