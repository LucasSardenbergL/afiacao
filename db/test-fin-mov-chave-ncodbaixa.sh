#!/usr/bin/env bash
# PROVA PG17 com FALSIFICAÇÃO — chave da baixa = -nCodBaixa em fin_movimentacoes.
#   bash db/test-fin-mov-chave-ncodbaixa.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   PG_LOCALE=pt_BR.UTF-8 LC_ALL=pt_BR.UTF-8 bash db/test-fin-mov-chave-ncodbaixa.sh   (2º locale)
# Cobre: supabase/migrations/20261127000000_fin_mov_chave_ncodbaixa.sql
# Desenho do laço: cada caso roda num banco NOVO do mesmo cluster. O CONTROLE (migration intacta)
# roda NA MESMA invocação, antes das sabotagens, e tem de sair verde — senão aborta (sempre-vermelha
# aprovaria toda sabotagem). Sabotagens editam um ESPELHO em tmpdir, nunca supabase/migrations/.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5491}"
SLUG="fin-mov-chave-ncodbaixa"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
TMPD="$(dirname "$DATA")"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
PG_LOCALE="${PG_LOCALE:-C}"
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$PG_LOCALE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null

MIG="$REPO_ROOT/supabase/migrations/20261127000000_fin_mov_chave_ncodbaixa.sql"
[ -f "$MIG" ] || { echo "FALTA $MIG"; exit 2; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -q -tA "$@"; }
# SQLSTATE de um comando que DEVE falhar. Captura o CÓDIGO, não "falhou algo". VERBOSITY=sqlstate:
# o prefixo é localizado (ERROR/ERRO em pt_BR, #1483), o código não.
estado() {
  local out
  if out="$("$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$DB" -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -q -c "$1" 2>&1)"; then
    echo "NAO_FALHOU"
  else
    printf '%s\n' "$out" | sed -n 's/^[A-Z]*:  *\([0-9A-Z]\{5\}\)$/\1/p' | head -1
  fi
}

# Fixture: colunas de PROD que a migration toca (psql-ro 2026-11-26: omie_ncodmov bigint NOT NULL,
# UNIQUE(company, omie_ncodmov), omie_ncodbaixa bigint nullable).
semear() {
  P -q <<'SQL'
CREATE TABLE public.fin_movimentacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  omie_ncodmov bigint NOT NULL,
  omie_ncodbaixa bigint,
  categoria_descricao text,
  valor numeric,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT fin_movimentacoes_company_omie_ncodmov_key UNIQUE (company, omie_ncodmov)
);
INSERT INTO public.fin_movimentacoes (id, company, omie_ncodmov, omie_ncodbaixa, categoria_descricao, valor, updated_at) VALUES
 -- A: baixa única com hash ⇒ renomeia
 ('00000000-0000-0000-0000-0000000000a1','oben', 7001, 100,'CONTA_CORRENTE_REC', 62.47,'2026-10-01'),
 -- B: duas versões da mesma baixa ⇒ só a MAIS NOVA renomeia; a velha fica congelada
 ('00000000-0000-0000-0000-0000000000b1','oben', 7002, 200,'CONTA_CORRENTE_REC',398.50,'2026-10-20'),
 ('00000000-0000-0000-0000-0000000000b2','oben', 7003, 200,'CONTA_CORRENTE_REC',398.50,'2026-11-26'),
 -- C: edge nova chegou antes (já tem -300) + hash velho mais NOVO ⇒ a negativa vence, nada renomeia
 ('00000000-0000-0000-0000-0000000000c1','oben', -300, 300,'CONTA_CORRENTE_PAG',1502.40,'2026-11-01'),
 ('00000000-0000-0000-0000-0000000000c2','oben', 7004, 300,'CONTA_CORRENTE_PAG',1502.40,'2026-11-26'),
 -- D: sem nCodBaixa (ótica do título / avulso) ⇒ intocada
 ('00000000-0000-0000-0000-0000000000d1','oben', 7005, NULL,'CONTA_A_RECEBER',124.94,'2026-10-13'),
 -- E: mesmo nCodBaixa em OUTRA empresa ⇒ grupo próprio
 ('00000000-0000-0000-0000-0000000000e1','colacor', 7006, 100,'CONTA_CORRENTE_REC',10.00,'2026-10-01');
SQL
}

# Roda UM caso: banco novo, fixture, migration (arquivo $1), asserções. Imprime FAIL no fim.
caso() {
  local mig="$1" rotulo="$2"
  DB="t_$(date +%s%N | tail -c 9)_$RANDOM"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$DB"
  PASS=0; FAIL=0
  echo "── caso: $rotulo"
  semear
  if ! P -q --single-transaction -f "$mig" >"$TMPD/apply.log" 2>&1; then
    bad "M0 migration aplicou — $(grep -m1 -oE '(ERROR|ERRO):.*' "$TMPD/apply.log" | cut -c1-160)"
    echo "FAIL=$FAIL"; return 0
  fi
  ok "M0 migration aplicou"
  eq "Z0 lc_collate do cluster é o pedido" "$(Pq -c "SELECT datcollate FROM pg_database WHERE datname = current_database();")" "$PG_LOCALE"
  eq "T1 baixa única renomeada" "$(Pq -c "SELECT omie_ncodmov FROM fin_movimentacoes WHERE id='00000000-0000-0000-0000-0000000000a1'")" "-100"
  eq "T2 versão MAIS NOVA vira -200" "$(Pq -c "SELECT omie_ncodmov FROM fin_movimentacoes WHERE id='00000000-0000-0000-0000-0000000000b2'")" "-200"
  eq "T3 versão velha congelada (hash)" "$(Pq -c "SELECT omie_ncodmov FROM fin_movimentacoes WHERE id='00000000-0000-0000-0000-0000000000b1'")" "7002"
  eq "T3b versão congelada não aceita UPDATE (CHECK NOT VALID vale para escrita nova)" "$(estado "UPDATE fin_movimentacoes SET valor = valor WHERE id='00000000-0000-0000-0000-0000000000b1'")" "23514"
  eq "T4 negativa pré-existente vence o hash mais novo" "$(Pq -c "SELECT string_agg(omie_ncodmov::text, ',' ORDER BY id) FROM fin_movimentacoes WHERE omie_ncodbaixa=300")" "-300,7004"
  eq "T5 sem nCodBaixa intocada" "$(Pq -c "SELECT omie_ncodmov FROM fin_movimentacoes WHERE id='00000000-0000-0000-0000-0000000000d1'")" "7005"
  eq "T6 mesmo id em outra empresa: grupo próprio" "$(Pq -c "SELECT omie_ncodmov FROM fin_movimentacoes WHERE id='00000000-0000-0000-0000-0000000000e1'")" "-100"
  eq "T7 nada apagado" "$(Pq -c "SELECT count(*) FROM fin_movimentacoes")" "7"
  eq "T8 CHECK recusa hash com nCodBaixa (edge velha na janela)" "$(estado "INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodbaixa) VALUES ('oben', 8001, 400)")" "23514"
  eq "T9 CHECK recusa negativa sem nCodBaixa" "$(estado "INSERT INTO fin_movimentacoes (company, omie_ncodmov) VALUES ('oben', -9)")" "23514"
  eq "T10 CHECK recusa negativa de outro id" "$(estado "INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodbaixa) VALUES ('oben', -401, 400)")" "23514"
  eq "T11 CHECK recusa nCodBaixa <= 0" "$(estado "INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodbaixa) VALUES ('oben', 0, 0)")" "23514"
  eq "T12 UNIQUE: 2ª linha para a mesma baixa recusada" "$(estado "INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodbaixa) VALUES ('oben', -100, 100)")" "23505"
  P -q -c "INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodbaixa, valor) VALUES ('oben', -100, 100, 99)
           ON CONFLICT (company, omie_ncodmov) DO UPDATE SET valor = EXCLUDED.valor, updated_at = now();"
  eq "T13 upsert da edge nova atualiza a MESMA linha (UUID)" "$(Pq -c "SELECT id || '|' || valor FROM fin_movimentacoes WHERE company='oben' AND omie_ncodmov=-100")" "00000000-0000-0000-0000-0000000000a1|99"
  eq "T14 CHECK aceita baixa identificada nova" "$(Pq -c "INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodbaixa) VALUES ('oben', -500, 500) RETURNING omie_ncodmov")" "-500"
  eq "T15 CHECK aceita hash sem id" "$(Pq -c "INSERT INTO fin_movimentacoes (company, omie_ncodmov) VALUES ('oben', 8002) RETURNING omie_ncodmov")" "8002"
  if P -q --single-transaction -f "$mig" >"$TMPD/apply2.log" 2>&1; then ok "T16 idempotente (2ª aplicação passa)"; else bad "T16 idempotente — $(grep -m1 -oE '(ERROR|ERRO):.*' "$TMPD/apply2.log" | cut -c1-160)"; fi
  eq "T17 2ª aplicação não mexe" "$(Pq -c "SELECT string_agg(omie_ncodmov::text, ',' ORDER BY id) FROM fin_movimentacoes WHERE omie_ncodbaixa IN (200,300)")" "7002,-200,-300,7004"
  echo "FAIL=$FAIL PASS=$PASS"
}

# Caso que a migration TEM de recusar: id legado <= 0. Devolve "ABORTOU" ou "APLICOU".
caso_id_zero() {
  local mig="$1"
  DB="z_$(date +%s%N | tail -c 9)_$RANDOM"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$DB"
  semear
  P -q -c "INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodbaixa) VALUES ('oben', 7999, 0)"
  if P -q --single-transaction -f "$mig" >"$TMPD/apply-z.log" 2>&1; then echo "APLICOU"
  elif grep -q "omie_ncodbaixa <= 0" "$TMPD/apply-z.log"; then echo "ABORTOU"
  else echo "ABORTOU_POR_OUTRO_MOTIVO"; fi
}

falhas() { grep -o 'FAIL=[0-9]*' "$1" | tail -1 | cut -d= -f2; }

echo "═══ PG17 :$PORT, locale $PG_LOCALE ═══"
# CONTROLE — mesma invocação do laço; tem de ser verde.
caso "$MIG" "CONTROLE (intacta)" | tee "$TMPD/controle.log"
CTRL="$(falhas "$TMPD/controle.log")"
if [ "$CTRL" != "0" ] || ! grep -q "T17" "$TMPD/controle.log"; then echo "CONTROLE VERMELHO ($CTRL) — abortando antes de falsificar"; exit 1; fi

Z="$(caso_id_zero "$MIG")"
if [ "$Z" = "ABORTOU" ]; then echo "  ✅ T18 id legado <= 0 aborta a migration (=ABORTOU)"; else echo "  ❌ T18 id legado <= 0 — veio [$Z]"; exit 1; fi

SAB_OK=0; SAB_FAIL=0
sab() {
  local nome="$1" expr="$2" f="$TMPD/sab-$1.sql"
  sed "$expr" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then echo "  ❌ sabotagem $nome NÃO alterou o arquivo (sed sem efeito)"; SAB_FAIL=$((SAB_FAIL+1)); return; fi
  caso "$f" "SABOTAGEM $nome" > "$TMPD/sab-$nome.log" 2>&1 || true
  local n; n="$(falhas "$TMPD/sab-$nome.log")"
  if [ -n "$n" ] && [ "$n" -gt 0 ]; then echo "  ✅ sabotagem $nome ficou VERMELHA ($n falha(s): $(grep -m1 '❌' "$TMPD/sab-$nome.log" | cut -c1-120))"; SAB_OK=$((SAB_OK+1))
  else echo "  ❌ sabotagem $nome ficou VERDE"; SAB_FAIL=$((SAB_FAIL+1)); fi
}
echo "═══ falsificação ═══"
sab "sem-rename" 's/^   SET omie_ncodmov = -m.omie_ncodbaixa$/   SET omie_ncodmov = m.omie_ncodmov/'
sab "velha-vence" 's/m.updated_at DESC NULLS LAST, m.created_at DESC NULLS LAST, m.id DESC/m.updated_at ASC NULLS LAST, m.created_at ASC, m.id ASC/'
sab "negativa-nao-prioriza" 's/ORDER BY (m.omie_ncodmov = -m.omie_ncodbaixa) DESC,/ORDER BY/'
sab "check-valida-tudo" 's/^) NOT VALID;$/);/'
sab "check-frouxo" 's/OR (omie_ncodbaixa IS NOT NULL AND omie_ncodbaixa > 0 AND omie_ncodmov = -omie_ncodbaixa)/OR (omie_ncodbaixa IS NOT NULL)/'
sab "check-aceita-zero" 's/AND omie_ncodbaixa > 0 AND/AND/'
sedz="$TMPD/sab-sem-guarda.sql"; sed 's/omie_ncodbaixa IS NOT NULL AND omie_ncodbaixa <= 0;/false;/' "$MIG" > "$sedz"
if cmp -s "$sedz" "$MIG"; then echo "  ❌ sabotagem sem-guarda NÃO alterou o arquivo"; SAB_FAIL=$((SAB_FAIL+1));
elif [ "$(caso_id_zero "$sedz")" = "APLICOU" ]; then echo "  ✅ sabotagem sem-guarda ficou VERMELHA (id 0 passou)"; SAB_OK=$((SAB_OK+1));
else echo "  ❌ sabotagem sem-guarda ficou VERDE"; SAB_FAIL=$((SAB_FAIL+1)); fi
echo "═══ CONTROLE FAIL=$CTRL · sabotagens vermelhas=$SAB_OK verdes=$SAB_FAIL ═══"
[ "$SAB_FAIL" -eq 0 ] && [ "$SAB_OK" -eq 7 ] && echo "PROVA_OK"
