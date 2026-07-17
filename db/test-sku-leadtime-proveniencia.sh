#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — proveniência do leadtime (nid_receb + uq_sku_hist_tracking_sku_receb) ║
# ║  Migration: supabase/migrations/20260716230000_sku_leadtime_proveniencia.sql   ║
# ║  Spec:  docs/superpowers/specs/2026-07-16-leadtime-duplicacao-retencao-design.md║
# ║  Plano: docs/superpowers/plans/2026-07-16-leadtime-duplicacao-retencao.md       ║
# ║  bash db/test-sku-leadtime-proveniencia.sh > /tmp/t.log 2>&1; echo "exit=$?"   ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
#
# Por quê esta constraint (não simplificar): uma NFe pode cobrir vários pedidos. Com o
# item atribuído ao pedido dele (edge omie-sync-sku-items, Task 2), a unicidade antiga
# (tracking_id, sku_codigo_omie) passaria a significar "1 leadtime por (pedido, SKU)" —
# e ENTREGAS PARCIAIS (mesmo SKU do mesmo pedido em NFes distintas) colidiriam: a
# segunda sobrescreveria a primeira em SILÊNCIO. Duplicata infla; perda apaga. Por isso
# nid_receb entra na chave. NULLS NOT DISTINCT é obrigatório porque as linhas
# históricas (nid_receb NULL) precisam continuar deduplicando ENTRE SI — com o default
# (NULLS DISTINCT), duas linhas (tracking,sku,NULL) coexistiriam e a duplicata do
# histórico velho voltaria pela porta dos fundos.
set -euo pipefail

# ── arranque PG17 descartável (idêntico aos demais harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5483}"
SLUG="sku-leadtime-prov"
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

# ── base mínima do Supabase (não estritamente necessária p/ esta migration — que só
#    toca public.sku_leadtime_history — mas mantém o harness no formato padrão) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: schema MÍNIMO fiel ao estado PRÉ-migration
# ══════════════════════════════════════════════════════════════════════════════
# Só as colunas que a migration lê/altera + a constraint ANTIGA que ela substitui —
# para provar a transição real (DROP da antiga + ADD da nova), não assumir que a
# antiga já não existe. sku_codigo_omie/tracking_id/empresa espelham os tipos reais
# (schema-snapshot.sql); t1_data_pedido (NOT NULL em prod) fica de fora de propósito —
# a migration não a toca e os asserts do brief não a preenchem.
P -q <<'SQL'
CREATE TABLE public.sku_leadtime_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id uuid NOT NULL,
  empresa text NOT NULL,
  sku_codigo_omie bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sku_hist_tracking_sku UNIQUE (tracking_id, sku_codigo_omie)
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado, não um stub)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260716230000_sku_leadtime_proveniencia.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED — nenhum necessário (sem RLS/persona envolvidas; a migration só
# altera DDL de public.sku_leadtime_history, sem policy nova). Os próprios asserts
# semeiam as linhas que precisam.
# ══════════════════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS ESTRUTURAIS + OS 3 OBRIGATÓRIOS DO BRIEF (comportamento)
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts estruturais ──"

COL=$(Pq -c "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='sku_leadtime_history' AND column_name='nid_receb';")
eq "S1 coluna nid_receb existe (bigint)" "$COL" "bigint"

NEWC=$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conrelid='public.sku_leadtime_history'::regclass AND conname='uq_sku_hist_tracking_sku_receb';")
eq "S2 constraint nova uq_sku_hist_tracking_sku_receb existe" "$NEWC" "1"

OLDC=$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conrelid='public.sku_leadtime_history'::regclass AND conname='uq_sku_hist_tracking_sku';")
eq "S3 constraint antiga uq_sku_hist_tracking_sku foi removida" "$OLDC" "0"

# NULLS NOT DISTINCT vive no ÍNDICE que sustenta a constraint (pg_index.indnullsnotdistinct),
# não em pg_constraint — join por conindid.
NND=$(Pq -c "SELECT i.indnullsnotdistinct FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid WHERE c.conrelid='public.sku_leadtime_history'::regclass AND c.conname='uq_sku_hist_tracking_sku_receb';")
eq "S4 constraint nova e NULLS NOT DISTINCT" "$NND" "t"

echo "── asserts obrigatórios (brief, comportamento executando) ──"

# (1) entrega parcial COEXISTE: mesmo (tracking,sku), nid_receb distintos => 2 linhas
run_a1() {
P -tA 2>&1 <<'SQL'
INSERT INTO sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, nid_receb)
VALUES ('11111111-1111-1111-1111-111111111111','OBEN',1,100),
       ('11111111-1111-1111-1111-111111111111','OBEN',1,200);
DO $$ BEGIN
  IF (SELECT count(*) FROM sku_leadtime_history WHERE sku_codigo_omie=1) <> 2 THEN
    RAISE EXCEPTION 'FALHOU: entrega parcial deveria coexistir';
  END IF;
  RAISE NOTICE 'A1_OK';
END $$;
SQL
}
R1=$(run_a1) || true
case "$R1" in *A1_OK*) ok "A1 entrega parcial coexiste (2 linhas, nid_receb 100/200)" ;; *) bad "A1 entrega parcial — veio: $R1" ;; esac

# (2) irmãs deduplicam: mesmo (tracking,sku,nid_receb) => upsert colapsa em 1 (nao insere)
run_a2() {
P -tA 2>&1 <<'SQL'
INSERT INTO sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, nid_receb)
VALUES ('11111111-1111-1111-1111-111111111111','OBEN',1,100)
ON CONFLICT (tracking_id, sku_codigo_omie, nid_receb) DO UPDATE SET empresa=EXCLUDED.empresa;
DO $$ BEGIN
  IF (SELECT count(*) FROM sku_leadtime_history WHERE sku_codigo_omie=1) <> 2 THEN
    RAISE EXCEPTION 'FALHOU: irma deveria deduplicar, nao inserir';
  END IF;
  RAISE NOTICE 'A2_OK';
END $$;
SQL
}
R2=$(run_a2) || true
case "$R2" in *A2_OK*) ok "A2 irma deduplica via ON CONFLICT (upsert, nao insert)" ;; *) bad "A2 dedup — veio: $R2" ;; esac

# (3) NULLS NOT DISTINCT: linhas historicas (nid_receb NULL) ainda deduplicam entre si
run_a3() {
P -tA 2>&1 <<'SQL'
DO $$
BEGIN
  INSERT INTO sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, nid_receb)
  VALUES ('22222222-2222-2222-2222-222222222222','OBEN',2,NULL);
  BEGIN
    INSERT INTO sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, nid_receb)
    VALUES ('22222222-2222-2222-2222-222222222222','OBEN',2,NULL);
    RAISE EXCEPTION 'FALHOU: NULL duplicado passou — NULLS NOT DISTINCT nao esta valendo';
  EXCEPTION WHEN unique_violation THEN
    NULL;  -- esperado: captura a SQLSTATE especifica, re-lanca o resto (plpgsql: WHEN
           -- nao-listado propaga sozinho, dispensa WHEN OTHERS THEN RAISE explicito)
  END;
  RAISE NOTICE 'A3_OK';
END $$;
SQL
}
R3=$(run_a3) || true
case "$R3" in *A3_OK*) ok "A3 NULLS NOT DISTINCT: nid_receb NULL dedup entre si (2222.../sku 2)" ;; *) bad "A3 NULLS NOT DISTINCT — veio: $R3" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota a migração → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# ── F1: UNIQUE NULLS NOT DISTINCT → UNIQUE (default = NULLS DISTINCT) ──
# Expectativa (brief): assert (3) fica VERMELHO — duas linhas (2222...,2,NULL) deixam
# de ser consideradas duplicatas (NULL <> NULL sob NULLS DISTINCT) e ambas inserem.
P -q <<'SQL'
ALTER TABLE public.sku_leadtime_history
  DROP CONSTRAINT IF EXISTS uq_sku_hist_tracking_sku_receb;
ALTER TABLE public.sku_leadtime_history
  ADD CONSTRAINT uq_sku_hist_tracking_sku_receb
  UNIQUE (tracking_id, sku_codigo_omie, nid_receb);
SQL
R3S=$(run_a3) || true
case "$R3S" in
  *"FALHOU: NULL duplicado passou"*) ok "F1 sabotagem (NULLS DISTINCT) derruba A3 com a mensagem esperada" ;;
  *A3_OK*)                            bad "F1 sabotei NULLS NOT DISTINCT e A3 CONTINUOU verde — assert fraco" ;;
  *)                                  bad "F1 sabotagem — saida inesperada: $R3S" ;;
esac
# limpa o excedente que a sabotagem deixou (2a linha NULL) — senão o restore (NULLS NOT
# DISTINCT) falha ao validar dado existente que já viola a constraint correta.
P -q -c "DELETE FROM sku_leadtime_history WHERE tracking_id='22222222-2222-2222-2222-222222222222' AND sku_codigo_omie=2;" >/dev/null
P -q -f "$MIG" >/dev/null   # restaura a constraint real
echo "F1 restaurado"

# ── F2: chave (tracking_id, sku_codigo_omie) — nid_receb sai da unicidade ──
# Expectativa (brief): assert (1) fica VERMELHO — entrega parcial deixa de coexistir.
P -q -c "DELETE FROM sku_leadtime_history WHERE tracking_id='11111111-1111-1111-1111-111111111111';" >/dev/null   # senão o ADD CONSTRAINT abaixo falha contra o dado já existente (é ISSO que estamos provando, não um efeito colateral do seed anterior)
P -q <<'SQL'
ALTER TABLE public.sku_leadtime_history
  DROP CONSTRAINT IF EXISTS uq_sku_hist_tracking_sku_receb;
ALTER TABLE public.sku_leadtime_history
  ADD CONSTRAINT uq_sku_hist_tracking_sku_receb
  UNIQUE NULLS NOT DISTINCT (tracking_id, sku_codigo_omie);
SQL
R1S=$(run_a1) || true
case "$R1S" in
  *A1_OK*) bad "F2 sabotei a chave (sem nid_receb) e A1 CONTINUOU verde — assert fraco" ;;
  *)       ok "F2 sabotagem (chave sem nid_receb) derruba A1 — saida: $(printf '%s' "$R1S" | tail -1)" ;;
esac
P -q -c "DELETE FROM sku_leadtime_history WHERE tracking_id='11111111-1111-1111-1111-111111111111';" >/dev/null   # limpa o que a sabotagem deixou (0 ou 1 linha, dependendo de onde parou)
P -q -f "$MIG" >/dev/null   # restaura a constraint real
echo "F2 restaurado"

# ── verificação final: com as DUAS sabotagens revertidas, os 3 asserts voltam a valer ──
echo "── pós-restauração (confirma que a migration real, não a memória de um passo anterior, está ativa) ──"
R1F=$(run_a1) || true
case "$R1F" in *A1_OK*) ok "R1 pos-restore: A1 volta a passar" ;; *) bad "R1 pos-restore A1 — veio: $R1F" ;; esac
R2F=$(run_a2) || true
case "$R2F" in *A2_OK*) ok "R2 pos-restore: A2 volta a passar" ;; *) bad "R2 pos-restore A2 — veio: $R2F" ;; esac
R3F=$(run_a3) || true
case "$R3F" in *A3_OK*) ok "R3 pos-restore: A3 volta a passar" ;; *) bad "R3 pos-restore A3 — veio: $R3F" ;; esac

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
