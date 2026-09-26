#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5471}"
SLUG="sync-reprocess-saude"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# A regra que este laço respeita (CLAUDE.md): sabotar sem CONTROLE VERDE na MESMA invocação é
# teatro — uma suíte sempre-vermelha (por ambiente quebrado, porta ocupada, migration inválida)
# aprovaria TODAS as sabotagens. Por isso o controle roda PRIMEIRO, aqui dentro, e um controle
# vermelho ABORTA antes da primeira sabotagem, em vez de deixar o laço "passar".
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="erro_nao_e_broken desconhecido_vira_ok nao_catalogada_vira_ok orfa_nunca_dispara
              stale_nunca_dispara nunca_executou_vira_ok retry_liquida_erro degradado_conta_dispensada message_com_idade
              message_com_data_do_relogio message_com_hora_de_parede message_constante fora_do_v_sources"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "  ✅ controle VERDE ($(grep -c '✅' "$LOGDIR/controle.log") asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar. Uma suíte que já falha sozinha"
    echo "     aprovaria todas as sabotagens por vermelhidão constante, não por dente."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for sab in $SABOTAGENS; do
    porta=$((porta+1))
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$LOGDIR/$sab.log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert correspondente NÃO tem dente"
      falhas=$((falhas+1))
    else
      quebrou="$(grep -c '❌' "$LOGDIR/$sab.log" || true)"
      echo "  ✅ $sab — vermelha como devia ($quebrou assert(s) quebraram)"
    fi
  done

  # Recibo EXCLUSIVO deste modo (o normal nunca o emite): é como o runner confere que a flag
  # `--falsificar` não foi silenciosamente ignorada. Vermelhas = sabotagens que ficaram vermelhas.
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  echo
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens todas vermelhas ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) passaram despercebidas (logs em $LOGDIR) ═══"
  exit 1
fi

# PGBIN resolvido POR PLATAFORMA (macOS Homebrew / Linux PGDG) com conferência positiva da major.
# O boilerplate do template é macOS-only (`/opt/homebrew`) — esta prova roda no `provas-sql` do CI,
# que é Ubuntu, então tem de usar o helper. Fail-closed: PG ausente é ERRO, nunca skip.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
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

# DUAS migrations, na ORDEM real de produção: a 1ª cria o check e registra o source nas duas
# pontas (watchdog + heartbeat); a 2ª recria só o compute para o conserto do E.1. Aplicar só a 2ª
# num PG limpo faz a postcondição dela falhar — corretamente, porque as outras pernas não existem.
MIG_BASE="$REPO_ROOT/supabase/migrations/20260918200000_data_health_sync_reprocess_saude.sql"
MIG_RETRY="$REPO_ROOT/supabase/migrations/20260920210000_sync_reprocess_retry_nao_liquida_erro.sql"
MIG="$REPO_ROOT/supabase/migrations/20260920233000_sync_reprocess_degradado_so_das_vigiadas.sql"
for m in "$MIG_BASE" "$MIG_RETRY" "$MIG"; do [ -f "$m" ] || { echo "❌ migration ausente: $m"; exit 1; }; done

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — pré-requisitos mínimos (formas MEDIDAS em prod, sem schema-snapshot)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$REPO_ROOT/db/stubs-data-health-trio.sql"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — a migration REAL (Lei #1: nunca um stub da lógica)
# ══════════════════════════════════════════════════════════════════════════════
# O PG17 limpo daria EXECUTE a PUBLIC por default; PROD tem o REVOKE (medido: o compute e
# executavel so por postgres/service_role/sandbox_exec — nem `authenticated`). Reproduzimos esse
# estado ANTES do apply com um stub de assinatura identica: assim a postcondicao de ACL nao mede o
# default do harness, e sim o que a migration faz com ele — provando que `CREATE OR REPLACE`
# PRESERVA o ACL (so DROP+CREATE o resetaria, CLAUDE.md/database.md §4).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint,
               freshness_basis text, message text, last_error text, probable_cause text,
               how_to_fix text, severity text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $stub$ SELECT NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bigint, NULL::text,
                 NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $stub$;
REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._data_health_compute() TO service_role;
SQL

aplicar_real() { P -q -f "$MIG_BASE" >/dev/null; P -q -f "$MIG_RETRY" >/dev/null; P -q -f "$MIG" >/dev/null; }
aplicar_real
echo "═══ migration real aplicada (postcondição passou) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# SABOTAGEM (dirigida por $SABOTAGEM; o laço --falsificar no fim do arquivo a usa)
# Sabota no BANCO, recriando a função com o trecho trocado — o repo NUNCA é tocado, então não há
# `git checkout --` para restaurar (que é onde a falsificação costuma comer trabalho não commitado).
# Cada sabotagem EXIGE que o padrão ocorra exatamente 1× no corpo: uma substituição que não pegou
# deixaria a suíte verde e faria a falsificação aprovar tudo — teatro.
# ══════════════════════════════════════════════════════════════════════════════
sabotar() {
  local fn="$1" de="$2" para="$3"
  # de qual arquivo extrair: o compute vem da migration do conserto (a última a recriá-lo, que é o
  # que vale em prod); watchdog e heartbeat só existem na base.
  local src="$MIG"; [ "$fn" = "_data_health_compute" ] || src="$MIG_BASE"
  local tmp; tmp="$(mktemp "/tmp/sab-${SLUG}.XXXXXX")"
  awk -v fn="CREATE OR REPLACE FUNCTION public.${fn}(" \
      'index($0,fn)==1{f=1} f{print} f && /^\$function\$;$/{exit}' "$src" > "$tmp"
  python3 - "$tmp" "$de" "$para" <<'PYSAB' || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× no corpo de $fn. Sem isto a suíte ficaria verde e a falsificação aprovaria tudo."; exit 9; }
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, "w").write(s.replace(de, para))
PYSAB
  P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
  echo "⚠️  SABOTAGEM ATIVA em $fn — a suíte abaixo DEVE ficar vermelha"
}

case "${SABOTAGEM:-}" in
  "") ;;
  erro_nao_e_broken)
      sabotar _data_health_compute "WHEN u.status IN ('error','failed') THEN 'broken'" \
                                   "WHEN u.status IN ('error','failed') THEN 'ok'" ;;
  desconhecido_vira_ok)
      sabotar _data_health_compute "WHEN u.status IS NOT NULL AND u.status <> 'complete' THEN 'unknown'" \
                                   "WHEN u.status IS NOT NULL AND u.status <> 'complete' THEN 'ok'" ;;
  nao_catalogada_vira_ok)
      sabotar _data_health_compute "WHEN cat.nao_catalogada THEN 'unknown'" \
                                   "WHEN cat.nao_catalogada THEN 'ok'" ;;
  orfa_nunca_dispara)
      sabotar _data_health_compute "AND r.created_at < now() - interval '2 hours' THEN 'broken'" \
                                   "AND r.created_at < now() - interval '900 hours' THEN 'broken'" ;;
  stale_nunca_dispara)
      sabotar _data_health_compute "WHEN s.ultimo_sucesso_em < now() - make_interval(hours => cat.sla_h) THEN 'stale'" \
                                   "WHEN s.ultimo_sucesso_em < now() - make_interval(hours => cat.sla_h * 1000) THEN 'stale'" ;;
  nunca_executou_vira_ok)
      sabotar _data_health_compute "WHEN s.ultimo_sucesso_em IS NULL THEN 'broken'" \
                                   "WHEN s.ultimo_sucesso_em IS NULL THEN 'ok'" ;;
  degradado_conta_dispensada)
      # devolver a contagem a TODAS as chaves faz o fóssil de `manual` voltar a inflar a message
      sabotar _data_health_compute "(cat.sla_h IS NOT NULL AND NOT cat.nao_catalogada
                AND u.status = 'complete' AND u.error_message IS NOT NULL) AS degradado," \
                                   "(u.status = 'complete' AND u.error_message IS NOT NULL) AS degradado," ;;
  retry_liquida_erro)
      # o furo E.1 em si: devolver `u` a leitura de QUALQUER linha faz um `running` posterior
      # apagar o erro terminal. Tem de ficar vermelha no assert do E.1.
      sabotar _data_health_compute "             AND l.status IS DISTINCT FROM 'running'
           -- desempate EXPLICITO por id" \
                                   "           -- desempate EXPLICITO por id" ;;
  message_com_idade)
      sabotar _data_health_compute "ELSE ' desde ' || to_char(d.ultimo_sucesso_em AT TIME ZONE 'America/Sao_Paulo','DD/MM') END" \
                                   "ELSE ' desde ' || to_char(now() AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI:SS') END" ;;
  message_com_data_do_relogio)
      # O defeito de SENSOR que o assert antigo não via: a data vir do RELÓGIO, e não do último sucesso.
      # Ela só muda à meia-noite ⇒ mesmo problema, message nova por dia ⇒ um e-mail por dia. Só pega
      # isso um relógio que CRUZA a meia-noite local com o dado parado; deslocar o dado, nunca.
      sabotar _data_health_compute "ELSE ' desde ' || to_char(d.ultimo_sucesso_em AT TIME ZONE 'America/Sao_Paulo','DD/MM') END" \
                                   "ELSE ' desde ' || to_char(now() AT TIME ZONE 'America/Sao_Paulo','DD/MM') END" ;;
  message_com_hora_de_parede)
      # clock_timestamp() não passa pelo relógio controlado (só now() passa): quem pega é o pg_sleep REAL
      # entre as leituras. Sem esta sabotagem aquele sleep seria camada sem prova de dente.
      sabotar _data_health_compute "ELSE ' desde ' || to_char(d.ultimo_sucesso_em AT TIME ZONE 'America/Sao_Paulo','DD/MM') END" \
                                   "ELSE ' desde ' || to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI:SS') END" ;;
  message_constante)
      # O outro lado da moeda de `message_com_idade`: uma message que NUNCA muda passaria o teste de
      # estabilidade e não avisaria ninguém. Esta sabotagem tem de ficar vermelha no assert do PAR.
      sabotar _data_health_compute "WHEN sr.n_broken > 0 THEN 'Reprocesso Omie PARADO: ' || sr.resumo" \
                                   "WHEN sr.n_broken > 0 THEN 'Reprocesso Omie PARADO'" ;;
  fora_do_v_sources)
      sabotar data_health_watchdog "    'sync_reprocess_saude'];" "    'nao_existe_este_source'];" ;;
  *)  echo "❌ SABOTAGEM desconhecida: ${SABOTAGEM}"; exit 9 ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — mesa de controle: cada cenário semeia sync_reprocess_log e lê o veredito
# ══════════════════════════════════════════════════════════════════════════════
# As 7 chaves VIGIADAS do catálogo. `semear_saudavel` deixa todas verdes; cada cenário
# depois altera UMA coisa, para que o assert prove aquela coisa e não o ambiente.
# $1 (opcional) = instante-âncora como expressão SQL; o padrão é now(). Só o cenário de message
# estável ancora num instante FIXO — o porquê está lá.
semear_saudavel() {
  P -q -v agora="${1:-now()}" <<'SQL'
TRUNCATE public.sync_reprocess_log;
INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at) VALUES
  ('oben','operational','orders',            'complete', :agora - interval '30 minutes'),
  ('oben','operational','inventory',         'complete', :agora - interval '30 minutes'),
  ('oben','strategic','orders',              'complete', :agora - interval '3 hours'),
  ('oben','strategic','inventory',           'complete', :agora - interval '3 hours'),
  ('oben','strategic','products',            'complete', :agora - interval '3 hours'),
  ('oben','status_produtos','sku_status_omie','complete', :agora - interval '3 hours'),
  ('colacor','status_produtos','sku_status_omie','complete', :agora - interval '3 hours');
SQL
}
# status agregado do check
st()  { Pq -c "SELECT status  FROM public._data_health_compute() WHERE source='sync_reprocess_saude';"; }
# message/idade lidas com o relógio controlado em $1, cada leitura na SUA sessão (o SET morre com ela).
# Só valem com o relógio ligado (seção "message estável"), e o controle positivo de lá confere isso.
msg_em()   { Pq -q -c "SET test.agora = '$1'" -c "SELECT message FROM public._data_health_compute() WHERE source='sync_reprocess_saude';"; }
idade_em() { Pq -q -c "SET test.agora = '$1'" -c "SELECT age_seconds::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';"; }
nlin(){ Pq -c "SELECT count(*)::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';"; }

echo "── contrato de forma (o que cega os outros checks se quebrar) ──"
P -q -c "TRUNCATE public.sync_reprocess_log;"
eq "tabela VAZIA ainda devolve 1 linha (catálogo é o FROM, não a tabela)" "$(nlin)" "1"
eq "tabela VAZIA ⇒ broken (chave vigiada que nunca executou é falha, não silêncio)" "$(st)" "broken"

semear_saudavel
eq "1 linha por source no compute INTEIRO" \
   "$(Pq -c "SELECT (count(*) = count(DISTINCT source))::text FROM public._data_health_compute();")" "true"
eq "o compute tem 30 sources (29 de prod + o novo)" \
   "$(Pq -c "SELECT count(DISTINCT source)::text FROM public._data_health_compute();")" "30"
eq "status dentro do vocabulário que o watchdog aceita" \
   "$(Pq -c "SELECT (status IN ('ok','stale','broken','unknown'))::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';")" "true"

echo "── vereditos por eixo ──"
eq "catálogo todo com complete fresco ⇒ ok" "$(st)" "ok"

semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET status='error', error_message='pedido 7b6f incoerente'
          WHERE reprocess_type='operational' AND entity_type='orders';"
eq "última linha em error ⇒ broken (o incidente real)" "$(st)" "broken"
eq "o erro técnico chega ao last_error" \
   "$(Pq -c "SELECT (last_error LIKE '%7b6f%')::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';")" "true"

semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET status='failed'
          WHERE reprocess_type='status_produtos' AND account='oben';"
eq "dialeto 'failed' (omie-sync-status-produtos) também é broken" "$(st)" "broken"

# O cenário da órfã precisa de um SUCESSO DENTRO do SLA, senão o `broken` vem da cláusula "nunca
# completou" e o assert passa pelo motivo errado — foi o que a falsificação flagrou: sabotar o
# limiar da órfã deixava a suíte verde. Aqui: complete há 3h (dentro do SLA de 4h) e uma tentativa
# iniciada há 2h30 que nunca terminou. Só a cláusula da órfã pode dar broken.
semear_saudavel
P -q -c "DELETE FROM public.sync_reprocess_log WHERE reprocess_type='operational' AND entity_type='orders';"
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at) VALUES
  ('oben','operational','orders','complete', now() - interval '3 hours'),
  ('oben','operational','orders','running',  now() - interval '150 minutes');"
eq "running iniciada há 2h30 sobre sucesso ainda no SLA ⇒ broken (órfã; máx real 2,6 min)" "$(st)" "broken"

semear_saudavel
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at)
         VALUES ('oben','operational','orders','running', now() - interval '10 minutes');"
eq "running há 10min sobre sucesso fresco ⇒ ok (run em voo não é órfã)" "$(st)" "ok"

semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET created_at = now() - interval '9 hours'
          WHERE reprocess_type='operational' AND entity_type='inventory';"
eq "sem complete há 9h num SLA de 4h ⇒ stale" "$(st)" "stale"

semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET status='enigma'
          WHERE reprocess_type='strategic' AND entity_type='products';"
eq "status FORA dos 3 dialetos ⇒ unknown, NUNCA ok" "$(st)" "unknown"

semear_saudavel
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at)
         VALUES ('nova_conta','operational','orders','complete', now());"
eq "chave ATIVA fora do catálogo ⇒ unknown (cobertura desconhecida não é saudável)" "$(st)" "unknown"

# ⚠️ REPRODUÇÃO do achado E.1 do Codex (challenge retroativo 2026-09-20): um `running` posterior
# NÃO pode liquidar um erro terminal. Sucesso 10h → erro 12h → retry grava `running` 12h29: a última
# linha deixa de ser erro, o running é recente e o sucesso das 10h ainda cabe no SLA de 4h ⇒ o check
# diria `ok` e o watchdog faria DISMISS AUTOMÁTICO, antes de o retry sequer completar.
semear_saudavel
P -q -c "DELETE FROM public.sync_reprocess_log WHERE reprocess_type='operational' AND entity_type='orders';"
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, error_message, created_at) VALUES
  ('oben','operational','orders','complete', NULL,             now() - interval '150 minutes'),
  ('oben','operational','orders','error',    'RPC falhou',     now() - interval '31 minutes'),
  ('oben','operational','orders','running',  NULL,             now() - interval '1 minute');"
eq "erro terminal seguido de retry em voo NÃO pode virar ok (E.1)" "$(st)" "broken"

echo "── precisão: degradação ≠ quebra ──"
semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET error_message='2 pedidos falharam na reconciliação'
          WHERE reprocess_type='operational' AND entity_type='orders';"
eq "complete COM error_message ⇒ continua ok (o estágio andou)" "$(st)" "ok"
eq "…mas a degradação aparece na message" \
   "$(Pq -c "SELECT (message LIKE '%falha por pedido%')::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';")" "true"

# O contador de degradação tem de contar só as chaves VIGIADAS. Medido em prod 2026-09-20:
# `oben/manual/orders` tem um `complete` COM error_message de 94 dias atrás — chave DISPENSADA — e
# ele inflava a message ("falha por pedido registrada em 1 estagio(s)") sobre um fóssil que ninguém
# vigia. Status seguia `ok`, então não havia alarme falso; o dano era na message, que é o que o
# founder lê — e é exatamente o ruído que o catálogo existe para não deixar entrar.
semear_saudavel
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, error_message, created_at)
         VALUES ('oben','manual','orders','complete','1 pedido com SKU repetido', now() - interval '94 days');"
eq "fóssil DISPENSADO com error_message não conta como degradação" \
   "$(Pq -c "SELECT (message LIKE '%falha por pedido%')::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';")" "false"

echo "── o catálogo não deixa fóssil nem escritor alheio poluir ──"
semear_saudavel
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at)
         VALUES ('colacor','manual','products','error', now() - interval '200 days');"
eq "manual em error desde fevereiro NÃO derruba o check (dispensado)" "$(st)" "ok"
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at) VALUES
  ('OBEN','ciclo_diario','pedidos_compra_sugeridos','ok', now()),
  ('OBEN','disparo_diario','pedidos_compra_disparo','partial', now());"
eq "grupo OBEN (dialeto ok/partial, vigiado por efeito) não vira 'não catalogada'" "$(st)" "ok"

echo "── message estável (senão re-emaila a cada 30 min) ──"
# ⚠️ QUEM ANDA É O RELÓGIO, NÃO O DADO. Até 2026-09-26 este assert simulava "o mesmo problema ficou 3h
# mais velho" deslocando o DADO (UPDATE created_at - 3h). Isso só equivale a avançar o relógio para o
# que é função de (now() - t) — e a message é, por CONTRATO, função do INSTANTE do último sucesso (a
# data congelada DD/MM em America/Sao_Paulo). O UPDATE movia esse instante: com a semeadura entre 00:30
# e 03:30 BRT (03:30Z–06:30Z) o deslocamento cruzava a meia-noite local e a data mudava, com razão. A
# prova reprovava sozinha nessa janela e travava o auto-merge de todo PR (#2573, #2576) sem defeito
# nenhum no sensor. Diário: docs/historico/deslocar-o-dado-nao-e-avancar-o-relogio.md
#
# Agora o dado fica PARADO e o relógio anda. `public.now()` lê a GUC `test.agora`, e o compute — corpo
# REAL da migration, intocado — ganha `pg_catalog` DEPOIS de `public` no search_path: é a única forma
# de um nome de usuário vencer um embutido (sem pg_catalog explícito ele é buscado PRIMEIRO, e por isso
# nada mais no banco enxerga esta função). O cenário é ADVERSARIAL e FIXO, independente da hora do CI:
# semeado às 23:00 BRT e relido às 02:00 BRT do dia seguinte — o relógio cruza a meia-noite local com o
# mesmo problema aberto, que é exatamente onde uma data tirada do relógio se trairia.
cfg_compute="$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(nullif(current_setting('test.agora', true), '')::timestamptz, pg_catalog.now())
$f$;
ALTER FUNCTION public._data_health_compute() SET search_path = public, pg_catalog, pg_temp;
SQL
T0='2026-09-15 23:00:00-03'   # 23:00 BRT
T1='2026-09-16 02:00:00-03'   # +3h, do OUTRO lado da meia-noite local

# O par certo: um `complete` antigo (a data que congela) + um `error` por cima, e depois SÓ o relógio
# anda. Às 02:00 as outras chaves seguem dentro do SLA (a mais apertada, 4h, completou às 22:30): o
# conjunto de problemas não muda, então nada autoriza a message a mudar.
semear_saudavel "'$T0'::timestamptz"
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, error_message, created_at)
         VALUES ('oben','operational','orders','error','pedido incoerente', '$T0'::timestamptz - interval '10 minutes');"
M1="$(msg_em "$T0")"; I1="$(idade_em "$T0")"
# O relógio REAL também anda >1s entre as leituras: o controlado só intercepta now(), e uma hora
# corrida tirada de clock_timestamp()/CURRENT_TIMESTAMP escaparia dele (sabotagem message_com_hora_de_parede).
P -q -c "SELECT pg_sleep(1.1);" >/dev/null
M2="$(msg_em "$T1")"; I2="$(idade_em "$T1")"
# Controle POSITIVO: um relógio que não interceptasse nada deixaria M1=M2 por construção, e o assert
# de estabilidade passaria por CEGUEIRA. A idade que o compute enxerga TEM de andar as 3h.
eq "o compute lê o relógio controlado: idade de 30 min às 23:00" "$I1" "1800"
eq "…e de 3h30 às 02:00 do dia seguinte (o relógio andou 3h, o dado ficou parado)" "$I2" "12600"
if [ "$M1" = "$M2" ] && [ -n "$M1" ]; then ok "message idêntica com o relógio 3h adiante, cruzando a meia-noite local (data congelada)"; else
  bad "message VARIOU só porque o tempo passou — o fingerprint source|status|severity|message re-emailaria
       antes: [$M1]
       depois: [$M2]"; fi

# O PAR do assert acima, e ele é obrigatório: "message estável" sozinho é satisfeito por uma
# message CONSTANTE, que não avisaria nada. A propriedade real tem dois lados — congela enquanto o
# problema é o mesmo, MUDA quando o conjunto de problemas muda (aí re-emitir é o certo, não spam).
P -q -c "UPDATE public.sync_reprocess_log SET status='error'
          WHERE reprocess_type='strategic' AND entity_type='products';"
M3="$(msg_em "$T1")"
if [ "$M3" != "$M2" ] && [ -n "$M3" ]; then ok "message MUDA quando um 2º estágio quebra (re-emite, como deve)"; else
  bad "message NÃO mudou com um 2º estágio quebrado — uma message constante passaria o teste de
       estabilidade sem avisar nada: [$M3]"; fi

# Dois problemas simultâneos: o resumo tem de ser DETERMINÍSTICO (o string_agg é ordenado por
# reprocess_type, entity_type, account). Sem ordem explícita a message oscilaria entre formas e o
# fingerprint re-emailaria sozinho — a lição do #1980, aqui no eixo do agregado.
M4="$(msg_em "$T1")"
eq "resumo com 2 problemas é estável entre leituras (string_agg ordenado)" "$M4" "$M3"

# Desliga o relógio controlado: o resto da prova (watchdog/heartbeat) roda no compute EXATAMENTE como a
# migration o deixou — conferido, não suposto.
P -q <<'SQL'
ALTER FUNCTION public._data_health_compute() SET search_path = public, pg_temp;
DROP FUNCTION public.now();
SQL
[ "$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")" = "$cfg_compute" ] \
  || { echo "❌ o relógio controlado NÃO foi desligado: o search_path do compute diverge do da migration [$cfg_compute]"; exit 1; }

echo "── as outras 2 pernas do trio EXECUTAM (late-bound: CREATE não prova nada) ──"
semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET status='error' WHERE reprocess_type='operational' AND entity_type='orders';"
P -q -c "SELECT public.data_health_watchdog();" >/dev/null
# 22 = tamanho do v_sources (21 + o novo). O compute produz 30 sources; o watchdog avalia os do
# array e ignora o resto — por isso os dois números são diferentes DE PROPÓSITO.
eq "watchdog avalia 22 checks (o v_sources, não os 30 do compute)" \
   "$(Pq -c "SELECT checks_avaliados::text FROM public.data_health_watchdog_estado WHERE id;")" "22"
# ⚠️ checks_falhos conta EXCECAO DE EXECUCAO do check, nunca status de negocio: o laco so o
# incrementa no EXCEPTION. Com o check novo em `broken`, o certo e ZERO — ele avaliou bem, o
# resultado e que e ruim. Foi por isso que o estado de 14/09 (checks_avaliados=21, checks_falhos=0)
# nao provava saude nenhuma durante os 10 dias do incidente: provava so que nada explodiu.
eq "checks_falhos=0 mesmo com o check novo em broken (conta exceção, não negócio)" \
   "$(Pq -c "SELECT checks_falhos::text FROM public.data_health_watchdog_estado WHERE id;")" "0"
eq "watchdog ROTEOU o source novo para o push (_data_health_episodio)" \
   "$(Pq -c "SELECT (count(*) > 0)::text FROM public._spy_episodio WHERE tipo='data_health_sync_reprocess_saude';")" "true"
P -q -c "SELECT public.fin_sync_heartbeat();" >/dev/null
ok "fin_sync_heartbeat executa com o source novo na IN-list"

echo "── o source está nas DUAS pontas (senão o check existe e nunca é avaliado) ──"
eq "sync_reprocess_saude no v_sources do watchdog" \
   "$(Pq -c "SELECT (pg_get_functiondef(p.oid) LIKE '%''sync_reprocess_saude''%')::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='data_health_watchdog';")" "true"
eq "sync_reprocess_saude na IN-list do heartbeat" \
   "$(Pq -c "SELECT (pg_get_functiondef(p.oid) LIKE '%''sync_reprocess_saude''%')::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fin_sync_heartbeat';")" "true"

echo
# Recibo no formato do runner (db/roda-nucleo-ci.sh): sem uma linha de contagem que ele saiba ler,
# uma prova trocada por `exit 0` passaria — o fechamento `[ "$FAIL" -eq 0 ]` também aceita PASS=0.
echo "PASS=${PASS}  FAIL=${FAIL}"
echo "═══ ${PASS} passaram · ${FAIL} falharam ═══"
[ "$FAIL" -eq 0 ] || exit 1
