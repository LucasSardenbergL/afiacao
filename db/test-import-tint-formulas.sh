#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — CARACTERIZAÇÃO de `import_tint_formulas` (money-path)          ║
# ║                                                                                ║
# ║  Este harness NÃO prova uma migration nova: prova que a função que está EM      ║
# ║  PRODUÇÃO HOJE é fail-OPEN. É o RED de um defeito vivo, não o GREEN de um fix.  ║
# ║                                                                                ║
# ║  Contexto: `import_tint_formulas` é o 2º (e único não-guardado) writer de       ║
# ║  `tint_formula_itens` em prod. O 1º, `tint_promote_sync_run`, ganhou o Guard 4  ║
# ║  (all-or-nothing por fórmula) nas migrations 20260717163000 + 20260718100000.   ║
# ║  Esta aqui manteve o padrão que o Guard 4 existiu para matar:                   ║
# ║      DELETE FROM tint_formula_itens WHERE formula_id = v_formula_id;  (incond.) ║
# ║      ... INSERT ... IF COALESCE((r->>'qtdNml')::numeric, 0) > 0        (filtr.) ║
# ║  ⇒ corante com qtd inválida é PULADO depois do delete ⇒ receita PARCIAL         ║
# ║    (subfaturamento silencioso) ou ZERADA (receita perdida).                     ║
# ║                                                                                ║
# ║  A FALSIFICAÇÃO aqui é INVERTIDA em relação ao harness comum: como os asserts   ║
# ║  caracterizam um DEFEITO, sabotar = CONSERTAR. Aplicamos o guard all-or-nothing ║
# ║  e exigimos que A1/A2/A3 fiquem VERMELHOS. Isso prova de uma vez que (a) os     ║
# ║  asserts têm dente e (b) o conserto proposto de fato fecha o furo.              ║
# ║                                                                                ║
# ║  Rode:  bash db/test-import-tint-formulas.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                        ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="import-tint-formulas"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# md5 do prosrc medido em PRODUÇÃO via psql-ro em 2026-08-06. O A0 compara o corpo
# aplicado aqui com este valor: sem isso, o harness poderia estar provando um corpo
# que não é o de prod (apply manual diverge do repo — §CREATE OR REPLACE do CLAUDE.md).
MD5_PROD="0aa159f8f4a63a01e8d5508eb5b8405e"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres --locale=C --encoding=UTF8 >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=localhost" -l "$DATA/log" -w start >/dev/null 2>&1

P()  { "$PGBIN/psql" -h localhost -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a função LÊ mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null

P -q <<'SQL'
-- auth.uid() lendo GUC de sessão (impersona o caller do gate de role)
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $$;

-- Tabelas do tintométrico: só as colunas que a função toca (a FUNÇÃO é que precisa ser real).
CREATE TABLE public.tint_produtos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, cod_produto text, descricao text,
  UNIQUE (account, cod_produto));
CREATE TABLE public.tint_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, id_base_sayersystem text, descricao text,
  UNIQUE (account, id_base_sayersystem));
CREATE TABLE public.tint_embalagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, id_embalagem_sayersystem text,
  descricao text, volume_ml numeric, UNIQUE (account, id_embalagem_sayersystem));
CREATE TABLE public.tint_subcolecoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, id_subcolecao_sayersystem text,
  descricao text, UNIQUE (account, id_subcolecao_sayersystem));
CREATE TABLE public.tint_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, produto_id uuid, base_id uuid,
  embalagem_id uuid, UNIQUE (account, produto_id, base_id, embalagem_id));
CREATE TABLE public.tint_corantes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, id_corante_sayersystem text,
  UNIQUE (account, id_corante_sayersystem));
CREATE TABLE public.tint_formulas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, id_seq int, cor_id text, nome_cor text,
  produto_id uuid, base_id uuid, embalagem_id uuid, subcolecao_id uuid, sku_id uuid,
  volume_final_ml numeric, preco_final_sayersystem numeric, data_geracao timestamptz,
  personalizada boolean, updated_at timestamptz DEFAULT now(),
  -- carimbo da Fase 5 (migration 20260727120000), incl. o CHECK que barra carimbo órfão
  desativada_em timestamptz, desativada_motivo text,
  CONSTRAINT tint_formulas_desativada_motivo_ck CHECK (desativada_em IS NOT NULL OR desativada_motivo IS NULL));
CREATE TABLE public.tint_formula_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), formula_id uuid, corante_id uuid, ordem int,
  qtd_ml numeric, UNIQUE (formula_id, corante_id));
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A FUNÇÃO REAL (Lei #1) — extraída verbatim da migration, sem reescrever
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260512101346_632761fc-2bd6-4caa-9c61-d35f872c2489.sql"
FN="$(mktemp "/tmp/itf-fn.XXXXXX.sql")"
sed -n '1,128p' "$MIG" > "$FN"          # linhas 1-128 = o CREATE OR REPLACE de import_tint_formulas
P -q -f "$FN"
rm -f "$FN"
echo "função aplicada: import_tint_formulas (de $(basename "$MIG"))"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),   -- staff (employee)
  ('22222222-2222-2222-2222-222222222222')    -- não-staff (customer)
ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','employee'),
  ('22222222-2222-2222-2222-222222222222','customer');

-- Os 3 corantes que a fórmula de teste usa (a função só insere item de corante JÁ cadastrado).
INSERT INTO public.tint_corantes(account, id_corante_sayersystem) VALUES
  ('oben','C1'), ('oben','C2'), ('oben','C3');
SQL

# helper: chama a RPC como staff e devolve o jsonb de retorno
chamar() { Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SELECT public.import_tint_formulas('oben', false, '$1'::jsonb);"; }
# helper: conta itens da receita da fórmula da cor informada
n_itens() { Pq -c "SELECT count(*) FROM public.tint_formula_itens i JOIN public.tint_formulas f ON f.id=i.formula_id WHERE f.cor_id='$1';"; }

echo "── asserts ──"

# ── A0 — FIDELIDADE: o corpo testado é BYTE A BYTE o de produção ────────────────
# Sem este assert, todo o resto poderia estar caracterizando uma função que não existe em prod.
MD5_LOCAL=$(Pq -c "SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='import_tint_formulas';")
eq "A0 corpo idêntico ao de PROD (md5 do prosrc)" "$MD5_LOCAL" "$MD5_PROD"

# ── A1 — RECEITA PARCIAL: 1 corante com qtd inválida ⇒ os outros 2 gravam ───────
# Cenário: a fonte manda a fórmula com 3 corantes; o 2º vem com qtd 0 (ilegível na origem).
# O esperado money-path seria REPROVAR a fórmula (precisão > recall). O que acontece: grava 2/3.
R1=$(chamar '[{"cod_produto":"P1","id_base":"B1","id_embalagem":"E1","cor_id":"COR-PARCIAL","nome_cor":"AZUL","volume_finalml":"900","preco_final":"100","corante1":"C1","qtd1ml":"10","corante2":"C2","qtd2ml":"0","corante3":"C3","qtd3ml":"30"}]')
eq "A1a fórmula gravada apesar do corante inválido" "$(n_itens COR-PARCIAL)" "2"
eq "A1b a função reporta SUCESSO (0 erros) com receita incompleta" "$(printf '%s' "$R1" | tr -d ' ' | grep -o '"errors":[0-9]*')" '"errors":0'

# ── A2 — RECEITA ZERADA: re-import todo-inválido APAGA a receita que existia ────
# O DELETE é incondicional e roda ANTES do insert filtrado: se nenhuma qtd for válida,
# a fórmula fica ativa, com preço, e SEM receita — a "receita perdida" da Regra de Ouro.
chamar '[{"cod_produto":"P1","id_base":"B1","id_embalagem":"E1","cor_id":"COR-ZERA","nome_cor":"PRETA","volume_finalml":"900","preco_final":"100","corante1":"C1","qtd1ml":"10","corante2":"C2","qtd2ml":"20","corante3":"C3","qtd3ml":"30"}]' >/dev/null
eq "A2a receita íntegra antes do re-import" "$(n_itens COR-ZERA)" "3"
# Doses 0 / negativa: passam o `::numeric` (não lançam) e reprovam no `> 0` ⇒ o DELETE
# roda e o INSERT não. É o cenário REAL da fonte, que emite `{AX=10, VM=0}` para slot
# cuja dose ficou ilegível (ver §Fase 1d, tintometrico.md).
R2=$(chamar '[{"cod_produto":"P1","id_base":"B1","id_embalagem":"E1","cor_id":"COR-ZERA","nome_cor":"PRETA","volume_finalml":"900","preco_final":"100","corante1":"C1","qtd1ml":"0","corante2":"C2","qtd2ml":"0","corante3":"C3","qtd3ml":"-5"}]')
eq "A2b re-import todo-inválido APAGOU a receita" "$(n_itens COR-ZERA)" "0"
eq "A2c e reportou sucesso (0 erros) tendo destruído a receita" "$(printf '%s' "$R2" | tr -d ' ' | grep -o '"errors":[0-9]*')" '"errors":0'
eq "A2d fórmula segue ATIVA e com preço (vende sem receita)" \
   "$(Pq -c "SELECT (desativada_em IS NULL AND preco_final_sayersystem IS NOT NULL) FROM public.tint_formulas WHERE cor_id='COR-ZERA';")" "t"

# ── A2e — FRONTEIRA do furo: lixo TEXTUAL não corrompe (proteção ACIDENTAL) ─────
# Medido, não presumido: `""::numeric` LANÇA, e o handler por-linha da função
# (`WHEN OTHERS => Error processing row`) reverte o subbloco — logo o DELETE volta atrás
# e a receita anterior sobrevive. A proteção é efeito colateral da exceção, não desenho:
# ela cobre o ilegível e deixa passar exatamente o que a fonte emite (0 / negativo).
chamar '[{"cod_produto":"P1","id_base":"B1","id_embalagem":"E1","cor_id":"COR-TEXTO","nome_cor":"CINZA","volume_finalml":"900","preco_final":"100","corante1":"C1","qtd1ml":"10","corante2":"C2","qtd2ml":"20","corante3":"C3","qtd3ml":"30"}]' >/dev/null
R2E=$(chamar '[{"cod_produto":"P1","id_base":"B1","id_embalagem":"E1","cor_id":"COR-TEXTO","nome_cor":"CINZA","volume_finalml":"900","preco_final":"100","corante1":"C1","qtd1ml":"","corante2":"C2","qtd2ml":"","corante3":"C3","qtd3ml":""}]')
eq "A2e qtd ILEGÍVEL aborta a linha e PRESERVA a receita (fail-closed acidental)" "$(n_itens COR-TEXTO)" "3"
eq "A2f e essa via SIM é contada como erro" "$(printf '%s' "$R2E" | tr -d ' ' | grep -o '"errors":[0-9]*')" '"errors":1'

# ── A3 — NaN ENTRA na receita ──────────────────────────────────────────────────
# Em numeric, NaN ordena ACIMA de tudo ⇒ `NaN > 0` é TRUE. É exatamente o C18 que o
# Guard 4 fechou no promote ("dose válida = positiva E FINITA"), e que aqui não existe.
chamar '[{"cod_produto":"P1","id_base":"B1","id_embalagem":"E1","cor_id":"COR-NAN","nome_cor":"VERDE","volume_finalml":"900","preco_final":"100","corante1":"C1","qtd1ml":"NaN"}]' >/dev/null
eq "A3 qtd_ml NaN foi GRAVADA na receita" \
   "$(Pq -c "SELECT count(*) FROM public.tint_formula_itens i JOIN public.tint_formulas f ON f.id=i.formula_id WHERE f.cor_id='COR-NAN' AND i.qtd_ml='NaN'::numeric;")" "1"

# ── A4 — MUTA o preço de linha carimbada pela Fase 5 ───────────────────────────
# As 463.995 linhas da geração '1' estão desativadas MAS seguem alimentando
# `preco_csv_legado` (rótulo "Tabela (versão anterior)") e `preco_piso_legado` (piso do
# gate `tint_gate_revalida`). A função escreve `preco_final_sayersystem` sem olhar
# `desativada_em` ⇒ alcança o preço que o balcão usa HOJE.
P -q <<'SQL'
INSERT INTO public.tint_produtos(account, cod_produto) VALUES ('oben','P9') ON CONFLICT DO NOTHING;
INSERT INTO public.tint_bases(account, id_base_sayersystem) VALUES ('oben','B9') ON CONFLICT DO NOTHING;
INSERT INTO public.tint_embalagens(account, id_embalagem_sayersystem, volume_ml) VALUES ('oben','E9', 900) ON CONFLICT DO NOTHING;
INSERT INTO public.tint_formulas(account, cor_id, produto_id, base_id, embalagem_id, preco_final_sayersystem, desativada_em, desativada_motivo)
SELECT 'oben','COR-FASE5', p.id, b.id, e.id, 260.00, now(), 'fase5_geracao_legada'
FROM public.tint_produtos p, public.tint_bases b, public.tint_embalagens e
WHERE p.cod_produto='P9' AND b.id_base_sayersystem='B9' AND e.id_embalagem_sayersystem='E9';
SQL
chamar '[{"cod_produto":"P9","id_base":"B9","id_embalagem":"E9","cor_id":"COR-FASE5","volume_finalml":"900","preco_final":"1.00"}]' >/dev/null
eq "A4a preço da linha Fase 5 foi SOBRESCRITO (260 → 1.00)" \
   "$(Pq -c "SELECT preco_final_sayersystem FROM public.tint_formulas WHERE cor_id='COR-FASE5';")" "1.00"
eq "A4b e a linha continua carimbada (a escrita não deixa rastro no carimbo)" \
   "$(Pq -c "SELECT desativada_motivo FROM public.tint_formulas WHERE cor_id='COR-FASE5';")" "fase5_geracao_legada"

# ── A5 — NEGATIVO: o gate de role MORDE (única defesa que a função tem) ─────────
# Assert negativo de verdade: captura a SQLSTATE esperada (42501) e RE-LANÇA o resto.
# Sentinela anti-teatro: 'GATE-BARROU-OK' não aparece em lugar nenhum do código sob teste.
R5=$(P -tA 2>&1 <<'SQL'
DO $$
BEGIN
  PERFORM set_config('test.uid','22222222-2222-2222-2222-222222222222', true);
  PERFORM public.import_tint_formulas('oben', false, '[{"cod_produto":"PX","id_base":"BX","id_embalagem":"EX","cor_id":"COR-DENY"}]'::jsonb);
  RAISE NOTICE 'GATE-NAO-BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'GATE-BARROU-OK';   -- 42501, o esperado
  WHEN OTHERS THEN RAISE;                                            -- qualquer outro erro sobe
END $$;
SQL
)
if printf '%s' "$R5" | grep -q 'GATE-BARROU-OK'; then ok "A5 não-staff barrado com 42501"; else bad "A5 gate de role NÃO barrou não-staff — veio: $R5"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (INVERTIDA: sabotar = CONSERTAR)
# ══════════════════════════════════════════════════════════════════════════════
# Os asserts A1/A2/A3 afirmam que a função é fail-OPEN. Se eu aplicar o guard
# all-or-nothing e eles CONTINUAREM verdes, é porque não medem nada.
# Exigimos: A1/A2/A3 VERMELHOS após o conserto, A5 (gate de role) VERDE — o conserto
# não pode ter apagado a defesa que já existia.
echo "── falsificação (aplica o guard all-or-nothing e exige que A1/A2/A3 caiam) ──"

P -q <<'SQL'
-- Guard fail-closed por FÓRMULA, espelhando o Guard 4 do tint_promote_sync_run:
-- se QUALQUER corante presente no payload não tiver dose válida (positiva E FINITA),
-- a fórmula inteira é rejeitada e a receita ANTERIOR fica intacta (nada de DELETE).
CREATE OR REPLACE FUNCTION public.import_tint_formulas_guardada(p_account text, p_personalizada boolean, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r jsonb; v_i int; v_qtd numeric; v_cor text; v_ok boolean; v_rej int := 0; v_boas jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE='42501';
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_ok := true;
    FOR v_i IN 1..6 LOOP
      v_cor := r->>('corante'||v_i::text);
      IF v_cor IS NOT NULL AND v_cor <> '' THEN
        BEGIN v_qtd := (r->>('qtd'||v_i::text||'ml'))::numeric; EXCEPTION WHEN OTHERS THEN v_qtd := NULL; END;
        -- dose válida = positiva E FINITA (NaN/Infinity fora — C18 do Guard 4)
        IF v_qtd IS NULL OR v_qtd <= 0 OR v_qtd = 'NaN'::numeric OR v_qtd = 'Infinity'::numeric THEN v_ok := false; END IF;
      END IF;
    END LOOP;
    IF v_ok THEN v_boas := v_boas || jsonb_build_array(r); ELSE v_rej := v_rej + 1; END IF;
  END LOOP;
  IF jsonb_array_length(v_boas) > 0 THEN PERFORM public.import_tint_formulas(p_account, p_personalizada, v_boas); END IF;
  RETURN jsonb_build_object('rejeitadas', v_rej);
END $$;
SQL

# re-roda A1/A2/A3 contra a versão GUARDADA
chamar_g() { Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SELECT public.import_tint_formulas_guardada('oben', false, '$1'::jsonb);"; }

chamar_g '[{"cod_produto":"P1","id_base":"B1","id_embalagem":"E1","cor_id":"F-PARCIAL","nome_cor":"AZUL","volume_finalml":"900","preco_final":"100","corante1":"C1","qtd1ml":"10","corante2":"C2","qtd2ml":"0","corante3":"C3","qtd3ml":"30"}]' >/dev/null
F1=$(n_itens F-PARCIAL)
if [ "$F1" = "2" ]; then bad "F1 INVÁLIDA — o guard não mudou A1 (ainda gravou receita parcial)"; else ok "F1 A1 caiu sob o guard (parcial não gravou: itens=$F1)"; fi

chamar_g '[{"cod_produto":"P1","id_base":"B1","id_embalagem":"E1","cor_id":"COR-ZERA","nome_cor":"PRETA","volume_finalml":"900","preco_final":"100","corante1":"C1","qtd1ml":"5","corante2":"C2","qtd2ml":"6","corante3":"C3","qtd3ml":"7"}]' >/dev/null
chamar_g '[{"cod_produto":"P1","id_base":"B1","id_embalagem":"E1","cor_id":"COR-ZERA","nome_cor":"PRETA","volume_finalml":"900","preco_final":"100","corante1":"C1","qtd1ml":"0","corante2":"C2","qtd2ml":"","corante3":"C3","qtd3ml":"-5"}]' >/dev/null
F2=$(n_itens COR-ZERA)
if [ "$F2" = "0" ]; then bad "F2 INVÁLIDA — o guard não mudou A2 (receita ainda foi apagada)"; else ok "F2 A2 caiu sob o guard (receita PRESERVADA: itens=$F2)"; fi

chamar_g '[{"cod_produto":"P1","id_base":"B1","id_embalagem":"E1","cor_id":"F-NAN","nome_cor":"VERDE","volume_finalml":"900","preco_final":"100","corante1":"C1","qtd1ml":"NaN"}]' >/dev/null
F3=$(Pq -c "SELECT count(*) FROM public.tint_formula_itens i JOIN public.tint_formulas f ON f.id=i.formula_id WHERE f.cor_id='F-NAN';")
if [ "$F3" = "1" ]; then bad "F3 INVÁLIDA — o guard não mudou A3 (NaN ainda entrou)"; else ok "F3 A3 caiu sob o guard (NaN barrado: itens=$F3)"; fi

# o conserto NÃO pode ter apagado a defesa que já existia
R5G=$(P -tA 2>&1 <<'SQL'
DO $$
BEGIN
  PERFORM set_config('test.uid','22222222-2222-2222-2222-222222222222', true);
  PERFORM public.import_tint_formulas_guardada('oben', false, '[{"cod_produto":"PX","id_base":"BX","id_embalagem":"EX","cor_id":"C-DENY2"}]'::jsonb);
  RAISE NOTICE 'GATE-NAO-BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'GATE-BARROU-OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
if printf '%s' "$R5G" | grep -q 'GATE-BARROU-OK'; then ok "F4 o guard preserva o gate de role (A5 segue verde)"; else bad "F4 o guard QUEBROU o gate de role — veio: $R5G"; fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
