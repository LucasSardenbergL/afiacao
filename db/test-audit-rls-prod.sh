#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA O DENTE de db/audit-rls-prod.ts — a quarta guarda (RLS viva).                      ║
# ║                                                                                           ║
# ║  Sobe um PG17 descartável, monta um recorte sintético do desenho de prod (tabela de       ║
# ║  papéis + gate SECDEF + tabela money-path com policy por comando) e roda o audit REAL —   ║
# ║  o mesmo binário que aponta para produção — com PSQL_RO redirecionado para este PG.       ║
# ║  Nada de reimplementar a lógica em shell: sob teste está o executável inteiro (query,     ║
# ║  parser da saída, comparador e exit code).                                                ║
# ║                                                                                           ║
# ║  PARTE A — o audit reage (catálogo). Cada sabotagem exige o CÓDIGO certo, não só          ║
# ║  "acusou alguma coisa": POLICY_NOVA e POLICY_ALTERADA pedem correções opostas.            ║
# ║  PARTE B — o EFEITO (sob SET ROLE authenticated + GUC do JWT). Catálogo não prova         ║
# ║  alcance (database.md §1); aqui a RLS é EXERCIDA, e o cenário do DISABLE mostra que o     ║
# ║  vetor que a guarda vigia é real: o mesmo SELECT passa de 0 para 2 linhas.                ║
# ║                                                                                           ║
# ║  O contrato de teste é DERIVADO do banco no estado limpo (jsonb_object_agg) e injetado    ║
# ║  por AUTHZ_RLS_TEST_JSON — o contrato real do repo não é tocado, e o harness não quebra   ║
# ║  quando sales_orders/profiles mudarem.                                                    ║
# ║                                                                                           ║
# ║  LOCALE: as asserções casam CÓDIGO ASCII em caixa fixa, sem -i (lição #1483). Rode nos    ║
# ║  DOIS — falsificar em um ambiente só não prova a asserção:                                ║
# ║    LC_ALL=C           bash db/test-audit-rls-prod.sh ; echo $?                             ║
# ║    LC_ALL=pt_BR.UTF-8 bash db/test-audit-rls-prod.sh ; echo $?                             ║
# ║                                                                                           ║
# ║  Pré-req: brew install postgresql@17 · bun no PATH.                                        ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-audit-rls.XXXXXX")"
DATA="$TMPD/data"
OUT="$TMPD/audit-saida.txt"
WRAP="$TMPD/psql-ro-fake"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"

UID_STAFF='11111111-1111-1111-1111-111111111111'
UID_FORA='22222222-2222-2222-2222-222222222222'

# O corpo do gate mora numa variável ÚNICA, usada no setup E na restauração do cenário O.
# Não é preciosismo: a primeira versão deste harness reescreveu o corpo "igual" à mão e o md5 NÃO
# voltou — a normalização `\s+ → ' '` colapsa espaços mas não os REMOVE, então `EXISTS (\n SELECT`
# vira `EXISTS ( SELECT` e nunca é igual a `EXISTS (SELECT`. O harness estava certo e eu, errado;
# a lição virou o cenário X, que trava esse comportamento em vez de escondê-lo.
GATE_SRC="SELECT COALESCE(_uid IS NOT NULL AND EXISTS (SELECT 1 FROM public.zz_papeis WHERE user_id = _uid AND papel = 'staff'), false)"
GATE_DDL="CREATE OR REPLACE FUNCTION public.zz_gate(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS \$f\$ ${GATE_SRC} \$f\$;"
GATE_SABOTADO="CREATE OR REPLACE FUNCTION public.zz_gate(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS \$f\$ SELECT true \$f\$;"
# Mesma SEMÂNTICA do GATE_SRC, espaçamento diferente — ver o cenário X.
GATE_REFORMATADO="CREATE OR REPLACE FUNCTION public.zz_gate(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS \$f\$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.zz_papeis WHERE user_id = _uid AND papel = 'staff'),
  false) \$f\$;"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
command -v bun >/dev/null || { echo "bun ausente no PATH"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$TMPD"
}
trap cleanup EXIT

echo "── setup: PG${PGVER} em :$PORT · locale do shell LC_ALL=$LC_ALL ──"
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q "$@"; }
PT() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -tA "$@"; }

# Wrapper que o audit invoca como se fosse o psql-ro de prod. Ecoa `SET` de propósito: o psqlrc do
# psql-ro real ecoa, e o parser precisa sobreviver a linhas que não são dado.
cat > "$WRAP" <<WRAPEOF
#!/usr/bin/env bash
echo "SET"
exec "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove "\$@"
WRAPEOF
chmod +x "$WRAP"

# ── recorte sintético do desenho de prod ───────────────────────────────────────────────────
# zz_papeis   ≙ user_roles      (a raiz da autz)
# zz_gate()   ≙ has_role/cap_*  (SECDEF + search_path preso; é o que a policy CHAMA)
# zz_pedidos  ≙ sales_orders    (policy POR COMANDO, não FOR ALL)
P <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END \$\$;

CREATE SCHEMA IF NOT EXISTS auth;
-- auth.uid() como o Supabase o define: lê o GUC do JWT. O stub de db/stubs-supabase.sql devolve
-- NULL fixo, o que tornaria a PARTE B um teste de nada.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  \$f\$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid \$f\$;
-- Sem este GRANT o caller leva 42501 ao chamar auth.uid() e o harness "prova" um bloqueio que a
-- prod não tem (armadilha (b) das 3 de harness do database.md §4).
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE public.zz_papeis (user_id uuid PRIMARY KEY, papel text NOT NULL);
ALTER TABLE public.zz_papeis ENABLE ROW LEVEL SECURITY;
INSERT INTO public.zz_papeis VALUES ('$UID_STAFF','staff');

SQL
P -c "$GATE_DDL"
P <<SQL
CREATE TABLE public.zz_pedidos (id int PRIMARY KEY, dono uuid, valor numeric);
ALTER TABLE public.zz_pedidos ENABLE ROW LEVEL SECURITY;
INSERT INTO public.zz_pedidos VALUES (1,'$UID_STAFF',100),(2,'$UID_FORA',200);
CREATE POLICY zz_sel_staff ON public.zz_pedidos FOR SELECT TO authenticated
  USING ((SELECT public.zz_gate((SELECT auth.uid()))));
CREATE POLICY zz_ins_staff ON public.zz_pedidos FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.zz_gate((SELECT auth.uid()))));
GRANT SELECT, INSERT ON public.zz_pedidos TO authenticated;

-- zz_extra ≙ as 13 de cap_compras_ler que ficaram de FORA do contrato: gateada pelo mesmo
-- predicado, e deliberadamente NÃO curada. Sem ela o grupo sintético teria zero lacunas e o
-- estado limpo já nasceria acusando LACUNA_GRUPO_CURADO — o cenário mediria outra coisa.
CREATE TABLE public.zz_extra (id int PRIMARY KEY);
ALTER TABLE public.zz_extra ENABLE ROW LEVEL SECURITY;
CREATE POLICY zz_sel_extra ON public.zz_extra FOR SELECT TO authenticated
  USING ((SELECT public.zz_gate((SELECT auth.uid()))));
SQL

# ── contrato de teste, DERIVADO do estado limpo ────────────────────────────────────────────
# Derivar (em vez de hardcodar md5) é o que mantém o harness honesto entre versões do PG: o
# `pg_get_expr` re-renderiza a expressão, e um md5 fixo aqui viraria vermelho eterno no dia em que
# o PG mudasse a impressão. O DENTE não vem do cenário A ser verde — vem de B..P exigirem vermelho.
# `$1` é a expressão SQL que produz o array `grupos` (eixo 4) — o resto do contrato é o mesmo
# nas duas variantes, e duplicar esta query para trocar UMA chave seria plantar duas fontes que
# divergem na primeira edição.
derivar_json() {
  PT <<SQL
SELECT jsonb_build_object(
  'contrato', (SELECT jsonb_object_agg(t.tabela, jsonb_build_object(
                        'forceRls', t.force, 'motivo', 'sintetica do harness', 'policies', t.policies))
               FROM (SELECT n.nspname||'.'||c.relname AS tabela, c.relforcerowsecurity AS force,
                            jsonb_object_agg(p.polname, jsonb_build_object(
                              'cmd', p.polcmd::text,
                              'permissiva', p.polpermissive,
                              'roles', to_jsonb(CASE WHEN p.polroles='{0}'::oid[] THEN ARRAY['PUBLIC']
                                                     ELSE ARRAY(SELECT r.rolname FROM pg_roles r
                                                                 WHERE r.oid=ANY(p.polroles) ORDER BY 1) END),
                              'qualMd5', md5(regexp_replace(btrim(pg_get_expr(p.polqual,p.polrelid)),'\s+',' ','g')),
                              'withCheckMd5', md5(regexp_replace(btrim(pg_get_expr(p.polwithcheck,p.polrelid)),'\s+',' ','g')),
                              'motivo', 'sintetica')) AS policies
                       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                       JOIN pg_policy p ON p.polrelid=c.oid
                      WHERE n.nspname='public' AND c.relname='zz_pedidos'
                      GROUP BY 1,2) t),
  'predicados', (SELECT jsonb_object_agg(f.funcao, jsonb_build_object(
                          'secdef', f.secdef, 'cfg', f.cfg, 'srcMd5', f.src, 'motivo', 'sintetico'))
                 FROM (SELECT DISTINCT n2.nspname||'.'||pr.proname AS funcao, pr.prosecdef AS secdef,
                              coalesce(array_to_string(pr.proconfig,','),'') AS cfg,
                              md5(regexp_replace(btrim(pr.prosrc),'\s+',' ','g')) AS src
                         FROM pg_policy p
                         JOIN pg_class c ON c.oid=p.polrelid AND c.relname='zz_pedidos'
                         JOIN pg_depend d ON d.classid='pg_policy'::regclass AND d.objid=p.oid
                                         AND d.refclassid='pg_proc'::regclass
                         JOIN pg_proc pr ON pr.oid=d.refobjid
                         JOIN pg_namespace n2 ON n2.oid=pr.pronamespace
                        WHERE n2.nspname <> 'auth') f),
  'plataforma', jsonb_build_array('auth.uid'),
  'grupos', ($1))::text;
SQL
}

# Um grupo do eixo 4, medido no estado limpo: `grupo_json <tipo> <arg>`.
#
# 🔴 `ORDER BY … COLLATE "C"` não é enfeite: o md5 que o audit compara é calculado em JS
# (`md5Lista`, sort por code unit), e o `ORDER BY` do Postgres usa COLLATION — em ICU/pt_BR o `_`
# é ignorado na comparação primária e `zz_p_a` × `zz_pa` trocam de lugar. Sem o COLLATE, este
# harness casaria no locale C e reprovaria no pt_BR com o produto CORRETO: o falso-vermelho que a
# lição #1483 manda procurar rodando nos DOIS.
#
# A chave do `def` tem o mesmo nome do tipo (`predicado`/`prefixo`), que é o que deixa o
# `jsonb_build_object('tipo',$1,$1,$2)` servir aos dois sem ramo.
grupo_json() {
  local cond
  case "$1" in
    predicado) cond="EXISTS (SELECT 1 FROM pg_policy pol
                               JOIN pg_depend d ON d.classid='pg_policy'::regclass AND d.objid=pol.oid
                                               AND d.refclassid='pg_proc'::regclass
                               JOIN pg_proc pr ON pr.oid=d.refobjid
                               JOIN pg_namespace pn ON pn.oid=pr.pronamespace
                              WHERE pol.polrelid=c.oid AND pn.nspname||'.'||pr.proname='$2')" ;;
    prefixo)   cond="starts_with(c.relname,'$2')" ;;
    *) echo "grupo_json: tipo desconhecido '$1'" >&2; exit 1 ;;
  esac
  printf '%s' "SELECT jsonb_build_object(
     'def', jsonb_build_object('tipo','$1','$1','$2'),
     'tabelasNoGrafo', count(*),
     'tabelasMd5', md5(string_agg(relname, ',' ORDER BY relname COLLATE \"C\")),
     'medidoEm', '2026-08-28',
     'motivo', 'grupo sintetico do harness ($1 $2)')
   FROM (SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r' AND $cond) t"
}
# 1 ou 2 grupos. Declarar o MESMO grupo duas vezes só para preencher a assinatura faria o audit
# acusar duas vezes o mesmo objeto — ruído que o cenário leria como "acusou", sem ser o desenho.
arr() {
  if [ "$#" -eq 1 ]; then printf 'SELECT jsonb_agg(g) FROM (SELECT (%s) AS g) z' "$1"
  else printf 'SELECT jsonb_agg(g) FROM (SELECT (%s) AS g UNION ALL SELECT (%s)) z' "$1" "$2"; fi
}

# Grupo de PREDICADO: zz_gate gateia {zz_pedidos (curada), zz_extra (lacuna)}.
# Grupo de PREFIXO: `zz_p` casa {zz_papeis (lacuna), zz_pedidos (curada)} — e NÃO casa zz_extra,
# então os dois grupos medem conjuntos diferentes e uma sabotagem não move os dois de graça.
TEST_JSON="$(derivar_json "$(arr "$(grupo_json predicado public.zz_gate)" "$(grupo_json prefixo zz_p)")")"
# Variante do cenário GH: um grupo (`zz_pe`) cujo ÚNICO membro é a tabela curada. Não dá para
# produzi-la mutando o banco — ela é uma DECLARAÇÃO que virou mentira sem prod se mexer, que é
# exatamente o defeito de §7.1 um nível acima.
TEST_JSON_CURADO="$(derivar_json "$(arr "$(grupo_json prefixo zz_pe)")")"

[ -n "$TEST_JSON" ] || { echo "❌ contrato de teste veio VAZIO — o harness mediria nada"; exit 1; }
case "$TEST_JSON" in *zz_sel_staff*zz_gate*|*zz_gate*zz_sel_staff*) : ;;
  *) echo "❌ contrato de teste sem a policy ou sem o predicado: $TEST_JSON"; exit 1 ;; esac
# Sonda do eixo 4, fail-CLOSED: sem `grupos` no JSON o audit cai em `?? []` e o eixo inteiro fica
# INERTE — os cenários G* passariam a exigir vermelho de uma guarda desligada e reprovariam, mas o
# modo de falha mais discreto (derivar `grupos: null` e seguir verde) é este check que pega.
case "$TEST_JSON" in *'"grupos":'*'"tabelasMd5":'*) : ;;
  *) echo "❌ contrato de teste sem o eixo 4 (grupos/tabelasMd5): $TEST_JSON"; exit 1 ;; esac
case "$TEST_JSON_CURADO" in *'"grupos":'*'"tabelasMd5":'*) : ;;
  *) echo "❌ variante CURADO sem o eixo 4: $TEST_JSON_CURADO"; exit 1 ;; esac

run_audit() {
  local ec=0
  # `|| ec=$?` é obrigatório: sob `set -e`, o exit 1 que QUEREMOS mataria o harness antes da
  # asserção, e o teste passaria a nunca reprovar.
  PSQL_RO="$WRAP" AUTHZ_RLS_TEST_JSON="${JSON_ATUAL:-$TEST_JSON}" \
    bun "$REPO_ROOT/db/audit-rls-prod.ts" > "$OUT" 2>&1 || ec=$?
  echo "$ec"
}

PASS=0; FAIL=0
# esperar <rótulo> <exit esperado> <código que DEVE aparecer|-> <código que NÃO pode aparecer|->
esperar() {
  local rotulo="$1" ec_esperado="$2" deve="$3" nao_deve="$4" ec erro=""
  ec="$(run_audit)"
  [ "$ec" = "$ec_esperado" ] || erro="exit $ec (esperava $ec_esperado)"
  if [ "$deve" != "-" ] && ! command grep -q "\[$deve\]" "$OUT"; then erro="$erro | ausente: [$deve]"; fi
  if [ "$nao_deve" != "-" ] && command grep -q "\[$nao_deve\]" "$OUT"; then erro="$erro | presente indevido: [$nao_deve]"; fi
  if [ -z "$erro" ]; then PASS=$((PASS+1)); echo "  ✅ $rotulo"
  else FAIL=$((FAIL+1)); echo "  ❌ $rotulo — $erro"; sed 's/^/     /' "$OUT"; fi
}

# conta_como <rótulo> <sub do JWT> <esperado>  — exerce a RLS de verdade, como authenticated.
conta_como() {
  local rotulo="$1" sub="$2" esperado="$3" bruto got
  # O psql imprime a tag de CADA comando ("SET", "SET", depois o valor), então ler a saída inteira
  # como se fosse o número compara 'SET\nSET\n2' com '2' e reprova com a defesa funcionando. O
  # veredito sai com PREFIXO delimitado e é extraído por ele — o mesmo padrão do `ROW|` dos outros
  # audits, e a mesma razão: âncore no valor exato, nunca no que "sobrou" da saída.
  bruto="$(PT -c "SET ROLE authenticated; SET \"request.jwt.claim.sub\" = '$sub'; SELECT 'CONTA|'||count(*) FROM public.zz_pedidos;")"
  got="$(printf '%s\n' "$bruto" | command sed -n 's/^CONTA|//p')"
  if [ "$got" = "$esperado" ]; then PASS=$((PASS+1)); echo "  ✅ $rotulo (viu $got linha(s))"
  else FAIL=$((FAIL+1)); echo "  ❌ $rotulo — viu '$got', esperava '$esperado' [bruto: $(printf '%s' "$bruto" | tr '\n' '/')]"; fi
}

echo "── PARTE A: o audit reage (catálogo) ──"
esperar "A1 estado conforme → limpo (exit 0)" 0 - RLS_DESLIGADA
esperar "A2 estado conforme → nenhum achado de policy" 0 - POLICY_ALTERADA

P -c "ALTER TABLE public.zz_pedidos DISABLE ROW LEVEL SECURITY;"
esperar "B  DISABLE numa tabela CURADA → RLS_DESLIGADA (exit 1)" 1 RLS_DESLIGADA RLS_DESLIGADA_FORA_DO_CONTRATO
P -c "ALTER TABLE public.zz_pedidos ENABLE ROW LEVEL SECURITY;"
esperar "C  religou → a acusação SOME (exit 0)  ← dente" 0 - RLS_DESLIGADA

P -c "CREATE TABLE public.zz_outra (id int);"
esperar "D  tabela nova SEM RLS, fora do contrato → RLS_DESLIGADA_FORA_DO_CONTRATO" 1 RLS_DESLIGADA_FORA_DO_CONTRATO RLS_DESLIGADA
P -c "ALTER TABLE public.zz_outra ENABLE ROW LEVEL SECURITY;"
esperar "E  ligou a RLS dela → volta ao limpo  ← dente + controle inócuo" 0 - RLS_DESLIGADA_FORA_DO_CONTRATO

P -c "CREATE POLICY zz_backdoor ON public.zz_pedidos FOR SELECT TO authenticated USING (true);"
esperar "F  policy nova à mão → POLICY_NOVA (exit 1)" 1 POLICY_NOVA POLICY_SUMIU
P -c "DROP POLICY zz_backdoor ON public.zz_pedidos;"
esperar "G  removeu a backdoor → limpo  ← dente" 0 - POLICY_NOVA

P -c "DROP POLICY zz_sel_staff ON public.zz_pedidos;"
esperar "H  DROP de policy declarada → POLICY_SUMIU (exit 1)" 1 POLICY_SUMIU POLICY_NOVA
P -c "CREATE POLICY zz_sel_staff ON public.zz_pedidos FOR SELECT TO authenticated USING ((SELECT public.zz_gate((SELECT auth.uid()))));"
esperar "I  recriada com o MESMO DDL → limpo  ← o md5 é reproduzível" 0 - POLICY_SUMIU

P -c "ALTER POLICY zz_sel_staff ON public.zz_pedidos USING (true);"
esperar "J  USING trocado por true → POLICY_ALTERADA (exit 1)" 1 POLICY_ALTERADA POLICY_NOVA
P -c "ALTER POLICY zz_sel_staff ON public.zz_pedidos USING ((SELECT public.zz_gate((SELECT auth.uid()))));"
esperar "K  USING restaurado → limpo  ← dente" 0 - POLICY_ALTERADA

P -c "ALTER POLICY zz_sel_staff ON public.zz_pedidos TO authenticated, anon;"
esperar "L  roles ampliadas (anon) → POLICY_ALTERADA" 1 POLICY_ALTERADA -
P -c "ALTER POLICY zz_sel_staff ON public.zz_pedidos TO authenticated;"
esperar "M  roles restauradas → limpo  ← dente" 0 - POLICY_ALTERADA

# ── o achado central: o corpo do gate muda e o texto da policy NÃO ──────────────────────────
P -c "$GATE_SABOTADO"
esperar "N  gate reescrito p/ 'true' → PREDICADO_ALTERADO, e NENHUM achado de policy" 1 PREDICADO_ALTERADO POLICY_ALTERADA
P -c "$GATE_DDL"
esperar "O  gate restaurado → limpo  ← dente" 0 - PREDICADO_ALTERADO

P -c "ALTER FUNCTION public.zz_gate(uuid) RESET search_path;"
esperar "P  search_path solto no gate SECDEF → PREDICADO_ALTERADO" 1 PREDICADO_ALTERADO -
P -c "ALTER FUNCTION public.zz_gate(uuid) SET search_path = public;"
esperar "Q  search_path preso de volta → limpo  ← dente" 0 - PREDICADO_ALTERADO

# Limite DECLARADO, travado como cenário em vez de vivido como surpresa: a normalização colapsa
# espaços mas não os remove, então reformatar o corpo sem mudar a semântica MOVE o md5. É
# falso-positivo conservador (o audit manda ler), e quem renovar o md5 precisa saber disso.
P -c "$GATE_REFORMATADO"
esperar "X  gate REFORMATADO (mesma semântica) → PREDICADO_ALTERADO: o md5 é textual, não semântico" 1 PREDICADO_ALTERADO -
P -c "$GATE_DDL"
esperar "Y  formatação original de volta → limpo  ← dente" 0 - PREDICADO_ALTERADO

P -c "DROP POLICY zz_ins_staff ON public.zz_pedidos;
      CREATE POLICY zz_ins_staff ON public.zz_pedidos FOR ALL TO authenticated USING (true) WITH CHECK ((SELECT public.zz_gate((SELECT auth.uid()))));"
esperar "R  FOR ALL com WITH CHECK ≠ USING → FOR_ALL_ASSIMETRICO (a armadilha do DELETE)" 1 FOR_ALL_ASSIMETRICO -
P -c "DROP POLICY zz_ins_staff ON public.zz_pedidos;
      CREATE POLICY zz_ins_staff ON public.zz_pedidos FOR INSERT TO authenticated WITH CHECK ((SELECT public.zz_gate((SELECT auth.uid()))));"
esperar "S  split por comando de volta → limpo  ← dente" 0 - FOR_ALL_ASSIMETRICO

# ── eixo 4: a DECLARAÇÃO de lacuna em bloco ainda descreve prod? ────────────────────────────
# Nenhum destes cenários mexe em autorização: mexe no que a declaração AFIRMA. É o eixo que os
# outros três não têm como cobrir, porque eles reconciliam o contrato contra o banco e a
# declaração de não-cobertura ninguém reconciliava (§7.2 do histórico).
esperar "GA estado conforme → nenhum achado de grupo (exit 0)" 0 - LACUNA_GRUPO_MUDOU

P -c "CREATE TABLE public.zz_gateada (id int);
      ALTER TABLE public.zz_gateada ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p ON public.zz_gateada FOR SELECT TO authenticated
        USING ((SELECT public.zz_gate((SELECT auth.uid()))));"
esperar "GB migration gateia MAIS uma tabela pelo predicado do grupo → LACUNA_GRUPO_MUDOU" 1 LACUNA_GRUPO_MUDOU POLICY_NOVA
P -c "DROP TABLE public.zz_gateada;"
esperar "GC removida → a acusação SOME  ← dente" 0 - LACUNA_GRUPO_MUDOU

P -c "CREATE TABLE public.zz_prefixada (id int); ALTER TABLE public.zz_prefixada ENABLE ROW LEVEL SECURITY;"
esperar "GD tabela nova casa o PREFIXO do grupo (sem policy nenhuma) → LACUNA_GRUPO_MUDOU" 1 LACUNA_GRUPO_MUDOU RLS_DESLIGADA_FORA_DO_CONTRATO
P -c "DROP TABLE public.zz_prefixada;"
esperar "GE removida → limpo  ← dente" 0 - LACUNA_GRUPO_MUDOU

# O buraco que a contagem sozinha deixa: uma sai, outra entra, e o total não se move. Aqui o
# rename faz as duas coisas de uma vez — `zz_papeis` sai do grupo `zz_p` e `zz_papeis_novo` entra.
P -c "ALTER TABLE public.zz_papeis RENAME TO zz_papeis_novo;"
esperar "GF SUBSTITUIÇÃO: contagem IGUAL, conjunto outro → LACUNA_GRUPO_MUDOU pelo md5" 1 LACUNA_GRUPO_MUDOU -
P -c "ALTER TABLE public.zz_papeis_novo RENAME TO zz_papeis;"
esperar "GG nome de volta → limpo  ← dente (e o md5 é reproduzível)" 0 - LACUNA_GRUPO_MUDOU

# O espelho de §7.1 um nível acima: a declaração passa a mentir na direção que finge NÃO cobrir.
# A correção é OPOSTA à do MUDOU (apagar a entrada, não renovar o número), por isso o código é outro.
# `JSON_ATUAL=… esperar …` (prefixo de env numa FUNÇÃO) seria dependente de shell: bash não-POSIX
# e bash em modo POSIX discordam sobre a variável sobreviver à chamada, e o cenário GI leria o
# JSON errado em metade dos ambientes. Set/unset explícito não tem essa ambiguidade.
JSON_ATUAL="$TEST_JSON_CURADO"
esperar "GH grupo com TODAS as tabelas curadas → LACUNA_GRUPO_CURADO, não MUDOU" 1 LACUNA_GRUPO_CURADO LACUNA_GRUPO_MUDOU
unset JSON_ATUAL
esperar "GI de volta ao contrato normal → limpo  ← controle: a acusação era da DECLARAÇÃO" 0 - LACUNA_GRUPO_CURADO

# ── controles INÓCUOS: mudança real que NÃO pode acusar nada ────────────────────────────────
P -c "ALTER TABLE public.zz_pedidos ADD COLUMN observacao text;"
esperar "T  controle inócuo: coluna nova na tabela curada → segue limpo" 0 - POLICY_ALTERADA
P -c "CREATE TABLE public.zz_terceira (id int); ALTER TABLE public.zz_terceira ENABLE ROW LEVEL SECURITY;"
esperar "U  controle inócuo: tabela nova COM RLS → segue limpo" 0 - RLS_DESLIGADA_FORA_DO_CONTRATO
P -c "INSERT INTO public.zz_pedidos(id,dono,valor) VALUES (3,'$UID_FORA',300);"
esperar "V  controle inócuo: DADO novo não é mudança de autorização → segue limpo" 0 - POLICY_ALTERADA

P -c "DROP TABLE public.zz_pedidos CASCADE;"
esperar "W  tabela curada DROPADA → TABELA_AUSENTE (nunca silêncio verde)" 1 TABELA_AUSENTE -

echo "── PARTE B: o EFEITO, sob SET ROLE authenticated + GUC do JWT ──"
# Recria o alvo: a PARTE A terminou com a tabela dropada de propósito.
P <<SQL
CREATE TABLE public.zz_pedidos (id int PRIMARY KEY, dono uuid, valor numeric);
ALTER TABLE public.zz_pedidos ENABLE ROW LEVEL SECURITY;
INSERT INTO public.zz_pedidos VALUES (1,'$UID_STAFF',100),(2,'$UID_FORA',200);
CREATE POLICY zz_sel_staff ON public.zz_pedidos FOR SELECT TO authenticated
  USING ((SELECT public.zz_gate((SELECT auth.uid()))));
GRANT SELECT ON public.zz_pedidos TO authenticated;
SQL
conta_como "B1 staff (sub no gate) LÊ" "$UID_STAFF" 2
conta_como "B2 não-staff é BARRADO pela RLS" "$UID_FORA" 0

P -c "ALTER TABLE public.zz_pedidos DISABLE ROW LEVEL SECURITY;"
conta_como "B3 após o DISABLE, o não-staff vê TUDO — o vetor é real, não teórico" "$UID_FORA" 2
P -c "ALTER TABLE public.zz_pedidos ENABLE ROW LEVEL SECURITY;"
conta_como "B4 religada, o não-staff volta a ser barrado" "$UID_FORA" 0

# O gate reescrito é o outro vetor, e ele NÃO mexe em policy nenhuma: a RLS segue ligada, o texto
# do USING segue idêntico, e mesmo assim o barrado passa a ler tudo.
P -c "$GATE_SABOTADO"
conta_como "B5 gate reescrito p/ 'true': RLS ligada, policy intacta, e o barrado LÊ TUDO" "$UID_FORA" 2

echo "──────────────"
echo "RESULTADO: $PASS ok / $FAIL fail  (locale LC_ALL=$LC_ALL)"
[ "$FAIL" = 0 ] || { echo "❌ VERMELHO"; exit 1; }
echo "✅ audit-rls com DENTE: acusa DISABLE (curada e não-curada), policy nova/sumida/alterada,"
echo "   corpo e search_path do predicado, FOR ALL assimétrico e tabela ausente; reage à correção"
echo "   em cada eixo; ignora mudança inócua; e a PARTE B prova o EFEITO sob SET ROLE."
