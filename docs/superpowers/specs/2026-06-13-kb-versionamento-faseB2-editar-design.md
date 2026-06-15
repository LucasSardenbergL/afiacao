# KB Versionamento — Fase B2: editar ficha pela tela (corrigir/completar → nova versão) — Design

**Data:** 2026-06-13
**Status:** decisões aprovadas pelo founder (brainstorming) — pronto pra plano + execução
**Pré-requisito:** Fase A em prod (RPC `aprovar_versao_boletim` aplicada) + Fase B1 (histórico/diff/completude, #807).

## Problema

A B1 deixa o founder VER o histórico e os dados faltantes, mas não há como **preencher/corrigir** um campo pela tela. Hoje só um boletim novo (extração) gera versão. A B2 fecha o ciclo: o founder pega o dado com a fábrica e **corrige/completa a ficha pela própria tela**, gerando uma nova versão imutável (`change_type` correction/data_completion) — sem subir boletim.

## Decisões (founder)

1. **Tipo da mudança = INFERIDO pelo diff:** se a edição só PREENCHEU campos vazios → `data_completion` ("Dados completados"); se MUDOU/apagou algum valor existente → `correction` ("Correção"). O founder não classifica.
2. **Preview com confirmação:** ao salvar, mostra um resumo (diff + tipo + motivo) e o founder confirma. Evita versão acidental.
3. **Acesso:** botão "Corrigir / Completar ficha" no detalhe do boletim → Dialog (mesmo padrão do `KbSpecsExtractButton`).

## Arquitetura (frontend; a RPC já existe da Fase A)

```
src/lib/knowledge-base/
  version-diff.ts        (MOD)  + inferirChangeTypeDoDiff(diff) → 'correction'|'data_completion'  [+ testes]

src/hooks/
  useSaveProductSpecs.ts (MOD)  SaveInput ganha changeType?/changeNote? (default bulletin_revision/null = atual)

src/components/knowledge-base/
  KbSpecsForm.tsx        (MOD, mínimo)  + props opcionais: onSubmitOverride, lockIdentity, submitLabel
  KbSpecsEditButton.tsx  (NOVO)  botão + Dialog(form modo corrigir) + preview(AlertDialog) + save

src/pages/
  AdminKnowledgeBaseDetail.tsx (MOD)  + <KbSpecsEditButton> ao lado do Extrair, quando há ficha aprovada
```

### `useSaveProductSpecs` (estende, retrocompatível)
`SaveInput` ganha `changeType?: 'bulletin_revision' | 'correction' | 'data_completion'` (default `'bulletin_revision'`) e `changeNote?: string | null` (default `null`). Passa pra RPC `aprovar_versao_boletim(p_payload, p_document_id, p_change_type, p_change_note)`. O comportamento atual (aprovação de boletim) fica **byte-idêntico** quando os novos campos são omitidos.

### `KbSpecsForm` (cirurgia mínima — NÃO quebrar o fluxo de aprovação)
3 props opcionais:
- `onSubmitOverride?: (specs: KbExtractedSpec) => void` — quando fornecida, o `onSubmit` chama isto (com os specs montados) em vez de `save.mutate`. O form deixa de tocar a RPC; o wrapper orquestra preview+save.
- `lockIdentity?: boolean` — `disabled` em **`product_code` e `supplier`** (a identidade `supplier+product_code_normalized`; mudar criaria outra ficha). `product_name` segue editável (corrigir nome é legítimo).
- `submitLabel?: string` — default `"Aprovar e salvar"`; a B2 usa `"Revisar mudança"`.

Sem `onSubmitOverride`, o form é **idêntico ao de hoje** (modo aprovação). Os testes/uso atuais não mudam.

### `KbSpecsEditButton` (novo — orquestra)
1. Botão "Corrigir / Completar ficha". Abre Dialog com `KbSpecsForm` (`initialValues` = ficha atual convertida; `lockIdentity`; `submitLabel="Revisar mudança"`; `onSubmitOverride`).
2. `onSubmitOverride(specs)`: calcula `diffVersions(fichaAtual, specs)`.
   - **Diff vazio** → `toast` "Nenhuma alteração" e não abre preview (guarda anti-versão-idêntica).
   - Senão → infere `changeType = inferirChangeTypeDoDiff(diff)`, guarda `{specs, diff, changeType}`, abre o **preview**.
3. **Preview (AlertDialog):** lista o diff (`rotularCampo`/`formatarValorCampo`, cores da B1) + "Será registrado como: {Correção|Dados completados}" + **campo "Motivo da mudança"** (Textarea, obrigatório — botão Confirmar `disabled` enquanto vazio) + número da próxima versão se disponível (via `useSpecVersions`).
4. Confirma → `save.mutate({ specs, documentId, changeType, changeNote: motivo })` → `onSuccess`: fecha tudo + invalida (o `useSaveProductSpecs` já invalida `kb-product-spec`/`kb-spec-versions`/`kb-completude`/`kb-approval-queue`).

**`document_id` preservado:** passa `documentId = fichaAtual.document_id ?? undefined`. NÃO null-clobber — preserva o vínculo com o boletim de origem (a RPC grava `p_document_id` no `kb_product_specs.document_id` e no `source_document_id` da versão).

### `inferirChangeTypeDoDiff(diff: CampoDiff[])`
- `diff.length === 0` → não chamado (o wrapper barra antes).
- `diff.some(d => d.tipo === 'changed' || d.tipo === 'removed')` → `'correction'`.
- senão (só `'added'`) → `'data_completion'`.

## Guardas

- **Sem alteração → não grava** (diff vazio barra antes do preview).
- **Identidade travada** (`product_code`/`supplier` read-only no modo corrigir) — corrigir dados, não trocar de produto.
- **Motivo obrigatório** (a RPC já exige `change_note` em correction/data_completion; a UI valida antes pra erro amigável).
- **Master-only:** a RPC gateia (`forbidden` se não-master); a tela KB já é gestor/master. O front não confia só na UI — a RPC é a fronteira.
- **Write-guard da lente "Ver como":** o `supabase.rpc` é interceptado pelo write-guard (libera só `get_`/`list_`); na lente, `aprovar_versao_boletim` (mutante) é bloqueado na fonte. O botão pode adicionar `disabled={isImpersonating}` pra UX honesta (a tela KB não costuma ser impersonada, mas é defesa em profundidade barata).

## Não-objetivos (B2)

- Reverter pra uma versão antiga pela UI (append-only; reverter = aprovar uma nova versão com os valores antigos — fluxo manual, não automatizado aqui).
- Editar em lote (corrigir N fichas de uma vez).
- Comparar/escolher 2 versões arbitrárias (segue B1: timeline "vs anterior").
- Mexer na RPC / migration (já existe e validada na Fase A; a B2 é só o front que a chama).

## Testes

- `version-diff.test.ts`: `inferirChangeTypeDoDiff` — só-added → data_completion; com changed → correction; com removed → correction; misto → correction.
- `diffVersions` já testado (Fase A).
- Form/wrapper: sem teste unitário pesado (UI); validação por typecheck + build + smoke do founder. A escrita real é a RPC, já coberta por PG17 (Fase A).

## Gates

`bun run typecheck` (strict) · `bun run test` · `bun lint` (0 errors) · `bun run build`.

## Codex / risco

A B2 **não introduz SQL novo** — chama a RPC `aprovar_versao_boletim` já validada (PG17 V1-V9 + revisão do controller na Fase A) e com Codex adversarial retroativo já pendente da Fase A. O front passa `change_type` inferido + `change_note` + `document_id` preservado. Auto-revisão adversária no lugar de Codex novo (sem money-path novo; a fronteira de segurança é a RPC master-only).
