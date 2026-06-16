# Persistência das extrações de boletim (rascunhos) — design

> Data: 2026-06-13 · Autor: Claude + Codex (consult de desenho) · Status: aprovado p/ plano
> Frente: Base de Conhecimento (KB) → curadoria de boletins técnicos Sayerlack.

## 1. Contexto e dor

O founder está curando ~297 boletins técnicos (PDFs) na tela de aprovação (`/admin/knowledge-base`, aba "A aprovar"). O fluxo hoje:

1. A edge **`kb-extract-specs`** (Claude tool-use, `claude-sonnet-4-6`, `ANTHROPIC_API_KEY`) recebe `{documentId}`, baixa o PDF e **extrai ~40 campos técnicos** (rendimento, catalisador, demãos, validade, substrato…) + `extraction_confidence` + `extraction_gaps[]`. **Custa dinheiro por chamada.**
2. A edge **devolve `{ specs }` e NÃO persiste nada**.
3. O front (`useBatchExtract`) acumula os resultados **só na memória da aba** (estado efêmero do React). `ApprovalQueueSection` particiona: confiança ≥85% + código → auto-aprovar em lote; baixa confiança/sem código → revisar manual.
4. Aprovar → grava em `kb_product_specs` (a ficha curada, RLS master-only pela migration "0c").

**O problema (mordeu 2× nesta sessão):** o resultado vive **só na aba**. Com 297 boletins ninguém revisa tudo de uma vez. Fechar a aba (ou recarregar, ou aprovar um lote que limpava o estado) **perde** o que não foi aprovado → o founder **re-extrai** → **re-paga a Anthropic**. Inclusive o saldo já esgotou uma vez (297 erros "credit balance too low").

**Objetivo:** a IA extrai **1× por boletim**, o resultado **fica salvo no banco**, e o founder revisa os 297 em várias sessões — fecha a aba, volta amanhã, **tudo continua lá** — sem nunca re-extrair nem re-gastar saldo.

## 2. Decisões (validadas com Codex — consult de desenho)

| # | Decisão | Por quê |
|---|---------|---------|
| 1 | **Tabela separada `kb_extraction_drafts`** (PK = `document_id`), NÃO rascunho dentro de `kb_product_specs` | Cardinalidade e ciclo de vida diferentes (rascunho é por-DOCUMENTO e temporário; a ficha é por-PRODUTO e curada). E a extração pode vir **sem `product_code`** → não teria a identidade composta `(supplier, product_code_normalized)` exigida por `kb_product_specs`. |
| 2 | **A edge persiste o rascunho** (server-side), antes de responder 200 | Persistir no front deixa uma janela estrutural de perda **após cada chamada paga** (a rede do client pode falhar depois do pagamento). ⚠️ Não há atomicidade real entre Anthropic e Postgres — por isso o **claim prévio** (item 4) e **nunca** retry pago automático em estado ambíguo. |
| 3 | **`spec jsonb`** (1 coluna), não 40 colunas espelhadas | O rascunho é um **envelope temporário** do resultado do modelo; o front já lida com o objeto inteiro. A validação relacional forte pertence à ficha aprovada, não ao rascunho. |
| 4 | **Claim atômico ANTES da chamada paga** (`status='extracting'` + `claim_token`) | UPSERT sozinho resolve a corrida de **linha**, mas **não a de custo**: duas abas / duplo-clique / recarregar-no-meio ainda pagam 2× antes do upsert. Com 297 docs e o founder impaciente recarregando, isso é o cenário real. |
| 5 | **Cache-first** (rascunho `ready` + não-`force` → devolve o cache, **sem** chamar o Claude) | É o que mata a dor principal: reabrir a aba / re-disparar nunca re-paga o que já foi extraído. |
| 6 | **Gate da edge: master-only** (hoje é `authorizeCronOrStaff` = qualquer staff) | A curadoria é master-only (0c). Hoje **qualquer `employee` pode chamar a edge direto e gerar custo**. Fecha o furo de custo, alinhado com a curadoria. |
| 7 | **RLS da tabela: SELECT/DELETE master; INSERT/UPDATE só `service_role`** | Espelha a curadoria master-only. A venda **nunca** lê rascunho. O humano nunca escreve o rascunho (só a edge, via service_role). |
| 8 | **DELETE do rascunho após aprovar** (salva a ficha primeiro, depois apaga) | Se o DELETE falhar, sobra lixo inofensivo (o anti-join da ficha aprovada já tira o doc da fila). `aprovado_em` numa linha mutável não é auditoria real — quando o versionamento entrar, a RPC `aprovar_versao_boletim` insere a versão **+ apaga o rascunho na mesma transação**. |
| 9 | **Re-extração só explícita** (botão "Re-extrair" + `force:true` + confirmação de custo) | Nunca re-extrair automático. A re-extração forçada **mantém o rascunho anterior** até o novo persistir (se falhar, o anterior continua disponível). |

## 3. Modelo de dados — `kb_extraction_drafts`

```sql
create table public.kb_extraction_drafts (
  document_id   uuid primary key references public.kb_documents(id) on delete cascade,
  status        text not null default 'extracting'
                  check (status in ('extracting','ready','failed')),
  spec          jsonb,                 -- o resultado da extração (KbExtractedSpec); null enquanto extracting/failed
  claim_token   uuid,                  -- dono do claim corrente (anti corrida de custo)
  started_at    timestamptz,           -- quando o claim corrente começou (p/ detectar claim abandonado)
  extracted_at  timestamptz,           -- quando virou ready
  last_error    text,                  -- mensagem do último erro (status=failed)
  model         text,                  -- modelo usado (reconciliação de custo)
  usage         jsonb,                 -- usage da Anthropic (input/output tokens) — reconciliação de custo
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

- **`document_id` PK** → 1 rascunho por documento, sempre existe (não depende do código do produto).
- **`status`**: `extracting` (claim ativo, chamada em voo) → `ready` (spec persistido) ou `failed` (erro).
- **`spec jsonb`**: o `KbExtractedSpec` cru. O front lê e particiona/edita como hoje.
- **`claim_token`/`started_at`**: o claim atômico. `model`/`usage`: persistidos pra reconciliar custo depois (barato, já disponível na resposta).
- Trigger `updated_at` (padrão do projeto).

## 4. A edge `kb-extract-specs` (cache-first + claim + persist-before-response + gate master)

Fluxo novo (mantém o contrato de resposta `{ specs }` + um campo opcional `cached`):

```
0. Gate MASTER-ONLY (novo helper authorizeMaster; era authorizeCronOrStaff).
1. Parse { documentId, force? }. Valida doc existe + ready (como hoje).
2. CACHE-FIRST:
   SELECT * FROM kb_extraction_drafts WHERE document_id = $doc;
   se draft.status='ready' AND draft.spec IS NOT NULL AND NOT force:
     return 200 { specs: draft.spec, cached: true }   -- SEM Claude, custo zero
3. CLAIM atômico (anti corrida de custo):
   INSERT INTO kb_extraction_drafts (document_id, status, claim_token, started_at, updated_at)
   VALUES ($doc, 'extracting', $myToken, now(), now())
   ON CONFLICT (document_id) DO UPDATE
     SET status='extracting', claim_token=$myToken, started_at=now(),
         last_error=null, updated_at=now()
     WHERE kb_extraction_drafts.status <> 'extracting'
        OR kb_extraction_drafts.started_at < now() - interval '5 minutes'   -- claim stale = re-claimável
   RETURNING claim_token;
   se NÃO retornou (claim fresco de outra aba):
     return 409 { status: 'extracting' }   -- outro está pagando; o front mostra "em extração", não dispara
4. Chama o Claude 1× (extrai). SEM transação/lock aberto durante a chamada externa.
5. PERSIST-BEFORE-RESPONSE (compare-and-set — só se o claim ainda for meu):
   UPDATE kb_extraction_drafts
     SET status='ready', spec=$spec, extracted_at=now(), usage=$usage, model=$model,
         last_error=null, updated_at=now()
     WHERE document_id=$doc AND claim_token=$myToken;
   (se 0 linhas = outra aba re-claimou no meio: NÃO sobrescreve; eu já paguei, devolvo o spec ao front
    mesmo assim — caso raríssimo, sem re-trabalho.)
   em erro do Claude:
     UPDATE ... SET status='failed', last_error=$msg WHERE document_id=$doc AND claim_token=$myToken;
     return 502 { error }.
6. return 200 { specs: $spec }.
```

**Notas:**
- O write final é **compare-and-set por `claim_token`** → nunca pisa um claim mais novo.
- O claim é **statement curto** (insert/update, commit), **depois** a chamada externa, **depois** outro statement. Nada de transação longa segurando lock durante o Claude (frisado pelo Codex).
- `force:true` (botão "Re-extrair") pula o cache-first (passo 2) mas **passa pelo claim** (3) — re-extração forçada concorrente também é serializada; o rascunho anterior só é sobrescrito no passo 5 (se a nova extração suceder).

## 5. O front (hidratação + extrair-só-pendentes + re-extrair)

### 5.1 Hook novo `useExtractionDrafts(documentIds)`
- Query React Query: `kb_extraction_drafts` por `document_id IN (...)` (master).
- Retorna os rascunhos `ready` (com `spec`) e os `extracting`/`failed` (estado, sem spec).
- É o que **hidrata** a fila ao abrir a página.

### 5.2 `ApprovalQueueSection` — hidratação automática
- Hoje: `extract.resultados` (só memória) → particiona auto/revisar.
- Novo: ao montar, **mescla** os rascunhos `ready` do banco (`useExtractionDrafts`) com `extract.resultados` da sessão atual → particiona o conjunto **mesclado**. Assim o founder abre a aba e **os 100 já extraídos aparecem** (auto-aprovar + revisar) sem clicar nada.
- **"Extrair pendentes (N)"**: N = docs da fila **sem** rascunho `ready` e **sem** claim `extracting` fresco. Só dispara esses (não re-extrai o que já está salvo).
- Doc com claim `extracting` fresco → mostra "extraindo…" (não dispara).
- Cada item (auto ou revisar): botão **"Re-extrair"** → `extract.run([id], { force:true })` com **confirmação de custo** ("isso vai gastar saldo de novo").

### 5.3 `useBatchExtract` / `useExtractSpecs`
- A edge agora pode responder `cached:true` (cache hit) ou `409 {status:'extracting'}`. O front:
  - `cached:true` → trata como sucesso normal (já vem com `specs`).
  - `409` → não conta como erro; marca o doc como "em extração" (pula).
- A normalização (`normalizeExtractedSpec`) na fronteira **continua** (já mergeada no #791).

### 5.4 Aprovação → DELETE do rascunho
- O `useBulkApproveSpecs` / `KbSpecsForm.onSaved` (que grava em `kb_product_specs`): **depois** do save bem-sucedido, **DELETE** o rascunho daquele `document_id`. Se o DELETE falhar, ignora (lixo inofensivo; a fila já tira o doc por anti-join da ficha aprovada).

## 6. RLS + segurança

```sql
alter table public.kb_extraction_drafts enable row level security;

-- SELECT: só master (curadoria master-only). Predicado canônico do projeto (= o da 0c).
create policy kb_extraction_drafts_select_master on public.kb_extraction_drafts
  for select to authenticated
  using (public.has_role(auth.uid(), 'master'::app_role));

-- DELETE: só master (apaga ao aprovar, pelo front).
create policy kb_extraction_drafts_delete_master on public.kb_extraction_drafts
  for delete to authenticated
  using (public.has_role(auth.uid(), 'master'::app_role));

-- INSERT/UPDATE: nenhuma policy de usuário → só service_role (a edge) escreve.
revoke all on public.kb_extraction_drafts from anon;
```

- A venda e o staff comum: **nenhum acesso** (a venda lê a view de ficha aprovada, nunca o rascunho).
- A edge escreve via `service_role` (bypassa RLS).
- **Edge gate master-only** — novo helper `authorizeMaster` em `_shared/auth.ts` (espelha o `authorizeCronOrStaff`, mas `allowed = {master}` em vez de `{employee, master}`; mantém o branch `service_role`). Fecha o custo por API direto.

## 7. Ciclo de vida do rascunho

```
(sem linha) --extrair--> extracting --Claude ok--> ready --aprovar--> [DELETE]
                              |                       ^
                              |--Claude erro--> failed |
                              |                        |
                          (claim stale >5min, re-extrair, force) --> extracting (re-claim)
```

- `ready` é o estado de repouso útil (cache).
- `failed` → o founder vê o erro e pode "Re-extrair".
- Aprovar → DELETE (o estado "qual rascunho gerou a ficha" não é guardado na v1; o versionamento futuro guarda o `source_document_id` na versão imutável).

## 8. Interação com a 0c e o versionamento

- **0c (RLS master-only de `kb_product_specs`):** intacta. O rascunho **não** toca `kb_product_specs` — só na aprovação, pelo fluxo de save existente (que já respeita a 0c). O gate master-only da edge **reforça** a curadoria master-only.
- **Versionamento (frente seguinte):** compõe limpo. Hoje: `aprovar → grava ficha → DELETE rascunho`. Amanhã: a RPC `aprovar_versao_boletim(payload, document_id, change_type, …)` faz `inserir versão imutável → atualizar ponteiro → DELETE rascunho` **na mesma transação**. O rascunho é a fonte do `payload` da aprovação — não atrapalha, alimenta.

## 9. Escopo v1 + adiado

**v1 (mata a dor — nunca re-pagar):**
- Tabela `kb_extraction_drafts` (status + claim + spec jsonb + model/usage).
- RLS master-only (SELECT/DELETE master; INSERT/UPDATE service_role).
- Edge: gate **master-only** + **cache-first** + **claim atômico** + **persist-before-response** + `force`.
- Front: hidrata a fila dos rascunhos `ready` ao abrir; "Extrair pendentes" só os sem rascunho/sem claim fresco; "Re-extrair" explícito (force + confirmação); DELETE do rascunho ao aprovar.
- Persistir `model`/`usage` (reconciliação de custo — barato, já disponível).

**Adiado (YAGNI):**
- Histórico append-only de **tentativas** de extração (1 rascunho por doc na v1; re-extrair sobrescreve).
- Diff entre extração original × edição humana.
- Versionamento imutável das fichas (frente própria — este spec só **compõe** com ele).
- Dashboard/métricas de custo (persisto `usage`, mas não construo a tela).
- Retry **automático** de claims abandonados (o claim stale >5min é re-claimável pelo próprio fluxo de "Re-extrair"; sem cron).
- Generalizar a curadoria pra staff não-master.

## 10. Validação

- **PG17 local** (`db/test-kb-extraction-drafts.sh`, base `verify-snapshot-replay.sh`): claim atômico (2 claims concorrentes → só 1 ganha), claim stale re-claimável, cache-first não re-extrai, compare-and-set não pisa claim novo, RLS (master lê/apaga; employee/anon barrados; INSERT direto barrado), DELETE ao aprovar. **Falsificação:** sabotar o gate master e exigir vermelho.
- **Codex adversarial** no SQL da migration + no diff da edge (money-adjacent: corrida de custo).
- **CI:** typecheck strict + vitest (helpers do front) + lint.
- **Smoke do founder:** extrair alguns boletins → fechar a aba → reabrir → os rascunhos aparecem (auto/revisar) **sem re-extrair** (confirmar custo zero na 2ª abertura).

## 11. Entregas manuais (founder)

- **Migration** `kb_extraction_drafts` → SQL Editor do Lovable (manual).
- **Edge `kb-extract-specs`** → deploy via chat do Lovable (verbatim da main) — é o que liga cache-first + claim + gate master.
- **Publish** do front (a hidratação + os botões).
- ⚠️ O **#793 já mergeou** mas ainda precisa de **Publish** (o fix do reset que perdia as fichas a revisar).
