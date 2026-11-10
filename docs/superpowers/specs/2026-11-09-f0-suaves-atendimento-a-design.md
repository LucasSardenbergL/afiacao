# F0 dos SUAVES — o gargalo de atendimento da classe A (design, sem implementação)

> **Status:** desenho, 2026-11-09. Nada de código de produção, migration, edge nem `db/embalagem-motor-rpc.sql` nesta fase.
> **Ponto de partida:** NO-GO oficial do replay TSB, `INVIAVEL_NA_CALIBRACAO` (PR #3411, `c8fcaae78`). Histórico em [reposicao-replay-tsb.md](../../historico/reposicao-replay-tsb.md) e spec mãe em [2026-10-20-tsb-estoque-seguranca-design.md](2026-10-20-tsb-estoque-seguranca-design.md).
> **Money-path:** sim, porque decide quanto estoque comprar. A 2ª opinião do Codex está na §8.
> **Repositório público:** este documento usa só percentuais e contagens. Os R$ ficam em `$REPLAY_DADOS`.

## 1. Intenção e porquê

Na calibração (01/02 a 30/04/26), o F0 atende **90,66%** das 400 linhas de A dos 12 SKUs suaves da coorte Sayerlack/OBEN, contra um piso de 98%. Pela spec mãe (§5.3), os suaves ficam no F0 em todas as variantes, então nenhuma fórmula de intermitente levava a célula A ao piso.

Este documento faz três coisas:

1. mede **de onde vem** a falha dos suaves de A;
2. propõe alternativas para o F0 desses SKUs;
3. define como medir cada alternativa **no próprio replay, sem afrouxar a régua**: piso de 98% em A, medido na célula da classe inteira.

**O achado que reorganiza o problema** (§2.4): mexer só nos suaves **não basta**. Mesmo com os suaves a 100%, a célula A chega a no máximo **95,75%**. Isso porque 324 das 724 linhas de A são de intermitentes, que o F0 atende a 90,49%. Qualquer mudança nos suaves só pode ser julgada como **pacote**, junto com a fórmula dos intermitentes.

## 2. Diagnóstico quantitativo

**Método.** São contrafactuais rodados no próprio simulador da main (`scripts/reposicao-replay/`, `3a93ef075`):

- só os parâmetros do F0 dos 12 suaves mudam; o resto do mapa é o oficial, byte a byte;
- mesmo contexto da calibração oficial: 50 réplicas, LT empírico, falta = espera, estado reconstruído;
- o PP e o máximo são recalculados com a fórmula da view (`ss = ⌈z·√(LT·σd² + D²·σLT²)⌉`, `PP = max(⌈D·LT + …⌉, max(ss, mín. op.) + 1)`, `máx = PP + EOQ`), trocando só o insumo de cada fator.

**Controle verde na mesma invocação.** O recálculo sem trocar nada (`D0L0U0`) reproduz o oficial: 90,66% × 90,66%, |Δ| = 0,00 p.p. Simular só os suaves também repete o fill deles (90,66%), o que prova que os SKUs não interferem entre si. As linhas de A contadas pelo script batem com a célula do simulador (724 = 724). Se não batessem, o script sai com rc = 3.

**Falsificação do controle** (10 réplicas, controle verde na mesma invocação):

- sabotar o z do recálculo em −5% faz o controle divergir 0,85 p.p. (89,42% × 90,28%). O controle é genuíno, não idêntico por construção;
- sabotar o piso `PP ≥ max(ss, mín. op.) + 1` **não** muda nada (|Δ| = 0,00). Essa camada é inalcançada nos suaves (o `⌈D·LT + z·σ⌉` sempre fica acima dela) e fica registrada como tal.

Os dados são os da rodada oficial, `~/.cache/afiacao/reposicao-replay-2026-11-09/` (hashDados `f4704d895c47…`). O script e a saída completa estão na §9.

### 2.1 Quem falha e quando

As falhas esperadas por réplica somam **37,4 de 400 linhas**, e quase metade vem de um SKU só:

| SKU | linhas A | falhas/rep | fill F0 | semanas com falha (início) |
|---|---:|---:|---:|---|
| 8689717792 | 71 | 15,2 | 78,62% | 01/02 (2,0) · **29/03 (4,3)** · **05/04 (4,6)** · 12/04 (1,5) |
| 8689731502 | 21 | 5,0 | 76,38% | 01/02 (1,0) · 05/04 (1,1) · 19/04 (1,7) |
| 8689723179 | 27 | 4,7 | 82,74% | 08/02 (0,8) · **19/04 (3,0)** · 26/04 (0,8) |
| 11892839175 | 42 | 4,1 | 90,19% | 01/02 (1,3) · 29/03 (1,8) |
| 8689743956 | 46 | 2,5 | 94,48% | 01/02 (1,5) · 08/02 (0,6) |
| 11979532838 | 43 | 2,2 | 94,98% | 29/03 (1,1) · 05/04 (0,6) |
| 8689774923 | 26 | 1,7 | 93,31% | 01/02 (0,6) · 26/04 (1,0) |
| outros 5 | 124 | 2,1 | 98,3% | — |

- **Três SKUs concentram 67% das falhas.** O 8689717792 sozinho tem 41%.
- **As falhas se concentram em três momentos:**
  - semana de 01/02 (7,1 falhas): é a abertura da janela, então pesa o estado herdado do aquecimento;
  - semanas de 29/03 e 05/04 (15,1 falhas): a demanda de março/abril sobe;
  - semana de 19/04 (5,0 falhas).
- **Demanda das linhas de A suaves:** 197, 241 e 271 unidades em fevereiro, março e abril (1,38× de fev → abr; a coorte A inteira teve 1,55×).

### 2.2 Decomposição da falha (Shapley de 3 fatores)

> **Revisado depois do Codex (rodada 2, §8).** A 1ª versão tinha três defeitos:
> - o fator D consultava vendas posteriores a 30/04, até 13/06;
> - o fator L tirava os momentos do LT das mesmas réplicas que mediam o resultado;
> - o fator U alongava também o σLT, o que é margem e não correção da média.
>
> Os números abaixo já são os corrigidos (`diag-suaves-a-v2.ts`). A ordem dos componentes não mudou; os tamanhos, sim.

Os três fatores trocam o insumo do F0 por um nível de **referência retrospectiva**. São diagnósticos, não estimativas que o motor teria no dia:

| Fator | F0 hoje | Contrafactual (diagnóstico) |
|---|---|---|
| **D: defasagem** | média dos 90 dias anteriores | média **centrada** de 90 dias, `[d−45, d+45)`, **truncada em 30/04**: não lê nada da avaliação, mas lê o futuro da calibração |
| **L: LT acima do parâmetro** | LT médio do parâmetro (amostra com t4 < d) | LT **esperado do sorteio** naquele SKU-dia: média e desvio de `max(1, lt)` em 200 réplicas **independentes** das medidas (reps 1000+) |
| **U: unidade** | `D_corrido × LT_du` no termo médio do PP | o termo médio vira `D_corrido × LT_du × 7/5`; o σ (σd e σLT) **fica como está** |

Fill dos suaves de A nas 8 combinações:

| D | L | U | fill | Δ estoque da coorte |
|:-:|:-:|:-:|---:|---:|
| 0 | 0 | 0 | 90,66% | 0 |
| 1 | 0 | 0 | 92,57% | +0,87% |
| 0 | 1 | 0 | 93,16% | +2,41% |
| 0 | 0 | 1 | 95,10% | +7,38% |
| 1 | 1 | 0 | 95,39% | +2,90% |
| 1 | 0 | 1 | 95,75% | +8,16% |
| 0 | 1 | 1 | 96,44% | +9,33% |
| 1 | 1 | 1 | 98,09% | +10,69% |

**Repartição das 9,34 p.p. que faltam para 100%:**

| Componente | p.p. | parcela | 1ª versão |
|---|---:|---:|---:|
| **U: taxa média em dia corrido × LT em du** | **3,46** | 37% | 4,49 |
| L: LT do sorteio acima do parâmetro | 2,31 | 25% | 1,98 |
| D: defasagem da média de 90 dias (oráculo retrospectivo) | 1,67 | 18% | 1,40 |
| resíduo (variância, z = 1,65, arredondamentos, estado herdado) | 1,91 | 20% | 1,48 |

Referência fora da decomposição: a demanda **clarividente**, a média dos 30 dias seguintes truncada em 30/04, dá 96,12%.

**Leitura:**

- **A hipótese do NO-GO estava parcialmente errada.** A defasagem é o menor componente identificado. Além disso, D é um **oráculo retrospectivo**: ele usa vendas posteriores a d, ainda dentro da calibração. Por isso **não** prova que 18% da falha seja "recuperável" por uma média mais rápida. As médias de 30 e 45 dias, que seriam a versão operacional, não recuperam nada (§3).
- **O maior componente continua sendo de unidade, mas na taxa média, não no horizonte exato:**
  - a taxa média: `D_corrido = 5/7 × D_útil` quando não há venda no fim de semana, o que dá **28,6% a menos**. Nos suaves, 0,00% da venda cai em sábado ou domingo na calibração e no aquecimento;
  - o horizonte exato: o erro da demanda até a chegada depende das bordas do calendário. O simulador compra depois das vendas do dia e recebe antes delas. No exemplo do Codex, com LT de 10 du, há 9 dias úteis de demanda entre os eventos e a subestimação é de **20,6%**. O período de revisão precisa ser tratado explicitamente.
- **Questão de σd em aberto.** O σd é medido em dias corridos, com os zeros dos fins de semana. Uma demanda constante de 1 por du tem variância útil zero e variância corrida positiva. Corrigir a média sem decidir o σd não é "coerência completa de unidades". O perfil do F0′ precisa fixar essa regra (§4.4).
- Esse viés de taxa **está na view** (`v_sku_parametros_sugeridos`, paridade de 100% no replay) e vale para todo SKU do F0. O EOQ também usa `D_corrido × 252` (dias úteis/ano).
- **O que o Codex reproduziu de forma independente:**
  - o controle é genuíno: mapa nulo = oficial em todas as entradas, e o z a −5% muda o fill;
  - L é estável à amostragem: 92,84% com os momentos exatos da distribuição documental, 93,25% com outra amostra de 50, contra 93,16% aqui.

  **Não está validado:** os caminhos de retenção e fusível da gravação (`formulas.ts:537-545`), que o recálculo simplificado omite. Nos suaves, eles não divergem na calibração.

### 2.3 Reconciliação com os números do NO-GO

- **"LT sorteado médio 11,6 du contra 9,8 du no parâmetro"** vem de **uma réplica** (rep 0), nos pedidos de A desde 16/03. Em 50 réplicas, pedido a pedido:

  | grupo | período | LT realizado | parâmetro | pedidos/rep |
  |---|---|---:|---:|---:|
  | suaves | desde 16/03 | 10,80 du | 10,25 du | 46,6 |
  | suaves | calibração inteira | 10,13 du | 10,14 du | 92,6 |
  | intermitentes | desde 16/03 | 10,59 du | 9,58 du | 77,4 |
  | intermitentes | calibração inteira | 10,15 du | 9,44 du | 131,6 |

  O LT acima do parâmetro existe, mas é modesto e concentrado no fim da janela. O fator L pesa 2,31 p.p. mais pelo **descasamento no tempo** (o LT sobe quando os pedidos saem) e pelo desvio do que pela média.
- **"Demanda de A cresceu 1,55×"** vale para a coorte A inteira. Nas linhas de A dos suaves, foi 1,38×.

### 2.4 O teto da célula A mexendo só nos suaves

| | linhas de A | fill F0 |
|---|---:|---:|
| suaves | 400 | 90,66% |
| intermitentes | 324 | 90,49% |
| **célula A, com suaves a 100%** | 724 | **95,75%** |

**Consequência para a régua:** o piso de 98% na célula inteira exige que os intermitentes de A cheguem a ≥ 95,5% com os suaves perfeitos, ou a 98,62% com os suaves a 97,5%. O teto é condicional à janela, ao cenário e ao F0 dos intermitentes, não uma constante da avaliação. O desenho precisa ser um **pacote**: F0′ nos suaves e uma fórmula X nos intermitentes, medidos juntos.

## 3. Alternativas para o F0 dos suaves

**Medição preliminar** (calibração, 50 réplicas). "Só suaves" = intermitentes no F0 atual; "pacote" = intermitentes na F2 β 0,02 (0,999 / 0,999 / 0,95), a candidata informativa da R27. Δ estoque é sobre o estoque médio da coorte no F0, e os suaves são 24,66% dele.

| Variante (suaves) | fill suaves A | célula A (só suaves) | Δ estoque | célula A (pacote F2) | Δ estoque (pacote) |
|---|---:|---:|---:|---:|---:|
| F0 atual | 90,66% | 90,58% | 0 | 93,94% | +49,13% |
| **Alt 1:** demanda por dia útil | 95,31% | 93,15% | +9,54% | 96,51% | +58,67% |
| Alt 1 + LT p80 (z da classe) | 96,58% ¹ | 93,86% ¹ | +18,09% ¹ | 97,22% ¹ | +67,22% ¹ |
| **Alt 2:** Alt 1 + LT p80 + z(A) = 2,326 | 98,11% | 94,70% | +25,11% | **98,06%** | +74,23% |
| Alt 2 com z(A) = 3,09 | 99,41% | 95,42% | +37,25% | 98,78% | +86,38% |
| **Alt 3:** F1 nos suaves, q 0,98 | 94,49% | 92,70% | +9,48% | — | — |
| Alt 3, q 0,999 | 96,58% | 93,86% | +24,85% | — | — |
| *descartada:* janela de 30 d | 90,49% | 90,49% | +2,78% | — | — |
| *descartada:* janela de 45 d | 90,07% | 90,26% | +0,12% | — | — |
| *descartada:* max(média 30 d, média 90 d) | 92,33% | 91,51% | +3,54% | — | — |
| *descartada:* LT p80 sem correção de unidade | 92,43% | 91,56% | +4,45% | — | — |

A linha "F0 atual / pacote F2" (93,94% em A, +49,13% de estoque) repete exatamente o ponto da grade oficial de 09/11 ("F2 β 0,02 com 93,94%, 49% a mais de estoque"). É uma conferência independente de que o script mede o mesmo que o `rodar.ts`.

¹ Medida na variante vizinha, com demanda de 45 dias, LT p80 e × 7/5 (`A13_dem45_ltP80_U`). Na implementação, a Alt 1 + p80 é medida com a definição exata dela.

**O tratamento de LT da Alt 2 no pacote** (z(A) = 2,326, F2 nos intermitentes, calibração). Os 98,06% da tabela acima são da combinação "p80 + σLT", que a §4.4 manda **não** usar, porque sobrepõe proteção:

| LT nos suaves | célula A | Δ estoque |
|---|---:|---:|
| p80 + σLT atual (a medida acima) | 98,06% | +74,23% |
| p80 com σLT = 0 | 98,11% | +72,17% |
| média + σLT atual | 97,71% | +68,37% |

A política não é monotônica: tirar o σLT até melhorou um pouco. As três linhas mantêm o σd corrido original.

> **Mesmo o melhor pacote só toca o piso no ponto, com +72% a +74% de estoque da coorte.** A célula A dá 98,06% na calibração, que é o ponto e não o limite inferior.
>
> Pela régua atual, o critério 3 (redução de capital ≥ 10%) reprova **por construção** qualquer mudança que suba o serviço comprando estoque (§4.3).

### Alt 1 — Demanda por dia útil (corrige a unidade)

- **O quê:** `D = Σ vendas em [d−90, d) ÷ nº de dias úteis da janela`, em vez de ÷ 90. O LT continua em du, e o EOQ fica coerente (`D_du × 252`).
- **Premissa:** a venda acontece em dia útil, com sábado residual. Então demanda por du × LT em du é a demanda esperada no LT. Isso é **correção de viés**, não aumento de margem: com z inalterado, o ES só cresce pelo D maior.
- **Ganho:** +4,65 p.p. nos suaves de A, por +9,54% do estoque da coorte (+38,70% do estoque dos próprios suaves). Ataca o maior componente (U, a taxa média). A questão do σd corrido continua aberta (§2.2) e é um campo do perfil (§4.4).
- **Riscos:**
  - (a) o viés está **na view**, para todo o F0. Corrigir só nos suaves Sayerlack cria duas definições de "demanda média diária" no mesmo motor;
  - (b) a correção global muda o estoque de **todos** os SKUs, inclusive Colacor/Oben fora da coorte, e precisa de medição própria;
  - (c) o sábado com NF conta venda num dia que não é du, e a conta superestimaria onde houvesse venda de sábado. Nos suaves, a fração da venda em sábado ou domingo na calibração é **0,00%**; fora da coorte, isso precisa ser medido.

### Alt 2 — Alt 1 + LT por quantil + z de A recalibrado

- **O quê:** a Alt 1, mais o `LT = quantil p80` da amostra documental com t4 < d (do SKU se tiver ≥ 5 documentos, senão da Sayerlack, como na F1), mais o z de A como parâmetro calibrado na grade em vez de 1,65.
- **Premissa:** a cauda do LT (e o descasamento no tempo, componente L) e a variância residual pedem margem explícita. O z vira o botão do serviço, escolhido na calibração e congelado.
- **Ganho:** é a única variante medida em que os suaves de A passam de 98% (98,11% com z = 2,326).
- **Riscos:**
  - capital: +25% da coorte só nos suaves;
  - p80 em amostra própria pequena (5–10 documentos) é instável;
  - sobrepor quantil de LT e σLT na raiz conta a incerteza do LT duas vezes. Por isso a implementação deve **escolher um dos dois** (ou p80 com σLT = 0, ou média com σLT) e medir os dois;
  - z por classe muda também o ES dos intermitentes que estiverem no F0.

### Alt 3 — ES da gaussiana (F1) só nos suaves

- **O quê:** a F1 que já existe no simulador: `S = ⌈H·d̄ + z_q·√(H·σd² + d̄²·σLT²)⌉`, com H = LT̄ + 1, d̄ e σd em 63 du e order-up-to sem EOQ. Fica só nos 12 suaves, com quantil calibrado.
- **Premissa:** a F1 já é coerente em unidade (tudo em du) e inclui a revisão (+1 du). Ganha a correção U "de graça" e já está testada e auditada no replay.
- **Riscos:**
  - **tira o EOQ:** compra até S toda vez que a posição cai abaixo de S, com mais pedidos, mais custo de pedido e lotes menores. O replay não custeia pedido, que é uma limitação a declarar;
  - na grade, é **menos eficiente** que a Alt 1 (q 0,98: +3,83 p.p. por +9,48%);
  - troca a política dos suaves, não só o parâmetro, e afasta da produção.

**Recomendação de desenho:** medir **Alt 1 e Alt 2** como as principais e a Alt 3 como comparadora.

- A Alt 1 é a correção de um viés provado, e a conversa com o Lucas é se ela vale para todo o F0.
- A Alt 2 é a única que alcança o piso nos suaves.
- Janelas curtas ficam descartadas: os dados mostram que a defasagem é o menor componente, e a média de 30 dias piora o fill por ruído.

## 4. Como medir no replay sem afrouxar a régua

### 4.1 Unidade de decisão: o pacote

- O mapa de parâmetros é `mapaMisto(F0′ nos suaves, X nos intermitentes)`, com X ∈ {F0, F1, F2, F3} calibrada como hoje.
- A régua é a da spec mãe (§6), na **célula da classe inteira**:
  - A ≥ 98%, B ≥ 95% e C ≥ 90% pelo limite inferior unilateral de 95%;
  - não inferioridade nas 6 células;
  - os dois extremos de falta;
  - estresse `max(LT, 15)`.
- A célula "A suaves" aparece só como diagnóstico, **nunca** como critério.
- A **linha de base continua o F0 atual** nos 153 SKUs: todos os deltas e o alvo `max(piso, fill F0 − 0,25 p.p.)` são contra o motor de hoje, não contra o F0′.

### 4.2 Calibração e seleção determinística do pacote

O Codex (P1) apontou que "descida por coordenada no par" não fecha o algoritmo. A seleção passa a ser esta:

1. **Enumerar os perfis do F0′ por fora da busca.** A lista é finita e fixada antes da rodada:
   - `P0`: o perfil nulo, igual ao F0 de hoje;
   - Alt 1: demanda por du;
   - Alt 2, nas variantes `{LT p80 com σLT = 0, LT médio com σLT}` × z(A) ∈ {1,65; 1,88; 2,054; 2,326; 2,576; 3,09};
   - Alt 3: F1 nos suaves, com quantil q ∈ grade §5.9.

   Os valores medidos na calibração para as duas versões de LT da Alt 2 estão na tabela da §3.
2. **Para cada perfil P, rodar a calibração existente sem mudança** (`calibrar`, §5.9 da mãe) para X ∈ {F1, F2, F3} (D4). Ela usa o mesmo alvo, a mesma grade, a mesma descida por classe e o mesmo trio validado. A saída de cada (P, X) é a tupla congelável `(P, X, β ou janela, quantis A/B/C)`, ou "inviável".
3. **Candidata:** entre as tuplas viáveis (alvo nas três classes, **com** A medido na célula inteira), fica a de menor estoque médio.
4. **Desempate**, nesta ordem:
   - (a) a regra de simplicidade da mãe, ≤ 1 p.p. de capital: F1 < F3 < F2;
   - (b) perfil mais simples, P0 < Alt 1 < Alt 2 < Alt 3;
   - (c) menor z(A) ou q;
   - (d) ordem lexicográfica da tupla serializada.
5. **Tudo vira dado:** dado ausente é inviável, nunca 0, e `escolherCandidata` passa a devolver a **tupla inteira**, não só a fórmula.
6. **Congelar a tupla e avaliar** de 01/05 a 20/10, com as réplicas, o bootstrap pareado (blocos de 4 e 8), os choques comuns e LI/LS da §5.8.

**Estabilidade (informativa, no relatório):**
- a seleção é refeita em dois cortes temporais dentro da calibração (fev–mar e mar–abr);
- e em *leave-one-SKU-out* nos 12 suaves.

Uma escolha que troca de perfil entre cortes é sinal de overfit. Fica registrada, mas não muda o veredito. As 50 réplicas não criam 50 históricos de demanda independentes.

### 4.3 Capital: a régua para mudança que compra serviço (D1, contrato executável)

A régua do TSB foi feita para uma mudança que **economiza** capital: o critério 3 exige redução ≥ 10%, e o 4 exige `LI(redução) > 0` no estresse. Toda alternativa deste documento **aumenta** o estoque. Pela D1 (economia + teto), os critérios de capital do TSB são substituídos assim:

| | O que é | Regra |
|---|---|---|
| **Mantido** | serviço (critérios 1 e 2, nas 6 células), exposição (≥ 300 linhas), precisão, estados iniciais, Clopper–Pearson, blocos 4/8 com `LI = min`, `LS = max` | sem mudança |
| **Mantido** | precedência NO-GO > INCONCLUSIVO > GO | sem mudança |
| **Mantido** | `A_alt`, `B_alt` e `C_alt` medidos na máscara dos **intermitentes originais** (`coorte.alterados`, fixada no corte), **nunca** na união com os suaves. Senão `A_alt` vira A e perde a função de proteger os intermitentes | sem mudança |
| **3 → 3′ (economia)** | benefício líquido = custo de falta evitada (emergencial, atraso, cancelamento pela margem, **incluindo o backlog terminal**) − custo do capital incremental a **25% a.a.**, proporcional aos dias da janela. Somas pareadas por semana e réplica | PASSA: `LI95 > 0` em **todas** as células da grade e nos três cenários de falta (espera, cancelamento, misto). FALHA: `LS95 < 0` em alguma. INCERTO no resto. 20% e 30% a.a. ficam como sensibilidade |
| **3″ (teto)** | aumento relativo do **estoque médio** da coorte contra o F0 (a média não é limite de pico de caixa) | PASSA: `LS95(aumento) ≤ teto`. FALHA: `LI95(aumento) > teto`. INCERTO no resto. O teto é fixado antes da rodada e fica em `$REPLAY_DADOS` |
| **5** | absorvido por 3′, que é a mesma conta com o sinal do capital invertido. A tabela do pacote tem 3′ e não repete o 5 | — |
| **4 (estresse)** | serviço como em 1 e 2 sob `max(LT, 15)`. Capital: 3′ e 3″ também no estresse, no lugar de `LI(redução) > 0` (**D1b**, decidido) | — |

**O que já se sabe no ponto** (conta do Codex, calibração, sem intervalo): o pacote de +74,23% de estoque, no cenário de espera, com atraso gratuito e emergencial terminal a 5%, dá benefício líquido de **−4,07% do estoque médio do F0**. Isso já inclui o backlog terminal menor.

- **A D1 não resolve a viabilidade por decreto.** O pacote mais caro provavelmente reprova em 3′.
- **Retirar depois a célula de atraso gratuito para fazer passar seria afrouxamento**, e está vedado.

O relatório mostra a **fronteira** capital × fill da célula A, de 95% a 99%, com o benefício líquido de cada ponto.

### 4.4 O que o replay precisa ganhar (plano, não código agora)

1. **Perfil completo do F0′ em `formulas.ts`.** Cada campo é explícito:
   - a demanda: `corrido90` ou `du90`;
   - no aquecimento, o F0 divide pelos dias observados quando há menos de 90 (`formulas.ts:453`). O `du90` divide pelos **du observados** na mesma condição. O diagnóstico dividia pela janela cheia, o que é um defeito a não repetir;
   - a regra de σd: corrida, como hoje, ou por du com os fins de semana agregados ao du anterior, como na F1 (`formulas.ts:598`);
   - o σLT: o atual, ou 0 com o LT em quantil;
   - a amostra e a janela do LT, o piso teórico, o fallback e o arredondamento;
   - z(A), aplicado pela classe proposta do dia (a mesma de `zPorClasse`);
   - desde quando o perfil vale: só a partir do 1º dia da calibração, com o aquecimento sempre em `P0`.
2. **Paridade nula bit a bit:** `P0` × F0 em todos os SKU-dias, com controle na mesma invocação (o `D0L0U0` daqui).
3. **Oráculos de teste independentes**, porque a paridade nula não prova o `du90`. São exemplos manuais com:
   - calendário, sábado com NF e semana com feriado ausente;
   - σd corrido × du e LT = 0;
   - histórico curto (< 90 dias);
   - os limites PASSA, FALHA e INCERTO de 3′ e 3″.

   E **mutar os dados posteriores a 30/04 não pode mudar** a calibração de nenhum perfil implementável. Esse teste pega exatamente o defeito do fator D da 1ª versão.
4. **Modo "pacote"** em `calibracao.ts`/`rodar.ts`, com o algoritmo da §4.2 e a tabela da §4.3. **O modo oficial não muda**: a rodada de 09/11 continua reprodutível byte a byte.
5. **Cache e relatório:** o perfil e o protocolo entram na chave do cache (hoje ela não tem perfil, `formulas.ts:805`) e no cabeçalho do relatório.
6. **Falsificação por camada**, com controle verde na mesma invocação:
   - sabotar `du90` para `÷ 90` e exigir vermelho nos oráculos manuais;
   - pôr os suaves no `P0` e exigir que o pacote reproduza a linha "F0 atual + F2" (93,94%, +49,13%);
   - trocar a máscara de `A_alt` pela união e exigir vermelho no teste da máscara.
7. **Relatório:** decomposição (§2.2) como diagnóstico; células A dos suaves e dos intermitentes como diagnóstico; fronteira; estabilidade (§4.2).
8. **Codex adversarial do código** antes da rodada oficial do pacote.

## 5. Limites e riscos de leitura

- **A demanda é censurada.** O fill mede linhas faturadas observadas; quando faltou estoque de verdade, a venda pode nem ter virado linha. O serviço real do F0 pode ser **pior** que 90,66%.
- **A amostra é pequena e concentrada:** 12 SKUs, e um deles (8689717792) responde por 41% das falhas. O resultado da Alt 2 pode ser "acertar esse SKU". O relatório deve mostrar o pacote **sem** o 8689717792, como sensibilidade.
- **A semana de 01/02 (19% das falhas)** é estado herdado do aquecimento, que nenhuma fórmula da janela corrige. O modo pacote deve reportar o fill de A com e sem a 1ª semana, só como sensibilidade (a régua usa a janela inteira).
- **O LT do sorteio é por documento da Sayerlack**, ±10 du em torno de d, com a amostra da calibração. O fator L mede descasamento contra esse sorteio, não contra o LT real de cada SKU. N1/N3/N5 seguem declarados.
- **Viés de unidade fora da coorte (onde mais):** a mesma `v_sku_parametros_sugeridos` dimensiona o PP de **todos** os SKUs do F0 em produção. Isso inclui a tela de reposição, o pedido sugerido e o teto de cobertura B/C (que usa `demanda_media_diaria` e também ficaria coerente em du). Corrigir na produção é **outra** fase, com medição própria e com migration de view (`CREATE OR REPLACE` com o pré-flight da prod).
- **Custo de pedido:** a Alt 3 sem EOQ aumenta o nº de pedidos, e o replay não custeia isso.

## 6. Fora do escopo desta fase

- Código no replay (§4.4 é o plano), migration, edge e `db/embalagem-motor-rpc.sql`.
- Mudança na produção. Uma eventual fase 2 sai do veredito do pacote.
- Revisar a régua de serviço (pisos, não inferioridade), que **não** se afrouxa.

## 7. Decisões que são do Lucas

- **D1: critério de capital para mudança que compra serviço.** Trocar o critério 3 (redução ≥ 10%) por 3′ (economia a 25% a.a. com a grade de falta), por 3″ (teto de aumento fixado antes) ou pelos dois? Sem D1, qualquer pacote dá NO-GO por construção.
- **D2: escopo da correção de unidade (Alt 1).** Medir só nos suaves Sayerlack, ou já desenhar a correção para todo o F0, com medição em toda a carteira?
- **D3: z de A.** Aceitar z(A) como parâmetro calibrado no replay (Alt 2)? Hoje 1,65 vem de `zPorClasse`, que é uma configuração de produção.
- **D4: fórmula dos intermitentes no pacote.** Só F2 (a candidata da R27), ou as três (F1/F2/F3), calibradas em conjunto com o F0′?
- **D5: sensibilidades declaradas.** Pacote sem o 8689717792 e fill sem a 1ª semana: informativos, como proposto, ou com peso no veredito?
- **D6: piso de A ≥ 98%.** Confirmar que continua sendo o piso também para esta pergunta. O melhor pacote medido toca 98,06% no ponto, com +74% de estoque.
- **D7: Codex agora ou depois.** A consulta de desenho foi barrada pelo guard local (cota em 96%, reabre em 11/11 07:47). Três saídas: esperar a janela (o PR fica DRAFT), seguir pelo Caminho B já aplicado (§8), ou gastar a reserva agora (`CODEX_ASYNC_TETO_SALDO=0`). Proponho esperar: nada aqui é urgente e o adversarial de código continua obrigatório antes da implementação.

### 7.1 Decisões tomadas (Lucas, 2026-11-09)

| # | Decisão |
|---|---|
| D1 | **Economia + teto.** O critério 3 vira 3′ **e** 3″: custo líquido positivo pelo LI em toda célula da grade (capital a 25% a.a., 20% e 30% como sensibilidade) **e** aumento de estoque da coorte abaixo de um teto. **O valor do teto ainda está em aberto:** o Lucas o fixa antes da rodada oficial do pacote e ele fica em `$REPLAY_DADOS`, nunca depois de ver o resultado |
| D2 | **Só os suaves no replay.** A correção de unidade em toda a carteira vira uma frente separada, depois do veredito do pacote |
| D4 | **F1, F2 e F3** nos intermitentes, calibradas em conjunto com o F0′ dos suaves |
| D7 | **Gastar a reserva do Codex agora** (`CODEX_ASYNC_TETO_SALDO=0`) |
| D1b | **Economia + teto também no estresse** (Lucas, 2026-11-10): no estresse `max(LT, 15)`, os critérios 3′ e 3″ valem no lugar de `LI(redução) > 0`, e o serviço segue como nos critérios 1 e 2 |
| D7′ | **Rodar a 3ª consulta do Codex agora** (Lucas, 2026-11-10) |
| Teto | **Delegado pelo Lucas** a uma proposta do Fable e do Codex, cada um sem ver a do outro (2026-11-10). O valor e a justificativa ficam na §7.2 |

**Ainda em aberto, depois do Codex (rodada 2):**
- **D1, valor do teto:** em definição (§7.2).

D3, D5 e D6 ficam como propostos na §7: o z(A) entra como parâmetro calibrado e congelado; as sensibilidades sem o 8689717792 e sem a 1ª semana são só informativas; o piso de A continua em 98%.

## 8. Parecer do Codex (consulta de DESENHO, money-path)

### Rodada 1: não consultado (guard de cota)

`sem-codex: cota (rc = 79, guard local)`. A cota estava em 96% (teto 85%), e a chamada não foi gasta. Nessa rodada foi aplicada a régua própria (abaixo).

### Rodada 2: REPROVA (gpt-6-astra, max, 546 s, rc = 0, reserva liberada pela D7)

> O parecer inteiro está em `codex-desenho-rodada2.txt` na pasta de notas da sessão.

**Veredito:** reprova o desenho **como contrato pronto para implementar**. Nas palavras dele, a tese do pacote se sustenta, mas a atribuição causal e as regras de decisão ainda admitiam leituras incompatíveis.

O Codex reexecutou o diagnóstico com 50 réplicas e confirmou, de forma independente:
- o controle (mapa nulo = oficial em todas as entradas; o z a −5% muda o fill);
- o teto de 95,745856%;
- que os suaves não pertencem a grupo de embalagem;
- os alvos A = 98%, B = 95%, C = 92,7233%.

| # | Achado | Tratamento |
|---|---|---|
| P1 | **D tinha clarividência:** a média centrada lia até 13/06, já dentro da avaliação. Retirar só do oráculo as vendas posteriores a 30/04 mudou 278 SKU-dias e levou o D1L0U0 a 91,68% | **Corrigido.** O oráculo é truncado em 30/04 (§2.2) e D virou "oráculo retrospectivo", sem prova de ser recuperável. **Registrado:** a direção desta spec foi escolhida tendo consultado parte de maio/junho |
| P2 | **L tirava os momentos das mesmas réplicas medidas** | **Corrigido:** 200 réplicas independentes. O Codex mostrou que L é estável (92,84% com os momentos exatos, 93,25% com outra amostra) |
| P1 | **U inflava também o σLT**, com o σd corrido, o que é margem e não correção da média | **Corrigido:** U só no termo médio, 3,46 p.p. (era 4,49). A questão do σd virou campo do perfil |
| P2 | **"29%" não é o erro exato do horizonte**, que depende das bordas (exemplo: 20,6%) | **Corrigido** na §2.2. O período de revisão entra no perfil |
| P2 | **Venda de sábado ÷ du não superestima** necessariamente | **Corrigido** na Alt 1 (c) |
| P3 | A conta "~98,5%" é 98,62% | **Corrigido** na §2.4 |
| P1 | **O critério 4 (estresse) ainda exigia redução de capital**; o 3′ repetia o 5 | **Reescrito** na §4.3 (tabela executável). O capital no estresse virou a decisão **D1b** |
| — | O pacote de +74% dá benefício líquido de −4,07% do estoque do F0 no ponto | **Registrado** na §4.3: a D1 não decide a viabilidade. É vedado retirar células da grade depois |
| P2 | **Os 98,06% são da combinação p80 + σLT**, que o próprio desenho manda abandonar | **Corrigido:** tabela com as três variantes de LT (§3) |
| P2 | **Risco de overfit** com 12 SKUs | **Incorporado:** estabilidade por cortes temporais e *leave-one-SKU-out* (§4.2), só informativa |
| P1 | **Seleção do pacote indeterminada;** `escolherCandidata` devolve só a fórmula | **Reescrito:** enumeração de perfis por fora, tupla congelada e desempate total (§4.2) |
| — | Contrato do perfil, aquecimento, cache, oráculos de teste independentes e máscara de `A_alt` | **Incorporado** na §4.4 |

**Próximo passo do ritual:** uma rodada 3 do Codex sobre esta versão, para confirmar que os P1 fecharam. A decisão de gastar mais cota é do Lucas (D7′).

### Régua própria (rodada 1, mantida com a correção do R3)

| # | Ataque | Resultado |
|---|---|---|
| R1 | O controle `D0L0U0` é idêntico por construção? | **Não.** O z a −5% diverge 0,85 p.p., e o Codex confirmou |
| R2 | U é só "mais margem"? | Na 1ª versão **era em parte**, porque alongava o σLT: o meu R2 errou, e o Codex pegou. Agora U mexe só no termo médio |
| R3 | D e L carregam clarividência? | **D carrega**, e o meu R3 errou ao dizer que não: lia até 13/06. Agora está truncado em 30/04 e rotulado como oráculo retrospectivo. **L**: o sorteio usa documentos com t1 a ±10 du de d (§5.9 da mãe), e a Alt 2 usa só t4 < d |
| R4 | O teto depende da classe do dia? | Não: 724 = 724, e o Codex confirmou 95,745856% |
| R5 | Trocar o critério 3 é afrouxar? | Não, desde que a régua seja executável e fixada antes (§4.3) |
| R6 | Overfit do z(A)? | Risco real: estabilidade na §4.2 |
| R7 | p80 + σLT sobrepõe proteção? | Sim: a §3 mede as três versões e a §4.2 só enumera as duas sem sobreposição |

## 9. Evidência

- Código: `origin/main` `3a93ef075`, simulador `scripts/reposicao-replay/` sem alteração.
- Dados: `~/.cache/afiacao/reposicao-replay-2026-11-09/` (extração de 09/11, motor das 07:15 SP; hashDados `f4704d895c47…`).
- Script de diagnóstico (fora do repositório nesta fase): `diag-suaves-a.ts`, sha256 `de4d2113186b68b7…`, na pasta de notas da sessão. A saída completa está em `diag-r50c.txt`, ao lado.
- Comandos (rc = 0 nos três; cada saída termina com `fim ok`):

  ```bash
  heavy bun diag-suaves-a.ts "$PWD" ~/.cache/afiacao/reposicao-replay-2026-11-09 50 > diag-r50.txt   # rc=0, 4,9 s
  heavy bun diag-suaves-a.ts "$PWD" ~/.cache/afiacao/reposicao-replay-2026-11-09 50 > diag-r50b.txt  # rc=0 (LT por pedido, z alto)
  heavy bun diag-suaves-a.ts "$PWD" ~/.cache/afiacao/reposicao-replay-2026-11-09 50 > diag-r50c.txt  # rc=0 (só suaves, controle de independência)
  ```

- Falsificação (10 réplicas, `diag-falsifica.ts` ao lado): `SABOTA=0` controle 90,28% × 90,28%, rc = 0; `SABOTA=2` (z −5%) 89,42% × 90,28%, rc = 0, com divergência esperada; `SABOTA=1` (piso +1) sem efeito: camada inalcançada.
- **Versão corrigida depois do Codex:** `diag-suaves-a-v2.ts`, saída `diag-v2.txt`, rc = 0, `fim ok`. Ela traz o oráculo truncado em 30/04, os momentos de LT de réplicas independentes, o U só no termo médio e as variantes de LT do pacote. Controle 90,66% × 90,66%.
- Controles na mesma invocação:
  - recálculo nulo × oficial: |Δ| = 0,00 p.p.;
  - linhas A do script × célula do simulador: 724 = 724, com saída rc = 3 se divergir;
  - só suaves × coorte: 90,66% = 90,66%.
