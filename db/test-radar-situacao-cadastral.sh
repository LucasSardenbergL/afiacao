#!/usr/bin/env bash
# Prova PG17 da SITUAÇÃO CADASTRAL (RFB) do Radar — migration 20261019200000_radar_situacao_cadastral:
# `radar_aplicar_situacao(p_lote, p_agora)` (chamada pela edge no finalize) descarta LEAD com situação
# 03/04/08, abre UM fornecedor_alerta por lote para CLIENTE irregular visto pela 1ª vez (com denominador)
# e nunca repete o aviso do mesmo (cnpj, situacao); situação 02 não muda estado; cliente FORA do radar
# também é coberto; lote mais velho que a foto conhecida não regride nem descarta. Relógio controlado
# por `p_agora` (dado parado). `radar_docs_clientes()` é espelho de `radar_recruzar_ja_cliente()`
# (20261019150000) — a prova compara os dois conjuntos num seed com máscara, cru e alfanumérico.
# Esquema mínimo com os MESMOS CHECKs de prod (radar_empresas, radar_contatos, fornecedor_alerta).
#
#   bash db/test-radar-situacao-cadastral.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-situacao-cadastral.sh   # tem de ficar VERMELHA
#   bash db/test-radar-situacao-cadastral.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261019200000_radar_situacao_cadastral.sql"
MIG_RECRUZAR="$REPO_ROOT/supabase/migrations/20261019150000_radar_recruzar_mascara_exata.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `post:A7` = a POSTCONDIÇÃO da própria migration (DO $post$)
  # aborta o apply antes de qualquer assert; `_sem_post` cega essa camada para provar que o assert da
  # suíte pega sozinho (uma camada por vez: a que fica verde é redundante ou inalcançada).
  SABOTAGENS="descarta_cliente:A5 repete_alerta:A9 descarta_02:A4 so_radar:A7 regride_lote:A11 sem_denominador:A7b acl_aberta:post:A7 acl_aberta_sem_post:A12"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-situacao.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      post:*) padrao="${a#post:} FALHOU" ;;
      *)      padrao="^FAIL $a " ;;
    esac
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5492}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-situacao.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
FN_RECRUZAR="$(dirname "$DATA")/fn-recruzar.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
# A função VIVA do recruzamento vem da migration de maior timestamp (imutável): só o bloco CREATE … $$;
awk '/^CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente\(\)/{p=1} p{print} p && /^\$\$;$/{exit}' "$MIG_RECRUZAR" > "$FN_RECRUZAR"
grep -q "GET DIAGNOSTICS v_marcados = ROW_COUNT" "$FN_RECRUZAR" || { echo "não extraí radar_recruzar_ja_cliente de $MIG_RECRUZAR"; exit 9; }

sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  descarta_cliente) sabotar " AND i.vigente AND NOT i.cliente" " AND i.vigente" ;;
  repete_alerta)    sabotar "WHERE a.cnpj = i.cnpj AND a.situacao = i.situacao AND a.alertado_em IS NOT NULL" "WHERE false" ;;
  descarta_02)      sabotar "WHERE s.lote = p_lote AND s.situacao IN ('03','04','08');" "WHERE s.lote = p_lote AND s.situacao IN ('02','03','04','08');" ;;
  so_radar)         sabotar "      LEFT JOIN public.radar_empresas re ON re.cnpj = s.cnpj
      LEFT JOIN tmp_rfb_clientes c ON c.doc = s.cnpj
     WHERE s.lote = p_lote AND s.situacao IN" "      JOIN public.radar_empresas re ON re.cnpj = s.cnpj
      LEFT JOIN tmp_rfb_clientes c ON c.doc = s.cnpj
     WHERE s.lote = p_lote AND s.situacao IN" ;;
  regride_lote)     sabotar "(re.cnpj IS NULL OR COALESCE(re.rfb_situacao_lote, p_lote) <= p_lote) AS vigente" "true AS vigente"
                    sabotar "     AND (re.rfb_situacao_lote IS NULL OR re.rfb_situacao_lote <= p_lote)
" "" ;;
  sem_denominador)  sabotar "|| 'de ' || v_verificados || ' clientes verificados neste lote ('" "|| 'de ' || v_novos || ' clientes verificados neste lote ('" ;;
  acl_aberta)       sabotar "REVOKE ALL ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) FROM anon;" ;;
  acl_aberta_sem_post) sabotar "REVOKE ALL ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) FROM anon;"
                    sabotar "    IF has_function_privilege('anon', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR has_function_privilege('public', f, 'EXECUTE') THEN" "    IF false THEN" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Espelha o default privilege do Supabase: relação e função novas NASCEM abertas (database.md §4/§5).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
-- Esquema mínimo com os CHECKs de prod que a função atravessa.
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  razao_social text,
  cnae_principal text NOT NULL DEFAULT '2071100',
  ultimo_lote text NOT NULL DEFAULT '2026-08',
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar'
    CHECK (prospeccao_status IN ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente')),
  prospeccao_atualizado_em timestamptz,
  descarte_motivo text,
  primeira_vista_em timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT '2026-09-01 00:00+00');
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL REFERENCES public.radar_empresas(cnpj) ON DELETE CASCADE CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  acao text NOT NULL CHECK (acao IN ('contatado_sem_resposta','em_conversa','descartado','virou_cliente','a_contatar')),
  nota text,
  criado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status_anterior text);
CREATE TABLE public.profiles (id uuid DEFAULT gen_random_uuid(), user_id uuid DEFAULT gen_random_uuid(), document text, name text, razao_social text);
CREATE TABLE public.omie_clientes_nao_vinculados (codigo text, cnpj_cpf text, razao_social text, nome_fantasia text);
CREATE TABLE public.fornecedor_alerta (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro','mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla','erro_app','outro','param_auto_resumo','reposicao_pedido_minimo')),
  severidade text NOT NULL DEFAULT 'info' CHECK (severidade IN ('info','atencao','urgente')),
  titulo text NOT NULL,
  mensagem text,
  status text DEFAULT 'pendente_notificacao' CHECK (status IN ('pendente_notificacao','notificado','falha_notificacao','ignorado')),
  tentativas integer DEFAULT 0,
  metadata jsonb,
  criado_em timestamptz DEFAULT now());
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_contatos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fornecedor_alerta ENABLE ROW LEVEL SECURITY;
SQL
P -q -f "$FN_RECRUZAR" >/dev/null
Pq -c "REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente() FROM PUBLIC, anon, authenticated;" >/dev/null

P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
AGORA="2026-10-19 12:00:00+00"
aplicar() { Pq -c "SELECT public.radar_aplicar_situacao('$1', '$AGORA'::timestamptz);"; }
campo() { Pq -c "SELECT (public.radar_aplicar_situacao('$1', '$AGORA'::timestamptz))->>'$2';"; }
estado() { Pq -c "SELECT prospeccao_status||'|'||coalesce(descarte_motivo,'-')||'|'||coalesce(rfb_situacao,'-')||'|'||coalesce(rfb_situacao_lote,'-') FROM public.radar_empresas WHERE cnpj='$1';"; }
n_alertas() { Pq -c "SELECT count(*) FROM public.fornecedor_alerta;"; }
n_contatos() { Pq -c "SELECT count(*) FROM public.radar_contatos WHERE cnpj='$1';"; }

# ── Seed ─────────────────────────────────────────────────────────────────────────────────────────
# Leads: L1 a_contatar/08 · L2 em_conversa/02 · L3 já descartado por humano/03 · L4 virou_cliente/08 · L5 sem linha no lote.
# Clientes: C1 ja_cliente/04 · C2 só em profiles (máscara)/08 · C3 FORA do radar (Omie)/08 · C4 ja_cliente/02 ·
#           CA alfanumérico (exemplo oficial da RFB) em profiles com máscara/03.
Pq -c "INSERT INTO public.radar_empresas (cnpj, razao_social, ja_cliente, prospeccao_status, descarte_motivo) VALUES
  ('11111111000191', 'LEAD UM LTDA', false, 'a_contatar', NULL),
  ('22222222000192', 'LEAD DOIS LTDA', false, 'em_conversa', NULL),
  ('33333333000193', 'LEAD TRES LTDA', false, 'descartado', 'humano: sem fit'),
  ('44444444000194', 'LEAD QUATRO LTDA', false, 'virou_cliente', NULL),
  ('99999999000199', 'LEAD CINCO LTDA', false, 'a_contatar', NULL),
  ('55555555000195', 'CLIENTE UM SA', true, 'a_contatar', NULL),
  ('66666666000196', 'CLIENTE DOIS ME', false, 'a_contatar', NULL),
  ('88888888000198', 'CLIENTE QUATRO EIRELI', true, 'virou_cliente', NULL),
  ('12ABC34501DE35', 'CLIENTE ALFA LTDA', false, 'a_contatar', NULL);
INSERT INTO public.profiles (document, name, razao_social) VALUES
  ('66.666.666/0001-96', 'Dois', 'CLIENTE DOIS ME (perfil)'),
  ('12.ABC.345/01DE-35', 'Alfa', NULL),
  ('aeg-123.456.789-09', 'CPF anotado', NULL),
  ('123.456.789-00', 'CPF', NULL);
INSERT INTO public.omie_clientes_nao_vinculados (codigo, cnpj_cpf, razao_social, nome_fantasia) VALUES
  ('o7', '77777777000197', 'FORA DO RADAR LTDA', 'Fora'),
  ('o5', '55555555000195', NULL, 'Cliente Um');
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao, motivo_codigo, motivo_descricao) VALUES
  ('11111111000191', '2026-08', '08', '2026-03-15', '01', 'EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA'),
  ('22222222000192', '2026-08', '02', '2010-01-01', '00', 'SEM MOTIVO'),
  ('33333333000193', '2026-08', '03', '2026-02-01', '63', 'OMISSAO DE DECLARACOES'),
  ('44444444000194', '2026-08', '08', '2026-01-10', '01', 'EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA'),
  ('55555555000195', '2026-08', '04', '2025-12-31', '63', 'OMISSAO DE DECLARACOES'),
  ('66666666000196', '2026-08', '08', '2026-04-02', '01', 'EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA'),
  ('77777777000197', '2026-08', '08', NULL, '01', 'EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA'),
  ('88888888000198', '2026-08', '02', '2015-05-05', '00', 'SEM MOTIVO'),
  ('12ABC34501DE35', '2026-08', '03', '2026-05-20', NULL, NULL);" >/dev/null

# ── Espelho: radar_docs_clientes() × radar_recruzar_ja_cliente() ─────────────────────────────────
eq "A13 radar_docs_clientes espelha a normalização (máscara, cru, alfanumérico com máscara; CPF anotado NÃO vira chave) e traz nome" \
   "$(Pq -c "SELECT string_agg(doc||'='||coalesce(nome,'-'), ' ' ORDER BY doc) FROM public.radar_docs_clientes();")" \
   "12ABC34501DE35=Alfa 55555555000195=Cliente Um 66666666000196=CLIENTE DOIS ME (perfil) 77777777000197=FORA DO RADAR LTDA"
Pq -c "SELECT public.radar_recruzar_ja_cliente();" >/dev/null
eq "A13b o recruzar vivo marca exatamente os docs presentes no radar (C2 e CA viram ja_cliente; L1..L5 não)" \
   "$(Pq -c "SELECT string_agg(cnpj, ' ' ORDER BY cnpj) FROM public.radar_empresas WHERE ja_cliente;")" \
   "12ABC34501DE35 55555555000195 66666666000196 88888888000198"
# Devolve C2/CA a ja_cliente=false: a prova abaixo exige que a função reconheça cliente PELO DOCUMENTO, não só pela flag.
Pq -c "UPDATE public.radar_empresas SET ja_cliente=false WHERE cnpj IN ('66666666000196','12ABC34501DE35');" >/dev/null

# ── Lote 2026-08 ───────────────────────────────────────────────────────────────────────────────────
R1="$(aplicar 2026-08)"
eq "A1 retorno do lote: 1 lead descartado · 5 clientes verificados · 4 irregulares · 4 novos · alerta_id=1" \
   "$(Pq -c "SELECT (j->>'leads_descartados')||'|'||(j->>'clientes_verificados')||'|'||(j->>'clientes_irregulares')||'|'||(j->>'clientes_alertados_novos')||'|'||(j->>'alerta_id')||'|'||(j->>'fotos_atualizadas') FROM (SELECT '$R1'::jsonb j) x;")" \
   "1|5|4|4|1|8"
eq "A2 LEAD 08 → descartado com motivo RFB, foto 08/2026-08, prospeccao_atualizado_em = p_agora" \
   "$(estado 11111111000191) $(Pq -c "SELECT (prospeccao_atualizado_em = '$AGORA'::timestamptz)::text FROM public.radar_empresas WHERE cnpj='11111111000191';")" \
   "descartado|RFB: BAIXADA em 15/03/2026 (01 — EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA)|08|2026-08 true"
eq "A3 histórico do lead: 1 linha 'descartado', criado_por = uuid de sistema, status_anterior, nota = motivo, created_at = p_agora" \
   "$(Pq -c "SELECT count(*)||'|'||min(acao)||'|'||min(criado_por::text)||'|'||min(status_anterior)||'|'||min(nota)||'|'||bool_and(created_at='$AGORA'::timestamptz)::text FROM public.radar_contatos WHERE cnpj='11111111000191';")" \
   "1|descartado|00000000-0000-0000-0000-00000000ad0f|a_contatar|RFB: BAIXADA em 15/03/2026 (01 — EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA)|true"
eq "A4 situação 02 não muda estado (só a foto); descartado por humano e virou_cliente ficam como estão; sem linha no lote = sem foto" \
   "$(estado 22222222000192) $(n_contatos 22222222000192) | $(estado 33333333000193) $(n_contatos 33333333000193) | $(estado 44444444000194) $(n_contatos 44444444000194) | $(estado 99999999000199)" \
   "em_conversa|-|02|2026-08 0 | descartado|humano: sem fit|03|2026-08 0 | virou_cliente|-|08|2026-08 0 | a_contatar|-|-|-"
eq "A5 CLIENTE irregular NÃO é descartado (ja_cliente, só-documento e alfanumérico) e sem linha no histórico" \
   "$(estado 55555555000195) | $(estado 66666666000196) | $(estado 12ABC34501DE35) | $(Pq -c "SELECT count(*) FROM public.radar_contatos WHERE cnpj IN ('55555555000195','66666666000196','12ABC34501DE35');")" \
   "a_contatar|-|04|2026-08 | a_contatar|-|08|2026-08 | a_contatar|-|03|2026-08 | 0"
eq "A6 UM fornecedor_alerta: oben/outro/atencao/pendente_notificacao, título com N=4 e o lote" \
   "$(Pq -c "SELECT count(*)||'|'||min(empresa)||'|'||min(tipo)||'|'||min(severidade)||'|'||min(status)||'|'||min(titulo) FROM public.fornecedor_alerta;")" \
   "1|oben|outro|atencao|pendente_notificacao|[Radar] 4 cliente(s) com baixa/inaptidão no lote 2026-08"
MSG="$(Pq -c "SELECT mensagem FROM public.fornecedor_alerta WHERE id=1;")"
tem() { case "$MSG" in *"$1"*) echo "sim";; *) echo "NAO";; esac; }
eq "A7 mensagem lista cliente FORA do radar (nome do Omie, CNPJ com máscara, data não informada) e os do radar" \
   "$(tem 'FORA DO RADAR LTDA (77.777.777/0001-97): RFB: BAIXADA em data não informada (01 — EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA)') $(tem 'CLIENTE UM SA (55.555.555/0001-95): RFB: INAPTA em 31/12/2025 (63 — OMISSAO DE DECLARACOES)') $(tem 'CLIENTE ALFA LTDA (12.ABC.345/01DE-35): RFB: SUSPENSA em 20/05/2026 (motivo não informado)') $(tem 'CLIENTE DOIS ME (66.666.666/0001-96)')" \
   "sim sim sim sim"
eq "A7b mensagem traz o DENOMINADOR (5 verificados, 4 irregulares, 4 novos) e metadata com os 4 CNPJs" \
   "$(tem 'de 5 clientes verificados neste lote (4 irregular(es) no total, 4 novo(s))') $(Pq -c "SELECT jsonb_array_length(metadata->'cnpjs')||'|'||(metadata->>'lote')||'|'||(metadata->>'origem') FROM public.fornecedor_alerta WHERE id=1;")" \
   "sim 4|2026-08|radar_situacao_cadastral"
eq "A8 alertado_em = p_agora exatamente nas 4 linhas de cliente irregular; as demais ficam NULL" \
   "$(Pq -c "SELECT string_agg(cnpj, ' ' ORDER BY cnpj) FROM public.radar_situacao_cadastral WHERE alertado_em = '$AGORA'::timestamptz;")|$(Pq -c "SELECT count(*) FROM public.radar_situacao_cadastral WHERE alertado_em IS NULL;")" \
   "12ABC34501DE35 55555555000195 66666666000196 77777777000197|5"

# ── Re-run do MESMO lote: nada se repete ──────────────────────────────────────────────────────────
R2="$(aplicar 2026-08)"
eq "A9 re-rodar o lote: 0 descartados, 0 novos, sem alerta novo; alertas=1, histórico do lead=1" \
   "$(Pq -c "SELECT (j->>'leads_descartados')||'|'||(j->>'clientes_alertados_novos')||'|'||coalesce(j->>'alerta_id','null')||'|'||(j->>'clientes_irregulares') FROM (SELECT '$R2'::jsonb j) x;") $(n_alertas) $(n_contatos 11111111000191)" \
   "0|0|null|4 1 1"

# ── Lote 2026-09: só o que é NOVO avisa; reativado perde o selo; lead descartado pela RFB fica descartado
Pq -c "INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao, motivo_codigo, motivo_descricao) VALUES
  ('11111111000191', '2026-09', '02', '2026-09-01', '00', 'SEM MOTIVO'),
  ('55555555000195', '2026-09', '04', '2025-12-31', '63', 'OMISSAO DE DECLARACOES'),
  ('66666666000196', '2026-09', '02', '2026-09-03', '00', 'SEM MOTIVO'),
  ('77777777000197', '2026-09', '08', NULL, '01', 'EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA'),
  ('88888888000198', '2026-09', '08', '2026-08-20', '01', 'EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA');" >/dev/null
R3="$(aplicar 2026-09)"
eq "A10 lote seguinte: só C4 (08 novo) avisa — C1 (mesma 04) e C3 (mesma 08) não repetem; C2 reativado não avisa; título N=1" \
   "$(Pq -c "SELECT (j->>'leads_descartados')||'|'||(j->>'clientes_verificados')||'|'||(j->>'clientes_irregulares')||'|'||(j->>'clientes_alertados_novos')||'|'||(j->>'alerta_id') FROM (SELECT '$R3'::jsonb j) x;") $(n_alertas) $(Pq -c "SELECT titulo FROM public.fornecedor_alerta WHERE id=2;")" \
   "0|4|3|1|2 2 [Radar] 1 cliente(s) com baixa/inaptidão no lote 2026-09"
eq "A10b foto avança: lead descartado pela RFB volta a 02 mas FICA descartado (motivo preservado); C2 perde o selo" \
   "$(estado 11111111000191) | $(estado 66666666000196) | $(estado 88888888000198)" \
   "descartado|RFB: BAIXADA em 15/03/2026 (01 — EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA)|02|2026-09 | a_contatar|-|02|2026-09 | virou_cliente|-|08|2026-09"

# ── Lote MAIS VELHO (2026-07) chegando depois: não regride a foto, não descarta, não avisa ─────────
Pq -c "INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao, motivo_codigo, motivo_descricao) VALUES
  ('22222222000192', '2026-07', '08', '2026-06-01', '01', 'EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA'),
  ('88888888000198', '2026-07', '02', '2015-05-05', '00', 'SEM MOTIVO');" >/dev/null
R4="$(aplicar 2026-07)"
eq "A11 lote mais velho que a foto conhecida: 0 descartados, 0 novos, foto de C4 segue 08/2026-09, L2 segue em_conversa" \
   "$(Pq -c "SELECT (j->>'leads_descartados')||'|'||(j->>'clientes_alertados_novos')||'|'||(j->>'fotos_atualizadas') FROM (SELECT '$R4'::jsonb j) x;") $(estado 88888888000198) $(estado 22222222000192) $(n_alertas)" \
   "0|0|0 virou_cliente|-|08|2026-09 em_conversa|-|02|2026-08 2"

# ── ACL, RLS, entrada inválida ─────────────────────────────────────────────────────────────────────
eq "A12 anon/authenticated/PUBLIC sem EXECUTE nas 3 funções; service_role com" \
   "$(Pq -c "SELECT string_agg(f||'='||has_function_privilege('anon', f, 'EXECUTE')::text||has_function_privilege('authenticated', f, 'EXECUTE')::text||has_function_privilege('public', f, 'EXECUTE')::text||has_function_privilege('service_role', f, 'EXECUTE')::text, ' ')
     FROM unnest(ARRAY['public.radar_aplicar_situacao(text, timestamptz)','public.radar_cnpjs_conhecidos(text, integer)','public.radar_docs_clientes()']) f;")" \
   "public.radar_aplicar_situacao(text, timestamptz)=falsefalsefalsetrue public.radar_cnpjs_conhecidos(text, integer)=falsefalsefalsetrue public.radar_docs_clientes()=falsefalsefalsetrue"
if SAIDA="$(Pq -c "SET ROLE authenticated; SELECT public.radar_aplicar_situacao('2026-08');" 2>&1)"; then RC="verde"; else RC="vermelho"; fi
case "$SAIDA" in *"permission denied"*) M="42501";; *) M="outro:$SAIDA";; esac
eq "A12b authenticated executando a função: permission denied (42501)" "$RC $M" "vermelho 42501"
if SAIDA="$(Pq -c "SELECT public.radar_aplicar_situacao('2026/08');" 2>&1)"; then RC="verde"; else RC="vermelho"; fi
case "$SAIDA" in *"lote inv"*) M="22023";; *) M="outro";; esac
eq "A14 lote fora de YYYY-MM falha alto" "$RC $M" "vermelho 22023"
GESTOR="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; VENDEDOR="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
Pq -c "INSERT INTO public.test_gestores VALUES ('$GESTOR');" >/dev/null
eq "A15 RLS: gestor lê radar_situacao_cadastral; não-gestor vê 0 linhas; anon não lê" \
   "$(Pq -c "SELECT pg_catalog.set_config('test.uid','$GESTOR',false); SET ROLE authenticated; SELECT count(*) FROM public.radar_situacao_cadastral;" | tail -1) $(Pq -c "SELECT pg_catalog.set_config('test.uid','$VENDEDOR',false); SET ROLE authenticated; SELECT count(*) FROM public.radar_situacao_cadastral;" | tail -1) $(Pq -c "SELECT has_table_privilege('anon','public.radar_situacao_cadastral','SELECT')::text;")" \
   "16 0 false"

# ── Lista radar ∪ clientes (keyset) ────────────────────────────────────────────────────────────────
contem() { case "$1" in *"$2"*) echo "fora-sim";; *) echo "fora-NAO";; esac; }
TUDO=""; APOS=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  PAG="$(Pq -c "SELECT array_to_string(public.radar_cnpjs_conhecidos('$APOS', 3), ' ');")"
  [ -z "$PAG" ] && break
  TUDO="$TUDO $PAG"; APOS="${PAG##* }"
done
eq "A16 radar_cnpjs_conhecidos pagina por keyset (3 por página) e cobre radar ∪ clientes, inclusive o cliente fora do radar, sem repetir" \
   "$(echo "$TUDO" | tr ' ' '\n' | grep -c . ) $(echo "$TUDO" | tr ' ' '\n' | sort -u | grep -c .) $(contem "$TUDO" 77777777000197)" \
   "10 10 fora-sim"
eq "A16b página vazia depois do último; limite é capado em 50000 e mínimo 1" \
   "$(Pq -c "SELECT array_length(public.radar_cnpjs_conhecidos('ZZZZZZZZZZZZZZ', 3), 1) IS NULL;") $(Pq -c "SELECT array_length(public.radar_cnpjs_conhecidos('', 0), 1);")" \
   "t 1"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_SITUACAO_CADASTRAL_PROVA_OK"
[ "$FAIL" -eq 0 ]
