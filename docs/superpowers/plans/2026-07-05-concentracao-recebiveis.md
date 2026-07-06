# F5 Concentração de recebíveis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline TDD).
> Steps use checkbox (`- [ ]`) syntax. Spec: `docs/superpowers/specs/2026-07-05-concentracao-recebiveis-design.md`.

**Goal:** Monitor master-only de concentração de crédito por código Omie (proxy de sacado) no `/financeiro`, com money-path blindado (empty≠zero, sem fabricar número/nome).

**Architecture:** Helper TS puro (`concentracao-helpers.ts`, vitest) faz toda a matemática + gates de fonte. Hook fino (`useConcentracaoRecebiveis`) lê `fin_contas_receber` (sem tabela nova), atesta `FonteStatus` (guarda o cap PostgREST) e chama o helper. UI = aba no `FinanceiroDashboard`. **v1 = códigos** ("Cliente #código"); nome rico = fast-follow (Codex F).

**Tech Stack:** React 18 + TS strict + @tanstack/react-query + supabase-js + vitest + shadcn/ui.

---

## Escopo v1 (o que ENTRA) vs fast-follow

- **Entra:** helper puro (métricas + gates), hook de leitura com `FonteStatus`, aba UI master-only, testes vitest (money-path + falsificação).
- **Fast-follow (fora do v1, Codex F):** resolução de nome rico `(company,código)`-scoped; grupo econômico; concentração de receita; semáforo forte. v1 mostra `Cliente #código` sempre — zero risco de nome fabricado.
- **Sem migration** (lê `fin_contas_receber`; RLS já provado pela aba `contas-receber`). Se a leitura client bater RLS/perf → RPC `SECURITY DEFINER` + prove-sql (decidir na Task 3).

---

## Task 1: Tipos (`concentracao-types.ts`)

**Files:**
- Create: `src/lib/financeiro/concentracao-types.ts`

- [ ] **Step 1: Criar o arquivo de tipos** (verbatim da spec §3): `Company`, `FonteStatus` (`'ok'|'indisponivel'|'parcial'`), `TituloAberto`, `MotivoConcentracao`, `ImpactoAbsoluto`, `LinhaExposicao`, `ConcentracaoResult`. Sem lógica — só `export type`/`interface`.
- [ ] **Step 2: `bun run typecheck`** → PASS (tipos compilam isolados).
- [ ] **Step 3: Commit** `feat(concentracao): tipos F5`.

---

## Task 2: Helper puro (`concentracao-helpers.ts`) — TDD, o núcleo money-path

**Files:**
- Create: `src/lib/financeiro/concentracao-helpers.ts`
- Test: `src/lib/financeiro/__tests__/concentracao-helpers.test.ts`

Funções puras exportadas: `c50(sharesDesc: number[])`, `hhi(shares: number[])`, e a orquestradora `concentracaoEmpresa(titulos, fonte, opts)`. Constantes de política `PISO_MODERADO=25000`, `PISO_ALTO=75000` (exportadas, tunáveis).

- [ ] **Step 1 (gates de fonte — a prova P0-1): escrever testes que FALHAM.**
  - `fonte='indisponivel'` + `[]` → `{motivo:'fonte_indisponivel', totalAberto:null, topN:[]}`.
  - `fonte='indisponivel'` + `[títulos válidos]` → **não calcula** (`motivo:'fonte_indisponivel'`, métricas null).
  - `fonte='ok'` + `[]` → `{motivo:'sem_carteira', totalAberto:0, top1Pct:null, topN:[]}`.
  - `fonte='parcial'` + `[]` → `{motivo:'fonte_parcial', totalAberto:null}` (não `sem_carteira`).
- [ ] **Step 2: rodar** `heavy bun run test concentracao-helpers` → FAIL (função não existe).
- [ ] **Step 3: implementar o esqueleto de `concentracaoEmpresa`** com a ordem de gates da spec §3 (1: indisponivel→null; 2: particiona válidas/inválidas; 3: vazio+ok+0inv→sem_carteira; 4: vazio+parcial→fonte_parcial; 5: com válidas→calcula). Retornar métricas null nos ramos sem cálculo.
- [ ] **Step 4: rodar** → PASS os testes de fonte.
- [ ] **Step 5 (agregação + primárias): testes que FALHAM** para: 3 códigos com saldos `[100,60,40]` (total 200) → `totalAberto:200`, `maiorExposicao:100`, `top1Pct:0.5`, `clientes:3`; `top5Pct` com <5 códigos = soma dos existentes (=1.0 aqui).
- [ ] **Step 6: implementar** agregação por `omie_codigo_cliente` (Map), ordenação desc por saldo, `totalAberto/maiorExposicao/top1Pct/top5Pct/clientes`. Rodar → PASS.
- [ ] **Step 7 (C50): testes que FALHAM.** `c50([0.6,0.3,0.1])→1` (um >50%); `c50([0.25,0.25,0.25,0.25])→2` (acumula ≥50% em 2); `c50([0.34,0.33,0.33])→2`. Empate estável.
- [ ] **Step 8: implementar `c50`** (ordena desc, acumula share até `>=0.5`, conta). Wire no `concentracaoEmpresa`. Rodar → PASS.
- [ ] **Step 9 (HHI/nº efetivo — secundário): testes.** `hhi([0.5,0.5])→0.5`, `nEfetivo=2`; `hhi([1])→1`, `nEfetivo=1`. Rodar FAIL→implementar→PASS.
- [ ] **Step 10 (overlay vencido): testes.** código com saldo 100 e 30 ATRASADO → `vencido:30, pctVencidoProprio:0.3`; código sem ATRASADO → `vencido:0, pctVencidoProprio:0` (**não** null). FAIL→implementar (agrega `vencido` por `atrasado===true`)→PASS.
- [ ] **Step 11 (linha inválida — Codex E): testes.** título com `saldo:NaN` / `saldo:-5` / `saldo:Infinity` / `omie_codigo_cliente:null` (com fonte `ok`) → `linhasInvalidas>=1`, `motivo:'fonte_parcial'`, a linha **não** entra em `totalAberto`, o total das válidas permanece correto. FAIL→implementar (partição + `Number.isFinite && saldo>0 && codigo!=null`)→PASS.
- [ ] **Step 12 (impactoAbsoluto = tom keyed na maiorExposicao): testes.** maior=20000→`'baixo'`; 54000→`'moderado'`; 80000→`'alto'`; e em todos os casos `topN` continua preenchido (nunca oculta — P1-5). FAIL→implementar→PASS.
- [ ] **Step 13 (falsificação — dente dos asserts):** temporariamente sabotar (a) o gate `indisponivel` (deixar calcular) → o teste de Step 1 fica **VERMELHO**; (b) fazer a linha inválida ser dropada sem `fonte_parcial` → Step 11 **VERMELHO**. Restaurar → verde. Documentar no comentário do teste.
- [ ] **Step 14: `heavy bun run test concentracao-helpers`** → tudo PASS; `bun run typecheck` PASS.
- [ ] **Step 15: Commit** `feat(concentracao): helper puro + vitest (money-path, falsificação)`.

---

## Task 3: Camada de leitura (`useConcentracaoRecebiveis`) + classificação de fonte

**Files:**
- Create: `src/hooks/useConcentracaoRecebiveis.ts`
- Modify: `src/lib/financeiro/concentracao-helpers.ts` (adicionar `classificarFonte` pura)
- Test: `src/lib/financeiro/__tests__/concentracao-helpers.test.ts` (append)

- [ ] **Step 1: pure `classificarFonte({error, rows, limitAtingido})` → FonteStatus** — testes: `error!=null → 'indisponivel'`; `limitAtingido → 'parcial'`; senão `'ok'`. FAIL→implementar→PASS. (O cap PostgREST 1.000 vira `'parcial'`, não silêncio.)
- [ ] **Step 2: hook** `useConcentracaoRecebiveis()` com `useQuery` por empresa: `select('omie_codigo_cliente,saldo,status_titulo').in('status_titulo',['A VENCER','ATRASADO']).eq('company', c)` com `.range(0, LIMIT-1)` estável; `limitAtingido = data.length >= LIMIT`. Mapeia `TituloAberto` (`atrasado = status_titulo==='ATRASADO'`), chama `classificarFonte` + `concentracaoEmpresa`. Retorna `Record<Company, ConcentracaoResult>`. **Confirmar RLS master lê fin_contas_receber (aba contas-receber já lê); se NÃO → RPC SECURITY DEFINER + prove-sql** (documentar decisão aqui).
- [ ] **Step 3: `bun run typecheck`** PASS.
- [ ] **Step 4: Commit** `feat(concentracao): hook de leitura + classificarFonte`.

---

## Task 4: UI — aba no FinanceiroDashboard

**Files:**
- Read first: `src/pages/FinanceiroDashboard.tsx` (padrão de `TabsList`/`TabsContent` + como a `DRETab` é montada).
- Create: `src/components/financeiro/ConcentracaoTab.tsx` (ou o dir onde vive `DRETab`).
- Modify: `src/pages/FinanceiroDashboard.tsx` (registrar a aba `concentracao`, master-only).

- [ ] **Step 1: ler** `FinanceiroDashboard.tsx` + o componente da `DRETab` pra copiar o padrão (gate master, seletor de empresa, cards, tabela, skeleton).
- [ ] **Step 2: `ConcentracaoTab`** — por empresa: cards primários (maior R$, top5%, C50) + badge `impactoAbsoluto` (tom, `text-status-*`) + tabela `topN` (`Cliente #código`, R$ aberto, R$ vencido, %vencido, share%) + bloco secundário HHI/nº efetivo. Estados honestos: `fonte_indisponivel` → `<EmptyState>` "não foi possível ler a carteira" (**não** "sem concentração"); `fonte_parcial` → banner "leitura parcial (N inválidas/truncada)"; `sem_carteira` → `<EmptyState tone="operational">` "sem recebíveis abertos". Copy fixa: **"Concentração por código Omie (sacado) — não consolida grupo econômico."** `<PageSkeleton>` no loading.
- [ ] **Step 3: registrar a aba** `concentracao` no `FinanceiroDashboard` (label "Concentração"), master-only (mesmo gate da DRE/endividamento).
- [ ] **Step 4: `bun run typecheck` + `bun run lint`** PASS.
- [ ] **Step 5: Commit** `feat(concentracao): aba UI no FinanceiroDashboard (v1 códigos)`.

---

## Task 5: Verde total + Codex adversarial no código

- [ ] **Step 1: `heavy bun run test` (suíte inteira) + `bun run typecheck` + `bun run lint`** → 0 fail.
- [ ] **Step 2: Codex adversarial NO CÓDIGO** (`codex exec -m gpt-5.5 -c model_reasoning_effort=xhigh -s read-only`, padrão F1 §11) apontando os arquivos novos + a spec; atacar: fabricação de fonte, cap não-guardado, C50/HHI errados, tom ocultando painel, RLS. Acatar P1; documentar no fim da spec.
- [ ] **Step 3: aplicar correções do Codex** (se houver) com testes de regressão.

---

## Task 6: PR + handoff Lovable

- [ ] **Step 1: push + PR** (não-draft → auto-merge no verde). Corpo: resumo + "sem migration; deploy = Publish frontend (1 camada)".
- [ ] **Step 2: nota de deploy** — F5 **não tem migration** (só lê `fin_contas_receber`). Deploy Lovable = **só Publish frontend**. Sem SQL Editor, sem validação de banco.
- [ ] **Step 3: registrar em `docs/historico/`** (entrega F5) — não engordar CLAUDE.md.

---

## Self-review (writing-plans)

- **Cobertura da spec:** §3 helper→Task 2; §5 degradação→Task 2 (steps 1,11)+Task 4 (estados); §6 RLS→Task 3 step 2; §7 UI→Task 4; §8 prova→Task 2 (steps 1-14); §0/§10 copy honesta→Task 4 step 2. ✅
- **Sem placeholder:** todos os steps têm código/comando/critério explícito. ✅
- **Consistência de tipos:** `ConcentracaoResult`/`FonteStatus`/`TituloAberto` idênticos entre Task 1/2/3. ✅
