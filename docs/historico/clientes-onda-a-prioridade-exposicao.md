# Clientes, onda A: prioridade por exposição ao atraso e "Meu dia" sem corte (2026-11-24)

Vem da 3ª revisão da tela de Clientes (11 eixos), que apontou a nota de prioridade como o defeito nº 1.
As ondas anteriores estão em `clientes-onda-1-carteira-priorizada.md`, `clientes-onda-2-ficha-unica.md` e
`clientes-onda-3-acao-na-ficha.md`.

> ⚠️ **Correção (2026-11-24, depois do Publish do #4162):** tudo o que este registro diz sobre o
> "Meu dia" — o corte de 200, o `?? 0` de `agenda.ts`, o escopo unificado e a reserva de reativação
> (#4162) — foi feito num caminho que **nenhuma tela renderiza**. O `AgendaTodayList` saiu da página
> Meu dia no `578c79a3c` (2026-10-20), que passou a mostrar a lista de recompra por produto
> (`private._venda_sugestoes_json`, ordenada por `valor_ref_total`, sem ler `priority_score`). A
> verificação por bytes do #4162 deu `ALVO ausente nos 411 chunks`, e o mesmo grep também não achava
> propriedades antigas do arquivo, o que levou ao achado. O código sem uso (`AgendaTodayList`,
> `SignalModifierBadge`, `useMyAgendaToday`, `useMyCarteiraScores`, `src/lib/scoring/agenda.ts` e
> testes) foi removido no PR seguinte. **O que vale da onda A:** a nota v1.9 e a ordem da lista de
> Clientes (`/admin/customers`), medidas em prod abaixo. Lição: antes de mexer num componente, prove
> que ele está montado (`git grep "<Componente"`), não só que o teste passa — testes que importam o
> arquivo mantêm vivo o código morto e o knip não acusa.

## O defeito (medido em prod via psql-ro, carteira da vendedora, 2.832 clientes, 707 com nota)

- Top 100 por `priority_score`: **100% `stale`**, média de **1.196 dias** sem compra. 1º `ativo` no
  **rank 206**. Só **52 valores distintos** em 707 notas.
- Causa: `calculate-scores` fazia a média renormalizada de potencial de margem (35), churn (30), recompra
  (20) e meta (15). O potencial é NULL na base inteira e saía da conta. Com churn = 100 − health, quem
  estava mais morto pontuava mais.
- O "Meu dia" (`useMyCarteiraScores`) cortava em `order(priority_score desc).limit(200)`. Com o eixo
  invertido, os 200 eram todos inativos, e nenhum ativo aparecia. É a armadilha "o teto é o EIXO" do
  `CLAUDE.md`: aumentar o limite só adiaria o problema.
- Escopo divergente: a lista lia `carteira_assignments` (elegíveis) e o "Meu dia" lia `farmer_id`. Para o
  master, eram 12.701 elegíveis contra 14.159 linhas por `farmer_id` (as 1.458 a mais não são elegíveis).

## A regra nova (calculate-scores v1.9)

A regra pura fica em `src/lib/scoring/prioridadeValor.ts`, com espelho verbatim em
`supabase/functions/_shared/prioridade-valor.ts`. As faixas são disjuntas, numa escala de 0 a 100 com
2 casas decimais:

| Faixa | Nota | Quem | Ordena por |
|---|---|---|---|
| `atrasado` | 60–100 | ativo que passou da cadência e tem gasto > 0 | exposição E = gasto mensal 180d ÷ 30 × (dias − intervalo) |
| `em_dia` | 35–60 | ativo com cadência que ainda não venceu (ou venceu sem gasto) | gasto × min(dias ÷ intervalo, 1) |
| `sem_cadencia` | 30–35 | ativo com menos de 3 dias de pedido | só o gasto |
| `reativacao` | 0–30 | `stale` | recência: 29,99 × 180 ÷ dias |

- Curva logística x ÷ (x + R$ 1.000), sem normalizar pelo máximo. Assim a ORDEM não depende do maior
  cliente do dia. A referência é configurável em `farmer_algorithm_config.ps_referencia_exposicao`, com
  guarda (inválida cai no padrão). Os pesos `ps_weight_*` deixaram de existir, e a tela de Governança
  passou a descrever a regra em vez de oferecer pesos sem efeito.
- Ausente ≠ zero: `sem_historico` e insumo obrigatório ausente continuam `null` (NULLS LAST). O ramo
  `salesRefreshFatal` segue a regra do status persistido (`_shared/prioridade-historico.ts`).
- `priority_score_log`: os quatro `*_component` passam a ser gravados NULL. A nota nova não é composta
  por eles, e gravá-los afirmaria uma decomposição que não existe.

### Simulação em prod antes do código (mesmas colunas persistidas)

| Métrica | Antes | Simulado |
|---|---|---|
| top 100 `stale` | 100 | 0 |
| rank do 1º `ativo` | 206 | 1 |
| valores distintos (de 707) | 52 | 551 |
| ativo atrasado abaixo de stale ≥ 3 anos | — | 0 violações |
| top 10 igual após 1 / 4 / 7 dias sem compra nova | — | 9 / 9 / 7 |

Alternativa rejeitada: g × min(dias ÷ intervalo, 4) numa faixa só. Ela punha no topo o comprador diário
que tinha comprado ontem (d = i = 1, R$ 104 mil/mês).

## Ritual /codex (challenge, gpt-6.2-astra high): APROVA COM AJUSTES

Ajustes incorporados:

- gasto 0 MEDIDO não entra na faixa `atrasado`, porque a exposição é zero;
- "sem cadência" ganhou fila própria, ordenada só pelo gasto, em vez de W = g, que equivaleria a afirmar
  "vence hoje";
- E virou "estimativa de exposição ao atraso", não "receita perdida";
- o intervalo 0 residual é tratado como cadência desconhecida;
- a régua de estabilidade é **≥ 8/10 do top 10 entre dias consecutivos**.

Ficaram de fora, como decisão do founder ou medição pós-deploy:

- **Descontinuidade na borda das faixas.** Um ativo de R$ 30/mês atrasado 1 dia (60,04) fica acima de
  um de R$ 104 mil/mês que vence hoje (59,70). Foi aceita: a faixa é a regra que a vendedora entende.
- **🧭 Cota de reativação no "Meu dia".** Com ≥ 10 ativos pontuados, nenhum `stale` entra no top 10. O
  Codex sugere reservar vagas para o `stale` recente (181–365d), dimensionadas pelo retorno por contato.
  Hoje não há dado de retorno por contato que sustente o número de vagas.
- **Estabilidade com histórico real.** A simulação congela gasto e status. A medição honesta é dia a
  dia, em `priority_score_log`, depois do recálculo (query abaixo).

## "Meu dia" sem corte

- `useMyCarteiraScores` faz UNIÃO com a carteira: `fetchAssignmentsElegiveis` (a mesma fonte da lista,
  `carteira_assignments` eligible, com `.range()` e ordem total por `customer_user_id`), recortada pelos
  donos [eu, ...cobertos] ou, na lente, pelo alvo e pelo que ele cobre. Os scores vêm por id, em lotes de
  150, com 4 em voo. Erro em qualquer página ou lote LANÇA. Quem escolhe o top N é `buildAgendaItems`,
  sobre o conjunto inteiro.
- `agenda.ts`: saiu o `priority_score ?? 0`. A nota ausente atravessa como `null` e ordena no fim do
  grupo. `effectivePriority(null)` é `null`, porque o nudge dos sinais não fabrica nota a partir do 0.
- **Divergência que fica, por desenho:** na LISTA, o gestor ou master vê a base completa
  (`resolveModoEscopo`). No "Meu dia", vê só a própria carteira, porque a agenda é de quem atende.

## Nota explicável

O tooltip da nota na lista mostra os 2–3 fatores que a decidiram (`explicarPrioridade`), calculados a
partir das MESMAS colunas persistidas, sem coluna nova. A explicação só aparece quando a nota gravada bate
com a regra (tolerância de arredondamento). Nota da fórmula antiga, antes do recálculo, ou referência
configurada diferente do padrão → sem tooltip: explicar com a regra errada seria fabricar o porquê.

## Testes

- `src/lib/scoring/__tests__/prioridadeValor.test.ts`: propriedades com 2.000 casos semeados (a régua
  "atrasado > stale", faixas disjuntas, monotonia, distintos), a marca de cada ramo de ausência e a
  paridade do espelho.
- `supabase/functions/_shared/prioridade-valor_test.ts`: valores pinados no Deno.
- `src/hooks/__tests__/useMyCarteiraScores.corte.test.tsx`: sem `.limit()`, `.range()` além de 1000,
  lotes ≤ 150 que cobrem cada cliente uma vez, e erro num lote do meio que lança.
- `agenda.test.ts`: o `not.toThrow()` pelado deu lugar à marca do ramo (deltas sem `breakdown` valem 0,
  com `breakdown` valem 40).

## Depois do deploy: a mesma métrica, antes e depois

```sql
with r as (select sales_history_status s, days_since_last_purchase d, priority_score p,
  row_number() over (order by priority_score desc nulls last, customer_user_id) rk
  from farmer_client_scores where farmer_id = '700657a1-d75d-4c72-99b1-0a0f2065fa29')
select count(*) filter (where rk <= 100 and s = 'stale') top100_stale,
  (select round(avg(d)) from r where rk <= 100) top100_dias,
  min(rk) filter (where s = 'ativo') rank_1o_ativo,
  count(distinct p) filter (where p is not null) distintos, count(p) priorizados from r;
```

Estabilidade real (rode a partir do 2º dia com a v1.9): a interseção do top 10 de dias consecutivos
em `priority_score_log`, para o mesmo `farmer_id`. A régua é ≥ 8.

### Medido em prod (psql-ro, `ON_ERROR_STOP`, exit 0)

Edge `calculate-scores` atestada em `v1.9-prioridade-exposicao-atraso` pela sonda no ledger
(`pendencias:deploy` → "✅ confere"). Recálculo manual em 2026-11-24 20:58 UTC.

| Métrica (carteira da vendedora) | Antes (12:09 UTC, v1.8) | Depois (20:59 UTC, v1.9) | Simulação |
|---|---|---|---|
| stale no top 100 | 100 | **0** | 0 |
| dias médios sem compra no top 100 | 1.196 | **64** | — |
| rank do 1º ativo | 206 | **1** | 1 |
| valores distintos de nota | 52 | **531** | 551 |
| clientes com nota | 707 | 709 | 707 |

Régua "ativo atrasado acima de inativo": maior nota stale = 29,82 < menor nota ativa = 30,02 —
0 violações nos 282 ativos × 427 stale. `sem_historico` (2.123) segue sem nota (NULL, não 0).
`priority_score_log` do run: os 4 `*_component` = NULL em todas as linhas, notas com 2 casas.

Pendente: estabilidade do top 10 entre dias consecutivos (régua ≥ 8/10) — só mede depois do cron
de 2026-11-25 06:00 UTC, com a query acima sobre `priority_score_log`.

## Reserva de reativação no Meu dia (decisão do founder, 2026-11-24)

Com a v1.9, nenhum inativo entrava no top 10 da carteira medida (282 ativos acima de todo stale).
`buildAgendaItems` agora reserva 1 vaga a cada 5 (2 de 10) para inativos com até 365 dias sem compra
e `days_since_last_purchase` medido, o mais recente primeiro, nas últimas posições, com o selo
"Reativação". Vaga sem candidato volta para a fila principal; ativação (`sem_historico`) segue só
completando o fim. Testes em `agenda.test.ts`, falsificados 5/5 (sem reserva, sem janela, dias NULL
elegível, reserva no topo, vaga vazia) com controle verde antes e depois. A cota (2/10) é
arbitrária: ajustar quando houver retorno por contato medido para cada grupo.
