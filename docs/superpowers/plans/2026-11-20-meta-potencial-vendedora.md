# Meta por potencial da vendedora — plano

> **For agentic workers:** execução nativa (founder: "Aprovo, implementa"), steps em checkbox.

**Goal:** meta mensal congelada (previsão calibrada + incremento) e ritmo por dia útil no tile "Receita time · mês".
**Architecture:** 1 migration (2 tabelas ledger + 2 helpers SQL internos + RPC master-only `meta_potencial_mes()`),
hook `useMetaPotencial`, lib pura de agregação por seleção, tile + bloco recolhível.
**Spec:** `docs/superpowers/specs/2026-11-20-meta-potencial-vendedora-design.md`

## Global Constraints
- Universo de venda = status ∉ {cancelado,rascunho,pendente,orcamento}, `deleted_at is null`, `order_date_kpi`.
- Premissas v1: inc C +0,10 · inc D +0,05 · inc B 0,10 × (receita 6m ÷ meses com compra) · cross 10 estreias × mediana.
- Congela a partir do dia 3 SP; só o mês corrente; índice `null` → meta `null` (nunca 1).
- Dia útil: seg–sex não `fechado` em `calendario_operacao_empresa` (empresa = upper(account)); fim de semana só se `aberto`/`meia_equipe`.
- Funções: SECURITY DEFINER, `search_path=''`, gate master, `REVOKE` PUBLIC+anon (helpers: também authenticated).

## Review Focus
- Mês sem histórico de 12 cortes (conta nova) → meta indisponível, não R$ 0.
- Seleção single com conta sem meta → "meta indisponível"; 'all' com 1 conta sem meta → grupo indisponível.
- Dia 1–2 → "provisória" visível e nada gravado.
- Último dia útil já passou / meta batida → sem divisão por zero.
- Erro da RPC → tile de receita continua, meta "indisponível".

### Task 1: Migration + prova PG17
Files: `supabase/migrations/20261120230000_meta_potencial.sql`, `db/test-meta-potencial.sh`.
Prova: gate (customer/anon → 42501), dia 2 não grava, dia 3 grava e 2ª chamada não recalcula (mudar pedido
não muda meta), segmentos exclusivos (cliente 4/6m parado 70d = C), índice ausente → meta null, sensor n++,
ACL. Falsificar: sem gate, sem trava do dia 3, sem precedência de recência.

### Task 2: Aplicar em prod no envelope + postcondição; types.ts.

### Task 3: Front
`src/lib/dashboard/meta-potencial.ts` (pura: agrega linhas por seleção, ritmo) + teste;
`src/hooks/dashboard/useMetaPotencial.ts`; `TeamKpiTiles.tsx` (linha de meta) + `MetaPotencialDetalhe.tsx`;
manifesto; vitest do componente nos 5 itens da Review Focus.

### Task 4: typecheck · lint · test · PR (auto-merge) · historico.
