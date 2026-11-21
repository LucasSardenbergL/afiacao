# Spec — Crédito definido por IA (limite do grupo + prazo máximo + liberação do pedido)

> Status: **rascunho para aprovação** (2026-11-20). Money-path. Decisões de produto do founder marcadas **[Lucas]**; decisões de engenharia minhas marcadas **[call]**.
> Antecedentes: `trava-credito-fase2.md` (gate vencido>60d, exceção, log — **continua sendo o piso**), `2026-10-31-oben-frente-b-pedido-cobranca-cet-design.md` (sugestão de prazo por regra), `docs/agent/money-path.md`, `docs/agent/financeiro.md`.

## 1. Intenção

Hoje a liberação de crédito é uma trava binária (vencido > 60 dias bloqueia) e o prazo é só sugestão — a vendedora escolhe qualquer `codigo_parcela`. Não há limite em R$, nem score, nem IA. A liberação "duvidosa" é negociada por WhatsApp com o gestor.

O founder quer que **a liberação de crédito seja definida por IA**: a IA define o **limite de crédito** de cada cliente e o **prazo** que ele pode ter, e a decisão sai **junto com a liberação do pedido**.

**Sucesso:** a maioria dos pedidos libera sozinha sem ninguém olhar; o duvidoso chega ao gestor no app já com recomendação e motivo; zero liberação que fure o piso; cada decisão auditável (o que a IA leu, o que disse, quem aprovou).

## 2. Decisões do founder

- **[Lucas] Caminho A**: IA decide 🟢 libera / 🔴 bloqueia sozinha; o caso 🟡 duvidoso vai para fila de aprovação do gestor. Evolução para "B" (sem humano) só por faixa e só com concordância IA×gestor medida.
- **[Lucas] Limite único do GRUPO**: a dívida do cliente na Oben + Colacor + Colacor SC soma contra um limite só.
- **[Lucas] Arquitetura híbrida (opção 3)**: a IA define limite/prazo **fora da hora do pedido**; na hora do pedido a checagem é SQL determinística e instantânea; a IA só é chamada no pedido para redigir a recomendação do 🟡.
- **[Lucas] Construção com Fable + Codex**: Fable em varreduras/1ª revisão; Codex como 2ª opinião obrigatória no desenho e no diff money-path.

## 3. Objetivos / não-objetivos / anti-objetivos

**Objetivos**
1. Limite de crédito em R$ por **cliente-grupo**, com histórico e motivo.
2. Prazo máximo (em dias) por cliente-grupo.
3. Exposição real: títulos abertos (a vencer + vencidos) nas 3 empresas + pedidos enviados não faturados + este pedido.
4. Decisão no pedido em 3 faixas, aplicada **no servidor** (edge `omie-vendas-sync`), cobrindo todas as vias.
5. Fila de aprovação no app (substitui o WhatsApp), com recomendação da IA.
6. Registro de toda decisão (IA e humano) para medir concordância.

**Não-objetivos (agora)**
- Bureau externo (Serasa/SPC/Boa Vista) — custo; fica como fase futura.
- Limite automático sem humano (caminho B).
- Mexer em cobrança/régua de cobrança.

**Anti-objetivos (falha mesmo "funcionando")**
- LLM no caminho síncrono do pedido decidindo liberação (latência, não-determinismo, venda parada se a API cair).
- Limite fabricado a partir de dado ausente (`null` virar 0 → "sem dívida" → libera). **Ausente ≠ zero.**
- Furar o piso atual (vencido > 60 d) sem exceção humana.
- Pedido 🟡 parado sem ninguém ver.

## 4. Abordagens consideradas

| # | Abordagem | Trade-off | Veredito |
|---|---|---|---|
| 1 | LLM analisa cada pedido na hora | mais "IA"; 5–15 s por pedido, não-determinístico, venda para se a API cai, difícil auditar | descartada |
| 2 | Regras fixas; IA só redige o motivo | rápido e previsível; **não** é "definido por IA" | descartada (não atende o pedido) |
| 3 | **Híbrido**: IA define limite/prazo assíncrono sob travas; pedido confere em SQL; IA redige o 🟡 | IA decide de verdade, pedido instantâneo e resiliente, auditável; mais trabalho; limite reflete o último cálculo | **escolhida [Lucas]** |

## 5. Desenho

### 5.1 Cliente-grupo (identidade)
- **[call]** Chave do grupo = `user_id` do cliente canônico (o mesmo eixo de `omie_clientes`), resolvendo os pares `(company, omie_codigo_cliente)` **no servidor** via `omie_clientes`/`omie_customer_account_map` — nunca do payload (lição Codex 2026-07-02 §10.2).
- Se o pedido tem um par que **não resolve** para grupo → decisão máxima 🟡 ("cliente não consolidado entre empresas"). Nunca adivinha.
- Aliases fiscais `@placeholder.local` (CLAUDE.md §armadilhas) **fazem parte** do grupo — a exposição deles soma.

### 5.2 Ficha de crédito (features determinísticas, SQL)
Uma função/view `credito_ficha(grupo)` monta, por grupo, com **confiança por campo**:
- exposição aberta por empresa e total (`fin_contas_receber.saldo`, a vencer + vencido);
- vencido total e faixa de atraso (0–15, 16–60, >60);
- pedidos `enviado` não faturados (`sales_orders`) — em trânsito;
- comportamento de pagamento: prazo concedido vs real ponderado, atraso p50/p80, `pct_valor_atrasado`, perfil (`folga|pontual|atraso_leve|atraso_cronico`) — reaproveita `v_ciclo_cliente_resumo` / `ciclo-cliente-helpers`;
- compra média mensal 180 d e maior compra (faturamento, **não** CR — `financeiro.md` §21);
- tempo de relacionamento, casos/promessas de cobrança abertas e quebradas;
- cadastro Receita: situação, porte, capital, data de abertura (`radar_empresas`, `cliente_situacao_receita`);
- **flags de qualidade**: baixa inferida (`v_titulo_baixas` confiança), título fantasma suspeito, sync defasado, grupo parcialmente consolidado.

Campo ausente vai como `null` + motivo. **Nunca** `0`.

### 5.3 Motor de limite (edge `credito-ia-avaliar`, Anthropic direto)
- **Gatilhos**: cron semanal para toda a carteira ativa + evento (novo título vencido, quitação, cliente novo no 1º pedido, pedido 🟡 resolvido). Single-shot com `registro-execucao`; gate `authorizeCronOrStaff`.
- **Entrada**: a ficha (5.2) em JSON + a política (texto versionado) + as travas.
- **Saída (tool-use, schema rígido)**: `limite_sugerido_brl`, `prazo_max_dias`, `risco` (`baixo|medio|alto|sem_evidencia`), `confianca` (0–1), `motivos[]` (cada um citando o campo da ficha), `alertas[]`.
- **Travas determinísticas pós-IA** (código, não prompt) — a saída da IA é **cortada** por elas, e o corte fica registrado:
  - vencido > 60 d no grupo → limite efetivo = exposição atual (nada novo) e `risco=alto`;
  - limite ≤ K × compra média mensal 180 d **[call: K=3, a calibrar]**; sem compra média (`null`) → teto de cliente novo;
  - cliente sem histórico → teto de cliente novo **[call: R$ 5.000 a calibrar]**, prazo ≤ 28 d;
  - prazo_max ≤ maior prazo já honrado pelo cliente + 1 degrau;
  - qualquer insumo crítico `null` → `confianca` rebaixada e mudança vai obrigatoriamente para aprovação.
- **Proposta, não aplicação**: a saída vira `credito_limite_proposta`. Só vira limite vigente com aprovação do gestor. **[call]** Exceção para descer: redução por deterioração (novo vencido) aplica na hora e avisa — reduzir é o lado seguro.
- **1ª leva**: o cálculo inicial de toda a carteira gera propostas; nada vale até o gestor revisar (tela com aprovação em lote por faixa).
- Modelo: `MODELO_PADRAO` (`_shared/anthropic.ts`), prompt caching na política, temperatura 0. Prompt + versão da política + versão do modelo gravados em cada proposta.

### 5.4 Banco (tudo com RLS, migrations novas)
- `credito_limite` — vigente por grupo: `grupo_user_id` (UNIQUE), `limite_brl`, `prazo_max_dias`, `risco`, `origem_proposta_id`, `aprovado_por`, `vigente_desde`. **1 writer**: RPC de aprovação.
- `credito_limite_proposta` — imutável: ficha (jsonb snapshot), saída da IA, travas aplicadas, `status (pendente|aprovada|recusada|aplicada_auto_reducao|expirada)`, decisor, motivo humano.
- `credito_decisao_pedido` — por pedido/tentativa: faixa, exposição calculada, limite e prazo usados, motivo, `excecao_id`, recomendação IA (quando 🟡), decisão humana.
- Fila 🟡: reaproveita/estende `venda_excecao_credito` (por pedido, imutável, alçada `pode_ver_carteira_completa`) em vez de tabela paralela **[call — Codex valida]**.
- Leitura vendedor: só o próprio cliente (faixa + motivo), nunca a ficha completa; gestor/master: tudo.

### 5.5 Decisão no pedido (RPC SQL pura, service_role)
`venda_gate_credito_v2(p_sales_order_id)` — deriva cliente/conta do `sales_orders` local (não do payload), resolve o grupo, calcula:

```
piso        = regra atual vencido>60d  → 🔴 (exceção humana continua igual)
sem_grupo   = par não consolidado      → 🟡
sem_limite  = grupo sem limite vigente → 🟡 (cliente novo / ainda não aprovado)
exposicao   = aberto(3 empresas) + enviado_nao_faturado + este_pedido
estoura     = exposicao > limite        → 🟡
prazo_acima = prazo(codigo_parcela) > prazo_max  → 🟡
prazo_ilegivel = parser não lê a parcela → 🟡
caso contrário → 🟢
```

- Chamada pela edge `omie-vendas-sync` em `criar_pedido` e `alterar_pedido` (quando total ou prazo sobem), no mesmo ponto do gate atual. **Todas as vias** passam por ali.
- 🟡 → pedido fica `aguardando_credito` (estado novo em `sales_orders`), **não** vai ao Omie. Aprovação na fila reenvia pelo mesmo `criar_pedido` com `excecao_id`.
- RPC indisponível → **mantém o comportamento atual**: piso vencido>60d decide e grava `gate_indisponivel` (fail-open só para a camada nova, nunca para o piso).
- Recomendação do 🟡: edge chama o Claude **assíncrono** após gravar o 🟡 (não segura o pedido); a fila mostra "recomendação chegando" até ela existir.

### 5.6 Prazo em dias
`omie_condicao_pagamento_catalogo.dias_parcelas` está vazio; o prazo vem da descrição livre via `prazo-sugestao.ts`. **[call]** Portar o parser para SQL (1 fonte de verdade na fronteira) com tabela de override manual para as parcelas que o parser não lê; ilegível → 🟡, nunca "0 dias".

### 5.7 Telas
- **Pedido** (`/sales/new`): selo da faixa no resumo + motivo em 1 linha; 🟡 mostra "vai para aprovação do gestor". Some o fluxo de WhatsApp.
- **Fila de crédito** (`/credito/fila`, gestor/master): pedidos 🟡 com ficha resumida, recomendação IA, ações aprovar / aprovar com outro prazo / recusar (motivo obrigatório na discordância). Alerta se item > 2 h sem ação **[call]**.
- **Limites** (`/credito/limites`): carteira com limite vigente, exposição, uso %, propostas pendentes (aprovação em lote para a 1ª leva).
- **Cliente** (ficha existente): bloco "Crédito" com limite, exposição, prazo máx e histórico de decisões.

### 5.8 Sensores (nascem com a superfície — ledger, não PostHog)
- concordância IA×gestor por faixa (taxa e direção da discordância);
- 🟡 por motivo, tempo até decisão;
- liberados que depois atrasaram > 15 d (qualidade do 🟢) — query, não recado.

## 6. Plano de entrega (PRs pequenos, ordem)
1. Banco: tabelas + RLS + `credito_ficha` (prove-sql PG17).
2. Prazo em dias no SQL + override.
3. Edge `credito-ia-avaliar` + travas + propostas; tela `/credito/limites` com aprovação da 1ª leva. **Ainda sem efeito no pedido.**
4. `venda_gate_credito_v2` + estado `aguardando_credito` + edge `omie-vendas-sync` — inicia em **modo sombra** (calcula e registra, não bloqueia) por ~2 semanas para medir a distribuição de faixas.
5. Fila `/credito/fila` + recomendação assíncrona; ligar o enforcement.
6. Sensores/painel.

Cada um com 3 camadas de deploy (migration · edge · Publish) e 2ª opinião Codex no diff.

## 7. Riscos conhecidos
- Consolidação do grupo parcial → muito 🟡 no começo (medido no modo sombra).
- Títulos fantasmas/sync defasado inflam exposição → falso 🟡 (falso 🟢 é o risco a evitar; falso 🟡 é custo aceitável).
- Pouco histórico rotulado → travas determinísticas carregam a segurança no início.

## 8. Em aberto para o founder
(ver §10 — respondidas na conversa de 2026-11-20)

## 9. Challenge Codex (2026-11-20, gpt-6.2-astra high — 8 P1 + 2 P2, TODOS acatados) + builder-check Fable

Veredito Codex: **bloquear ativação** até provar que cada real comprometido ocupa o limite do grupo exatamente uma vez. Incorporações ao desenho (substituem o que conflitar em §5):

1. **Reserva transacional (P1, corrida).** Dois pedidos de R$ 7 mil com R$ 10 mil livres não podem ambos dar 🟢. `venda_gate_credito_v2` roda numa transação que trava a linha do grupo (`SELECT … FOR UPDATE` em `credito_limite`), relê exposição e limite, grava decisão e **reserva** em `credito_reserva` (por pedido + revisão). Retry reusa a reserva; edição reserva só o acréscimo; redução libera só após confirmação do Omie; timeout ambíguo do Omie mantém a reserva até reconciliar pela chave de integração.
2. **Trânsito = reserva, não status (P1).** Abandona-se "somar `sales_orders.enviado`" (o PV nasce `importado` e passa por `separacao`). Exposição = títulos abertos + reservas ativas. No faturamento, a reserva **transfere** para o título comprovado (empresa+PV+NF+parcelas), inclusive parcial — nunca solta antes do título chegar (saldo fictício) nem soma os dois (dívida dupla). Carga das reservas dos PVs preexistentes antes de ativar. OS da Afiação: fronteira própria (ver §10).
3. **Piso sobre o grupo inteiro e fail-closed (P1).** O piso vencido>60d passa a olhar **todos** os pares confirmados do grupo (hoje só o par do pedido — cliente vencido na SC passa comprando na Oben). Piso indeterminável (RPC falhou) **segura** o envio para nova tentativa em vez de liberar — muda o fail-open de `omie-vendas-sync/index.ts:2518`. Dívida comprovada prevalece sobre cadastro incompleto.
4. **Revisão imutável da operação (P1).** O que é avaliado é o que é enviado: grava-se uma revisão (itens, total, `codigo_parcela` efetivo por conta) e o envio usa ela. Conversão de orçamento sem parcela (`SalesQuotes.tsx:139` → `999`) resolve a condição efetiva antes do gate. Edição compara com o PV confirmado **antes** da 1ª mutação e reavalia também quando o **prazo** sobe com o total igual (hoje só total).
5. **Ausente na ingestão (P1).** O mapper de CR grava `0` quando falta valor (`omie-financeiro/index.ts:948`) → corrigir na origem (preservar `null`), reconciliar zeros legados, e o gate síncrono exige **cobertura e frescor do sync por empresa**; ficha crítica incompleta → 🟡 mesmo com limite. Teto de cliente novo só para cliente **comprovadamente** novo (sem nenhum título/PV histórico em nenhuma empresa). Compra média por cliente vem de faturamento por cliente, não de DRE agregado.
6. **Grupo = identidade comprovada + aliases ativos (P1; idem builder-check Q1).** Parte da identidade derivada pela edge (`index.ts:3132`), expande `customer_canonical_alias` com vínculo `active` (`inactive` ignora, `conflict` → 🟡), normaliza contas, deduplica títulos pela chave ERP. Grupo é **versionado**; mudança de composição reavalia limite e reservas. "Parcialmente consolidado" = existe par do pedido sem alias `active` resolvido, ou alias `conflict`.
7. **Solicitar ≠ autorizar (P1; builder-check Q2).** Entrar na fila cria **solicitação**; autorização é registro separado, exige `cap_credito_escrever` (`20260718190000_authz_capability_matrix_e2.sql:303`), amarrada à **revisão**, valor, prazo, motivo e validade. Aprovar estouro de limite **não** autoriza o piso (exceção do piso continua a de hoje). Revalida no despacho. "Aprovar com outro prazo" = o aprovador escolhe a `codigo_parcela` da lista da conta, gerando nova revisão. Edição posterior que aumente total ou prazo reabre a fila.
8. **Não sobrescrever status operacional (P1; builder-check Q3).** `aguardando_credito` vive na **revisão proposta**, não em `sales_orders.status` (a lista de orçamentos filtra `orcamento`, `SalesQuotes.tsx:54`; na edição o PV anterior continua válido). Edição 🟡 de PV já no Omie: o PV atual segue intacto, a alteração fica pendente e, aprovada, retoma `alterar_pedido`. Modo sombra grava só a decisão simulada e preserva o piso de hoje. Matriz de teste antes de ativar: submit, conversão, edição, retry × bundle antigo × checkout misto × aprovação repetida.
9. **Risco entra no veredito (P2).** Tabela de decisão explícita: `risco=alto` → 🟡 mesmo dentro do limite; `sem_evidencia` → 🟡. Proposta aplica-se por **versão** da ficha e do limite (aprovação antiga não desfaz redução recente). Redução automática só se nenhuma dimensão aumentar (é o 2º writer de `credito_limite`, declarado: RPC de aprovação + RPC de redução automática, ambas SECURITY DEFINER). **Anti-injection**: a IA (motor e recomendação) recebe só números, enums e flags — nunca razão social, observações ou texto livre do cliente.
10. **Sensores antes de ligar (P2).** Movem para o PR de sombra. Backtest: IA × regra-base nas mesmas fichas históricas, medindo decisões alteradas pelos cortes, atraso por R$ em safras **já vencidas** e taxa de liberação (2 semanas de sombra não maturam parcela de 90 d — a qualidade vem do backtest, a sombra mede distribuição de faixas e volume da fila). Ativação condicionada a: prova SQL em 2 sessões concorrentes, reconciliação sem diferença inexplicada, fila com responsável/alerta/retomada testados.

**Builder-check — resolvidas por mim [call]:** limite expira se a ficha ficar > 14 d sem recálculo bem-sucedido → pedido 🟡 ("limite desatualizado"); redução automática dispara em novo título vencido > 15 d e reduz para `max(exposição atual, sugerido pela IA)`; volta a subir só por nova proposta aprovada; degraus de prazo = 7/14/21/28/35/42/56/63/70/84/90/120 (os que existem nas parcelas Omie, confirmar na implementação).

## 10. Decisões do founder pós-revisão (2026-11-20)

- **[Lucas] Aprovador da fila 🟡 e das propostas de limite: só o Lucas.** Implementação [call]: autorização exige `cap_credito_escrever` **e** o usuário estar numa allowlist de aprovador de crédito (1 linha hoje: o Lucas) — não "qualquer master". Como ele vira o único caminho, o alerta de item parado (> 2 h) vai por notificação push/in-app para ele; a fila mostra contador no menu. Risco aceito: gargalo de venda quando ele estiver indisponível — sensor de "tempo até decisão" nasce no PR de sombra.
- **[Lucas] Transição: a trava nova só liga após a 1ª leva de limites aprovada.** Até lá vale só o piso (agora corrigido para o grupo inteiro e fail-closed — §9.3). Critério de ligar: 1ª leva revisada + condições de ativação do §9.10.
- **[Lucas] Apetite equilibrado:** K = 3× compra média mensal 180 d; cliente comprovadamente novo começa em R$ 5.000 e prazo ≤ 28 d. Calibrável depois pelo backtest.
- **[Lucas] OS da Afiação entra nesta entrega.** A OS que concede prazo passa pelo mesmo `venda_gate_credito_v2` e reserva limite no ponto em que concede o crédito (fronteira em `submitOrder.ts:615` — mapear na implementação se a OS gera título no Omie e quando, para a transferência reserva→título do §9.2). Entra no plano como PR próprio depois do enforcement de venda, mas dentro deste programa.

### Plano de entrega revisado (substitui §6)
1. **Correções do piso atual** (valem já, independente do resto): piso sobre o grupo inteiro + fail-closed + reavaliar edição quando prazo sobe + `null` na ingestão de CR. *Fecha furos que existem hoje.*
2. Banco: grupo versionado, `credito_limite`, `credito_limite_proposta`, `credito_reserva`, `credito_decisao_pedido`, solicitação/autorização, allowlist de aprovador (prove-sql PG17, incl. 2 sessões concorrentes).
3. Prazo em dias no SQL + override + revisão imutável da operação.
4. Edge `credito-ia-avaliar` (só números/enums/flags) + travas + `/credito/limites` para aprovar a 1ª leva. Sem efeito no pedido.
5. Gate v2 em **modo sombra** + reservas simuladas + sensores + backtest.
6. Fila `/credito/fila` + recomendação assíncrona + alerta ao Lucas; ligar enforcement da venda.
7. OS da Afiação no gate v2.
8. Painel de crédito.

Cada PR: 3 camadas de deploy (migration · edge · Publish) e review Codex no diff.
