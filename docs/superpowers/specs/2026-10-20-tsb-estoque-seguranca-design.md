# TSB no estoque de segurança — replay do motor de reposição nos intermitentes (Sayerlack)

> **Status:** aprovado pelo founder em 2026-10-21 (calibração contra o nível de F0 confirmada; custo de capital 25% a.a.) · branch `claude/tsb-estoque-seguranca`
> **Origem:** handoff do Lucas + brainstorming Claude, com 2ª opinião do Codex (gpt-6-astra, consulta de DESENHO com seção `RÉGUA:`) e do Sonnet. Números medidos em prod via `psql-ro` em 2026-10-20.
> **Money-path:** sim (`docs/agent/money-path.md`). A consulta Codex ADVERSARIAL no diff final ainda está pendente.
> **Próximo:** aprovação do Lucas → `superpowers:writing-plans`.

## 1. Intenção e porquê

O motor de reposição (`gerar_pedidos_sugeridos_ciclo`, roda a cada 2h) trata toda demanda como se fosse regular e gaussiana:

- a demanda é a **média simples de 90 dias**;
- o estoque de segurança é `ES = z·√(LT·σd² + d²·σLT²)`;
- o ponto de pedido é `PP = d·LT + ES`;
- o máximo é `PP + EOQ`. Na prática, isso é uma política (s,S).

Em SKU intermitente (vende em poucos dias, em quantidades irregulares), essa conta **infla os pedidos de 2 a 5 vezes**. **93% do valor dos pedidos sugeridos é "encher até o máximo"**. Além disso, a fórmula mistura dia corrido (demanda) com dia útil (LT).

A tese a testar: **no intermitente, prever com TSB e dimensionar por quantil empírico da demanda no período de proteção, sem EOQ, segura o mesmo atendimento com menos capital.** A hipótese pode ser derrotada. Se um comparador mais simples empatar, fica o simples.

**A v1 é só replay contra o histórico, em simulação. Ela não muda o motor em produção.** O resultado decide se vale ir para modo sombra.

### Preferências do Lucas que moldam a régua

| Pergunta | Resposta do Lucas | Efeito no desenho |
|---|---|---|
| Ruptura ou capital, o que dói mais? | "acredito que seja pior perder produto" | O serviço é piso duro. Capital só conta depois que o serviço passa. |
| O que acontece numa falta? | Troca embalagem, troca produto, pergunta se espera, compra fora. "a última coisa é deixar ele comprar em concorrente" | A falta raramente vira venda perdida. O replay modela três desfechos (§5.4). |
| Frequência de pedido Sayerlack | "faço pedido diário" | R = 1 dia útil. O EOQ perde o sentido: o frete é 2,5% fixo sobre a NF, sem custo fixo por pedido a amortizar. |
| Pedido avulso / mínimo | Pode pedir avulso. Os itens com mínimo do portal já têm `minimo_forcado_manual`, e o app avisa quando a quantidade está errada | O mínimo forçado é piso. O múltiplo de embalagem é regra separada. Os dois só se aplicam com necessidade positiva. |
| Parar de repor item parado? | "pode testar parar de repor, mas eu ficarei sabendo no momento da sugestão de compra?" | Em produção, o item parado aparece como linha visível com quantidade 0 e motivo (§8). No replay, só entram itens que ele confirmar. |
| Critério de GO | "não sei, me diga você" e depois "decida você, o Codex e o Fable" | A régua do §6 foi consolidada por Claude, Codex e Sonnet. O Fable estava sem crédito (429), e o Sonnet entrou no lugar. |

## 2. Metas, não-metas e anti-metas

**Metas (v1):**
1. Um simulador de replay walk-forward que reproduza, dia útil a dia útil, o estoque, os pedidos e o atendimento dos SKUs Sayerlack em 12 meses de histórico, sob quatro fórmulas de reposição (§5.3).
2. Um relatório com veredito **GO / NO-GO / INCONCLUSIVO** pela régua do §6, com intervalos de confiança das diferenças pareadas.
3. Uma lista dos itens "sem evidência para reposição automática", com o custo e o capital de cada um, para o Lucas decidir.

**Não-metas (v1):**
- Mudar o motor em produção (`db/embalagem-motor-rpc.sql`, RPC e views). Nada vai a `supabase/migrations/`.
- Outros fornecedores além da Sayerlack.
- Ajuste de α/β por SKU.
- Tela nova. O relatório é um artefato estático (markdown ou HTML) commitado ou publicado.
- Liquidar o estoque parado. Essa é uma decisão separada (§7).

**Anti-metas (o que seria errado entregar):**
- Ganhar em MAE ou erro de previsão e chamar isso de vitória. O sucesso se mede em **serviço, capital e custo total**.
- Afrouxar a régua para obter aprovação. Amostra insuficiente gera **INCONCLUSIVO**.
- Usar qualquer informação do futuro (§5.1).
- Fabricar número: ausente não é zero; SKU sem linha tem serviço "não observável", nunca 100%.
- Virar gate de CI ou máquina meta. O simulador é análise de decisão de produto, roda sob demanda e não entra no `validate`.

## 3. Números medidos (prod, `psql-ro`, 2026-10-20)

Todas as consultas rodaram com `-v ON_ERROR_STOP=1` e marcador `select 'fim','ok'`. Os SQL estão no scratchpad da sessão (`q1`–`q10`), e o plano os promove para o repositório.

**Escopo**
- Sayerlack no motor: **391 SKUs** (373 ativos, 276 com reposição automática habilitada, 27 com mínimo forçado). Outros 187 SKUs não têm fornecedor e ficam fora.
- Histórico de venda OBEN (`v_venda_items_history_efetivo`): **2025-10-21 a 2026-10-20**, 7.594 linhas, 563 SKUs. **Isso é o teto: 12 meses.**

**Classificação Syntetos-Boylan (série semanal; ADI > 1,32; CV² > 0,49), 374 SKUs Sayerlack ativos (venda 12m e estoque de hoje como 100%; absolutos só no Artifact privado — repo público, decisão do founder de 2026-10-15)**

| Grupo | SKUs | % da venda 12m | % do estoque hoje |
|---|---|---|---|
| Suave ou errático (todos classe A) | 13 | 43,5% | 16,7% |
| Intermitente ou lumpy | 237 | 54,5% | 69,8% |
| ≤ 1 semana com venda em 12m ("parados") | 124 | 1,8% | 13,5% |

Na série **diária**, todos os 374 são intermitentes. Por isso a classificação semanal é só diagnóstico (§5.3, parecer do Codex P1-6).

**Parados (124)**
- 107 C, 11 B, 6 A.
- 78 com saldo hoje; 68 sem nenhuma venda em 12m; 60 ainda com reposição automática ligada.
- **22 comprados nos últimos 90 dias**, com 3,7% do estoque Sayerlack (ex.: DILUENTE DN.4290LT comprado em 06/10; SAYERGLAZE CANELA e BASE BRILHO MÁXIMO em 14/10).
- Maior estoque parado: PRIMER BRANCO YL.4812.626EBA, 2,3% do estoque Sayerlack.

**Lead time Sayerlack (`sku_leadtime_history`)**
- A tabela tem **duplicatas**: 4.460 linhas, só 1.884 distintas.
- Depois de deduplicar por `(sku_codigo_omie, t1_data_pedido, quantidade_recebida)` com `t4` não nulo: n = 1.656, média **9,55 du**, desvio 3,39, p50 10, p90 14, **p95 15**, **máximo 29 du**.

**Reconstrução retroativa do estoque** (`estoque_fim_d = saldo_hoje − Σ eventos após d`; eventos = −vendas + recebimentos deduplicados)
- Recebido 6.842 contra vendido 7.856 em 12m.
- A conta **fecha em 84% dos SKUs**. Os outros **16% ficam negativos em algum dia** (12,4% abaixo de −2), o que indica fluxos não registrados (ajuste de inventário, devolução, transferência). Esse é o **erro medido do simulador** e vira cenário de inicialização (§5.2).
- Não existe tabela de histórico diário de estoque. A reconstrução é a única fonte.

**Contexto financeiro**
- CCC ≈ 102 dias.
- 1 dia de CMV da empresa inteira ≈ 2,9% do estoque Sayerlack de hoje. **Não é DIO Sayerlack**: o DIO Sayerlack usa CMV Sayerlack.

## 4. Restrições

- **Não tocar `supabase/migrations/`** (regra de DR). O replay só **lê**.
- Leitura direta por `~/.config/afiacao/psql-ro`. Os extratos ficam fora do repositório se contiverem dado de cliente (nome e CNPJ não entram no simulador; só SKU, data, quantidade, valor e CFOP).
- A unidade decisória **não é universalmente "nº de embalagens"**: `db/embalagem-motor-rpc.sql:488` converte 36 L → 8 baldes → `qtde_final = 40 L`. O simulador precisa do contrato de unidade por SKU (§5.5).
- O motor atual tem um teto de cobertura pós-compra para B/C (flag por empresa em `company_config.reposicao_teto_cobertura_<empresa>_*`) que só corta acima do PP. A fórmula "atual" no replay preserva esse teto.
- `src/lib/reposicao/compras-otimizador-helpers.ts:23` trata o mínimo forçado como piso. O replay segue a mesma semântica.

## 5. Desenho do replay

### 5.1 Linha do tempo (walk-forward)

Com 12 meses de histórico:

```
| 3 meses aquecimento | 3 meses calibração | 6 meses avaliação intocada |
  nov/25 – jan/26       fev/26 – abr/26      mai/26 – out/26
```

- **Aquecimento:** os estados das fórmulas (médias, TSB, janelas de quantil) acumulam histórico. Nada é medido.
- **Calibração:** escolhe-se **um** conjunto global de parâmetros por fórmula (β do TSB; janela do quantil; z equivalente). Depois disso, os parâmetros **congelam**.
- **Avaliação:** os 6 meses finais medem o resultado. Nenhum parâmetro é tocado aqui.

**Proibido usar o futuro:** classificação ABC/XYZ atual, "parado em 12 meses" calculado retrospectivamente, tamanhos de demanda posteriores ao dia simulado, LT de pedidos ainda não recebidos naquela data. A classificação usada em cada dia simulado é recomputada com os dados até a véspera.

**O limite de 12 meses é estrutural.** Seis meses de avaliação dão poucos blocos longos de reamostragem, e os intervalos ficam largos. Se ficarem largos demais, o veredito é INCONCLUSIVO, e a decisão vira "repetir com mais histórico" ou "ir para sombra e medir de verdade" (escolha do Lucas no relatório).

### 5.1.1 População e classe

- **População do replay (coorte fixada no corte de 2026-05-01):** SKUs Sayerlack, `ativo`, **com reposição automática habilitada** (276), menos os parados (§7) e menos os SKUs sem contrato de unidade (§5.6). Os parados são definidos com o que se sabia **antes do corte**: ≤ 1 semana com venda nas **27 semanas** observadas antes de 01/05/2026. Essa cobertura é declarada; semana anterior ao início do histórico é "não observada", não zero. O flag de reposição automática só existe no valor de hoje e pode ter sido desligado justamente por mau desempenho na avaliação. Isso é **seleção retrospectiva**: a conclusão vale para "a coorte habilitada hoje" e **não é confirmatória**. O relatório repete o veredito com todos os SKUs ativos (sensibilidade). Se o veredito mudar, ele é INCONCLUSIVO.
- **Empresa:** só OBEN (é quem compra no portal Sayerlack). Primeiro passo do plano: medir a venda e a transferência dos mesmos SKUs nas outras duas empresas. Se passar de 5% das linhas ou do valor, a spec volta para revisão antes de simular.
- **Classe ABC do dia:** reproduz a regra versionada. A proposta vem do Pareto por empresa em `v_sku_classificacao_abc_xyz`, sobre **todo o universo OBEN** e não só sobre a coorte; a aplicação, com histerese, vem de `atualizar_classificacao_skus`. Tudo é recalculado com dados até a véspera, na cadência de produção. O `z` do F0 sai da **configuração de z por classe** aplicada à classe do dia, **nunca** do `z_aplicado` de hoje, que embute a classe atual. `classe_forcada` é respeitada como decisão humana (sem histórico de vigência; limitação declarada). A validação compara a classe recalculada de hoje com `sku_parametros.classe_abc`, **por classe e ponderada por valor**. Divergência em mais de 5% do valor A interrompe o trabalho até ser explicada.
- **Papel da classificação semanal Syntetos-Boylan:** ela **é operacional**, porque decide a coorte "alterada" (os SKUs que trocam de fórmula). Fica fixada no corte, com dados antes de 01/05/2026, por intenção de tratar: um SKU que muda de regime na avaliação continua na sua coorte. Ela não autoriza gaussianidade. Por isso os suaves também aparecem com F1–F3, só como informação.

### 5.2 Estado inicial

- O estoque físico no início do aquecimento vem da reconstrução retroativa (§3).
- Nos **84% que fecham**, usa-se a reconstrução.
- Nos **16% que não fecham**, roda-se em cenários de inicialização (por exemplo, piso zero e "o mínimo que evita negativo"), e o relatório mostra quanto o resultado depende disso.
- O saldo de hoje serve só como conferência de plausibilidade, nunca como denominador.

### 5.3 As quatro fórmulas comparadas

Todas usam a mesma **revisão diária (R = 1 du)** e a mesma posição: `posição = físico + compras abertas − obrigações (backlog)`. O gatilho é diferente:
- **F0** reproduz a **decisão completa do motor** sobre o estado de cada replicação. Compra se `posição ≤ PP`, até o máximo; o teto de cobertura B/C é aplicado sobre a posição realizada, com os mesmos `floor/ceil`, e **não** se aplica quando há mínimo forçado ou grupo de embalagem (`db/embalagem-motor-rpc.sql:~440-500`). Os parâmetros (PP, máximo, cobertura do teto, demanda da linha) são pré-computados; a decisão roda no estado.
- **F1–F3** compram se `posição < S`, até `S`.
- Em todas, o piso de mínimo forçado e o múltiplo de embalagem vêm depois, nessa ordem e só com necessidade positiva.
- **Grupo de embalagem:** o motor consolida SKUs do mesmo produto em embalagens diferentes (36 L → 8 baldes). O primeiro passo mede quantos SKUs da coorte estão em grupo e quanto valor eles têm. Se houver algum, F0 reproduz a consolidação e F1–F3 calculam o nível na unidade-base do grupo, convertendo a compra pela mesma regra do motor. A consolidação de **compra** é separada da substituição no **atendimento** (§5.7).

| # | Fórmula | Para que serve |
|---|---|---|
| F0 | **Atual**: média 90d + ES gaussiano + PP + EOQ, recalculada rolando dia a dia, preservando teto B/C, mínimos e equivalências | Baseline. Todos os deltas são contra ela. |
| F1 | **Média 90d + order-up-to sem EOQ**: S = quantil gaussiano da demanda em LT+R | Separa ganho de **política** (tirar o EOQ) de ganho de **previsão**. Se F1 empatar com F2/F3, o TSB não se justifica. |
| F2 | **Probabilidade TSB + distribuição empírica de tamanhos**: S = quantil da demanda em LT+R, simulada por Bernoulli(p̂ TSB) × tamanho sorteado do histórico de totais de dias positivos | A tese. O nome é honesto (parecer do Codex P1-5): o α só participa se o tamanho suavizado entrar na conta. |
| F3 | **Quantil empírico em janela deslizante** da soma da demanda em LT+R (bootstrap da série diária) | Comparador não paramétrico. |

**Parâmetros:**
- TSB: α = 0,10 e β ∈ {0,005; 0,01; 0,02}, um conjunto global escolhido na calibração e sem ajuste por SKU (parecer do Codex P1-6). São candidatos de experimento, não valores validados.
- Calendário operacional diário explícito: fim de semana fechado não conta como "dia sem demanda", e venda efetiva em sábado não some. O LT em dias úteis é convertido em datas reais.
- O quantil-alvo de cada fórmula é calibrado por classe, na janela de calibração, até o fill rate medido bater **`alvo = max(piso da classe, fill rate de F0 na calibração − 0,25 p.p.)`**. A meia tolerância (0,25 de 0,5 p.p.) é margem para a avaliação. **O quantil não é o fill rate**: o alvo é ajustado pelo fill rate medido. Mirar só o piso faria F1–F3 perderem serviço de propósito e garantiria o NO-GO pelo critério 2.
- **Fronteira (informativa):** para F2 e F3, o relatório mostra também a curva capital × fill rate (alvos de 90% a 99,5%). Assim o Lucas vê quanto capital custa cada décimo de serviço, mesmo que o GO use só o ponto acima.

**Classificação:** os 13 suaves/erráticos continuam na fórmula atual em todas as variantes (só os intermitentes trocam de fórmula). Como a série diária é toda intermitente, o relatório mostra também F1–F3 aplicadas aos 13, só como informação.

### 5.4 Falta: três desfechos

A demanda do replay é a linha faturada histórica. Quando o estoque simulado não cobre a linha, ela tem um destes três desfechos:

1. **Espera (backorder):** a linha fica como obrigação e é atendida na próxima chegada. Conta **linhas-dias de atraso**.
2. **Compra emergencial:** a linha é atendida por compra fora, com custo extra por linha. Ela sai do backlog (não conta duas vezes).
3. **Cancelamento:** venda perdida.

As proporções vêm de cenários (o Lucas disse que a falta raramente vira venda perdida). A fórmula nova precisa **passar nos dois extremos**: 100% espera e 100% cancelamento. A penalidade de compra emergencial é testada em 2–3 valores.

Regras de contagem (parecer do Codex P1-7):
- Cada linha falha **uma vez** no denominador original. Atender depois não transforma falha em sucesso.
- O backlog terminal permanece como obrigação no balanço final e não some na borda da janela.
- A previsão é atualizada com a demanda na data original, não de novo quando o backlog é entregue.

### 5.5 Lead time

Três cenários, com as fórmulas entrando **com parâmetros congelados** (sem recalibrar depois de conhecer o choque):

1. **Empírico deduplicado**, sorteado por **pedido** (não por linha), preservando a dependência entre itens do mesmo pedido.
2. **Estresse** `max(LT_sorteado, 15 du)`, que preserva a cauda de 16–29 du.
3. **Choque comum de 29 du** em um período predefinido: mostra exposição e necessidade de contingência, sem exigência de economia.

A dedup e a auditoria de pedidos ainda abertos (que podem faltar na amostra justamente por estarem atrasados) entram no plano.

### 5.6 Contrato de unidade por SKU

Antes de simular, cada SKU precisa de um contrato que ligue: unidade da NF de venda, unidade do estoque, CMC, unidade Omie e embalagem do fornecedor. SKU sem contrato coerente **sai do replay** e é listado (não se adivinha conversão). Uma conversão errada fabrica serviço e economia ao mesmo tempo.

Venda fracionada (litros de um galão, por exemplo) **não exclui o SKU**: o estoque é simulado na unidade de estoque, que é contínua, e a compra arredonda para a embalagem do fornecedor. O SKU só sai se a conversão NF → estoque for incoerente. O relatório mostra quanto do valor A ficou fora por falta de contrato.

### 5.7 Métricas

**Serviço** ("atendimento das linhas faturadas observadas" — o nome é obrigatório, porque a demanda é censurada):
- **fill rate por linha** = Σ linhas integralmente atendidas no dia ÷ Σ linhas demandadas, por classe. **Nunca média de percentuais por SKU.**
- Também em unidades e em valor.
- **Exato** separado de **com substituição de embalagem**. A substituição exige equivalência cadastrada, quantidade suficiente e baixa do estoque substituto (o mesmo galão não salva duas linhas).
- As mesmas métricas **só na população cuja fórmula mudou**, para que os 13 suaves não escondam os intermitentes A.
- SKU sem linhas na janela = "não observável".

**Capital:**
- Estoque físico médio a CMC, com redução contra o **estoque médio de F0 no replay** (não o saldo de hoje).
- DIO Sayerlack com CMV Sayerlack.
- Compras abertas e backlog expostos separadamente.
- **Balanço terminal:** estoque final, compras abertas e obrigações. Comprar menos na janela pode ser só consumo do estoque inicial.

**Custo total:** custo de capital evitado (taxa em cenário) − custo de emergências − custo de atraso. O relatório mostra o **custo de falta de equilíbrio**: o custo máximo por falta adicional que ainda mantém a mudança vantajosa.

### 5.8 Estatística

- **200 replicações pareadas** com **choques comuns** indexados por calendário e fornecedor (reutilizar a mesma semente não basta se as fórmulas consomem sorteios em ordens diferentes). Aumentar até a meia largura do erro Monte Carlo ficar em ~0,1 p.p. no serviço e ~1 p.p. no estoque.
- Incerteza histórica: bootstrap em blocos de **4 e 8 semanas** (sensibilidade). Janelas sobrepostas não contam como réplicas independentes.
- Incerteza estrutural (demanda censurada, estado inicial, comportamento na falta) aparece como cenários, não como intervalo.
- Os intervalos são das **diferenças pareadas** contra F0.

### 5.9 Contratos do replay (revisão adversarial do Codex, 2026-10-21)

Estes contratos fecham as escolhas que deixariam dois construtores com vereditos diferentes. Onde houver conflito, eles prevalecem sobre §5.1–§5.8.

**Calendário.** O dia útil de produção é segunda a sexta, sem feriados (`public.dias_uteis_entre` não tem feriado). Há dois calendários:
- **calendário de LT e de revisão:** só os dias úteis, gerados explicitamente, nunca via `dias_uteis_entre(d, d+1)`, que devolve 0 para a sexta;
- **dias de atendimento:** dias úteis ∪ dias com venda efetiva (sábado com NF).

O capital médio é **ponderado pelos dias corridos** em que cada saldo permanece.

**Lead time.**
- *Dedup:* por **identidade documental** (`tracking_id` + empresa + SKU), como `v_sku_leadtime_efetivo` e a fixture `db/fixtures/hoje-sp-data-ciclo-prod-20261001.sql:313`. A chave `(sku, t1, quantidade)` da medição inicial pode fundir recebimentos legítimos e fica só como conferência.
- *Recebimento parcial:* o LT do item é o `t4` do recebimento que completa ≥ 95% da quantidade pedida. Se nunca completar, o item é tratado como **aberto**.
- *Censura:* um pedido aberto entra na amostra com `LT = max(du decorridos até a extração, 15)`. Isso é imputação conservadora e faz parte da amostra do veredito.
- *Sorteio:* para cada dia `d` e replicação, sorteia-se **um documento histórico** com `t1` a ±10 du de `d` (candidatos em ordem estável `(t1, tracking_id)`; sem candidato, a janela dobra até achar). Cada SKU pedido em `d` recebe o LT de um item **desse mesmo documento**, sorteado por `(rep, d, sku)`. O choque do fornecedor fica preservado sem impor um LT escalar a todos.
- *Calibração:* só usa documentos com `t4` (ou a data de extração, se aberto) **≤ fim da calibração**. Realizações posteriores só existem no ambiente da avaliação.
- *LT exógeno:* o LT estimado pelas fórmulas aprende só com recebimentos históricos com `t4 < d`, nunca com chegadas simuladas. Essa hipótese é o que permite pré-computar os níveis uma vez para todas as replicações.

**Estado inicial.** A reconstrução contábil é a base. Nos SKUs que não fecham, o ajuste "mínimo que evita negativo" é calculado **só com eventos até o fim da calibração**. Um negativo que aparece só na avaliação é reportado como erro do simulador, não ajustado. O veredito é computado com `reconstruido+ajuste` e com `piso_zero`; se mudar, fica INCONCLUSIVO. Alterar dados da avaliação não pode mudar nada da calibração, inclusive o estado inicial (teste de ponta a ponta).

**Obrigações por linha.** Cada linha carrega seu saldo restante. Acumulam-se, separadamente:
- entregue **imediata**, **tardia** e **emergencial**;
- **cancelada** (valor e margem = valor − CMC × quantidade);
- **valor × dias de atraso**, linha a linha, nunca `linhas-dias × valor médio`.

Fechamento obrigatório por SKU e por janela: demanda = imediata + tardia + emergencial + cancelada + backlog terminal. **Tratamento econômico terminal comum:** o backlog que sobra no fim é custeado como se fosse atendido por compra emergencial no último dia, mais o atraso até lá.

**Equações.**
- **F1:** `d̄` e `σd` sobre os últimos 63 dias úteis antes de `d`, com zeros; `LT̄` e `σLT` dos recebimentos `t4 < d` do SKU se houver ≥ 5, senão da Sayerlack toda; `H = LT̄ + 1`; `S = ceil(H·d̄ + z_q·√(H·σd² + d̄²·σLT²))`.
- **F2:** TSB diário nos dias úteis; inicialização com `p̂₀` = fração de dias positivos e `ẑ₀` = média dos tamanhos positivos nos primeiros 63 du disponíveis; 2.000 trajetórias de `LT + 1` du; quantil empírico tipo 7 (interpolação linear) e depois `ceil`.
- **F3:** `H = ceil(LT̄) + 1`; somas de blocos contíguos de `H` du dentro de `janelaDias` du antes de `d`; quantil tipo 7 e `ceil`.
- **Histórico insuficiente** (< 2 dias positivos até a véspera): todas as fórmulas usam F0 naquele SKU-dia, então não há diferença a medir.

**Calibração.** Não usa busca binária: o contraexemplo do Codex (múltiplo 2, LT de 3 du num dia) mostra que o serviço **não é monotônico** no nível. A calibração usa uma grade fixa de quantis `{0,50; 0,60; 0,70; 0,80; 0,85; 0,90; 0,925; 0,95; 0,96; 0,97; 0,98; 0,985; 0,99; 0,995; 0,999}`:
- faz descida por coordenada (uma classe por vez, duas rodadas) e depois **valida as três classes juntas** no trio final;
- escolhe o trio de menor estoque médio que atinge o alvo nas três classes;
- desempata pelo menor quantil;
- **inviável** (nenhum ponto atinge o alvo) tira a fórmula da disputa; se as três forem inviáveis, o veredito é NO-GO, com motivo `INVIAVEL_NA_CALIBRACAO`;
- classe não observável na calibração gera INCONCLUSIVO.

A fórmula candidata é a de menor estoque médio que atinge o alvo. Se outra mais simples (F1 < F3 < F2) ficar a ≤ 1 p.p. de capital dela, fica a mais simples.

**Bootstrap.** O que se transporta são **somas pareadas por semana e por replicação**: linhas demandadas e atendidas por célula, estoque × dias, custos. Cada reamostragem (blocos circulares de semanas, os mesmos para as duas políticas) **recalcula** as razões, diferenças e reduções relativas. Média de razões semanais é proibida. Saem LI e LS.

**Precisão e cache.**
- A precisão é **congelada antes da seleção**: 2.000 trajetórias em F2, 2.000 reamostragens no bootstrap.
- A chave do cache inclui o hash dos CSVs, o hash do código de `scripts/reposicao-replay/`, o calendário e a precisão. Tudo isso aparece no relatório.
- Atingir o teto de 1.000 replicações sem a meia largura alvo gera INCONCLUSIVO.

## 6. Critério de decisão

A fórmula candidata (uma só, entre F1–F3) é **escolhida e congelada na calibração** (§5.9), nunca na avaliação. Para **GO**, todas as condições juntas, na janela de avaliação:

1. **Pisos de serviço:** A ≥ 98%, B ≥ 95%, C ≥ 90%, sustentados pelo **limite inferior unilateral de 95%**.
2. **Não inferioridade:** queda ≤ **0,5 p.p.** contra F0 em A, B e C **e separadamente em A-alterados, B-alterados e C-alterados**, também pelo limite inferior de 95%. Um agregado "alterados" sozinho deixaria a melhora de B/C esconder a perda nos intermitentes A. (Passar de 99% para 98,5% aumenta as faltas em 50%. Por isso a tolerância não sobe.)
3. **Capital:** redução ≥ **10%** do estoque médio de F0, com limite inferior ≥ **5%**.
4. **Estresse `max(LT,15)`:** as mesmas tolerâncias de serviço, com redução de capital positiva.
5. **Economia líquida positiva** depois das faltas, em **toda a grade de custos**: taxa de capital **25% a.a.** (custo de captação de capital de giro hoje, segundo o Lucas; acompanha a Selic, com sensibilidade em 20% e 30%) × penalidade de compra emergencial em 5%, 10% e 20% do valor da linha × custo de atraso por linha-dia em 0, 0,5% e 1% do valor da linha. O relatório também mostra o custo de falta de equilíbrio. R$ 20k liberados não são R$ 20k de lucro: a 20% a.a., viram ~R$ 4k/ano de custo de capital evitado.

As condições de serviço (1, 2 e 4) valem nos dois extremos de falta (100% espera e 100% cancelamento). A condição econômica (5) vale num cenário **com emergências fixado previamente** (60% espera, 30% compra emergencial, 10% cancelamento) **e** nos dois extremos. Sem esse cenário, a grade de custo emergencial seria inócua.

### 6.1 Tabela de decisão

Cada critério recebe **PASSA**, **FALHA** ou **INCERTO**. LI e LS são os limites unilaterais de 95% do bootstrap pareado (§5.8). Com blocos de 4 e de 8 semanas, usa-se `LI = min(LI4, LI8)` e `LS = max(LS4, LS8)`: o desacordo entre blocos gera incerteza, nunca refutação.

| Critério | PASSA | FALHA | INCERTO |
|---|---|---|---|
| 1 Piso da classe | LI ≥ piso **e** limite exato (Clopper-Pearson sobre as linhas) ≥ piso | LS < piso | resto |
| 2 Não inferioridade (6 células) | LI(Δ) ≥ −0,5 p.p. | LS(Δ) < −0,5 p.p. | resto |
| 3 Capital | ponto ≥ 10% **e** LI ≥ 5% | LS < 10% | resto (ex.: 9% em [8%, 11%]) |
| 4 Estresse | serviço como em 1 e 2; LI(redução) > 0 | serviço em FALHA ou LS(redução) ≤ 0 | resto |
| 5 Economia | LI(custo líquido) > 0 em toda célula da grade | LS < 0 em alguma célula | resto |
| Exposição | ≥ 300 linhas na avaliação em cada célula de 1 e 2 | — | célula abaixo disso, ou `null` |
| Precisão | meia largura MC dentro do alvo | — | teto de 1.000 replicações atingido sem precisão |
| Estado inicial | o mesmo veredito nos estados iniciais plausíveis (§5.2) | — | o veredito muda entre eles |

Precedência:
- **NO-GO** se algum critério FALHA. Cada FALHA é uma refutação individual a 95%; o NO-GO **não** promete confiança conjunta.
- Senão, **INCONCLUSIVO** se algum critério estiver INCERTO ou sem dado.
- Senão, **GO**. Exigir todos os componentes juntos (interseção-união), com a candidata fixada antes, controla o GO falso a 5%.

**A régua nunca é afrouxada.**

Um GO autoriza **modo sombra e piloto em coorte** (§8), não a troca do motor.

## 7. Itens "sem evidência para reposição automática"

Os 124 parados não têm dados para estimar uma cauda individual: "uma única observação reamostrada mil vezes continua sendo uma única observação" (Codex P1-10).

- Eles saem do replay de fórmula e viram uma **categoria própria**, com lista, estoque a CMC, data da última venda e da última compra, e status da reposição automática.
- **Reconciliar antes de qualquer teste:** os **22 comprados nos últimos 90 dias** (encomenda? lançamento? substituição de código? componente de kit? item estratégico?) e os **6 classe A** (de onde veio a classe A?).
- O teste "parar de repor" só roda nos itens que o **Lucas confirmar** como elegíveis. Os demais ficam como exceções explícitas.
- **O teste não faz parte do pronto da v1.** A v1 entrega a lista reconciliável e fecha sem esperar a confirmação do Lucas. O teste de parar vem depois, numa entrega própria.
- **Parar de comprar não libera o estoque dos parados (13,5% do estoque Sayerlack).** Sem venda, transferência ou liquidação, o capital continua parado. A liquidação é uma decisão separada, fora desta entrega.

## 7.1 Promoções do fornecedor (fora da v1, regra registrada)

A Sayerlack manda todo mês um e-mail com descontos sobre vários produtos. Hoje isso não entra no módulo de compras. Comprar a mais na promoção é uma **decisão diferente** da reposição: a reposição dimensiona o estoque de proteção, e a promoção decide se vale antecipar compra.

- **Fora da v1:** não há histórico estruturado das promoções, então o replay não consegue simulá-las. A comparação continua justa, porque nem F0 nem F1–F3 modelam promoção.
- **Regra de equilíbrio, para quando virar funcionalidade:** antecipar `k` dias de demanda vale a pena se `desconto > taxa_capital × k / 365 + risco de obsolescência`. A 25% a.a., cada mês extra de estoque custa ≈ **2,1%** do valor. Um desconto de 5% paga até ~2 meses de cobertura extra, **se a demanda vier**.
- **Nos intermitentes, a demanda é o risco:** a cobertura extra deve ser calculada sobre a previsão TSB (que decai quando o item para de vender), e não sobre a média de 90 dias. Caso contrário, a promoção vira a próxima leva de estoque parado (§7).
- **Pré-requisito:** capturar o e-mail de promoção como dado (SKU, desconto, validade). Isso é entrega própria, depois da v1.

## 8. Produção (fora da v1, registrado para não perder)

Só depois de um GO, e em degraus, cada um exigindo sinal do anterior:

1. **Modo sombra:** a fórmula nova calcula ao lado da atual, sem comprar. Começa a registrar pedido original, data desejada e substituições, ou seja, a evidência que a NF histórica não tem. (A sombra observa o atendimento com o estoque da política vigente; ela não prova o contrafactual.)
2. **Piloto em coorte:** demanda observável, baixa criticidade, equivalências verificadas, sem pendência de "parado". Piso de **30 dias úteis** (2× o p95 do LT) **e** volume de linhas suficiente; o prazo sozinho não aprova o degrau.
3. **Item parado na sugestão:** aparece como **linha visível com quantidade 0 e o motivo**, com override de um clique, e sai do estado sozinho se voltar a vender. Provável lugar: `v_reposicao_sku_fora_do_motor`. Isso responde à pergunta do Lucas ("eu ficarei sabendo no momento da sugestão de compra?"): sim.

## 9. Pareceres

### Codex (gpt-6-astra, max, consulta de DESENHO com `RÉGUA:`, 350 s, exit 0)

> **"Veredito: REPROVA o critério de GO/NO-GO tal como está. Aprova a v1 de replay com esses ajustes."**

O parecer tinha 3 P0, 9 P1 e 2 P2. Todos foram incorporados:

| Achado | Onde entrou |
|---|---|
| P0-1: unidade decisória (36 L → 40 L) e mínimo como piso | §4, §5.6 |
| P0-2: NF mede o faturado, não o pedido (demanda censurada) | nome da métrica §5.7; registro na sombra §8 |
| P0-3: vazamento temporal além do quantil | §5.1 |
| P0-4: estado inicial desconhecido; o saldo de hoje não valida o simulador | §5.2 |
| P1-5: nome honesto do TSB + tamanhos empíricos | F2, §5.3 |
| P1-6: classificação semanal só como diagnóstico; α/β e calendário | §3, §5.3 |
| P1-7: três desfechos; cada linha falha uma vez; backlog terminal | §5.4 |
| P1-8: LT por pedido; `max(LT,15)`; choque de 29 du | §5.5 |
| P1-9: soma de linhas, população alterada, substituição exata vs. com troca | §5.7 |
| P1-10: categoria "sem evidência"; o estoque parado não se libera | §7 |
| P1-11: 200 replicações pareadas, choques comuns, blocos de 4/8 semanas | §5.8 |
| P1-12: denominador = estoque médio do baseline; DIO Sayerlack; balanço terminal; R$ 20k ≠ lucro | §5.7, §6 |
| P2-13: comparador média 90d sem EOQ | F1 |
| P2-14: C primeiro ≠ menor risco; sombra não testa o contrafactual; piso de 30 du | §8 |

**Consulta ADVERSARIAL (gpt-6-astra, max, 1.056 s, 166k tokens), sobre spec e plano: "Veredito: REPROVA"**, com 15 P1 e 3 P2, sem P0. Todos foram incorporados: §5.1.1 (coorte no corte, seleção retrospectiva, ABC versionado, z por classe, papel da SB), §5.3 (decisão completa do F0, teto B/C, grupo de embalagem), §5.9 (calendário, LT documental/censura/corte, estado inicial, obrigações por linha, equações, grade não monotônica, bootstrap por somas, precisão e cache) e §6/§6.1 (células classe × alterados, cenário com emergências, tabela de decisão). O parecer completo é anexado ao PR.

A régua do Codex foi adotada quase integralmente. A exceção: ele sugeriu não exigir 10% de economia em toda janela mensal. Aceito; as janelas mensais aparecem só como diagnóstico de concentração das falhas.

### Sonnet (2ª opinião independente; substituiu o Fable, que falhou com 429 por falta de crédito)

Convergiu com o Codex no desenho do replay e no critério. **Divergência rejeitada:** aceitar queda de até **−1,0 p.p.** em B/C. Mantive **0,5 p.p. em todas as classes**, porque o Lucas disse que perder produto dói mais que capital, e 1 p.p. a 95% significa 20% a mais de faltas.

## 10. Limites conhecidos (o que este replay não prova)

- **12 meses de histórico:** 6 meses de avaliação, poucos blocos longos, intervalos largos.
- **Demanda censurada:** a NF mostra o que foi faturado, quando e em qual SKU. A espera, a substituição e a venda perdida originais não aparecem. O resultado é condicional ao faturado.
- **16% dos SKUs não fecham** na reconstrução de estoque.
- **Duplicatas em `sku_leadtime_history`** (4.460 linhas, 1.884 distintas). Sem dedup, o recebido sai 2,3× o vendido. Isso também pode afetar o motor de produção, que computa LT dessa tabela para `sku_parametros`. O construtor verifica se o cálculo de produção deduplica, e o achado é anotado em `docs/agent/reposicao.md`. Se for bug de produção, ele entra como item separado, fora desta entrega.
- **O replay não mede a operação real** (tempo de separação, aceitação do cliente à troca). Isso cabe à sombra e ao piloto.

## 11. O que fica para o construtor (plano)

- Onde o simulador vive e em que linguagem (sugestão: TypeScript sob `scripts/reposicao-replay/`, com teste vitest das peças puras, extraindo os dados via `psql-ro` para arquivos locais fora do repositório).
- Promover as consultas `q1`–`q10` para o repositório com o padrão `ON_ERROR_STOP` + marcador.
- Como recalcular F0 rolando sem chamar o RPC de produção (reimplementação fiel, validada contra o `estoque_seguranca` e o `ponto_pedido` de hoje em `sku_parametros` como teste de paridade).
- Formato do relatório final (tabela por classe × fórmula × cenário, intervalos, veredito).
- Consulta Codex ADVERSARIAL no diff final, via `scripts/codex-async.sh` em background.
- Registro em `docs/historico/` ao concluir.
