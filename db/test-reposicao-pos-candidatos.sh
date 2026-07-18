#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — reposicao_pos_candidatos (detector de PO excluído, NÃO-MUTANTE)  ║
# ║  Migration: supabase/migrations/20260721190000_reposicao_pos_candidatos.sql    ║
# ║  Rode: bash db/test-reposicao-pos-candidatos.sh > /tmp/t.log 2>&1; echo $?     ║
# ║        (NÃO pipe pra tail — engole o exit code)                                 ║
# ║                                                                                ║
# ║  A  marcador fail-closed: sem run VÁLIDO → VAZIO (não classifica ninguém).      ║
# ║  B  quem é candidato: não-visto no marcador (nunca carimbado OU run anterior).  ║
# ║  C  ROTA — o guard que mudou o design: compromisso com o fornecedor NUNCA       ║
# ║     auto-cancela (o portal é acionado ANTES do Omie; prod: 281/286 protocolados).║
# ║  D  gate cron-or-staff NULL-aware (auth.role() mataria o cron SQL-local).        ║
# ║  E  TIPO: pedido_compra_sugerido.empresa é TEXT, as outras são ENUM — comparar  ║
# ║     direto quebra em RUNTIME (PL/pgSQL late-bound). Só EXECUTAR pega.            ║
# ║  Falsifica: sabota cada guard → exige VAZAMENTO (dente).                         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5477}"
SLUG="reposicao-pos-candidatos"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20260721190000_reposicao_pos_candidatos.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
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

echo "═══ setup (PG17 :$PORT) ═══"

# ── ZONA 1: schema — TIPOS FIÉIS À PROD (conferidos via psql-ro 18/07) ──
# pedido_compra_sugerido.empresa = TEXT ('OBEN'); as demais = ENUM empresa_reposicao. Essa divergência é o
# ponto E: a RPC compara as duas e text=enum quebra em runtime.
P -q <<'SQL'
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');
CREATE TABLE public.user_roles       (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $fn$;
CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT commercial_role FROM public.commercial_roles WHERE user_id=_user_id LIMIT 1 $fn$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT public.has_role(_uid,'master')
     OR (public.has_role(_uid,'employee') AND public.get_commercial_role(_uid) IN ('gerencial','estrategico','super_admin')) $fn$;

CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY,
  empresa text NOT NULL,                       -- ⚠️ TEXT em prod (não enum)
  status text NOT NULL,
  omie_pedido_compra_id text,
  data_ciclo date NOT NULL,
  fornecedor_nome text,
  canal_usado text,
  portal_protocolo text,
  status_envio_portal text,
  resposta_canal jsonb
);
CREATE TABLE public.pedido_compra_item (pedido_id bigint, sku_codigo_omie text, valor_linha numeric);
CREATE TABLE public.purchase_orders_tracking (
  empresa public.empresa_reposicao NOT NULL,   -- ⚠️ ENUM
  omie_codigo_pedido bigint NOT NULL
);
CREATE TABLE public.reposicao_pedidos_compra_run (
  run_id uuid PRIMARY KEY, seq bigint NOT NULL UNIQUE,
  empresa public.empresa_reposicao NOT NULL,
  status text NOT NULL DEFAULT 'ok', volume_ok boolean
);
CREATE TABLE public.reposicao_po_last_seen (
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  run_id uuid NOT NULL,
  PRIMARY KEY (empresa, omie_codigo_pedido)
);
INSERT INTO auth.users(id) VALUES
  ('33333333-3333-3333-3333-333333333333'),  -- master (staff)
  ('44444444-4444-4444-4444-444444444444');  -- customer (não-staff)
INSERT INTO public.user_roles(user_id, role) VALUES ('33333333-3333-3333-3333-333333333333','master');
-- Codex v11: employee SEM linha em commercial_roles -> pode_ver_carteira_completa() retorna NULL (tri-state)
INSERT INTO auth.users(id) VALUES ('66666666-6666-6666-6666-666666666666');
INSERT INTO public.user_roles(user_id, role) VALUES ('66666666-6666-6666-6666-666666666666','employee');
SQL

# ── ZONA 2: migration REAL ──
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# UUIDs DESALINHADOS de proposito: o marcador correto (maior seq) tem o MAIOR uuid, e o velho o menor.
# Com eles alinhados, o mutante `ORDER BY r.run_id ASC` passava VERDE sem provar o fencing (Codex v2 #3).
RID_ATUAL='ffffffff-ffff-ffff-ffff-ffffffffffff'
RID_VELHO='00000000-0000-0000-0000-000000000001'

# seed: 1 run VÁLIDO (marcador) + 1 run velho. Pedidos cobrindo cada combinação.
seed() {
  P -q <<SQL
TRUNCATE public.reposicao_pedidos_compra_run, public.reposicao_po_last_seen,
         public.pedido_compra_sugerido, public.pedido_compra_item, public.purchase_orders_tracking;
INSERT INTO public.reposicao_pedidos_compra_run (run_id,seq,empresa,status,volume_ok) VALUES
 ('$RID_VELHO', 10,'OBEN','ok',true),
 ('$RID_ATUAL', 20,'OBEN','ok',true),
 -- Codex PR2 #3 mutante 1: sem um run status<>'ok' de seq MAIOR, remover r.status='ok' passava VERDE.
 ('44444444-4444-4444-4444-444444444444', 30,'OBEN','erro',true),
 -- Codex PR2 #3 mutante 2: sem run de OUTRA empresa com seq MAIOR, remover r.empresa=v_empresa passava VERDE.
 ('55555555-5555-5555-5555-555555555555', 40,'COLACOR','ok',true);
-- 100 visto NO marcador (NÃO é candidato) · 101 visto em run ANTERIOR · 102 NUNCA carimbado
INSERT INTO public.reposicao_po_last_seen (empresa,omie_codigo_pedido,run_id) VALUES
 ('OBEN', 100, '$RID_ATUAL'),
 ('OBEN', 101, '$RID_VELHO'),
 ('OBEN', 126, '$RID_ATUAL'),
 ('OBEN', 138, '$RID_ATUAL'),
 ('OBEN', 1000000000000000000, '$RID_ATUAL'),
 ('OBEN', 145, '$RID_ATUAL'),
 ('OBEN', 9223372036854775807, '$RID_ATUAL'),
 ('COLACOR', 555, '$RID_VELHO');  -- PO 555 so na COLACOR  -- o 137 ('  00138  ') tem de casar por btrim+numerico  -- carimbado no marcador: o 125 ('00126') NAO pode ser candidato
INSERT INTO public.pedido_compra_sugerido
 (id,empresa,status,omie_pedido_compra_id,data_ciclo,fornecedor_nome,canal_usado,portal_protocolo,status_envio_portal,resposta_canal) VALUES
 (100,'OBEN','disparado','100', now()::date-2,'F','omie',NULL,NULL,NULL),                        -- visto: fora
 (101,'OBEN','disparado','101', now()::date-2,'F','omie',NULL,NULL,NULL),                        -- candidato (run anterior), SEM compromisso
 (102,'OBEN','disparado','102', now()::date-50,'F','omie',NULL,NULL,NULL),                       -- candidato (nunca), SEM compromisso
 (103,'OBEN','disparado','103', now()::date-50,'SAYERLACK','portal_sayerlack','2097501','sucesso_portal','{"fornecedor_notificado":true}'::jsonb), -- protocolado
 (104,'OBEN','disparado','104', now()::date-50,'SAYERLACK','portal_sayerlack',NULL,'sucesso_portal',NULL),                                          -- enviado_portal
 (105,'OBEN','disparado','105', now()::date-50,'F','email',NULL,NULL,'{"fornecedor_notificado":true}'::jsonb),                                      -- notificado
 (106,'OBEN','concluido_recebido','106', now()::date-2,'F','omie',NULL,NULL,NULL),               -- status fora do alvo
 (107,'OBEN','disparado',NULL, now()::date-2,'F','omie',NULL,NULL,NULL),                         -- sem PO
 (108,'OBEN','disparado','', now()::date-2,'F','omie',NULL,NULL,NULL),                           -- PO vazio
 (109,'COLACOR','disparado','109', now()::date-2,'F','omie',NULL,NULL,NULL),                    -- outra empresa
 -- ▼ os shapes que ESCAPAVAM na v1 (Codex PR2 #1) — todos DEVEM ir p/ reconciliacao_humana
 (110,'OBEN','disparado','110', now()::date-50,'F','portal_sayerlack',NULL,' sucesso_portal ',NULL),
 (111,'OBEN','disparado','111', now()::date-50,'F','portal_sayerlack',NULL,'SUCESSO_PORTAL',NULL),
 (112,'OBEN','disparado','112', now()::date-50,'F','omie',NULL,NULL,'{"portal":{"fornecedor_notificado":true}}'::jsonb),
 (113,'OBEN','disparado','113', now()::date-50,'F','omie',NULL,NULL,'[{"fornecedor_notificado":true}]'::jsonb),
 (114,'OBEN','disparado','114', now()::date-50,'F','omie',NULL,NULL,'{"fornecedor_notificado":" true "}'::jsonb),
 (115,'OBEN','disparado','115', now()::date-50,'F','canal_novo_desconhecido',NULL,NULL,NULL),
 (116,'OBEN','disparado','116', now()::date-50,'F',NULL,NULL,NULL,'{"portal_protocolo":"999123"}'::jsonb),
 -- ▼ escapes de PAYLOAD (Codex v2 #1): canal na allowlist, mas resposta_canal NAO reconhecida
 (117,'OBEN','disparado','117', now()::date-50,'F','omie',NULL,NULL, to_jsonb('{"fornecedor_notificado":true}'::text)), -- JSON duplamente escapado
 (118,'OBEN','disparado','118', now()::date-50,'F','omie',NULL,NULL,'{"fornecedorNotificado":true}'::jsonb),            -- camelCase
 (119,'OBEN','disparado','119', now()::date-50,'F','omie',NULL,NULL,'{"portal":{"status":"ok"}}'::jsonb),               -- aninhado desconhecido
 (120,'OBEN','disparado','120', now()::date-50,'F','omie',NULL,NULL,'{"chave_nova_do_futuro":"x"}'::jsonb),             -- vocabulario novo
 (121,'OBEN','disparado','121', now()::date-50,'F',E'\tomie\t',NULL,NULL,NULL),                                        -- canal com TAB
 (122,'OBEN','disparado','122', now()::date-50,'F','email',NULL,NULL,NULL),                                            -- mutante allowlist: email SEM payload
 (123,'OBEN','disparado','123', now()::date-50,'F','omie',NULL,'pedido_confirmado_pelo_fornecedor',NULL),
 -- Codex v3 P1-1: chave CONHECIDA com valor comprometedor (o gate de "chave conhecida" nao provava nada)
 (124,'OBEN','disparado','124', now()::date-50,'F','omie',NULL,NULL,'{"status":"pedido_aceito_pelo_fornecedor"}'::jsonb),
 -- Codex v3: leading zero — '00101' e o MESMO PO que 101 (comparacao NUMERICA, nao texto)
 (125,'OBEN','disparado','00126', now()::date-50,'F','omie',NULL,NULL,NULL),
 -- Codex v4 P1-1: os 4 NEGATIVOS que viravam evidencia FALSA (rotulo afirmava mais que o observado)
 (130,'OBEN','disparado','130', now()::date-50,'F','omie',NULL,NULL,'{"fornecedor_notificado":false}'::jsonb),
 (131,'OBEN','disparado','131', now()::date-50,'F','omie',NULL,NULL,'{"erro":"protocolo ausente"}'::jsonb),
 (132,'OBEN','disparado','132', now()::date-50,'F','omie',NULL,'sem sucesso',NULL),
 (133,'OBEN','disparado','133', now()::date-50,'F','omie','N/A',NULL,NULL),
 -- Codex v4 P1-2: canal preenchido e o resto NULL -> 'sem_sinal_conhecido' MENTIA (o canal E um sinal)
 (134,'OBEN','disparado','134', now()::date-50,'F','portal_sayerlack',NULL,NULL,NULL),
 -- Codex v4 #3 mutante: sem nenhum seed neste status, trocar `status IN (...)` por `= 'disparado'` passava verde
 (135,'OBEN','aprovado_aguardando_disparo','135', now()::date-3,'F',NULL,NULL,NULL,NULL),
 -- Codex v4 #3: 19 digitos estoura o bigint e DERRUBA a RPC (o bug que EU criei ao consertar leading zero)
 (136,'OBEN','disparado','9223372036854775808', now()::date-50,'F','omie',NULL,NULL,NULL),
 (137,'OBEN','disparado','  00138  ', now()::date-50,'F','omie',NULL,NULL,NULL),
 -- unico caso legitimo de 'sem_dado_de_canal': NENHUM dos 4 campos preenchido
 (139,'OBEN','disparado','139', now()::date-50,'F',NULL,NULL,NULL,NULL),
 -- Codex v5: limites de regex e de btrim
 (140,'OBEN','disparado','140', now()::date-50,'F','omie',NULL,'sucessor',NULL),
 (141,'OBEN','disparado','141', now()::date-50,'F',NULL,E'\t  ',NULL,NULL),
 (142,'OBEN','disparado','142', now()::date-50,'F','',NULL,NULL,NULL),
 (143,'OBEN','disparado','1000000000000000000', now()::date-50,'F','omie',NULL,NULL,NULL),
 (144,'OBEN','disparado',E'\t145\t', now()::date-50,'F','omie',NULL,NULL,NULL),
 -- Codex v6: identidade ilegivel NAO pode virar "nunca visto"
 (146,'OBEN','disparado',E'\t', now()::date-50,'F','omie',NULL,NULL,NULL),
 (147,'OBEN','disparado','12 34', now()::date-50,'F','omie',NULL,NULL,NULL),
 (148,'OBEN','disparado','00000000000000000000145', now()::date-50,'F','omie',NULL,NULL,NULL),
 (149,'OBEN','disparado', U&'\1680' || '145' || U&'\1680', now()::date-50,'F','omie',NULL,NULL,NULL),
 (150,'OBEN','disparado','9223372036854775807', now()::date-50,'F','omie',NULL,NULL,NULL),
 -- Codex v7: PO 555 esta carimbado na COLACOR (run anterior) mas NAO na OBEN -> o pedido OBEN e candidato.
 -- Sem `ls.empresa = v_empresa` o join pegaria a linha da COLACOR e o candidato sumiria.
 (151,'OBEN','disparado','555', now()::date-50,'F','omie',NULL,NULL,NULL),
 (160,'OBEN','disparado','160', now()::date-50,'F','omie',NULL,NULL,NULL),
 (161,'OBEN','disparado','161', now()::date-50,'F','omie',NULL,'su cesso',NULL),
 (162,'OBEN','disparado','00152', now()::date-50,'F','omie',NULL,NULL,NULL),
 (163,'OBEN','disparado','163', now()::date-50,'F','omie',NULL,NULL,NULL),
 (164,' OBEN ','disparado','164', now()::date-50,'F','omie',NULL,NULL,NULL),
 (165,'OBEN','disparado','165', now()::date+3,'F','omie',NULL,NULL,NULL),
 (166,'OBEN','disparado','166', now()::date-50,'F','omie',NULL,'login: sucesso',NULL),
 (167,'OBEN','disparado','167', now()::date-50,'F','omie',NULL,NULL,NULL),
 -- one-hot do OR (Codex v10): cada sinal ISOLADO tem de acender algum_sinal_de_canal
 (170,'OBEN','disparado','170', now()::date-50,'F','omie',NULL,NULL,NULL),
 (171,'OBEN','disparado','171', now()::date-50,'F',NULL,NULL,'x',NULL),
 (172,'OBEN','disparado','172', now()::date-50,'F',NULL,NULL,NULL,'{"a":1}'::jsonb),
 (173,'OBEN','disparado','173', now()::date-50,'F',NULL,'PROTO-1',NULL,NULL),
 (174,'OBEN','disparado','174', now()::date-50,'F',NULL,NULL,NULL,'null'::jsonb),
 (175,'OBEN','disparado','175', now()::date-50,'F','omie',NULL,NULL,NULL);
-- multi-item TOTALMENTE valorado: mata o mutante sum() -> max() (Codex v9)
INSERT INTO public.pedido_compra_item (pedido_id,sku_codigo_omie,valor_linha) VALUES (167,'P',10.00),(167,'Q',20.00),(175,'R',NULL),(175,'S',NULL);
-- empresa MINUSCULA armazenada: mata o mutante que remove upper() de p.empresa (Codex v9)
INSERT INTO public.pedido_compra_sugerido (id,empresa,status,omie_pedido_compra_id,data_ciclo,fornecedor_nome,canal_usado)
VALUES (168,'oben','disparado','168', now()::date-50,'F','omie');
-- varredura: 1 pedido por codepoint de whitespace do conjunto, todos cercando o PO 145 (carimbado)
INSERT INTO public.pedido_compra_sugerido (id,empresa,status,omie_pedido_compra_id,data_ciclo,fornecedor_nome,canal_usado)
SELECT 200 + row_number() OVER (), 'OBEN','disparado', chr(cp) || '145' || chr(cp), now()::date-50,'F','omie'
-- CONJUNTO COMPLETO (Codex v8): \u2000-\u200b sao 12 codepoints (8192..8203), nao 2. Semear so os extremos
-- deixava vivo o mutante "trocar o intervalo por \u2000\u200b". generate_series varre o intervalo inteiro.
FROM (SELECT unnest(ARRAY[9,10,11,12,13,32,133,160,5760,8232,8233,8239,8287,12288,65279]) AS cp
      UNION ALL SELECT generate_series(8192,8203)) AS t(cp);                               -- 'insucesso' NAO e sucesso
INSERT INTO public.pedido_compra_item (pedido_id,sku_codigo_omie,valor_linha) VALUES
 (101,'A',10.00),(160,'X',50.00),(160,'Y',NULL),(102,'B',1808.59),(103,'C',1251.89),(104,'D',5.00),(105,'E',7.00);
INSERT INTO public.purchase_orders_tracking (empresa,omie_codigo_pedido) VALUES
 ('OBEN',101), ('OBEN',152), ('COLACOR',163);  -- 152: identidade canonica ('00152'); 163: so na COLACOR
SQL
}
seed

cand() { Pq -c "SELECT string_agg(pedido_id::text, ',' ORDER BY pedido_id) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1; }
campo() { Pq -c "SELECT $2 FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=$1;" | tail -1; }

echo "── Bloco E: TIPO (text × enum) — só EXECUTAR pega (PL/pgSQL é late-bound) ──"
R=$(P -tA 2>&1 <<'SQL' || true
SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');
SQL
)
case "$R" in
  *"operator does not exist"*|*"does not exist"*|*ERROR*) bad "E1 a RPC QUEBROU em runtime: $R";;
  *) ok "E1 a RPC EXECUTA com empresa TEXT × ENUM (comparação com cast explícito)";;
esac
eq "E2 aceita a empresa em caixa/espaço divergentes (upper+btrim)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('  oben ');" | tail -1)" "49"

echo "── Bloco B: quem é candidato ──"
eq "B1 candidatos = todos os não-vistos no marcador" "$(cand)" "101,102,103,104,105,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,130,131,132,133,134,135,136,139,140,141,142,146,147,151,160,161,162,163,164,165,166,167,168,170,171,172,173,174,175"
eq "B2 PO visto NO marcador NÃO é candidato (100 fora)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=100;" | tail -1)" "0"
eq "B3 visto em run ANTERIOR é candidato, marcado como tal" "$(campo 101 visto_status)" "visto_em_outro_run"
eq "B4 NUNCA carimbado é candidato, marcado como tal" "$(campo 102 visto_status)" "sem_registro_last_seen"
eq "B5 status fora do alvo (concluido_recebido) não entra" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=106;" | tail -1)" "0"
eq "B6 pedido sem PO / PO vazio não entra" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id IN (107,108);" | tail -1)" "0"
eq "B7 outra EMPRESA não vaza (109 é COLACOR)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=109;" | tail -1)" "0"
eq "B8 na_janela_7d = janela 7d do em_transito (101 recente)" "$(campo 101 na_janela_7d)" "t"
eq "B9 na_janela_7d falso fora da janela (102, 50d)" "$(campo 102 na_janela_7d)" "f"
eq "B10 po_no_espelho reflete o tracking (101 tem linha)" "$(campo 101 po_no_espelho)" "t"
eq "B11 po_no_espelho falso quando o PO sumiu do espelho (102)" "$(campo 102 po_no_espelho)" "f"

echo "── Bloco C: EVIDENCIA de compromisso (a RPC evidencia, NAO decide) ──"

echo "── Bloco C2: rotulos FACTUAIS — nao afirmar mais que o observado (Codex v4/v5) ──"
# valor FALSE: o rotulo factual "a resposta MENCIONA notificacao" continua VERDADEIRO (a chave esta la) e
# nao engana — diferente do antigo 'notificado', que afirmava o fato. E o que o Codex pediu: descrever o
# observado. O consumidor (humano/PR3) le "menciona" e sabe que precisa olhar o valor.

echo "── Bloco J: identidade do PO (numerica, robusta) ──"
eq "J2 aprovado_aguardando_disparo E candidato (mata o mutante status IN -> =)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=135;" | tail -1)" "1"
eq "J3 PO fora do range NAO derruba a RPC (overflow do bigint)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=136;" | tail -1)" "1"
# ⚠️ o assert ANTIGO parava aqui e FIXAVA o falso-positivo: identidade ilegivel virava 'nunca_carimbado',
# afirmando ausencia que a RPC nao pode provar (Codex v6 P1). Agora exige o estado EXPLICITO.
eq "J3b identidade ilegivel -> 'identidade_nao_interpretavel' (NAO 'nunca_carimbado')" "$(campo 136 visto_status)" "identidade_nao_interpretavel"
eq "J7 PO so com TAB -> identidade nao interpretavel (nao afirma ausencia)" "$(campo 146 visto_status)" "identidade_nao_interpretavel"
eq "J8 whitespace INTERNO invalida a identidade (senao '12 34' colidiria com 1234)" "$(campo 147 visto_status)" "identidade_nao_interpretavel"
eq "J9 leading zeros LONGOS ('00..00145') casam o PO 145 -> NAO e candidato" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=148;" | tail -1)" "0"
eq "J10 U+1680 nas bordas nao quebra a identidade" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=149;" | tail -1)" "0"
eq "J4 PO com espacos ('  00138  ') casa o carimbado 138 -> NAO e candidato" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=137;" | tail -1)" "0"
eq "J5 PO de 19 digitos VALIDO (1e18) casa o carimbado -> NAO e candidato (Codex v5)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=143;" | tail -1)" "0"
eq "J6 PO com TAB casa o carimbado (btrim nao remove TAB — Codex v5)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=144;" | tail -1)" "0"

echo "── Bloco K: identidade ilegivel NAO afirma ausencia + varredura de mutantes (Codex v7) ──"
eq "K1 identidade ilegivel -> po_no_espelho NULL (nao FALSE: a RPC nao apurou)" "$(Pq -c "SELECT COALESCE(po_no_espelho::text,'NULL') FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=147;" | tail -1)" "NULL"
eq "K2 identidade LEGIVEL segue afirmando o espelho (nao virou NULL p/ todo mundo)" "$(campo 101 po_no_espelho)" "t"
eq "K3 PO MAXIMO exato (9223372036854775807) e legivel — mata o mutante > -> >=" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=150;" | tail -1)" "0"
# VARREDURA do conjunto de whitespace: cada codepoint cercando o PO 145 (carimbado) tem de casar. Escolher
# 2 chars a dedo deixava vivo o mutante "remover o char X" (Codex v7). Aqui a classe inteira e coberta.
eq "K4 TODOS os codepoints de whitespace do conjunto casam a identidade (varredura, nao amostra)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id BETWEEN 200 AND 299;" | tail -1)" "0"
eq "K5 cross-empresa: PO 555 visto na COLACOR nao serve p/ a OBEN (mata o mutante ls.empresa)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=151;" | tail -1)" "1"

echo "── Bloco L: dentes que faltavam (Codex v8) ──"
eq "L1 valor_total NULL quando algum item nao tem valor (nao apresenta subtotal como total)" "$(Pq -c "SELECT COALESCE(valor_total::text,'NULL') FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=160;" | tail -1)" "NULL"
eq "L2 itens_sem_valor diz POR QUE o total e NULL" "$(campo 160 itens_sem_valor)" "1"
eq "L3 valor_total existe quando TODOS os itens tem valor" "$(campo 101 valor_total)" "10.00"
eq "L3b valor_total SOMA (mata o mutante sum -> max: itens 10 e 20 = 30, nao 20)" "$(campo 167 valor_total)" "30.00"
eq "L9 empresa MINUSCULA armazenada nao some (mata o mutante que remove upper)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=168;" | tail -1)" "1"
eq "L5 espelho usa a identidade CANONICA ('00152' casa o tracking 152)" "$(campo 162 po_no_espelho)" "t"
eq "L6 espelho e POR EMPRESA (tracking COLACOR/163 nao serve p/ a OBEN)" "$(campo 163 po_no_espelho)" "f"
eq "L7 p.empresa com espacos (' OBEN ') NAO some da lista" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=164;" | tail -1)" "1"
eq "L8 data_ciclo FUTURA nao vira na_janela_7d (idade negativa)" "$(campo 165 na_janela_7d)" "f"

echo "── Bloco M: FATOS binarios no lugar da regex semantica (Codex v9) ──"
eq "M1 protocolo preenchido -> tem_protocolo" "$(campo 103 tem_protocolo)" "t"
eq "M2 protocolo so com whitespace NAO conta" "$(campo 141 tem_protocolo)" "f"
eq "M3 'su cesso' e 'sem sucesso' sao apenas tem_status_portal (sem interpretar)" "$(campo 161 tem_status_portal)$(campo 132 tem_status_portal)" "tt"
eq "M4 'login: sucesso' (falso-negativo da guarda) agora e so um fato" "$(campo 166 tem_status_portal)" "t"
eq "M5 resposta_canal presente -> tem_resposta_canal" "$(campo 112 tem_resposta_canal)" "t"
eq "M6 canal vazio NAO conta como canal" "$(campo 142 tem_canal)" "f"
eq "M7 algum_sinal_de_canal = OR dos 4 (103 tem tudo)" "$(campo 103 algum_sinal_de_canal)" "t"
eq "M8 SEM nenhum campo -> algum_sinal_de_canal falso (o unico caso honesto)" "$(campo 139 algum_sinal_de_canal)" "f"

echo "── Bloco N: mutantes do Codex v10 (identidade retornada, one-hot do OR, correlacao) ──"
eq "N1 a IDENTIDADE retornada e o PO, nao o pedido_id (nenhum assert lia essa coluna)" "$(campo 101 omie_codigo_pedido)" "101"
eq "N2 identidade retornada preserva o texto CRU ('00152', nao 152)" "$(campo 162 omie_codigo_pedido)" "00152"
# ONE-HOT: sem estes, remover ramos do OR passava verde (M7 tinha tudo, M8 nada — nenhum caso isolado)
eq "N3 one-hot SO canal -> algum_sinal true" "$(campo 170 algum_sinal_de_canal)" "t"
eq "N4 one-hot SO status -> algum_sinal true" "$(campo 171 algum_sinal_de_canal)" "t"
eq "N5 one-hot SO resposta -> algum_sinal true" "$(campo 172 algum_sinal_de_canal)" "t"
eq "N6 one-hot SO protocolo -> algum_sinal true" "$(campo 173 algum_sinal_de_canal)" "t"
eq "N7 JSON null ('null'::jsonb) NAO e resposta presente" "$(campo 174 tem_resposta_canal)" "f"
eq "N8 JSON null tambem nao vira algum_sinal (com os outros vazios)" "$(campo 174 algum_sinal_de_canal)" "f"
# CORRELACAO: 2 pedidos com item NULL em quantidades DIFERENTES matam a subquery sem WHERE pedido_id
eq "N9 itens_sem_valor e POR PEDIDO (2 nulos aqui)" "$(campo 175 itens_sem_valor)" "2"
eq "N10 pedido SEM item nulo tem itens_sem_valor=0 (mata a subquery descorrelacionada)" "$(campo 167 itens_sem_valor)" "0"
eq "N11 campos CRUS retornados: 'sucesso' e 'sem sucesso' sao distinguiveis" "$(campo 104 status_envio_portal)|$(campo 132 status_envio_portal)" "sucesso_portal|sem sucesso"

echo "── Bloco O: BYPASS do gate por NULL + campos crus (Codex v11) ──"
# pode_ver_carteira_completa() e TRI-STATE: employee SEM commercial_role retorna NULL. Com `NOT NULL` = NULL
# o IF nao entrava e a SECURITY DEFINER entregava TUDO. Este e o unico furo de SEGURANCA do PR.
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid='66666666-6666-6666-6666-666666666666';
DO $$ BEGIN PERFORM * FROM public.reposicao_pos_candidatos('OBEN'); RAISE EXCEPTION 'BYPASS';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'DENY_OK'; END $$;
SQL
)
case "$R" in *DENY_OK*) ok "O1 employee SEM commercial_role (role NULL) e BARRADO — sem bypass por tri-state";; *) bad "O1 BYPASS: $R";; esac
eq "O2 campo cru portal_protocolo e retornado (mata b.portal_protocolo -> NULL::text)" "$(campo 103 portal_protocolo)" "2097501"
eq "O3 campo cru resposta_canal e retornado (mata b.resposta_canal -> NULL::jsonb)" "$(Pq -c "SELECT (resposta_canal->>'fornecedor_notificado') FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=103;" | tail -1)" "true"

echo "── Bloco A: marcador FAIL-CLOSED ──"
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=false;" >/dev/null
eq "A1 sem run VÁLIDO (todos truncados) → VAZIO (não classifica ninguém)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "0"
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=NULL;" >/dev/null
eq "A2 só bootstrap (volume_ok NULL) → VAZIO" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "0"
P -q -c "TRUNCATE public.reposicao_pedidos_compra_run;" >/dev/null
eq "A3 nenhum run → VAZIO" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "0"
seed
eq "A4 o marcador é o de MAIOR seq (fencing), não o mais antigo" "$(campo 101 marcador_seq)" "20"

echo "── Bloco D: gate cron-or-staff NULL-aware ──"
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid='44444444-4444-4444-4444-444444444444';
DO $$ BEGIN PERFORM * FROM public.reposicao_pos_candidatos('OBEN'); RAISE EXCEPTION 'PASSOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'DENY_OK'; END $$;
SQL
)
case "$R" in *DENY_OK*) ok "D1 authenticated NÃO-staff é barrado (42501)";; *) bad "D1 — veio: $R";; esac
eq "D2 staff (master) enxerga" "$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "49"
eq "D3 uid NULL (service_role / cron SQL-local) passa — auth.role() aqui MATARIA o cron" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "49"

# ══════════════════════════════════════════════════════════════════════════════
echo "── FALSIFICAÇÃO ──"
# Sabota a MIGRATION REAL (sed no arquivo), nao uma copia manual — a copia nao cobria os predicados do
# marcador (Codex PR2 #3: 2 mutantes passavam verdes).
saboto_real()  { sed "$1" "$MIG" | P -q -f - ; }
saboto_real2() { sed -e "$1" -e "$2" "$MIG" | P -q -f - ; }

saboto_real "s/AND r.status = 'ok' AND r.volume_ok IS TRUE/AND r.volume_ok IS TRUE/"
V=$(campo 101 marcador_seq)
case "$V" in 30) ok "F4 sem status='ok' o run com ERRO vira marcador — H1 tem dente";; *) bad "F4 nao vazou (marcador=$V)";; esac
P -q -f "$MIG" >/dev/null

saboto_real "s/WHERE r.empresa = v_empresa AND r.status/WHERE r.status/"
V=$(campo 101 marcador_seq)
case "$V" in 40) ok "F5 sem filtro de empresa o run COLACOR vira marcador da OBEN — H1 tem dente";; *) bad "F5 nao vazou (marcador=$V)";; esac
P -q -f "$MIG" >/dev/null



# F2 — sem exigir volume_ok, um run TRUNCADO vira base de verdade.
saboto_real "s/AND r.status = 'ok' AND r.volume_ok IS TRUE/AND r.status = 'ok'/"
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=false WHERE seq=20;" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)
case "$V" in 0) bad "F2 nao vazou (esperava >0)";; *) ok "F2 sem volume_ok, run TRUNCADO vira base ($V candidatos) — A1 tem dente";; esac
P -q -f "$MIG" >/dev/null; seed

# F3 — gate por auth.role() (em vez de uid NULL-aware) MATA o cron SQL-local.
saboto_real2 "s/IF (SELECT auth.uid()) IS NOT NULL/IF auth.role() IS DISTINCT FROM 'service_role' THEN --/" "s/AND (SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))) IS NOT TRUE THEN//"
R=$(P -tA 2>&1 <<'SQL' || true
DO $$ BEGIN PERFORM * FROM public.reposicao_pos_candidatos('OBEN'); RAISE NOTICE 'CRON_OK';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'CRON_MORREU'; END $$;
SQL
)
case "$R" in *CRON_MORREU*) ok "F3 gate por auth.role() MATA o cron (uid NULL) — D3 tem dente";; *) bad "F3 nao vazou ($R)";; esac
P -q -f "$MIG" >/dev/null

# F6 — ordenar o marcador por run_id em vez de seq (o mutante que passava verde com UUIDs alinhados).
# usa o 102 (NUNCA carimbado => candidato sob QUALQUER marcador) p/ a evidencia ser DIRETA: o seq muda.
saboto_real "s/ORDER BY r.seq DESC/ORDER BY r.run_id ASC/"
V=$(campo 102 marcador_seq)
case "$V" in 20) bad "F6 nao vazou (marcador ainda seq=20)";; "") bad "F6 inconclusivo (sem linha)";; *) ok "F6 ordenar por run_id escolhe o marcador ERRADO (seq=$V, nao 20) — o fencing por seq tem dente";; esac
P -q -f "$MIG" >/dev/null



# F9 — o BYPASS por tri-state: voltando p/ `NOT (...)`, o employee sem commercial_role (role NULL) passa.
saboto_real "s/IS NOT TRUE THEN/IS NOT TRUE OR TRUE THEN/"
P -q -f "$MIG" >/dev/null   # (restaura antes: a sabotagem acima e no sentido oposto, so p/ garantir estado)
saboto_real "s/AND (SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))) IS NOT TRUE THEN/AND NOT (SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))) THEN/"
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid='66666666-6666-6666-6666-666666666666';
DO $$ BEGIN PERFORM * FROM public.reposicao_pos_candidatos('OBEN'); RAISE NOTICE 'BYPASS_VAZOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AINDA_BARRA'; END $$;
SQL
)
case "$R" in *BYPASS_VAZOU*) ok "F9 com NOT(...) o employee-role-NULL ENTRA (bypass) — O1 tem dente";; *) bad "F9 nao vazou ($R)";; esac
P -q -f "$MIG" >/dev/null

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "✅ HARNESS VERDE" || { echo "❌ HARNESS VERMELHO"; exit 1; }
