# Cockpit — Expor caixa inicial da projeção (A1) vs saldo bancário atual

**Data:** 2026-05-31
**Tipo:** Consolidação/hardening (transparência cross-tela). Alvo escolhido por consult Codex (rodada 3) — **provavelmente o último** da frente; depois o maior valor passa a ser o founder preencher inputs de contabilidade.

## Problema (confirmado no código)

A engine A1 (`fin-cashflow-engine`) inicia a projeção 13s com `fin_contas_correntes.saldo_atual` e **grava `saldo_inicial` em cada semana** do snapshot (`gerarSemanas` L916 `saldo_inicial: saldoAtual`; o snapshot salva `dados: semanas` com o campo). MAS o client **descarta `saldo_inicial`** ao ler (`getProjecaoSnapshotsCockpit`, `financeiroV2Service.ts:677-682` mapeia só `inicio/total_entradas/total_saidas/saldo_final`). Resultado: o Cockpit mostra o **saldo bancário "agora"** (`totalCC`, `useFinanceiroCockpit`) **ao lado** da projeção diária, **sem dizer de qual caixa inicial a projeção partiu**. Divergência silenciosa: se o snapshot é de dias atrás, a projeção partiu de um caixa diferente do atual, e nada explica isso.

## Objetivo / critério de pronto

Expor, no Cockpit, o **caixa inicial que a projeção consolidada usou** (consolidado por coorte) ao lado do **saldo bancário atual** (`totalCC`), com o **delta** e uma nota honesta de que a diferença é esperada quando o snapshot é de dias atrás. **A UI NÃO altera nenhum número** — só expõe a base da projeção e o delta. Sem alerta vermelho por diferença explicável por snapshot diário.

## Decisões de design (Codex challenge)

- **A — `SnapshotSemana.saldo_inicial: number | null`** (nullable/defensivo): a engine sempre grava, mas snapshot malformado/legado pode faltar. **NÃO entra no filtro rígido de semana** (`getProjecaoSnapshotsCockpit`) — senão um `saldo_inicial` ausente dropparia a semana inteira (regressão na projeção). Captura: `Number.isFinite(Number(w?.saldo_inicial)) ? Number(...) : null`.
- **B — `consolidarCockpit` expõe** (na `CockpitConsolidado`): `caixa_inicial_projecao: number | null` = Σ do `saldo_inicial` **da semana de menor `inicio`** de cada empresa **presente na coorte** (Codex P2.1: NÃO `semanas[0]` literal — se a semana 0 tiver sido filtrada por campo inválido, `semanas[0]` viraria a semana 1, cujo `saldo_inicial` é o `saldo_final` projetado da 0, não a base bancária; pegar o menor `inicio` é o mais próximo da base real); `null` se **qualquer** presente não tiver semana com `saldo_inicial` válido (degradação honesta — não soma parcial enganosa). `caixa_inicial_por_empresa: { company; saldo_inicial: number|null; presente: boolean }[]`. `caixa_inicial_parcial: boolean` (algum presente sem saldo_inicial). Usa a **mesma coorte** já calculada (DRY; mesma semântica latest-wins/dataRef).
- **C — Helper puro `compararCaixaInicial({ caixaInicialProjecao: number|null; saldoAtualBanco: number; cohorteCompleta: boolean })`** → `{ disponivel: boolean; delta: number | null }`. **`disponivel = cohorteCompleta && caixaInicialProjecao != null`** — só compara quando a projeção cobre TODAS as empresas (`!cockpit.parcial`), senão é maçã-com-laranja (`caixa_inicial` da coorte parcial × `totalCC` das 3). `delta = disponivel ? round2(saldoAtualBanco − caixaInicialProjecao) : null`.
- **D — UI `Projecao13Card`:** abaixo dos badges existentes, uma linha: "Caixa inicial da projeção: R$Y · saldo bancário atual R$Z · Δ R$W" + nota (Codex P3.2, sem alerta vermelho/threshold — não é diagnóstico) "(a diferença pode refletir movimentações após o snapshot)". Quando `!disponivel`: "Caixa inicial da projeção indisponível neste snapshot" (parcial/ausente). Recebe `caixaInicialProjecao` + `saldoAtualBanco` (= `totalCC`) + `cohorteCompleta` (= `!parcial`) por props.

## Não-objetivos (Codex)
- **NÃO** reconciliar com `getFluxoCaixa` — lá `saldo_realizado` é acumulado desde zero na janela, não saldo bancário.
- **NÃO** reconciliar `fin_movimentacoes` até saldo bancário (caro/frágil; mistura extrato com posição Omie).
- **NÃO** mexer na engine, em alocação, ou margens/DRE (rótulo "DRE Regime de Caixa" é documental, fora de escopo).

## Entrega / risco
- **CLIENT-SIDE puro. Sem migration, sem edge function, sem deploy** (o snapshot já grava `saldo_inicial`; só passo a LER). Risco baixíssimo — só adiciona exibição, não muda cálculo. Tela master (Cockpit).
