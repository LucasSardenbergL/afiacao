-- FU4-F fase 3b — o LIMIAR da faixa deixa de ser um oráculo de custo.
--
-- ── O PROBLEMA (medido em prod 2026-08-13; achado por revisão adversarial no #1543) ──────────
-- O #1543 fechou o NÚMERO: `public.get_carteira_margem_faixa()` devolve a FAIXA sempre e
-- `margem_pct` só sob `private.cap_custo_ler`. Mas a faixa é decidida por dois limiares LIDOS
-- de `public.farmer_algorithm_config`:
--
--     WHEN b.pct < v_piso  THEN 'amarelo'   -- v_piso  = key 'margem_faixa_piso_pct'
--     WHEN b.pct < v_meta  THEN 'abaixo_da_meta'  -- v_meta = key 'margem_faixa_meta_pct'
--
-- ...e essa tabela é escrita por QUALQUER staff. Medido:
--   • policy `Staff can manage algorithm config` = FOR ALL, USING e WITH CHECK
--     `has_role(master) OR has_role(employee)`;
--   • `has_table_privilege('authenticated', ..., 'INSERT'/'UPDATE'/'DELETE')` = true.
--
-- Logo o gate de PROJEÇÃO é derrotável por BUSCA BINÁRIA. Um employee sem `cap_custo_ler`:
--   1. escreve `margem_faixa_piso_pct = X`;
--   2. chama a RPC e olha se o cliente virou `amarelo` (margem < X) ou seguiu `verde`;
--   3. repete ~13 vezes → recupera a margem com precisão arbitrária.
-- Como ele já vê a receita do cliente, `custo = receita × (1 − margem)`. O #1543 escondeu o
-- número na SAÍDA; o limiar o devolvia por um canal lateral — cada chamada é uma comparação, e
-- comparações bastam para reconstruir o valor.
--
-- `motivo` amplia a sonda (devolve os DOIS limiares por chamada: `abaixo_do_piso` vs
-- `abaixo_da_meta` vs `saudavel`), mas não muda a natureza do furo: o que vaza é a ESCRITA.
--
-- ── A DECISÃO: quem escreve o limiar é quem JÁ PODE VER O NÚMERO ─────────────────────────────
-- O gate desta migration é `private.cap_custo_ler(auth.uid())` — o MESMO predicado do gate de
-- projeção da RPC — e não `has_role(master)`. Duas razões:
--
--   1. É o corte exato do ataque. O oráculo só tem valor para quem NÃO pode ler `margem_pct`;
--      para quem já lê o número, mover o limiar não revela absolutamente nada. Gatear por
--      `master` fecharia o furo, mas por uma coincidência (hoje `cap_custo_ler` ⊇ master), não
--      pelo motivo certo.
--   2. Não cria um segundo eixo de autorização. Com `cap_custo_ler`, "ver custo" e "calibrar a
--      régua de custo" continuam sendo UM conceito: no dia em que o dono conceder
--      `commercial_role = 'estrategico'` a alguém, essa pessoa ganha os dois de forma coerente,
--      sem uma segunda migration. Com `master` hardcoded, os dois eixos divergiriam em silêncio.
--
-- Hoje em prod os dois recortes coincidem (`cap_custo_ler` = master OR employee com
-- `estrategico`/`super_admin`; medido: 1 master, 2 employees, ZERO `estrategico`/`super_admin`),
-- então o efeito imediato é idêntico a "só o master escreve" — a diferença é de DESENHO.
--
-- ── POR QUE NÃO QUEBRA QUEM AJUSTA OS PESOS (levantado antes de escrever) ────────────────────
-- Os dois escritores da tabela no front:
--   • `src/pages/GovernanceMathParams.tsx` — grava SÓ `hs_weight_*` / `ps_weight_*` (as listas
--     `HEALTH_WEIGHTS`/`PRIORITY_WEIGHTS` são fixas no código). Nenhuma casa `margem_faixa_%`.
--   • `src/hooks/useFarmerGovernance.ts::approveProposal` — grava as keys de uma proposta
--     aprovada (arbitrárias). Tabela `farmer_governance_proposals` está VAZIA em prod.
-- Ambos já gateiam na UI por `commercial_role = 'super_admin'`, que NINGUÉM tem em prod — e
-- `farmer_audit_log` tem ZERO linhas com `entity_type='algorithm_config'`. Ou seja: nenhuma
-- escrita legítima existe hoje, e as que o desenho prevê (pesos) seguem livres para todo staff.
--
-- ── FORMA: policy RESTRICTIVE por comando ────────────────────────────────────────────────────
-- RESTRICTIVE é AND-ed com as permissivas existentes (que ficam intactas — menos risco de
-- regressão que reescrever `Staff can manage algorithm config`), e falha FECHADA.
-- Uma policy por comando, de propósito, para NÃO tocar o SELECT: `FOR ALL` restritiva também
-- filtraria leitura, e `GovernanceMathParams` faz `select('*')` na tabela inteira.
--
-- Os três comandos são necessários — fechar só o UPDATE deixa o oráculo de pé:
--   • INSERT — as keys HOJE NÃO EXISTEM (a RPC cai no COALESCE 30/50), então o atacante
--              criaria a linha do zero. Este é o caminho vivo hoje, não o UPDATE.
--   • UPDATE — precisa de USING **e** WITH CHECK. Só WITH CHECK deixaria passar o desvio
--              lateral `SET key='outra' WHERE key='margem_faixa_piso_pct'`: a linha resultante
--              não casa o predicado, o WITH CHECK aprova, e a key de faixa SOME — devolvendo o
--              limiar ao default 30 sem nunca ter escrito uma linha de faixa.
--   • DELETE — mesma classe do rename: apagar a linha reseta o limiar para o default.
--
-- `service_role` e `postgres` têm BYPASSRLS (medido) → edges e a própria RPC (SECURITY DEFINER,
-- owner=postgres) não são afetadas.
--
-- ⚠️ Grants de tabela de `anon` NÃO são tocados aqui: `db/audit-anon-dml-bypass.sh` registra a
-- decisão do repo de não revogar em massa (é o modelo do Supabase — grant amplo + RLS). `anon`
-- já é barrado pelas policies permissivas (`auth.uid()` IS NULL → `has_role` false).
--
-- Prova: `db/test-farmer-config-limiar-faixa.sh` (PG17 local, asserts negativos com SQLSTATE +
-- re-raise, RLS sob SET ROLE authenticated + GUC, e 4 sabotagens exigindo vermelho).

BEGIN;

-- ── 1) As linhas de limiar passam a EXISTIR ──────────────────────────────────────────────────
-- Hoje ausentes: a RPC vinha caindo no `COALESCE(..., 30)` / `COALESCE(..., 50)`. Semear com
-- exatamente esses valores é um NO-OP de comportamento (a faixa de todo mundo continua igual),
-- e torna o limiar auditável e ajustável sem deploy — que é o desenho do spec.
-- Os valores 30/50 foram medidos em prod (spec 2026-07-20 §3.1b, 746 clientes com margem).
-- `DO NOTHING` e não `DO UPDATE`: se a linha já existir por qualquer motivo, um re-apply da
-- migration não pode sobrescrever calibragem legítima. A validação pós-apply confere o valor.
--
-- ⚠️ EFEITO DURADOURO (não é no-op para sempre): a partir daqui o BANCO é a fonte efetiva desses
-- limiares. Se um dia o `COALESCE` da RPC mudar para 35/55, as linhas persistidas em 30/50
-- continuarão vencendo, e o default no código vira letra morta. Quem mexer no default da RPC
-- precisa mexer nestas linhas junto — ou a mudança não terá efeito nenhum.
INSERT INTO public.farmer_algorithm_config (key, value, description) VALUES
  ('margem_faixa_piso_pct', 30,
   'FU4-F: margem agregada abaixo deste % => faixa amarelo (motivo abaixo_do_piso). '
   'Escrita gateada por private.cap_custo_ler: o limiar e um oraculo do custo.'),
  ('margem_faixa_meta_pct', 50,
   'FU4-F: margem agregada abaixo deste % => verde/abaixo_da_meta; acima => verde/saudavel. '
   'Escrita gateada por private.cap_custo_ler: o limiar e um oraculo do custo.')
ON CONFLICT (key) DO NOTHING;

-- ── 2) A escrita das linhas de limiar exige o cap de custo ───────────────────────────────────
-- Predicado por PREFIXO e não por lista de keys: uma terceira chave de faixa criada amanhã nasce
-- protegida, sem precisar lembrar de editar a policy. O namespace `margem_faixa_` é o CONTRATO —
-- qualquer key sob ele exige o cap por definição. O preço dessa escolha é conhecido: uma chave
-- sensível batizada fora do prefixo (`margem_piso_novo`) nasceria DESPROTEGIDA. Por isso o
-- COMMENT ON TABLE abaixo declara o namespace, em vez de deixá-lo como convenção tácita.
--
-- `ESCAPE '!'` explícito: `_` é wildcard no LIKE e escapá-lo com `\` depende do escape DEFAULT do
-- Postgres. Declarar o escape torna o predicado independente dessa regra — sem isso, um dia com
-- `standard_conforming_strings` diferente o `_` voltaria a casar qualquer caractere (o predicado
-- ficaria mais FROUXO, nunca mais restrito).
--
-- `(SELECT ...)` envolvendo a chamada: forma que o planner avalia como InitPlan único por
-- instrução, em vez de uma chamada por linha num UPDATE em lote.
--
-- NULL-safety: `key` é NOT NULL, mas o predicado é fail-closed por construção — se `key` fosse
-- NULL, `NOT (NULL LIKE ...)` → NULL, e `NULL OR false` → NULL → a policy NEGA.

-- `DROP ... IF EXISTS` antes de cada `CREATE`: o apply é MANUAL (SQL Editor do Lovable) e
-- re-colar o bloco após uma falha parcial é rotina — sem isso o segundo Run morre em 42710.
DROP POLICY IF EXISTS "limiar_faixa_margem_insert_exige_cap_custo" ON public.farmer_algorithm_config;
CREATE POLICY "limiar_faixa_margem_insert_exige_cap_custo"
  ON public.farmer_algorithm_config
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    NOT (key LIKE 'margem!_faixa!_%' ESCAPE '!')
    OR COALESCE((SELECT private.cap_custo_ler((SELECT auth.uid()))), false)
  );

DROP POLICY IF EXISTS "limiar_faixa_margem_update_exige_cap_custo" ON public.farmer_algorithm_config;
CREATE POLICY "limiar_faixa_margem_update_exige_cap_custo"
  ON public.farmer_algorithm_config
  AS RESTRICTIVE FOR UPDATE
  USING (
    NOT (key LIKE 'margem!_faixa!_%' ESCAPE '!')
    OR COALESCE((SELECT private.cap_custo_ler((SELECT auth.uid()))), false)
  )
  WITH CHECK (
    NOT (key LIKE 'margem!_faixa!_%' ESCAPE '!')
    OR COALESCE((SELECT private.cap_custo_ler((SELECT auth.uid()))), false)
  );

DROP POLICY IF EXISTS "limiar_faixa_margem_delete_exige_cap_custo" ON public.farmer_algorithm_config;
CREATE POLICY "limiar_faixa_margem_delete_exige_cap_custo"
  ON public.farmer_algorithm_config
  AS RESTRICTIVE FOR DELETE
  USING (
    NOT (key LIKE 'margem!_faixa!_%' ESCAPE '!')
    OR COALESCE((SELECT private.cap_custo_ler((SELECT auth.uid()))), false)
  );

-- ── 3) TRUNCATE: o buraco que a RLS não tapa ────────────────────────────────────────────────
-- RLS **não se aplica a TRUNCATE** — nenhuma policy acima o intercepta. Medido em prod:
-- `has_table_privilege('authenticated', ..., 'TRUNCATE')` = true (o grant `arwdDxtm` que o
-- Supabase concede por default privilege inclui o `D`). Um TRUNCATE apagaria as linhas de limiar
-- e a RPC voltaria ao `COALESCE` default — anulando as policies acima sem violá-las.
--
-- Alcance honesto: NÃO é explorável pelo browser. O PostgREST não tem verbo para TRUNCATE, então
-- o employee com JWT não o alcança por HTTP; seria preciso conexão SQL direta, que ele não tem.
-- Revogar é defense-in-depth barato (nenhum caminho legítimo trunca config de algoritmo) e
-- fecha a classe inteira em vez de só o vetor conhecido.
--
-- Revogado POR NOME: `REVOKE ... FROM PUBLIC` seria no-op aqui — o Supabase concede às roles
-- nomeadas, não via PUBLIC (regra do repo). Só TRUNCATE sai; SELECT/INSERT/UPDATE/DELETE ficam,
-- porque é a RLS que os governa e revogá-los quebraria o app (`db/audit-anon-dml-bypass.sh`
-- registra a decisão de não revogar DML em massa — o modelo do Supabase é grant amplo + RLS).
REVOKE TRUNCATE ON public.farmer_algorithm_config FROM authenticated, anon;

COMMENT ON TABLE public.farmer_algorithm_config IS
  'Parametros do algoritmo do farmer (key/value numerico). Os pesos (hs_weight_*, ps_weight_*, '
  'health_w_*, priority_w_*) sao escrita livre de staff. As keys margem_faixa_* sao EXCECAO: '
  'a escrita delas exige private.cap_custo_ler, porque mover o limiar e chamar '
  'get_carteira_margem_faixa reconstroi a margem por busca binaria (oraculo de custo).';

COMMIT;
