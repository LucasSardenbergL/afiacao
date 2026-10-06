-- sku_items_sync_controle.itens_pendentes — a fila do omie-sync-sku-items passa a exigir EVIDÊNCIA de
-- completude do recebimento, e não só "alguma linha gravada em sku_leadtime_history".
--
-- POR QUÊ (2026-10-05, docs/historico/sku-items-pendencia-por-item.md): a fila era "tracking SEM
-- NENHUMA linha de leadtime". Bastava UMA linha gravada para o recebimento sair da fila para sempre,
-- e o item que faltava nunca voltava. Medido em prod: 0 falhas de upsert em 1.287 runs, mas 2 SKUs
-- perdidos em 63 recebimentos conferidos contra o payload — itens que vieram SEM nIdProduto na
-- consulta (associação pendente no recebimento da Omie) e eram pulados em silêncio.
--
-- A COLUNA: quantos ITENS da última lista observada ficaram sem linha (aguardando associação, lookup
-- de pedido com erro, upsert falho). A edge (writer único, via service_role) grava em TODAS as irmãs
-- do recebimento: antes dos upserts a pendência conservadora (write-ahead), depois a final (UPDATE com
-- CAS em ultima_tentativa). A fila: medida > 0 volta mesmo com linha; medida = 0 sai mesmo sem linha;
-- NULL segue a regra antiga.
--
-- ⚠️ NULL, SEM DEFAULT, DE PROPÓSITO: NULL = NÃO MEDIDO (legado, ou resposta sem lista). Um DEFAULT 0
-- diria "medido e completo" para as 144 linhas históricas — dado fabricado (ausente ≠ zero) — e a
-- regra nova tiraria da fila as irmãs sem linha delas, que a regra antiga ainda reconsulta.
--
-- ORDEM: aplicar ANTES do deploy da edge v1.4-pendencia-por-item — ela lê a coluna e, sem ela, a
-- leitura do controle falha FECHADA (todo run vira 'error'). A edge velha não lê nem escreve a coluna:
-- aplicar antes é inócuo.
--
-- Privilégio: service_role tem o da TABELA (arwdDxtm, medido 2026-10-05) e a coluna nova o herda;
-- anon/authenticated seguem sem nenhum (REVOKE da 20260715001500), e a RLS segue deny-all.

BEGIN;

ALTER TABLE public.sku_items_sync_controle
  ADD COLUMN IF NOT EXISTS itens_pendentes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sku_items_sync_controle'::regclass
      AND conname = 'sku_items_sync_controle_itens_pendentes_check'
  ) THEN
    ALTER TABLE public.sku_items_sync_controle
      ADD CONSTRAINT sku_items_sync_controle_itens_pendentes_check
      CHECK (itens_pendentes IS NULL OR itens_pendentes >= 0);
  END IF;
END
$$;

COMMENT ON COLUMN public.sku_items_sync_controle.itens_pendentes IS
  'Itens da última lista de ConsultarRecebimento sem linha em sku_leadtime_history (aguardando '
  'associação, lookup de pedido com erro, upsert falho). NULL = não medido (legado / resposta sem '
  'lista) — a fila usa a regra antiga ("sem linha"). >0 = volta à fila mesmo com linha; 0 = completo. '
  'Writer único: edge omie-sync-sku-items (write-ahead + fechamento com CAS em ultima_tentativa).';

COMMENT ON COLUMN public.sku_items_sync_controle.motivo IS
  'Desfecho da última tentativa: ok_com_itens | ok_todos_ignorados | ok_0_itens | '
  'ok_sem_itensRecebimento | pendente: <k> itens (...) | em_gravacao: ... | fault: <faultstring> | '
  'consulta_falhou: <erro>. Diagnóstico humano — quem decide a fila é itens_pendentes.';

-- Postcondição: a migration se recusa a terminar em silêncio (o SQL Editor não mostra NOTICE — o
-- veredito é o Success, isto é, a AUSÊNCIA de exception).
DO $post$
DECLARE
  v_tipo text;
  v_default text;
  v_nulo text;
  v_validada boolean;
BEGIN
  SELECT data_type, column_default, is_nullable
    INTO v_tipo, v_default, v_nulo
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'sku_items_sync_controle'
    AND column_name = 'itens_pendentes';

  -- A1: a coluna existe e é inteira
  IF v_tipo IS DISTINCT FROM 'integer' THEN
    RAISE EXCEPTION 'A1 FALHOU: itens_pendentes ausente ou com tipo % — a edge v1.4-pendencia-por-item falharia fechada em todo run', coalesce(v_tipo, '<ausente>');
  END IF;

  -- A2: sem default — um default constante viraria "pendência medida" em toda linha histórica
  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION 'A2 FALHOU: itens_pendentes tem DEFAULT % — fabricaria medida nas linhas legadas e tiraria da fila as irmãs sem linha', v_default;
  END IF;

  -- A3: aceita NULL (NULL = não medido; é o que mantém o legado na regra antiga)
  IF v_nulo IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'A3 FALHOU: itens_pendentes é NOT NULL — o legado não teria como dizer "não medido"';
  END IF;

  -- A4: o CHECK de não-negativo existe E está validado sobre o acervo
  SELECT convalidated INTO v_validada
  FROM pg_constraint
  WHERE conrelid = 'public.sku_items_sync_controle'::regclass
    AND conname = 'sku_items_sync_controle_itens_pendentes_check';
  IF NOT coalesce(v_validada, false) THEN
    RAISE EXCEPTION 'A4 FALHOU: CHECK de itens_pendentes ausente ou NOT VALID — pendência negativa passaria e o predicado k>0 a esconderia';
  END IF;

  -- A5: a edge (service_role) lê e escreve a coluna
  IF NOT (has_column_privilege('service_role', 'public.sku_items_sync_controle', 'itens_pendentes', 'SELECT')
      AND has_column_privilege('service_role', 'public.sku_items_sync_controle', 'itens_pendentes', 'INSERT')
      AND has_column_privilege('service_role', 'public.sku_items_sync_controle', 'itens_pendentes', 'UPDATE')) THEN
    RAISE EXCEPTION 'A5 FALHOU: service_role sem SELECT/INSERT/UPDATE em itens_pendentes — o write-ahead falharia e nada seria gravado';
  END IF;

  -- A6: anon/authenticated seguem sem acesso (tabela de infraestrutura, deny-all)
  IF has_column_privilege('anon', 'public.sku_items_sync_controle', 'itens_pendentes', 'SELECT')
     OR has_column_privilege('authenticated', 'public.sku_items_sync_controle', 'itens_pendentes', 'SELECT') THEN
    RAISE EXCEPTION 'A6 FALHOU: anon/authenticated leem itens_pendentes — o REVOKE da tabela foi desfeito';
  END IF;

  RAISE NOTICE 'postcondicao OK: itens_pendentes integer NULL sem default, CHECK >= 0 validado, service_role com SELECT/INSERT/UPDATE, anon/authenticated sem acesso';
END
$post$;

COMMIT;
