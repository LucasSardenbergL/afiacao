# KB 0c — caminho A: aprovação de spec MASTER-ONLY + endurecimento dos vínculos

> Spec de design. Data: 2026-06-13. Autor: Claude (Opus) + 2ª opinião do Codex (gpt-5.5, xhigh adversarial — money-path).
> Continuação da **Fundação KB** (PR #779, `docs/superpowers/specs/2026-06-11-kb-conhecimento-venda-fundacao-design.md`).
> Status: aguardando revisão do founder antes de `writing-plans`.

## 1. Contexto e problema (achados do adversarial retroativo do Codex sobre o PR #779)

A Fundação entregou a view **`v_omie_product_current_spec`** com uma **dupla-trava**: a venda/copilot só veem uma ficha técnica quando o **vínculo é `confirmed`** (gate master) **E** o **spec tem `approved_at IS NOT NULL`**. A intenção (V1-C): **só o founder cura a base** — é o que influencia a venda.

O Codex (adversarial retroativo, 13/06) **confirmou as carteiras limpas** (sem P1 de vazamento) mas achou que **a dupla-trava é FURÁVEL por employee** — um **P1 latente** que só morde quando a venda passar a consumir a view (fatia 0c-path-B em diante):

### P1 — a aprovação do spec não é enforçada a master

A RLS de `kb_product_specs` (`20260517180000_kb_specs_and_competitors.sql`) hoje permite:
- **INSERT:** qualquer `employee` ou `master` (`kb_product_specs_insert_staff`).
- **UPDATE:** `master` **OU `extracted_by = auth.uid()`** (`kb_product_specs_update_master`) — **de QUALQUER coluna**.

E os 3 callers gravam `approved_at` **client-side** (`useSaveProductSpecs`, `useBulkApproveSpecs`: `approved_at: new Date().toISOString()`).

**O ataque (money-path):** um vendedor (`employee`) extrai uma ficha (INSERT liberado → ele vira `extracted_by`). Depois que o **master confirma o vínculo** daquele spec a um SKU (a única trava que era do master), o vendedor — como `extracted_by` — pode **UPDATE os números** da ficha (`rendimento_m2_por_litro`, `catalisador_proporcao_pct`, `catalisador_codigo`, …) e re-setar `approved_at`. A view continua mostrando (`approved_at IS NOT NULL`), e a venda passa a exibir **números adulterados**. O master confirmou o *vínculo*, não um *snapshot congelado* dos números — os números vivem em `kb_product_specs` e seguem editáveis pelo `extracted_by`.

**Por que é latente, não exposto hoje:** nada renderiza a view ainda (a venda só a consome no 0c-path-B). Então **bloqueia o APPLY da migration do 0a + o 0c**, **não** o que já está em produção.

### P2 — `confirmar_vinculo_boletim` aceita vínculo-fantasma

A RPC (BLOCO E da `20260611140000`) **não valida** `(account, omie_codigo_produto)` contra `omie_products`. Aceita `account` vazio, em caixa errada (`'OBEN'` quando o dado é `'oben'`), ou SKU inexistente → grava um **vínculo-fantasma** que a view nunca casará (ou casará no account errado). E **falta uma RPC de desvinculação/reassign**: `rejeitar_sugestao` insere uma linha `'rejected'`, mas **não desfaz** um `'confirmed'` errado (o índice parcial `one_confirmed` trava o SKU pra sempre no spec errado até alguém apagar à mão).

## 2. Objetivo e não-objetivos

**Objetivo:** elevar a **aprovação de spec a master-only enforçado no banco** (pré-requisito do consumo na venda) e endurecer as RPCs de vínculo, **sem** quebrar o fluxo do founder nem o que está em produção.

**Não-objetivos (YAGNI / fatias futuras):**
- ❌ Ligar a view na venda (é o 0c-path-B + fatias 1–3).
- ❌ Versionamento temporal de spec / snapshot no pedido (V2-A da Fundação — segue adiado).
- ❌ Permitir employee "salvar rascunho pra master aprovar depois" (não há esse fluxo; V1-C diz master cura). Se um dia existir, vira RPC de submissão separada.
- ❌ Monitoramento no Sentinela de vínculos órfãos (V2-B).

**Princípio mestre (inalterado):** precisão > recall; o que a venda exibe é **curado pelo founder**. Ambiguidade ⇒ nenhuma ficha.

## 3. Escopo do caminho A

1. **P1 — aprovação master-only** (o furo). Núcleo não-negociável.
2. **P2-a** — `confirmar_vinculo_boletim` valida `(account, omie_codigo_produto)` contra `omie_products`.
3. **P2-b** — RPC `desvincular_boletim` (master) pra desfazer/reatribuir um `confirmed` errado.
4. **Bug** — identidade composta no upsert (o `onConflict:'product_code'` que sobrescreve).
5. **Guardrail** — `useKbProductSpecs` (singular) é admin-only; a venda lê **só** a view (doc-comment + garantir no 0c-path-B).

Tudo é **banco + pequenas mudanças de client**. Independe do founder aplicar nada — destrava o apply da migration do 0a.

## 4. Decisões de design (com recomendação — Codex adjudica as 2 não-óbvias)

### 4a. Enforcement do P1 — RLS master-only (núcleo) + RPC de aprovação? `[Codex decide]`

O furo fecha com **RLS master-only na escrita** de `kb_product_specs`:
- **UPDATE:** remover o ramo `extracted_by = auth.uid()` → **só `master`**.
- **INSERT:** apertar de staff → **só `master`** (a criação da ficha = ato de curadoria; não há employee que crie ficha legítima).
- **SELECT:** **inalterado** (staff lê — RendimentoCalculator/venda leem fichas aprovadas). `DELETE` já é master.

Isso sozinho mata o P1: não-master não escreve → não adultera número, não seta `approved_at`. O founder (master) segue operando a fila do 0b normalmente.

**Decisão aberta (Codex):** vale **também** uma RPC `SECURITY DEFINER` master-gated como **único caminho de escrita** (`aprovar_kb_spec(payload, document_id)`), que server-seta `approved_by/approved_at/extracted_by` e usa o `ON CONFLICT` da identidade composta — OU **RLS-master-only basta** + um fix de 1 linha no `onConflict` do client?
- **Pró-RPC:** caminho de escrita money-path único e auditável; server-set anti-spoof; o fix de `onConflict` vive no SQL (sem a sutileza do PostgREST com coluna trigger-derivada); defesa em profundidade.
- **Pró-RLS-só:** muito menos superfície; o único writer é o founder (master = autoridade, "spoof do próprio approved_by" não é ameaça); migra os 2 hooks com mudança mínima (só o `onConflict`).
- **Recomendação inicial (a confirmar com Codex):** RLS-master-only é o núcleo; a RPC é defensável mas talvez over-engineering com base vazia e único writer master. **Levar a decisão ao Codex.**

### 4b. Identidade composta / `onConflict` — dropar o `UNIQUE(product_code)` global? `[Codex decide]`

A Fundação adicionou `UNIQUE(supplier, product_code_normalized)` mas **manteve** o `product_code text NOT NULL UNIQUE` global ("segue por ora"). O bug do `onConflict:'product_code'` sobrescrever boletins de fornecedores diferentes com o mesmo código só fecha de vez se a identidade for a **composta**.
- Com base **vazia** e **único fornecedor** (`sayerlack` default), a composta ≈ `product_code` → dropar o global é **zero-risco de dado hoje**.
- Impacto de código: `useKbProductSpecs(productCode).maybeSingle()` (admin-only) poderia estourar se `product_code` deixar de ser único — mitigável com `order().limit(1)`.
- **Recomendação inicial:** dropar o global `UNIQUE(product_code)` agora (a migração já o marcou transitório) + tornar a composta a identidade do upsert + endurecer o read singular. **Levar ao Codex** (vs. manter o global e só trocar o `onConflict`).

### 4c. P2-a — validar SKU no `confirmar_vinculo_boletim`

Dentro do laço, antes do INSERT: `IF NOT EXISTS (SELECT 1 FROM omie_products WHERE omie_codigo_produto = v_cod AND account = v_account) THEN RAISE EXCEPTION 'SKU %/% inexistente em omie_products'`. **Sem coerção silenciosa de caixa** (validar o valor exato; o candidato vem de `buscar_skus_candidatos` = `op.account` verbatim, então o caminho feliz nunca falha; só barra o vínculo-fantasma). **Não** virar FK rígida (omie_products é sincronizado/churna; FK com cascade perderia curadoria em janela de sync) — validação no momento do confirm, não constraint.

### 4d. P2-b — `desvincular_boletim(p_account, p_omie_codigo_produto)` (master)

Master-gated. **DELETA** a linha `confirmed` daquele SKU (o índice `one_confirmed` garante ≤1). Retorna `integer` (linhas removidas). Depois disso o SKU fica livre → `confirmar_vinculo_boletim` pode ligar outro spec (reatribuir = desvincular + confirmar, composto pela UI). DELETE (não flip pra `'rejected'`, que tem outra semântica = "sugestão rejeitada"; e evita colisão com o `unique_triple`).

### 4e. Guardrail do `useKbProductSpecs` singular

Não filtra `approved_at` **de propósito** (admin-only: o detalhe precisa ver o rascunho). Adicionar doc-comment "⚠️ admin-only — a venda lê `v_omie_product_current_spec`, NUNCA este hook". O badge "Aprovado" do `AdminKnowledgeBaseDetail` deveria checar `approved_at` (hoje mostra "Aprovado" pra qualquer spec) — fix cosmético opcional. A garantia real é o 0c-path-B usar a view.

## 5. Contratos

**Banco (1 migration ADITIVA + CREATE OR REPLACE das RPCs):**
- RLS de `kb_product_specs`: INSERT + UPDATE → master-only (DROP+CREATE das 2 policies; SELECT/DELETE intactas).
- (se a RPC for escolhida) `aprovar_kb_spec(p_payload jsonb, p_document_id uuid) RETURNS kb_product_specs` SECURITY DEFINER master-gated.
- `confirmar_vinculo_boletim` — `CREATE OR REPLACE` com a validação 4c (resto verbatim).
- `desvincular_boletim(p_account text, p_omie_codigo_produto bigint) RETURNS integer` SECURITY DEFINER master-gated; REVOKE anon/public, GRANT authenticated.
- (se 4b=dropar) `ALTER TABLE kb_product_specs DROP CONSTRAINT kb_product_specs_product_code_key` (nome real a confirmar via catálogo).

**Front:**
- `useSaveProductSpecs` / `useBulkApproveSpecs`: migram pra RPC `aprovar_kb_spec` **OU** mantêm upsert com `onConflict` composto (conforme 4a/4b). Sem mudança de assinatura externa (KbSpecsForm/ApprovalQueueSection inalterados).
- `useKbProductSpecs` singular: doc-comment guardrail (+ opcional `order/limit` se 4b dropar o global).
- `useDesvincularBoletim` (novo, master) — só se houver UI de desvínculo nesta fatia; senão fica pro 0c-path-B (a RPC já entra no banco agora).

## 6. Casos de erro / money-path safety

- Non-master tenta escrever spec → RLS nega (42501) → UI mostra erro; nada gravado.
- Master aprova → único caminho; `approved_at` setado (client ou RPC).
- `confirmar_vinculo_boletim` com SKU inexistente/account errado → RAISE explícito; nada gravado (fim do fantasma).
- `desvincular_boletim` de SKU não vinculado → retorna 0 (idempotente).
- Re-aprovar mesmo boletim → conflito pela identidade composta → UPDATE (sem duplicar nem sobrescrever fornecedor diferente).

## 7. Testes (PG17 local, padrão `db/verify-snapshot-replay.sh`, com FALSIFICAÇÃO)

- **RLS master-only:** seed employee + master; employee INSERT/UPDATE de `kb_product_specs` → **deve falhar** (assert que captura a SQLSTATE 42501 e re-lança o resto); master → passa; SELECT por employee → passa. **Falsificação:** sabotar o gate (voltar o ramo `extracted_by`) → o teste TEM que ficar vermelho.
- **`confirmar_vinculo_boletim`:** SKU inexistente → RAISE; account caixa-errada → RAISE; caminho feliz (candidato real) → grava. Sabotar a validação → vermelho.
- **`desvincular_boletim`:** confirmado→removido (libera o SKU); reatribuir (desvincular+confirmar outro spec) ok; não-vinculado→0; não-master→forbidden.
- **identidade composta:** (se 4b) re-upsert mesmo (supplier, code) → UPDATE 1 linha; código repetido em caixa/espaço → mesma linha (NFKC).
- **Execução** das RPCs (não só `CREATE`) — plpgsql é late-bound.
- ⚠️ o PG17 roda como `postgres` (superuser) → testa `auth.uid()`/`has_role` via GUC/seed, **não** os GRANTs/RLS em runtime de role (limitação conhecida; o gate é re-checado dentro das funções).

## 8. Sequência

1. **Codex consult** nas 2 decisões abertas (4a RPC-vs-RLS, 4b dropar-global) + adversarial no desenho.
2. `writing-plans` → plano bite-sized.
3. `subagent-driven-development` (implementer + spec-review + quality-review por task) + PG17 + Codex adversarial no SQL final.
4. PR. **⚠️ migration manual** (SQL Editor) — entregar inline. Front pede **Publish**.

## 9. Decisões registradas

- **A1 — o P1 é pré-requisito do consumo, não do merge.** A migration do 0a + esta só devem ser aplicadas juntas (ou esta antes do 0c ligar a venda). Até a venda ler a view, nada está exposto.
- **A2 — master-only é a V1-C elevada a enforcement.** Não é mudança de produto; é fechar o gap entre a decisão (master cura) e a RLS (deixava employee).
- **A3 — validar, não FK.** Vínculo validado no confirm, não constraint rígida (sync churn).

## 10. Resultado da consulta Codex (gpt-5.5 xhigh, 13/06) — adjudicação + escopo FINAL

**Adjudicação das 2 decisões abertas:**
- **4a → RLS-master-only + upsert composto no client; NÃO criar a RPC ampla.** ✅ Adotado. (Codex: a RPC de ~40 campos adiciona mass-assignment + manutenção e **não** seria "caminho único" sem também revogar DML direto; o `ON CONFLICT` composto com coluna preenchida por `BEFORE INSERT` funciona no PG.)
- **4b → Codex recomendou DROPAR o global agora + migrar consumidores; DECIDI ADIAR (discordância fundamentada — YAGNI).** O overwrite cross-fornecedor é **DORMENTE**: base vazia, fornecedor único (`sayerlack`) → `product_code` é único na prática, e o próprio global unique até **bloqueia** um 2º fornecedor com código colidente. Dropar agora ripa em **≥3 consumidores** (`RendimentoCalculator` usa o code como key/value+`.find`; `StandardProcess` persiste só o code; `useKbProductSpecs.maybeSingle()`) **sem ganho real hoje**. **Gatilho de revisita:** quando um 2º fornecedor com código colidente entrar → dropar o global + migrar consumidores pra `spec.id`. Registrado como follow-up. (Concordo com o Codex no mérito técnico; discordo só do *momento*.)

**Achados novos do Codex e disposição:**
- **[Codex P1] orphan-on-code-change** — corrigir `product_code`/`supplier` de uma ficha **vinculada** muda a chave composta → vira INSERT (nova linha/`id`) → o link aponta pro `id` antigo → a view segue exibindo números **velhos**. **Disposição: ADIADO p/ path-B.** Não há fluxo de edição-por-id em path-A (a fusão "confirmar-na-aprovação" é path-B). **Requisito de path-B:** edição **por `id`** (`UPDATE WHERE id=expected`), upsert composto só p/ criação/reimportação.
- **[Codex P1] queue-thrash (multi-doc por produto)** — 2 boletins do MESMO produto: aprovar V2 troca o `document_id` da linha única → V1 **volta à fila** (`useApprovalQueue` anti-junta por `document_id`) → um bulk-approve posterior re-grava V1 **sobre** V2 = **revert SILENCIOSO** da ficha ativa (refletido na hora pela view). **Disposição: ADIADO p/ follow-up "0b-hardening".** É gatilhado **só pelo master** pós-fix, exige multi-doc-por-produto, base vazia. **Fix correto** = ledger durável por documento (`kb_document_approvals(document_id PK, kb_product_spec_id FK ON DELETE SET NULL, approved_at, approved_by)` via **trigger AFTER** em `approved_at`) + a fila anti-juntar nele (doc aprovado nunca re-entra). Registrado **loud** no CLAUDE.md.
- **[Codex P2] validar omie_products não é barreira adversarial** — employee tem `FOR ALL` em `omie_products` → pode plantar SKU falso p/ o master confirmar. **Disposição: mantém como guardrail de INTEGRIDADE** (mata typo/fantasma). A **barreira de segurança** do vínculo é o gate **master** do `confirmar_vinculo` (employee não confirma). Endurecer a escrita de `omie_products` (`FOR ALL` amplo) = concern separado do catálogo inteiro → follow-up, fora de escopo.
- **[Codex P2] desvincular stale-delete** — incluir **`p_expected_kb_product_spec_id`** no DELETE (aba atrasada não apaga um vínculo já reatribuído; 0 linhas = conflito/stale UI). ✅ **Incorporado** ao path-A.
- **[Codex P2] sem CHECK de domínio nos números da venda** (rendimento negativo / catalisador 900%). ✅ **Incorporado** — CHECKs mínimos de **não-negatividade** nos campos consumidos pela view (`rendimento_m2_por_litro`, `demaos_recomendadas`, `pot_life_horas`, `validade_dias`, `catalisador_proporcao_pct`). Sem upper-bound apertado (não rejeitar dado legítimo).
- **[Codex P3] contador `v_count` mente em idempotência** (incrementa mesmo no `ON CONFLICT DO NOTHING`). ✅ **Incorporado** — `GET DIAGNOSTICS ROW_COUNT` no `confirmar_vinculo_boletim`.

**Escopo FINAL do path-A (1 PR — banco + guardrail de client):**
1. **RLS master-only** INSERT+UPDATE em `kb_product_specs` (SELECT/DELETE intactas) — **o P1 de segurança** (remove o ramo `extracted_by`).
2. `confirmar_vinculo_boletim` — `CREATE OR REPLACE`: + validação `SKU EXISTS em omie_products` + contador por `ROW_COUNT` (resto verbatim).
3. `desvincular_boletim(p_account, p_omie_codigo_produto, p_expected_kb_product_spec_id) RETURNS integer` (master; `DELETE … WHERE kb_product_spec_id = expected AND status='confirmed'`).
4. **CHECKs de não-negatividade** nos 5 campos numéricos consumidos pela view.
5. **Guardrail:** doc-comment em `useKbProductSpecs` (admin-only; venda lê a view) + fix do badge "Aprovado" do `AdminKnowledgeBaseDetail` (checar `approved_at`).

**PG17 (com falsificação):** RLS testada com **`SET ROLE` não-superuser + GUC `auth.uid`** (superuser bypassa RLS — padrão Silver+ do `verify-snapshot-replay.sh`); sabotar o gate → vermelho obrigatório. RPCs testadas por **execução**.

**Deferidos (registrados):** 4b multi-fornecedor (drop global + migrar consumidores); Codex-P1 orphan (path-B, edição por id); Codex-P1 queue-thrash (0b-hardening, ledger durável); endurecimento de `omie_products FOR ALL`.
