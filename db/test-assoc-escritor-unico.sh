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
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="assoc-escritor-unico"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
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
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS DE SCHEMA (o que a migração LÊ/ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: o estado PRÉ-migration, fiel ao que a PROD tinha.
#
# Conferido em prod via psql-ro ANTES de escrever (2026-08-21):
#   · RPC `farmer_association_rules_substituir(jsonb)`: prosecdef = t (SECURITY DEFINER),
#     owner postgres, ACL `authenticated=X` + `service_role=X`.
#   · Tabela: RLS LIGADA, ACL de tabela `authenticated=arwdDxtm` (privilégio TOTAL —
#     quem segura a escrita é SÓ a policy), 1 policy `FOR ALL` com predicado
#     `has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee')`.
#   · `service_role`: rolbypassrls = true.
# O objeto SOB TESTE é a migration (aplicada de verdade na ZONA 2). Isto aqui é o cenário.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('employee','customer','master','admin');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$f$;
-- O call-site da policy passa 'master'/'employee' sem cast explícito (é como a policy VIVA
-- em prod está escrita); o enum resolve por literal desconhecido. Mantido igual de propósito.

CREATE TABLE IF NOT EXISTS public.farmer_association_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  antecedent_product_ids text[]  NOT NULL,
  consequent_product_ids text[]  NOT NULL,
  support                numeric NOT NULL DEFAULT 0,
  confidence             numeric NOT NULL DEFAULT 0,
  lift                   numeric NOT NULL DEFAULT 0,
  rule_type              text    NOT NULL DEFAULT 'association',
  cluster_segment        text,
  sample_size            integer DEFAULT 0,
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now()
);

ALTER TABLE public.farmer_association_rules ENABLE ROW LEVEL SECURITY;

-- ACL de tabela idêntico ao de prod: privilégio TOTAL para authenticated/anon. É ESTE fato
-- que torna a policy a única defesa da via PostgREST crua — e o que faz metade 2 do fence
-- ser necessária. Se este GRANT não estivesse aqui, os asserts A4-A6 passariam pelo motivo
-- ERRADO (falta de grant), não pela RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.farmer_association_rules TO authenticated, anon;
GRANT SELECT ON public.user_roles TO authenticated, anon;

-- A policy ANTIGA (FOR ALL) — o estado que a migration vem substituir.
DROP POLICY IF EXISTS "Staff can manage association rules" ON public.farmer_association_rules;
CREATE POLICY "Staff can manage association rules"
  ON public.farmer_association_rules FOR ALL
  USING (has_role(auth.uid(), 'master') OR has_role(auth.uid(), 'employee'))
  WITH CHECK (has_role(auth.uid(), 'master') OR has_role(auth.uid(), 'employee'));

-- A RPC: o que importa aqui é (a) ser SECURITY DEFINER — logo BYPASSA a RLS, que é o motivo
-- de a metade 1 do fence existir — e (b) o ACL inicial incluir `authenticated`.
CREATE OR REPLACE FUNCTION public.farmer_association_rules_substituir(p_regras jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE v_n integer;
BEGIN
  IF p_regras IS NULL OR jsonb_array_length(p_regras) = 0 THEN
    RAISE EXCEPTION 'lote vazio' USING ERRCODE = 'TR001';
  END IF;
  DELETE FROM public.farmer_association_rules WHERE true;
  INSERT INTO public.farmer_association_rules
    (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size)
  SELECT ARRAY(SELECT jsonb_array_elements_text(e->'antecedent_product_ids')),
         ARRAY(SELECT jsonb_array_elements_text(e->'consequent_product_ids')),
         (e->>'support')::numeric, (e->>'confidence')::numeric, (e->>'lift')::numeric,
         coalesce(e->>'rule_type','association'), (e->>'sample_size')::integer
  FROM jsonb_array_elements(p_regras) e;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $f$;

REVOKE ALL ON FUNCTION public.farmer_association_rules_substituir(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.farmer_association_rules_substituir(jsonb) TO authenticated, service_role;
SQL
echo "═══ ZONA 1: estado pré-migration montado ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS (antes da migration, pra o cenário PRÉ ser exercitável)
# ══════════════════════════════════════════════════════════════════════════════
MASTER='11111111-1111-1111-1111-111111111111'
EMPREGADO='22222222-2222-2222-2222-222222222222'
CLIENTE='33333333-3333-3333-3333-333333333333'
P -q <<SQL
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$MASTER','master'), ('$EMPREGADO','employee'), ('$CLIENTE','customer')
ON CONFLICT DO NOTHING;
INSERT INTO public.farmer_association_rules
  (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size)
VALUES (ARRAY['A'], ARRAY['B'], 0.0120, 0.3922, 8.59, 'association', 30239);
SQL

# ── CONTROLE DE CALIBRAÇÃO: no estado PRÉ, o browser CONSEGUIA as duas vias. Sem este
#    controle, os asserts pós-migration passariam mesmo que a via nunca tivesse existido
#    (o "detector que mede zero porque nunca foi exercido" do money-path §9).
echo "═══ CONTROLE: o buraco EXISTIA antes da migration ═══"
if P -q -c "SET ROLE authenticated; SELECT set_config('test.uid','$MASTER',false);
            SELECT public.farmer_association_rules_substituir('[{\"antecedent_product_ids\":[\"X\"],\"consequent_product_ids\":[\"Y\"],\"support\":0.5,\"confidence\":0.5,\"lift\":2,\"rule_type\":\"association\",\"sample_size\":9}]'::jsonb);" >/dev/null 2>&1
then ok "PRÉ: authenticated conseguia chamar a RPC (o buraco era real)"
else bad "PRÉ: a RPC já negava antes da migration — o cenário não reproduz a prod, asserts abaixo não valem"; fi

if P -q -c "SET ROLE authenticated; SELECT set_config('test.uid','$MASTER',false);
            INSERT INTO public.farmer_association_rules (antecedent_product_ids, consequent_product_ids) VALUES (ARRAY['P'],ARRAY['Q']);" >/dev/null 2>&1
then ok "PRÉ: staff conseguia INSERT direto pela via PostgREST crua"
else bad "PRÉ: o INSERT já era negado — cenário não reproduz a prod"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (Lei #1: psql -f no arquivo commitado, não um stub)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260820225840_farmer_assoc_rules_escritor_unico.sql"
[ -f "$MIG" ] || { echo "❌ migration não encontrada: $MIG"; exit 1; }
echo "═══ ZONA 2: aplicando a migration REAL ═══"
P -q -f "$MIG"

# Idempotência: o founder pode re-colar no SQL Editor (re-apply após falha parcial).
if P -q -f "$MIG" >/dev/null 2>&1; then ok "migration é idempotente (2ª aplicação passa)"
else bad "migration NÃO é idempotente — re-colar no SQL Editor quebraria"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
#
# Sentinela = EXIT CODE do psql, nunca uma string procurada na saída. É a defesa contra o
# teatro que o §10 documenta (um ILIKE casando a PRÓPRIA sentinela): aqui não há string a
# casar. O caminho esperado completa em silêncio; o caminho ruim RAISE-eia e o exit vira ≠0.
#
# ⚠️ NUANCE DE POSTGRES que decide a FORMA de cada assert: com RLS ligada e SEM policy para o
# comando, `INSERT` LANÇA 42501, mas `DELETE`/`UPDATE` afetam ZERO LINHAS EM SILÊNCIO. Um
# assert que só exigisse "falhou" passaria pelo motivo errado no DELETE — ele não falha,
# simplesmente não faz nada. Por isso DELETE/UPDATE são provados por SOBREVIVÊNCIA DA LINHA.
# ══════════════════════════════════════════════════════════════════════════════
echo "═══ ZONA 4: asserts ═══"

# ── A1 (positivo): o cron NÃO pode ter quebrado. service_role tem BYPASSRLS e mantém EXECUTE.
N=$(Pq -c "SET ROLE service_role; SELECT public.farmer_association_rules_substituir('[{\"antecedent_product_ids\":[\"S\"],\"consequent_product_ids\":[\"T\"],\"support\":0.012,\"confidence\":0.39,\"lift\":8.59,\"rule_type\":\"association\",\"sample_size\":30239}]'::jsonb);" | tail -1)
eq "A1 service_role (cron) ainda substitui o lote" "$N" "1"

# ── A2 (positivo): a LEITURA do staff sobrevive — é dela que vivem MixGap e cross-sell.
V=$(Pq -c "SELECT set_config('test.uid','$MASTER',false); SET ROLE authenticated; SELECT count(*) FROM public.farmer_association_rules;" | tail -1)
eq "A2 staff master ainda LÊ a tabela" "$V" "1"
V=$(Pq -c "SELECT set_config('test.uid','$EMPREGADO',false); SET ROLE authenticated; SELECT count(*) FROM public.farmer_association_rules;" | tail -1)
eq "A2b staff employee ainda LÊ a tabela" "$V" "1"

# ── A3 (negativo, metade 1 do fence): a RPC DEFINER fecha para authenticated.
#    DO/EXCEPTION com a SQLSTATE esperada e RE-RAISE no resto (Lei #2).
if P -q -c "
SET ROLE authenticated;
DO \$t\$
BEGIN
  PERFORM set_config('test.uid','$MASTER',true);
  PERFORM public.farmer_association_rules_substituir('[{\"antecedent_product_ids\":[\"Z\"],\"consequent_product_ids\":[\"W\"],\"support\":0.9,\"confidence\":0.9,\"lift\":9,\"rule_type\":\"association\",\"sample_size\":1}]'::jsonb);
  RAISE EXCEPTION 'a RPC EXECUTOU sob authenticated' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;   -- 42501: exatamente o que o REVOKE deve produzir
  WHEN OTHERS THEN RAISE;                  -- qualquer outro erro sobe (inclusive typo meu)
END \$t\$;" >/dev/null 2>&1
then ok "A3 authenticated NÃO executa a RPC (42501)"
else bad "A3 metade 1 do fence não mordeu — a RPC ainda roda pelo browser"; fi

# ── A4 (negativo, metade 2): INSERT direto. Aqui a RLS LANÇA.
if P -q -c "
SET ROLE authenticated;
DO \$t\$
BEGIN
  PERFORM set_config('test.uid','$MASTER',true);
  INSERT INTO public.farmer_association_rules (antecedent_product_ids, consequent_product_ids)
  VALUES (ARRAY['H'], ARRAY['I']);
  RAISE EXCEPTION 'o INSERT direto PASSOU' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;   -- 42501: 'new row violates row-level security policy'
  WHEN OTHERS THEN RAISE;
END \$t\$;" >/dev/null 2>&1
then ok "A4 staff NÃO insere direto (RLS nega, 42501)"
else bad "A4 metade 2 do fence não mordeu no INSERT"; fi

# ── A5 (negativo): DELETE não lança — prova-se pela SOBREVIVÊNCIA da linha.
#
# ⚠️ O `|| true` que estava aqui era um buraco (achado do challenge Codex xhigh): ele
# engolia QUALQUER erro, inclusive um typo de SQL meu. Com a linha sobrevivendo por erro de
# sintaxe, o assert passaria sem ter exercido a RLS uma única vez — o teatro que a Lei #2
# existe pra matar. Sob RLS sem policy de DELETE o comando NÃO erra: afeta 0 linhas. Então
# o certo é exigir exit 0 E a sobrevivência; se o statement errar, o teste acusa.
ANTES=$(Pq -c "SELECT count(*) FROM public.farmer_association_rules;")
if Pq -c "SELECT set_config('test.uid','$MASTER',false); SET ROLE authenticated; DELETE FROM public.farmer_association_rules;" >/dev/null 2>&1
then ok "A5a o DELETE roda sem erro (é a RLS que zera o alcance, não um typo meu)"
else bad "A5a o DELETE ERROU — o assert de sobrevivência abaixo passaria pelo motivo errado"; fi
DEPOIS=$(Pq -c "SELECT count(*) FROM public.farmer_association_rules;")
eq "A5b DELETE do staff não apaga nada (linha sobrevive)" "$DEPOIS" "$ANTES"

# ── A6 (negativo): UPDATE idem — silencioso, prova-se pelo valor INALTERADO. Mesmo cuidado.
if Pq -c "SELECT set_config('test.uid','$MASTER',false); SET ROLE authenticated; UPDATE public.farmer_association_rules SET sample_size = 1;" >/dev/null 2>&1
then ok "A6a o UPDATE roda sem erro (a RLS é que o torna inócuo)"
else bad "A6a o UPDATE ERROU — o assert de valor abaixo passaria pelo motivo errado"; fi
V=$(Pq -c "SELECT sample_size FROM public.farmer_association_rules LIMIT 1;")
eq "A6b UPDATE do staff não altera nada" "$V" "30239"

# ── A9 (negativo de ESCOPO): um `customer` não pode LER a tabela.
#
# Sem este caso, uma policy `FOR SELECT TO authenticated USING (true)` — que abriria a
# tabela para TODO usuário logado — passaria em A2, A2b e A7 sem acusar nada (achado do
# challenge Codex xhigh). A2 prova que o staff LÊ; só este prova que o predicado ainda
# DISCRIMINA por papel. `anon` (A7) não basta: ele reprova por `auth.uid()` nulo, não pelo
# papel, então uma policy `USING(true)` para authenticated o manteria em 0 do mesmo jeito.
V=$(Pq -c "SELECT set_config('test.uid','$CLIENTE',false); SET ROLE authenticated; SELECT count(*) FROM public.farmer_association_rules;" | tail -1)
eq "A9 customer logado não lê a tabela (o predicado discrimina por papel)" "$V" "0"

# ── A7 (negativo): anon segue sem nada (não regrediu para aberto).
V=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.farmer_association_rules;" | tail -1)
eq "A7 anon não lê nada" "$V" "0"

# ── A8: zero policy de ESCRITA sobrou, exatamente uma de SELECT.
V=$(Pq -c "SELECT count(*) FROM pg_policy WHERE polrelid='public.farmer_association_rules'::regclass AND polcmd <> 'r';")
eq "A8 nenhuma policy de escrita sobreviveu" "$V" "0"
V=$(Pq -c "SELECT count(*) FROM pg_policy WHERE polrelid='public.farmer_association_rules'::regclass AND polcmd = 'r';")
eq "A8b exatamente 1 policy de SELECT" "$V" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota, exige VERMELHO, restaura.
#
# Cada sabotagem ataca UMA metade do fence. Se um assert seguir verde com a metade dele
# sabotada, aquele assert não tem dente — e um fence sem dente é pior que nenhum, porque
# parece auditado. As duas metades são falsificadas SEPARADAMENTE de propósito: é isso que
# prova que NENHUMA das duas sozinha bastava (o argumento inteiro da migration).
# ══════════════════════════════════════════════════════════════════════════════
echo "═══ ZONA 5: falsificação ═══"

# ── F1: devolve o EXECUTE ao authenticated (desfaz SÓ a metade 1). A3 tem de ficar VERMELHO.
P -q -c "GRANT EXECUTE ON FUNCTION public.farmer_association_rules_substituir(jsonb) TO authenticated;"
if P -q -c "
SET ROLE authenticated;
DO \$t\$
BEGIN
  PERFORM set_config('test.uid','$MASTER',true);
  PERFORM public.farmer_association_rules_substituir('[{\"antecedent_product_ids\":[\"Z\"],\"consequent_product_ids\":[\"W\"],\"support\":0.9,\"confidence\":0.9,\"lift\":9,\"rule_type\":\"association\",\"sample_size\":1}]'::jsonb);
  RAISE EXCEPTION 'a RPC EXECUTOU sob authenticated' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE;
END \$t\$;" >/dev/null 2>&1
then bad "F1 SABOTADO e A3 seguiu VERDE — o assert A3 não tem dente"
else ok "F1 com o EXECUTE de volta, A3 fica vermelho (o assert morde)"; fi
P -q -c "REVOKE EXECUTE ON FUNCTION public.farmer_association_rules_substituir(jsonb) FROM authenticated;"

# ── F2: recria a policy FURADA (FOR ALL) — desfaz SÓ a metade 2. A4 tem de ficar VERMELHO.
P -q -c "
DROP POLICY IF EXISTS \"Staff can read association rules\" ON public.farmer_association_rules;
CREATE POLICY \"Staff can manage association rules\" ON public.farmer_association_rules FOR ALL
  USING (has_role(auth.uid(), 'master') OR has_role(auth.uid(), 'employee'))
  WITH CHECK (has_role(auth.uid(), 'master') OR has_role(auth.uid(), 'employee'));"
if P -q -c "
SET ROLE authenticated;
DO \$t\$
BEGIN
  PERFORM set_config('test.uid','$MASTER',true);
  INSERT INTO public.farmer_association_rules (antecedent_product_ids, consequent_product_ids)
  VALUES (ARRAY['H'], ARRAY['I']);
  RAISE EXCEPTION 'o INSERT direto PASSOU' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE;
END \$t\$;" >/dev/null 2>&1
then bad "F2 SABOTADO e A4 seguiu VERDE — o assert A4 não tem dente"
else ok "F2 com a policy FOR ALL de volta, A4 fica vermelho (o assert morde)"; fi

# ── F3: o BLOCO DE PÓS-VERIFICAÇÃO da própria migration tem dente?
# Deixa uma policy de escrita com OUTRO nome (que os DROP nominais não removem) e re-aplica
# a migration: ela tem de RECUSAR. Sem isto, o bloco seria decoração — o §9 do money-path
# em forma de auto-verificação: "escrever que o sensor detecta X é afirmação TESTÁVEL".
P -q -c "CREATE POLICY \"buraco_de_escrita\" ON public.farmer_association_rules FOR INSERT WITH CHECK (true);"
if P -q -f "$MIG" >/dev/null 2>&1
then bad "F3 a migration ACEITOU rodar com uma policy de escrita órfã — o bloco de pós-verificação é decoração"
else ok "F3 a migration RECUSA aplicar com policy de escrita sobrevivente (o bloco morde)"; fi

# ── F4: o RAISE deixa o banco INTEIRO ou PELA METADE? (achado do challenge Codex xhigh)
#
# F3 acima roda com `psql -f`, que é AUTOCOMMIT POR STATEMENT — ali o REVOKE e o CREATE
# POLICY já commitaram quando o bloco de verificação levanta. Isso NÃO é como o founder vai
# aplicar: o SQL Editor do Lovable manda o buffer inteiro numa mensagem só, e o PostgreSQL
# abre transação implícita — logo, ou tudo entra ou nada entra. Provar só com `-f` deixaria a
# propriedade que importa em produção SEM teste, e um apply parcial num fence de autorização
# é o pior desfecho possível (metade do fence, com cara de aplicado).
#
# Observável escolhido: devolvo o EXECUTE ao authenticated E deixo a policy órfã. Aplicando
# em transação única, a migration REVOGA e depois levanta na verificação. Se for atômico, o
# EXECUTE tem de VOLTAR a existir no fim (rollback). Se tiver commitado no meio, some.
P -q -c "GRANT EXECUTE ON FUNCTION public.farmer_association_rules_substituir(jsonb) TO authenticated;"
P -q -c "SELECT 1;" >/dev/null   # garante que o GRANT acima commitou antes do teste
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -1 -q -f "$MIG" >/dev/null 2>&1 \
  && bad "F4 a migration PASSOU em transação única com a policy órfã — a verificação não morde" \
  || ok "F4 a migration falha em transação única (como no SQL Editor)"
V=$(Pq -c "SELECT has_function_privilege('authenticated','public.farmer_association_rules_substituir(jsonb)','EXECUTE')::text;")
eq "F4b o REVOKE foi DESFEITO pelo rollback (apply é tudo-ou-nada)" "$V" "true"

P -q -c "DROP POLICY IF EXISTS \"buraco_de_escrita\" ON public.farmer_association_rules;"

# ── RESTAURA a verdade e re-prova que o estado final é o correto (cirúrgico, não git checkout:
#    em árvore suja o `git checkout --` destrói fix uncommitted — lição do §9).
P -q -f "$MIG"
V=$(Pq -c "SELECT count(*) FROM pg_policy WHERE polrelid='public.farmer_association_rules'::regclass AND polcmd <> 'r';")
eq "pós-falsificação: estado restaurado, zero policy de escrita" "$V" "0"
V=$(Pq -c "SELECT has_function_privilege('authenticated','public.farmer_association_rules_substituir(jsonb)','EXECUTE')::text;")
eq "pós-falsificação: authenticated segue sem EXECUTE" "$V" "false"

echo
echo "═══ RESULTADO: $PASS ok / $FAIL falhas ═══"
[ "$FAIL" -eq 0 ] || exit 1
