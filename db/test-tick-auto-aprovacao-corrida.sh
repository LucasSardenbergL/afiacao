#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA DE ABSOLVICAO — reposicao_alerta_pedido_minimo_tick NAO tem o TOCTOU    ║
# ║  da classe fechada em 20260905224959 / 20260906105549 / 20260906151715.        ║
# ║                                                                               ║
# ║      bash db/test-tick-auto-aprovacao-corrida.sh > /tmp/t.log 2>&1; echo $?   ║
# ║  (NAO pipe pra tail — engole o exit!=0.)                                       ║
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-tick-auto-aprovacao-corrida.sh        ║
# ║                                                                               ║
# ║  POR QUE ESTE HARNESS EXISTE                                                   ║
# ║  A triagem de 2026-09-06 absolveu o tick em DOIS eixos:                        ║
# ║   (1) STATUS — o predicado esta no WHERE da escrita (claim condicional+FOUND); ║
# ║       isso se le no corpo do proprio tick.                                     ║
# ║   (2) VALOR  — a elegibilidade decide pela SOMA DOS ITENS, que o WHERE do tick ║
# ║       NAO reconfere. O que fecha esse eixo e um `SELECT ... FOR UPDATE` que    ║
# ║       vive DENTRO do callee `reposicao_pedido_auto_aprovavel` (linha 1 do      ║
# ║       corpo). Ou seja: a seguranca do tick e LOAD-BEARING num lock de OUTRA    ║
# ║       funcao, invisivel de quem le so o tick — e que parece redundante la      ║
# ║       (a funcao e read-only). Tirar aquele `FOR UPDATE` reabre o buraco em     ║
# ║       silencio.                                                                ║
# ║  O P5 de db/test-auto-aprovacao-v2.sh ja cobre "corrida com humano", mas e     ║
# ║  SEQUENCIAL (aprova, commita, so entao chama o tick) — e assert sequencial NAO ║
# ║  distingue "tem guard" de "o guard e atomico"                                  ║
# ║  (docs/historico/guard-fora-da-escrita-nao-e-guard.md). Este aqui e a corrida. ║
# ║                                                                               ║
# ║  GRUPOS                                                                        ║
# ║   D  deriva     — o corpo LOCAL bate com o md5 medido na PROD em 2026-09-06    ║
# ║   R  CORRIDA    — R1 e o BASELINE VERMELHO: com o `FOR UPDATE` do callee       ║
# ║                   removido (unica alteracao), o tick auto-aprova um pedido que ║
# ║                   acabou de cair ABAIXO da regua. R2 e a absolvicao: corpo     ║
# ║                   real, mesma corrida, RECUSA.                                 ║
# ║   F  falsificacao — F1 falsifica o proprio R2: corrida IDENTICA, mesma espera  ║
# ║                   no mesmo lock, mas a remocao deixa o pedido AINDA acima da   ║
# ║                   regua -> o tick tem de APROVAR. Verde aqui + verde em R2 =   ║
# ║                   a recusa de R2 veio do VALOR RELIDO, nao de ter esperado.    ║
# ╚═══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5478}"
SLUG="tick-corrida"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# md5(prosrc) MEDIDO NA PROD em 2026-09-06 via ~/.config/afiacao/psql-ro. Se o corpo local
# divergir, este harness estaria provando um corpo que NAO esta em producao (a licao de
# docs/historico/deriva-de-corpo-prod-a-frente-do-repo.md) — e o grupo D fica vermelho.
MD5_PROD_TICK='55cc2e3fc4f92ab775dbf29f6d310046'
MD5_PROD_CALLEE='b209fb34b7b1a513a4883067aafdc242'

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
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone='UTC';"
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }

P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

echo "-> stubs + prelude + snapshot..."
RR="$(mktemp "${TMPDIR:-/tmp}/snap-${SLUG}.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -q -f "$RR"
rm -f "$RR"
P -q -f "$REPO_ROOT/supabase/migrations/20260524102500_fix_fin_triggers_json_field_access.sql" >/dev/null

P -q >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid),0)+1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;
SQL

echo "-> migrations reais, em ordem de timestamp (Lei #1: a funcao sob teste e a REAL)..."
for m in 20260609150000_reposicao_alerta_pedido_minimo \
         20260610150000_reposicao_auto_aprovacao_piloto \
         20260611120000_reposicao_fixes_codex_711 \
         20260615210000_reposicao_auto_aprovacao_v2 \
         20260629140000_reposicao_preco_ausente_null; do
  P -q -f "$REPO_ROOT/supabase/migrations/${m}.sql" >/dev/null
done

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

AMOSTRA_MSG=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT 1/0;" 2>&1 | head -1) || true
echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="
echo "=== controle do eixo de locale, mensagem do servidor: $AMOSTRA_MSG"

md5f() { Pq -c "SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$1';"; }

echo "-- grupo D: deriva repo x PROD (o corpo testado e o corpo servido?) --"
eq "D1 tick local == corpo medido na PROD 2026-09-06"   "$(md5f reposicao_alerta_pedido_minimo_tick)" "$MD5_PROD_TICK"
eq "D2 callee local == corpo medido na PROD 2026-09-06" "$(md5f reposicao_pedido_auto_aprovavel)"     "$MD5_PROD_CALLEE"
# D3: o lock que sustenta a absolvicao do eixo VALOR esta MESMO no callee (assert POSICIONAL:
# no mesmo SELECT que le o pai, nao "FOR UPDATE em algum lugar do arquivo").
eq "D3 o callee trava o pai antes de decidir (FOR UPDATE no SELECT do pai)" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reposicao_pedido_auto_aprovavel' AND p.prosrc ~ 'INTO p FROM public\.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE';")" '1'

# ══════════════════════════════════════════════════════════════════════════════
# Fixture: helpers PERMANENTES (nao pg_temp — a corrida usa VARIAS conexoes, e
# pg_temp e por-sessao: um helper em pg_temp sumiria para o bloqueador).
# ══════════════════════════════════════════════════════════════════════════════
P -q >/dev/null <<'SQL'
CREATE TABLE IF NOT EXISTS public.barreira (nome text PRIMARY KEY);

-- N eventos de COMPRA do grupo (a referencia v2 e a MEDIANA do valor_total deles).
CREATE FUNCTION public.t_mkrefs(grp text, valores numeric[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int;
BEGIN
  FOR i IN 1..array_length(valores,1) LOOP
    INSERT INTO public.pedido_compra_sugerido
      (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo,
       criado_em, omie_pedido_compra_numero)
    VALUES ('OBEN', 'RENNER SAYERLACK S/A', grp, CURRENT_DATE - i, valores[i], 5, 'disparado', 'normal',
       now() - (i || ' days')::interval, '9' || grp || i);
  END LOOP;
END $$;

-- candidato pendente com N itens IGUAIS de `val_item` (soma = n_itens * val_item).
CREATE FUNCTION public.t_mk(grp text, n_itens int, val_item numeric) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE pid bigint; i int;
BEGIN
  INSERT INTO public.pedido_compra_sugerido
    (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN', 'RENNER SAYERLACK S/A', grp, CURRENT_DATE, n_itens * val_item, n_itens,
          'pendente_aprovacao', 'normal')
  RETURNING id INTO pid;
  FOR i IN 1..n_itens LOOP
    INSERT INTO public.pedido_compra_item
      (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha)
    VALUES (pid, i::text, 'SKU ' || grp || i, 1, 1, val_item, val_item);
  END LOOP;
  RETURN pid;
END $$;
SQL

# Regua = 5000; delta_max 0.10; cooldown 24h. Braco de auto-aprovacao LIGADO.
P -q >/dev/null <<'SQL'
INSERT INTO public.company_config (key, value) VALUES
  ('reposicao_alerta_pedido_valor_minimo', '5000'),
  ('reposicao_alerta_pedido_fornecedor_ilike', '%SAYERLACK%'),
  ('reposicao_auto_aprovacao_ativa', 'true'),
  ('reposicao_auto_aprovacao_delta_max', '0.10'),
  ('reposicao_auto_aprovacao_cooldown_falha_horas', '24')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# Duas variantes do CALLEE, geradas do corpo REAL ja aplicado. A sabotada difere
# do real EXATAMENTE num ponto: o `FOR UPDATE` do SELECT que le o pai.
# ══════════════════════════════════════════════════════════════════════════════
VAR_DIR="$(mktemp -d "/tmp/variantes-${SLUG}.XXXXXX")"
Pq -c "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reposicao_pedido_auto_aprovavel';" > "$VAR_DIR/real.sql"
sed 's/WHERE id = p_pedido_id FOR UPDATE;/WHERE id = p_pedido_id;/' "$VAR_DIR/real.sql" > "$VAR_DIR/sabotado.sql"
# A sabotagem tem de ter MUDADO alguma coisa — senao R1 mediria o corpo real e ficaria verde
# de graca ("baseline" sempre-verde aprova qualquer coisa).
if cmp -s "$VAR_DIR/real.sql" "$VAR_DIR/sabotado.sql"; then
  bad "S0 a sabotagem do callee nao alterou o corpo -- R1 nao mediria nada"
else
  ok "S0 a sabotagem do callee alterou exatamente o SELECT do pai"
fi
aplica_callee() { P -q -f "$VAR_DIR/$1.sql" >/dev/null; }

# ══════════════════════════════════════════════════════════════════════════════
# CORRIDA com barreira OBSERVADA (pg_blocking_pids), nunca `sleep`.
# A = quem remove item do pedido (a via real: remover_itens_pedido trava o pai com
#     FOR NO KEY UPDATE antes de escrever). B = o tick.
# ══════════════════════════════════════════════════════════════════════════════
B_OUT="/tmp/corrida-b-saida-tick.txt"   # CAMINHO FIXO: corrida() roda em $( ) = subshell.
BLOQ_PID=""

lancar_bloqueador() {   # $1 = pedido; $2 = quantos itens remover
  P -q >/dev/null <<SQL &
BEGIN;
DO \$u\$
BEGIN
  PERFORM 1 FROM public.pedido_compra_sugerido WHERE id = $1 FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BLOQUEADOR: pedido % inexistente', $1; END IF;
  DELETE FROM public.pedido_compra_item
   WHERE id IN (SELECT id FROM public.pedido_compra_item WHERE pedido_id = $1 ORDER BY id DESC LIMIT $2);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLOQUEADOR: nenhum item removido do pedido % -- a corrida nao mediria nada', $1;
  END IF;
  UPDATE public.pedido_compra_sugerido
     SET valor_total = (SELECT COALESCE(SUM(qtde_final * preco_unitario), 0)
                          FROM public.pedido_compra_item WHERE pedido_id = $1),
         atualizado_em = now()
   WHERE id = $1;
  PERFORM pg_advisory_xact_lock(918273647);
END
\$u\$;
DO \$w\$
BEGIN
  FOR i IN 1..2000 LOOP
    PERFORM pg_sleep(0.05);
    IF EXISTS (SELECT 1 FROM public.barreira WHERE nome = 'liberar') THEN RETURN; END IF;
  END LOOP;
  RAISE EXCEPTION 'BARREIRA: o orquestrador nunca liberou o bloqueador';
END
\$w\$;
COMMIT;
SQL
  BLOQ_PID=$!
}

esperar_A_travar() {
  local n
  for _ in $(seq 1 300); do
    n=$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND pid <> pg_backend_pid();" | tail -1)
    if [ "${n:-0}" -ge 1 ]; then echo "sim"; return; fi
    sleep 0.05
  done
  echo "nao"
}

esperar_bloqueio() {
  local n
  for _ in $(seq 1 300); do
    n=$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND cardinality(pg_blocking_pids(pid)) > 0;" | tail -1)
    if [ "${n:-0}" -ge 1 ]; then echo "sim"; return; fi
    sleep 0.05
  done
  echo "nao"
}

liberar_A() { P -q -c "INSERT INTO public.barreira VALUES ('liberar') ON CONFLICT DO NOTHING;" >/dev/null; }

campo() { Pq -c "SELECT COALESCE($2::text,'<null>') FROM public.pedido_compra_sugerido WHERE id=$1;"; }
soma()  { Pq -c "SELECT COALESCE(SUM(qtde_final*preco_unitario),0)::bigint::text FROM public.pedido_compra_item WHERE pedido_id=$1;"; }

# $1 = pedido, $2 = itens que A remove. Ecoa "<status>|<aprovado_por>|<soma_itens>|<bloqueio>"
corrida() {
  local id="$1" remover="$2" bpid visto
  : > "$B_OUT"
  P -q -c "DELETE FROM public.barreira;" >/dev/null
  lancar_bloqueador "$id" "$remover"
  if [ "$(esperar_A_travar)" != "sim" ]; then
    liberar_A; wait "$BLOQ_PID" || true
    echo "A-NAO-TRAVOU|A-NAO-TRAVOU|A-NAO-TRAVOU|A-NAO-TRAVOU"; return
  fi
  Pq -c "SELECT public.reposicao_alerta_pedido_minimo_tick();" > "$B_OUT" 2>&1 &
  bpid=$!
  visto="$(esperar_bloqueio)"
  liberar_A
  wait "$bpid" || true
  if ! wait "$BLOQ_PID"; then echo "BLOQUEADOR-FALHOU|BLOQUEADOR-FALHOU|BLOQUEADOR-FALHOU|BLOQUEADOR-FALHOU"; return; fi
  echo "$(campo "$id" status)|$(campo "$id" aprovado_por)|$(soma "$id")|$visto"
}

# Cada cenario roda sozinho: o tick varre TODOS os pendentes, e um pendente extra do mesmo
# grupo mudaria `qtd_pendentes` (o tick exige = 1) — mediria outra coisa.
limpar_pendentes() { P -q -c "DELETE FROM public.pedido_compra_sugerido WHERE status='pendente_aprovacao';" >/dev/null; }

echo "-- grupo R: a corrida (2 conexoes, barreira observada) --"
# GR: mediana 8000 (teto 8800). Pedido 2x4000 = 8000 -> elegivel. A remove 1 item -> 4000,
# ABAIXO da regua de 5000. O tick tem de recusar: o valor mudou entre decidir e gravar.
limpar_pendentes
P -q -c "SELECT public.t_mkrefs('GR', ARRAY[8000,8000,8000]::numeric[]);" >/dev/null
PID_R="$(Pq -c "SELECT public.t_mk('GR', 2, 4000);")"

aplica_callee sabotado
R1="$(corrida "$PID_R" 1)"
eq "R1 BASELINE: sem o FOR UPDATE do callee, o tick auto-aprova um pedido que caiu ABAIXO da regua" \
   "$R1" 'aprovado_aguardando_disparo|auto:sayerlack-v2|4000|sim'
# R1b: o log carimba o valor ESTAGNADO (8000) — um numero que nao existe mais apos o commit.
eq "R1b BASELINE: o log registra o valor do RETRATO (8000), nao o real (4000)" \
   "$(Pq -c "SELECT COALESCE(MAX(valor_total)::bigint::text,'<sem-log>') FROM public.reposicao_auto_aprovacao_log WHERE pedido_id=$PID_R;")" '8000'

limpar_pendentes
P -q -c "DELETE FROM public.reposicao_auto_aprovacao_log;" >/dev/null
PID_R2="$(Pq -c "SELECT public.t_mk('GR', 2, 4000);")"
aplica_callee real
R2="$(corrida "$PID_R2" 1)"
eq "R2 ABSOLVICAO: com o corpo REAL, a mesma corrida RECUSA e nao toca a linha" \
   "$R2" 'pendente_aprovacao|<null>|4000|sim'
eq "R2b ABSOLVICAO: nenhum log de auto-aprovacao foi gravado" \
   "$(Pq -c "SELECT count(*)::text FROM public.reposicao_auto_aprovacao_log WHERE pedido_id=$PID_R2;")" '0'

echo "-- grupo F: falsificacao do proprio R2 (controle: a corrida por si nao recusa) --"
# F0 CONTROLE na MESMA invocacao: o corpo real, SEM corrida, aprova o mesmo formato de pedido.
# Sem isto, um R2 vermelho por qualquer motivo (fixture, config, regua) passaria por "absolvicao".
limpar_pendentes
P -q -c "DELETE FROM public.reposicao_auto_aprovacao_log;" >/dev/null
P -q -c "SELECT public.t_mkrefs('GC', ARRAY[8000,8000,8000]::numeric[]);" >/dev/null
PID_C="$(Pq -c "SELECT public.t_mk('GC', 2, 4000);")"
P -q -c "SELECT public.reposicao_alerta_pedido_minimo_tick();" >/dev/null
eq "F0 CONTROLE: sem corrida, o corpo real APROVA este mesmo pedido" \
   "$(campo "$PID_C" status)" 'aprovado_aguardando_disparo'
if [ "$FAIL" -ne 0 ]; then
  echo "  ABORTANDO antes de F1: sem controle verde, a falsificacao nao mediria nada."
  echo; echo "=== RESULTADO: $PASS OK, $FAIL FAIL (lc_messages=$HARNESS_LC) ==="
  rm -rf "$VAR_DIR"; exit 1
fi

# F1: corrida IDENTICA a R2 — mesma barreira, mesmo lock, mesma espera — mas a remocao deixa
# o pedido AINDA acima da regua. A fronteira tem de ACEITAR. Verde aqui + verde em R2 prova
# que a recusa de R2 veio do VALOR RELIDO, e nao do mero fato de ter esperado no lock (que
# recusaria SEMPRE sob concorrencia e passaria por guard sem ser um).
limpar_pendentes
P -q -c "DELETE FROM public.reposicao_auto_aprovacao_log;" >/dev/null
P -q -c "SELECT public.t_mkrefs('GF', ARRAY[12000,12000,12000]::numeric[]);" >/dev/null
PID_F="$(Pq -c "SELECT public.t_mk('GF', 3, 4000);")"
F1="$(corrida "$PID_F" 1)"
eq "F1 falsifica R2: corrida identica que NAO cruza a regua -> o tick APROVA" \
   "$F1" 'aprovado_aguardando_disparo|auto:sayerlack-v2|8000|sim'
# F1b: e aprovou com o valor RELIDO (8000), nao com o do retrato (12000).
eq "F1b o log usa o valor RELIDO pos-commit (8000), nao o do retrato (12000)" \
   "$(Pq -c "SELECT COALESCE(MAX(valor_total)::bigint::text,'<sem-log>') FROM public.reposicao_auto_aprovacao_log WHERE pedido_id=$PID_F;")" '8000'

rm -rf "$VAR_DIR"
echo
echo "=== RESULTADO: $PASS OK, $FAIL FAIL (lc_messages=$HARNESS_LC) ==="
[ "$FAIL" -eq 0 ]
