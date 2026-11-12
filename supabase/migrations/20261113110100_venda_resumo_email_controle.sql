-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Venda por cliente · rodada 2 · Entrega 1 — RESUMO DIÁRIO POR E-MAIL + GRUPO CONTROLE (decisão do founder, 12/11/2026)
--
-- Por quê: medido em prod (12/11) — `venda_lista_acesso` 0 linhas desde 28/10: as farmers nunca abriram a lista do
-- Meu Dia; elas trabalham no Omie. O gargalo é CANAL, não motor. O resumo vai ao e-mail (canal não congelado pela
-- M-41) e o founder o revisa com elas 10 min/dia nos 10 primeiros dias úteis.
--
-- O que esta migration faz:
--  1. SORTEIO estável (`venda_braco_sorteio`, 1 linha imutável) e braço por comprador CANÔNICO
--     (`venda_braco_comprador`, imutável, escritor único `private.venda_braco_atribuir`): u = 32 bits de
--     md5(semente:comprador)/2^32; controle ⇔ u < 0,15. Universo inicial = todo comprador que já esteve em
--     `venda_sugestao` (qualquer fase — permite o A/A no histórico); comprador novo é atribuído na 1ª aparição pela
--     MESMA semente. Nunca re-sorteia: trocar semente/fração exige migration nova e o singleton não aceita UPDATE.
--  2. `venda_sugestao.braco` (coluna dedicada, NÃO jsonb): o trigger `venda_sugestao_braco_trg` é o escritor único —
--     linha `ativa` com dia ≥ `inicio` recebe o braço do comprador (no INSERT e na transição de fase); antes do início,
--     historico e sombra ficam NULL; braço gravado não muda. O gerador NÃO muda: continua gravando o controle.
--  3. O controle sai do que a farmer VÊ: `private._venda_sugestoes_json` (lista do Meu Dia + ficha),
--     `venda_marcar_mostrada`, a policy de SELECT da farmer em `venda_sugestao`, e o painel de adoção
--     (`venda_painel`: na lista / contatados / conversão ativa e a régua da Onda 2) — todos com
--     `braco IS DISTINCT FROM 'controle'`.
--  4. RESUMO por e-mail (`venda_resumo_preparar`, cron 06:35 SP seg–sex): por farmer, ranking do dia sobre OS DOIS
--     braços (até 5 das cidades com entrega amanhã + maiores atrasos, completando 8). A seleção inteira é gravada
--     (`venda_resumo_selecao`) — o controle selecionado é o CONTRAFACTUAL ("seria enviado"), o que torna os braços
--     comparáveis; só o tratamento vai no e-mail. O e-mail é um `fornecedor_alerta` que a edge
--     `dispatch-notifications` já despacha (cron */30), como o Radar D1. Cópia separada ao founder, tokens próprios.
--  5. SENSOR com denominador: entrega = alerta `notificado` (envio ACEITO pelo Gmail); abertura = pixel
--     (`venda_resumo_registrar_abertura`, sinal fraco, só service_role); clique = rota /meu-dia/abrir/<token>
--     (`venda_resumo_abrir`, grava só se quem abre é o destinatário e marca `mostrada_em` dos itens que o e-mail
--     MOSTROU); oferta = contato registrado na ficha (`venda_contato`) após o envio, até o próximo dia útil.
--     `venda_resumo_painel` (master) expõe tudo e o efeito por braço (comprador na 1ª seleção, coorte madura).
--
-- Revisão Codex (1×, 12/11, gpt-6-astra high): hash em bigint/2^32 (nunca int assinado); braço também na transição
-- de fase; unidade = comprador na 1ª seleção com janela de 14 dias e coorte MADURA; "ofertada" separa tentativa de
-- contato efetivo e exige contato DEPOIS do envio; entrega = "envio aceito"; desligamento por prazo-calendário.
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md §12 (rodada 2).
--
-- Aplicar: `bun run db:aplicar` (sem BEGIN/COMMIT — a transação é do executor). Prova: db/test-venda-resumo-email.sh.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── TRAVA: antes de ler, prende cada função viva que este arquivo recria (a PRE abaixo guarda as três) ──────────
DO $trava$
BEGIN
  IF to_regprocedure('private._venda_sugestoes_json(uuid,date)') IS NOT NULL THEN
    ALTER FUNCTION private._venda_sugestoes_json(uuid, date) STABLE;
  END IF;
  IF to_regprocedure('public.venda_marcar_mostrada(uuid[])') IS NOT NULL THEN
    ALTER FUNCTION public.venda_marcar_mostrada(uuid[]) VOLATILE;
  END IF;
  IF to_regprocedure('public.venda_painel(date,date)') IS NOT NULL THEN
    ALTER FUNCTION public.venda_painel(date, date) STABLE;
  END IF;
END
$trava$;

-- ── PRE: o corpo vivo de cada uma é o predecessor medido em prod (psql-ro, 12/11/2026) ou já é este ─────────────
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('private._venda_sugestoes_json(uuid,date)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('private._venda_sugestoes_json(uuid,date)')),
         '6e26a8360dbfc2e0af9559d6a75da893', 'ccc8189a3d2962e073a3d360581efb61'),
        ('public.venda_marcar_mostrada(uuid[])',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('public.venda_marcar_mostrada(uuid[])')),
         '6caf2c9644ff0380fc31617adcf471e7', '3e286aaea8d6f4c7b1bce316824d5be7'),
        ('public.venda_painel(date,date)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('public.venda_painel(date,date)')),
         '2b3f2c1b9af99c6dcc34f413f9534c54', '76d2d0f050e9240392cd1362ef2d82bd')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) nao e o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- ════════════════════════════════════════ 1. SORTEIO ════════════════════════════════════════════════════════

-- u ∈ [0, 1): os 32 primeiros bits de md5(semente:comprador) como inteiro SEM sinal (bit(32)→bigint estende com
-- zeros) sobre 2^32. Pura e IMUTÁVEL: é a régua que qualquer um re-confere fora do banco.
CREATE OR REPLACE FUNCTION private.venda_braco_u(p_semente text, p_comprador uuid)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (('x' || substr(md5(p_semente || ':' || p_comprador::text), 1, 8))::bit(32)::bigint)::numeric / 4294967296
$$;

CREATE TABLE IF NOT EXISTS public.venda_braco_sorteio (
  id                  smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  algoritmo           text        NOT NULL CHECK (algoritmo = 'md5-32-v1'),
  semente             text        NOT NULL CHECK (length(semente) >= 8),
  fracao_controle     numeric     NOT NULL CHECK (fracao_controle > 0 AND fracao_controle < 0.5),
  inicio              date        NOT NULL,
  realizado_em        timestamptz NOT NULL DEFAULT now(),
  n_inicial           integer     NOT NULL CHECK (n_inicial >= 0),
  n_inicial_controle  integer     NOT NULL CHECK (n_inicial_controle >= 0 AND n_inicial_controle <= n_inicial)
);
COMMENT ON TABLE public.venda_braco_sorteio IS
  'Venda R2: o sorteio do grupo controle (1 linha, imutável). inicio = 1º dia_referencia com braço (1º dia útil do '
  'e-mail). Trocar semente/fração = migration nova, nunca UPDATE.';

CREATE TABLE IF NOT EXISTS public.venda_braco_comprador (
  comprador_id  uuid        PRIMARY KEY,
  braco         text        NOT NULL CHECK (braco IN ('controle', 'tratamento')),
  u             numeric     NOT NULL CHECK (u >= 0 AND u < 1),
  origem        text        NOT NULL CHECK (origem IN ('sorteio_inicial', 'primeira_aparicao')),
  atribuido_em  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.venda_braco_comprador IS
  'Venda R2: braço (controle × tratamento) por comprador CANÔNICO. Imutável; escritor único private.venda_braco_atribuir '
  '(e o sorteio inicial desta migration). A farmer não lê (contaminação).';

-- Imutáveis: nem UPDATE, nem DELETE, nem TRUNCATE (o REVOKE fecha a porta; o trigger fecha a CLASSE, até para o dono).
CREATE OR REPLACE FUNCTION private.venda_braco_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'VENDA_BRACO_IMUTAVEL: % em % — o sorteio nao se refaz em silencio (migration nova)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS venda_braco_sorteio_imutavel ON public.venda_braco_sorteio;
CREATE TRIGGER venda_braco_sorteio_imutavel BEFORE UPDATE OR DELETE ON public.venda_braco_sorteio
  FOR EACH ROW EXECUTE FUNCTION private.venda_braco_imutavel();
DROP TRIGGER IF EXISTS venda_braco_sorteio_imutavel_trunc ON public.venda_braco_sorteio;
CREATE TRIGGER venda_braco_sorteio_imutavel_trunc BEFORE TRUNCATE ON public.venda_braco_sorteio
  FOR EACH STATEMENT EXECUTE FUNCTION private.venda_braco_imutavel();
DROP TRIGGER IF EXISTS venda_braco_comprador_imutavel ON public.venda_braco_comprador;
CREATE TRIGGER venda_braco_comprador_imutavel BEFORE UPDATE OR DELETE ON public.venda_braco_comprador
  FOR EACH ROW EXECUTE FUNCTION private.venda_braco_imutavel();
DROP TRIGGER IF EXISTS venda_braco_comprador_imutavel_trunc ON public.venda_braco_comprador;
CREATE TRIGGER venda_braco_comprador_imutavel_trunc BEFORE TRUNCATE ON public.venda_braco_comprador
  FOR EACH STATEMENT EXECUTE FUNCTION private.venda_braco_imutavel();

-- O sorteio (uma vez): início = próximo dia útil (seg–sex) depois do dia do apply em SP — o 1º dia em que o e-mail sai.
-- Antes dele não há braço: a coorte do experimento nasce com o canal, não com a migration.
DO $sorteio$
DECLARE
  c_semente constant text    := 'venda-r2-controle-2026-11-12';
  c_fracao  constant numeric := 0.15;
  v_hoje    date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_inicio  date;
  v_n       integer;
  v_nc      integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.venda_braco_sorteio) THEN
    RETURN;   -- re-apply: o sorteio já existe e não se refaz
  END IF;
  v_inicio := v_hoje + CASE extract(isodow FROM v_hoje)::int WHEN 5 THEN 3 WHEN 6 THEN 2 ELSE 1 END;

  SELECT count(*), count(*) FILTER (WHERE private.venda_braco_u(c_semente, x.comprador_id) < c_fracao)
    INTO v_n, v_nc
    FROM (SELECT DISTINCT s.comprador_id FROM public.venda_sugestao s) x;

  INSERT INTO public.venda_braco_sorteio (id, algoritmo, semente, fracao_controle, inicio, n_inicial, n_inicial_controle)
  VALUES (1, 'md5-32-v1', c_semente, c_fracao, v_inicio, v_n, v_nc);

  INSERT INTO public.venda_braco_comprador (comprador_id, braco, u, origem)
  SELECT x.comprador_id,
         CASE WHEN private.venda_braco_u(c_semente, x.comprador_id) < c_fracao THEN 'controle' ELSE 'tratamento' END,
         private.venda_braco_u(c_semente, x.comprador_id),
         'sorteio_inicial'
    FROM (SELECT DISTINCT s.comprador_id FROM public.venda_sugestao s) x
  ON CONFLICT (comprador_id) DO NOTHING;
END
$sorteio$;

-- Escritor único do braço de comprador novo: mesma semente/fração do singleton. Devolve o braço PERSISTIDO
-- (também sob concorrência: ON CONFLICT espera o outro e a releitura vê o que ele gravou).
CREATE OR REPLACE FUNCTION private.venda_braco_atribuir(p_comprador uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_b text;
  v_s record;
  v_u numeric;
BEGIN
  IF p_comprador IS NULL THEN
    RAISE EXCEPTION 'venda_braco_atribuir: comprador NULL' USING ERRCODE = '22023';
  END IF;
  SELECT b.braco INTO v_b FROM public.venda_braco_comprador b WHERE b.comprador_id = p_comprador;
  IF FOUND THEN
    RETURN v_b;
  END IF;
  SELECT s.semente, s.fracao_controle INTO v_s FROM public.venda_braco_sorteio s WHERE s.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'venda_braco_atribuir: sem sorteio' USING ERRCODE = '55000';
  END IF;
  v_u := private.venda_braco_u(v_s.semente, p_comprador);
  INSERT INTO public.venda_braco_comprador (comprador_id, braco, u, origem)
  VALUES (p_comprador, CASE WHEN v_u < v_s.fracao_controle THEN 'controle' ELSE 'tratamento' END, v_u, 'primeira_aparicao')
  ON CONFLICT (comprador_id) DO NOTHING;
  SELECT b.braco INTO STRICT v_b FROM public.venda_braco_comprador b WHERE b.comprador_id = p_comprador;
  RETURN v_b;
END
$$;

-- ════════════════════════════════ 2. venda_sugestao.braco ═══════════════════════════════════════════════════

ALTER TABLE public.venda_sugestao ADD COLUMN IF NOT EXISTS braco text;
COMMENT ON COLUMN public.venda_sugestao.braco IS
  'Venda R2: braço do comprador no experimento do resumo por e-mail (controle | tratamento). NULL = antes do sorteio, '
  'historico ou sombra. Escritor único: trigger venda_sugestao_braco_trg. Controle não aparece para a farmer.';
DO $ck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.venda_sugestao'::regclass AND conname = 'venda_sugestao_braco_ck') THEN
    ALTER TABLE public.venda_sugestao ADD CONSTRAINT venda_sugestao_braco_ck
      CHECK (braco IS NULL OR (fase = 'ativa' AND braco IN ('controle', 'tratamento')));
  END IF;
END
$ck$;

-- O braço de uma linha é FUNÇÃO de (fase, dia, comprador): o trigger calcula, não aceita palpite de quem escreve
-- e não deixa mudar o que já gravou. Atalho barato para o caso comum (o fechamento de desfechos reescreve linhas
-- velhas sem tocar braço/fase/dia/comprador).
CREATE OR REPLACE FUNCTION private.venda_sugestao_braco()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inicio   date;
  v_esperado text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.braco IS NOT DISTINCT FROM OLD.braco
     AND NEW.fase = OLD.fase AND NEW.dia_referencia = OLD.dia_referencia AND NEW.comprador_id = OLD.comprador_id
     AND (OLD.braco IS NOT NULL OR OLD.fase <> 'ativa') THEN
    RETURN NEW;
  END IF;

  IF NEW.fase = 'ativa' THEN
    SELECT s.inicio INTO v_inicio FROM public.venda_braco_sorteio s WHERE s.id = 1;
    IF v_inicio IS NOT NULL AND NEW.dia_referencia >= v_inicio THEN
      v_esperado := private.venda_braco_atribuir(NEW.comprador_id);
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.braco IS NOT NULL AND v_esperado IS DISTINCT FROM OLD.braco THEN
    RAISE EXCEPTION 'VENDA_BRACO_IMUTAVEL: sugestao % ja tem braco %', OLD.id, OLD.braco USING ERRCODE = '55000';
  END IF;
  IF NEW.braco IS NOT NULL AND NEW.braco IS DISTINCT FROM v_esperado
     AND NOT (TG_OP = 'UPDATE' AND NEW.braco IS NOT DISTINCT FROM OLD.braco) THEN
    RAISE EXCEPTION 'VENDA_BRACO_SO_PELO_SORTEIO: braco % informado para a sugestao (esperado %)', NEW.braco, v_esperado
      USING ERRCODE = '55000';
  END IF;
  NEW.braco := v_esperado;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS venda_sugestao_braco_trg ON public.venda_sugestao;
CREATE TRIGGER venda_sugestao_braco_trg BEFORE INSERT OR UPDATE ON public.venda_sugestao
  FOR EACH ROW EXECUTE FUNCTION private.venda_sugestao_braco();

-- Backfill (só se o apply cair depois do início, ex.: re-apply num dia seguinte): linha ativa sem braço do início
-- em diante. O trigger calcula; o SET é o gatilho da transição.
UPDATE public.venda_sugestao s
   SET braco = NULL
 WHERE s.fase = 'ativa' AND s.braco IS NULL
   AND s.dia_referencia >= (SELECT b.inicio FROM public.venda_braco_sorteio b WHERE b.id = 1);

-- A farmer lê só as SUAS linhas ativas que NÃO são do controle (antes ela via o braço pela API).
DROP POLICY IF EXISTS "venda_sugestao_select" ON public.venda_sugestao;
CREATE POLICY "venda_sugestao_select" ON public.venda_sugestao
  FOR SELECT TO authenticated
  USING ((farmer_user_id = auth.uid() AND fase = 'ativa' AND braco IS DISTINCT FROM 'controle')
         OR (SELECT public.has_role(auth.uid(), 'master'::public.app_role)));

-- ════════════════════════════════ 3. RESUMO POR E-MAIL — tabelas ════════════════════════════════════════════

-- Quem recebe. Semeada com as farmers de `commercial_roles` e cópia para o master de `commercial_roles` (o founder).
CREATE TABLE IF NOT EXISTS public.venda_resumo_config (
  farmer_user_id     uuid        PRIMARY KEY,
  ativo              boolean     NOT NULL DEFAULT true,
  copia_user_id      uuid,
  max_oportunidades  smallint    NOT NULL DEFAULT 8 CHECK (max_oportunidades BETWEEN 1 AND 12),
  max_cidade         smallint    NOT NULL DEFAULT 5,
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venda_resumo_config_cidade_ck CHECK (max_cidade BETWEEN 0 AND max_oportunidades)
);
COMMENT ON TABLE public.venda_resumo_config IS
  'Venda R2: farmers que recebem o resumo diário por e-mail; copia_user_id recebe uma cópia (ritual do founder).';

INSERT INTO public.venda_resumo_config (farmer_user_id, copia_user_id)
SELECT f.user_id,
       (SELECT m.user_id FROM public.commercial_roles m WHERE m.commercial_role = 'master' ORDER BY m.user_id LIMIT 1)
  FROM public.commercial_roles f
 WHERE f.commercial_role = 'farmer'
ON CONFLICT (farmer_user_id) DO NOTHING;

-- O EXPERIMENTO: quem o ranking do dia escolheu, nos DOIS braços. Controle aqui = "seria enviado" (contrafactual).
-- 1 linha por dia × farmer × comprador, gravada uma vez (re-envio reaproveita).
CREATE TABLE IF NOT EXISTS public.venda_resumo_selecao (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dia              date        NOT NULL,
  farmer_user_id   uuid        NOT NULL,
  comprador_id     uuid        NOT NULL,
  posicao          smallint    NOT NULL CHECK (posicao >= 1),
  braco            text        NOT NULL CHECK (braco IN ('controle', 'tratamento')),
  grupo            text        NOT NULL CHECK (grupo IN ('cidade_amanha', 'maior_atraso')),
  motivo_entrada   text        NOT NULL,
  valor_ref_total  numeric     CHECK (valor_ref_total IS NULL OR valor_ref_total > 0),
  versao_ranking   text        NOT NULL,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venda_resumo_selecao_comprador_uq UNIQUE (dia, farmer_user_id, comprador_id),
  CONSTRAINT venda_resumo_selecao_posicao_uq   UNIQUE (dia, farmer_user_id, posicao)
);
COMMENT ON TABLE public.venda_resumo_selecao IS
  'Venda R2: seleção diária do resumo (top-K sobre os dois braços). Tratamento vai no e-mail; controle é o contrafactual. '
  'Escritor único: venda_resumo_preparar.';

-- Os itens que o e-mail MOSTRA de cada selecionado (até 3 de recompra + até 2 famílias de complemento). Sem FK para
-- venda_sugestao de propósito: o reprocesso da sucessão substitui linhas não mostradas (venda_sugestao_substituida).
CREATE TABLE IF NOT EXISTS public.venda_resumo_item (
  selecao_id   uuid     NOT NULL REFERENCES public.venda_resumo_selecao(id),
  sugestao_id  uuid     NOT NULL,
  ordem        smallint NOT NULL CHECK (ordem >= 1),
  PRIMARY KEY (selecao_id, sugestao_id)
);

-- Cada e-mail. tipo farmer = o que conta; copia = o do founder; teste = fora de toda conta.
CREATE TABLE IF NOT EXISTS public.venda_resumo_envio (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dia                   date        NOT NULL,
  farmer_user_id        uuid        NOT NULL,
  tipo                  text        NOT NULL CHECK (tipo IN ('farmer', 'copia', 'teste')),
  tentativa             smallint    NOT NULL DEFAULT 1 CHECK (tentativa >= 1),
  destinatario_user_id  uuid        NOT NULL,
  destinatario_email    text        NOT NULL CHECK (destinatario_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  alerta_id             bigint      NOT NULL UNIQUE,
  token_abertura        uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  aberto_em             timestamptz,
  n_oportunidades       smallint    NOT NULL CHECK (n_oportunidades >= 1),
  criado_em             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venda_resumo_envio_tentativa_uq UNIQUE (dia, farmer_user_id, tipo, tentativa)
);
COMMENT ON TABLE public.venda_resumo_envio IS
  'Venda R2: e-mail do resumo (1 por farmer × dia × tipo × tentativa). Entrega = fornecedor_alerta.status notificado '
  '(Gmail aceitou); abertura = pixel (sinal fraco). Lido pela edge dispatch-notifications (destinatário + pixel).';

-- Um link por oportunidade de cada e-mail (tokens próprios por envio: o clique do founder na cópia não vira da farmer).
CREATE TABLE IF NOT EXISTS public.venda_resumo_link (
  token         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  envio_id      uuid        NOT NULL REFERENCES public.venda_resumo_envio(id),
  posicao       smallint    NOT NULL CHECK (posicao >= 1),
  comprador_id  uuid        NOT NULL,
  selecao_id    uuid        REFERENCES public.venda_resumo_selecao(id),
  clicado_em    timestamptz,
  clicado_por   uuid,
  CONSTRAINT venda_resumo_link_posicao_uq UNIQUE (envio_id, posicao),
  CONSTRAINT venda_resumo_link_clique_ck CHECK ((clicado_em IS NULL) = (clicado_por IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_venda_resumo_envio_dia ON public.venda_resumo_envio (dia, farmer_user_id);
CREATE INDEX IF NOT EXISTS idx_venda_resumo_link_envio ON public.venda_resumo_link (envio_id);
CREATE INDEX IF NOT EXISTS idx_venda_resumo_selecao_comprador ON public.venda_resumo_selecao (comprador_id, dia);

-- RLS + ACL: só master lê; ninguém escreve direto (só as funções desta migration, donas das tabelas).
DO $acl$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['venda_braco_sorteio', 'venda_braco_comprador', 'venda_resumo_config', 'venda_resumo_selecao',
                           'venda_resumo_item', 'venda_resumo_envio', 'venda_resumo_link'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_master', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
                   'USING ((SELECT public.has_role(auth.uid(), ''master''::public.app_role)))', t || '_select_master', t);
  END LOOP;
END
$acl$;

-- ════════════════════════════════ 4. RESUMO — funções ═══════════════════════════════════════════════════════

-- Próximo dia útil (seg–sex; feriado não conhecido — declarado).
CREATE OR REPLACE FUNCTION private.venda_prox_dia_util(p_dia date)
RETURNS date
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_dia + CASE extract(isodow FROM p_dia)::int WHEN 5 THEN 3 WHEN 6 THEN 2 ELSE 1 END
$$;

-- R$ 1.234,56 sem depender de lc_numeric (os separadores são literais do to_char + troca).
CREATE OR REPLACE FUNCTION private.venda_brl(p numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN p IS NULL THEN NULL
              ELSE 'R$ ' || translate(to_char(round(p, 2), 'FM999,999,999,990.00'), ',.', '.,') END
$$;

-- Quantidade sem zeros à direita, vírgula decimal: 12 · 2,5 · 0,75.
CREATE OR REPLACE FUNCTION private.venda_qtd(p numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN p IS NULL THEN NULL
              ELSE replace(CASE WHEN round(p, 3)::text LIKE '%.%'
                                THEN rtrim(rtrim(round(p, 3)::text, '0'), '.')
                                ELSE round(p, 3)::text END, '.', ',') END
$$;

-- O RANKING do dia por farmer, sobre os DOIS braços (é o que torna o controle selecionado comparável ao tratamento
-- enviado). Mesmo critério da lista: cidades com entrega amanhã + maiores atrasos; até p_cidade da cidade e o resto
-- dos maiores atrasos; se um grupo não enche a cota, o outro completa. Valor = soma do valor esperado de recompra do
-- comprador (NULL se alguma linha não tem base — ausente ≠ zero; vai para o fim do grupo).
-- O grupo sai do motivo do gerador: 'maior atraso da carteira' é o literal de private.venda_lista_calc.
CREATE OR REPLACE FUNCTION private.venda_resumo_ranking(p_farmer uuid, p_dia date, p_k integer, p_cidade integer)
RETURNS TABLE (posicao smallint, comprador_id uuid, braco text, grupo text, motivo_entrada text, valor_ref_total numeric)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH c AS (
    SELECT s.comprador_id,
           min(s.motivo_entrada) AS motivo,
           CASE WHEN bool_and(s.valor_ref IS NOT NULL) THEN sum(s.valor_ref) END AS valor,
           min(s.braco) AS braco
      FROM public.venda_sugestao s
     WHERE s.fase = 'ativa' AND s.tipo = 'recompra'
       AND s.farmer_user_id = p_farmer AND s.dia_referencia = p_dia
     GROUP BY s.comprador_id
  ),
  g AS (
    SELECT c.*, CASE WHEN c.motivo = 'maior atraso da carteira' THEN 'maior_atraso' ELSE 'cidade_amanha' END AS grupo
      FROM c
  ),
  r AS (
    SELECT g.*, row_number() OVER (PARTITION BY g.grupo ORDER BY g.valor DESC NULLS LAST, g.comprador_id) AS rn
      FROM g
  ),
  o AS (
    SELECT r.*,
           CASE WHEN (r.grupo = 'cidade_amanha' AND r.rn <= p_cidade)
                  OR (r.grupo = 'maior_atraso'  AND r.rn <= p_k - p_cidade) THEN 0 ELSE 1 END AS cota,
           CASE r.grupo WHEN 'cidade_amanha' THEN 0 ELSE 1 END AS grupo_ord
      FROM r
  )
  SELECT (row_number() OVER (ORDER BY o.cota, o.grupo_ord, o.rn))::smallint, o.comprador_id, o.braco, o.grupo,
         o.motivo, o.valor
    FROM o
   ORDER BY o.cota, o.grupo_ord, o.rn
   LIMIT p_k
$$;

-- O texto de UM selecionado no e-mail + os ids das sugestões que ele mostra. Nunca custo: só valor esperado, quantidade
-- de referência e o ÚLTIMO PREÇO PRATICADO (venda_recompra.ultimo_preco).
CREATE OR REPLACE FUNCTION private.venda_resumo_bloco(p_farmer uuid, p_dia date, p_comprador uuid, p_posicao integer,
                                                      p_motivo text, p_valor numeric, p_link text)
RETURNS TABLE (texto text, sugestao_ids uuid[])
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_nome   text;
  v_tel    text;
  v_itens  text := '';
  v_ids    uuid[] := '{}';
  v_resto  integer;
  v_fams   text;
  v_fids   uuid[];
  i        record;
BEGIN
  SELECT COALESCE(NULLIF(btrim(p.name), ''), NULLIF(btrim(p.razao_social), ''), 'Cliente sem nome no cadastro'),
         NULLIF(btrim(p.phone), '')
    INTO v_nome, v_tel
    FROM public.profiles p WHERE p.user_id = p_comprador
   ORDER BY p.created_at LIMIT 1;
  -- Sem linha em profiles o SELECT INTO deixa NULL (o COALESCE de cima só age com linha) — e NULL zeraria o e-mail.
  v_nome := COALESCE(v_nome, 'Cliente sem nome no cadastro');

  FOR i IN
    SELECT s.id, s.qtd_ref, s.valor_ref, s.empresa,
           COALESCE((SELECT o.descricao FROM public.omie_products o
                      WHERE o.omie_codigo_produto = s.omie_codigo_produto AND o.account = s.empresa LIMIT 1),
                    'SKU ' || s.omie_codigo_produto) AS descricao,
           vr.ultimo_preco, vr.cadencia_dias, vr.ultima_compra
      FROM public.venda_sugestao s
      LEFT JOIN public.venda_recompra vr
             ON vr.comprador_id = s.comprador_id AND vr.empresa = s.empresa
            AND vr.omie_codigo_produto = s.omie_codigo_produto
     WHERE s.fase = 'ativa' AND s.tipo = 'recompra' AND s.farmer_user_id = p_farmer
       AND s.comprador_id = p_comprador AND s.dia_referencia = p_dia
     ORDER BY s.valor_ref DESC NULLS LAST, s.omie_codigo_produto
     LIMIT 3
  LOOP
    v_ids := v_ids || i.id;
    v_itens := v_itens || E'\n' || '   - ' || i.descricao
      || COALESCE(' · ' || private.venda_qtd(i.qtd_ref) || ' un', '')
      || ' · último preço ' || COALESCE(private.venda_brl(i.ultimo_preco), 'sem registro')
      || CASE WHEN i.cadencia_dias IS NOT NULL AND i.ultima_compra IS NOT NULL
              THEN ' · comprava a cada ' || round(i.cadencia_dias)::int || ' dias, última há '
                   || (p_dia - i.ultima_compra) || ' dias'
              ELSE '' END;
  END LOOP;

  SELECT count(*) - cardinality(v_ids) INTO v_resto
    FROM public.venda_sugestao s
   WHERE s.fase = 'ativa' AND s.tipo = 'recompra' AND s.farmer_user_id = p_farmer
     AND s.comprador_id = p_comprador AND s.dia_referencia = p_dia;

  SELECT string_agg(x.familia, ', ' ORDER BY x.familia), array_agg(x.id ORDER BY x.familia)
    INTO v_fams, v_fids
    FROM (SELECT s.id, s.familia FROM public.venda_sugestao s
           WHERE s.fase = 'ativa' AND s.tipo = 'complemento' AND s.farmer_user_id = p_farmer
             AND s.comprador_id = p_comprador AND s.dia_referencia = p_dia
           ORDER BY s.familia LIMIT 2) x;

  texto := p_posicao || '. ' || v_nome || ' — ' || COALESCE(v_tel, 'sem telefone no cadastro') || E'\n'
        || '   ' || p_motivo || ' · valor esperado ' || COALESCE(private.venda_brl(p_valor), 'sem base de valor')
        || v_itens
        || CASE WHEN v_resto > 0 THEN E'\n' || '   + ' || v_resto
                                      || CASE WHEN v_resto = 1 THEN ' outro item' ELSE ' outros itens' END || ' na ficha'
                ELSE '' END
        || COALESCE(E'\n' || '   Ofereça também: ' || v_fams, '')
        || E'\n' || '   Abrir a ficha: ' || p_link;
  sugestao_ids := v_ids || COALESCE(v_fids, '{}');
  RETURN NEXT;
END
$$;


-- O PREPARO do dia (cron 06:35 SP, seg–sex): seleção (1×/farmer/dia, os dois braços, com os itens que o e-mail
-- mostraria) → e-mail da farmer + cópia do founder, cada um um fornecedor_alerta que a dispatch-notifications
-- despacha. p_teste_para = desvia para esse usuário como 'teste' (não grava seleção, não conta, aceita dia antes do
-- início). Idempotente: envio na fila ou entregue consome o dia; o que falhou (falha_notificacao) vira tentativa+1.
CREATE OR REPLACE FUNCTION public.venda_resumo_preparar(
  p_dia date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'))::date,
  p_teste_para uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_app_padrao constant text := 'https://steu.lovable.app';
  c_url_ok     constant text := '^https://[A-Za-z0-9.-]+(:[0-9]+)?$';
  c_email_ok   constant text := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  c_versao     constant text := 'r2-v1';
  v_ini        timestamptz := clock_timestamp();
  v_teste      boolean := p_teste_para IS NOT NULL;
  v_app        text;
  v_inicio     date;
  r            record;
  d            record;
  k            record;
  v_sel_id     uuid;
  v_nome       text;
  v_email      text;
  v_tent       integer;
  v_envio      uuid;
  v_alerta     bigint;
  v_lista      text;
  v_titulo     text;
  v_corpo      text;
  v_tokens     uuid[];
  v_pos        integer[];
  v_comps      uuid[];
  v_sels       uuid[];
  v_token      uuid;
  v_texto      text;
  v_ids        uuid[];
  v_n          integer;
  v_enviados   jsonb := '[]'::jsonb;
  v_pulados    jsonb := '[]'::jsonb;
  v_erros      jsonb := '[]'::jsonb;
  v_out        jsonb;
BEGIN
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_resumo_preparar: p_dia NULL' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('venda.resumo_preparar'));

  SELECT NULLIF(btrim(cc.value), '') INTO v_app FROM public.company_config cc WHERE cc.key = 'app_url_publica';
  v_app := rtrim(COALESCE(v_app, c_app_padrao), '/');
  SELECT s.inicio INTO v_inicio FROM public.venda_braco_sorteio s WHERE s.id = 1;

  IF v_app !~ c_url_ok THEN
    v_out := jsonb_build_object('dia', p_dia, 'erro', 'app_url_publica_invalida');
  ELSIF NOT v_teste AND (v_inicio IS NULL OR p_dia < v_inicio) THEN
    v_out := jsonb_build_object('dia', p_dia, 'erro', 'antes_do_inicio', 'inicio', v_inicio);
  ELSIF NOT EXISTS (SELECT 1 FROM public.venda_gerador_execucao e
                     WHERE e.dia_referencia = p_dia AND e.fase = 'ativa') THEN
    -- Sem lista ativa do dia (gerador não rodou, onda desligada): não inventa resumo com a lista de ontem.
    v_out := jsonb_build_object('dia', p_dia, 'erro', 'lista_do_dia_ausente');
  END IF;
  IF v_out IS NOT NULL THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('venda.resumo_email', CASE WHEN v_teste THEN 'manual' ELSE 'automatica' END, v_ini, clock_timestamp(),
            'erro', v_out);
    RETURN v_out;
  END IF;

  FOR r IN SELECT c.* FROM public.venda_resumo_config c WHERE c.ativo ORDER BY c.farmer_user_id LOOP
    -- Cada farmer numa subtransação: o erro de uma desfaz só o dela, vai para `erros` e a outra segue.
    BEGIN
      -- (a) A SELEÇÃO do experimento: uma vez por farmer × dia, nos dois braços, com os itens que o e-mail mostraria.
      IF NOT v_teste AND NOT EXISTS (SELECT 1 FROM public.venda_resumo_selecao x
                                      WHERE x.dia = p_dia AND x.farmer_user_id = r.farmer_user_id) THEN
        FOR k IN SELECT * FROM private.venda_resumo_ranking(r.farmer_user_id, p_dia, r.max_oportunidades, r.max_cidade)
        LOOP
          IF k.braco IS NULL THEN
            RAISE EXCEPTION 'venda_resumo_preparar: comprador % sem braco no dia %', k.comprador_id, p_dia
              USING ERRCODE = '55000';
          END IF;
          INSERT INTO public.venda_resumo_selecao
                 (dia, farmer_user_id, comprador_id, posicao, braco, grupo, motivo_entrada, valor_ref_total, versao_ranking)
          VALUES (p_dia, r.farmer_user_id, k.comprador_id, k.posicao, k.braco, k.grupo, k.motivo_entrada,
                  k.valor_ref_total, c_versao || ':k=' || r.max_oportunidades || ',cidade=' || r.max_cidade)
          RETURNING id INTO v_sel_id;
          SELECT b.sugestao_ids INTO v_ids
            FROM private.venda_resumo_bloco(r.farmer_user_id, p_dia, k.comprador_id, k.posicao, k.motivo_entrada,
                                            k.valor_ref_total, '') b;
          INSERT INTO public.venda_resumo_item (selecao_id, sugestao_id, ordem)
          SELECT v_sel_id, u.id, u.ord FROM unnest(v_ids) WITH ORDINALITY AS u(id, ord);
        END LOOP;
      END IF;

      SELECT COALESCE(NULLIF(split_part(btrim(p.name), ' ', 1), ''), 'vendedora') INTO v_nome
        FROM public.profiles p WHERE p.user_id = r.farmer_user_id ORDER BY p.created_at LIMIT 1;
      v_nome := COALESCE(v_nome, 'vendedora');
      v_nome := upper(left(v_nome, 1)) || lower(substr(v_nome, 2));

      -- (b) Os destinos: farmer + cópia (ou só o teste).
      FOR d IN
        SELECT x.tipo, x.user_id
          FROM (VALUES ('farmer', r.farmer_user_id, 1), ('copia', r.copia_user_id, 2)) AS x(tipo, user_id, ord)
         WHERE NOT v_teste AND x.user_id IS NOT NULL
        UNION ALL
        SELECT 'teste', p_teste_para WHERE v_teste
      LOOP
        IF d.tipo <> 'teste' AND EXISTS (
             SELECT 1 FROM public.venda_resumo_envio e
               LEFT JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
              WHERE e.dia = p_dia AND e.farmer_user_id = r.farmer_user_id AND e.tipo = d.tipo
                AND fa.status IS DISTINCT FROM 'falha_notificacao') THEN
          v_pulados := v_pulados || jsonb_build_object('farmer', r.farmer_user_id, 'tipo', d.tipo, 'motivo', 'ja_enviado_no_dia');
          CONTINUE;
        END IF;

        SELECT btrim(p.email) INTO v_email FROM public.profiles p WHERE p.user_id = d.user_id ORDER BY p.created_at LIMIT 1;
        IF v_email IS NULL OR v_email !~ c_email_ok THEN
          v_pulados := v_pulados || jsonb_build_object('farmer', r.farmer_user_id, 'tipo', d.tipo, 'motivo', 'sem_email');
          CONTINUE;
        END IF;

        -- As oportunidades DO E-MAIL: o tratamento da seleção gravada (no teste, o ranking ao vivo sem o controle).
        v_lista := ''; v_tokens := '{}'; v_pos := '{}'; v_comps := '{}'; v_sels := '{}'; v_n := 0;
        FOR k IN
          SELECT x.comprador_id, x.id AS selecao_id, x.motivo_entrada, x.valor_ref_total, x.posicao
            FROM public.venda_resumo_selecao x
           WHERE NOT v_teste AND x.dia = p_dia AND x.farmer_user_id = r.farmer_user_id AND x.braco = 'tratamento'
          UNION ALL
          SELECT g.comprador_id, NULL::uuid, g.motivo_entrada, g.valor_ref_total, g.posicao
            FROM private.venda_resumo_ranking(r.farmer_user_id, p_dia, r.max_oportunidades, r.max_cidade) g
           WHERE v_teste AND g.braco IS DISTINCT FROM 'controle'
           ORDER BY 5
        LOOP
          v_n := v_n + 1;
          v_token := gen_random_uuid();
          SELECT b.texto INTO v_texto
            FROM private.venda_resumo_bloco(r.farmer_user_id, p_dia, k.comprador_id, v_n, k.motivo_entrada,
                                            k.valor_ref_total, v_app || '/meu-dia/abrir/' || v_token) b;
          IF v_texto IS NULL THEN   -- ausente ≠ vazio: um bloco NULL apagaria o e-mail inteiro em silêncio
            RAISE EXCEPTION 'venda_resumo_preparar: bloco NULL para o comprador %', k.comprador_id USING ERRCODE = '22004';
          END IF;
          v_lista := v_lista || v_texto || E'\n\n';
          v_tokens := v_tokens || v_token; v_pos := v_pos || v_n;
          v_comps := v_comps || k.comprador_id; v_sels := v_sels || k.selecao_id;
        END LOOP;
        IF v_n = 0 THEN
          v_pulados := v_pulados || jsonb_build_object('farmer', r.farmer_user_id, 'tipo', d.tipo, 'motivo', 'sem_oportunidades');
          CONTINUE;
        END IF;

        v_titulo := 'Meu Dia: ' || v_n || CASE WHEN v_n = 1 THEN ' cliente' ELSE ' clientes' END
                 || ' para ligar hoje (' || to_char(p_dia, 'DD/MM') || ')';
        v_corpo := 'Bom dia, ' || v_nome || '!' || E'\n\n'
          || 'Separei ' || v_n || CASE WHEN v_n = 1 THEN ' cliente' ELSE ' clientes' END
          || ' para você ligar hoje: primeiro os das cidades com entrega amanhã, depois os maiores atrasos da carteira. '
          || 'Os valores são o que o cliente costuma comprar desses itens, ao último preço que ele pagou.' || E'\n\n'
          || v_lista
          || 'O link abre a ficha do cliente no app, com o histórico e o botão para registrar a ligação. '
          || 'Registre o resultado de cada uma (1 toque): é assim que a gente sabe o que funcionou.';
        IF d.tipo = 'copia' THEN
          v_titulo := '[Cópia · ' || v_nome || '] ' || v_titulo;
          v_corpo := 'Cópia do resumo enviado hoje a ' || v_nome || ' — para o ritual de 10 minutos com ela. '
            || 'Os links desta cópia são seus: abrir não conta como clique dela.' || E'\n\n' || v_corpo;
        ELSIF d.tipo = 'teste' THEN
          v_titulo := '[TESTE] ' || v_titulo;
          v_corpo := '[TESTE] Resumo de ' || v_nome || ' de ' || to_char(p_dia, 'DD/MM')
            || ', desviado para você. Não entra em nenhuma conta.' || E'\n\n' || v_corpo;
        END IF;

        SELECT COALESCE(max(e.tentativa), 0) + 1 INTO v_tent FROM public.venda_resumo_envio e
         WHERE e.dia = p_dia AND e.farmer_user_id = r.farmer_user_id AND e.tipo = d.tipo;
        v_envio := gen_random_uuid();

        IF v_corpo IS NULL OR v_titulo IS NULL THEN
          RAISE EXCEPTION 'venda_resumo_preparar: corpo/titulo NULL (farmer %)', r.farmer_user_id USING ERRCODE = '22004';
        END IF;
        INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
        VALUES ('oben', 'outro', 'info', v_titulo, v_corpo, 'pendente_notificacao',
                jsonb_build_object('origem', 'venda.resumo_email', 'envio_id', v_envio, 'dia', p_dia, 'tipo', d.tipo,
                                   'farmer', r.farmer_user_id, 'n_oportunidades', v_n, 'tentativa', v_tent))
        RETURNING id INTO v_alerta;

        INSERT INTO public.venda_resumo_envio
               (id, dia, farmer_user_id, tipo, tentativa, destinatario_user_id, destinatario_email, alerta_id, n_oportunidades)
        VALUES (v_envio, p_dia, r.farmer_user_id, d.tipo, v_tent, d.user_id, v_email, v_alerta, v_n);

        INSERT INTO public.venda_resumo_link (token, envio_id, posicao, comprador_id, selecao_id)
        SELECT u.token, v_envio, u.pos, u.comp, u.sel
          FROM unnest(v_tokens, v_pos, v_comps, v_sels) AS u(token, pos, comp, sel);

        v_enviados := v_enviados || jsonb_build_object('farmer', r.farmer_user_id, 'tipo', d.tipo, 'envio_id', v_envio,
                                                       'alerta_id', v_alerta, 'oportunidades', v_n, 'tentativa', v_tent);
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      v_erros := v_erros || jsonb_build_object('farmer', r.farmer_user_id, 'sqlstate', SQLSTATE, 'erro', left(SQLERRM, 300));
    END;
  END LOOP;

  v_out := jsonb_build_object('dia', p_dia, 'teste', v_teste, 'enviados', v_enviados, 'pulados', v_pulados,
                              'erros', v_erros);
  INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
  VALUES ('venda.resumo_email', CASE WHEN v_teste THEN 'manual' ELSE 'automatica' END, v_ini, clock_timestamp(),
          CASE WHEN jsonb_array_length(v_erros) > 0 THEN 'erro' ELSE 'sucesso' END, v_out);
  RETURN v_out;
END
$$;

-- ABERTURA (pixel do e-mail): só a edge (service_role) chama, com o token do envio. Primeira vence. Sinal FRACO:
-- cliente de e-mail que bloqueia imagem não marca; proxy que pré-carrega marca sem leitura. Abertura não é uso.
CREATE OR REPLACE FUNCTION public.venda_resumo_registrar_abertura(p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_token IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.venda_resumo_envio e SET aberto_em = now()
   WHERE e.token_abertura = p_token AND e.aberto_em IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END
$$;

-- CLIQUE (rota /meu-dia/abrir/:token, usuário logado). Devolve para onde ir (comprador + dia). Só GRAVA se quem abre é
-- o DESTINATÁRIO daquele e-mail (primeiro clique vence); se for a farmer no e-mail dela, marca `mostrada_em` dos itens
-- que o e-mail MOSTROU (o resto a ficha marca ao exibir). Staff apenas; token desconhecido → NULL (nada a revelar).
CREATE OR REPLACE FUNCTION public.venda_resumo_abrir(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  l      record;
  v_dest boolean;
  v_reg  boolean := false;
  v_most integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
                           OR COALESCE(public.has_role(v_uid, 'master'::public.app_role), false)) THEN
    RAISE EXCEPTION 'venda_resumo_abrir: requer staff' USING ERRCODE = '42501';
  END IF;
  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT lk.token, lk.comprador_id, lk.selecao_id, lk.clicado_em, e.dia, e.tipo, e.farmer_user_id,
         e.destinatario_user_id
    INTO l
    FROM public.venda_resumo_link lk
    JOIN public.venda_resumo_envio e ON e.id = lk.envio_id
   WHERE lk.token = p_token;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_dest := l.destinatario_user_id = v_uid;
  IF v_dest AND l.clicado_em IS NULL THEN
    UPDATE public.venda_resumo_link SET clicado_em = now(), clicado_por = v_uid
     WHERE token = p_token AND clicado_em IS NULL;
    v_reg := FOUND;
  END IF;
  IF v_dest AND l.tipo = 'farmer' AND l.selecao_id IS NOT NULL THEN
    UPDATE public.venda_sugestao s SET mostrada_em = now()
     WHERE s.id IN (SELECT i.sugestao_id FROM public.venda_resumo_item i WHERE i.selecao_id = l.selecao_id)
       AND s.farmer_user_id = v_uid AND s.fase = 'ativa' AND s.braco IS DISTINCT FROM 'controle'
       AND s.mostrada_em IS NULL;
    GET DIAGNOSTICS v_most = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('comprador_id', l.comprador_id, 'dia', l.dia, 'farmer_user_id', l.farmer_user_id,
                            'tipo', l.tipo, 'do_destinatario', v_dest, 'registrado', v_reg, 'mostradas', v_most);
END
$$;

-- As oportunidades ENTREGUES (e-mail tipo farmer com alerta `notificado`) com o clique da própria farmer e o contato
-- atribuído (régua no comentário de venda_resumo_painel). Fonte única do painel.
CREATE OR REPLACE FUNCTION private.venda_resumo_oportunidades()
RETURNS TABLE (dia date, farmer_user_id uuid, comprador_id uuid, enviado_em timestamptz, clicado boolean, resultado text)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH ops AS (
    SELECT e.dia, e.farmer_user_id, l.comprador_id, fa.email_enviado_em AS enviado_em,
           (l.clicado_em IS NOT NULL AND l.clicado_por = e.destinatario_user_id) AS clicado
      FROM public.venda_resumo_envio e
      JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id AND fa.status = 'notificado'
      JOIN public.venda_resumo_link l ON l.envio_id = e.id
     WHERE e.tipo = 'farmer'
  )
  SELECT o.dia, o.farmer_user_id, o.comprador_id, o.enviado_em, o.clicado, ct.resultado
    FROM ops o
    LEFT JOIN LATERAL (
      SELECT vc.resultado FROM public.venda_contato vc
       WHERE vc.farmer_user_id = o.farmer_user_id AND vc.comprador_id = o.comprador_id
         AND vc.dia >= o.dia AND vc.dia <= private.venda_prox_dia_util(o.dia)
         AND vc.atualizado_em >= COALESCE(o.enviado_em, 'infinity'::timestamptz)
         AND NOT EXISTS (SELECT 1 FROM ops o2
                          WHERE o2.farmer_user_id = o.farmer_user_id AND o2.comprador_id = o.comprador_id
                            AND o2.dia > o.dia AND o2.dia <= vc.dia)
       ORDER BY vc.dia LIMIT 1) ct ON true
$$;

-- PAINEL do resumo (master): o sensor com denominador e o efeito por braço.
--  · entregue  = oportunidade de e-mail tipo farmer cujo alerta está `notificado` (envio ACEITO pelo Gmail — não prova
--                caixa de entrada); teste e cópia fora do denominador.
--  · tentativa = existe `venda_contato` da farmer para o comprador com dia ∈ [dia do envio, próximo dia útil] e tocado
--                DEPOIS do envio; ofertada = tentativa com resultado efetivo (vendeu | vai_pedir | sem_interesse —
--                `nao_atendeu` é tentativa, não oferta). Um contato vale para UMA oportunidade: a entregue mais recente
--                até o dia dele.
--  · acesso validado (farmer × dia) = e-mail aceito E (clicou um link dele OU abriu a lista no app no dia).
--  · status (desde o início, não do período): < 10 dias úteis com e-mail aceito → medindo; nenhum dia com acesso
--    validado → acesso_pendente (o problema é o canal/login, não a lista); ofertadas ÷ entregues < 50% → desligar;
--    senão manter. Prazo de calendário (Codex): a taxa conta TODOS os dias entregues, não só os validados.
--  · efeito: comprador na 1ª seleção desde o início (unidade sorteada), desfecho das linhas de recompra daquele dia;
--    só coorte MADURA (nenhuma linha aberta). nao_medivel fica fora da taxa e aparece por braço. IC95 de Wald da
--    diferença. Antes × depois não; controle × tratamento sim — mas com poucos compradores, inconclusivo ≠ sem efeito.
CREATE OR REPLACE FUNCTION public.venda_resumo_painel(p_de date, p_ate date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_hoje   date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_s      record;
  v_dias   jsonb;
  v_farm   jsonb;
  v_ef     jsonb;
  v_aa     jsonb;
  t        record;
  c        record;
  v_dif    numeric;
  v_ep     numeric;
BEGIN
  IF v_uid IS NULL OR NOT COALESCE(public.has_role(v_uid, 'master'::public.app_role), false) THEN
    RAISE EXCEPTION 'venda_resumo_painel: requer master' USING ERRCODE = '42501';
  END IF;
  IF p_de IS NULL OR p_ate IS NULL OR p_ate < p_de OR p_ate - p_de > 400 THEN
    RAISE EXCEPTION 'PAINEL_PERIODO: periodo invalido (de=%, ate=%; maximo 400 dias)', p_de, p_ate USING ERRCODE = '22023';
  END IF;

  SELECT s.* INTO v_s FROM public.venda_braco_sorteio s WHERE s.id = 1;

  -- por dia × farmer (no período)
  SELECT COALESCE(jsonb_agg(x ORDER BY x.dia DESC, x.farmer_user_id), '[]'::jsonb) INTO v_dias
    FROM (
      SELECT e.dia, e.farmer_user_id,
             (SELECT COALESCE(NULLIF(btrim(p.name), ''), e.farmer_user_id::text) FROM public.profiles p
               WHERE p.user_id = e.farmer_user_id ORDER BY p.created_at LIMIT 1) AS nome,
             fa.status AS envio_status, fa.email_enviado_em AS enviado_em, e.aberto_em, e.tentativa,
             (SELECT count(*) FROM private.venda_resumo_oportunidades() o WHERE o.dia = e.dia AND o.farmer_user_id = e.farmer_user_id) AS entregues,
             (SELECT count(*) FILTER (WHERE o.clicado) FROM private.venda_resumo_oportunidades() o
               WHERE o.dia = e.dia AND o.farmer_user_id = e.farmer_user_id) AS clicadas,
             (SELECT count(*) FILTER (WHERE o.resultado IS NOT NULL) FROM private.venda_resumo_oportunidades() o
               WHERE o.dia = e.dia AND o.farmer_user_id = e.farmer_user_id) AS tentativas,
             (SELECT count(*) FILTER (WHERE o.resultado IN ('vendeu', 'vai_pedir', 'sem_interesse')) FROM private.venda_resumo_oportunidades() o
               WHERE o.dia = e.dia AND o.farmer_user_id = e.farmer_user_id) AS ofertadas,
             (fa.status = 'notificado' AND (
                EXISTS (SELECT 1 FROM private.venda_resumo_oportunidades() o WHERE o.dia = e.dia AND o.farmer_user_id = e.farmer_user_id AND o.clicado)
                OR EXISTS (SELECT 1 FROM public.venda_lista_acesso a WHERE a.farmer_user_id = e.farmer_user_id AND a.dia = e.dia)
             )) AS acesso_validado,
             (SELECT fc.status FROM public.venda_resumo_envio ec
                JOIN public.fornecedor_alerta fc ON fc.id = ec.alerta_id
               WHERE ec.dia = e.dia AND ec.farmer_user_id = e.farmer_user_id AND ec.tipo = 'copia'
               ORDER BY ec.tentativa DESC LIMIT 1) AS copia_status
        FROM public.venda_resumo_envio e
        LEFT JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
       WHERE e.tipo = 'farmer' AND e.dia BETWEEN p_de AND p_ate
         AND e.tentativa = (SELECT max(e2.tentativa) FROM public.venda_resumo_envio e2
                             WHERE e2.dia = e.dia AND e2.farmer_user_id = e.farmer_user_id AND e2.tipo = 'farmer')
    ) x;

  -- por farmer, desde o início: o critério de desligar
  SELECT COALESCE(jsonb_agg(y ORDER BY y.farmer_user_id), '[]'::jsonb) INTO v_farm
    FROM (
      SELECT z.*,
             CASE WHEN z.entregues > 0 THEN round(z.ofertadas::numeric / z.entregues, 4) END AS taxa_ofertada,
             CASE WHEN z.dias_com_envio < 10 THEN 'medindo'
                  WHEN z.dias_acesso_validado = 0 THEN 'acesso_pendente'
                  WHEN z.ofertadas::numeric / NULLIF(z.entregues, 0) < 0.5 THEN 'desligar'
                  ELSE 'manter' END AS status
        FROM (
          SELECT f.farmer_user_id,
                 (SELECT COALESCE(NULLIF(btrim(p.name), ''), f.farmer_user_id::text) FROM public.profiles p
                   WHERE p.user_id = f.farmer_user_id ORDER BY p.created_at LIMIT 1) AS nome,
                 (SELECT min(o.dia) FROM private.venda_resumo_oportunidades() o WHERE o.farmer_user_id = f.farmer_user_id) AS primeiro_envio,
                 (SELECT count(DISTINCT o.dia) FROM private.venda_resumo_oportunidades() o WHERE o.farmer_user_id = f.farmer_user_id) AS dias_com_envio,
                 (SELECT count(DISTINCT o.dia) FROM private.venda_resumo_oportunidades() o
                   WHERE o.farmer_user_id = f.farmer_user_id
                     AND (EXISTS (SELECT 1 FROM private.venda_resumo_oportunidades() o3 WHERE o3.farmer_user_id = o.farmer_user_id
                                   AND o3.dia = o.dia AND o3.clicado)
                          OR EXISTS (SELECT 1 FROM public.venda_lista_acesso a
                                      WHERE a.farmer_user_id = o.farmer_user_id AND a.dia = o.dia))) AS dias_acesso_validado,
                 (SELECT count(*) FROM private.venda_resumo_oportunidades() o WHERE o.farmer_user_id = f.farmer_user_id) AS entregues,
                 (SELECT count(*) FILTER (WHERE o.clicado) FROM private.venda_resumo_oportunidades() o
                   WHERE o.farmer_user_id = f.farmer_user_id) AS clicadas,
                 (SELECT count(*) FILTER (WHERE o.resultado IS NOT NULL) FROM private.venda_resumo_oportunidades() o
                   WHERE o.farmer_user_id = f.farmer_user_id) AS tentativas,
                 (SELECT count(*) FILTER (WHERE o.resultado IN ('vendeu', 'vai_pedir', 'sem_interesse'))
                    FROM private.venda_resumo_oportunidades() o WHERE o.farmer_user_id = f.farmer_user_id) AS ofertadas
            FROM public.venda_resumo_config f
        ) z
    ) y;

  -- efeito por braço: comprador na 1ª seleção desde o início
  WITH prim AS (
    SELECT DISTINCT ON (x.comprador_id) x.comprador_id, x.dia, x.farmer_user_id, x.braco
      FROM public.venda_resumo_selecao x
     ORDER BY x.comprador_id, x.dia, x.posicao
  ),
  d AS (
    SELECT p.braco,
           count(s.id) AS linhas,
           count(s.id) FILTER (WHERE s.desfecho IS NULL) AS abertas,
           COALESCE(bool_or(s.desfecho = 'virou_pedido'), false) AS virou,
           COALESCE(bool_or(s.desfecho = 'nao_medivel'), false) AS algum_nm
      FROM prim p
      LEFT JOIN public.venda_sugestao s
             ON s.fase = 'ativa' AND s.tipo = 'recompra' AND s.farmer_user_id = p.farmer_user_id
            AND s.comprador_id = p.comprador_id AND s.dia_referencia = p.dia
     GROUP BY p.comprador_id, p.braco
  ),
  b AS (
    SELECT d.braco,
           count(*) AS compradores,
           count(*) FILTER (WHERE d.linhas = 0) AS sem_linhas,
           count(*) FILTER (WHERE d.linhas > 0 AND d.abertas = 0) AS maduros,
           count(*) FILTER (WHERE d.linhas > 0 AND d.abertas = 0 AND d.virou) AS converteram,
           count(*) FILTER (WHERE d.linhas > 0 AND d.abertas = 0 AND NOT d.virou AND d.algum_nm) AS nao_medivel
      FROM d GROUP BY d.braco
  )
  SELECT jsonb_object_agg(b.braco, jsonb_build_object(
           'compradores', b.compradores, 'maduros', b.maduros, 'converteram', b.converteram,
           'nao_medivel', b.nao_medivel, 'sem_linhas', b.sem_linhas,
           'taxa', CASE WHEN b.maduros - b.nao_medivel > 0
                        THEN round(b.converteram::numeric / (b.maduros - b.nao_medivel), 4) END))
    INTO v_ef FROM b;
  v_ef := COALESCE(v_ef, '{}'::jsonb);

  v_dif := (v_ef -> 'tratamento' ->> 'taxa')::numeric - (v_ef -> 'controle' ->> 'taxa')::numeric;
  IF v_dif IS NOT NULL THEN
    SELECT (v_ef -> 'tratamento' ->> 'taxa')::numeric AS p,
           ((v_ef -> 'tratamento' ->> 'maduros')::int - (v_ef -> 'tratamento' ->> 'nao_medivel')::int) AS n INTO t;
    SELECT (v_ef -> 'controle' ->> 'taxa')::numeric AS p,
           ((v_ef -> 'controle' ->> 'maduros')::int - (v_ef -> 'controle' ->> 'nao_medivel')::int) AS n INTO c;
    v_ep := sqrt(t.p * (1 - t.p) / t.n + c.p * (1 - c.p) / c.n);
  END IF;
  v_ef := v_ef || jsonb_build_object(
    'diferenca', round(v_dif, 4),
    'ic95', CASE WHEN v_dif IS NOT NULL THEN jsonb_build_array(round(v_dif - 1.96 * v_ep, 4), round(v_dif + 1.96 * v_ep, 4)) END,
    'aviso', 'Controle = compradores sorteados que seriam enviados e não foram. Só coorte madura (14 dias fechados). '
          || 'Com poucos compradores o intervalo é largo: inconclusivo não significa ausência de efeito.');

  -- A/A no histórico (diagnóstico do sorteio, por linha): os braços deviam converter igual ANTES do e-mail existir.
  SELECT COALESCE(jsonb_object_agg(q.braco, jsonb_build_object('virou', q.virou, 'nao_virou', q.nao_virou,
           'taxa', CASE WHEN q.virou + q.nao_virou > 0 THEN round(q.virou::numeric / (q.virou + q.nao_virou), 4) END)), '{}'::jsonb)
    INTO v_aa
    FROM (SELECT bc.braco,
                 count(*) FILTER (WHERE s.desfecho = 'virou_pedido') AS virou,
                 count(*) FILTER (WHERE s.desfecho = 'nao_virou') AS nao_virou
            FROM public.venda_sugestao s
            JOIN public.venda_braco_comprador bc ON bc.comprador_id = s.comprador_id
           WHERE s.fase = 'historico' AND s.tipo = 'recompra'
           GROUP BY bc.braco) q;

  RETURN jsonb_build_object(
    'periodo', jsonb_build_object('de', p_de, 'ate', p_ate),
    'hoje', v_hoje,
    'sorteio', CASE WHEN v_s.id IS NOT NULL THEN jsonb_build_object(
                 'inicio', v_s.inicio, 'fracao_controle', v_s.fracao_controle, 'algoritmo', v_s.algoritmo,
                 'realizado_em', v_s.realizado_em,
                 'compradores', (SELECT count(*) FROM public.venda_braco_comprador),
                 'controle', (SELECT count(*) FROM public.venda_braco_comprador WHERE braco = 'controle')) END,
    'dias', v_dias,
    'farmers', v_farm,
    'efeito', v_ef,
    'aa_historico', v_aa);
END
$$;

-- ════════════════ 5. O controle sai do que a farmer vê (corpos VIVOS de prod + o filtro de braço) ═══════════════
-- Base: pg_get_functiondef via psql-ro em 12/11/2026 (md5 na PRE). Única mudança em cada uma: o filtro
-- `braco IS DISTINCT FROM 'controle'` (NULL = linha anterior ao sorteio, segue visível como sempre foi).

CREATE OR REPLACE FUNCTION private._venda_sugestoes_json(p_farmer uuid, p_dia date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ondas jsonb;
  v_out   jsonb;
BEGIN
  IF p_farmer IS NULL OR p_dia IS NULL THEN
    RAISE EXCEPTION '_venda_sugestoes_json: p_farmer/p_dia NULL' USING ERRCODE = '22023';
  END IF;

  -- Liga/desliga do servidor (vale para o aparelho da farmer). Chave ausente = desligada.
  SELECT jsonb_build_object(
           'recompra',    COALESCE(bool_or(c.chave = 'onda_recompra'    AND c.valor = 'true'::jsonb), false),
           'complemento', COALESCE(bool_or(c.chave = 'onda_complemento' AND c.valor = 'true'::jsonb), false),
           'preco',       COALESCE(bool_or(c.chave = 'onda_preco'       AND c.valor = 'true'::jsonb), false))
    INTO v_ondas
    FROM public.venda_config c;

  WITH s AS (
    SELECT s.*, op.descricao, round(vr.cadencia_dias)::int AS cadencia_dias, ho.nomes AS herdada_de
      FROM public.venda_sugestao s
      LEFT JOIN LATERAL (
        SELECT o.descricao FROM public.omie_products o
         WHERE o.omie_codigo_produto = s.omie_codigo_produto AND o.account = s.empresa
         LIMIT 1) op ON true
      LEFT JOIN public.venda_recompra vr
             ON s.tipo = 'recompra' AND vr.comprador_id = s.comprador_id
            AND vr.empresa = s.empresa AND vr.omie_codigo_produto = s.omie_codigo_produto
      -- A herança (PR B): o nome de quem passou o histórico, por evento da origem. Compara o evento como TEXTO:
      -- um elemento fora da forma vira "sem nome", nunca um cast que derruba a lista inteira.
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(DISTINCT COALESCE(
                 (SELECT r.nome FROM private.cliente_resolver_documento(cs.antigo_documento) r), cs.antigo_documento))
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.sucessao_origem) = 'array'
                                         THEN s.sucessao_origem ELSE '[]'::jsonb END) e(el)
          JOIN LATERAL (
            SELECT c.antigo_documento FROM public.cliente_sucessoes c
             WHERE c.evento_id::text = e.el ->> 'evento_id'
             ORDER BY c.declarado_em, c.id LIMIT 1) cs ON true
        ) ho(nomes) ON s.sucessao_origem IS NOT NULL
     WHERE s.fase = 'ativa'
       AND s.braco IS DISTINCT FROM 'controle'
       AND s.farmer_user_id = p_farmer
       AND s.dia_referencia = p_dia
  ),
  c AS (
    SELECT s.comprador_id,
           min(s.motivo_entrada) FILTER (WHERE s.tipo = 'recompra') AS motivo_entrada,
           -- ausente ≠ zero: total só quando TODAS as sugestões de recompra têm valor de referência.
           CASE WHEN bool_and(s.valor_ref IS NOT NULL) FILTER (WHERE s.tipo = 'recompra')
                THEN sum(s.valor_ref) FILTER (WHERE s.tipo = 'recompra') END AS valor_ref_total,
           COALESCE(bool_or(s.valor_ref_referencia_origem AND s.valor_ref IS NOT NULL)
                      FILTER (WHERE s.tipo = 'recompra'), false) AS valor_ref_total_referencia_origem,
           jsonb_agg(jsonb_build_object(
             'id', s.id, 'tipo', s.tipo, 'empresa', s.empresa,
             'omie_codigo_produto', s.omie_codigo_produto, 'descricao', s.descricao,
             'familia', s.familia, 'qtd_ref', s.qtd_ref, 'valor_ref', s.valor_ref,
             'preco_alvo', s.preco_alvo, 'cadencia_dias', s.cadencia_dias,
             'sucessao_origem', s.sucessao_origem, 'herdada_de', s.herdada_de,
             'valor_ref_referencia_origem', s.valor_ref_referencia_origem)
             ORDER BY s.tipo, s.valor_ref DESC NULLS LAST, s.omie_codigo_produto, s.familia) AS sugestoes
      FROM s
     GROUP BY s.comprador_id
  )
  SELECT jsonb_build_object(
           'dia', p_dia,
           'ondas', v_ondas,
           'compradores', COALESCE(jsonb_agg(jsonb_build_object(
               'comprador_id', c.comprador_id,
               'nome', pr.nome,
               'telefone', pr.telefone,
               'motivo_entrada', c.motivo_entrada,
               'valor_ref_total', c.valor_ref_total,
               'valor_ref_total_referencia_origem', c.valor_ref_total_referencia_origem,
               'sugestoes', c.sugestoes)
             ORDER BY c.valor_ref_total DESC NULLS LAST, c.comprador_id), '[]'::jsonb))
    INTO v_out
    FROM c
    LEFT JOIN LATERAL (
      SELECT COALESCE(p.name, p.razao_social) AS nome, p.phone AS telefone
        FROM public.profiles p WHERE p.user_id = c.comprador_id
       ORDER BY p.created_at LIMIT 1) pr ON true;

  RETURN v_out;
END
$function$;

CREATE OR REPLACE FUNCTION public.venda_marcar_mostrada(p_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_n   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'venda_marcar_mostrada: sem sessao' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'venda_marcar_mostrada: mais de 500 ids' USING ERRCODE = '22023';
  END IF;

  -- Controle do experimento (venda R2) nunca é mostrado. Primeira exibição vence; só linhas ATIVAS da própria farmer (na lente "Ver como" o uid é o
  -- do master, que não é dono de nada — não fabrica "mostrada").
  UPDATE public.venda_sugestao
     SET mostrada_em = now()
   WHERE id = ANY (p_ids)
     AND farmer_user_id = v_uid
     AND fase = 'ativa'
     AND mostrada_em IS NULL
     AND braco IS DISTINCT FROM 'controle';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$function$;

-- venda_painel: só as CTEs `ativa` e `lista` e a régua da Onda 2 ganham o filtro — a adoção (na lista, mostradas,
-- contatados) e a conversão `ativa` passam a contar só o que a farmer pode ver. Linha de base (historico/sombra) intacta.
CREATE OR REPLACE FUNCTION public.venda_painel(p_de date, p_ate date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_ini date;
  v_fim date;   -- exclusivo
  v_cfg_on1 boolean; v_cfg_on2 boolean; v_cfg_on3 boolean;
  v_base_confiavel boolean;
  v_linhas jsonb;
  v_hist_dias int;
  v_sombra_dias jsonb := '[]'::jsonb;
  v_d date;
  v_semanas jsonb := '[]'::jsonb;
  v_seg date;
  v_n_farmers int;
  v_min_taxa numeric;
  v_repasse boolean;
  v_ondas jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'venda_painel: requer master' USING ERRCODE = '42501';
  END IF;
  IF p_de IS NULL OR p_ate IS NULL OR p_ate < p_de OR p_ate - p_de > 400 THEN
    RAISE EXCEPTION 'PAINEL_PERIODO: periodo invalido (de=%, ate=%; maximo 400 dias)', p_de, p_ate
      USING ERRCODE = '22023';
  END IF;

  -- semanas inteiras (seg–dom) que tocam o período
  v_ini := date_trunc('week', p_de)::date;
  v_fim := date_trunc('week', p_ate)::date + 7;

  SELECT COALESCE(bool_or(chave = 'onda_recompra'    AND valor = 'true'::jsonb), false),
         COALESCE(bool_or(chave = 'onda_complemento' AND valor = 'true'::jsonb), false),
         COALESCE(bool_or(chave = 'onda_preco'       AND valor = 'true'::jsonb), false)
    INTO v_cfg_on1, v_cfg_on2, v_cfg_on3
    FROM public.venda_config;

  v_base_confiavel := EXISTS (SELECT 1 FROM public.venda_onda_log WHERE onda = 'onda_recompra');

  -- ── por farmer × semana ────────────────────────────────────────────────────────────────────
  WITH semanas AS (
    SELECT g::date AS semana FROM generate_series(v_ini, v_fim - 7, interval '7 days') g
  ),
  farmers AS (
    SELECT cr.user_id AS farmer_user_id
      FROM public.commercial_roles cr
     WHERE cr.commercial_role = 'farmer'
    UNION
    SELECT DISTINCT s.farmer_user_id
      FROM public.venda_sugestao s
     WHERE s.fase IN ('ativa', 'sombra') AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
  ),
  ativa AS (
    SELECT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date AS semana,
           count(DISTINCT s.comprador_id)                                              AS na_lista,
           count(DISTINCT s.comprador_id) FILTER (WHERE s.mostrada_em IS NOT NULL)     AS mostradas,
           count(DISTINCT s.comprador_id) FILTER (WHERE s.tipo = 'recompra'
                                                    AND s.desfecho = 'virou_pedido')   AS compraram,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho = 'virou_pedido') AS virou,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho = 'nao_virou')    AS nao_virou,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho = 'nao_medivel')  AS nao_medivel,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho IS NULL)          AS pendentes,
           sum(s.valor_realizado) FILTER (WHERE s.tipo = 'recompra'
                                            AND s.desfecho = 'virou_pedido')           AS receita,
           COALESCE(bool_or(s.tipo = 'recompra' AND s.desfecho = 'virou_pedido'
                            AND s.valor_realizado IS NULL), false)                     AS receita_incompleta,
           -- sucessor declarado (entrega 3): a fatia HERDADA (sucessao_origem preenchida pelo gerador) — as
           -- mesmas réguas de cima, só restritas a ela; a taxa própria sai por diferença, no SELECT final
           count(DISTINCT s.comprador_id) FILTER (WHERE s.sucessao_origem IS NOT NULL)   AS h_na_lista,
           count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL)                         AS h_sugestoes,
           count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                              AND s.desfecho = 'virou_pedido')                           AS h_virou,
           count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                              AND s.desfecho = 'nao_virou')                              AS h_nao_virou,
           count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                              AND s.desfecho = 'nao_medivel')                            AS h_nao_medivel,
           count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                              AND s.desfecho IS NULL)                                    AS h_pendentes,
           sum(s.valor_realizado) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                                            AND s.desfecho = 'virou_pedido')           AS h_receita,
           COALESCE(bool_or(s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                            AND s.desfecho = 'virou_pedido' AND s.valor_realizado IS NULL), false)
                                                                                         AS h_receita_incompleta
      FROM public.venda_sugestao s
     WHERE s.fase = 'ativa' AND s.braco IS DISTINCT FROM 'controle'
       AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
     GROUP BY 1, 2
  ),
  lista AS (
    SELECT DISTINCT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date AS semana, s.comprador_id
      FROM public.venda_sugestao s
     WHERE s.fase = 'ativa' AND s.braco IS DISTINCT FROM 'controle'
       AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
  ),
  contatos AS (
    SELECT l.farmer_user_id, l.semana, count(*) AS contatados
      FROM lista l
     WHERE EXISTS (SELECT 1 FROM public.venda_contato c
                    WHERE c.farmer_user_id = l.farmer_user_id AND c.comprador_id = l.comprador_id
                      AND c.dia >= l.semana AND c.dia < l.semana + 7)
     GROUP BY 1, 2
  ),
  sombra AS (
    SELECT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date AS semana,
           count(DISTINCT s.comprador_id) AS na_lista
      FROM public.venda_sugestao s
     WHERE s.fase = 'sombra' AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
     GROUP BY 1, 2
  ),
  -- mesma semana do ano anterior: 52 semanas = 364 dias (segunda cai em segunda)
  hist AS (
    SELECT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date + 364 AS semana,
           count(*) FILTER (WHERE s.desfecho = 'virou_pedido') AS virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_virou')    AS nao_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_medivel')  AS nao_medivel,
           count(*) FILTER (WHERE s.desfecho IS NULL)          AS pendentes,
           -- a base PRÓPRIA (sem herdadas): o gerador grava a origem nas três fases, então a base também mistura
           count(*) FILTER (WHERE s.desfecho = 'virou_pedido' AND s.sucessao_origem IS NULL) AS p_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_virou'    AND s.sucessao_origem IS NULL) AS p_nao_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_medivel'  AND s.sucessao_origem IS NULL) AS p_nao_medivel,
           count(*) FILTER (WHERE s.desfecho IS NULL          AND s.sucessao_origem IS NULL) AS p_pendentes
      FROM public.venda_sugestao s
     WHERE s.fase = 'historico' AND s.tipo = 'recompra'
       AND s.dia_referencia >= v_ini - 364 AND s.dia_referencia < v_fim - 364
     GROUP BY 1, 2
  ),
  -- sombra (antes do go-live) inteira, por farmer — a 2ª linha de base
  base_sombra AS (
    SELECT s.farmer_user_id,
           count(*) FILTER (WHERE s.desfecho = 'virou_pedido') AS virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_virou')    AS nao_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_medivel')  AS nao_medivel,
           count(*) FILTER (WHERE s.desfecho IS NULL)          AS pendentes,
           count(*) FILTER (WHERE s.desfecho = 'virou_pedido' AND s.sucessao_origem IS NULL) AS p_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_virou'    AND s.sucessao_origem IS NULL) AS p_nao_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_medivel'  AND s.sucessao_origem IS NULL) AS p_nao_medivel,
           count(*) FILTER (WHERE s.desfecho IS NULL          AND s.sucessao_origem IS NULL) AS p_pendentes
      FROM public.venda_sugestao s
     WHERE s.fase = 'sombra' AND s.tipo = 'recompra'
     GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'farmer_user_id',   f.farmer_user_id,
           'farmer_nome',      p.name,
           'semana',           sm.semana,
           'na_lista',         COALESCE(a.na_lista, 0),
           'mostradas',        COALESCE(a.mostradas, 0),
           'contatados',       COALESCE(ct.contatados, 0),
           'compraram',        COALESCE(a.compraram, 0),
           'virou',            COALESCE(a.virou, 0),
           'nao_virou',        COALESCE(a.nao_virou, 0),
           'nao_medivel',      COALESCE(a.nao_medivel, 0),
           'pendentes',        COALESCE(a.pendentes, 0),
           -- ausente ≠ zero: sem nenhuma venda casada a receita é NULL, não R$ 0
           'receita_realizada', a.receita,
           'receita_incompleta', COALESCE(a.receita_incompleta, false),
           'taxa_ativa',       round(a.virou::numeric / NULLIF(a.virou + a.nao_virou, 0), 4),
           'na_lista_sombra',  COALESCE(so.na_lista, 0),
           'base_historico',   jsonb_build_object(
                                 'virou', COALESCE(h.virou, 0), 'nao_virou', COALESCE(h.nao_virou, 0),
                                 'nao_medivel', COALESCE(h.nao_medivel, 0), 'pendentes', COALESCE(h.pendentes, 0)),
           'taxa_base_historico_mesma_semana', round(h.virou::numeric / NULLIF(h.virou + h.nao_virou, 0), 4),
           'base_sombra',      jsonb_build_object(
                                 'virou', COALESCE(bs.virou, 0), 'nao_virou', COALESCE(bs.nao_virou, 0),
                                 'nao_medivel', COALESCE(bs.nao_medivel, 0), 'pendentes', COALESCE(bs.pendentes, 0)),
           'taxa_base_sombra', round(bs.virou::numeric / NULLIF(bs.virou + bs.nao_virou, 0), 4),
           'base_confiavel',   v_base_confiavel,
           -- sucessor declarado: a parte herdada da linha (ausente ≠ zero: receita NULL sem venda casada)
           'herdadas',         jsonb_build_object(
                                 'na_lista', COALESCE(a.h_na_lista, 0), 'sugestoes', COALESCE(a.h_sugestoes, 0),
                                 'virou', COALESCE(a.h_virou, 0), 'nao_virou', COALESCE(a.h_nao_virou, 0),
                                 'nao_medivel', COALESCE(a.h_nao_medivel, 0), 'pendentes', COALESCE(a.h_pendentes, 0),
                                 'receita_realizada', a.h_receita,
                                 'receita_incompleta', COALESCE(a.h_receita_incompleta, false)),
           -- a conversão SEM as herdadas: o histórico delas inclui compras da antiga, a própria não
           'taxa_ativa_propria', round((a.virou - a.h_virou)::numeric
                                       / NULLIF((a.virou - a.h_virou) + (a.nao_virou - a.h_nao_virou), 0), 4),
           -- e a linha de base com a MESMA régua (sem herdadas): própria × própria, nunca própria × mistura
           'base_historico_propria', jsonb_build_object(
                                 'virou', COALESCE(h.p_virou, 0), 'nao_virou', COALESCE(h.p_nao_virou, 0),
                                 'nao_medivel', COALESCE(h.p_nao_medivel, 0), 'pendentes', COALESCE(h.p_pendentes, 0)),
           'taxa_base_historico_propria', round(h.p_virou::numeric / NULLIF(h.p_virou + h.p_nao_virou, 0), 4),
           'base_sombra_propria', jsonb_build_object(
                                 'virou', COALESCE(bs.p_virou, 0), 'nao_virou', COALESCE(bs.p_nao_virou, 0),
                                 'nao_medivel', COALESCE(bs.p_nao_medivel, 0), 'pendentes', COALESCE(bs.p_pendentes, 0)),
           'taxa_base_sombra_propria', round(bs.p_virou::numeric / NULLIF(bs.p_virou + bs.p_nao_virou, 0), 4)
         ) ORDER BY p.name NULLS LAST, f.farmer_user_id, sm.semana DESC), '[]'::jsonb)
    INTO v_linhas
    FROM farmers f
   CROSS JOIN semanas sm
    LEFT JOIN public.profiles p ON p.user_id = f.farmer_user_id
    LEFT JOIN ativa a     ON a.farmer_user_id = f.farmer_user_id AND a.semana = sm.semana
    LEFT JOIN contatos ct ON ct.farmer_user_id = f.farmer_user_id AND ct.semana = sm.semana
    LEFT JOIN sombra so   ON so.farmer_user_id = f.farmer_user_id AND so.semana = sm.semana
    LEFT JOIN hist h      ON h.farmer_user_id = f.farmer_user_id AND h.semana = sm.semana
    LEFT JOIN base_sombra bs ON bs.farmer_user_id = f.farmer_user_id;

  -- ── ondas: estado + pré-requisitos da PRÓXIMA avaliação (leitura; quem liga é o cron) ──────────
  -- Onda 1: as mesmas condições baratas de venda_avaliar_ondas (dias de histórico, sombra ao vivo
  -- nos 3 dias anteriores). A comparação de lista idêntica é do cron (custa ~8 s/dia).
  SELECT count(*) INTO v_hist_dias
    FROM public.venda_gerador_execucao WHERE fase = 'historico' AND dia_referencia < v_hoje;
  FOR i IN 1..3 LOOP
    v_d := v_hoje - i;
    v_sombra_dias := v_sombra_dias || jsonb_build_object('dia', v_d, 'ao_vivo', EXISTS (
      SELECT 1 FROM public.venda_gerador_execucao e
       WHERE e.dia_referencia = v_d AND e.fase = 'sombra'
         AND (e.primeira_em AT TIME ZONE 'America/Sao_Paulo')::date = v_d));
  END LOOP;

  -- Onda 2: ≥ 80% de contatados por farmer em cada uma das 2 últimas semanas completas.
  FOR i IN 1..2 LOOP
    v_seg := date_trunc('week', v_hoje)::date - 7 * i;
    WITH lista AS (
      SELECT DISTINCT s.farmer_user_id, s.comprador_id
        FROM public.venda_sugestao s
       WHERE s.fase = 'ativa' AND s.braco IS DISTINCT FROM 'controle'
         AND s.dia_referencia >= v_seg AND s.dia_referencia < v_seg + 7
    ),
    por_farmer AS (
      SELECT l.farmer_user_id,
             (count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM public.venda_contato c
                 WHERE c.farmer_user_id = l.farmer_user_id AND c.comprador_id = l.comprador_id
                   AND c.dia >= v_seg AND c.dia < v_seg + 7)))::numeric / count(*) AS taxa
        FROM lista l
       GROUP BY l.farmer_user_id
    )
    SELECT count(*), min(pf.taxa) INTO v_n_farmers, v_min_taxa FROM por_farmer pf;
    v_semanas := v_semanas || jsonb_build_object('semana', v_seg, 'farmers', v_n_farmers,
                                                 'menor_taxa', round(v_min_taxa, 4),
                                                 'ok', v_n_farmers > 0 AND v_min_taxa >= 0.8);
  END LOOP;

  -- Onda 3: ≥ 1 repasse aprovado vigente (tabela da Task 6; ausente = NULL, "não sei", não false).
  v_repasse := NULL;
  IF to_regclass('public.venda_repasse_aprovado') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.venda_repasse_aprovado
                               WHERE revogado_em IS NULL AND valido_ate >= $1)'
         INTO v_repasse USING v_hoje;
    EXCEPTION WHEN undefined_column OR undefined_table THEN
      v_repasse := NULL;
    END;
  END IF;

  SELECT jsonb_build_object(
    'onda_recompra', jsonb_build_object(
      'ligada', v_cfg_on1,
      'ligada_em', (SELECT l.ligada_em FROM public.venda_onda_log l WHERE l.onda = 'onda_recompra'),
      'condicao_ao_ligar', (SELECT l.condicao FROM public.venda_onda_log l WHERE l.onda = 'onda_recompra'),
      'prerequisitos', jsonb_build_object(
        'historico_dias', v_hist_dias, 'historico_meta', 365,
        'sombra_ao_vivo', v_sombra_dias,
        -- o cron avalia e DEPOIS gera a lista do dia: lista de hoje gravada = avaliação de hoje já rodou
        'avaliada_hoje', EXISTS (SELECT 1 FROM public.venda_gerador_execucao e
                                  WHERE e.dia_referencia = v_hoje AND e.fase IN ('sombra', 'ativa')))),
    'onda_complemento', jsonb_build_object(
      'ligada', v_cfg_on2,
      'ligada_em', (SELECT l.ligada_em FROM public.venda_onda_log l WHERE l.onda = 'onda_complemento'),
      'condicao_ao_ligar', (SELECT l.condicao FROM public.venda_onda_log l WHERE l.onda = 'onda_complemento'),
      'prerequisitos', jsonb_build_object('onda_recompra_ligada', v_cfg_on1, 'semanas', v_semanas)),
    'onda_preco', jsonb_build_object(
      'ligada', v_cfg_on3,
      'ligada_em', (SELECT l.ligada_em FROM public.venda_onda_log l WHERE l.onda = 'onda_preco'),
      'condicao_ao_ligar', (SELECT l.condicao FROM public.venda_onda_log l WHERE l.onda = 'onda_preco'),
      'prerequisitos', jsonb_build_object('onda_complemento_ligada', v_cfg_on2, 'repasse_vigente', v_repasse)))
    INTO v_ondas;

  RETURN jsonb_build_object(
    'hoje', v_hoje,
    'periodo', jsonb_build_object('de', v_ini, 'ate', v_fim - 1),
    'base_confiavel', v_base_confiavel,
    'repasse_disponivel', to_regprocedure('public.venda_repasse_candidatos()') IS NOT NULL,
    'linhas', v_linhas,
    'ondas', v_ondas);
END
$function$;

-- ════════════════════════════════ 6. ACL ═════════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION public.venda_resumo_preparar(date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_resumo_preparar(date, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.venda_resumo_registrar_abertura(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_resumo_registrar_abertura(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.venda_resumo_abrir(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_resumo_abrir(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.venda_resumo_painel(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_resumo_painel(date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.venda_marcar_mostrada(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.venda_painel(date, date) FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION private.venda_braco_u(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_braco_imutavel() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_braco_atribuir(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_sugestao_braco() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_prox_dia_util(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_brl(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_qtd(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_resumo_ranking(uuid, date, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_resumo_bloco(uuid, date, uuid, integer, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_resumo_oportunidades() FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════ 7. CRON ════════════════════════════════════════════════════════════════════
-- 09:35 UTC = 06:35 SP, seg–sex: depois do gerador (08:15 UTC) e do fechamento de desfechos (09:30 UTC). O SQL só
-- enfileira o alerta; o envio é o cron já existente da dispatch-notifications (*/30, net.http_post com
-- timeout_milliseconds 60000) → e-mail ~07:00 SP. Sem net.http_post novo.
SELECT cron.schedule('venda-resumo-email', '35 9 * * 1-5', 'SELECT public.venda_resumo_preparar();');

-- ════════════════════════════════ PÓS-CONDIÇÃO ═══════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v  record;
  t  text;
  f  text;
BEGIN
  -- P1 o sorteio é o desta migration
  SELECT s.* INTO v FROM public.venda_braco_sorteio s WHERE s.id = 1;
  IF NOT FOUND OR v.semente <> 'venda-r2-controle-2026-11-12' OR v.fracao_controle <> 0.15
     OR v.algoritmo <> 'md5-32-v1' THEN
    RAISE EXCEPTION 'P1 FALHOU: sorteio ausente ou com outra semente/fracao/algoritmo';
  END IF;
  -- P2 cada braço gravado segue a régua (recalculada aqui) e o sorteio inicial bate com o singleton
  IF (SELECT count(*) FROM public.venda_braco_comprador WHERE origem = 'sorteio_inicial') <> v.n_inicial
     OR (SELECT count(*) FROM public.venda_braco_comprador WHERE origem = 'sorteio_inicial' AND braco = 'controle')
        <> v.n_inicial_controle THEN
    RAISE EXCEPTION 'P2 FALHOU: sorteio inicial nao bate com n_inicial/n_inicial_controle';
  END IF;
  IF EXISTS (SELECT 1 FROM public.venda_braco_comprador b
              WHERE b.u <> private.venda_braco_u(v.semente, b.comprador_id)
                 OR (b.braco = 'controle') <> (b.u < v.fracao_controle)) THEN
    RAISE EXCEPTION 'P2 FALHOU: braco gravado fora da regua md5-32-v1';
  END IF;
  -- P3 coluna + check VALIDADO + trigger habilitado
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.venda_sugestao'::regclass
                    AND conname = 'venda_sugestao_braco_ck' AND convalidated)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.venda_sugestao'::regclass
                       AND tgname = 'venda_sugestao_braco_trg' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'P3 FALHOU: venda_sugestao.braco sem check validado ou trigger habilitado';
  END IF;
  -- P4 nenhuma linha ativa do início em diante sem braço
  IF EXISTS (SELECT 1 FROM public.venda_sugestao s
              WHERE s.fase = 'ativa' AND s.dia_referencia >= v.inicio AND s.braco IS NULL) THEN
    RAISE EXCEPTION 'P4 FALHOU: linha ativa >= inicio sem braco';
  END IF;
  -- P5 tabelas novas: RLS ligada; anon nada; ninguém escreve direto
  FOREACH t IN ARRAY ARRAY['venda_braco_sorteio', 'venda_braco_comprador', 'venda_resumo_config', 'venda_resumo_selecao',
                           'venda_resumo_item', 'venda_resumo_envio', 'venda_resumo_link'] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = ('public.' || t)::regclass)
       OR has_table_privilege('anon', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_table_privilege('service_role', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION 'P5 FALHOU: % sem RLS ou com escrita/leitura aberta', t;
    END IF;
  END LOOP;
  -- P6 funções: PUBLIC e anon fechados em todas; authenticated fora do preparo e da abertura
  FOREACH f IN ARRAY ARRAY['public.venda_resumo_preparar(date,uuid)', 'public.venda_resumo_registrar_abertura(uuid)',
                           'public.venda_resumo_abrir(uuid)', 'public.venda_resumo_painel(date,date)',
                           'public.venda_marcar_mostrada(uuid[])', 'public.venda_painel(date,date)',
                           'private.venda_braco_atribuir(uuid)', 'private.venda_sugestao_braco()',
                           'private.venda_resumo_ranking(uuid,date,integer,integer)',
                           'private.venda_resumo_bloco(uuid,date,uuid,integer,text,numeric,text)',
                           'private.venda_resumo_oportunidades()'] LOOP
    IF to_regprocedure(f) IS NULL
       OR has_function_privilege('public', to_regprocedure(f), 'EXECUTE')
       OR has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION 'P6 FALHOU: % ausente ou aberta a PUBLIC/anon', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.venda_resumo_preparar(date,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.venda_resumo_registrar_abertura(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.venda_resumo_abrir(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.venda_resumo_painel(date,date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.venda_resumo_registrar_abertura(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: ACL de authenticated/service_role fora do desenho';
  END IF;
  -- P7 os três corpos recriados são ESTES
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('private._venda_sugestoes_json(uuid,date)'))
       IS DISTINCT FROM 'ccc8189a3d2962e073a3d360581efb61'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.venda_marcar_mostrada(uuid[])'))
       IS DISTINCT FROM '3e286aaea8d6f4c7b1bce316824d5be7'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.venda_painel(date,date)'))
       IS DISTINCT FROM '76d2d0f050e9240392cd1362ef2d82bd' THEN
    RAISE EXCEPTION 'P7 FALHOU: corpo recriado nao e o deste arquivo';
  END IF;
  -- P8 a policy da farmer esconde o controle
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'venda_sugestao'
                    AND policyname = 'venda_sugestao_select' AND qual LIKE '%braco%controle%') THEN
    RAISE EXCEPTION 'P8 FALHOU: policy venda_sugestao_select sem o filtro do controle';
  END IF;
  -- P9 cron
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'venda-resumo-email' AND schedule = '35 9 * * 1-5'
                    AND command = 'SELECT public.venda_resumo_preparar();' AND active) THEN
    RAISE EXCEPTION 'P9 FALHOU: cron venda-resumo-email ausente ou diferente';
  END IF;
  RAISE NOTICE 'venda-resumo-email OK: sorteio % (inicio %, % compradores, % controle)',
    v.semente, v.inicio, v.n_inicial, v.n_inicial_controle;
END
$post$;
