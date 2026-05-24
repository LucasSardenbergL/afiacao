# Financeiro A4 — Próxima Melhor Ação (Next-Best-Action) — Design

> Frente final do programa "Estado da Arte do Financeiro" (A1 caixa 13s · A2 retorno/ROIC · A3 cockpit de valor). A4 **compõe** as três numa **fila priorizada de ações concretas** que o dono deve aprovar ou recusar, sob a restrição de caixa de hoje. Design re-escopado e validado por consult Codex.

## 1. Re-escopagem (decisão Codex) — NÃO é um "alocador de capital"

O Codex (que tinha sequenciado "alocador depois do cockpit") concluiu que, pra 3 PMEs de decisões lumpy e owner-managed, o alocador-textbook é overkill e perigoso. A4 é uma **Fila de Próxima Melhor Ação**:

> "Dada a restrição de caixa de hoje, qual ação concreta o dono deve aprovar a seguir — e qual recusar."

Ordem de prioridade que a fila reflete:
1. **Consertar vazamento de valor primeiro** (preço/desconto/prazo/SKU ruim — a A3 já gera essas ações).
2. **Liberar caixa preso no NCG** (encurtar prazo, cobrar, reduzir estoque parado).
3. **Financiar só crescimento de EVA alto** (spread-positivo, acima do hurdle).
4. **A2 company-level** serve só pra decidir onde vale aprofundar o cockpit (Colacor/SC ainda sem A3).
5. **Se nada bate o hurdle → segurar caixa / pagar dívida / distribuir pro dono** — sempre uma linha explícita da fila, nunca um caso de falha escondido.

A maior armadilha que A4 evita: **recomendar "crescer" quando a resposta certa é "parar de vender mal"**.

## 2. O que A4 é (camada fina, compõe — não recomputa)

A4 não recalcula nada. Compõe as saídas já calculadas:
- **A3** (`fin-valor-cockpit`, Oben): cada `recomendacaoCliente` (cortar desconto / subir preço / encurtar prazo / despriorizar SKU / crescer) vira uma **ação** com EVA/R$ em jogo.
- **A2** (`fin-valor-engine`, por empresa): incremental ROIC / spread → um **"growth sleeve"** por empresa (financiar crescimento genérico), confiança baixa para Colacor/Colacor SC (sem cockpit granular ainda).
- **A1** (`fin-cashflow-engine`, por empresa): restrição de caixa — `disponível_para_alocar` = f(saldo de tesouraria, dias de cobertura, NCG, reserva mínima); e o piso `precisa_reservar`.

## 3. Anatomia de uma "ação" na fila

Cada item:
- `descricao` (ex.: "Oben — cortar desconto do cliente X", "Colacor — sleeve de crescimento")
- `empresa`, `tipo` (`consertar_valor` | `liberar_caixa` | `crescer` | `benchmark`)
- `impacto_eva` (R$/ano, quando estimável; senão null)
- `caixa_consumido` (pico; 0 para ações de preço/prazo que não custam caixa; null se desconhecido)
- `payback_meses` (quando aplicável; null)
- `hurdle` (WACC da A2 da empresa, ou fallback — ver §6)
- `ticket_min` / `ticket_max` (lumpy; null para ações sem caixa)
- `confianca` (`alta`|`media`|`baixa`)
- **`status`**: `Financiar já` | `Financiar condicional` | `Consertar antes` | `Falta dado` | `Não financiar`

Regras de status: ações de **consertar valor** (A3, custo de caixa ~0, EVA positivo) → `Consertar antes` (topo, fazer primeiro); **liberar caixa** → idem; **crescer** spread-positivo com caixa disponível → `Financiar já`; spread-positivo sem caixa → `Financiar condicional`; sem hurdle/dado → `Falta dado`; spread-negativo ou abaixo do hurdle → `Não financiar`. O benchmark (pagar dívida/distribuir) entra como `Não financiar` dos demais quando nada supera o hurdle.

## 4. Ordenação

Dentro da restrição de caixa: ordena por **prioridade de tipo** (consertar_valor → liberar_caixa → crescer → benchmark), e dentro de cada tipo por **EVA/R$ por R$ de caixa consumido** (ações sem caixa, como preço/prazo, vêm primeiro — retorno "infinito"), com payback como desempate. Hurdle é o corte: crescimento abaixo do hurdle vira `Não financiar`.

## 5. Caixa disponível (da A1) — owner-managed

`disponível_para_alocar` por empresa, conservador: do `fin-cashflow-engine`, usar `saldo_tesouraria` − reserva mínima (ex.: N semanas de cobertura via `dias_cobertura`/threshold) − NCG incremental projetado. **Caixa NÃO é fungível entre as 3 PJs** (entidades legais distintas; intercompany informal). A4 calcula o disponível **por empresa** e não soma cegamente; ações de uma empresa só competem pelo caixa daquela empresa (com nota se houver intercompany configurado). Pró-labore/distribuição do dono entram como benchmark, não como caixa disponível.

## 6. Hurdle + degradação honesta

- Hurdle = WACC da A2 da empresa. **Se ausente** (A2 sem inputs de dívida/PL/Ke): fallback explícito + flag — custo de dívida pós-imposto, OU retorno mínimo do dono (input manual opcional), OU mediana dos hurdles disponíveis; status `Falta dado` quando nem o fallback existe.
- **A3 ausente** (Colacor / Colacor SC): só o sleeve company-level da A2, confiança **baixa**, status `Falta dado` com "precisa definir ação concreta (margem/NCG/payback) antes de financiar". Nunca inventa ações de cliente/SKU pra quem não tem cockpit.
- **Caixa A1 incerto** (confiança baixa da projeção): encolhe o disponível e move ações pra `Financiar condicional` (gatilho: cobrança recebida / dívida aprovada / reserva restaurada).
- Nunca fabrica número: campo ausente = null + motivo; impacto/payback só quando estimável.

## 7. O que A4 NÃO faz (armadilhas — Codex)

Não trata ROIC de empresa como permissão de despejar caixa; não compara ação de cliente Oben (A3) contra média company-level de Colacor (A2) sem flag de confiança; não recomenda crescer antes de consertar preço/prazo; não trata caixa como fungível entre as 3 PJs; não usa WACC fake; não super-rankeia Δcapital minúsculo (herda o aviso da A2); não ignora NCG (crescer pode destruir caixa — o caixa consumido captura isso); não compara economics de Simples (serviços) com Presumido (indústria) sem normalização; não otimiza decimais em decisões lumpy; não esconde "não fazer nada / pagar dívida / distribuir".

## 8. Onde mexe (arquitetura — engine fino que COMPÕE)

- **Engine** `supabase/functions/fin-next-best-action/index.ts` (gate **gestor comercial + master**). Usa service_role pra **chamar internamente** `fin-cashflow-engine`, `fin-valor-engine` e `fin-valor-cockpit` (todas aceitam service_role) para as 3 empresas, compõe e devolve a fila. Resolve o descasamento de auth (A2 é master-only; o A4 gateia gestor+master na borda e busca os insumos via service_role). ~7 chamadas internas; tela analítica de baixa frequência, latência aceitável; degrada se uma function falhar (parte da fila com `Falta dado`).
- **Helper puro** `src/lib/financeiro/next-best-action-helpers.ts` (vitest) espelhado no engine: `montarFilaAcoes` (junta ações A3 + sleeves A2 + benchmark, ordena, atribui status), `hurdleEfetivo` (WACC ou fallback), `caixaDisponivel` (da A1), `classificarStatus`, `scoreConfiancaAcao`. A lógica de ranking/status/caixa é TODA testável aqui.
- **Tipos/hook**: `financeiroService.ts` + `useProximaAcao`.
- **UI**: rota `/financeiro/proxima-acao` (gestor+master): a fila priorizada com status + "o que recusar" + banner de confiança. Agrupada por status (Consertar antes / Financiar já / Condicional / Falta dado / Não financiar).
- **Sem migration nova** (compõe dados existentes). Opcional: input manual `retorno_minimo_dono` em `fin_config_cashflow` para o hurdle fallback (idempotente, à parte).

## 9. Testes (vitest no helper)

- `caixaDisponivel`: tesouraria − reserva − NCG; confiança baixa → encolhe; negativo → 0.
- `hurdleEfetivo`: WACC presente → usa; ausente → fallback (cost-of-debt / retorno dono / mediana) + flag; nada → null.
- `classificarStatus`: consertar_valor/EVA+ → Consertar antes; crescer spread+ com caixa → Financiar já; sem caixa → condicional; abaixo do hurdle → Não financiar; sem dado → Falta dado.
- `montarFilaAcoes`: ordem por tipo→EVA/caixa→payback; benchmark sempre presente; A3 ausente p/ empresa → só sleeve company-level com confiança baixa; caixa de uma empresa não financia ação de outra.
- `scoreConfiancaAcao`: A3 → alta; sleeve A2-only → baixa; hurdle fallback → rebaixa; caixa incerto → rebaixa.

## 10. Migração / pré-requisitos

- Depende de A1/A2/A3 em produção. **A2/A3 ainda não estão deployadas** (PRs mergeados, deploy manual no Lovable pendente) → A4 só funciona ao vivo depois que `fin-valor-engine` e `fin-valor-cockpit` estiverem Active. O código de A4 pode ser construído/testado antes (engine degrada honesto se as functions internas faltarem).
- Re-deploy do engine via chat Lovable. Rota nova no `App.tsx`. Sem migration obrigatória (coluna opcional `retorno_minimo_dono` entregue à parte se quisermos o fallback de hurdle do dono).

## 11. Definição de pronto

- Fila priorizada de ações concretas (consertar valor → liberar caixa → crescer → benchmark) com status (Financiar já/condicional/Consertar antes/Falta dado/Não financiar), EVA/caixa/payback/hurdle/ticket por ação.
- Caixa por empresa (não-fungível), hurdle com fallback honesto, benchmark "pagar dívida/distribuir" sempre presente.
- Compõe A1/A2/A3 via engine fino (service_role internamente; gate gestor+master na borda); degrada honesto se um insumo faltar.
- Helper vitest verde; `bun run test` 100%; `validate` (CI) verde; zero lint novo; `deno check` no engine.
- UI `/financeiro/proxima-acao` (gestor+master) + docs CONFIABILIDADE seção A4.
- A4 não regride A1/A2/A3.

## 12. Não-escopo (deferido)

Otimização matemática (LP/MILP) — fila greedy/rankeada determinística basta; cockpit granular para Colacor/Colacor SC (A3 só cobre Oben hoje) — sleeve company-level até lá; modelagem de dívida/headroom de crédito real; simulação de cenários de alocação; eliminação intercompany pra caixa consolidado; automação da execução das ações (A4 recomenda, o dono decide).
