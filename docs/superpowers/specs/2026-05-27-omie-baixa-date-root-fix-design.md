# Omie — Data de Baixa Real (root-fix da família de números errados do financeiro)

> Spec aprovado em 2026-05-27. Origem: auditoria "Max" do financeiro (achou que `data_recebimento`/`data_pagamento` estão sempre NULL → cascata em 5 engines). Decisão do founder: ir no fix-raiz. Validação adversarial via codex (consult 2026-05-27).

## Problema

`fin_contas_receber.data_recebimento` e `fin_contas_pagar.data_pagamento` (a **data de baixa / liquidação real**) estão **SEMPRE NULL** em produção (39k+ títulos liquidados, 100% sem baixa). Provado com o payload cru de um título `RECEBIDO` do Omie: o endpoint LIST (`financas/contareceber/ListarContasReceber`) **não retorna a data de baixa** — só emissão/previsão/registro/vencimento. O sync mapeia `data_recebimento: parseOmieDate(t.data_recebimento || t.dDtPagamento)` → ambos `undefined` → NULL. Não é bug de mapeamento; o dado não vem nessa rota.

### Cascata — 5 engines lêem a baixa NULL

| Engine | O que quebra | Tipo de número errado |
|---|---|---|
| PMR/PMP/Ciclo | — | ✅ já corrigido (degradação honesta, #381) |
| `getFluxoCaixa` (realizado) | `entradas/saidas_realizadas` só somam quando há baixa → **sempre 0**; saldo realizado sempre 0 | errado silencioso (mostrado em `FluxoCaixaTab`) |
| `aging-helpers` → projeção 13 sem | `liquidado = !!data_recebimento` → sempre `false` → todo título tratado como aberto; `taxa_recebimento = pago/exposicao = 0` em toda faixa confiável | confiantemente errado (0% de recebimento) |
| `valor-cockpit-helpers` | `fimOpen = data_recebimento ? ... : ttm_fim` e `valor = data_recebimento ? valor_documento : saldo` → todo título conta como aberto até o fim da janela | saldo médio em aberto inflado |
| `calcularDRE` (regime caixa) | cai sempre no fallback de vencimento | ⚪ já marca "estimado" (honesto) |

## Causa-raiz (provada empiricamente)

1. O LIST não manda baixa. (raw título acima)
2. A baixa real **existe** no endpoint de movimentos `financas/mf/ListarMovimentos` — o sync já resolve `dDtPagamento` (a data de pagamento real) em `fin_movimentacoes.data_movimento`, com `omie_codigo_lancamento = nCodTitulo` (joinável ao título).
3. **MAS** o sync chama `ListarMovimentos` **sem filtro de data** → o Omie devolve só a janela recente. Medido em prod: todos os movimentos das 3 empresas começam em `2025-12-29` (cursor `next_page = NULL` = sync se considera completo). Por isso a cobertura de baixa derivável é só **17-23%** (só os liquidados de dez/2025 pra cá).
4. **A doc do Omie confirma**: `mfListarRequest` aceita filtros de data — `dDtPagtoDe`/`dDtPagtoAte` (data de pagamento), além de emissão/vencimento/registro/inclusão/alteração. Passar o filtro destrava o histórico em massa (paginação), **sem N+1**.

## Abordagem escolhida

**Backfill de movimentos com filtro de data (bulk) + derivação limpa da baixa numa tabela lateral + conserto dos 5 consumidores.** Fallback pro endpoint de detalhe (`ConsultarContaReceber` por título, N+1) só se a validação empírica mostrar que o filtro de data não traz o histórico.

Princípios (validados com codex):
- **Nunca `UPDATE` na coluna base** `data_recebimento`/`data_pagamento` (o sync re-sobrescreveria pra NULL; mistura dado Omie original com inferência; contamina). A baixa derivada vive numa **tabela lateral com provenance + confiança**.
- **`MAX(data_movimento)` não basta** — pagamento parcial e estorno mentem. Derivar: data de quitação = `MAX` das baixas reais; PMR/PMP usam **prazo ponderado por valor** da baixa.
- **Filtrar só baixas reais**: movimento com `dDtPagamento` presente, `tipo` casando com o título (CR↔E, CP↔S), keyed por `(company, omie_codigo_lancamento)`.
- **Degradação honesta** onde o dado não existir (título liquidado antes da janela que o Omie tiver) — nunca fabricar.

### Fases (cada uma entrega valor sozinha)

**Fase 0 — Validação empírica (gate, pequena).**
Adicionar filtro de data ao `syncMovimentacoes` (`dDtPagtoDe`/`dDtPagtoAte`, ou os nomes corretos confirmados no `debug_raw`). Redeploy. Rodar 1 sync histórico da oben. Conferir: `min(data_movimento)` salta pra trás (anos), cobertura de baixa derivável sobe muito. **Se o filtro for silenciosamente ignorado (mais_antigo não muda) → o param está errado ou o Omie só tem janela curta → fallback pro detalhe N+1.** Inspecionar o `first_record_sample` de um movimento (confirmar `dDtPagamento` e se previsões poluem).

**Fase 1 — `getFluxoCaixa` realizado das movimentações (independente, ganho imediato).**
Reescrever as linhas realizadas: `entradas_realizadas` = Σ `fin_movimentacoes.valor` por dia onde `tipo='E'` e `omie_codigo_lancamento IS NOT NULL` (exclui transferências internas/tarifas sem título); `saidas_realizadas` = idem `tipo='S'`. **Não depende da derivação por título** — é caixa real por dia. Conserta o realizado pra janela sincronizada (que, pós-Fase 0, será o histórico). Mantém o previsto como está (títulos abertos por vencimento). Teste do helper de agregação.

**Fase 2 — `liquidado` por status, não pela data null (independente, conserto real).**
- `aging-helpers`: `liquidado = ['RECEBIDO','LIQUIDADO','PAGO'].includes(status_titulo)` (sinal confiável que já temos). Conserta `taxa_recebimento` (% que de fato liquida por faixa). O **timing** (lag/faixa do recebimento) ainda precisa da data → usa a baixa derivada onde houver (pós-Fase 3), senão degrada essa componente (sinaliza confiança).
- `valor-cockpit-helpers`: usar `status` pra aberto vs liquidado; saldo médio em aberto para de inflar.

**Fase 3 — Derivação da baixa (tabela lateral) + ligação dos consumidores de timing.**
- Backfill histórico de movimentos por janelas de data + cursor (mesma mecânica do cursor CR/CP, pra **não estourar o time-budget** que acabamos de blindar). Tabela `fin_sync_cursor` ganha resource/janela.
- Tabela lateral `fin_titulo_baixas(company, tipo ['CR'|'CP'], omie_codigo_lancamento, data_baixa_final date, prazo_ponderado_dias numeric, valor_baixado numeric, n_movimentos int, source text, confianca text, updated_at)`. RLS staff-read/master-write/service-all. Recalculável (idempotente) a partir de `fin_movimentacoes`.
- Ligar: `aging` (timing real onde houver), `DRE-caixa` (usar baixa derivada onde houver; senão fallback "estimado" como hoje), e — opcional — PMR/PMP recente da baixa derivada **com flag de confiança** (senão mantém degradação).

## Não-objetivos
- Reescrever o sync de CR/CP (a baixa não vem do LIST de qualquer forma).
- `UPDATE` destrutivo nas colunas base.
- Garantir baixa pra títulos liquidados antes do que o Omie expõe — degrada honesto.
- Tratar estorno como evento de fluxo no `getFluxoCaixa` v1 (sinaliza; refino depois).

## Riscos & mitigação
- **Time-budget do sync** (backfill histórico de movimentos pode ser muitas páginas) → cursor por janela de data, igual CR/CP; rodar em ciclos `*/10`.
- **Param de filtro de data errado** (Omie ignora em silêncio) → a Fase 0 é exatamente o gate que pega isso (compara `mais_antigo` antes/depois).
- **`dDtPagamento` ausente em movimentos de previsão** → filtrar só os com pagamento real; confirmar no `debug_raw`.
- **Transferências internas inflando o fluxo bruto** → filtro `omie_codigo_lancamento IS NOT NULL` na Fase 1.
- **Lovable**: toda migration manual (skill `lovable-db-operator`); todo deploy de edge manual via chat. Cada fase com bloco SQL + validação + nota de PR.

## Validação
- Fase 0: `min(data_movimento)` por empresa salta pra trás; cobertura de baixa derivável (query da auditoria) sobe de ~20% pra alto.
- Fase 1: `FluxoCaixaTab` mostra realizado > 0 coerente; teste do helper de agregação E/S por dia.
- Fase 2: testes vitest do aging (`taxa_recebimento` deixa de ser 0; settled fora do projetado futuro) e do valor-cockpit (saldo médio deixa de inflar).
- Fase 3: testes do helper de derivação (parcial → ponderado; estorno → não vira baixa; só `dDtPagamento`); identidade de cobertura; PMR derivado recente plausível (CR ~32d batia na amostra).

---

## Atualização 2026-05-27 (pós-codex + Fase 1 entregue)

### O que JÁ foi a produção
- **Fase 1 — fluxo realizado das movimentações (PR #396, mergeado):** `getFluxoCaixa` parou de ler a baixa-NULL e passa a somar `fin_movimentacoes` por dia (E/S, exclui transferência sem título), com paginação anti-truncamento. Helper testável `src/lib/financeiro/fluxo-realizado-helpers.ts`. **Caveat:** só melhora de verdade pra janela recente até o backfill da Fase 0 rodar (hoje só ~5 meses de movimentos).

### Fato empírico medido (decisivo)
- Todos os movimentos das 3 empresas começam em **2025-12-29** (cursor `movimentacoes` = NULL/completo). Causa: o sync chama `ListarMovimentos` **sem filtro de data** e o default no código é "últimos 3 meses". Cobertura de baixa derivável (all-history) = **17% CR / 23% CP** na oben; CR derivado 97% são (PMR ~32d), CP 38% anômalo (ruído de fallback/parcial).
- **Confirmado em código real (várias integrações):** `financas/mf/ListarMovimentos` aceita `dDtPagtoDe`/`dDtPagtoAte` (DD/MM/YYYY). Request real: `{ nPagina, nRegPorPagina, dDtPagtoDe, dDtPagtoAte }`.

### Decisão de sequenciamento (founder delegou; eu+codex)
1. **Derivação na janela recente PRIMEIRO** (Fase 3 sobre os ~5 meses que já temos — cobertura alta lá, e é o que importa pro view atual/futuro do CFO). Honest-degrade pra títulos antigos. A `fin_titulo_baixas` é recomputável idempotente → **derivação-agora é forward-compatible com backfill-depois** (re-rodar só preenche mais títulos, sem rework).
2. **Backfill histórico (Fase 0) ADIADO** pra esforço próprio, com cabeça fresca no money-path.

### Desenho do backfill (Fase 0) — escolhido pelo codex: **opção A (janela no cursor)**
Codex rejeitou o "deploy amplo→reverter" (B) como atalho frágil em money-path recém-blindado. Mecanismo correto:
- `fin_sync_cursor` ganha `filtro_data_de date`, `filtro_data_ate date`, `mode text` (`incremental`|`backfill`). Colunas **neutras pra CR/CP** (cujo endpoint não aceita filtro de data → page-number já é consistente; só movimentos precisam disso).
- Regra: se há cursor `next_page IS NOT NULL`, a função **ignora o body/default e usa a janela gravada no cursor** (a continuação `*/10` passa só `{action, company}` → lê a janela do cursor). Sem cursor pendente: body com filtro → inicia backfill e grava a janela; sem filtro → default incremental. Ao completar (página 1), limpa janela+mode. Kickoff incremental **nunca** sobrescreve backfill pendente.
- **`filtro_data_ate` CONGELADO no kickoff** (ex: ontem) — senão `total_de_paginas` muda a cada resume e o cursor aponta pra outro universo.
- **Guard de concorrência** (codex, P1): manual+cron ou kickoff+continuação podem ler o mesmo cursor → race que pula/retrocede página. Checar `running` recente em `fin_sync_log` p/ `company/resource` (ou advisory lock) antes de processar.
- **Medir 1 empresa / 1 ano antes** (páginas/min, erros). Backfill por janelas menores (ano a ano) reduz risco de paginação instável.
- Persistir datas como `date`; formatar DD/MM/YYYY só na chamada.
- Depois do backfill, rodar 1 passada incremental pra cobrir o delta entre `filtro_data_ate` congelado e hoje.

### Dependência aberta pra retomar
- **`debug_raw` de um movimento** (`{action:'debug_raw', entidade:'movimentacoes', company:'oben'}` no chat do Lovable — travou em 403; precisa preview logado). Define o filtro limpo da derivação: confirmar `dDtPagamento` no payload cru e se previsões (sem pagamento) poluem — é o que explica os 38% de CP anômalos.
