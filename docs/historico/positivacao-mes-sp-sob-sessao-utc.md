# Positivação ao vivo: o mês de SP medido no fuso da sessão

**2026-09-27.** Fecha a "4ª prova, parada no sensor" de
[provas-janela-de-relogio-fora-do-nucleo.md](provas-janela-de-relogio-fora-do-nucleo.md). Migration
`20260927133606_positivacao_mes_sp_sessao_utc.sql`, prova `db/test-positivacao-eligible-consumo.sh`
reescrita e gate `scripts/fuso-da-sessao-gate.ts`.

## O defeito

`_carteira_positivacao_for_owner` (a positivação AO VIVO, lida por `get_minha_positivacao` e
`get_minha_positivacao_for`) fixa o mês em São Paulo: `mes_inicio`/`mes_fim` são `date` calculadas de
`now() AT TIME ZONE 'America/Sao_Paulo'`. Mas comparava dois eixos timestamptz no fuso da SESSÃO:

- `farmer_calls.started_at >= mes_inicio` — o cast implícito date→timestamptz usa o TimeZone da sessão;
- `COALESCE(order_date_kpi, created_at::date)` — o `::date` também.

`route_visits.visit_date` é `date`: date contra date não tem fuso, e esse eixo já estava certo.

Medido na prod (psql-ro): `TimeZone=UTC` vindo do arquivo de configuração, sem override por papel
nem por banco, e o PostgREST herda. Então, avaliando o mês M de SP, a janela era
[último dia de M-1 às 21:00 BRT, último dia de M às 21:00 BRT). O corpo vivo era o do repo, menos 1
comentário. **Impacto hoje: zero** — `farmer_calls` tem 0 linhas, e dos 31.550 pedidos válidos só 4
caem no fallback de `created_at`, nenhum numa borda de mês.

**Nada congelado foi atingido.** O snapshot mensal `carteira_positivacao_snapshot` (35.328 linhas,
5 meses, edge `carteira-positivacao-snapshot`) só lê colunas `date` (`order_date_kpi`,
`route_contact_log.data_rota`, `visit_date`), e o comentário dos loaders em
`_shared/mapas-paginados.ts` já descrevia esta classe. O defeito era só do KPI ao vivo.

## O conserto

Duas expressões: a ligação e o fallback do pedido passam pela data de SP antes de comparar
(`(col AT TIME ZONE 'America/Sao_Paulo')::date`). O resto do corpo é o de prod linha a linha.

- **Coluna ou borda?** O Codex (desenho) mostrou que converter a BORDA
  (`col >= mes_inicio::timestamp AT TIME ZONE 'America/Sao_Paulo'`) é equivalente para datas depois
  do horário de verão de 1950 e preserva acesso por índice. Medido: `farmer_calls` não tem índice
  geral `(farmer_id, started_at)`, só dois parciais que esta query não usa. Ficou a coluna, simétrica
  ao eixo do pedido. Se esse índice nascer, trocar para a borda é equivalente.
- **O fallback converte o INSTANTE.** Isso só é certo se `created_at` for instante, e isso foi
  MEDIDO antes de decidir. O importador grava a data como meio-dia UTC (31.510 linhas em 365 dias):
  data de SP = data UTC, conversão neutra. As 41 linhas gravadas como meia-noite UTC têm todas
  `order_date_kpi`, então nunca chegam ao fallback, que só alcança 5 linhas com instante real. Um
  writer novo que grave data como meia-noite UTC tem de preencher `order_date_kpi`. Heurística por
  hora do dia foi descartada: seria fabricar semântica.
- **Pré-condição anti-deriva.** O `CREATE OR REPLACE` substitui a função inteira. Por isso a
  migration aborta se o corpo vivo não for o predecessor revisado nem o próprio corpo novo (achado
  do Codex). A identidade é o md5 do corpo **sem comentários e com espaço colapsado**, porque o corpo
  de prod já tinha perdido um comentário no apply. Um md5 exato reprovaria uma aplicação sã.
- **Postcondição** de catálogo, sem invocar a função: existe, SECURITY DEFINER, `search_path=public`,
  dono `postgres`, corpo normalizado = o desta migration, anon/authenticated/PUBLIC sem EXECUTE, e
  os dois wrappers ainda executáveis por `authenticated`. Ela confirma a INSTALAÇÃO; o CONTROLE é
  da prova executada.

## A prova

- **Relógio controlado** (padrão do #2583/#2588): `public.now()` lê `test.agora`, e só a função sob
  teste ganha `pg_catalog` depois de `public`. O `now()` é TRIPWIRE: sem `test.agora` ele levanta
  exceção em vez de cair no relógio de parede, com SQLSTATE próprio (`Z9T01`). Um `RAISE` comum
  daria P0001, o mesmo código do `forbidden` do gate, e o C9 o leria como "o gate barrou" (achado do
  Codex). O C9 agora exige a MENSAGEM do gate e relança qualquer outro P0001.
- **Guarda de sombra** mais estrita que a do #2588: o único nome de `public` que pode sombrear
  `pg_catalog` é o `now()`, chamado ou não. `AT TIME ZONE` é `timezone(...)` por sintaxe, e nenhum
  regex sobre o corpo enxergaria uma sombra dela. O controle positivo `now|` continua.
- **Bloco B, a borda.** O relógio fica 1 s antes e 1 s depois de 01/03/2025 00:00 BRT, e os eventos
  ficam às 22:30, 23:59:59 e 00:00:00 BRT. Tudo roda sob `SET TimeZone='UTC'` E
  `'America/Sao_Paulo'`: sob sessão SP o corpo antigo PASSA, e só a rodada UTC o pega. A receita é soma
  de potências de 10, então o valor diz QUAIS pedidos entraram. Um cliente que recompra (fevereiro e
  março) separa `novos` de `positivados`, que antes eram sempre iguais no bloco (achado do Codex).
  Os pedidos com KPI têm `created_at` em OUTRO mês, o que prova a precedência do KPI. Controle
  positivo da sessão (B0): o cast ingênuo de uma data vira 00:00Z numa sessão e 03:00Z na outra.
  Esperados conferidos por um oráculo independente em Python antes de escrever a prova.
- **Erro de execução não mata mutante** (Codex): valor que é erro ou saída vazia vira
  `ERRO_DE_EXECUCAO`, nunca `FALHOU`. O laço `--falsificar` reprova a sabotagem cujo vermelho veio
  daí. A única exceção é declarada: no `sem_pin`, o vermelho esperado é o próprio tripwire.
- **Smoke com o `proconfig` restaurado** (Codex): no fim, a função volta ao `search_path` da prod e
  os dois wrappers rodam como `authenticated`, com a identidade que cada gate exige.

**Números:** 44 asserts (eram 13). Matriz servidor `TZ=UTC`/SP × `lc_messages` C/pt_BR: 4/4 verdes.
`--falsificar`: controle verde + **14/14** sabotagens vermelhas no assert certo, com os asserts que
têm de continuar verdes rodando verdes, nas 4 combinações. As sabotagens: corpo pré-fix, cast da
ligação na sessão, cast do pedido na sessão, mês em UTC, fim fechado, início aberto, primeira
compra por `max`, KPI sem precedência, UUID do vendedor no lugar do cliente em `a_positivar`,
relógio desligado, hora de parede, sem pin, `eligible` removido e gate master removido. Entrou no
núcleo do CI (`db/nucleo-ci.txt`: `44 falsificar=14`).

**O laço foi falsificado também.** Num espelho em tmpdir foram plantados 3 defeitos: expectativa
errada, padrão de sabotagem que não existe e sabotagem que quebra o SQL. O resultado foi exatamente
**10 vermelhas / 3 falhas**, cada uma com o diagnóstico certo, e exit 1. O #2588 tinha achado um
`--falsificar` irmão que contava sabotagem não aplicável como dente.

## A classe (matar-classe)

**Assinatura**, só em corpo que menciona `AT TIME ZONE 'America/Sao_Paulo'`:
- **A**: coluna timestamptz comparada com variável `date`/`timestamp` calculada em SP;
- **B**: coluna timestamptz convertida pelo fuso da sessão (`::date`, `::timestamp`, `date()`,
  `date_trunc`/`extract` de campo de calendário);
- **C**: o "hoje" da sessão (`current_date`, `now()::date`…) num corpo SP.

A calibração casa os 2 sítios do corpo pré-fix e zero do corpo corrigido.

**Denominador.** 616 ocorrências de `America/Sao_Paulo` em 63 migrations → 739 migrations
modeladas → 312 identidades vivas → **17 com semântica SP**. Prod tem 19: as 17 mais
`fornecedor_operacional` e `proxima_janela_operacional`, sem `CREATE` versionado e já corretas.

| sítio (última definição) | família | veredito |
|---|---|---|
| `_carteira_positivacao_for_owner` · `farmer_calls.started_at` | A | **afetado** — corrigido aqui |
| `_carteira_positivacao_for_owner` · `sales_orders.created_at::date` | B | **afetado** — corrigido aqui |
| `_carteira_positivacao_for_owner` · `route_visits.visit_date` | — | já-correto (date×date) |
| `get_ultimos_precos_cliente(uuid)` · `data SP <= current_date` | C | **dívida marginal**: das 21:00 às 23:59 BRT aceita pedido de amanhã; 0 casos hoje |
| `medir_abaixo_piso_tier(integer)` · `data SP >= current_date - p_dias` | C | **dívida marginal**: perde o dia mais antigo das 21:00 às 23:59 BRT; auditoria |
| `_data_health_compute()` · `current_date - max(data_ciclo)` | C | falso-positivo: `data_ciclo` é gravada em UTC pela edge (`toISOString`) |
| `prime_uso_vigencia` · `data_inicio::timestamp` | B | falso-positivo: coluna `date` |
| `venda_gate_credito`, `aplicar_parametros_automatico_diario`, `reposicao_param_auto_resumo_tick`, `whatsapp_minutos_uteis` | A | já-corretas: comparam date×date, ou convertem para SP antes de comparar |
| `data_health_watchdog`, `fin_sync_heartbeat`, `get_customer_sales_summary`, `pedido_total_liquido_classificar`, `push_sla_tick`, `tarefas_materializar_recorrentes`, `tint_promocao_watchdog`, `whatsapp_sla_digest_tick` | — | sem sítio: o SP delas vira `::time`/`isodow`/`to_char` ou coluna `date`, e comparam timestamptz com timestamptz |

**Gate:** `scripts/fuso-da-sessao-gate.ts` (vitest), sobre a ÚLTIMA definição viva de cada função
(`modelarRepo`, o modelo "a última a recriar vence" do sensor de deriva). Tem baseline das 2 dívidas
e do falso-positivo, que só encolhe, dois canários embutidos (o corpo pré-fix, e o mesmo corpo nas
formas `date =` e `CAST`) e sentinela do stripper (maior bloco descartado ≤ 60, medido em 54, e é
comentário de verdade). As 2 dívidas foram para chip. São 35 testes, falsificados com 6
sabotagens in-place, cada uma APLICADA e vermelha no teste certo.

- **A heurística de coluna foi MEDIDA, não suposta.** Das 658 colunas timestamptz de `public`, só
  432 terminam em `_at`, e um gate só com `_at` teria ponto cego de um terço. `_em` acrescenta 176
  (as 4 `*_em` que não são timestamptz são 3 nomes `date`, excluídos). Juntas cobrem 608/658
  (92,4%). As 50 restantes (`data_evento`, `ultima_sincronizacao`, `window_start`…) são o limite
  declarado do gate, junto com SQL dinâmico e função que não menciona SP.

## O adversarial (Codex, no diff final)

4 achados, todos P2:

1. **A PRÉ reprova mudança só de formatação** (`ca.eligible=true`, um `/* */`). Ficou aceita como
   limite fail-closed; a migration já era imutável no branch. O predecessor medido em prod passa, e
   a query de validação, que usa o mesmo hash, roda logo antes do apply: "DIVERGENTE" para antes da
   PRE.
2. **O gate não via `d date = …`, `SELECT … INTO d` nem `CAST(col AS date)`.** Corrigido, com
   calibração dos dois lados e o 2º canário.
3. **O gate acusava a conversão CORRETA da borda** (`d::timestamp AT TIME ZONE 'America/Sao_Paulo'`),
   justamente a troca documentada para quando houver índice. Corrigido; `d::timestamptz` segue
   acusado, porque ainda casta no fuso da sessão.
4. **`a_positivar` poderia devolver o UUID do vendedor com os nomes certos.** O card de clientes
   usa o UUID no link. B6/B13 passaram a conferir o par nome=UUID, e a sabotagem
   `a_positivar_id_errado` prova o dente.

## Lições

1. **Converter a coluna para SP só é certo se a coluna for INSTANTE.** Para data gravada como
   meia-noite UTC, a mesma conversão recuaria um dia. Meça a FORMA do dado (hora do dia) antes de
   escolher a conversão. Aqui a convenção do importador, meio-dia UTC, tornou a conversão neutra.
2. **md5 exato de corpo reprova aplicação sã** quando algum caminho de apply mexe em comentário.
   A identidade útil é o corpo normalizado; o sensor de deriva já compara por tokens pelo mesmo motivo.
3. **Meu próprio contador de falsificação mentiu, no mesmo dia em que o diário do #2588 descreveu a
   classe.** No laço improvisado que falsificou o gate, a 4ª sabotagem não aplicou: a contrabarra
   foi escapada duas vezes e o padrão ocorreu 0×. O resumo disse "4 vermelhas / 0 falhas", porque
   calculava `total − falhas` e sabotagem que não aplica não entrava em `falhas`. O que denunciou foi
   ler a linha `PADRAO 0x`, não o resumo. Conte só "aplicada E vermelha", nunca por subtração.
4. **Converter o controle de sessão em asserção** (B0) é o que torna a matriz UTC/SP real. Sem ele,
   um `SET TimeZone` que não pegasse faria as duas rodadas concordarem, e o bloco inteiro passaria
   medindo o mesmo mundo duas vezes.
5. **Sabotagem in-place que ESPERA NA FILA do `heavy` contamina quem segura o slot.** O laço que
   falsificou o gate aplicava a sabotagem em disco e só DEPOIS pedia o slot. O slot estava com a
   suíte vitest completa, que leu o gate sabotado e reprovou o teste do `SELECT … INTO` por 10
   minutos de fila. O resultado da suíte completa virou mistura de dois estados da árvore; isolada,
   com a árvore limpa, deu 35/35. É irmã de "a árvore mente" (`mutcheck`) com "o `heavy` é uma
   fila", em `money-path.md`. Conserto de processo: a sabotagem entra DENTRO do comando que o
   `heavy` embrulha, ou num espelho, nunca antes da espera. E não rode suíte completa enquanto
   houver sabotagem in-place pendente.
