# KB Versionamento — Fase B1: visualização (histórico + diff + completude) — Design

**Data:** 2026-06-13
**Status:** aprovado pelo founder (chat) — pronto pra plano + execução
**Pré-requisito:** Fase A em prod (migration `20260613150000` aplicada, `kb_product_spec_versions` + RPC `aprovar_versao_boletim` + backfill 119/119).

## Problema

A Fase A garante que **o dado existe** (toda aprovação vira versão imutável; nada se perde quando a Sayerlack muda um boletim). Mas hoje **não há onde VER isso**: o histórico de versões, o que mudou entre elas, e quais dados importantes faltam pra pedir à fábrica estão invisíveis no app.

A Fase B1 é **só visualização** (read-only). As ações de preencher/corrigir uma ficha pela tela (gerando nova versão) ficam pra **Fase B2**.

## Escopo (3 peças + 1 bônus)

### 1. "Histórico de versões" — no detalhe do boletim (`/admin/knowledge-base/:id`)
Seção nova abaixo da ficha atual. Linha do tempo das versões **do produto** daquele boletim (ordem mais-recente-primeiro):
- Cada versão: `version_number`, `change_type` (rótulo amigável), data (`approved_at`), `change_note`.
- Cada versão ≥ v2: **diff vs a versão imediatamente anterior** via `diffVersions(anterior, atual)` — 🟢 adicionado · 🔴 removido · 🟡 alterado, com "de → para" (labels e valores formatados).
- A v1 (initial) não tem diff.

### 2. Aba nova "Dados faltantes" — na tela KB (`/admin/knowledge-base`, ao lado de Documentos | A aprovar)
Lista de **o que pedir à fábrica**. Produtos **aprovados** com campos importantes vazios, ordenados do mais incompleto pro menos (`relatorioCompletude`):
- Por produto: `product_name`, `product_code`, e os campos faltantes em chips (rótulos amigáveis).
- Linha clicável → navega pro detalhe do produto (via `document_id` da ficha, ou `/admin/knowledge-base?product=<code>` se não houver doc — ver "Decisões").
- Badge numérico na aba (quantos produtos têm faltantes).

### 3. (bônus) Selo de completude no detalhe
Na ficha atual do detalhe, um aviso discreto quando `camposFaltantes(ficha).length > 0`: "⚠ N dados importantes faltando", listando os campos. Reusa `camposFaltantes`.

## Arquitetura (frontend puro, read-only)

```
src/lib/knowledge-base/
  campo-labels.ts        (NOVO)  CAMPO_LABEL + rotularCampo + formatarValorCampo + rotularChangeType  [+ testes]
  version-diff.ts        (existe) diffVersions / decidirChangeType
  completude.ts          (existe) camposFaltantes / relatorioCompletude / CAMPOS_IMPORTANTES

src/hooks/
  useSpecVersions.ts     (NOVO)  lê kb_product_spec_versions por (supplier, product_code_normalized) ASC|DESC
  useCompletude.ts       (NOVO)  lê kb_product_specs aprovados → relatorioCompletude

src/components/knowledge-base/
  VersionHistory.tsx     (NOVO)  timeline + diff (usa useSpecVersions + diffVersions + labels)
  CompletudeSection.tsx  (NOVO)  lista de produtos incompletos (usa useCompletude + labels)
  CompletudeBadge.tsx    (NOVO, bônus)  selo "N faltando" (usa camposFaltantes)

src/pages/
  AdminKnowledgeBase.tsx       (MODIFICA)  3ª aba "Dados faltantes" + badge
  AdminKnowledgeBaseDetail.tsx (MODIFICA)  <VersionHistory> + <CompletudeBadge> na ficha
```

## Contratos

**`useSpecVersions(supplier, productCode)`** → `{ data: SpecVersion[], isLoading }`
- Normaliza: `sup = (supplier ?? 'sayerlack').toLowerCase().trim()`, `norm = normalizeProductCode(productCode)`.
- `enabled` só quando `productCode` truthy.
- Query: `kb_product_spec_versions` `.eq('supplier', sup).eq('product_code_normalized', norm).order('version_number', { ascending: false })`.
- ⚠️ A tabela **não está em `types.ts`** (Lovable regenera pós-migration) → cast `as never`/`as any` na chamada. **NÃO adicionar à mão** (lição §10).
- `SpecVersion` = tipo local: `version_number`, `change_type`, `change_note`, `approved_at`, `product_code`, + os ~35 campos técnicos (subset de `KbProductSpec`, reusa `Partial<KbExtractedSpec>` pros campos do diff).

**`useCompletude()`** → `{ data: CompletudeProduto[], isLoading }`
- Query: `kb_product_specs` `.select('product_code, product_name, extraction_gaps, <CAMPOS_IMPORTANTES>').not('approved_at', 'is', null)`.
- Aplica `relatorioCompletude(data)`; retorna só os com `faltantes.length > 0` (a aba é "dados faltantes" — produto completo não aparece).
- 119 linhas hoje, sem paginação (volume pequeno; se crescer >1000 vira follow-up).

**`campo-labels.ts`** (helper puro, TDD):
- `CAMPO_LABEL: Record<string, string>` — rótulos pt-BR dos ~38 campos técnicos (ex.: `rendimento_m2_por_litro` → "Rendimento (m²/L)", `catalisador_proporcao_pct` → "Catalisador (%)").
- `rotularCampo(campo: string): string` — `CAMPO_LABEL[campo] ?? campo` (fallback ao nome cru, nunca quebra).
- `formatarValorCampo(v: unknown): string` — array → join " · "; `null`/`''`/array vazio → "—"; resto → `String(v)`.
- `rotularChangeType(t: string): string` — initial→"Versão inicial", bulletin_revision→"Boletim revisado", correction→"Correção", data_completion→"Dados completados", fallback→`t`.

## Decisões

- **Identidade pela ficha atual, não pelo documento:** o `VersionHistory` recebe `supplier`/`productCode` da **ficha aprovada** (`useKbProductSpecs(data.product_code)`), porque foi esse `supplier`/`product_code` que o backfill/RPC gravou. Usar `data.supplier` do `kb_documents` poderia divergir.
- **Navegação da completude:** a `CompletudeProduto` não carrega `document_id`. Pra clicar→detalhe, a query da completude inclui `document_id` (de `kb_product_specs`); se `document_id` for null (ficha sem doc), a linha não é clicável (mostra só o texto). Sem inventar rota.
- **Read-only total:** nenhuma escrita, nenhuma RPC mutante, nenhuma migration, nenhum deploy de edge. Só `Publish` do front no fim (junto com o que já está pendente de #802/#805).
- **`change_note` pode ser null** (backfill `initial` e `bulletin_revision` permitem null) → o componente esconde a nota quando vazia.

## Não-objetivos (Fase B1)

- Preencher/corrigir campo pela tela (= **Fase B2**, usa a RPC com `change_type` correction/data_completion).
- Comparar 2 versões arbitrárias (a B1 mostra só "vs a anterior" — timeline). Comparador livre = follow-up se pedido.
- Reverter pra uma versão antiga (a tabela é append-only por design; reverter seria aprovar uma nova versão = B2).
- Tela "por produto" separada (decisão do founder: histórico vive no detalhe do boletim).

## Testes

- `campo-labels.test.ts`: `formatarValorCampo` (array/null/vazio/número/string), `rotularCampo` (conhecido + fallback), `rotularChangeType` (4 tipos + fallback).
- `diffVersions`/`relatorioCompletude` já têm cobertura (Fase A).
- Hooks/componentes: sem teste unitário pesado (UI read-only); validação por typecheck + build + smoke manual do founder pós-Publish.

## Gates

`bun run typecheck` (strict) · `bun run test` · `bun lint` (0 errors) · `bun run build`.
