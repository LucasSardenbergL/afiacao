# Recebimento closed-loop honesto (Oben) — Design

> Data: 2026-06-04 · Frente do programa autônomo (pós Picking #567). Metodologia validada em 3 rodadas de Codex (gpt-5.5, xhigh): honestidade pura → veredito → **Fase A (completar a coreografia)**. O founder ampliou o escopo: não basta "parar de mentir" — a efetivação precisa **levar a NF até "Concluído" no Omie e movimentar o estoque**.

## 1. Problema

A efetivação da conferência mobile (edge `omie-nfe-recebimento`) **mente sobre conclusão E está funcionalmente incompleta**:

- `nfe_recebimentos.status='efetivado'` é **incondicional** (`index.ts:390-394`) mesmo se `AlterarRecebimento` falha (linha 309 só loga *"Continue anyway"*) ou o ajuste Sayerlack falha (345 só loga). O edge devolve **HTTP 200 + `success:true`** → front sempre dá toast de sucesso.
- **Não envia a quantidade recebida** ao Omie — o payload é `det:[{nItem,nCodProd,lote_validade}]`, **sem `nQtdeRecebida`**. Não confronta/atualiza a quantidade no Omie.
- **Não conclui** — não chama `AlterarEtapaRecebimento` nem `ConcluirRecebimento` → a NF **não vai pra "Recebido"/"Concluído"** sozinha.
- **Furo central (Codex):** classifica sucesso por `res.ok` (HTTP). Mas o Omie retorna **HTTP 200 com `faultstring`** em erro de negócio (padrão do repo: `omie-sync:127`, `process-nfe:115` fazem `if (data.faultstring) throw`). **Sucesso HTTP ≠ sucesso Omie.**

**Mapa comprovado — `process-nfe`** (aba "Manual", vivo via `/nfe-receipt` + aba do admin, fail-closed correto): faz a coreografia que funciona — `ListarRecebimentos → ConsultarRecebimento → AlterarRecebimento`(com `nQtdeRecebida`+departamento) `→ AlterarEtapaRecebimento`(`cEtapa:"40"`) `→ ConcluirRecebimento`. Não envia lote/validade nem trata CT-e/data de registro. **Nenhum dos 2 edges é completo.**

## 2. Escopo — Fase A (completar a coreografia COM honestidade)

A efetivação da conferência mobile passa a fazer o **fluxo completo** do Omie:
1. **Data de registro** = dia do recebimento no app.
2. **Atualizar a quantidade recebida** de cada item no Omie.
3. **Lote/validade** (já capturado via OCR).
4. Mover kanban **"Recebido" → "Concluído"**.
5. **CT-e** atrelado: concluir e mover pra "Concluído".
6. **Honestidade:** critério de sucesso real (`faultstring`), fail-closed, ledger por passo, status de falha, toasts honestos, KPIs por `efetivado_at`.

**Fase B (cortada, sub-frente futura):** itens NOVOS — criar produto no Omie + associar de-para ao item da nota (senão o estoque não movimenta). Mais complexo (criação de cadastro), validado à parte.

## 3. RESTRIÇÃO CRÍTICA → entrega em 2 sub-fases

**Eu não tenho acesso ao Omie** (nem teste nem prod). Não posso validar payloads, nem o nome do campo "data de registro", nem o shape de lote no `AlterarRecebimento`, nem o que é "2353". A única validação é o founder no Omie real. **Codex: nunca pôr campo "provável" em payload de estoque real.** Daí o de-risk **diagnóstico-first** e a entrega faseada:

### Sub-fase A0 — Fundação + Diagnóstico (PR1, 100% aditivo, ZERO risco de estoque)
- **Migration do ledger** (idempotente): flags por passo + tabela append-only de tentativas + status novos.
- **Helper puro TDD** (`classificarRespostaOmie`, `decidirStatusEfetivacao`, `selecionarPassosPendentes`) — espelhado no edge.
- **Modo diagnóstico read-only** no edge: `{diagnostico:true, nfe_recebimento_id}` → chama só `ConsultarRecebimento(nIdReceb)` (+ `ListarRecebimentos` se faltar `nIdReceb`) e retorna o **JSON cru** (etapa atual, itens, datas, lote, CT-e). **Não escreve nada.**
- **Frontend:** botão "Diagnosticar" (staff) que mostra/baixa o JSON; status/KPIs honestos preparados.
- **O fluxo de efetivação atual fica INTACTO** (não regride). PR1 destrava o founder pra me colar o JSON real.

### Sub-fase A1 — Coreografia completa (PR2, validado pelo founder)
- O edge ativo absorve a coreografia comprovada do `process-nfe` + lote/validade + data/CT-e **com os campos confirmados pelo diagnóstico**.
- Fail-closed por passo + ledger + **lock atômico** + retry que retoma só o passo pendente.
- Founder testa **1 NF de baixo valor** → ajusto.
- **Guard:** se um campo obrigatório da Fase A não estiver com mapeamento confirmado, o edge retorna erro operacional (`falha_efetivacao` + motivo "campo X não mapeado") — **não efetiva às cegas** (default desligado, fail-closed; Codex Q4).

## 4. Modelo de estado e ledger (por passo)

`nfe_recebimentos.status` é `varchar(20)` → cabem `falha_efetivacao`(16), `efetivacao_parcial`(18). Reuso o `status` (já tem `efetivado`).

**`nfe_recebimentos`** — flags de idempotência por passo + estado de tela:
- `alterar_recebimento_ok boolean DEFAULT false`, `alterar_etapa_ok boolean DEFAULT false`, `concluir_recebimento_ok boolean DEFAULT false`, `cte_ok boolean DEFAULT false`
- `efetivacao_erro text`, `efetivacao_tentativas integer DEFAULT 0`, `efetivacao_lock_at timestamptz` (claim atômico)
- (`efetivado_at` já existe — só seta quando vira `efetivado`.)

**`nfe_recebimento_itens`** — idempotência do `IncluirAjusteEstoque` (NÃO-idempotente):
- `ajuste_estoque_ok boolean DEFAULT false`, `ajuste_estoque_omie_id text`, `ajuste_estoque_at timestamptz`

**`nfe_efetivacao_tentativas`** (append-only, auditoria por operação):
- `id uuid pk`, `nfe_recebimento_id uuid` (FK), `tentativa int`, `operacao text` (`diagnostico`/`alterar_recebimento`/`alterar_etapa`/`concluir_recebimento`/`ajuste_estoque`/`importar_cte`), `item_id uuid null`, `sucesso boolean`, `erro text`, `omie_status text`, `created_at timestamptz`. RLS: SELECT staff; escrita só `service_role`. Index por `nfe_recebimento_id`.

**Lock atômico (Codex Q5):** claim via `UPDATE nfe_recebimentos SET efetivacao_lock_at=now() WHERE id=$1 AND (efetivacao_lock_at IS NULL OR efetivacao_lock_at < now()-interval '2 min') RETURNING id`. Se 0 linhas → outro request está processando → 409. Libera no fim (lock_at=null). Padrão do claim do Sayerlack.

## 5. Helper puro (oráculo TDD) — `src/lib/recebimento/efetivacao-helpers.ts`

Espelhado **verbatim** no edge Deno. Funções puras (vitest):

1. **`classificarRespostaOmie(r: { httpOk: boolean; status?: number; body: unknown }): { sucesso: boolean; erro: string | null; omieStatus: string | null }`** — `!httpOk` → falha; `body.faultstring` (string ≠ vazio) → falha; `codigo_status`/`cCodStatus` ≠ `"0"`/`0` → falha; senão sucesso. Robusto a body null/array/string/number.
2. **`erroBenigno(faultstring, operacao): boolean`** — reconhece mensagens explícitas ("já concluíd", "já está na etapa", "já efetivad") por operação → trata como sucesso benigno (Codex Q2/Q3). **Allowlist conservadora** (só strings conhecidas; desconhecido = falha real).
3. **`decidirStatusEfetivacao(flags: { alterarOk; etapaOk; concluirOk; cteOk; ajustesTentados; ajustesOk }): 'efetivado' | 'falha_efetivacao' | 'efetivacao_parcial'`** — `efetivado` só com todos os passos OBRIGATÓRIOS ok (alterar+etapa+concluir + ajustes todos ok; CT-e e Sayerlack conforme aplicável); nenhum efeito crítico → `falha_efetivacao`; algum efeito ok + outro pendente → `efetivacao_parcial`.
4. **`selecionarPassosPendentes(flags): string[]`** — lista de passos a executar no retry (pula os `ok`). Ajustes: itens com `quantidade_convertida>0 && !ajuste_estoque_ok`.
5. **`podeReprocessar(status): boolean`** — `falha_efetivacao`/`efetivacao_parcial`.
6. **`resumirErros(falhas): string`** — concatena, trunca ~500 chars.

## 6. Edge `omie-nfe-recebimento` (A0: diagnóstico · A1: coreografia)

- **A0 — `{diagnostico:true, nfe_recebimento_id}`:** valida staff + lê `nfe`+`omie_id_receb`; chama `ConsultarRecebimento({nIdReceb})` (read-only); registra tentativa `operacao='diagnostico'`; retorna `{ok:true, diagnostico: <JSON cru>}`. Sem escrita.
- **A1 — efetivação:** claim atômico (lock). Incrementa tentativas. Ordem fail-closed, cada passo só se `!flag_ok`, `classificarRespostaOmie` + `erroBenigno`, registra tentativa, persiste flag ao suceder **antes do próximo passo** (Codex furo #3):
  1. `AlterarRecebimento` (qtd + lote/data confirmados) → `alterar_recebimento_ok`.
  2. ajustes Sayerlack pendentes → `ajuste_estoque_ok` por item.
  3. `AlterarEtapaRecebimento` (cEtapa 40) → `alterar_etapa_ok` (tolera benigno "já na etapa").
  4. `ConcluirRecebimento` → `concluir_recebimento_ok` (tolera benigno "já concluído").
  5. CT-e → `cte_ok`.
  - Qualquer passo obrigatório falha → para, `decidirStatusEfetivacao`, persiste status+erro, libera lock, retorna `{success:false,status,erro}`.
  - Todos ok → `status='efetivado'` + `efetivado_at`, libera lock, `{success:true}`.
  - **Guard de campo não-mapeado:** se `data_registro`/lote/`2353` exigidos e não confirmados → não chama escrita, retorna `falha_efetivacao` + motivo.

## 7. Frontend honesto

- **`Recebimento.tsx`:** `NfeStatus` + `STATUS_CONFIG` ganham `falha_efetivacao` (error) / `efetivacao_parcial` (warning). `handleEfetivar` inspeciona `res.data.status` (toast de sucesso só se `efetivado`; senão error/warning com `res.data.erro`). Botão **"Reprocessar"** (falha/parcial) + **"Diagnosticar"** (staff, qualquer status). Abas incluem os novos status.
- **`RecebimentoConferencia.tsx`:** `handleFinalize` inspeciona o resultado real (sem declarar efetivado em falha).
- **KPIs `AdminEstoqueRecebimento.tsx`:** "Efetivadas Hoje" → `efetivado_at >= início do dia`; novo contador **"Falhas de efetivação"** (`status in (falha_efetivacao, efetivacao_parcial)`).
- **`useEstoqueZone.ts`:** "Recebidos hoje" (conta `conferido`) → label **"Conferidas hoje"**; `priority`/topItem quando há NF em `falha_efetivacao`.

## 8. Testes (helper puro, vitest)

- `classificarRespostaOmie`: 200 sem fault → sucesso; `faultstring` → falha; HTTP 500 → falha; `codigo_status:"0"` → sucesso; `"101"` → falha; null/array/string robusto.
- `erroBenigno`: "já concluído"/"já está na etapa" conhecidos → benigno; string desconhecida → falha real.
- `decidirStatusEfetivacao`: matriz de flags (todos ok → efetivado; alterar ok + concluir falha → parcial; nada → falha).
- `selecionarPassosPendentes`: pula `ok`; ajustes só itens com conversão pendente.
- `podeReprocessar`, `resumirErros`.

## 9. Validação + loop com o founder

- Helper puro: vitest. Edge: `deno check` (erro-set inalterado). CI `validate`.
- **Sem teste local contra o Omie.** PR1 (diagnóstico/infra) entregue com confiança. Entre PR1 e PR2: founder **roda o diagnóstico numa NF real** + responde as factuais → eu confirmo os campos. PR2: founder testa **1 NF de baixo valor** → ajusto. Ledger + lock garantem que re-testar **não duplica** estoque/conclusão.

## 10. Perguntas factuais ao founder (entre PR1 e PR2)
1. A aba "Manual" (`process-nfe`) leva a NF até "Concluído" e movimenta estoque hoje? (valida o mapa)
2. "2353" — que campo/valor é e onde vai?
3. Data de registro — automática na conclusão (= hoje) ou manual? + o JSON do diagnóstico (campos reais).

## 11. Entregáveis / Lovable
- **PR1:** migration `20260604140000_recebimento_efetivacao_ledger.sql` (SQL Editor) + deploy do edge (diagnóstico) via Lovable + Publish.
- **PR2:** deploy do edge (coreografia) via Lovable + Publish + teste do founder.
- Registrar no CLAUDE.md + nota de migration manual no PR.

## 12. Riscos (Codex)
1. **Double-count de estoque por retry/paralelismo** → lock atômico + flags por passo (obrigatório).
2. **Payload errado em campo de estoque real** → data/lote/2353 nunca inferidos; diagnóstico-first + guard.
3. **Beco de parcial sem retomada** → flag persistida antes do próximo passo + `podeReprocessar` + (v2) consulta de estado antes do retry.
