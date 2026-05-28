# Valor A2 — Guard de NCG indisponível (capital de giro ausente ≠ R$0)

**Data:** 2026-05-28
**Tipo:** Consolidação/hardening do módulo financeiro (não é feature nova).
**Frente:** "provar que os números batem entre telas — ou degradar honestamente". Alvo escolhido por consult Codex após a Consolidação do Cockpit.

## Problema (confirmado no código)

O engine de Valor A2 (`supabase/functions/fin-valor-engine/index.ts`) usa o **NCG da engine A1** como `capital_giro` (lê `fin_projecao_snapshots.ncg`, igual ao Cockpit). Mas quando **não há snapshot de NCG válido** (todos `ncg == null` ou sem snapshot):

- L250: `capital_giro = latestNcg ? Number(latestNcg.ncg) : 0` → **vira 0**.
- L297: `capitalInvestido({ capital_giro: 0, ativo_fixo, ajustes })` → se `ativo_fixo` foi informado, `capital_investido = ativo_fixo` (**subestimado**, sem o giro).
- L315: `roic = nopat / capital_investido` → como `capital_investido > 0`, **NÃO retorna null** → **ROIC superestimado** (capital menor que o real).
- `capRep.parcial` só fica `true` por **ativo fixo** ausente (`valor-helpers.ts:82`) — **não** pela falta de giro → `scoreConfiancaValor` **não rebaixa** a confiança pela ausência de NCG.
- L340: só empilha um texto no `motivos` ("capital de giro assumido 0 (ROIC pode estar superestimado)") — mas o número **já nasceu errado**.

Isso **viola "ausente ≠ zero"** e **diverge do Cockpit**, que já trata NCG ausente como parcial (`useFinanceiroCockpit.ts` + `COCKPIT_VAZIO.ncg_parcial=true`) e usa `cockpit.ncg_total` da engine A1.

> Nota: NCG **negativo** (folga) é valor REAL, não ausência. O guard só dispara quando **não há nenhum** `ncg` não-nulo. `capital_investido ≤ 0` por folga grande continua retornando `roic=null` legitimamente (motivo diferente de "giro indisponível").

## Objetivo / critério de pronto

1. **Empresa com snapshot válido:** `Valor A2.reportado.capital_giro` == último `fin_projecao_snapshots.ncg` não-nulo da empresa — **o mesmo valor** que alimenta o Cockpit. Comportamento idêntico ao atual no happy-path (zero regressão).
2. **Empresa sem NCG válido:** `capital_giro` e `capital_investido` viram **`null` (indisponível)**, `roic`/`spread`/`eva` viram **`null`**, a **confiança vira `baixa`**, e a UI diz **"sem snapshot de NCG"**, nunca "R$0" nem "capital parcial (sem ativo fixo)". Nenhum ROIC/EVA é fabricado.

## Mudanças (superfície fechada no A2)

### Helper puro `src/lib/financeiro/valor-helpers.ts` (espelhado verbatim no Deno)
- **Novo** `resolverCapitalGiro(snaps)`: encapsula "último snapshot com `ncg` não-nulo" → `{ capital_giro: number | null; snapshot_at: string | null; disponivel: boolean }`. (Hoje inline no edge L245-251.) Usa `s.ncg != null` (truthiness NÃO — `0` e negativo são valores REAIS; só `null`/sem snapshot falha).
- **Novo** `frescorGiro(snapshot_at, hojeMs, limiarStaleDias = 45)` → `{ dias: number | null; stale: boolean }` (**Codex P1.3**): puro/determinístico (`hojeMs` injetado p/ testar). `dias = round((hojeMs − Date.parse(snapshot_at))/86400000)`; `stale = dias != null && dias > limiar`. O cron de snapshot é diário → um NCG com 45+ dias indica pipeline quebrado / NCG potencialmente desatualizado. **Stale NÃO vira indisponível** (não esconde um NCG real) — só rebaixa a confiança e fica visível na UI.
- **Novo** `acharCapitalGiroAnterior(snaps, refSnapshotAt, opts?)`: o lookup ~365d antes com tolerância ≤60d (hoje inline L252-263) → `number | null`. **Só é chamado quando o giro atual está disponível** (sem ponto atual, incremental não existe — Codex resposta 3).
- **`capitalInvestido`**: `capital_giro: number | null`. Quando `null` → `capital_investido: null`, `capital_giro: null`, **novo** `giro_indisponivel: true`, `parcial: true`, motivo "Sem snapshot de NCG — capital de giro indisponível; ROIC/EVA não calculáveis." Tipo de retorno: `capital_investido: number | null`, `capital_giro: number | null`, `giro_indisponivel: boolean`.
- **`normalizarComingling`**: `capital_reportado: number | null` → `capital_normalizado: number | null`. **Guard explícito anti-coerção (Codex P1.1):** `capital_normalizado = capital_reportado == null ? null : capital_reportado + ajuste_intercompany_capital` (nunca `null + (−X)` → 0). A normalização de **EBIT** (pró-labore/aluguel) é **inalterada** (independe do capital) — EBIT/NOPAT normalizado seguem calculáveis e exibidos; só `capital_normalizado`/ROIC/EVA normalizados ficam null.
- **`scoreConfiancaValor`**: dois novos inputs (**Codex P1.2**): `giro_indisponivel: boolean` → `rebaixar(1, …)` (**baixa** — métrica central de capital ausente, mais severo); `giro_stale: boolean` → `rebaixar(2, 'NCG de DD/MM/YYYY (Nd atrás) — capital de giro pode estar desatualizado.')` (**media**). O `roic_null` por capital ≤0 **conhecido** segue `media` (não confundir com indisponível).
- `roic`/`spread`/`eva`/`roicIncremental`: **já são null-safe** (`capital_investido: number | null`) — sem mudança.

### Edge `supabase/functions/fin-valor-engine/index.ts`
- Substitui L245-263 pelas chamadas dos helpers; passa `capital_giro: number | null` ao `capitalInvestido`; `normalizarComingling` null-safe; passa `giro_indisponivel` ao `scoreConfiancaValor`; remove o motivo enterrado L340 (agora estruturado). **Espelho verbatim** do helper.

### Contrato `src/services/financeiroService.ts`
- `ValorEmpresaResult.reportado.capital_investido: number | null`, `.capital_giro: number | null`, **novos** `.giro_indisponivel: boolean`, `.giro_snapshot_at: string | null`, `.giro_dias: number | null`; `normalizado.capital_investido: number | null`.

### UI `src/pages/FinanceiroValor.tsx`
- `brl()`/`pct()` **já** renderizam `—` para null (sem mudança no número).
- **Mensagem giro-específica:** quando `reportado.giro_indisponivel`, exibir "Sem snapshot de NCG — capital de giro indisponível (rode a projeção de caixa). ROIC/EVA não calculáveis." e **gate** o "* capital parcial (sem ativo fixo)" (L48) para `capital_parcial && !giro_indisponivel` (não mostrar o motivo errado quando o parcial vem do NCG — **Codex resposta 7**).
- **Frescor visível:** quando há giro, exibir "NCG de DD/MM/YYYY" e, se `giro_dias != null && giro_dias > 1`, "(Nd atrás)" com aviso quando stale — espelha o padrão do Cockpit (`Projecao13Card`).

## Matriz de testes (vitest, Codex resposta 7)
`resolverCapitalGiro`: (a) snapshots com ncg negativo → retorna o negativo, disponível; (b) ncg **zero** real → retorna 0, disponível (truthiness NÃO); (c) todos `ncg==null` → `{capital_giro:null, disponivel:false}`; (d) sem snapshots → indisponível; (e) mistura → pega o mais recente com ncg não-nulo + `snapshot_at`.
`frescorGiro`: fresco (<limiar) → `stale:false`; velho (>limiar) → `stale:true` + `dias`; `snapshot_at` null → `{dias:null, stale:false}`.
`capitalInvestido`: giro null → `capital_investido:null`, `giro_indisponivel:true`, `parcial:true`; giro 0 real + ativo fixo → capital = ativo fixo (válido, `giro_indisponivel:false`); giro negativo → capital pode ser ≤0 → ROIC null por capital (motivo distinto).
`normalizarComingling`: `capital_reportado:null` + `intercompany_giro:-X` → `capital_normalizado:null` (NÃO `−X`); EBIT normalizado segue calculado.
`scoreConfiancaValor`: `giro_indisponivel:true` → `baixa`; `giro_stale:true` (sem indisponível) → `media`; `roic_null` por capital≤0 → `media`.

## Entrega / risco
- **Sem migration.** **Com deploy** do `fin-valor-engine` via chat do Lovable (ROIC/EVA são calculados no edge — client-side só avisaria depois do número nascer errado, como o Codex apontou).
- **Tela master-only** → blast radius baixo. A mudança só torna ROIC/EVA `null` em MAIS casos (giro ausente) — estritamente mais honesto, nunca superestima. Happy-path (snapshot válido) inalterado.

## Não-objetivos
- Backfill da data de baixa do Omie (adiado, money-path sensível).
- Mudar a definição de NCG (continua ACO−PCO da engine A1 — só o tratamento de ausência muda).
- Cobertura cross-CNPJ ou margens Cockpit×Orçamento (descartados pelo Codex: menor valor/maior risco agora).
