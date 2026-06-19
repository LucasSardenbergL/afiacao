# Cockpit de Valor (Oben) — EVP-teto marcado: degradação honesta do capital ausente

- **Data:** 2026-06-18
- **Status:** design aprovado pelo founder; **Codex challenge `xhigh` incorporado** (60.249 tokens, 2026-06-18)
- **Escopo desta entrega:** MOTOR (helper TS puro + edge Deno verbatim + contrato + recomendações + confiança + testes vitest). A camada de UI ("EVP ≤ X" + badge "estoque/AR não medido" + tooltip) é a **entrega seguinte** (founder: "1 depois 2"), acoplada ao dia em que o Ke for ligado.
- **Arquivos:** `src/lib/financeiro/valor-cockpit-helpers.ts` (+ `__tests__/valor-cockpit-helpers.test.ts`), `supabase/functions/fin-valor-cockpit/index.ts` (espelho verbatim).

## Problema (achado Codex, 2026-06-18)

`montarCelulasComboEVP` trata componente de capital **ausente como R$0**:

```ts
const a_cs = arC != null && rc > 0 ? arC * (c.receita_liquida / rc) : 0;   // AR ausente → 0
const i_cs = estS != null && qs > 0 ? estS * (c.quantidade / qs) : 0;       // estoque ausente → 0
const encargo = input.k == null ? null : input.k * (a_cs + i_cs);
const evp = cm == null || encargo == null ? null : cm - encargo;
```

Perna de capital ausente entra como 0 → **encargo subestimado → EVP superestimado** (otimista). Viola money-path #2 ("ausente ≠ zero"). Mitigação atual (flags + `scoreConfiancaCockpit`) **não corrige o número** e tem ponto cego abaixo de 30%.

## Medição (psql-ro read-only, TTM Oben, 2026-06-18)

- **Dano HOJE = R$0.** `fin_valor_inputs.ke.base` da Oben vazio → `k=null` → EVP `null` em 100% das células. Bug **LATENTE**; nasce quando o Ke for configurado em `/financeiro/valor`.
- **Recorte fiel:** `receita_total = R$5.059.623` = `empresa.receita` do #939.
- **Exposição** (3.783 células): **19,9%** com ≥1 perna ausente (estoque 19,2% vs AR 0,8%). Das 3.471 com `cm`: **442 expostas (12,7%)**, valendo **~R$250k / 4,95% da receita**. **206/558 SKUs (37%) sem `inventory_position`** — binário (0 casos saldo-sem-cmc). Ordem de grandeza do encargo de estoque faltante: ~R$16k–38k a um Ke 0,20.
- **Ponto cego confirmado:** `estoque_ausente_pct = 19,2% < 30%` → `scoreConfiancaCockpit` não rebaixa hoje.
- **Assimetria:** AR ausente (0,8%) ≈ cliente à vista; estoque ausente (19,2%) ≈ não-syncado/sob encomenda.

## Decisões

- **Semântica (founder):** EVP-teto marcado — mantém o número, declara-o **teto** (upper bound) quando capital incompleto.
- **AR = estoque (founder):** qualquer perna ausente marca teto. "AR à vista = 0 real" é aposta não-verificável; uma regra só, menos superfície.
- **D1 "Crescer/proteger" parcial (founder):** **qualificar** (emite com ressalva), não suprimir.
- **D2 furo cm=null (delegado a Claude+Codex):** **tratar agora via qualificação** — mesmo mecanismo do D1, sob o conceito único "EVP confiável".

## Design (motor)

### Princípio + invariante de robustez
Capital incompleto ⟹ `encargo` é **piso** ⟹ `evp = cm − encargo` é **teto**. A afirmação "teto" **só vale se** `k>0` finito e cada perna de capital `≥0` finita (Codex [P1]: capital negativo/NaN transforma teto em piso). Logo o motor **impõe esses invariantes na fronteira** — capital inválido vira *indisponível* (teto), nunca número sujo.

### Robustez / guards na fronteira (Codex [P1]×4 — MUST-FIX)
1. **`k` inválido → tratado como `null`** (encargo indisponível) dentro de `montarCelulasComboEVP`: `if (k != null && (!Number.isFinite(k) || k <= 0)) k := null`. Defense-in-depth sobre `resolverHurdleCockpit`.
2. **Capital negativo/não-finito → indisponível:** `ar_indisponivel = arC == null || !Number.isFinite(arC) || arC < 0 || rc <= 0` (idem `estoque_indisponivel` com `estS`). A perna inválida não entra como número; marca teto. Fecha o contraexemplo (`teto<0 ⟹ real<0` sob dado negativo).
3. **`margemContribuicao` finita:** `const m = receita − custo*qtd; return Number.isFinite(m) ? m : null` (cm NaN → null; receita/qtd não-finitos → null).
4. **Guard na edge:** `estoque_valor = e && Number.isFinite(e.saldo) && Number.isFinite(e.cmc) ? e.saldo*e.cmc : null` (fecha `saldo*null=0`); `ar_medio` propagado só se finito. Fecha o `COALESCE→0` residual (Codex [P1]).

### Contrato
**Célula** (`CelulaEVP`) ganha `evp_parcial: boolean = evp != null && (ar_indisponivel || estoque_indisponivel)`.
- `evp` numérico inalterado → identidade `Σ porCliente.evp = Σ porSKU.evp = empresa.evp` intacta (com guards, sem NaN → não quebra).
- Zero-conhecido (SKU presente saldo 0; `ar_medio=0` conhecido) **não** é parcial.

**Rollup** (`RollupCliente`/`RollupSKU`/`empresa`) ganham:
- `evp_parcial: boolean` = OR das células contribuintes-teto (`evp != null && evp_parcial`).
- `cm_incompleto: boolean` = grupo tem ≥1 célula com `cm == null` (excluída do EVP — Codex [P1] do `cm=null`).

**Topo (retorno)** ganha `evp_teto_receita_pct: number` = `Σ receita {evp!=null && evp_parcial} / Σ receita {evp!=null}`; `0` se denominador 0. **Ponderado por receita, não contagem** (Codex [P1]: célula parcial pode carregar 80% do EVP em 1% das células).

### Recomendações — `recomendarAcaoComercial`
Novos inputs opcionais `evp_parcial?: boolean`, `cm_incompleto?: boolean` (do rollup-cliente). Conceito único:
```
evp_confiavel = evp != null && evp > 0 && !evp_parcial && !cm_incompleto
```
- **Positivo confiável** (`evp_confiavel`): "Crescer / proteger" (motivo atual).
- **Positivo não-confiável** (`evp>0 && (evp_parcial || cm_incompleto)`): "Crescer / proteger" **qualificado** — motivo compõe "capital parcial — confirmar" e/ou "margem parcial (parte sem custo)". (D1+D2: qualifica, não suprime; responde Codex [P1]×2 e o [P2] do OR grosseiro.)
- **Negativo** ("Encurtar prazo", "Despriorizar / liquidar"): dispara só com **`evp != null && evp < 0`** (era `evp == null || evp < 0` → fabricava ação em EVP desconhecido; Codex [P1] MUST-FIX). `teto<0 ⟹ real<0` → robusto.
- **Cortar desconto:** `(!evpConhecivel || evp==null || evp<=0 || evp_parcial)` — teto>0 deixa de blindar contra o corte.
- **Subir preço** (margem%): ortogonal, intacta.

### Confiança — `scoreConfiancaCockpit`
Novo input **`evp_teto_receita_pct: number`** (substitui a ideia de contagem):
- `> 0` → **sempre** motivo: "X% do EVP (por receita) é teto — encargo de capital não medido."
- `> 0.05` → **rebaixa para média**. Calibrado para o caso real: Oben ≈ R$250k/R$4,79M = **5,2% > 5% → rebaixa** (o limiar de 15%-por-contagem que eu propus deixava 12,7% passar verde — Codex [P1], corrigido).
- Limiares de `ar_indisponivel_pct`/`estoque_ausente_pct` (qualidade-de-dado geral) inalterados.

### Espelhamento
Verbatim TS↔edge. A edge calcula `evp_teto_receita_pct` no orquestrador (de `res.celulas`), aplica o guard de `estoque_valor`/`ar_medio`, e passa `evp_parcial`+`cm_incompleto` do rollup-cliente para `recomendarAcaoComercial`.

## Rastreabilidade da revisão Codex (xhigh, 2026-06-18)
| Achado | Severidade | Tratamento |
|---|---|---|
| `k` cru (k<0 vira piso, NaN vira EVP) | P1 | Guard 1 |
| capital/`a_cs`/`i_cs` negativo/NaN | P1 | Guard 2 |
| `rc<=0`/`qs<=0` mascarado | P1 | Guard 2 (marca indisponível→teto) |
| `cm=NaN` | P1 | Guard 3 |
| ponto cego 30% não fecha (15% > 12,7%) | P1 | métrica por receita + limiar 5% |
| métrica por contagem fraca | P1 | `evp_teto_receita_pct` |
| alertas com `evp==null` | P1 | `evp != null && evp < 0` |
| suprimir "Crescer" = falso negativo | P1 | D1 qualificar |
| rollup `cm=null` dispara "Crescer" | P1 | D2 `cm_incompleto` no gate |
| `COALESCE→0` upstream | P1 | Guard 4 (edge) |
| AR=estoque falso parcial (0,8%) | P2 | aceito (baixo impacto) |
| OR no rollup grosseiro | P2 | qualifica (leve) + confiança ponderada |

## Testes (vitest, TDD + falsificação)
1. Estoque ausente + cm + k → `evp` numérico **e** `evp_parcial=true`. 2. AR ausente → `evp_parcial=true`. 3. Limpa → `false`. 4. `estoque_valor=0` conhecido → `false`.
5. **Robustez:** `k<0`/`k=NaN`/`k=0` → `encargo=null`, `evp=null`; `ar_medio<0`/`estoque_valor` não-finito → indisponível (não número sujo); `cm` NaN → `null`.
6. `k=null` → `evp=null`, `evp_parcial=false`.
7. Rollup: 1 célula-teto + 1 limpa → `evp_parcial=true`, soma normal, identidade preservada; grupo com 1 célula `cm=null` → `cm_incompleto=true`.
8. `evp_teto_receita_pct` ponderado correto (inclui denominador 0 → 0).
9. Recomendações: confiável evp>0 → "Crescer" puro; teto>0 OU cm_incompleto → "Crescer" **qualificado** (motivo certo); `evp<0` conhecido → alertas disparam; `evp==null` → alertas **não** disparam.
10. Confiança: `evp_teto_receita_pct>0` → motivo; `>0.05` → média; caso Oben (5,2%) rebaixa.
11. **FALSIFICAÇÃO:** sabotar (`evp_parcial=false` sempre / remover guard de sinal / limiar de volta a 15%) → teste 1/5/10 vermelho.

Atualizar o teste "AR do cliente null → a_cs 0 + flag ar_indisponivel" (linhas 164-172): agora também `evp_parcial=true`.

## Deploy
- **Edge:** deploy **MANUAL** pós-merge pelo chat do Lovable, lendo o `index.ts` da `main` **verbatim** (merge ≠ produção; nunca SQL Editor).
- **Frontend:** nada nesta entrega (UI é entrega 2).

## Fora de escopo (follow-up)
- **UI (entrega 2):** "EVP ≤ X" + badge + tooltip; consumir `evp_parcial`/`ar_indisponivel`/`estoque_indisponivel`/`cm_incompleto`.
- **A4 (`fin-next-best-action`):** confirmar consumo do "Crescer qualificado" (não vira N candidatos espúrios).
- **`inventory_position` sem filtro de `account`** (#937: 9 SKUs oben/vendas divergentes) — ortogonal.
