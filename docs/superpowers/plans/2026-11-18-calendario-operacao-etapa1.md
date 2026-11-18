# Calendário de operação — Etapa 1 (dezembro) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Em produção até ~01/12/2026: calendário de operação editável (empresa e fornecedor) com a carga 2025–2030, data de recebimento que respeita dias fechados, prova de que o recesso não causa recompra, e tela com pendências.

**Architecture:** Duas tabelas novas + 3 funções SQL são a **fonte única** das regras de data (a edge e a tela chamam as mesmas RPCs; nada de 6º espelho de "dia útil" em TS). A edge `disparar-pedidos-aprovados` mantém o `dDtPrevisao` do Omie (promessa do fornecedor) e grava ao lado a `data_recebimento_prevista`. O motor **não muda** nesta etapa — só se o teste da Task 4 reprovar.

**Tech Stack:** Postgres 17 (Supabase/Lovable Cloud), Deno edge, React 18 + TS strict + react-query + shadcn, vitest, testes SQL `db/test-*.sh`.

**Spec:** `docs/superpowers/specs/2026-11-18-calendario-operacao-design.md` (§4, §4.1, §4.2, §6.1–6.3, §7-E1). A Etapa 2 (demanda) tem plano próprio.

## Global Constraints

- Nunca editar migration existente; migration nova em `supabase/migrations/2026111xxxxxxx_calendario_operacao.sql`. Aplicação em prod: ENVELOPE (psql-rw, idempotente+transacional+postcondição) ou SQL Editor pelo founder — `docs/agent/database.md`, skill `lovable-db-operator`.
- Tabela nova **com RLS**. Função SECURITY DEFINER: `SET search_path = public`, gate na fronteira, `REVOKE ALL ... FROM PUBLIC, anon` (as duas pontas), conferir com `has_function_privilege`.
- Empresas: `'OBEN'`, `'COLACOR'`. Fornecedor identificado por `(empresa, fornecedor_nome)` como em `fornecedor_calendario_operacao`; comparar com `lower(btrim(...))`.
- Status do dia da empresa: `aberto | fechado | meia_equipe | pendente_dado`. Origem: `historico | escala | feriado | emenda | manual | deteccao`. Peso gravado 0..1, mas **nenhum cálculo desta etapa usa peso fracionário**; `meia_equipe` = aberto para recebimento.
- Regra base sem linha na tabela: seg–sex aberto, sáb/dom fechado (0 NFs em fim de semana em 13 meses).
- Fornecedor fechado = sáb/dom ∪ `calendario_feriados` com `tipo='nacional'` ∪ linhas de `calendario_operacao_fornecedor`. (Chamada do Claude: fornecedor fecha feriado nacional; feriado municipal de Divinópolis vale só para a empresa.)
- Datas pt-BR, código e rotas em pt-BR, toasts `sonner`, `track('reposicao.calendario_<acao>')`, `useUrlState`, `<EmptyState tone="operational">`, `<PageSkeleton>`.
- Arquivo novo em `src/` com dono em `src/lib/modulos/manifesto.ts` (módulo `reposicao`; testes novos listados em `testes`).
- SQL de verificação por psql-ro com `-v ON_ERROR_STOP=1` + `select 'fim','ok';`. Teste negativo captura SQLSTATE específica; falsificação com controle verde na mesma invocação; commitar antes de falsificar.
- Edge: gates `test:edges` (`--no-remote`), `edges:typecheck`, `edges:sintaxe`, `sonda:bump` e `sonda:fingerprint -- --write`.

## Review Focus

1. **Nome do fornecedor com caixa/espaço diferente** entre `pedido_compra_sugerido.fornecedor_nome` e o calendário → hoje aplicaria zero dias fechados em silêncio. Esperado: comparação normalizada; teste na Task 1 (`'  SAYERLACK '` casa `'Sayerlack'`).
2. **RPC de calendário falha na edge** (rede, permissão) → o disparo ao Omie não pode quebrar nem inventar data. Esperado: `dDtPrevisao` legado, `data_recebimento_prevista = NULL`, log de aviso. Teste na Task 3.
3. **Detecção "dia sem NF" acusando ontem/hoje** antes do sync de NF chegar. Esperado: só dias ≤ hoje−3; e nunca para COLACOR. Teste na Task 1.
4. **Recesso inteiro sem dia de recebimento**: chegada em 19/12 → próximo dia aberto é 04/01/2027 (pulando 18/12–03/01, fins de semana e feriados). Teste na Task 1 com as datas reais da carga.
5. **Emenda decidida como "não emendar"** precisa sair das pendências sem fechar o dia. Esperado: linha `status='aberto', origem='emenda'` no dia-ponte conta como decidida. Teste na Task 5.

---

### Task 1: Esquema, RLS e funções de data (migration + prova PG17)

**Files:**
- Create: `supabase/migrations/20261119100000_calendario_operacao.sql`
- Create: `db/test-calendario-operacao.sh`
- Modify: `package.json` (incluir o teste no agregador de testes SQL que o CI roda — seguir o padrão de `db/test-compra-suspensa-motor.sh`)

**Interfaces:**
- Produces:
  - `calendario_operacao_empresa(data date, empresa text, status text, peso numeric(3,2), motivo text, origem text, decidido_por uuid default auth.uid(), atualizado_em timestamptz default now(), PRIMARY KEY (data, empresa))`; checks: `empresa IN ('OBEN','COLACOR')`, status e origem nos domínios acima, `peso BETWEEN 0 AND 1`, `status='fechado' ⇒ peso=0`.
  - `calendario_operacao_fornecedor(data date, empresa text, fornecedor_nome text, motivo text, origem text, decidido_por uuid, atualizado_em timestamptz, PRIMARY KEY (data, empresa, fornecedor_nome))`.
  - `calendario_operacao_log(id bigserial, tabela text, operacao text, antes jsonb, depois jsonb, por uuid, em timestamptz)` alimentado por trigger AFTER INSERT/UPDATE/DELETE nas duas tabelas.
  - `pedido_compra_sugerido` + colunas `data_recebimento_prevista date NULL`, `recebimento_ajustado_calendario boolean NULL`.
  - `calendario_somar_dias_uteis_fornecedor(p_empresa text, p_fornecedor text, p_de date, p_n int) RETURNS date` — mesma semântica de `somarDiasUteis` (`p_n ≤ 0` devolve `p_de`), pulando dias fechados do fornecedor.
  - `calendario_proximo_dia_recebimento(p_empresa text, p_data date) RETURNS date` — 1º dia ≥ `p_data` aberto para a empresa (`aberto`/`meia_equipe`/sem linha em dia útil); teto de 60 dias de busca → `NULL` (nunca data inventada).
  - `calendario_dias_sem_nf(p_empresa text, p_de date, p_ate date) RETURNS SETOF date` — seg–sex, sem linha de calendário, zero NF em `v_venda_items_history_efetivo`, `≤ current_date - 3`; para empresa ≠ `'OBEN'` retorna vazio.
  - RLS: SELECT para staff (`has_role` employee/master/admin — usar o helper existente do repo); INSERT/UPDATE/DELETE só master/admin. Funções: EXECUTE para `authenticated` e `service_role`; revogadas de `PUBLIC` e `anon`.

- [ ] **Step 1: Escrever `db/test-calendario-operacao.sh`** no molde de `db/test-em-transito-erro-terminal.sh` (PG17 efêmero, `ON_ERROR_STOP`, marcador final). Asserções:
  - `calendario_proximo_dia_recebimento('OBEN','2026-12-19')` = `2027-01-04` com a carga do recesso (inserir no teste 18/12/2026–03/01/2027 `fechado`).
  - `calendario_proximo_dia_recebimento('OBEN','2026-12-07')` = `2026-12-09` com 07/12 (emenda) e 08/12 (municipal) fechados.
  - `calendario_somar_dias_uteis_fornecedor('OBEN','Fornecedor X','2026-12-17',3)` = `2027-01-06` com X fechado 21/12–03/01 e feriados 25/12 e 01/01 nacionais.
  - O mesmo para `'  SAYERLACK '` com Sayerlack fechada só 25/12 e 01/01: `('2026-12-23',2)` = `2026-12-28`.
  - `p_n = 0` num sábado devolve o próprio sábado.
  - `calendario_dias_sem_nf('OBEN', …)` devolve só o dia útil sem NF e sem linha; não devolve dia `pendente_dado`/`fechado`, nem fim de semana, nem `current_date-1`; `'COLACOR'` devolve vazio.
  - Negativos com SQLSTATE: `peso=1.5` → `23514`; `status='fechado', peso=0.5` → `23514`; `empresa='XPTO'` → `23514`.
  - RLS sob `SET ROLE authenticated` + GUC de claims: customer não lê (0 linhas); employee lê e não escreve (`42501`); master escreve; trigger gravou 1 linha em `calendario_operacao_log`.
  - `has_function_privilege('anon', 'calendario_proximo_dia_recebimento(text,date)', 'EXECUTE')` = false e idem `PUBLIC` (via role sem grants).
- [ ] **Step 2:** Rodar `bash db/test-calendario-operacao.sh` → falha (funções inexistentes).
- [ ] **Step 3:** Escrever a migration (idempotente: `IF NOT EXISTS`, `CREATE OR REPLACE`, `ADD COLUMN IF NOT EXISTS`).
- [ ] **Step 4:** Rodar o teste → `fim|ok` e `exit 0` colado.
- [ ] **Step 5:** Commit; depois **falsificar** uma camada por vez (tirar o `lower(btrim)`, tirar o `≤ current_date-3`, tirar o REVOKE de `anon`), exigindo vermelho em cada, com controle verde na mesma invocação; restaurar.
- [ ] **Step 6:** `bun run typecheck` (tipos Supabase: regenerar/atualizar `src/integrations/supabase/types.ts` para as tabelas/colunas/RPCs novas) e commit.

### Task 2: Carga inicial 2025–2030 (gerador + SQL idempotente)

**Files:**
- Create: `scripts/calendario-operacao/gerar-carga.ts` (gerador puro + CLI que escreve o SQL)
- Create: `scripts/calendario-operacao/__tests__/gerar-carga.test.ts`
- Create: `db/carga-calendario-operacao-2025-2030.sql` (saída gerada, commitada)

**Interfaces:**
- Consumes: tabelas da Task 1; `calendario_feriados(data, nome, tipo, observacoes)`.
- Produces: `gerarCarga(fornecedoresNaoSayerlack: string[]): { empresa: LinhaEmpresa[]; fornecedor: LinhaFornecedor[]; feriadosNacionais: LinhaFeriado[] }` e `pascoa(ano: number): string` (`YYYY-MM-DD`).

Conteúdo exato (spec §4, §4.1, §4.2), todas as linhas para `'OBEN'` **e** `'COLACOR'` (mesma operação física), exceto `pendente_dado` (só OBEN):
- `historico/fechado`: 22/12/2025–02/01/2026 (dias úteis); 16–18/02/2026; feriados nacionais de 2025-10-21 a 2026-11-18 exceto **20/11/2025 `aberto`**; pontes 21/11/2025, 20/04/2026, 05/06/2026; municipais 08/12/2025 e 01/06/2026.
- `historico/pendente_dado` (OBEN): 11, 15, 18, 19, 20, 22, 29/05/2026.
- `manual/fechado`: 20/11/2026; recesso 18/12/2026–03/01/2027.
- `feriado/fechado`: nacionais 2027–2030 (lista da spec; Carnaval seg/ter e Cinzas **não**); municipais Divinópolis 01/06 e 08/12 de 2026–2030 e Corpus Christi (já nacional na lista — não duplicar).
- `emenda/fechado`: 07/12/2026; 2027 28/05, 31/05, 06/09, 11/10, 01/11; 2028 16/06, 02/06, 08/09, 13/10, 03/11; 2029 30/04, 01/06, 16/11, 19/11; 2030 21/06.
- `escala/fechado`: fins de ano 22/12/2027–04/01/2028, 19/12/2028–01/01/2029, 19/12/2029–01/01/2030, 19/12/2030–01/01/2031.
- `escala/meia_equipe` (peso 1): janelas de Carnaval e Semana Santa 2027–2030 da spec §4.
- Fornecedores: Sayerlack `fechado` 25/12 e 01/01 de 2026–2030; cada nome em `fornecedoresNaoSayerlack` `fechado` 21/12–03/01 de 2026/27 a 2030/31. A lista vem de `select distinct fornecedor_nome from fornecedor_habilitado_reposicao where empresa=…` (psql-ro) e é commitada no gerador.
- `calendario_feriados`: insere só os nacionais 2027–2030 (`tipo='nacional'`), `ON CONFLICT DO NOTHING`.

- [ ] **Step 1:** Teste vitest: `pascoa(2027)==='2027-03-28'`, `pascoa(2030)==='2030-04-21'`; a carga contém `('2027-01-04','OBEN')` ausente (dia de volta aberto), `('2026-12-18','OBEN','fechado','manual')`, `('2027-02-09','OBEN','meia_equipe')`, `('2026-11-20','OBEN','fechado')`, `('2025-11-20','OBEN','aberto','historico')`, nenhuma linha em sábado/domingo, nenhuma `pendente_dado` para COLACOR, e nenhuma data duplicada por empresa.
- [ ] **Step 2:** `bun run test scripts/calendario-operacao` → FAIL.
- [ ] **Step 3:** Implementar o gerador; o SQL usa `INSERT … ON CONFLICT (pk) DO NOTHING` (re-rodar não sobrescreve edição do founder) dentro de transação, com postcondição contando linhas por origem e `select 'fim','ok'`.
- [ ] **Step 4:** Antes de gerar: conferir os feriados municipais de Divinópolis (Lei 744/1967) no SAPL da Câmara; registrar a URL no cabeçalho do SQL. Se divergirem, parar e avisar o founder.
- [ ] **Step 5:** Testes PASS; gerar o SQL; rodá-lo no PG17 efêmero junto com a migration da Task 1 (`db/test-calendario-operacao.sh` ganha um caso que carrega o arquivo e confere a contagem); commit.

### Task 3: Edge — data de recebimento pelo calendário

**Files:**
- Modify: `supabase/functions/disparar-pedidos-aprovados/previsao.ts`
- Modify: `supabase/functions/disparar-pedidos-aprovados/previsao_test.ts`
- Modify: `supabase/functions/disparar-pedidos-aprovados/index.ts:1197-1325` (cálculo do LT/`dDtPrevisao`) e o `.update` que persiste o pedido após o disparo
- Modify: versão/fingerprint da sonda da edge (seguir `docs/historico/ci-testes-edge-deno.md`)

**Interfaces:**
- Consumes: RPCs `calendario_somar_dias_uteis_fornecedor`, `calendario_proximo_dia_recebimento` (Task 1).
- Produces: `previsaoComCalendario(e: { portalDataEntrega: unknown; ltDias: number; agora: Date; somarFornecedor: (de: string, n: number) => Promise<string | null>; proximoRecebimento: (d: string) => Promise<string | null> }): Promise<{ dDtPrevisao: string; dataRecebimentoPrevista: string | null; ajustado: boolean | null }>`.

Regras: ramo portal = data do portal + 2 dias úteis pelo calendário do fornecedor; ramo fallback = hoje SP + `ltDias` pelo calendário do fornecedor; qualquer RPC devolvendo `null`/lançando → `dDtPrevisao` legado (`dataPrevisaoOmie`), `dataRecebimentoPrevista=null`, `ajustado=null`. `dataRecebimentoPrevista = proximoRecebimento(promessa)`; `ajustado = recebimento ≠ promessa`.

- [ ] **Step 1:** Testes Deno (stubs das RPCs): promessa 23/12/2026 → recebimento `2027-01-04`, `ajustado=true`; promessa 10/12/2026 → igual, `ajustado=false`; RPC lança → legado + `null`s, sem throw; RPC devolve `null` → idem.
- [ ] **Step 2:** `bun run test:edges` → FAIL.
- [ ] **Step 3:** Implementar; no `index.ts`, chamar via `db.rpc(...)` checando `{ error }` (nunca ignorar), gravar `data_recebimento_prevista`/`recebimento_ajustado_calendario` no mesmo `.update` do pós-disparo.
- [ ] **Step 4:** `bun run test:edges && bun run edges:typecheck && bun run edges:sintaxe && bun run sonda:bump && bun run sonda:fingerprint -- --write` → todos `exit 0`.
- [ ] **Step 5:** Commit.

### Task 4: Prova — o recesso não causa recompra

**Files:**
- Create: `db/test-calendario-acaminho-recesso.sh`
- Create (só se o teste reprovar): `supabase/migrations/20261119110000_motor_acaminho_documental.sql`

- [ ] **Step 1:** psql-ro: medir se `sku_estoque_atual.estoque_pendente_entrada` mantém pedido de compra Omie **aberto e já vencido** (data de previsão < hoje). Query: SKUs com pedido `disparado` há > 15 dias, ainda não `concluido_recebido`, e o pendente correspondente > 0. Registrar o número no PR.
- [ ] **Step 2:** Teste PG17 executando `gerar_pedidos_sugeridos_ciclo` (fixture no molde de `db/test-em-transito-erro-terminal.sh`): pedido `disparado` em `2026-12-10` com nº Omie, estoque abaixo do PP, pendente Omie refletindo o pedido; rodar o ciclo em `2027-01-04` → **nenhuma** sugestão para o SKU. Caso 2: mesmo cenário **sem** o pendente Omie (sync falhou) → documentar o resultado (esperado hoje: recompra).
- [ ] **Step 3:** Se o caso 1 passar e a medição do Step 1 mostrar que o pendente Omie persiste: registrar a prova, nenhuma mudança no motor. Se reprovar: migration que acrescenta ao `em_transito` o ramo "pedido `disparado` com nº Omie, não `concluido_recebido`, sem cancelamento" sem o corte de 7 dias, com pré-voo `pg_get_functiondef` da PROD, e o teste passa; Codex obrigatório nessa mudança.
- [ ] **Step 4:** Commit.

### Task 4b: Sinal "antecipar antes do recesso" (informativo, spec §6.3.4)

**Files:**
- Create: `supabase/migrations/20261119120000_calendario_antecipar_recesso.sql`
- Modify: `db/test-calendario-operacao.sh` (caso novo)

**Interfaces:**
- Consumes: `calendario_somar_dias_uteis_fornecedor`, `calendario_proximo_dia_recebimento` (Task 1); `sku_parametros` (`demanda_media_diaria`, `lt_medio_dias_uteis`, `fornecedor_nome`); `sku_estoque_atual` (`estoque_fisico`, `estoque_pendente_entrada`).
- Produces: `calendario_itens_antecipar(p_empresa text, p_fim_recesso date) RETURNS TABLE(sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text, cobertura_dias numeric, dias_ate_chegada_pos_recesso int)` — SKUs cujo fornecedor tem dia fechado entre hoje e `p_fim_recesso`, com `(estoque_fisico + estoque_pendente_entrada) / demanda_media_diaria` (dias corridos) **<** dias corridos de hoje até `calendario_proximo_dia_recebimento(p_empresa, calendario_somar_dias_uteis_fornecedor(p_empresa, fornecedor, p_fim_recesso, ceil(lt_medio_dias_uteis)))`. `demanda_media_diaria` NULL ou 0 → SKU fora (nunca divisão fabricada). Só leitura; não altera o motor.

- [ ] **Step 1:** Caso no teste PG17: SKU com cobertura 20 dias e fornecedor fechado 21/12–03/01, LT 10 úteis, hoje fixado em 2026-12-01 → aparece; mesmo SKU com cobertura 80 → não aparece; demanda NULL → não aparece.
- [ ] **Step 2:** FAIL → implementar (SECURITY INVOKER, `REVOKE` de `PUBLIC`/`anon`; "hoje" injetável por parâmetro opcional `p_hoje date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date` para o teste) → PASS → commit.
- [ ] **Step 3:** A Task 5 exibe essa lista num cartão "Antecipar antes do recesso" na tela do calendário.

### Task 5: Tela "Calendário de operação" + alerta nos pedidos

**Files:**
- Create: `src/lib/reposicao/calendario/pendencias.ts` (puro)
- Create: `src/lib/reposicao/calendario/__tests__/pendencias.test.ts`
- Create: `src/hooks/useCalendarioOperacao.ts`
- Create: `src/pages/AdminReposicaoCalendario.tsx`
- Create: `src/pages/__tests__/AdminReposicaoCalendario.leitura-falhou.test.tsx`
- Modify: `src/App.tsx` (rota `admin/reposicao/calendario`, lazy), navegação da reposição, `src/lib/modulos/manifesto.ts` (hook + testes), `src/pages/AdminReposicaoPedidos.tsx` (coluna/badge "recebe em DD/MM" quando `recebimento_ajustado_calendario`)

**Interfaces:**
- Consumes: tabelas/RPCs da Task 1; `calendario_feriados`.
- Produces: `calcularPendencias(e: { hoje: string; feriados: { data: string; nome: string }[]; diasEmpresa: { data: string; status: string; origem: string }[]; diasSemNf: string[]; ultimoDiaCadastrado: string | null }): Pendencia[]` com `Pendencia = { tipo: 'emenda_sem_decisao' | 'dia_sem_nf' | 'calendario_curto'; data: string; urgente: boolean; texto: string }`.

Regras: feriado em terça/quinta cujo dia-ponte (seg antes / sex depois) **não tem linha** → `emenda_sem_decisao`, `urgente` se faltam ≤ 90 dias; todas aparecem (não só as urgentes). `dia_sem_nf` para cada data de `calendario_dias_sem_nf`. `calendario_curto` se `ultimoDiaCadastrado < hoje + 12 meses`.

- [ ] **Step 1:** Testes de `calcularPendencias`: feriado 08/12/2026 (terça) sem linha em 07/12 → pendência urgente em 2026-11-18; com linha `aberto/emenda` em 07/12 → nenhuma (Review Focus 5); feriado 2027-09-07 → pendência não urgente; último dia 2027-06-30 em 2026-11-18 → `calendario_curto`.
- [ ] **Step 2:** Teste de página: leitura falhou → mensagem de erro honesta (não grade vazia), no molde de `AdminReposicaoCadastros.leitura-falhou.test.tsx`.
- [ ] **Step 3:** FAIL → implementar: grade mensal por empresa (ano/mês/empresa em `useUrlState`), diálogo de edição (status, motivo; peso só exibido), lista de períodos por fornecedor com incluir/remover, painel de pendências com ação "fechado"/"dado faltante"/"aberto". Escrita só master/admin (esconder ações para os demais; RLS é a garantia).
- [ ] **Step 4:** `heavy bun run test` (arquivos novos) + `bun run typecheck` + `bun lint` → `exit 0`; conferir `manifesto.gate` local se houver script.
- [ ] **Step 5:** Commit.

### Task 6: Revisão, deploy e verificação em produção

- [ ] **Step 1:** Codex no PR via `scripts/codex-async.sh` em background (diff completo + spec); tratar achados.
- [ ] **Step 2:** PR (não-draft só quando pronto para auto-merge); Auto-fix ligado.
- [ ] **Step 3:** Pós-merge: aplicar a migration (ENVELOPE ou SQL Editor) e a carga `db/carga-calendario-operacao-2025-2030.sql`; postcondição por psql-ro (contagem por origem/empresa, `calendario_proximo_dia_recebimento('OBEN','2026-12-19')='2027-01-04'`, `has_function_privilege` anon=false).
- [ ] **Step 4:** Deploy da edge decidido por `bun run pendencias:deploy`; sonda de atestação.
- [ ] **Step 5:** Publish do front (founder) e verificação da tela em produção.
- [ ] **Step 6:** Registrar em `docs/historico/` (entrega + medição da Task 4).
