# Venda assistida — Casamento do catalisador (destrava preço catalisado)

> Fatia escolhida pelo founder (2026-06-29). Destrava o preço CATALISADO no selo (hoje degrada a "sob consulta").
> Design do programa: `docs/superpowers/specs/2026-06-14-venda-assistida-ia-design.md`. Selo v1: PR #1135.

## Problema (dado real de produção)
`catalisador_codigo` em `kb_product_specs` é texto SUJO: um catalisador serve muitos boletins (FC.6975 = 13);
há variantes de separador (`FC.6975` vs `FC 6975`, `YC.1401` vs `YC 1401`); e multi-código/free-text
(`FC.6930 ou FC.7090`, `FCA.7002 (...50%), FCA.7077 (...35%), ...`). A `buscar_skus_candidatos` busca só na
**descrição** do `omie_products`.

## Decisões do founder (2026-06-29)
- **Chave NORMALIZADA:** `UPPER + só alfanumérico` (`FC.6975`→`FC6975`, `FC 6975`→`FC6975`). Variantes consolidam;
  multi-código/free-text normaliza pra algo que não casa SKU → **"sob consulta" honesto** (v1 não parseia o monstro).
- **UI no detalhe do boletim:** painel irmão do vínculo da base; mostra o catalisador do boletim + status + busca-e-aprova.
  Grava no mapa **GLOBAL** (serve todos os boletins com aquele código). Master-gated, "eu sugiro, você aprova".

## Modelo de dados (simétrico à casar da base)
- O catalisador tem embalagens (GL/QT/BH…) = vários SKUs, igual à base → o mapa é **(conta, omie_codigo_produto) → código normalizado**.
- **Tabela `kb_catalisador_links`**: `catalisador_codigo_norm text`, `account text`, `omie_codigo_produto bigint`,
  `status ('confirmed'|'rejected')`, `confirmed_by`, timestamps. Unique confirmado em **(account, omie_codigo_produto)**
  (≤1 catalisador por SKU; muitos SKUs por catalisador — espelha `omie_product_spec_links`). RLS SELECT staff.
- **Fn `kb_normalizar_catalisador(text)`** IMMUTABLE: `upper(regexp_replace(p,'[^a-zA-Z0-9]','','g'))`.
- **RPCs (master-gated, SECURITY DEFINER):** `confirmar_catalisador_vinculo(p_catalisador_codigo text, p_skus jsonb)`
  (normaliza + upsert confirmado) · `desvincular_catalisador(p_account, p_omie_codigo_produto, p_expected_norm)` (anti-stale).
- Reusa `buscar_skus_candidatos` pra achar os SKUs do catalisador (busca por descrição).

## Ligação no selo
Por grupo **(conta, boletim)**: normaliza `boletim.catalisador_codigo` → busca os SKUs confirmados em `kb_catalisador_links`
para (norm, conta) → `montarBaseEmbalagens(catalisadorRows, preços-da-conta)` → `catalisadorEmbalagens` →
`resolverOpcaoVenda`. Sem mapa → `catalisadorEmbalagens: []` → "sob consulta" (como hoje).

## Money-path
- Nunca fabrica preço (herda o motor). Catalisador obrigatório sem casamento/sem preço/sem litros → `incomplete` → "sob consulta".
- Normalização IMMUTABLE e usada NOS DOIS lados (gravação e lookup) — chave consistente.
- Aprovação master-gated no servidor (RPC), não confiar no gate do front.

## Fatias
1. **Migration** (`kb_catalisador_links` + fn normaliza + 2 RPCs + RLS) — prove-sql PG17 (falsificado) + lovable-db-operator (paste no SQL Editor).
2. **Hooks** (`useCatalisadorLinksMap` global + `useConfirmar/DesvincularCatalisador`) — `as never` (não editar types.ts).
3. **UI** painel no detalhe do boletim (irmão do `SpecLinkPanel`), master-only, lente-aware.
4. **Ligar no selo** (`montarSelosVendaAssistida` passa a alimentar `catalisadorEmbalagens`).

## Deferido
- Multi-catalisador por substrato + markup-pra-migração ("tabela de catálise") — o monstro free-text.
- Estender `buscar_skus_candidatos` pra buscar por `codigo` (hoje só descrição) se a cobertura ficar baixa.
