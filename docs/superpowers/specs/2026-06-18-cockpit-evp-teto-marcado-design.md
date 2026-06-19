# Cockpit de Valor (Oben) — EVP-teto marcado: degradação honesta do capital ausente

- **Data:** 2026-06-18
- **Status:** design aprovado pelo founder; Codex adversarial pendente
- **Escopo desta entrega:** MOTOR (helper TS puro + edge Deno verbatim + contrato + recomendações + confiança + testes vitest). A camada de UI ("EVP ≤ X" + badge "estoque/AR não medido" + tooltip) é a **entrega seguinte** (founder: "1 depois 2"), naturalmente acoplada ao dia em que o Ke for ligado.
- **Arquivos:** `src/lib/financeiro/valor-cockpit-helpers.ts` (+ `__tests__/valor-cockpit-helpers.test.ts`), `supabase/functions/fin-valor-cockpit/index.ts` (espelho verbatim).

## Problema (achado Codex, 2026-06-18)

`montarCelulasComboEVP` trata componente de capital **ausente como R$0**:

```ts
const a_cs = arC != null && rc > 0 ? arC * (c.receita_liquida / rc) : 0;   // AR ausente → 0
const i_cs = estS != null && qs > 0 ? estS * (c.quantidade / qs) : 0;       // estoque ausente → 0
const encargo = input.k == null ? null : input.k * (a_cs + i_cs);
const evp = cm == null || encargo == null ? null : cm - encargo;
```

Quando o AR do cliente **ou** o estoque do SKU está ausente, a perna respectiva entra como 0 → **encargo subestimado → EVP superestimado** (o combo parece gerar mais valor econômico do que gera). Viola o princípio money-path #2 ("ausente ≠ zero — nunca fabricar número"). A mitigação atual (flags `ar_indisponivel`/`estoque_indisponivel` por célula + `scoreConfiancaCockpit`) **não corrige o número** e só rebaixa a confiança acima de 30% de ausência — abaixo disso fica "verde" com EVP otimista.

## Medição (psql-ro read-only, TTM Oben, 2026-06-18)

- **Dano HOJE = R$0.** `fin_valor_inputs.ke.base` da Oben está vazio → `k=null` → `encargo=null` → **EVP é `null` em 100% das células**. O bug é **LATENTE**: só ganha dentes quando o founder configurar o Ke em `/financeiro/valor`. A medição abaixo é da **exposição estrutural** (o que nasce inflado quando o hurdle entrar).
- **Recorte fiel:** a query SQL reproduz o recorte da edge (Oben via `omie_products.account`, TTM 365d, pedidos faturáveis) e bate ao real — `receita_total = R$5.059.623` = `empresa.receita` do #939.
- **Exposição** (3.783 células = combos cliente×SKU):
  - **19,9%** têm ≥1 perna de capital ausente → EVP seria teto. Concentração: **estoque 19,2%** vs **AR 0,8%**.
  - Das **3.471 com `cm`** (únicas com EVP quando o Ke ligar): **442 expostas (12,7%)**, valendo **~R$250k / 4,95% da receita**.
  - **206 de 558 SKUs (37%) sem linha em `inventory_position`** — e é **binário**: 0 casos de "saldo sem cmc". Ou completo, ou ausente.
  - **Ordem de grandeza em R$:** encargo de estoque faltante ≈ `k × Σ(estoque_valor ausente)`. Imputando o `estoque_valor` mediano dos presentes (R$379) aos 206 ausentes → Σ ≈ R$78k; pela média (R$927) → ~R$191k. Com Ke hipotético 0,20 → **~R$16k–38k de encargo não cobrado** → EVP-empresa superestimado nessa ordem. Pequeno no agregado-empresa; **relevante por-SKU** (206 SKUs com EVP sistematicamente otimista alimentando "crescer/proteger").
  - **Ponto cego confirmado:** `estoque_ausente_pct = 19,2% < 30%` → `scoreConfiancaCockpit` **não rebaixa** hoje.
- **Assimetria das pernas:** AR ausente (0,8%) = cliente sem títulos AR → plausivelmente **compra à vista** (AR real ≈ 0). Estoque ausente (19,2%) = SKU sem posição → para distribuidora, mais provavelmente **não-syncado / sob encomenda** do que estoque real zero.

## Decisão (founder, 2026-06-18)

**EVP-teto marcado** (opção c): mantém o número, mas declara que é **teto** (otimista) quando o capital está incompleto. Sub-decisões:

- **AR tratado IGUAL ao estoque.** Qualquer perna ausente marca teto. A defesa "AR à vista = 0 real" é uma aposta não-verificável; "ausente≠zero" estrito vale para as duas pernas e uma regra só tem menos superfície de erro. As flags `ar_indisponivel`/`estoque_indisponivel` por célula já distinguem a perna para a UI futura.
- **Limiar de rebaixamento da confiança = 15%.**

## Design (motor)

### Princípio
Capital incompleto ⟹ `encargo` é um **piso** (falta somar a perna ausente) ⟹ `evp = cm − encargo` é um **teto** (upper bound). O número segue exibido, declarando-se teto.

### Contrato
`CelulaEVP` ganha **`evp_parcial: boolean`**, derivado:

```
evp_parcial = evp != null && (ar_indisponivel || estoque_indisponivel)
```

- O `evp` **numérico não muda** → a identidade contábil `Σ porCliente.evp = Σ porSKU.evp = empresa.evp` (travada em teste) **permanece intacta**.
- `evp_parcial` só pode ser `true` quando `evp != null` (logo `cm != null` e `encargo != null`/`k != null`). Sem hurdle (hoje) → `evp` null → `evp_parcial` sempre `false` (não há teto a marcar).
- **Zero-conhecido ≠ ausente:** `estoque_valor = 0` com SKU presente (saldo 0), ou cliente com `ar_medio = 0` conhecido, **não** marca parcial — as flags testam `== null`/denominador `<= 0`, nunca `== 0`.

`RollupCliente`, `RollupSKU` e `empresa` ganham **`evp_parcial: boolean`** = OR das células contribuintes ao EVP do grupo (`evp != null && evp_parcial`). Uma célula-teto contamina o agregado.

O retorno (nível topo, consumido pela edge) expõe **`evp_teto_pct: number`** = `(#células com evp!=null && evp_parcial) / (#células com evp!=null)`; `0` quando o denominador é 0.

### Recomendações — `recomendarAcaoComercial` (a assimetria)
Novo input opcional **`evp_parcial?: boolean`** (vem do rollup-cliente).

- **Sinal POSITIVO** ("Crescer / proteger", hoje `r.length===0 && evp!=null && evp>0`): passa a exigir **`&& !evp_parcial`**. EVP-teto>0 não garante real>0 → **suprime** a recomendação (sem ação inventada — não cria item que vaze para o A4/`fin-next-best-action`, igual ao tratamento do hurdle ausente).
- **Sinal NEGATIVO** ("Encurtar prazo", "Despriorizar / liquidar"): **inalterado**. `teto < 0 ⟹ real ≤ teto < 0` → robusto; o teto negativo reforça o alerta.
- **"Cortar desconto"** (hoje dispara com `!evpConhecivel || evp==null || evp<=0`): EVP-teto>0-parcial deixa de blindar contra o corte → condição vira `(!evpConhecivel || evp==null || evp<=0 || evp_parcial)`.
- **"Subir preço"** (margem%): ortogonal ao capital, **intacta**.

### Confiança — `scoreConfiancaCockpit`
Novo input **`evp_teto_pct: number`**:

- `> 0` → **sempre** adiciona motivo: "X% do EVP é teto — encargo de capital (estoque/AR) não medido em parte da carteira."
- `> 0.15` → **rebaixa para média** (nível 2).
- Limiares existentes de `ar_indisponivel_pct`/`estoque_ausente_pct` (sobre todas as células — sinal de qualidade-de-dado geral) **inalterados**.

### Espelhamento
Tudo verbatim TS↔edge. A edge calcula `evp_teto_pct` no orquestrador a partir de `res.celulas` e o passa tanto para `scoreConfiancaCockpit` quanto para o payload de resposta; passa `evp_parcial` do rollup-cliente para `recomendarAcaoComercial`.

## Testes (vitest, TDD + falsificação)
1. Estoque ausente + cm + k → `evp` numérico (teto) **e** `evp_parcial=true`.
2. AR ausente + cm + k → `evp_parcial=true`.
3. Célula limpa (AR+estoque ok) → `evp_parcial=false`.
4. `estoque_valor=0` **conhecido** (presente) → `evp_parcial=false` (zero-conhecido ≠ ausente).
5. `k=null` → `evp=null`, `evp_parcial=false` (sem teto a marcar).
6. Rollup: cliente com 1 célula-teto + 1 limpa → `rollup.evp_parcial=true`; `evp` soma normal; identidade preservada.
7. `empresa.evp_parcial` e `evp_teto_pct` corretos (inclui caso denominador 0 → 0).
8. Recomendações: EVP-teto>0 parcial → **não** "Crescer / proteger"; EVP-teto<0 parcial → "Encurtar prazo"/"Despriorizar" disparam; desconto>max + teto>0-parcial → "Cortar desconto" aparece.
9. Confiança: `evp_teto_pct>0` → motivo presente; `>0.15` → rebaixa para média; `≤0.15` → só motivo.
10. **FALSIFICAÇÃO:** sabotar (forçar `evp_parcial=false` sempre, ou tratar AR como conhecido) → o teste 1/2 fica vermelho. Confirma que os asserts têm dente.

Atualizar o teste existente "AR do cliente null → a_cs 0 + flag ar_indisponivel" (linhas 164-172): `a_cs` segue 0, mas agora `evp_parcial=true` (era implicitamente não-testado).

## Codex (money-path)
`/codex challenge` reasoning `xhigh` na metodologia/design: validar a assimetria teto+/teto−, a propagação do `evp_parcial` pelos rollups, o fechamento do ponto cego dos 30%, e a decisão AR=estoque. Caminho B (auto-challenge + `REVISÃO INDEPENDENTE PENDENTE`) se a cota esgotar.

## Deploy
- **Edge:** deploy **MANUAL** pós-merge pelo chat do Lovable, lendo o `index.ts` da `main` **verbatim** (merge ≠ produção; nunca colar `.ts` no SQL Editor).
- **Frontend:** nada nesta entrega (sem mudança de UI). Publish só na entrega 2 (UI).

## Fora de escopo (follow-up)
- **UI (entrega 2):** exibir `evp` como "≤ X" + badge "estoque/AR não medido" + tooltip; consumir `evp_parcial` + `ar_indisponivel`/`estoque_indisponivel` por célula.
- **A4 (`fin-next-best-action`):** confirmar que a supressão do "Crescer / proteger" parcial não abre lacuna indesejada no mapeamento de candidatos.
- **`inventory_position` sem filtro de `account`** (#937 follow-up: 9 SKUs oben/vendas divergentes) — ortogonal a esta entrega.
