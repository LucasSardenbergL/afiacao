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

Os três fatores trocam o insumo do F0 por um "nível certo" sem clarividência:

| Fator | F0 hoje | Contrafactual |
|---|---|---|
| **D: defasagem** | média dos 90 dias anteriores | média **centrada** de 90 dias (45 antes + 45 depois). A suavização é a mesma, só a defasagem some |
| **L: LT acima do parâmetro** | LT médio do parâmetro (amostra com t4 < d) | LT **esperado do sorteio** do simulador naquele SKU-dia (média e desvio de `max(1, lt)` nas 50 réplicas) |
| **U: unidade** | demanda por **dia corrido** (÷ 90) × LT em **dias úteis** | LT convertido para dias corridos (× 7/5). É a mistura de unidades que a spec mãe já apontava (§1) |

Fill dos suaves de A nas 8 combinações:

| D | L | U | fill | Δ estoque da coorte |
|:-:|:-:|:-:|---:|---:|
| 0 | 0 | 0 | 90,66% | 0 |
| 1 | 0 | 0 | 92,33% | +0,32% |
| 0 | 1 | 0 | 93,19% | +1,74% |
| 0 | 0 | 1 | 96,14% | +11,80% |
| 1 | 1 | 0 | 94,75% | +1,92% |
| 1 | 0 | 1 | 96,80% | +12,17% |
| 0 | 1 | 1 | 97,10% | +15,10% |
| 1 | 1 | 1 | 98,52% | +14,83% |

**Repartição das 9,34 p.p. que faltam para 100%:**

| Componente | p.p. | parcela |
|---|---:|---:|
| **U: demanda em dia corrido × LT em du** | **4,49** | 48% |
| L: LT do sorteio acima do parâmetro | 1,98 | 21% |
| D: defasagem da média de 90 dias | 1,40 | 15% |
| resíduo (variância da demanda e do LT, z = 1,65, arredondamentos, estado herdado) | 1,48 | 16% |

Referência fora da decomposição: a demanda **clarividente**, a média dos 30 dias seguintes, dá 95,83%. A diferença para a centrada (92,33%) é informação de curto prazo que nenhuma média tem, então não é atribuível à "defasagem".

**Leitura:**

- **A hipótese do NO-GO estava parcialmente errada.** A defasagem da média de 90 dias é o **menor** componente identificado: a média centrada fica só 1,4% acima da de 90 dias, em média, nos SKU-dias de A.
- **O maior componente é estrutural:** o PP cobre `D_corrido × LT_du`, mas o LT de *L* dias úteis dura cerca de *1,4 L* dias corridos com venda. A demanda média no LT fica **subestimada em ~29%** antes de qualquer margem de segurança.
- Esse viés não é dos suaves: **está na view** (`v_sku_parametros_sugeridos`, paridade 100% no replay) e vale para todo SKU do F0. Também o EOQ usa `D_corrido × 252` (dias úteis/ano).

### 2.3 Reconciliação com os números do NO-GO

- **"LT sorteado médio 11,6 du contra 9,8 du no parâmetro"** vem de **uma réplica** (rep 0), nos pedidos de A desde 16/03. Em 50 réplicas, pedido a pedido:

  | grupo | período | LT realizado | parâmetro | pedidos/rep |
  |---|---|---:|---:|---:|
  | suaves | desde 16/03 | 10,80 du | 10,25 du | 46,6 |
  | suaves | calibração inteira | 10,13 du | 10,14 du | 92,6 |
  | intermitentes | desde 16/03 | 10,59 du | 9,58 du | 77,4 |
  | intermitentes | calibração inteira | 10,15 du | 9,44 du | 131,6 |

  O LT acima do parâmetro existe, mas é modesto e concentrado no fim da janela. O fator L pesa 1,98 p.p. mais pelo **descasamento no tempo** (o LT sobe quando os pedidos saem) e pelo desvio do que pela média.
- **"Demanda de A cresceu 1,55×"** vale para a coorte A inteira. Nas linhas de A dos suaves, foi 1,38×.

### 2.4 O teto da célula A mexendo só nos suaves

| | linhas de A | fill F0 |
|---|---:|---:|
| suaves | 400 | 90,66% |
| intermitentes | 324 | 90,49% |
| **célula A, com suaves a 100%** | 724 | **95,75%** |

**Consequência para a régua:** o piso de 98% na célula inteira exige que os intermitentes de A cheguem a ≥ 95,5% com os suaves perfeitos, ou a ~98,5% com os suaves a ~97,5%. O desenho precisa ser um **pacote**: F0′ nos suaves e uma fórmula X nos intermitentes, medidos juntos.

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

> **Mesmo o melhor pacote só toca o piso no ponto, com +74% de estoque da coorte.** A célula A dá 98,06% na calibração, que é o ponto e não o limite inferior.
>
> Pela régua atual, o critério 3 (redução de capital ≥ 10%) reprova **por construção** qualquer mudança que suba o serviço comprando estoque (§4.3).

### Alt 1 — Demanda por dia útil (corrige a unidade)

- **O quê:** `D = Σ vendas em [d−90, d) ÷ nº de dias úteis da janela`, em vez de ÷ 90. O LT continua em du, e o EOQ fica coerente (`D_du × 252`).
- **Premissa:** a venda acontece em dia útil, com sábado residual. Então demanda por du × LT em du é a demanda esperada no LT. Isso é **correção de viés**, não aumento de margem: com z inalterado, o ES só cresce pelo D maior.
- **Ganho:** +4,65 p.p. nos suaves de A, por +9,54% do estoque da coorte (+38,70% do estoque dos próprios suaves). Ataca o maior componente (U).
- **Riscos:**
  - (a) o viés está **na view**, para todo o F0. Corrigir só nos suaves Sayerlack cria duas definições de "demanda média diária" no mesmo motor;
  - (b) a correção global muda o estoque de **todos** os SKUs, inclusive Colacor/Oben fora da coorte, e precisa de medição própria;
  - (c) o sábado com NF conta venda num dia que não é du, e a conta superestima levemente onde há venda de sábado.

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

### 4.2 Calibração e congelamento

- **Parâmetro livre de cada alternativa:**
  - Alt 1: nenhum;
  - Alt 2: z(A) ∈ {1,65; 1,88; 2,054; 2,326; 2,576; 3,09} e a escolha "p80 × σLT", sem acumular as duas;
  - Alt 3: o quantil da grade da §5.9.
- A escolha acontece na calibração, junto com a da fórmula X dos intermitentes: descida por coordenada no par (parâmetro de F0′, quantil de X), validação do trio de classes e menor estoque que atinge o alvo nas três. Depois, **congela**.
- **Avaliação:** de 01/05 a 20/10, com as réplicas e o bootstrap pareado da §5.8, os mesmos choques comuns e LI/LS.

### 4.3 Capital: o critério 3 não serve para esta pergunta

- A régua do TSB foi desenhada para uma mudança que **economiza** capital. O critério 3 exige redução ≥ 10%, e toda alternativa deste documento **aumenta** o estoque.
- Manter o critério 3 dá NO-GO garantido. Isso não é rigor: a régua estaria respondendo outra pergunta.
- **O piso de serviço não se mexe.** O que precisa de decisão do Lucas (D1) é o critério de capital para mudança que compra serviço. Proposta:
  - **3′ (economia):** custo líquido = custo de falta evitada (grade da §6: emergencial 5/10/20%, atraso 0/0,5/1% por linha-dia, cancelamento pela margem) − custo do capital adicional a **25% a.a.** (20% e 30% como sensibilidade), positivo pelo LI em toda célula da grade;
  - **3″ (teto):** aumento de estoque da coorte ≤ um teto que o Lucas fixa antes da rodada (por exemplo, +X% ou +R$ Y, guardado em `$REPLAY_DADOS`).
- O relatório mostra a **fronteira** capital × fill da célula A, de 95% a 99%, como já faz para F2/F3.

### 4.4 O que o replay precisa ganhar (plano, não código agora)

1. **Parametrizar o F0 no `formulas.ts`:** `F0` ganha um "perfil" {`demanda: 'corrido90' | 'du90'`, `lt: 'media' | {quantil}`, `zA?`}. O perfil nulo tem de reproduzir o F0 de hoje **bit a bit**: paridade 100% contra a view e controle na mesma invocação, como o `D0L0U0` deste diagnóstico. Teste: perfil nulo × F0 em todos os SKU-dias.
2. **Modo de calibração "pacote"** em `calibracao.ts`/`rodar.ts`: grade conjunta, o mesmo `alvo`, a mesma régua e o veredito da tabela §6.1 com o critério 3 trocado pela decisão D1. **Sem tocar no modo oficial atual**: a rodada de 09/11 continua reprodutível.
3. **Falsificação por camada**, com controle verde na mesma invocação:
   - sabotar o perfil (por exemplo, ÷ 90 no lugar de ÷ du) e exigir vermelho no teste de paridade do perfil;
   - sabotar o mapa misto (suaves no F0) e exigir que o pacote reproduza a linha "F0 atual + F2".
4. **Relatório:** decomposição (§2.2) como seção fixa; célula A suaves e intermitentes como diagnóstico; fronteira.
5. **Codex adversarial do código** antes da rodada oficial (o ritual da spec mãe).

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

## 8. Parecer do Codex (consulta de DESENHO, money-path)

*Pendente: preenchido depois da consulta via `scripts/codex-async.sh` em background.*

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

- Controles na mesma invocação:
  - recálculo nulo × oficial: |Δ| = 0,00 p.p.;
  - linhas A do script × célula do simulador: 724 = 724, com saída rc = 3 se divergir;
  - só suaves × coorte: 90,66% = 90,66%.
