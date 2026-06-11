# Base de conhecimento → venda/copilot — Sub-projeto 0: FUNDAÇÃO ("Popular + Casar")

> Spec de design. Data: 2026-06-11. Autor: Claude (Opus) + 2ª opinião do Codex (gpt-5.5) no casamento.
> Status: aguardando revisão do founder antes de `writing-plans`.

## 1. Contexto e problema

O app já tem uma **base de conhecimento de boletins técnicos** (`/admin/knowledge-base`) que ingere PDFs, indexa pra RAG (`rag-search`), e extrai **specs estruturados** (`kb_product_specs`: rendimento, catalisador, demãos, pot-life, validade, substrato, certificações…). Também já existe `compare-customer-process` (IA que confronta o processo do cliente com padrões e devolve oportunidades com `product_codes_suggested`).

**Tudo isso está OCIOSO** — nada disso renderiza no app: nem na venda, nem no copilot. O founder quer que "a IA conheça os produtos e sugira melhor de acordo com o processo do cliente e no momento da venda".

**Dois bloqueios reais** impedem que qualquer ponta funcione hoje:

1. **A base está vazia** e o fluxo de cadastro é hostil a volume (1 PDF por vez → abrir cada doc → extrair → aprovar). O founder tem **muitos boletins** salvos pra subir. Sem dado, as pontas não têm o que mostrar.
2. **Não existe casamento** entre o item de venda (catálogo Omie) e o boletim. O código do boletim (ex. `FO20.6827.00`, código do fornecedor) vive na **descrição** do produto Omie (`VERNIZ PU FO20.6827.00 GL`), **não** no `codigo` interno (`PRD01722`) — o mesmo padrão Sayerlack que já mordeu na reposição.

Esta Fundação resolve os dois. Ela é **compartilhada** pelas pontas seguintes (venda determinística, venda IA, copilot), que viram specs próprios depois.

## 2. Objetivo e não-objetivos

**Objetivo:** tornar a base **populável em volume** e criar um **casamento confiável boletim ↔ item-de-venda** que as duas pontas consomem por um único contrato.

**Princípio mestre (money-path):** **precisão > recall.** Mostrar a ficha técnica do produto ERRADO no momento da venda é pior que não mostrar nada. Ambiguidade ⇒ **nenhuma ficha**. Vínculo só é usado em runtime se for **confirmado por humano** E o spec estiver **aprovado**.

**Não-objetivos da Fundação (YAGNI — registrados, adiados):**
- ❌ Renderizar specs na venda ou no copilot (são as fatias 1–3, specs próprios).
- ❌ **Versionamento temporal de specs** (revisões com `valid_from/valid_to`, `superseded_at`) e **snapshot de versão no pedido/orçamento** — recomendados pelo Codex, mas YAGNI com base vazia. Ver §10 (decisão V2-A).
- ❌ Reestruturar `kb_product_specs` no modelo de 3 tabelas do Codex (`kb_supplier_products` + `kb_product_spec_versions` + links). Reusamos a tabela existente (já tem hooks/UI/edge). Ver §10 (V2-A).
- ❌ Cobertura multi-fornecedor sofisticada — v1 mira Sayerlack + genérico, reusando `sayerlack-sku.ts`.
- ❌ Monitoramento no Sentinela (vínculos órfãos/ambíguos/descrição alterada) — ver §10 (V2-B).

## 3. Visão geral do programa (contexto — não é escopo deste spec)

```
FUNDAÇÃO (este spec)  →  1. Venda determinística  →  2. Venda IA (cross-sell)  →  3. Copilot
   popular + casar         card de specs ao            sugestão por processo        specs/RAG em
                           escolher produto            (compare-customer-process)   tempo real na chamada
```

Cada seta = spec→plano→PR próprio. A Fundação destrava as três.

## 4. Arquitetura da Fundação

### 4a. Modelo de dados

Reusa `kb_product_specs` como a entidade "produto técnico + spec" (não reestrutura). Adições:

**Ajustes em `kb_product_specs` (base vazia ⇒ custo de migração zero — momento ideal):**
- Nova coluna `product_code_normalized text` — normalização canônica do `product_code` (UPPER + trim + colapsar espaços; **mantém** `.00/GL/QT/LT` — são identidade). Gerada por trigger na escrita. Reusa o normalizador de `src/lib/reposicao/sayerlack-sku.ts` (já trata espaço↔ponto).
- **Identidade composta:** trocar `UNIQUE(product_code)` → `UNIQUE(supplier, product_code_normalized)`. Fecha (i) o bug de `upsert onConflict:'product_code'` que sobrescreve silenciosamente boletins de fornecedores diferentes com o mesmo código, e (ii) a fragilidade de `product_code` global apontada pelo Codex.

**Nova tabela `omie_product_spec_links` (o de-para confirmado):**

| coluna | tipo | nota |
|---|---|---|
| `id` | uuid PK | |
| `account` | text | `'oben' \| 'colacor' \| 'colacor_sc'` — **a chave Omie é COMPOSTA** |
| `omie_codigo_produto` | bigint | |
| `kb_product_spec_id` | uuid FK → kb_product_specs(id) | |
| `status` | text | `'confirmed' \| 'rejected'` (rejected = "lembrar pra não re-sugerir") |
| `confirmed_by` | uuid FK → auth.users | quem confirmou (server-side) |
| `confirmed_at` | timestamptz | |
| `created_at`, `updated_at` | timestamptz | |

- **Índice único parcial:** `UNIQUE(account, omie_codigo_produto) WHERE status='confirmed'` → garante **no máximo 1 spec ativo por SKU**. Múltiplos `rejected` permitidos.
- **Cardinalidade** (Codex §5): N SKUs Omie (GL/LT/QT) → 1 spec é natural (N links → 1 `kb_product_spec_id`). 1 SKU → 1 spec ativo (o índice impõe).
- RLS: SELECT staff; INSERT/UPDATE (confirmar/rejeitar) via RPC `SECURITY DEFINER` gated (ver 4b) — não escrita direta por PostgREST.

**View `v_omie_product_current_spec` (a fonte única que as pontas leem):**
```sql
-- security_invoker=on, staff-readable
SELECT l.account, l.omie_codigo_produto, l.kb_product_spec_id, s.*  -- campos técnicos
FROM omie_product_spec_links l
JOIN kb_product_specs s ON s.id = l.kb_product_spec_id
WHERE l.status = 'confirmed'
  AND s.approved_at IS NOT NULL;   -- dupla trava: confirmado E aprovado
```
O índice parcial garante ≤1 linha por `(account, omie_codigo_produto)`. (Se algum dia houver 2 ativos, é bug de dado — a view não escolhe arbitrário; o índice impede a 2ª inserção.)

### 4b. Casamento: busca reversa (sugere → confirma → runtime só confirmado)

**Insight central do Codex:** não extrair o código da descrição (frágil — captura o catalisador `FC.xxxx` citado). Em vez disso, **busca reversa**: dado `supplier + product_code_normalized` **confirmado no boletim**, achar SKUs Omie cuja descrição **contém exatamente esse código** (match por **token/boundary**, não substring livre).

**RPC `sugerir_skus_para_boletim(p_kb_product_spec_id)` (SECURITY DEFINER, staff-gated):**
- Lê `supplier` + `product_code_normalized` do spec.
- Varre `omie_products` (todas as contas) por descrição cujo conjunto de tokens normalizados contém o código (boundary — evita `FC.6952` casar dentro de outro token).
- **Validação de categoria** (Codex §2): se o spec é `verniz`, não sugerir SKU cuja descrição denota catalisador/diluente (heurística de palavra-chave) — reduz falso-positivo.
- Exclui SKUs já `confirmed` (em qualquer spec) e os `rejected` para este spec.
- Retorna candidatos: `{account, omie_codigo_produto, codigo, descricao, trecho_destacado, ambiguous}`. `ambiguous=true` quando ≥2 códigos plausíveis aparecem na mesma descrição.

**RPC `confirmar_vinculo_boletim(p_kb_product_spec_id, p_skus[])` e `rejeitar_sugestao(...)`** (SECURITY DEFINER, gate staff/master):
- Insere/atualiza `omie_product_spec_links` com `status='confirmed'`/`'rejected'`, `confirmed_by = auth.uid()` (server-side, anti-spoof).
- Respeita o índice único parcial; confirmar um SKU já ligado a OUTRO spec → erro explícito (não rouba vínculo silenciosamente).

**Regra de ouro:** regex/IA **nunca** publicam vínculo. Só **sugerem**. Humano confirma.

### 4c. Popular em volume (0a)

Estende `/admin/knowledge-base`:

1. **Upload múltiplo:** dropar N PDFs. Cada um → `kb_documents` (título = nome do arquivo; type = `boletim_tecnico`; supplier opcional default `sayerlack`).
2. **Auto-pipeline:** cada upload encadeia `kb-ingest-document` → (quando `ready`) `kb-extract-specs`. Hoje essas edges existem mas não são encadeadas nem em lote. Fila com estado por documento (`processing/ready/extracted/error`).
3. **Fila de revisão ("Boletins a aprovar"):** lista os specs extraídos com `extraction_confidence` + `extraction_gaps`. Ações:
   - **Aprovar em lote** os de alta confiança (limiar, ex. ≥0.85) num clique.
   - Abrir/ajustar os duvidosos no `KbSpecsForm` existente.
   - **Ao aprovar, fundir a confirmação de vínculo:** mostra os SKUs Omie sugeridos (4b), nenhum pré-selecionado, com `account`+código+descrição+trecho destacado; confirma **vários SKUs de embalagem numa ação**; botão **"aprovar sem vincular"**; divergência entre código informado e código extraído (Codex §6) **bloqueia** até escolha explícita.

> Resultado: founder joga 30/50 PDFs, a IA extrai, ele revisa por confiança e confirma vínculos em lote — base populada + casada em minutos.

## 5. Contratos de interface

**Banco:**
- `kb_product_specs` (+`product_code_normalized`, identidade `(supplier, product_code_normalized)`).
- `omie_product_spec_links` (nova).
- View `v_omie_product_current_spec`.
- RPCs: `sugerir_skus_para_boletim`, `confirmar_vinculo_boletim`, `rejeitar_sugestao`.

**Helper puro (TDD, espelha a normalização):** `src/lib/knowledge-base/code-normalize.ts` — `normalizeProductCode(raw)` + `matchesAsToken(descricao, codeNormalized)`. Reusa/estende `sayerlack-sku.ts`. É o oráculo que o SQL espelha.

**Front:**
- Hook `useProductSpecLink(account, omieCodigo)` — lê `v_omie_product_current_spec` (mapa leve por SKU + busca dos ~40 campos sob demanda ao selecionar). **Consumido pelas 2 pontas.** NÃO adiciona `product_code` ao tipo `Product` (Codex §3 — `Product` representa corretamente o SKU comercial).
- Hooks de ingestão em lote + fila de aprovação (estendem os existentes).

**Edges (reuso, encadeamento):** `kb-ingest-document`, `kb-extract-specs` (sem mudança de contrato; só orquestração em lote no front/fila).

## 6. Fluxos

**A. Popular:** dropar PDFs → auto-ingest+extract → fila → aprovar (lote/individual) + confirmar vínculo → `kb_product_specs.approved_at` + `omie_product_spec_links.status='confirmed'`.

**B. Ler na venda/copilot (pontas futuras):** dado `(account, omie_codigo_produto)` do item → `useProductSpecLink` → `v_omie_product_current_spec` → spec ou **nada** (sem vínculo confirmado = nada, por design).

## 7. Casos de erro / money-path safety

- Sem vínculo confirmado → view retorna vazio → ponta não mostra ficha (correto).
- `ambiguous` na sugestão → não auto-confirma; exige escolha humana.
- Confirmar SKU já ligado a outro spec → erro explícito (sem roubo silencioso).
- Divergência código-informado × código-extraído → bloqueia aprovação.
- Spec aprovado mas SKU sem vínculo → invisível na venda (não vaza spec solto).

## 8. Bugs atuais corrigidos nesta Fundação (achados pelo Codex)

1. **`useSaveProductSpecs` faz `upsert onConflict:'product_code'`** → sobrescreve histórico/outro fornecedor. Corrigido pela identidade composta + (se necessário) checagem de divergência.
2. **`useKbProductSpecs(productCode)` NÃO filtra `approved_at`** → inseguro pra venda (pode ler spec não-aprovado). A venda passará a ler **só** a view (confirmado+aprovado); o hook unitário ganha filtro `approved_at IS NOT NULL` ou é aposentado no caminho de venda.
3. **RLS deixa o próprio `extracted_by` atualizar o spec** e o client grava `approved_at` direto → revisar se aprovar (money-path) deve ser gated a master/founder. Decisão registrada em §10 (V1-C).

## 9. Testes

- **Helper puro `code-normalize.ts`** (vitest): normalização (caixa/espaço/ponto; preserva GL/QT/.00), match por token (não substring), casos Sayerlack do gabarito existente.
- **RPCs em PostgreSQL 17 local** (padrão `db/verify-snapshot-replay.sh`): busca reversa sugere certo/erra catalisador; índice único impede 2 ativos; confirmar SKU alheio falha; view só devolve confirmado+aprovado. Validação por **execução** das RPCs (não só `CREATE`).
- **Migration manual** (ritual Lovable §5 do CLAUDE.md) — `lovable-db-operator`.

## 10. Decisões e trade-offs

- **V1-A — Reusar `kb_product_specs` (não o modelo de 3 tabelas do Codex).** Menor disrupção (hooks/UI/edge já dependem dela); base vazia permite ajustar identidade barato. O ganho do modelo completo é versionamento temporal, que é V2.
- **V2-A — Versionamento temporal + snapshot no pedido (ADIADO).** Codex §6: "uma revisão posterior não pode mudar retroativamente a orientação dada ao cliente". Real, mas YAGNI com base vazia e specs que quase não mudam. Quando houver revisões de boletim, criar `kb_product_spec_versions` + snapshot de `spec_version_id` no orçamento/pedido.
- **V2-B — Monitoramento no Sentinela (ADIADO):** SKUs sem vínculo, vínculos ambíguos, specs aprovadas sem SKU, descrição Omie alterada após confirmação. Vira check de `data_health` quando a base tiver volume.
- **V1-C — Quem aprova/confirma (money-path):** confirmar vínculo via RPC server-side gated a staff (employee/master); avaliar apertar aprovação de spec pra master no plano. Não relaxar o gate.
- **Busca reversa > extração:** decisão central, reduz falso-casamento (não captura catalisador citado).

## 11. Sequência de PRs da Fundação

1. **PR-0a (banco):** coluna `product_code_normalized` + identidade composta + `omie_product_spec_links` + view + RPCs + helper puro TDD + testes PG17. (Migration manual.)
2. **PR-0b (front popular):** upload múltiplo + auto-pipeline + fila de aprovação com aprovar-em-lote.
3. **PR-0c (front casar):** confirmação de vínculo fundida na aprovação (sugestão por busca reversa + confirmar SKUs em lote + rejeitar) + hook `useProductSpecLink`.
4. **Fix junto:** os 2 bugs do §8 (upsert/approved_at).

Cada PR: helper TDD onde houver lógica, revisão independente, CI `validate`, e (no PR-0a) Codex adversarial no SQL antes do apply.
