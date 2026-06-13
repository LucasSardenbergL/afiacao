# KB — Versionamento de boletins (Sub-projeto 1: FUNDAÇÃO)

> Spec de design. Data: 2026-06-13. Autor: Claude (Opus) + 2ª opinião do Codex (gpt-5.5).
> Continuação do programa **Base de conhecimento → venda/copilot** (Fundação KB #779 + 0c #786, em prod).
> Status: aguardando revisão do founder antes de `writing-plans`.

## 1. Contexto e problema

O founder quer **guardar versões de cada boletim técnico**. A Sayerlack muda boletins ao longo do tempo — e isso significa **perder conhecimento** (ex.: o boletim antigo permitia catalisar com o catalisador X; o novo removeu) **ou ganhar** (uma demão/validade nova). Hoje o modelo do KB é **1 linha por produto que SOBRESCREVE** ao re-aprovar (`kb_product_specs`, identidade composta `(supplier, product_code_normalized)`, `onConflict`). Re-aprovar um boletim novo do mesmo produto **apaga** o anterior — o histórico se perde.

Isso é o **versionamento temporal (V2-A)** que foi deliberadamente adiado na Fundação (YAGNI com base vazia). Agora a base está populando (~297 boletins) e o valor é concreto, então é o momento.

**Bônus:** o modelo de 1-linha-sobrescreve é a causa-raiz de **2 bugs latentes que o próprio Codex já tinha achado** no review retroativo do #779:
- **orphan-on-code-change** — o master corrige `product_code`/`supplier` de uma ficha vinculada → muda a chave composta → vira INSERT de nova linha (novo id) → o vínculo Omie aponta pro id ANTIGO → a venda mostraria número velho.
- **queue-thrash** — 2 boletins do MESMO produto: aprovar V2 troca o `document_id` da linha única → V1 volta à fila de aprovação (anti-join por `document_id`) → um bulk-approve posterior re-grava V1 **sobre** V2 = revert silencioso da ficha ativa.

Versionar (parar de sobrescrever) **mata os dois de graça**.

## 2. Decomposição do programa (contexto — só a Sub-1 é escopo deste spec)

| Sub | O quê | Status |
|---|---|---|
| **1 — Fundação do versionamento (ESTE SPEC)** | identidade estável + versões imutáveis + ponteiro atual + histórico com diff completo + migração dos 297 + conserto dos 2 bugs | agora |
| 2 — Matriz de catálise | doc separado (matriz produto × catalisadores) → opções versionadas na KB | próximo (precisa do arquivo de exemplo) |
| 3 — Surfacing na venda (path-B) | ficha + opções de catalisador + histórico no fluxo de venda, com rótulo seguro | depois |

A Sub-1 é **pré-requisito** das outras duas (a identidade estável do produto é onde a matriz e a venda se penduram).

## 3. Objetivo e não-objetivos (Sub-1)

**Objetivo:** parar de perder conhecimento — toda aprovação de boletim vira uma **versão imutável** (append-only); o produto tem uma **versão vigente** explícita; o master vê o **diff completo** ("o que mudou de um boletim pro outro") na tela do KB; a migração preserva os ~297 sem perda; e os 2 bugs morrem.

**Não-objetivos (adiados, registrados):**
- ❌ Surfacing na venda (Sub-3 / path-B — a venda ainda nem lê a ficha).
- ❌ Matriz de catálise / opções múltiplas de catalisador (Sub-2 — fonte própria).
- ❌ Snapshot da versão no pedido (essencial **quando** a venda consumir a KB — Sub-3; a versão é imutável, então o `version_id` já serve de snapshot na hora).
- ❌ Diff semântico por IA / determinar automaticamente se o catalisador antigo "ainda serve / é melhor / mais barato" (regra técnica + curadoria própria — nunca o sistema afirma isso).
- ❌ Aliases/merge/split de produtos, datas de vigência retroativas.
- ❌ Acoplar com o versionamento de fórmula tintométrica (frente paralela, dado e regras próprias — mesmo PADRÃO técnico, tabelas separadas).

## 4. Arquitetura (Codex + Claude convergiram)

### 4a. Modelo de dados — identidade estável + versões imutáveis + ponteiro atual

**`kb_spec_products`** — a raiz **estável** do produto (a identidade que nunca muda):
| coluna | tipo | nota |
|---|---|---|
| `id` | uuid PK | a identidade estável (o vínculo Omie aponta AQUI) |
| `supplier` | text | corrigível sem trocar o `id` |
| `product_code` | text | idem (o code é atributo do produto, não a PK) |
| `product_code_normalized` | text | trigger NFKC (reusa a normalização da Fundação) |
| `current_version_id` | uuid FK → kb_product_spec_versions(id) | ponteiro explícito da vigente (nullable até a 1ª aprovação) |
| `created_at`, `updated_at` | timestamptz | |

- `UNIQUE(supplier, product_code_normalized)` — 1 produto por (fornecedor, código). Corrigir o code de um produto **muda a coluna, não o `id`** → o vínculo continua válido (mata o **orphan**).

**`kb_product_spec_versions`** — histórico **append-only** (cada aprovação = 1 linha imutável):
| coluna | tipo | nota |
|---|---|---|
| `id` | uuid PK | é o "snapshot" (imutável → o id já serve de referência) |
| `product_id` | uuid FK → kb_spec_products(id) ON DELETE CASCADE | |
| `version_number` | int | sequencial por produto (1,2,3…) |
| `source_document_id` | uuid FK → kb_documents(id) | o PDF de origem |
| `change_type` | text CHECK ('bulletin_revision','correction','initial') | revisão da Sayerlack × correção de extração × migração |
| `change_note` | text NULL | obrigatória em `correction`, opcional em `bulletin_revision` |
| **os ~40 campos técnicos** | (mesmos de kb_product_specs) | snapshot imutável dos specs daquela versão |
| `approved_by` | uuid FK → auth.users | server-side |
| `approved_at` | timestamptz | = `valid_from` |
| `superseded_at` | timestamptz NULL | quando a próxima versão virou vigente (derivável, mas materializado p/ query) |
| `created_at` | timestamptz | |

- **Imutável:** trigger `BEFORE UPDATE` que **rejeita** alteração dos campos de payload de uma versão (só `superseded_at` pode mudar). Append-only de verdade.
- `version_number` único por `(product_id)`.
- **CHECKs de não-negatividade** (rendimento/demãos/pot-life/validade/catalisador_pct ≥ 0) migram do 0c pra esta tabela — é onde os números técnicos passam a viver.

**`omie_product_spec_links`** (existente) passa a referenciar o **produto**, não a spec:
- Adiciona `product_id uuid` (FK → kb_spec_products), índice parcial `≤1 confirmed por (account, omie_codigo_produto)` preservado.
- A venda resolve: link → produto → `current_version_id` → specs da vigente.
- A coluna antiga `kb_product_spec_id` é descontinuada após a migração (ver §6).

**View `v_omie_product_current_spec`** (a venda lê): reescrita pra `link (confirmed) → product → current_version (approved)`. A **dupla-trava** vira: `link.status='confirmed'` + `product.current_version_id IS NOT NULL` (a vigente é, por construção, aprovada). Os campos técnicos vêm da versão vigente.

> **Como mata os 2 bugs:** (orphan) corrigir code/supplier mexe em `kb_spec_products`, o `id` é estável, o link nunca aponta pra lugar errado. (queue-thrash) a fila passa a anti-juntar por "documento já tem versão aprovada" (§4c) — V1 nunca volta à fila depois de V2, então não re-grava nada.

### 4b. Nova versão × correção (o gatilho)

Tudo append-only; nada de payload aprovado é editado in-place. A distinção é só de **rótulo + UX**:
- **PDF novo associado a um produto existente** → a UI pergunta: **"Nova revisão do boletim"** (cria versão `bulletin_revision`, vira a vigente, guarda a anterior) × **"É outro produto"**.
- **Corrigir um erro da extração** → ação **separada** "Corrigir dados extraídos" → cria uma versão `correction` (nova linha imutável, vira vigente; `change_note` obrigatória). Não é uma revisão da Sayerlack, mas **é** uma revisão interna do registro (auditável).
- **Nunca** um botão que edita os campos de uma versão já aprovada.

### 4c. Fila de aprovação (conserta o queue-thrash)

`useApprovalQueue` deixa de anti-juntar por "documento cujo `document_id` está na linha única aprovada" e passa a anti-juntar por **"documento que já tem QUALQUER versão aprovada"**:
```sql
-- documento pendente = ready E sem nenhuma versão aprovada apontando pra ele
NOT EXISTS (SELECT 1 FROM kb_product_spec_versions v WHERE v.source_document_id = kb_documents.id)
```
→ uma vez aprovado, o documento **sai da fila pra sempre** (não re-entra quando outra versão do mesmo produto é aprovada). Revisões novas entram como documentos novos.

### 4d. Histórico com diff completo (o "todas as alterações claras" do founder)

Na tela do KB (admin, `AdminKnowledgeBaseDetail`): a ficha do produto mostra a **vigente** + uma seção **"Histórico de versões"**. Ao comparar duas versões (ou vigente × anterior), um **diff campo-a-campo COMPLETO** (todos os ~40 campos que mudaram), claro: `campo · valor anterior → valor atual · data de aprovação · PDF de origem de cada lado`.
- **Disciplina de rótulo (money-path, vale aqui e na venda):** o diff **mostra** o que mudou; **não afirma** "pode usar / é melhor / mais barato". Um campo que sumiu (ex.: catalisador removido) aparece como *"o boletim anterior (aprovado DD/MM) trazia X — não consta no atual; validar tecnicamente antes de oferecer"*.
- Helper puro TDD `diffVersions(a, b)` → lista de `{campo, de, para, tipo: added|removed|changed}`. Oráculo testável; a UI só renderiza.

### 4e. Escrita: RPCs transacionais master-only (consistente com o 0c)

Toda escrita de versão passa por **RPC `SECURITY DEFINER` master-gated** (a curadoria é do founder, V1-C; consistente com a RLS master-only do 0c):
- **`aprovar_versao_boletim(p_product_identity, p_source_document_id, p_change_type, p_change_note, p_payload jsonb)`** — find-or-create do `kb_spec_products` (por identidade), insere a próxima `version_number`, seta `superseded_at` na anterior, promove `current_version_id`. Transacional (advisory lock por produto p/ serializar version_number).
- A RLS de `kb_product_spec_versions` e `kb_spec_products`: SELECT staff; INSERT/UPDATE/DELETE **negado a authenticated** (só via as RPCs DEFINER + service_role). A imutabilidade vem do trigger + do gate.
- `confirmar_vinculo_boletim`/`desvincular_boletim` (do 0c) passam a referenciar `product_id` (a identidade estável) em vez de `kb_product_spec_id`.

## 5. Contratos de interface (front)

- `useSaveProductSpecs` / `useBulkApproveSpecs` → passam a chamar `aprovar_versao_boletim` (em vez do `upsert` direto). Sem mudança de assinatura externa pros componentes.
- `useKbProductSpecs` / `useKbProductSpecsList` → leem a **versão vigente** (via produto → current_version). `useKbProductSpecsList` continua filtrando "tem vigente aprovada".
- `useApprovalQueue` → novo anti-join (§4c).
- Novo `useSpecVersionHistory(productId)` + `useSpecVersionDiff(versionA, versionB)` → alimentam a seção de histórico/diff no `AdminKnowledgeBaseDetail`.
- A UI de "nova revisão × outro produto × corrigir dados" (§4b) entra no fluxo de aprovação.

## 6. Migração (aditiva, sem perda — ~297 linhas)

Padrão Lovable (SQL manual). **Pausa só nas aprovações por alguns minutos**; extração de PDF segue:
1. Cria `kb_spec_products`, `kb_product_spec_versions`, constraints, trigger de imutabilidade, RPCs. Adiciona `product_id` nullable em `omie_product_spec_links`.
2. Pra cada linha de `kb_product_specs`: cria 1 `kb_spec_products` + 1 versão `change_type='initial'` (os 40 campos, `source_document_id`/`approved_at`/`approved_by` preservados) + seta como `current_version_id`.
3. Backfill `omie_product_spec_links.product_id` pelo antigo `kb_product_spec_id` → produto correspondente.
4. **Reconciliação por contagem + hash** dos campos técnicos (toda linha migrou; todo link confirmado tem produto + vigente aprovada).
5. Troca a `v_omie_product_current_spec` pro modelo novo. Troca o anti-join da fila. Migra os hooks/edge pra RPC.
6. Torna `product_id` obrigatório; descontinua `kb_product_spec_id` do link. Reabre aprovações.
> ~Poucas centenas de boletins → pausa curta é mais segura que dual-write. Docs em `processing/ready` não-aprovados não migram — entram pelo fluxo novo.

## 7. Money-path / casos de erro

- Append-only enforçado por trigger (rejeita UPDATE de payload aprovado) + RPC master-only.
- Concorrência de aprovação (2 boletins do mesmo produto ao mesmo tempo) → advisory lock por produto serializa `version_number` + promoção.
- Migração: tudo aditivo + reconciliação por hash antes de virar a chave; `product_id` só vira obrigatório depois de validado.
- Diff/histórico **mostra, não recomenda** (rótulo "boletim anterior dizia X · validar tecnicamente").

## 8. Testes

- **Helper puro `diffVersions`** (vitest): added/removed/changed, campo-a-campo, ordem estável.
- **Helper puro** da decisão nova-versão/correção (mapeia entrada → `change_type`).
- **PG17 (padrão `db/test-*.sh`, com falsificação):** append-only (UPDATE de versão aprovada → rejeitado); `version_number` sequencial sob concorrência (advisory lock); `aprovar_versao_boletim` promove vigente + seta `superseded_at`; fila anti-junta certo (doc aprovado não re-entra); link resolve produto→vigente; gate master (não-master barrado); migração preserva contagem+hash; orphan e queue-thrash **provados mortos** (cenário antes/depois).
- **Codex adversarial** no SQL final (money-path) antes do apply.

## 9. Decisões registradas

- **Modelo:** identidade estável + versões imutáveis + ponteiro (Codex+Claude). Mata orphan + queue-thrash.
- **Correção é versão também** (não edição in-place) — append-only > auditoria; UX distingue por ação/rótulo.
- **Diff completo no histórico** (todos os campos), mas **rótulo não-afirmativo** (founder quer clareza do que mudou; o sistema não decide se a opção antiga vale).
- **Snapshot no pedido = Sub-3** (a versão imutável já dá o `version_id` de snapshot quando a venda consumir).
- **Matriz de catálise = Sub-2** (fonte própria, precisa do arquivo de exemplo).
