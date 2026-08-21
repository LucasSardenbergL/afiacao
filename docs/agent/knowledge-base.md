# Base de Conhecimento (KB) — boletins↔SKU (referência operacional, money-path)

> Programa que faz a IA conhecer os boletins técnicos (rendimento/catalisador/demãos/validade) e sugerir produto na venda/copilot. Princípios em `docs/agent/money-path.md`. Specs: `docs/superpowers/specs/2026-06-1*-kb-*`. Diário em `docs/historico/bugs-resolvidos.md`.

## Casamento boletim↔SKU (a chave)

- **O boletim traz o código-BASE da fórmula** (`FO20.6827.00`); **o item de venda é a EMBALAGEM com sufixo colado** (`FO20.6827.00GL`, `WFOT.6529QT`). Casa **base↔base** (1 boletim → N embalagens) via `src/lib/knowledge-base/code-normalize.ts` (reusa `extrairCodigosSayerlack`/`sufixoSayerlack` de `sayerlack-sku.ts`). De quebra blinda contra casar o catalisador (citado sem embalagem).
- O código vive na **DESCRIÇÃO** do SKU Omie, não no `codigo`.

## Money-path: precisão > recall

- **Ambiguidade ⇒ NENHUMA ficha.** Regex/IA só **SUGEREM**; humano **confirma** (master-gated). A venda mostra ficha SÓ pela **view `v_omie_product_current_spec`** (`security_invoker`, **dupla-trava `confirmed` + `approved_at`**) — **zero matching fuzzy em runtime**, nunca reconstrói.
- ⚠️ **A venda lê a VIEW, NUNCA o hook singular `useKbProductSpecs`** (admin-only — ler o hook na venda fura a dupla-trava). Guardrail por doc-comment no hook.

## Escrita = master-only (a fronteira é a RPC, não a UI)

- Aprovação de spec é **master-only no banco** (RLS INSERT/UPDATE master; `REVOKE INSERT/UPDATE/DELETE FROM authenticated` — só RPC `SECURITY DEFINER` escreve). O `disabled` da UI é cosmético.
- RPCs: `confirmar_vinculo_boletim` (valida `(account, omie_codigo_produto)` EXISTS em `omie_products` → mata vínculo-fantasma), `desvincular_boletim` (expected-id anti-stale-delete), **`aprovar_versao_boletim`** (único caminho de escrita de spec).

## Versionamento (append-only)

- **`kb_product_spec_versions`** append-only, imutável por trigger **`kbv_block_mutation`** (`BEFORE UPDATE OR DELETE`; só `superseded_at` pode mudar). Índice parcial `kbv_uma_viva` (1 versão viva por produto). Re-aprovar boletim novo do mesmo produto = **nova versão**, não sobrescreve (a Sayerlack muda boletins → não perder conhecimento, ex.: catalisador removido).

- ⚠️ **A maquinaria de versionamento NUNCA rodou — 0 de 297, com denominador** (medido em prod via `psql-ro`, 2026-08-21). `change_type='initial'` em **119/119**; `version_number > 1`: **0**; `superseded_at`: **0**; `change_note` preenchido: **0**; `kb_documents.parent_id`: **0**. O trigger `kbv_block_mutation`, o índice `kbv_uma_viva` e as colunas `change_type`/`change_note` estão íntegros e **inéditos**. Isso não é "ainda não deu tempo": 297 documentos entraram e nenhum foi revisão de outro (um único candidato no corpus, base `NSB_9106_00`). É a regra "fase N+1 exige SINAL da fase N" do CLAUDE.md — **antes de investir em ler a diferença entre boletins, o passo é o SENSOR que avisa quando a v2 chega** (hoje nada avisa; a Sayerlack republicar um boletim é invisível para nós). Quando chegar, `/doc2md` nos dois PDFs + `diff` dá o "o que mudou", e o destino desse texto é a coluna `change_note`, que já existe e está vazia.
- ⚠️ **`kb_documents.product_code` é NULL em 297/297 — qualquer filtro/JOIN por ela é VACUAMENTE verdadeiro.** A coluna existe desde o início e **nenhum writer a preenche**; o vínculo real documento→produto vive em `kb_product_spec_versions.source_document_id`. Um `WHERE NOT EXISTS (… d.product_code …)` devolve "0 ocorrências" e parece uma conclusão — é o NULL-blind do CLAUDE.md, e mordeu de verdade nesta medição antes de eu conferir a contagem de não-nulos. **Conte `count(coluna)` vs `count(*)` ANTES de tirar conclusão de uma negação.**
- 📉 **O buraco real hoje é COBERTURA, não versão:** dos 297 documentos `ready`, só **119 viraram spec estruturada** — **178 (60%) nunca viraram**, e são boletins DISTINTOS (296 títulos-base distintos), não revisões represadas. Eles ainda alimentam o RAG por `kb_chunks`, mas não a ficha da venda (que lê `v_omie_product_current_spec`). Priorize por aí, não pelo diff.

## Extração paga (anti-re-pagamento)

- A edge `kb-extract-specs` extrai ~40 campos via Claude (**custa $**). Persistência em **`kb_extraction_drafts`** (⚠️ coluna **`spec` SINGULAR** — a edge responde `specs` plural; NÃO confundir, já mordeu).
- **Claim atômico** (RPC `kb_extraction_draft_claim`) ANTES da chamada paga = **anti-duplo-pagamento**: o `UPSERT` resolve a corrida de LINHA, **não** a de CUSTO (2 abas/duplo-clique pagariam 2×). **Cache-first**: draft `ready` + não-force → devolve o salvo, **sem chamar o Claude**.
- Gate **master-only** (`authorizeMaster`, não `authorizeCronOrStaff` — que deixava qualquer staff disparar custo). A RPC de claim é INVOKER + `REVOKE` de anon/authenticated (só `service_role`).

> ⚠️ Lição app-wide nascida do Codex retroativo neste programa (privilege escalation via trigger de role) está em `docs/agent/database.md` §4.
