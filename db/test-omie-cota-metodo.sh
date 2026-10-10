#!/usr/bin/env bash
# Prova PG17 da trava compartilhada do Omie — supabase/migrations/20261010204708_omie_cota_metodo.sql
#   bash db/test-omie-cota-metodo.sh > /tmp/t.log 2>&1; echo "exit=$?"
#
# Cada banco nasce do zero (stubs + a migration). A falsificação aplica uma CÓPIA sabotada da
# migration num banco novo e exige o assert correspondente VERMELHO — com o controle (a migration
# verdadeira pelo MESMO caminho) VERDE na mesma invocação, antes do 1º sed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5471}"
SLUG="omie-cota"
TMP="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMP/data"
export LC_ALL=C LANG=C
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMP/pg.log" -w start >/dev/null

MIG="$REPO_ROOT/supabase/migrations/20261010204708_omie_cota_metodo.sql"

Pd() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
Pq() { Pd "$1" -tA -q -c "$2"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# Monta um banco do zero com a migration indicada (a real ou uma cópia sabotada).
montar() {
  local db="$1" mig="$2"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$db"
  Pd "$db" -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
  # Como no Supabase: as 3 roles alcançam o schema public. Sem isto o 42501 do A11b viria do
  # SCHEMA, não do REVOKE da função — o assert passaria pelo motivo errado.
  Pd "$db" -q -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;" >/dev/null
  # Como no Supabase: service_role tem BYPASSRLS — é por isso que as funções INVOKER escrevem numa
  # tabela com RLS e sem policy. (O stub não dá; sem isto o A11c mente contra a prod.)
  Pd "$db" -q -c "ALTER ROLE service_role BYPASSRLS;" >/dev/null
  Pd "$db" -q -f "$mig" >/dev/null
}

# ── checagens reutilizadas pela prova E pela falsificação (cada uma imprime um veredito curto) ──

# Duas sessões disputando a MESMA (conta, método): A segura a transação 2 s depois de pegar a vez;
# B chega no meio. Com FOR UPDATE, B espera o lock e vê o lease de A → 'ocupado'.
# A linha JÁ EXISTE (o caso de prod depois da 1ª chamada): com a linha nova, o INSERT…ON CONFLICT
# já serializaria as duas sessões e o FOR UPDATE ficaria sem teste (medido: F1 verde).
chk_concorrencia() {
  local db="$1"
  Pd "$db" -q -c "DELETE FROM public.omie_cota_metodo;
                  INSERT INTO public.omie_cota_metodo (conta, metodo) VALUES ('oben','ListarPedidos');" >/dev/null
  ( Pd "$db" -tA -q -c "BEGIN; SELECT ok FROM public.omie_cota_tentar('oben','ListarPedidos','token-sessao-A',60); SELECT pg_sleep(2); COMMIT;" >"$TMP/a.out" 2>&1 ) &
  local pid=$!
  sleep 0.5
  local b
  b=$(Pq "$db" "SELECT ok::text || '|' || motivo FROM public.omie_cota_tentar('oben','ListarPedidos','token-sessao-B',60);")
  wait "$pid"
  echo "A=$(head -1 "$TMP/a.out") B=$b"
}

# Um "aguarde" curto que chega depois NÃO encurta o bloqueio longo já registrado.
chk_greatest() {
  local db="$1"
  Pq "$db" "DELETE FROM public.omie_cota_metodo;
            SELECT public.omie_cota_registrar_fault('colacor','ListarPedidos',1800,'bloqueio longo');
            SELECT public.omie_cota_registrar_fault('colacor','ListarPedidos',5,'aguarde curto');
            SELECT (bloqueado_ate > clock_timestamp() + interval '25 minutes')::text
              FROM public.omie_cota_metodo WHERE conta='colacor' AND metodo='ListarPedidos';" | tail -1
}

# anon/authenticated não executam nenhuma das 3 RPCs nem leem a tabela (catálogo).
chk_acl() {
  local db="$1"
  Pq "$db" "SELECT bool_or(has_function_privilege(r, f, 'EXECUTE'))::text || '|' ||
                   bool_or(has_table_privilege(r, 'public.omie_cota_metodo', 'SELECT'))::text
              FROM unnest(ARRAY['anon','authenticated']) r,
                   unnest(ARRAY['public.omie_cota_tentar(text,text,text,integer)',
                                'public.omie_cota_liberar(text,text,text)',
                                'public.omie_cota_registrar_fault(text,text,integer,text)']) f;"
}

# Durante um bloqueio, nem o DONO do lease chama.
chk_bloqueio_vence_lease() {
  local db="$1"
  Pq "$db" "DELETE FROM public.omie_cota_metodo;
            SELECT 1 FROM public.omie_cota_tentar('oben','ListarPedidos','token-dono-xx',60);
            SELECT public.omie_cota_registrar_fault('oben','ListarPedidos',30,'REDUNDANT');
            SELECT motivo FROM public.omie_cota_tentar('oben','ListarPedidos','token-dono-xx',60);" | tail -1
}

# Lease de X vence ENQUANTO B espera o lock de A: com clock_timestamp() depois do lock, B vê o lease
# vencido → 'livre'; com now() (congelado no início da transação de B) ainda o veria vivo → 'ocupado'.
chk_relogio_pos_lock() {
  local db="$1"
  Pd "$db" -q -c "DELETE FROM public.omie_cota_metodo;
                  INSERT INTO public.omie_cota_metodo (conta, metodo, ocupado_ate, ocupado_por)
                  VALUES ('oben','ListarPedidos', clock_timestamp() + interval '1 second', 'token-de-X-velho');" >/dev/null
  ( Pd "$db" -tA -q -c "BEGIN; SELECT 1 FROM public.omie_cota_metodo WHERE conta='oben' AND metodo='ListarPedidos' FOR UPDATE; SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
  local pid=$!
  sleep 0.3
  local b
  b=$(Pq "$db" "SELECT motivo FROM public.omie_cota_tentar('oben','ListarPedidos','token-sessao-B',60);")
  wait "$pid"
  echo "$b"
}

echo "═══ PROVA — migration real ═══"
montar real "$MIG"

# A1 — vez livre, renovação pelo mesmo token, recusa a outro token
Pq real "DELETE FROM public.omie_cota_metodo;" >/dev/null
eq "A1 1ª vez é livre" "$(Pq real "SELECT ok::text||'|'||motivo FROM public.omie_cota_tentar('oben','ListarPedidos','token-aaaa-1',60);")" "true|livre"
eq "A2 mesmo token renova" "$(Pq real "SELECT ok::text||'|'||motivo FROM public.omie_cota_tentar('oben','ListarPedidos','token-aaaa-1',60);")" "true|livre"
eq "A3 outro token durante o lease → ocupado" "$(Pq real "SELECT ok::text||'|'||motivo FROM public.omie_cota_tentar('oben','ListarPedidos','token-bbbb-2',60);")" "false|ocupado"

# A4 — só o dono libera
eq "A4a token alheio não libera" "$(Pq real "SELECT public.omie_cota_liberar('oben','ListarPedidos','token-bbbb-2');")" "f"
eq "A4b dono libera" "$(Pq real "SELECT public.omie_cota_liberar('oben','ListarPedidos','token-aaaa-1');")" "t"
eq "A4c liberado → outro token pega" "$(Pq real "SELECT motivo FROM public.omie_cota_tentar('oben','ListarPedidos','token-bbbb-2',60);")" "livre"
eq "A4d liberar com token NULL não libera" "$(Pq real "SELECT public.omie_cota_liberar('oben','ListarPedidos',NULL);")" "f"

# A5 — lease vence sozinho (edge que morreu no meio não trava a conta para sempre)
Pq real "DELETE FROM public.omie_cota_metodo; SELECT 1 FROM public.omie_cota_tentar('oben','ListarPedidos','token-morto-1',1);" >/dev/null
sleep 1.3
eq "A5 lease vencido → livre para outro" "$(Pq real "SELECT motivo FROM public.omie_cota_tentar('oben','ListarPedidos','token-vivo-22',60);")" "livre"

# A6 — bloqueio do Omie vence o lease, inclusive do dono
eq "A6 bloqueio vence o lease do próprio dono" "$(chk_bloqueio_vence_lease real)" "bloqueado"

# A7 — prazo só aumenta
eq "A7 aguarde curto não encurta bloqueio longo" "$(chk_greatest real)" "true"

# A8 — isolamento por conta e por método
Pq real "DELETE FROM public.omie_cota_metodo; SELECT public.omie_cota_registrar_fault('oben','ListarPedidos',600,'REDUNDANT');" >/dev/null
eq "A8a outra conta, mesmo método → livre" "$(Pq real "SELECT motivo FROM public.omie_cota_tentar('colacor','ListarPedidos','token-iso-001',60);")" "livre"
eq "A8b mesma conta, outro método → livre" "$(Pq real "SELECT motivo FROM public.omie_cota_tentar('oben','ConsultarPedido','token-iso-002',60);")" "livre"
eq "A8c a conta bloqueada segue bloqueada" "$(Pq real "SELECT motivo FROM public.omie_cota_tentar('oben','ListarPedidos','token-iso-003',60);")" "bloqueado"

# A9 — concorrência real entre duas sessões
eq "A9 sessão B espera o lock e vê o lease de A" "$(chk_concorrencia real)" "A=t B=false|ocupado"

# A10 — entradas inválidas: SQLSTATE 22023 exata; qualquer outro erro RE-LANÇA (Lei #2)
for caso in \
  "public.omie_cota_tentar('x','ListarPedidos','token-valido-1',60)|conta inválida" \
  "public.omie_cota_tentar('oben','Listar Pedidos','token-valido-1',60)|método com espaço" \
  "public.omie_cota_tentar('oben','ListarPedidos','curto',60)|token curto" \
  "public.omie_cota_tentar('oben','ListarPedidos','token-valido-1',0)|lease 0" \
  "public.omie_cota_tentar('oben','ListarPedidos','token-valido-1',301)|lease 301" \
  "public.omie_cota_registrar_fault('oben','ListarPedidos',0,'x')|bloqueio 0" \
  "public.omie_cota_registrar_fault('oben','ListarPedidos',7201,'x')|bloqueio 7201" \
  "public.omie_cota_registrar_fault(NULL,'ListarPedidos',10,'x')|conta NULL no fault"; do
  chamada="${caso%%|*}"; nome="${caso##*|}"
  r=$(Pq real "DO \$t\$ BEGIN PERFORM $chamada; RAISE NOTICE 'X'; RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SEM_ERRO_ESPERADO';
               EXCEPTION WHEN invalid_parameter_value THEN NULL; WHEN OTHERS THEN RAISE; END \$t\$; SELECT 'REJEITADO_22023';" 2>&1 || true)
  eq "A10 $nome → 22023" "$r" "REJEITADO_22023"
done

# A11 — ACL: anon/authenticated fora (catálogo), e na prática (42501 sob SET ROLE)
eq "A11a catálogo: anon/authenticated sem EXECUTE e sem SELECT" "$(chk_acl real)" "false|false"
r=$(Pq real "DO \$t\$ BEGIN SET LOCAL ROLE authenticated; PERFORM public.omie_cota_tentar('oben','ListarPedidos','token-intruso',60);
             RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SEM_ERRO_ESPERADO';
             EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN OTHERS THEN RAISE; END \$t\$; SELECT 'NEGADO_42501';" 2>&1 || true)
eq "A11b authenticated chamando tentar → 42501" "$r" "NEGADO_42501"
eq "A11c service_role executa" "$(Pq real "SET ROLE service_role; SELECT motivo FROM public.omie_cota_tentar('colacor','ConsultarPedido','token-servico-1',60);")" "livre"

# A11d/e — as outras duas RPCs também executam como service_role
eq "A11d service_role registra fault" "$(Pq real "SET ROLE service_role; SELECT (public.omie_cota_registrar_fault('colacor','ConsultarPedido',5,'x') > clock_timestamp())::text;")" "true"
eq "A11e service_role libera" "$(Pq real "SET ROLE service_role; SELECT public.omie_cota_liberar('colacor','ConsultarPedido','token-servico-1')::text;")" "true"

# A13 — relógio depois do lock: lease que vence durante a espera não bloqueia quem esperou
eq "A13 lease vencido durante a espera pelo lock → livre" "$(chk_relogio_pos_lock real)" "livre"

# A14 — liberação TARDIA do dono antigo não solta o lease do novo dono
Pq real "DELETE FROM public.omie_cota_metodo; SELECT 1 FROM public.omie_cota_tentar('oben','ListarPedidos','token-antigo-A',1);" >/dev/null
sleep 1.3
Pq real "SELECT 1 FROM public.omie_cota_tentar('oben','ListarPedidos','token-novo-B',60);" >/dev/null
eq "A14a dono antigo libera tarde → não libera" "$(Pq real "SELECT public.omie_cota_liberar('oben','ListarPedidos','token-antigo-A')::text;")" "false"
eq "A14b o novo dono segue com a vez" "$(Pq real "SELECT motivo FROM public.omie_cota_tentar('oben','ListarPedidos','token-terceiro-C',60);")" "ocupado"

# A15 — CHECK: lease sem dono (ou dono sem lease) é rejeitado com 23514
r=$(Pq real "DO \$t\$ BEGIN INSERT INTO public.omie_cota_metodo (conta, metodo, ocupado_ate) VALUES ('oben','XyzMetodo', now());
             RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SEM_ERRO_ESPERADO';
             EXCEPTION WHEN check_violation THEN NULL; WHEN OTHERS THEN RAISE; END \$t\$; SELECT 'CHECK_23514';" 2>&1 || true)
eq "A15 lease sem dono → 23514" "$r" "CHECK_23514"

# A12 — RLS ligada e sem policy
eq "A12a RLS ligada" "$(Pq real "SELECT relrowsecurity FROM pg_class WHERE oid='public.omie_cota_metodo'::regclass;")" "t"
eq "A12b nenhuma policy" "$(Pq real "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='omie_cota_metodo';")" "0"

echo
echo "═══ FALSIFICAÇÃO — controle verde pelo MESMO caminho, depois cada sabotagem VERMELHA ═══"
# Controle: a migration verdadeira copiada pelo mesmo caminho das sabotagens.
cp "$MIG" "$TMP/controle.sql"
montar controle "$TMP/controle.sql"
CTRL_CONC=$(chk_concorrencia controle); CTRL_GRT=$(chk_greatest controle)
CTRL_ACL=$(chk_acl controle); CTRL_BLQ=$(chk_bloqueio_vence_lease controle); CTRL_REL=$(chk_relogio_pos_lock controle)
if [ "$CTRL_CONC" != "A=t B=false|ocupado" ] || [ "$CTRL_GRT" != "true" ] || [ "$CTRL_ACL" != "false|false" ] || [ "$CTRL_BLQ" != "bloqueado" ] || [ "$CTRL_REL" != "livre" ]; then
  bad "CONTROLE não ficou verde ($CTRL_CONC / $CTRL_GRT / $CTRL_ACL / $CTRL_BLQ / $CTRL_REL) — falsificação abortada antes do 1º sed"
else
  ok "controle verde pelo caminho da sabotagem"

  sabotar() {  # $1 nome, $2 expressão sed; exige que o sed MUDE o arquivo
    local nome="$1" expr="$2"
    sed "$expr" "$MIG" > "$TMP/$nome.sql"
    if cmp -s "$MIG" "$TMP/$nome.sql"; then bad "F $nome: o sed não mudou nada (sabotagem inerte)"; return 1; fi
    # Sabotagem que nem monta não prova nada — conta como FALHA, nunca como pulo calado.
    if ! montar "$nome" "$TMP/$nome.sql" >"$TMP/$nome.log" 2>&1; then
      bad "F $nome: a cópia sabotada não aplicou ($(head -c 200 "$TMP/$nome.log"))"; return 1
    fi
  }

  # F1 — DUAS camadas serializam a disputa, e cada uma sozinha basta (medido, sabotando uma por vez):
  #   (a) o INSERT…ON CONFLICT DO NOTHING ESPERA a transação que está mexendo na linha (o índice
  #       único enxerga a versão em curso) e depois a sessão relê com snapshot novo;
  #   (b) o SELECT…FOR UPDATE.
  # Sem só uma delas, A9 segue verde (camada redundante — esperado); sem as duas, vermelho.
  if sabotar f1a_sem_lock 's/^   FOR UPDATE;$/   ;/'; then
    v=$(chk_concorrencia f1a_sem_lock)
    if [ "$v" = "A=t B=false|ocupado" ]; then ok "F1a só sem FOR UPDATE → A9 verde (o INSERT…ON CONFLICT serializa)"; else bad "F1a só sem FOR UPDATE e A9 vermelho ($v) — o INSERT não serializa como medido"; fi
  fi
  if sabotar f1b_sem_insert '/^  INSERT INTO public.omie_cota_metodo (conta, metodo)$/,/^  ON CONFLICT (conta, metodo) DO NOTHING;$/d'; then
    v=$(chk_concorrencia f1b_sem_insert)
    if [ "$v" = "A=t B=false|ocupado" ]; then ok "F1b só sem o INSERT → A9 verde (o FOR UPDATE serializa)"; else bad "F1b só sem o INSERT e A9 vermelho ($v) — o FOR UPDATE não serializa"; fi
  fi
  if sabotar f1c_sem_ambos 's/^   FOR UPDATE;$/   ;/; /^  INSERT INTO public.omie_cota_metodo (conta, metodo)$/,/^  ON CONFLICT (conta, metodo) DO NOTHING;$/d'; then
    v=$(chk_concorrencia f1c_sem_ambos)
    if [ "$v" != "A=t B=false|ocupado" ]; then ok "F1c sem as duas camadas → A9 vermelho ($v)"; else bad "F1c sem as duas camadas e A9 seguiu verde — assert sem dente"; fi
  fi

  # F2 — prazo substituído em vez de GREATEST: o aguarde curto encurta o bloqueio
  if sabotar f2_sem_greatest 's/GREATEST(c.bloqueado_ate, EXCLUDED.bloqueado_ate)/EXCLUDED.bloqueado_ate/'; then
    v=$(chk_greatest f2_sem_greatest)
    if [ "$v" != "true" ]; then ok "F2 sem GREATEST → A7 vermelho ($v)"; else bad "F2 sem GREATEST e A7 seguiu verde"; fi
  fi

  # F3 — REVOKE esquecido para anon (a postcondição precisa cair junto, senão a migration aborta)
  if sabotar f3_sem_revoke 's/FROM PUBLIC, anon, authenticated;/FROM authenticated;/; /POSTCONDICAO: % executável/s/RAISE EXCEPTION/RAISE NOTICE/; /POSTCONDICAO: omie_cota_metodo legível/s/RAISE EXCEPTION/RAISE NOTICE/'; then
    v=$(chk_acl f3_sem_revoke)
    if [ "$v" != "false|false" ]; then ok "F3 sem REVOKE de anon → A11a vermelho ($v)"; else bad "F3 sem REVOKE e A11a seguiu verde"; fi
  fi

  # F4 — bloqueio só para token alheio: o dono do lease chamaria durante o "aguarde"
  if sabotar f4_dono_fura 's/IF v_linha.bloqueado_ate IS NOT NULL AND v_linha.bloqueado_ate > v_agora THEN/IF v_linha.bloqueado_ate IS NOT NULL AND v_linha.bloqueado_ate > v_agora AND v_linha.ocupado_por IS DISTINCT FROM p_token THEN/'; then
    v=$(chk_bloqueio_vence_lease f4_dono_fura)
    if [ "$v" != "bloqueado" ]; then ok "F4 dono fura o bloqueio → A6 vermelho ($v)"; else bad "F4 dono fura e A6 seguiu verde"; fi
  fi

  # F6 — now() no lugar de clock_timestamp() após o lock: quem esperou vê um lease já vencido como vivo
  if sabotar f6_now 's/^  v_agora := clock_timestamp();$/  v_agora := now();/'; then
    v=$(chk_relogio_pos_lock f6_now)
    if [ "$v" != "livre" ]; then ok "F6 now() após o lock → A13 vermelho ($v)"; else bad "F6 now() e A13 seguiu verde"; fi
  fi

  # F5 — a postcondição morde E desfaz tudo: aplicada numa transação única (como o db:aplicar),
  # migration com GRANT a anon tem de ABORTAR e não deixar NADA para trás (nem a tabela).
  sed 's/^GRANT EXECUTE ON FUNCTION public.omie_cota_liberar(text, text, text) TO service_role;/&\nGRANT EXECUTE ON FUNCTION public.omie_cota_liberar(text, text, text) TO anon;/' "$MIG" > "$TMP/f5.sql"
  if cmp -s "$MIG" "$TMP/f5.sql"; then
    bad "F5: o sed não mudou nada"
  else
    "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres f5
    Pd f5 -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
    Pd f5 -q -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; ALTER ROLE service_role BYPASSRLS;" >/dev/null
    if Pd f5 -1 -q -f "$TMP/f5.sql" >"$TMP/f5.log" 2>&1; then
      bad "F5 GRANT a anon e a migration NÃO abortou — postcondição sem dente"
    elif ! grep -q "POSTCONDICAO: public.omie_cota_liberar" "$TMP/f5.log"; then
      bad "F5 abortou por OUTRO motivo: $(head -c 300 "$TMP/f5.log")"
    else
      ok "F5 GRANT a anon → postcondição abortou a migration"
      eq "F5b rollback integral: nem a tabela nem as funções ficaram" \
        "$(Pq f5 "SELECT (to_regclass('public.omie_cota_metodo') IS NULL AND to_regprocedure('public.omie_cota_tentar(text,text,text,integer)') IS NULL)::text;")" "true"
    fi
  fi

  # F7 — premissa do BYPASSRLS: sem ele a postcondição aborta (a trava não funcionaria)
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres f7
  Pd f7 -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
  Pd f7 -q -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; ALTER ROLE service_role NOBYPASSRLS;" >/dev/null
  if Pd f7 -1 -q -f "$MIG" >"$TMP/f7.log" 2>&1; then
    bad "F7 service_role sem BYPASSRLS e a migration passou"
  elif grep -q "POSTCONDICAO: service_role sem BYPASSRLS" "$TMP/f7.log"; then
    ok "F7 sem BYPASSRLS → postcondição abortou"
  else
    bad "F7 abortou por OUTRO motivo: $(head -c 300 "$TMP/f7.log")"
  fi
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
