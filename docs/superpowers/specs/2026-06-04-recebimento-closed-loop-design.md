# Recebimento closed-loop honesto (Oben) — Design

> Data: 2026-06-04 · Frente do programa autônomo (pós Picking #567). Metodologia validada em 2 rodadas de Codex (gpt-5.5, xhigh). Mesmo padrão de "ciclo que mente sobre conclusão" do picking.

## 1. Problema

O módulo de Recebimento de NF-e dá entrada de mercadoria comprada (importa NF-e do Omie → confere no celular → **efetiva**, que escreve no Omie pra dar entrada de estoque). A efetivação (edge `omie-nfe-recebimento`) **mente sobre conclusão**:

- **`nfe_recebimentos.status='efetivado'` é INCONDICIONAL** (`index.ts:390-394`) — marca efetivado mesmo se:
  - `AlterarRecebimento` (Passo A, a entrada no Omie) **falhou** → `index.ts:309` só `console.error` + *"Continue anyway"*.
  - `IncluirAjusteEstoque` (Passo B, ajuste de estoque do item convertido tipo Sayerlack) **falhou** → `index.ts:345` só `console.error`.
  → **entrada de estoque fantasma** (status diz efetivado, Omie não recebeu).
- O edge sempre devolve **HTTP 200 + `{success:true}`** → o front (`Recebimento.tsx:163`, `RecebimentoConferencia.tsx:389`) **sempre mostra toast de sucesso**.
- **`AlterarRecebimento` sozinho pode nem efetivar** — o edge irmão `process-nfe` (aba "Manual", fail-closed correto) mostra o fluxo completo do Omie: `AlterarRecebimento → AlterarEtapaRecebimento → ConcluirRecebimento`. O edge ativo **só faz `AlterarRecebimento`**.
- **KPI "Efetivadas Hoje"** (`AdminEstoqueRecebimento.tsx:92`) filtra por `data_emissao=today` (data de emissão da nota pelo fornecedor), não `efetivado_at`.
- **Furo #1 (Codex):** o edge classifica sucesso por `res.ok` (HTTP). Mas o Omie retorna **HTTP 200 com `faultstring`** em erro de negócio (padrão confirmado no repo: `omie-sync:127` faz `if (result.faultstring) throw`). **Sucesso HTTP ≠ sucesso Omie.**

## 2. Escopo — v1 = honestidade operacional, SEM mudar a coreografia Omie

A v1 **mantém exatamente as chamadas Omie que o edge já faz** (não adiciona `ConcluirRecebimento`). Só passa a **respeitar o resultado real** delas. Decisão eu+Codex: tornar honesto é baixo risco; completar o fluxo (Hipótese B) é money-path do Omie sem poder testar → v2, só com evidência de produção.

**Entregas v1:**
1. **Critério de sucesso real por operação** — parsear o corpo do Omie (`faultstring`/`codigo_status`), não só HTTP.
2. **Fail-closed:** se `AlterarRecebimento` falha → **não** roda ajustes/CT-e, marca `falha_efetivacao`, retorna erro honesto.
3. **Ledger de efeitos externos** (resolve o bloqueio metodológico) → retry sem duplicar estoque.
4. **2 status de falha:** `falha_efetivacao` (Passo A falhou, nada confirmado) · `efetivacao_parcial` (A ok, algum ajuste B falhou).
5. **Retry seguro** (botão "Reprocessar"): re-chama só o que **não** teve sucesso registrado (pula `AlterarRecebimento` se já ok, pula ajuste de item já ok).
6. **Toasts honestos** (sucesso só em sucesso real).
7. **KPIs honestos:** "Efetivadas Hoje" por `efetivado_at::date`; card de falhas; "Recebidos hoje" do cockpit renomeado pra não confundir conferência com entrada efetiva.

**NÃO-objetivos (v2, cortados pelo Codex):**
- Adicionar `AlterarEtapaRecebimento` + `ConcluirRecebimento` (completar a coreografia) — só após evidência de produção (Hipótese B).
- Reconciliação automática via `ConsultarRecebimento(nIdReceb)`.
- Retomada granular item-a-item com UX detalhada.
- Unificar/aposentar o `process-nfe` (caminho paralelo — fica intacto; registrado como divergência técnica).

## 3. A tensão A/B (decisão registrada)

Como o edge ativo só faz `AlterarRecebimento`, há 2 hipóteses sobre a produção hoje (founder confirma via logs/Omie):
- **Hipótese A:** `AlterarRecebimento` conclui/efetiva (ou o estoque entra OK) → o bug é só "não respeita falha" → a v1 resolve.
- **Hipótese B:** `AlterarRecebimento` NÃO conclui → o app marca efetivado mas o Omie nunca dá entrada (mesmo no caminho feliz) → a v1 deixa o app **honesto sobre o fluxo atual**, mas a completude vira v2.

A v1 é **segura por construção em ambas**: ela só marca `falha_efetivacao` quando há **erro inequívoco** (HTTP≥400 ou `faultstring`/`codigo_status≠0`). Se hoje o caminho feliz retorna 200 sem `faultstring`, a v1 **não muda** o caminho feliz — só captura as falhas reais. Não inventa falha.

**Perguntas factuais ao founder (gatilho de v2):**
1. Ao "efetivar" uma NF normal (sem Sayerlack) hoje, o estoque sobe no Omie? Recebimento fica "concluído" ou em etapa intermediária?
2. Nos logs do edge, o `operations[0]` (`AlterarRecebimento`) costuma vir `error:true` ou `false`?
3. Há NF marcada "efetivado" no app mas ainda aberta/sem estoque no Omie?

## 4. Modelo de estado e ledger

`nfe_recebimentos.status` é `character varying(20)` → os 2 nomes cabem (`falha_efetivacao`=16, `efetivacao_parcial`=18).

**Reuso o `status` existente** pro estado de efetivação (`efetivado` já é um status hoje; adiciono `falha_efetivacao`/`efetivacao_parcial`). Ledger em colunas + tabela append-only:

**`nfe_recebimentos`** (estado de tela + idempotência do Passo A):
- `efetivacao_erro text` — resumo do último erro (pra tela).
- `efetivacao_tentativas integer DEFAULT 0` — contador.
- `alterar_recebimento_ok boolean DEFAULT false` — idempotência do `AlterarRecebimento` (não re-chamar se já passou).
- `omie_alterar_at timestamptz` — quando o Passo A teve sucesso.
- (`efetivado_at` já existe — só seta quando vira `efetivado`.)

**`nfe_recebimento_itens`** (idempotência do `IncluirAjusteEstoque`, que é NÃO-idempotente):
- `ajuste_estoque_ok boolean DEFAULT false` — item já ajustado (retry pula).
- `ajuste_estoque_omie_id text` — id do lançamento de ajuste no Omie.
- `ajuste_estoque_at timestamptz`.

**`nfe_efetivacao_tentativas`** (append-only, auditoria por operação — o "ledger de efeitos externos"):
- `id uuid pk`, `nfe_recebimento_id uuid` (FK), `tentativa int`, `operacao text` (`alterar_recebimento`/`ajuste_estoque`/`importar_cte`), `item_id uuid null`, `sucesso boolean`, `erro text`, `omie_status text`, `created_at timestamptz`.
- RLS: SELECT staff (employee/master); escrita só `service_role` (o edge usa service_role → bypassa RLS). Index por `nfe_recebimento_id`.

## 5. Helper puro (oráculo TDD) — `src/lib/recebimento/efetivacao-helpers.ts`

Espelhado **verbatim** no edge Deno (Edge não importa de `src/`). Funções puras, testadas com vitest:

1. **`classificarRespostaOmie(r: { httpOk: boolean; status?: number; body: unknown }): { sucesso: boolean; erro: string | null; omieStatus: string | null }`**
   - `!httpOk` → falha (`erro = "HTTP {status}"` + faultstring se houver).
   - `body.faultstring` (string não-vazia) → falha (`erro = faultstring`).
   - `body.codigo_status`/`cCodStatus` presente e ≠ `"0"`/`0` → falha (`erro = descricao_status`/`cDescStatus`).
   - senão → sucesso. Robusto a `body` null/array/string/number.

2. **`decidirStatusEfetivacao(p: { alterarOk: boolean; ajustesTentados: number; ajustesOk: number }): { status: 'efetivado' | 'falha_efetivacao' | 'efetivacao_parcial'; }`**
   - `!alterarOk` → `falha_efetivacao`.
   - `alterarOk && ajustesTentados === ajustesOk` (inclui 0 ajustes) → `efetivado`.
   - `alterarOk && ajustesOk < ajustesTentados` → `efetivacao_parcial`.
   - CT-e falho **não** degrada o status (frete é fiscal, não estoque; tem `cte_associados.status` próprio); só registra no ledger.

3. **`selecionarAjustesPendentes(itens: { id: string; quantidade_convertida: number | null; produto_omie_id: number | null; ajuste_estoque_ok: boolean }[]): string[]`** — ids dos itens com `quantidade_convertida>0 && produto_omie_id && !ajuste_estoque_ok` (idempotência: pula já-feitos).

4. **`podeReprocessar(status: string): boolean`** — `true` só pra `falha_efetivacao`/`efetivacao_parcial`.

5. **`resumirErros(falhas: { operacao: string; erro: string }[]): string`** — concatena, trunca pra caber em `efetivacao_erro` (limite ~500 chars).

## 6. Edge `omie-nfe-recebimento` reescrito (fail-closed)

Após fetch (nfe/itens/lotes/conversões), incrementa `efetivacao_tentativas`. Espelha o helper verbatim.

1. **Passo A — `AlterarRecebimento`** (só se `!alterar_recebimento_ok`): chama, `classificarRespostaOmie`. Registra tentativa.
   - **Falha** → persiste `status='falha_efetivacao'` + `efetivacao_erro` + tentativas; retorna `{success:false, status, erro}` (HTTP 200). **Aborta B e C** (nada mais roda — sem entrada parcial).
   - **Sucesso** → `alterar_recebimento_ok=true`, `omie_alterar_at=now`.
2. **Passo B — ajustes** (`selecionarAjustesPendentes`): pra cada item, `IncluirAjusteEstoque`, classifica, registra tentativa. Sucesso → marca item `ajuste_estoque_ok=true` + `omie_id` + `at`. Falha → acumula erro (não aborta os outros — tenta todos).
3. **Passo C — CT-e**: como hoje (por-item, marca `cte_associados.status='efetivado'` só em sucesso). Registra tentativa. Falha não degrada o status da NF.
4. **Status final** — `decidirStatusEfetivacao`. `efetivado` → `status='efetivado'` + `efetivado_at=now` + `efetivacao_erro=null`. `efetivacao_parcial` → `status` + `efetivacao_erro`. Persiste.
5. Retorna `{success: status==='efetivado', status, erro, ctes_processed, operations}`.

**Idempotência do retry:** tentativa 2 pula `AlterarRecebimento` (já ok) e os ajustes de itens já-ok → re-faz só o que faltou → vira `efetivado` sem duplicar estoque.

**Postura conservadora (Codex Q3):** `IncluirAjusteEstoque` e `AlterarRecebimento` tratados como NÃO-idempotentes (só re-chamam se nenhum sucesso registrado). Se o founder confirmar que `AlterarRecebimento` é overwrite-seguro, relaxa depois.

## 7. Frontend honesto

- **`Recebimento.tsx`:** tipo `NfeStatus` + `STATUS_CONFIG` ganham `falha_efetivacao` (status-error) e `efetivacao_parcial` (status-warning). `handleEfetivar` inspeciona `res.data.status`: toast de sucesso **só** se `efetivado`; senão `toast.error`/`toast.warning` com `res.data.erro`. Botão "Reprocessar" nos cards `falha_efetivacao`/`efetivacao_parcial` (re-invoca o edge). Filtros das abas incluem os novos status no histórico/pendências.
- **`RecebimentoConferencia.tsx`:** `handleFinalize` inspeciona o resultado real (igual). Em falha: toast honesto + **não** declara efetivado (a NF aparece como falha na lista pra reprocessar).
- **KPIs `AdminEstoqueRecebimento.tsx`:** "Efetivadas Hoje" → `efetivado_at >= início do dia` (gte/lt, não `data_emissao`). Novo card/contagem **"Falhas de efetivação"** (`status in (falha_efetivacao, efetivacao_parcial)`).
- **`useEstoqueZone.ts` (cockpit):** "Recebidos hoje" (conta `conferido`) → renomear label **"Conferidas hoje"** (a métrica é trabalho do conferente, não entrada efetiva). Adicionar `priority`/topItem quando houver NF em `falha_efetivacao` (alerta o gestor: entrada de estoque travada).

## 8. process-nfe (divergência técnica registrada)

`process-nfe` está **vivo** (rota `/nfe-receipt` + aba "Manual" do admin via `NfeReceipt`) e é fail-closed correto (cada passo dá `return` no erro; faz o fluxo completo). **Intacto na v1** — não é o caminho do bug. Risco de longo prazo: 2 fluxos de efetivação com contratos diferentes. Consolidar/aposentar = decisão pós-v1 (não misturar com a correção de honestidade).

## 9. Testes (helper puro, vitest)

- `classificarRespostaOmie`: 200 sem fault → sucesso; `faultstring` → falha; HTTP 500 → falha; `codigo_status:"0"` → sucesso; `codigo_status:"101"` → falha; body null/array/string → robusto (sucesso só com sinal claro de ok; sem fabricar).
- `decidirStatusEfetivacao`: alterar falha → `falha_efetivacao`; alterar ok + 0 ajustes → `efetivado`; alterar ok + 2/2 ajustes → `efetivado`; alterar ok + 1/2 ajustes → `efetivacao_parcial`.
- `selecionarAjustesPendentes`: pula `ajuste_estoque_ok`; inclui `quantidade_convertida>0 && produto_omie_id`; ignora sem conversão.
- `podeReprocessar`: true pra falha/parcial; false pra efetivado/pendente/conferido.
- `resumirErros`: trunca/concatena.

## 10. Validação

- Helper puro: vitest (todos verdes).
- Edge: `deno check` (erro-set inalterado vs main, padrão do repo).
- CI `validate`: typecheck (strict) + test + lint + build.
- ⚠️ **Sem teste contra o Omie** (sem acesso). O fail-closed se baseia no sinal honesto que o Omie devolve. Founder monitora o 1º dia pós-deploy (se muitas NFs viram `falha_efetivacao` → Hipótese B se revelando → dispara a v2).

## 11. Entregáveis / operações Lovable

- **Migration** `20260604140000_recebimento_efetivacao_ledger.sql` (idempotente: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, RLS) → **colar no SQL Editor** (manual).
- **Deploy do edge** `omie-nfe-recebimento` **verbatim da main** via chat do Lovable (após merge).
- **Publish** do frontend.
- Registrar no CLAUDE.md (§6 ou §10) + nota de migration manual no PR.
