# Frente B — "Caça" (look-alike dos melhores → Hunter) — Plano de Implementação

> **Para workers agênticos:** SUB-SKILL: `superpowers:subagent-driven-development`. Tarefas com checkbox (`- [ ]`). Spec: `docs/superpowers/specs/2026-06-04-frente-b-caca-design.md` (ler §7 grão, §5 melhores, §15 revisão Codex).

**Goal:** Uma fila de caça proativa pro hunter ("vá atrás destes N clientes parecidos com seus melhores que não compram"), grão `(documento × empresa-alvo)`, com degradação honesta por sabor (cross/dormente/frio).

**Architecture:** Helper puro TDD (lift/score/sabor/ranking) ← view/snapshot SQL `(documento × empresa-alvo)` ← hook `useCaca` → componente `FilaDeCaca` na rota `/caca` + card no `MasterDashboard` + render no `HunterDashboard`. Não é money-path (inteligência comercial, staff-readable). Reusa o padrão visual/feedback da `FilaDoDia` (Frente A).

**Tech Stack:** React 18 + TS + Vite · vitest (helper) · Supabase view/RPC (Lovable SQL Editor, migration manual) · TanStack Query.

**Princípio:** núcleo sólido (helper) → view → frontend → piloto (founder é o hunter). O helper define o CONTRATO; a view alimenta nesse formato.

---

## Fase 0 — Diagnóstico de dados (read-only, founder no SQL Editor) — DESTRAVA a view

> Confirma as incógnitas da §13 ANTES de desenhar a view. São queries **read-only** pra colar no 🟣 **Lovable → SQL Editor → Run**. O founder cola os resultados; eu detalho a Fase 2 com base neles. NÃO bloqueia a Fase 1 (helper roda em paralelo).

- [ ] **Q1 — Cobertura de `venda_items_history` por empresa** (a fonte fiscal cross-CNPJ; o Codex viu cron só de Oben):
```sql
select empresa, count(*) linhas, count(distinct cliente_cnpj_cpf) clientes,
       min(data_emissao) desde, max(data_emissao) ate
from venda_items_history group by empresa order by empresa;
```
- [ ] **Q2 — Compra por empresa via `sales_orders.account`** (fallback + base do sabor cross-empresa):
```sql
select account, count(*) pedidos, count(distinct customer_user_id) clientes,
       count(*) filter (where coalesce(order_date_kpi, created_at) >= now() - interval '6 months') ultimos_6m
from sales_orders where status not in ('cancelado','rascunho')
group by account order by account;
```
- [ ] **Q3 — `profiles.document`: PJ × PF + duplicados** (decide dedup por-tipo vs consolidado):
```sql
select case when length(regexp_replace(coalesce(document,''),'\D','','g'))=14 then 'CNPJ'
            when length(regexp_replace(coalesce(document,''),'\D','','g'))=11 then 'CPF'
            else 'outro/null' end tipo,
       count(*) total, count(distinct regexp_replace(coalesce(document,''),'\D','','g')) distintos
from profiles where coalesce(is_employee,false)=false group by 1;
```
- [ ] **Q4 — Universo candidato: vinculados sem compra recente + não-vinculados:**
```sql
select 'com_conta' fonte, count(*) from profiles p
  where coalesce(is_employee,false)=false
  and not exists (select 1 from sales_orders so where so.customer_user_id=p.user_id
                  and so.status not in ('cancelado','rascunho')
                  and coalesce(so.order_date_kpi, so.created_at) >= now() - interval '6 months')
union all
select 'nao_vinculados_atual', count(*) from v_clientes_nao_vinculados_atual;
```
- [ ] **Q5 — `farmer_client_scores` cobertura vs universo** (confirma que frios não têm score → degradação honesta):
```sql
select count(*) total_scores, count(distinct customer_user_id) clientes_com_score from farmer_client_scores;
```
- [ ] **Decisão pós-Q1-Q5 (eu):** fonte primária de compra-por-empresa (`venda_items_history` se cobre as 3, senão `sales_orders.account` + nota de cobertura); dedup por-tipo de documento; tamanho esperado do universo por sabor. Atualizo a Fase 2 e o §13 do spec.

---

## Fase 1 — Helper puro TDD (núcleo da lógica) — `src/lib/caca/` — INDEPENDENTE da Fase 0

> Define o CONTRATO que a view (Fase 2) alimenta. 100% testável com fixtures, sem produção. Subagent-driven, TDD. Cada função: teste falhando → impl mínima → verde → commit.

### Task 1.1 — Tipos + normalização de documento
**Files:** Create `src/lib/caca/types.ts`, `src/lib/caca/documento.ts` + `__tests__/documento.test.ts`

- [ ] Tipos (contrato):
```ts
export type EmpresaAlvo = 'oben' | 'colacor' | 'colacor_sc';
export type SaborCaca = 'cross_empresa' | 'dormente' | 'frio';
export type DimensaoCaca = 'regiao' | 'ramo' | 'ticket' | 'familias';

export interface CandidatoFeatures {
  documento: string;                  // normalizado (só dígitos)
  empresaAlvo: EmpresaAlvo;
  cidadeUf: string | null;            // "DIVINOPOLIS-MG"; null = desconhecida
  ramo: string | null;                // derivado do mix OU cnae; null = "sem ramo conhecido"
  ticketFaixa: number | null;         // ticket médio histórico; null = frio
  familias: string[];                 // famílias compradas; [] = frio
  compraEmOutraEmpresa: boolean;      // sabor cross
  compraNaEmpresaAlvo: boolean;       // se true, NÃO é candidato pra essa empresa
  ultimaCompraGrupoDias: number | null; // null = nunca comprou (frio)
  atrasoRelativo: number | null;      // boost (customer_metrics_mv)
}
export interface MelhorCliente { documento: string; cidadeUf: string|null; ramo: string|null; ticketFaixa: number|null; familias: string[]; }
export interface PerfilMelhores {
  regiaoLift: Record<string, number>; ramoLift: Record<string, number>; familiaLift: Record<string, number>;
  ticketMediano: number | null; nMelhores: number;
}
export interface CacaResultado { features: CandidatoFeatures; sabor: SaborCaca; score: number; confianca: number; dimensoesUsadas: DimensaoCaca[]; porque: string[]; rankFinal: number; }
```
- [ ] `normalizarDocumento(doc: string|null): string` — só dígitos; vazio se null/inválido. Testes: máscara CNPJ → 14 dígitos; null → ''; com pontuação → limpo.

### Task 1.2 — Classificação de sabor (precedência cross > dormente > frio)
**Files:** Create `src/lib/caca/sabor.ts` + teste

- [ ] `classificarSabor(c: CandidatoFeatures, dormenteMeses=6): SaborCaca`
  - `compraEmOutraEmpresa && !compraNaEmpresaAlvo` → **cross_empresa** (mesmo se comprou ontem no grupo).
  - `ultimaCompraGrupoDias != null && ultimaCompraGrupoDias >= dormenteMeses*30 && !compraNaEmpresaAlvo` → **dormente**.
  - `ultimaCompraGrupoDias == null` → **frio**.
  - **Testes anti-impl-preguiçosa:** cross vence dormente (comprou na Colacor há 200d, zero Oben, alvo=oben → cross); comprador recente na Colacor + zero Oben → cross (não some); nunca comprou → frio; já compra na empresa-alvo → NÃO classificável (helper retorna null/erro — não é candidato).

### Task 1.3 — Perfil dos melhores por LIFT (com suporte mínimo + teto)
**Files:** Create `src/lib/caca/perfil.ts` + teste

- [ ] `perfilPorLift(melhores: MelhorCliente[], base: {cidadeUf:string|null; ramo:string|null; familias:string[]}[], opts?: {suporteMin?: number; tetoLift?: number}): PerfilMelhores`
  - lift de um valor `v` na dimensão = `freq(v | melhores) / freq(v | base)`. `suporteMin` (default 3): valor com menos de N melhores → lift neutro (1) ou excluído. `tetoLift` (default 5): satura (geografia não domina).
  - `ticketMediano` = mediana do ticket dos melhores.
  - **Testes:** valor desproporcional entre melhores (ramo marcenaria 60% melhores vs 20% base → lift 3) entra; valor que só reflete a base (cidade 80% melhores mas 80% base → lift ~1) NÃO pesa; suporte < min → neutro; lift acima do teto → saturado.

### Task 1.4 — Score do candidato + confiança
**Files:** Create `src/lib/caca/score.ts` + teste

- [ ] `scoreCandidato(c: CandidatoFeatures, perfil: PerfilMelhores): {score:number; confianca:number; dimensoesUsadas:DimensaoCaca[]}`
  - Soma a aderência por dimensão **só com dado**: regiao (lift da cidadeUf), ramo (lift do ramo; `ramo=null` → dimensão ausente, NÃO zero), ticket (proximidade ao mediano), familias (média dos lifts das famílias do candidato).
  - `confianca` = nº de dimensões com dado / 4 (faixa baixa/média/alta).
  - **Testes anti-impl-preguiçosa:** candidato frio (ramo=null, familias=[], ticket=null) → só regiao → confiança baixa (1/4); candidato rico → 4/4; `ramo=null` não conta como lift 0 (ausência ≠ zero); dois candidatos com mesmo score mas confianças diferentes.

### Task 1.5 — Ranking (score × confiança × boost_sabor) + porquê
**Files:** Create `src/lib/caca/ranking.ts` + teste

- [ ] `boostSabor(s: SaborCaca): number` — cross_empresa > dormente > frio (ex.: 1.3 / 1.0 / 0.6).
- [ ] `rankearCaca(candidatos: CandidatoFeatures[], perfil: PerfilMelhores, dormenteMeses=6): CacaResultado[]` — classifica sabor, calcula score/confiança, `rankFinal = score × confiança × boostSabor`, ordena desc, ignora quem já compra na empresa-alvo.
- [ ] `montarPorque(c, perfil, sabor): string[]` — razões interpretáveis: "mesma região dos seus melhores"; "compra a família X que seus melhores compram"; "já compra da Colacor, zero na Oben"; **frio sem ramo → "sem ramo conhecido"** (NUNCA "mesmo ramo").
  - **Testes anti-impl-preguiçosa:** frio com score alto NÃO lidera sobre cross/dormente (boost+confiança puxam pra baixo); cross sempre acima de dormente equivalente; porque do frio nunca afirma ramo que não existe; baseline — uma lista de cross/dormente/frio ordena cross→dormente→frio salvo score×confiança muito díspar.

### Task 1.6 — Gate da Fase 1
- [ ] `heavy bun run test` (helper verde) + `heavy bun run typecheck` + `bun lint`. Commit.

---

## Fase 2 — View/snapshot SQL `(documento × empresa-alvo)` — depende da Fase 0 (lovable-db-operator)

> Migration manual (SQL Editor). Grão = `(documento_normalizado, empresa_alvo)`. Fonte de compra-por-empresa definida na Fase 0. Detalho o SQL exato após Q1-Q5. Estrutura-alvo:

- [ ] **View `v_caca_candidatos`** (`security_invoker=on`, staff-readable): uma linha por `(documento, empresa_alvo)` candidato (não compra na empresa-alvo), com: `cidade_uf`, `ramo` (do mix/CNAE), `ticket_faixa`, `familias` (array), `compra_em_outra_empresa`, `ultima_compra_grupo_dias`, `atraso_relativo`, `sabor`, `fonte`, `cobertura`.
- [ ] **View/CTE `v_caca_melhores`** — "melhores" por CNPJ: percentis de volume 12m + freq/recência + margem (com confiança; `gross_margin_pct=0` não conta). EVP só feature Oben.
- [ ] **View `v_caca_mix_familia`** — famílias compradas por documento×empresa (de `venda_items_history` ou `sales_orders.items`+`omie_products.familia`, **sempre com `account`/`empresa`** no join — anti-contaminação P1).
- [ ] **Decisão snapshot vs view ao vivo:** se a agregação for pesada (toda a base), materializar em snapshot (padrão `customer_metrics_mv`) com cron; senão view direta. Medir na Fase 0.
- [ ] **LGPD:** excluir documentos com opt-out global (cruzar com a fonte de opt-out existente — confirmar tabela na Fase 0/código).
- [ ] Entregar via `lovable-db-operator`: arquivo de migration + bloco pro SQL Editor + query de validação + nota de PR + regenerar audit.

---

## Fase 3 — Frontend: hook + componente + acesso

### Task 3.1 — `useCaca()` hook
**Files:** Create `src/hooks/useCaca.ts`
- [ ] Lê `v_caca_candidatos` + `v_caca_melhores` (paginado, anti-truncamento 1000) → roda `perfilPorLift` + `rankearCaca` → retorna top-K (ex.: 50) com `CacaResultado`. Loading/erro honestos.

### Task 3.2 — Componente `FilaDeCaca`
**Files:** Create `src/components/caca/FilaDeCaca.tsx`
- [ ] Reusa o padrão visual da `FilaDoDia` (item priorizado + porquê + ações + outcome). Por candidato: badge de sabor (cross/dormente/frio) + confiança + `porque[]`. Ações: ligar (`tel:` se houver) / ficha (Customer 360 se vinculado) / iniciar pedido (`/sales/new?customer=&returnTo=/caca` quando aplicável) / outcome (caçei/converteu/sem-fit/não-agora). **Card por cliente**, agrupando empresas-alvo se o mesmo documento aparece >1×.
- [ ] Empty-state honesto; degradação (frio marcado).

### Task 3.3 — Acesso (founder é o hunter)
**Files:** Modify `src/App.tsx` (rota `/caca`), `src/components/dashboard/HunterDashboard.tsx` (substitui placeholder), `src/components/dashboard/MasterDashboard.tsx` (card/link "Caça")
- [ ] Rota `/caca` (gated staff: hunter + master). Render `FilaDeCaca` no `HunterDashboard` (troca o placeholder). Card/entrada no `MasterDashboard` (founder acessa sem trocar de role). NÃO toca `FarmerDashboardV2`.

---

## Fase 4 — Telemetria, feedback, gate, PR

- [ ] **Telemetria** `caca.*` (espelha `fila.*`): `caca.exibida {qtd,sabores}`, `caca.item_aberto {sabor,confianca}`, `caca.acao {cta,sabor}`, `caca.outcome {resultado,sabor}`, `caca.descartado {sabor}`. Via `track()` de `@/lib/analytics`.
- [ ] **Loop de feedback** — reusa o padrão da fila (esconder-na-sessão + outcome). v1: outcome registrado em telemetria (persistência server-side = evolução, espelhando o que a Frente A decidiu).
- [ ] **Métrica de sucesso (piloto)** — instrumentar pra medir conversão→1ª compra por sabor (cross = compra na empresa-ALVO) + comparar com baseline (dormente por recência pura + cross por maior faturamento). Critério duro: top-K tem que bater o baseline por sabor.
- [ ] **Gate CI** `validate` (typecheck + test + build + lint) verde local (`heavy`). Abrir PR `feat/frente-b-caca` → main com nota de migration manual (Fase 2).

---

## Não-objetivos (v1) / evolução
Prospecção externa + radar do ME; vetorial/kNN; co-compra como motor; automação/pin/cadência; persistência server-side do feedback; calibração de pesos por ML. Tudo guiado pelo piloto (founder como hunter).

## Self-review (writing-plans)
- Cobre §3-§9 do spec (motor, grão, sabores, score, entregável, onde-calcular, métrica) + os 5 P1 do Codex (§15): grão documento×empresa-alvo (Task 1.1/Fase 2), não-compra por empresa-alvo + precedência (Task 1.2), melhores por CNPJ (Fase 2 v_caca_melhores), fonte venda_items_history + join com account (Fase 0/2), frio sem-ramo (Task 1.5 montarPorque), LGPD opt-out (Fase 2).
- Sem placeholders no contrato do helper (tipos/assinaturas/comportamento + exemplos de teste anti-impl-preguiçosa). A Fase 2 (SQL) é deliberadamente detalhada APÓS a Fase 0 (dado real) — dependência declarada, não placeholder.
- Tipos consistentes (CandidatoFeatures/PerfilMelhores/CacaResultado/SaborCaca usados em todas as tasks).
