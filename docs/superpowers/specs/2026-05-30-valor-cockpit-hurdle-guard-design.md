# A3 Cockpit de Valor — Guard de hurdle indisponível (não fabricar 20%)

**Data:** 2026-05-30
**Tipo:** Consolidação/hardening do módulo financeiro (mesma frente do A2 NCG-guard). Alvo escolhido por consult Codex.

## Problema (confirmado no código)

O engine A3 (`supabase/functions/fin-valor-cockpit/index.ts`, `/financeiro/valor-cockpit`) calcula **lucro econômico (EVP) por cliente/SKU** = margem de contribuição − encargo de capital de giro, onde o encargo usa um hurdle `k`. Em **L204**:

```ts
const k = keBase ? (Number(keBase.ancora||0) + ...prêmios...) : 0.20;
```

Quando `fin_valor_inputs.ke.base` está **ausente** (founder ainda não preencheu o Ke), `k = 0.20` (**20% fabricado**). Esse hurdle entra em `montarCelulasComboEVP(..., k)` (L300) → `encargo = k × (AR + estoque)` (helper L121) → `evp = cm − encargo` (L122) → **EVP fabricado** por cliente/SKU, e a UI mostra **"@ 20.0%"** (L85). Mesmo padrão "ausente vira número" que o A2 NCG-guard acabou de corrigir. (Comparação: o A4 `fin-next-best-action` faz certo — só registra hurdle se `wacc != null`.)

Variante: `keBase = {}` (objeto vazio, truthy) → `k = 0+0+0+0 = 0` → encargo=0 → EVP=margem (capital "de graça", também enganoso).

## Objetivo / critério de pronto

1. **Ke/hurdle presente e válido:** comportamento idêntico ao atual (k = soma dos componentes; EVP calculado). Happy-path inalterado.
2. **Ke/hurdle ausente ou inválido:** `k = null`; `encargo` e `evp` viram **`null`** (não fabricados) em célula/rollup/empresa; a margem de contribuição (`cm`) **continua** calculada (não depende de k); a confiança cai pra **baixa** com motivo "configure o Ke/hurdle"; a UI **não mostra "@ 20.0%"** nem EVP fabricado — mostra banner "Lucro econômico (EVP) indisponível — configure o Ke em /financeiro/valor". As **recomendações EVP-dependentes não disparam falso-sinal** (ver decisão D abaixo).

## Decisões de design (Codex challenge)

- **A — `resolverHurdleCockpit(vi) → number | null`** (helper puro, substitui o inline L204): lê `vi.ke.base`. Ausente → `null`. **Âncora obrigatória** e válida (`numOrNull` rejeita ''/NaN/Infinity); prêmios ausentes contam 0 (prêmio "nenhum" é legítimo); soma; **se não-finita ou ≤ 0 → null** (hurdle 0/negativo é degenerado = "de graça", não cobra). Espelha o rigor do A2 (`ncgFinito`).
- **B — `montarCelulasComboEVP` aceita `k: number | null`.** Com `k=null`: `encargo = null` e `evp = null` em toda célula; rollups `encargo`/`encargo_total`/`evp` = null; `cm` segue. Tipos `CelulaEVP.encargo`/`Rollup*.encargo`/`encargo_total`/`empresa.encargo` → `number | null`. **Nullabilidade do encargo é UNIFORME** (`encargo = k==null ? null : k*(a_cs+i_cs)`; quando k é número, `a_cs`/`i_cs` são sempre números → encargo nunca null). **Acumuladores null-aware (Codex P1.4):** trocar `acc.encargoTotal += cel.encargo` / `encTotalEmp += cel.encargo` (L133/L152) por acúmulo guardado (`if (cel.encargo != null) { ...; encargoTotalNull=false }`) → `encargo_total = encargoTotalNull ? null : soma` (idem `encargo` e `empresa.encargo`). NUNCA `null + x = número`.
- **C — `scoreConfiancaCockpit` ganha `hurdle_indisponivel: boolean`** → `rebaixar(1, 'Sem Ke/hurdle configurado — lucro econômico (EVP) indisponível; configure em /financeiro/valor.')` (baixa).
- **D — `recomendarAcaoComercial` ganha `hurdle_indisponivel: boolean`** (Codex confirmou). Introduz `evpConhecivel = !hurdle_indisponivel`. Regras:
  - **"Subir preço"** (cmPct < min): inalterada (margem-pura, independe do hurdle).
  - **"Cortar desconto"** (descontoPct > max): dispara com `(!evpConhecivel || evp==null || evp<=0)` — quando hurdle ausente, o desconto excessivo É fato (impacto_rs = recuperável, não precisa de evp), mas o **motivo é hurdle-aware** ("…lucro econômico indisponível — configure o hurdle p/ confirmar"), sem prometer EVP (nota neutra que o Codex sugeriu).
  - **"Encurtar prazo" / "Despriorizar"**: gated por `evpConhecivel &&` (não disparar por `evp==null`-de-hurdle; inertes hoje pois prazo/estoque=0 — gate por correção).
  - **"Crescer"**: requer `evp != null && evp > 0` → naturalmente não dispara com evp null (sem mudança).
  - **Nota**: quando `hurdle_indisponivel`, adiciona `{acao:'Configurar hurdle', motivo:'Sem Ke configurado — EVP e recomendações de valor indisponíveis. Configure em /financeiro/valor.', impacto_rs:null}`.
  - Sem `hurdle_indisponivel` (default), comportamento **idêntico ao atual** — incluindo `evp==null` por `cm` ausente (segue conservador; Codex: não mudar essa semântica).
- **E — Contrato `ValorCockpitResult`:** `k: number | null`; `encargo` (célula/rollup/empresa) → `number | null`; **novo** `hurdle_indisponivel: boolean`.
- **F — UI `FinanceiroValorCockpit.tsx`:** L85 mostra "@ X%" só quando `data.k != null`; quando null, banner de hurdle ausente (sem `data.k*100`). `brl(encargo/evp)` já renderiza "—"; sort por evp já usa `?? Infinity`.

## ⚠️ Questão de escopo pro Codex: Ke × WACC

Hoje o A3 cobra capital ao **Ke** (custo de equity = âncora+prêmios, da `fin_valor_inputs.ke.base`). O **A2** usa **WACC** (`waccHurdle` = pondera Ke e Kd por dívida/PL) como hurdle. Então o mesmo "custo de capital" aparece como **dois números** entre A2 e A3 — uma divergência cross-tela. **Duas opções:**
- **(i) Mínimo (honestidade só):** mantém Ke; só conserta a fabricação (k=null quando ausente). Menor superfície. A divergência Ke×WACC fica documentada como follow-up.
- **(ii) Reconciliação plena:** A3 passa a usar o **WACC** (lê kd/divida/equity da mesma `fin_valor_inputs` e roda o `waccHurdle` igual ao A2) → `A3.k == A2.reportado.wacc`. Mais on-theme ("números batem"), mas maior superfície (degrada a null também quando falta Kd/dívida/PL, como o A2). 

**Pergunta ao Codex:** (i) ou (ii)? Se (ii), vale a superfície extra agora ou é over-reach? Considere que o founder ainda não preencheu os inputs (hoje os dois usam fallback), risco no money-path, e o objetivo declarado "números batem entre telas".

> **DECISÃO (Codex):** **(i) agora — manter A3 no Ke; WACC fica como follow-up explícito.** Misturar bugfix money-path com mudança de metodologia (Ke→WACC) é risco: o `waccHurdle` do A2 exige Ke+equity+dívida (+Kd se houver dívida) e qualquer falta vira WACC null → ampliaria a indisponibilidade do A3 mesmo com Ke presente. WACC é teoricamente melhor p/ capital de giro (financiado por dívida+PL) e bate melhor com "números entre telas" — mas vira **follow-up** (`docs/.../valor-cockpit-wacc-*`) quando o founder tiver preenchido os inputs. Este patch só mata a fabricação.

## Entrega / risco
- **Sem migration.** **Com deploy** do `fin-valor-cockpit` via chat do Lovable (EVP calculado no edge). **Gate gestor comercial + master** → blast radius baixo. A mudança só torna EVP `null` em MAIS casos (hurdle ausente) — estritamente mais honesto.

## Não-objetivos
- Backfill da baixa do Omie (adiado). Mudar a metodologia de AR/estoque/alocação por cliente. Computar prazo/estoque por cliente (deferido). Tocar A2/A4/Cockpit.
