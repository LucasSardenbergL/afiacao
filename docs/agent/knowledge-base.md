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

## Extração paga (anti-re-pagamento)

- A edge `kb-extract-specs` extrai ~40 campos via Claude (**custa $**). Persistência em **`kb_extraction_drafts`** (⚠️ coluna **`spec` SINGULAR** — a edge responde `specs` plural; NÃO confundir, já mordeu).
- **Claim atômico** (RPC `kb_extraction_draft_claim`) ANTES da chamada paga = **anti-duplo-pagamento**: o `UPSERT` resolve a corrida de LINHA, **não** a de CUSTO (2 abas/duplo-clique pagariam 2×). **Cache-first**: draft `ready` + não-force → devolve o salvo, **sem chamar o Claude**.
- Gate **master-only** (`authorizeMaster`, não `authorizeCronOrStaff` — que deixava qualquer staff disparar custo). A RPC de claim é INVOKER + `REVOKE` de anon/authenticated (só `service_role`).

> ⚠️ Lição app-wide nascida do Codex retroativo neste programa (privilege escalation via trigger de role) está em `docs/agent/database.md` §4.
