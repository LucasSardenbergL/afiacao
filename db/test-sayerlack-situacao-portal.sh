#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261108120000_sayerlack_situacao_portal_no_pedido.sql (Onda 5A, fatia 1)
# ║      bash db/test-sayerlack-situacao-portal.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-sayerlack-situacao-portal.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sayerlack-situacao-portal.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║   W  escritor: só código 1..7 grava (ilegível nunca apaga um 6), repetido no lote é ambíguo, leitura
# ║      sobreposta só entra dizendo 6, só leitura iniciada DEPOIS do fim da vigente libera, protocolo novo
# ║      substitui o anterior, intervalo inválido = 22023, só OBEN.
# ║   T  escritor ÚNICO: UPDATE/INSERT direto nas colunas (staff tem UPDATE pela RLS) = 42501.
# ║   C  claim: 6 bloqueia (mesmo com protocolo trocado), pendência aberta é devolvida (conciliação por
# ║      consulta), sem observação e código ≠ 6 disparam.
# ║   R  CORRIDA, 2 conexões, bloqueio OBSERVADO (pg_blocking_pids) nas duas ordens gravar × claim.
# ║   A  ACL: escritor e claim fechados para anon/authenticated, abertos para service_role.
# ║  Diário: docs/historico/importar-pedido-portal-sayerlack.md
# ╚═════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5691}"
SLUG="sayerlack-situacao-portal"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C; o idioma do SERVIDOR vem de $LOC
MIG_REAL="$REPO_ROOT/supabase/migrations/20261108120000_sayerlack_situacao_portal_no_pedido.sql"
[ -f "$MIG_REAL" ] || { echo "INFRA: ausente: $MIG_REAL"; exit 1; }

# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e
# cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA, (3) o assert declarado estava verde
# no controle e virou vermelho, (4) sem ERRO de SQL que o controle não tem. Uma camada por vez: as
# sabotagens de COMPORTAMENTO desligam também a postcondição que as pegaria (senão mediriam a POS).
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="claim_sem_veto:C1,C4,R2 claim_veto_por_protocolo:C4 sem_trigger:T1,T2 sobreposta_libera:W7
              ilegivel_grava:W3 sem_ordem:W5 qualquer_empresa:W10 seis_nao_estende:W15 sem_trava_protocolo:W17,W18 protocolo_fura_ordem:W19 pos_claim_sem_dente:POS=S7 pos_trigger_sem_dente:POS=S2 pos_trava_sem_dente:POS=S9"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    # Sabotagem da POSTCONDIÇÃO: o vermelho certo é a migration ABORTAR com a marca dela (A1), não um assert.
    case "$exigidos" in POS=*)
      marca="${exigidos#POS=}"
      if grep -q 'SABOTAGEM ATIVA em ' "$log" && grep -q "ERROR:  $marca FALHOU" "$log" && grep -Eq '^  ❌ A1 ' "$log"; then
        echo "  ✅ $sab — a postcondição abortou a migration com $marca"
      else
        echo "  ❌ $sab — a postcondição NÃO abortou com $marca"; falhas=$((falhas+1))
      fi
      continue ;;
    esac
    vermelhos="$(grep -Eo '^  ❌ [A-Z][0-9]+ ' "$log" | grep -Eo '[A-Z][0-9]+' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão ocorre|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de SQL ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou:$faltam · vermelhos: ${vermelhos:-nenhum}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# SETUP
# ══════════════════════════════════════════════════════════════════
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
BGPIDS=""
cleanup() {
  for p in $BGPIDS; do kill "$p" 2>/dev/null || true; done
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone='UTC';" >/dev/null
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA -q -v VERBOSITY=verbose "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
sqlstate() { local s; s="$(grep -o -E '^[A-Z]+:  [0-9A-Z]{5}' | grep -o -E '[0-9A-Z]{5}$' | head -1 || true)"; printf '%s' "${s:-SEM_SQLSTATE}"; }
trocar() {  # $1 arquivo, $2 de, $3 para — o padrão tem de ocorrer exatamente 1×
  python3 -I - "$1" "$2" "$3" <<'PYSAB'
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, 'w', encoding='utf-8').write(s.replace(de, para))
PYSAB
}

# ── Sabotagem (no modo normal, SABOTAGEM vazia = a migration real) ──
MIG="$TMP/migration.sql"
cp "$MIG_REAL" "$MIG"
SAB="${SABOTAGEM:-}"
sab_pos_claim() { trocar "$MIG" "  IF v_up NOT LIKE '%AND portal_situacao_codigo IS DISTINCT FROM ''6''%' THEN" "  IF false THEN"; }
case "$SAB" in
  "") ;;
  claim_sem_veto)
    trocar "$MIG" "     AND portal_situacao_codigo IS DISTINCT FROM '6'
  RETURNING status" "  RETURNING status"; sab_pos_claim ;;
  claim_veto_por_protocolo)  # o desenho v3: trocar o protocolo liberava a compra
    trocar "$MIG" "     AND portal_situacao_codigo IS DISTINCT FROM '6'
  RETURNING status" "     AND NOT COALESCE(portal_situacao_codigo = '6' AND portal_situacao_protocolo = btrim(portal_protocolo), false)
  RETURNING status"; sab_pos_claim ;;
  sem_trigger)
    trocar "$MIG" "CREATE TRIGGER trg_situacao_portal_escritor_unico" "CREATE TRIGGER trg_situacao_portal_escritor_unico_desligado"
    trocar "$MIG" "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__situacao_portal_escritor_unico();" \
      "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__situacao_portal_escritor_unico();
ALTER TABLE public.pedido_compra_sugerido DISABLE TRIGGER trg_situacao_portal_escritor_unico_desligado;"
    trocar "$MIG" "                   AND tgrelid = 'public.pedido_compra_sugerido'::regclass AND tgenabled <> 'D') THEN" \
      "                   AND tgrelid = 'public.pedido_compra_sugerido'::regclass AND tgenabled <> 'D') AND false THEN" ;;
  sobreposta_libera)  # compara INÍCIOS (o desenho v3): leitura sobreposta mais curta liberaria o 6
    trocar "$MIG" "              OR p_lido_de > portal_situacao_ate
" "              OR p_lido_de > portal_situacao_em
"
    trocar "$MIG" "  IF v_src NOT LIKE '%OR p_lido_de > portal_situacao_ate%' OR" "  IF false OR" ;;
  ilegivel_grava)
    trocar "$MIG" "(i.protocolo ~ '^\d{3,12}\$' AND i.codigo ~ '^[1-7]\$' AND c.n = 1) AS valido" \
      "(i.protocolo ~ '^\d{3,12}\$' AND c.n = 1) AS valido"
    trocar "$MIG" "OR v_src NOT LIKE '%''^[1-7]\$''%' THEN" "THEN" ;;
  sem_ordem)
    trocar "$MIG" "              OR p_lido_de > portal_situacao_ate
" "              OR true
"
    trocar "$MIG" "  IF v_src NOT LIKE '%OR p_lido_de > portal_situacao_ate%' OR" "  IF false OR" ;;
  seis_nao_estende)  # o v4 sem o conserto: 2º 6 sobreposto descartado
    trocar "$MIG" "              OR (r.codigo = '6' AND portal_situacao_codigo = '6' AND p_lido_ate > portal_situacao_ate))" "              )" ;;
  sem_trava_protocolo)
    trocar "$MIG" "  BEFORE UPDATE OF portal_protocolo ON public.pedido_compra_sugerido
  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__trava_protocolo_com_cancelado();" "  BEFORE UPDATE OF portal_protocolo ON public.pedido_compra_sugerido
  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__trava_protocolo_com_cancelado();
ALTER TABLE public.pedido_compra_sugerido DISABLE TRIGGER trg_situacao_portal_trava_protocolo;"
    trocar "$MIG" "                   AND tgrelid = 'public.pedido_compra_sugerido'::regclass AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'S9" "                   AND tgrelid = 'public.pedido_compra_sugerido'::regclass AND tgenabled <> 'D') AND false THEN
    RAISE EXCEPTION 'S9" ;;
  pos_trava_sem_dente)
    trocar "$MIG" "  BEFORE UPDATE OF portal_protocolo ON public.pedido_compra_sugerido
  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__trava_protocolo_com_cancelado();" "  BEFORE UPDATE OF portal_protocolo ON public.pedido_compra_sugerido
  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__trava_protocolo_com_cancelado();
ALTER TABLE public.pedido_compra_sugerido DISABLE TRIGGER trg_situacao_portal_trava_protocolo;" ;;
  protocolo_fura_ordem)  # o v4: observação de protocolo diferente entrava sem olhar o tempo
    trocar "$MIG" "         AND (portal_situacao_em IS NULL
" "         AND (portal_situacao_em IS NULL OR portal_situacao_protocolo IS DISTINCT FROM r.protocolo
" ;;
  qualquer_empresa)
    trocar "$MIG" "       WHERE empresa = 'OBEN'
         AND btrim(portal_protocolo) = r.protocolo
         AND (" "       WHERE btrim(portal_protocolo) = r.protocolo
         AND (" ;;
  pos_claim_sem_dente)  # a POS tem de pegar o veto ausente SOZINHA (A1 vermelho = a migration não aplicou)
    trocar "$MIG" "     AND portal_situacao_codigo IS DISTINCT FROM '6'
  RETURNING status" "  RETURNING status" ;;
  pos_trigger_sem_dente)
    trocar "$MIG" "CREATE TRIGGER trg_situacao_portal_escritor_unico" "CREATE TRIGGER trg_situacao_portal_escritor_unico_desligado"
    trocar "$MIG" "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__situacao_portal_escritor_unico();" \
      "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__situacao_portal_escritor_unico();
ALTER TABLE public.pedido_compra_sugerido DISABLE TRIGGER trg_situacao_portal_escritor_unico_desligado;" ;;
  *) echo "INFRA: sabotagem desconhecida: $SAB"; exit 1 ;;
esac
if [ -n "$SAB" ]; then
  if cmp -s "$MIG" "$MIG_REAL"; then echo "INFRA: sabotagem $SAB inerte"; exit 1; fi
  echo "SABOTAGEM ATIVA em $SAB"
fi

# ── Banco: papéis do Supabase + o recorte da tabela que a migration toca ──
P -q <<'SQL' >/dev/null
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
-- O GRANT padrão do Supabase em função/tabela nova do public (a migration tem que FECHAR o EXECUTE).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE public.pedido_compra_sugerido (
  id                    bigint PRIMARY KEY,
  empresa               text NOT NULL,
  status                text NOT NULL,
  status_envio_portal   text,
  portal_protocolo      text,
  omie_pedido_compra_id text,
  disparo_claim_em      timestamptz,
  disparo_claim_por     text,
  atualizado_em         timestamptz
);
INSERT INTO public.pedido_compra_sugerido(id, empresa, status, status_envio_portal, portal_protocolo) VALUES
  (1, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141001'),
  (2, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141002'),
  (3, 'COLACOR', 'aprovado_aguardando_disparo', 'sucesso_portal', '2141003'),
  (4, 'OBEN',    'falha_envio',                 'sucesso_portal', '2141004'),
  (5, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141005'),
  (6, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141006'),
  (7, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141007'),
  (8, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141008'),
  (9, 'OBEN',    'aprovado_aguardando_disparo', 'sucesso_portal', '2141009');
SQL

echo "── A: aplicar ──"
if out="$(P -1 -f "$MIG" 2>&1)"; then
  case "$out" in *"POSTCONDICAO_OK sayerlack situacao portal no pedido"*) ok "A1 migration aplica com o NOTICE positivo de fim";; *) bad "A1 sem o NOTICE de fim";; esac
else bad "A1 migration NÃO aplicou: $(printf '%s' "$out" | grep -m1 -E 'ERROR|FALHOU' || true)"; fi
if P -1 -q -f "$MIG" >/dev/null 2>&1; then ok "A2 re-aplicar é idempotente"; else bad "A2 re-aplicar falhou"; fi
eq "A3 escritor fechado p/ anon+authenticated" "$(Pq -c "SELECT has_function_privilege('anon','public.sayerlack_registrar_situacao_portal(timestamptz,timestamptz,jsonb)','EXECUTE')::text || has_function_privilege('authenticated','public.sayerlack_registrar_situacao_portal(timestamptz,timestamptz,jsonb)','EXECUTE')::text" 2>&1)" "falsefalse"
eq "A4 escritor aberto p/ service_role" "$(Pq -c "SELECT has_function_privilege('service_role','public.sayerlack_registrar_situacao_portal(timestamptz,timestamptz,jsonb)','EXECUTE')" 2>&1)" "t"

# Chamada do escritor: $1 início, $2 fim, $3 itens jsonb → jsonb devolvido
W() { Pq -c "SELECT public.sayerlack_registrar_situacao_portal('$1'::timestamptz, '$2'::timestamptz, '$3'::jsonb)" 2>&1 || true; }
SIT() { Pq -c "SELECT COALESCE(portal_situacao_codigo,'-') || '|' || COALESCE(portal_situacao_protocolo,'-') FROM public.pedido_compra_sugerido WHERE id = $1" 2>&1 || true; }
NAO_FUTURO="2026-01-01"   # todos os instantes de leitura abaixo ficam no passado (o escritor recusa o futuro)

echo "── W: escritor ──"
W "$NAO_FUTURO 10:00Z" "$NAO_FUTURO 10:03Z" '[{"protocolo":"2141001","codigo":"6","texto":"6 - Cancelado"}]' >/dev/null
eq "W1 grava 6 no pedido OBEN do protocolo" "$(SIT 1)" "6|2141001"
eq "W2 o resto não muda" "$(SIT 2)" "-|-"
r="$(W "$NAO_FUTURO 11:00Z" "$NAO_FUTURO 11:01Z" '[{"protocolo":"2141001","codigo":"","texto":"Cancelado"},{"protocolo":"2141001x","codigo":"1"}]')"
eq "W3 código ilegível não apaga o 6 (e conta como ignorado)" "$(SIT 1)|$(printf '%s' "$r" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["ignorados"])' 2>&1)" "6|2141001|2"
W "$NAO_FUTURO 12:00Z" "$NAO_FUTURO 12:01Z" '[{"protocolo":"2141002","codigo":"1","texto":"1 - Aberto"},{"protocolo":"2141002","codigo":"6","texto":"6 - Cancelado"}]' >/dev/null
eq "W4 protocolo repetido no lote = ambíguo, nada grava" "$(SIT 2)" "-|-"
W "$NAO_FUTURO 09:00Z" "$NAO_FUTURO 09:30Z" '[{"protocolo":"2141001","codigo":"1","texto":"1 - Aberto"}]' >/dev/null
eq "W5 leitura MAIS VELHA não substitui" "$(SIT 1)" "6|2141001"
W "$NAO_FUTURO 10:03Z" "$NAO_FUTURO 10:04Z" '[{"protocolo":"2141001","codigo":"1","texto":"1 - Aberto"}]' >/dev/null
eq "W6 leitura que começou no FIM da vigente (não depois) não libera" "$(SIT 1)" "6|2141001"
W "$NAO_FUTURO 10:01Z" "$NAO_FUTURO 10:02Z" '[{"protocolo":"2141001","codigo":"1","texto":"1 - Aberto"}]' >/dev/null
eq "W7 leitura SOBREPOSTA dizendo 1 não libera o 6" "$(SIT 1)" "6|2141001"
W "$NAO_FUTURO 13:00Z" "$NAO_FUTURO 13:05Z" '[{"protocolo":"2141005","codigo":"1","texto":"1 - Aberto"}]' >/dev/null
W "$NAO_FUTURO 12:59Z" "$NAO_FUTURO 13:02Z" '[{"protocolo":"2141005","codigo":"6","texto":"6 - Cancelado"}]' >/dev/null
eq "W8 leitura sobreposta dizendo 6 entra (na dúvida, bloqueia)" "$(SIT 5)" "6|2141005"
W "$NAO_FUTURO 13:00Z" "$NAO_FUTURO 13:05Z" '[{"protocolo":"2141006","codigo":"1","texto":"1 - Aberto"}]' >/dev/null
W "$NAO_FUTURO 12:00Z" "$NAO_FUTURO 12:30Z" '[{"protocolo":"2141006","codigo":"6","texto":"6 - Cancelado"}]' >/dev/null
eq "W9 6 de leitura TODA anterior não entra" "$(SIT 6)" "1|2141006"
W "$NAO_FUTURO 10:00Z" "$NAO_FUTURO 10:03Z" '[{"protocolo":"2141003","codigo":"6","texto":"6 - Cancelado"}]' >/dev/null
eq "W10 só empresa OBEN" "$(SIT 3)" "-|-"
eq "W11 intervalo invertido = 22023" "$(W "$NAO_FUTURO 10:05Z" "$NAO_FUTURO 10:00Z" '[]' | sqlstate)" "22023"
eq "W12 leitura no futuro = 22023" "$(Pq -c "SELECT public.sayerlack_registrar_situacao_portal(now(), now() + interval '1 hour', '[]')" 2>&1 | sqlstate)" "22023"
W "$NAO_FUTURO 14:00Z" "$NAO_FUTURO 14:01Z" '[{"protocolo":"2141001","codigo":"1","texto":"1 - Aberto"}]' >/dev/null
eq "W13 leitura que começou DEPOIS do fim da vigente libera (6→1)" "$(SIT 1)" "1|2141001"
W "$NAO_FUTURO 15:00Z" "$NAO_FUTURO 15:01Z" '[{"protocolo":"2141001","codigo":"6","texto":"6 - Cancelado"}]' >/dev/null
eq "W14 e um 6 posterior volta a bloquear (1→6)" "$(SIT 1)" "6|2141001"

# Codex v4 P1: A=6 [10:00,10:01] · B=6 [10:00:30,10:02] (sobreposta) · C=1 [10:01:30,10:02:30] — C começou depois de A
# mas se sobrepõe a B: tem de seguir 6. Exige que B ESTENDA o horizonte do cancelamento.
W "$NAO_FUTURO 10:00:00Z" "$NAO_FUTURO 10:01:00Z" '[{"protocolo":"2141008","codigo":"6","texto":"6 - Cancelado"}]' >/dev/null
W "$NAO_FUTURO 10:00:30Z" "$NAO_FUTURO 10:02:00Z" '[{"protocolo":"2141008","codigo":"6","texto":"6 - Cancelado"}]' >/dev/null
W "$NAO_FUTURO 10:01:30Z" "$NAO_FUTURO 10:02:30Z" '[{"protocolo":"2141008","codigo":"1","texto":"1 - Aberto"}]' >/dev/null
eq "W15 2º 6 sobreposto estende o horizonte: a 3ª leitura (1) não libera" "$(SIT 8)" "6|2141008"
eq "W16 e o 6 estendido não encurta o início" "$(Pq -c "SELECT to_char(portal_situacao_em AT TIME ZONE 'UTC','HH24:MI:SS') || '-' || to_char(portal_situacao_ate AT TIME ZONE 'UTC','HH24:MI:SS') FROM public.pedido_compra_sugerido WHERE id=8" 2>&1)" "10:00:00-10:02:00"

# Codex rodadas 3-4 P1: trocar o protocolo abria sequências de ida-e-volta que liberavam a compra. Com 6 gravado,
# o protocolo é TRAVADO (trigger); sem 6, troca livre, e a ordem temporal vale entre protocolos.
W "$NAO_FUTURO 10:00Z" "$NAO_FUTURO 10:02Z" '[{"protocolo":"2141009","codigo":"6","texto":"6 - Cancelado"}]' >/dev/null
eq "W17 trocar o protocolo de pedido com 6 gravado = 42501" "$(Pq -c "UPDATE public.pedido_compra_sugerido SET portal_protocolo = '2141909' WHERE id = 9" 2>&1 | sqlstate)" "42501"
eq "W18 limpar o protocolo de pedido com 6 também = 42501" "$(Pq -c "UPDATE public.pedido_compra_sugerido SET portal_protocolo = NULL WHERE id = 9" 2>&1 | sqlstate)" "42501"
W "$NAO_FUTURO 10:00Z" "$NAO_FUTURO 10:02Z" '[{"protocolo":"2141006","codigo":"1","texto":"1 - Aberto"}]' >/dev/null
Pq -c "UPDATE public.pedido_compra_sugerido SET portal_protocolo = '2141906' WHERE id = 6" >/dev/null || true
W "$NAO_FUTURO 09:00Z" "$NAO_FUTURO 09:01Z" '[{"protocolo":"2141906","codigo":"1","texto":"1 - Aberto"}]' >/dev/null
eq "W19 sem 6 a troca é livre, e a leitura ANTERIOR do protocolo novo não substitui" "$(SIT 6)" "1|2141006"

echo "── T: escritor ÚNICO ──"
eq "T1 UPDATE direto da situação = 42501" "$(Pq -c "UPDATE public.pedido_compra_sugerido SET portal_situacao_codigo='1' WHERE id=1" 2>&1 | sqlstate)" "42501"
eq "T2 INSERT com situação = 42501" "$(Pq -c "INSERT INTO public.pedido_compra_sugerido(id, empresa, status, portal_protocolo, portal_situacao_codigo, portal_situacao_texto, portal_situacao_em, portal_situacao_ate, portal_situacao_protocolo, portal_situacao_gravada_em) VALUES (99,'OBEN','aprovado_aguardando_disparo','2141099','1','1',now(),now(),'2141099',now())" 2>&1 | sqlstate)" "42501"
eq "T3 UPDATE de outras colunas segue livre" "$(Pq -c "UPDATE public.pedido_compra_sugerido SET atualizado_em = now() WHERE id = 1 RETURNING id" 2>&1)" "1"
eq "T4 a porta (GUC) não sobra aberta depois do escritor na mesma transação" \
  "$(Pq -c "BEGIN; SELECT public.sayerlack_registrar_situacao_portal('$NAO_FUTURO 16:00Z','$NAO_FUTURO 16:01Z','[]'); UPDATE public.pedido_compra_sugerido SET portal_situacao_codigo='1' WHERE id=1; COMMIT;" 2>&1 | sqlstate)" "42501"

echo "── C: claim ──"
CL() { Pq -c "SELECT public.reposicao_claim_disparo($1, 'prova')" 2>&1 || true; }
campo() { python3 -I -c "import json,sys; v=json.load(sys.stdin).get('$1'); print('null' if v is None else str(v).lower())" 2>&1; }
r="$(CL 1)"
eq "C1 situação 6 bloqueia o claim" "$(printf '%s' "$r" | campo claimed)|$(printf '%s' "$r" | campo bloqueio)" "false|cancelado_no_portal"
eq "C2 sem pendência aberta, pendente_desde é null" "$(printf '%s' "$r" | campo pendente_desde)" "null"
eq "C3 e o claim NÃO foi gravado" "$(Pq -c "SELECT disparo_claim_em IS NULL FROM public.pedido_compra_sugerido WHERE id=1")" "t"
Pq -c "UPDATE public.pedido_compra_sugerido SET portal_protocolo = '2141901' WHERE id = 1" >/dev/null 2>&1 || true
eq "C4 tentar trocar o protocolo NÃO libera a compra" "$(CL 1 | campo claimed)" "false"
W "$NAO_FUTURO 17:00Z" "$NAO_FUTURO 17:01Z" '[{"protocolo":"2141001","codigo":"1","texto":"1 - Aberto"}]' >/dev/null
eq "C5 leitura posterior com outro código libera" "$(SIT 1)|$(CL 1 | campo claimed)" "1|2141001|true"
eq "C6 sem observação dispara" "$(CL 7 | campo claimed)" "true"
eq "C7 código ≠ 6 dispara" "$(CL 6 | campo claimed)" "true"
eq "C8 status fora da allowlist segue recusado" "$(Pq -c "UPDATE public.pedido_compra_sugerido SET status='disparado' WHERE id=8 RETURNING id" >/dev/null; CL 8 | campo claimed)" "false"
# pendência aberta ANTES do 6 (tentativa anterior sem desfecho): o claim recusa e devolve a pendência
Pq -c "SELECT public.reposicao_claim_disparo(4, 'tentativa-1')" >/dev/null || true
W "$NAO_FUTURO 10:00Z" "$NAO_FUTURO 10:03Z" '[{"protocolo":"2141004","codigo":"6","texto":"6 - Cancelado"}]' >/dev/null
r="$(CL 4)"
eq "C9 pendência aberta + 6: recusa com pendente_desde preenchido" "$(printf '%s' "$r" | campo claimed)|$( [ "$(printf '%s' "$r" | campo pendente_desde)" != null ] && echo sim || echo nao)" "false|sim"
eq "C10 e a pendência não é limpa" "$(Pq -c "SELECT disparo_claim_por FROM public.pedido_compra_sugerido WHERE id=4")" "tentativa-1"
eq "A5 claim fechado p/ anon+authenticated (REPLACE preserva o ACL)" "$(Pq -c "SELECT has_function_privilege('anon','public.reposicao_claim_disparo(bigint,text)','EXECUTE')::text || has_function_privilege('authenticated','public.reposicao_claim_disparo(bigint,text)','EXECUTE')::text")" "falsefalse"

echo "── R: corrida, 2 conexões ──"
# Conexão A segura a linha (transação aberta com sleep); B entra e TEM de ficar bloqueada por A
# (observado em pg_blocking_pids), e o desfecho de B é o da linha que A commitou.
corrida() { # $1 rótulo, $2 SQL de A (antes do sleep), $3 SQL de B → ecoa a saída de B
  local rot="$1" sa="$2" sb="$3" saida="$TMP/corrida-$1.out" bloq=nao
  "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 -tA -q \
    -c "SET application_name='corrida_a_$rot'" -c "BEGIN; $sa; SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
  local pa=$!; BGPIDS="$BGPIDS $pa"
  for _ in $(seq 1 50); do
    [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='corrida_a_$rot' AND query LIKE '%pg_sleep%' AND state='active'")" = 1 ] && break
    sleep 0.1
  done
  PGAPPNAME="corrida_b_$rot" "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 -tA -q -c "$sb" > "$saida" 2>&1 &
  local pb=$!; BGPIDS="$BGPIDS $pb"
  for _ in $(seq 1 25); do
    if [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity b WHERE b.application_name='corrida_b_$rot' AND cardinality(pg_blocking_pids(b.pid)) > 0")" = 1 ]; then bloq=sim; break; fi
    sleep 0.1
  done
  wait "$pa" || true; wait "$pb" || true
  printf '%s|%s' "$bloq" "$(tr -d '\n' < "$saida")"
}
# Ordem 1: a gravação do 6 vence (A grava e segura) → o claim de B reavalia a linha commitada e recusa.
out="$(corrida g1 "SELECT public.sayerlack_registrar_situacao_portal('$NAO_FUTURO 18:00Z','$NAO_FUTURO 18:01Z','[{\"protocolo\":\"2141002\",\"codigo\":\"6\",\"texto\":\"6 - Cancelado\"}]')" "SELECT (public.reposicao_claim_disparo(2,'corrida'))->>'claimed'")"
eq "R1 gravar-vence: B ficou BLOQUEADO por A e o claim saiu recusado" "$out" "sim|false"
eq "R2 gravar-vence: nenhuma pendência de disparo aberta" "$(Pq -c "SELECT disparo_claim_em IS NULL FROM public.pedido_compra_sugerido WHERE id=2")" "t"
# Ordem 2: o claim vence (A reivindica e segura) → a gravação de B espera e entra depois; o claim fica,
# e a próxima tentativa recusa devolvendo a pendência (o caminho da conciliação por consulta).
out="$(corrida c1 "SELECT public.reposicao_claim_disparo(7,'corrida')" "SELECT jsonb_array_length((public.sayerlack_registrar_situacao_portal('$NAO_FUTURO 18:00Z','$NAO_FUTURO 18:01Z','[{\"protocolo\":\"2141007\",\"codigo\":\"6\",\"texto\":\"6 - Cancelado\"}]'))->'aceitos')")"
eq "R3 claim-vence: a gravação ficou BLOQUEADA e entrou depois" "$out" "sim|1"
r="$(CL 7)"
eq "R4 claim-vence: a próxima tentativa recusa e devolve a pendência" "$(printf '%s' "$r" | campo claimed)|$( [ "$(printf '%s' "$r" | campo pendente_desde)" != null ] && echo sim || echo nao)" "false|sim"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then echo "RESULTADO: VERMELHO (LC=$LOC)"; exit 1; fi
echo "RESULTADO: VERDE — test-sayerlack-situacao-portal (LC=$LOC)"
