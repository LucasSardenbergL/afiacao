# Módulo Avaliação Trimestral DES

Sistema para acompanhar, projetar e simular o **programa DES da Sayerlack** (Desconto por Estímulo ao Sucesso). Consolida faturamento trimestral, posicionamento em faixas de volume, critérios qualitativos, e simulador financeiro de decisões de compra.

O objetivo do módulo é responder duas perguntas de negócio que tinha que fazer na cabeça antes:

1. **Onde estou no trimestre agora e qual faixa DES vou atingir?**
2. **Vale a pena puxar volume extra para subir de faixa? Qual prazo de pagamento usar?**

---

## Índice

1. [Visão geral do programa DES](#visão-geral-do-programa-des)
2. [Posição ao vivo](#posição-ao-vivo)
3. [Checkin qualitativo](#checkin-qualitativo)
4. [Simulador de decisão](#simulador-de-decisão)
5. [Histórico](#histórico)
6. [Snapshots do GoodData](#snapshots-do-gooddata)
7. [Conceitos financeiros](#conceitos-financeiros)
8. [Troubleshooting](#troubleshooting)

---

## Visão geral do programa DES

### Como funciona o DES Sayerlack

A Sayerlack concede descontos trimestrais sobre suas compras baseados em dois pilares:

**Pilar 1 — Faixa quantitativa.** Seu faturamento no trimestre define em qual faixa você se encaixa. São 6 faixas, da menor (1 estrela) à maior (6 estrelas). Cada faixa tem um desconto "padrão" que vai de 3,54% a 6,00%.

**Pilar 2 — Critérios qualitativos.** Oito critérios operacionais (mix de produtos, cursos técnicos, visitas a especificadores, etc.) que você pode atingir ou não. Cada critério adiciona um percentual extra. Há também um bônus de 1% por cumprir o objetivo de Tingimix.

O **desconto total** aplicado nas suas compras do trimestre seguinte é a soma: desconto padrão da faixa + soma dos qualitativos atingidos + bônus. Na faixa 3 estrelas (sua atual), o máximo teórico é ~10,09%. Na faixa 4 estrelas sobe para ~11,14%.

### Matriz completa 2026

| Faixa | Estrelas | Volume mín | Volume máx | Padrão | Qualitativos máx | Bônus | Total máx |
|-------|----------|-----------:|-----------:|-------:|-----------------:|------:|----------:|
| 1 | ⭐⭐⭐⭐⭐⭐ | 921.016 | — | 6,00% | 6,50% | 1,00% | 13,50% |
| 2 | ⭐⭐⭐⭐⭐ | 613.176 | 921.015 | 5,40% | 5,85% | 1,00% | 12,25% |
| 3 | ⭐⭐⭐⭐ | 390.096 | 613.175 | 4,86% | 5,28% | 1,00% | 11,14% |
| 4 | ⭐⭐⭐ | 204.425 | 390.095 | 4,37% | 4,72% | 1,00% | 10,09% |
| 5 | ⭐⭐ | 102.266 | 204.425 | 3,94% | 4,21% | 1,00% | 9,15% |
| 6 | ⭐ | 40.655 | 102.265 | 3,54% | 3,85% | 1,00% | 8,39% |

Valores em R$ de faturamento bruto da NF Sayerlack dentro do trimestre.

### Meta pessoal vs faixa DES

São duas métricas independentes:

- **Meta pessoal**: seu alvo trimestral (atualmente R$ 400.840,02). Reflete sua ambição de crescimento, não as faixas DES.
- **Faixa DES objetivo**: faixa alvo do programa Sayerlack (atualmente 4 estrelas — R$ 390.096).

Quando a meta pessoal está acima do piso da faixa objetivo (como é seu caso), bater a meta automaticamente atinge a faixa. Mas você pode ter meta diferente da faixa: por exemplo, se num trimestre específico sua estratégia for "consolidar estoque", você pode reduzir meta pessoal sem perder faixa DES.

---

## Posição ao vivo

Tab "Posição atual" mostra onde você está exatamente neste momento no trimestre corrente.

### Como o sistema calcula a posição

A posição é composta por dois componentes:

**Componente 1 — Snapshot GoodData (fonte de verdade até sábado anterior).**

Toda segunda-feira, a Sayerlack envia PDF do GoodData com os números oficiais do trimestre até o sábado anterior. Esse é o "faturamento confirmado" que vai contar para DES.

**Componente 2 — Pedidos em trânsito pós-snapshot.**

Qualquer pedido Omie emitido depois do sábado do último snapshot (e que ainda não foi incluído no próximo snapshot) é somado à posição se a estimativa indicar que vai faturar dentro do trimestre.

A estimativa de quando um pedido vira NF usa o lead time de produção do grupo do SKU:
- **sayerlack_rapido**: 5 dias úteis
- **sayerlack_normal**: 8 dias úteis

Pedidos com folga temporal grande são marcados **zona verde** (vai faturar com certeza), folga apertada é **zona amarela** (provável), e folga insuficiente é **zona vermelha** (risco de escapar).

### Leitura dos 4 cards do topo

**Card "Posição ao vivo"**: faturado GoodData + pedidos em zona verde e amarela. Valor em destaque. Abaixo aparece "posição otimista" que também inclui zona vermelha.

**Card "Meta pessoal"**: barra de progresso R$ atual / R$ meta. Gap restante até bater. Verde se atingida, amarelo 75-99%, vermelho abaixo.

**Card "Faixa DES"**: faixa conservadora (usando posição conservadora). Se a versão otimista apontar faixa superior, aparece no tooltip.

**Card "Dias restantes"**: dias corridos até fim do trimestre. Referência para decidir se ainda há tempo de puxar volume.

### Detalhamento de pedidos em trânsito

A tabela embaixo dos cards lista cada pedido emitido após o último snapshot, com:

- Data de emissão e grupo de produção
- Valor total
- Data prevista de faturamento (emissão + lead time × 1,4 para converter úteis em corridos)
- Zona de confiança
- Status Omie (aprovado, disparado, aguardando)

Pedidos em zona vermelha merecem atenção: ou negocia antecipação de faturamento com Sayerlack, ou conta com eles caindo no trimestre seguinte.

---

## Checkin qualitativo

Os 8 critérios qualitativos são checkboxes que você marca junto com o André (vendedor Sayerlack). A avaliação pode ser feita em dois momentos:

**Projeção** (faça quando quiser durante o trimestre): estimativa sua do que vai atingir. Útil para usar no simulador.

**Confirmação com André** (~10 dias antes do fim do trimestre): avaliação oficial validada com o vendedor. Substitui a projeção como fonte de verdade para a DES Sayerlack.

### Os 8 critérios 2026

**1. Mix de produtos.** Pelo menos 50% do volume em PUs + componentes (FCs) + poliésteres + acrílicos + tingidores + nitros. Linhas especiais e commodity contam separado.

**2. Cursos técnicos.** Pelo menos 1 curso de capacitação para marceneiros ministrado no trimestre.

**3. Vendedores técnicos.** Ter vendedores externos com capacidade técnica Sayerlack (um especialista por loja). Avaliação dos Gerentes Regionais.

**4. Visibilidade no PDV.** Sistema tintométrico + produtos Sayerlack + amostras pintadas visíveis na área principal da loja.

**5. Visitas a especificadores.** Mínimo 15 especificadores por trimestre com comprovação (nome, email, CAU).

**6. Lâminas MGH.** Pelo menos 100 m² por mês = 300 m² por trimestre.

**7. Tingimix.** Volume de compra dos componentes do kit KIT.TMXKT + Bases + Concentrado.

**8. Venda direta.** Usar pró Real como referência ou lista indústria -20%, comissão única 4%. Abrir no mínimo 1 cliente por trimestre.

### Bônus objetivo (1%)

Separado dos 8 critérios. Concedido se você atingir o objetivo de volume do kit Tingimix + Bases + Concentrado. Vale 1,00% fixo em todas as faixas.

### Como salvar

No topo direito da tab, dropdown com dois botões:

- **"Salvar como Projeção"**: grava checkin tipo `projecao`. Usado pelo simulador como base.
- **"Salvar como Confirmação (com André)"**: grava tipo `confirmacao_andre`. Dialog de confirmação antes.

Cada checkin é uma linha nova em `des_checkin_qualitativo`. Todos os checkins do trimestre ficam guardados no histórico — dá para ver a evolução ao longo do trimestre.

O último checkin (independente do tipo) é o que o simulador e as views usam. Projeção vira referência até você confirmar com André; confirmação vira referência até o fim do trimestre.

---

## Simulador de decisão

O coração do módulo. Responde a pergunta "vale a pena puxar R$ X extras agora para subir de faixa?".

### Parâmetros

**Valor extra.** Quanto você consideraria adicionar aos seus pedidos normais do trimestre. Slider de R$ 0 a R$ 200.000.

Acima do slider há um chip de atalho: "Faltam para próxima faixa: R$ Y". Clicar preenche exatamente o mínimo para entrar na faixa superior.

**Prazo de pagamento.** Antecipado (à vista) ou 28/42/56 dias. No antecipado você ganha 2% de desconto; no 28/42/56 paga 2,56% de encargo financeiro. Outras condições podem ser adicionadas depois.

**Dias de estoque extra.** Quantos dias o volume extra vai ficar parado além do giro normal. Afeta custo de capital. Default 60.

### Como o sistema calcula

Cinco parcelas compõem o resultado:

**Nominal adicionado à NF.** É o que conta para meta DES. Se o prazo é antecipado, é igual ao valor extra. Se é 28/42/56, é inflado em 2,56% (o encargo faz o valor da NF ser maior que o pedido).

**Faixa nova.** Soma posição atual + nominal adicionado à NF. Identifica qual faixa DES você atingiria.

**Delta de desconto.** Diferença entre desconto total projetado (padrão + qualitativos atingidos + bônus) na faixa nova versus atual.

**Ganho futuro.** Delta × projeção do próximo trimestre (sua meta pessoal do próximo trimestre). É o R$ que você vai economizar em compras no próximo trimestre.

**Perdas no pedido atual.** Quatro componentes:

1. **Perda antecipado**: se você mudou de antecipado para prazo, perde o 2% que teria ganhado.
2. **Encargo prazo**: se está em 28/42/56, paga 2,56% de encargo.
3. **Frete**: 2,5% fixo sobre o valor extra.
4. **Custo de capital**: capital parado em estoque não rende. Calculado como `valor × taxa anual × dias/365`. A taxa anual vem da configuração da empresa (selic + spread + armazenagem). Para OBEN é ~25,75% ao ano.

**Saldo líquido** = Ganho futuro − Perdas totais.

### Recomendação do sistema

O simulador retorna uma recomendação textual baseada no saldo líquido:

- **Compensa** (saldo > R$ 1.000): verde, polegar para cima.
- **Compensa marginalmente** (saldo entre R$ 0 e R$ 1.000): amarelo, alerta.
- **Neutro** (saldo entre -R$ 1.000 e R$ 0): cinza, igual.
- **Não compensa** (saldo < -R$ 1.000): vermelho, polegar para baixo.

### Cenários típicos

**Cenário 1 — Puxar R$ 50k antecipado, posição atual R$ 100k:**

- Posição final: R$ 150k (faixa 5 — 2 estrelas)
- Não muda de faixa (já estava em 5)
- Delta: 0%
- Ganho futuro: R$ 0
- Perdas: frete R$ 1.250 + capital R$ 2.116 = R$ 3.366
- **Não compensa**. Volume não move faixa, você só paga os custos.

**Cenário 2 — Puxar R$ 100k em 28/42/56, posição atual R$ 300k:**

- Nominal na NF: R$ 102.560 (inflado por 2,56%)
- Posição final: R$ 402.560 — cruza a fronteira dos R$ 390.096 (4 estrelas)
- Delta de faixa: +0,49% no padrão, +0,56% em qualitativos = +1,05% total
- Ganho futuro: R$ 4.200 (1,05% × R$ 400k)
- Perdas: antecipado R$ 2.000 + encargo R$ 2.560 + frete R$ 2.500 + capital R$ 4.230 = R$ 11.290
- **Não compensa**. Ganho futuro (R$ 4k) não paga os custos (R$ 11k).

**Cenário 3 — Puxar R$ 10k para "completar meta", posição atual R$ 380k, antecipado:**

- Posição final: R$ 390k — cruza para faixa 3 (4 estrelas)
- Delta: +0,49% (padrão) + 0,56% (qualitativos) = 1,05%
- Ganho futuro: R$ 4.200
- Perdas: frete R$ 250 + capital R$ 423 = R$ 673
- **Compensa. Saldo R$ 3.527.** Volume pequeno + cruzar fronteira = decisão ótima.

### Paradoxo antecipado vs prazo

O 28/42/56 infla o valor da NF, fazendo você cruzar fronteiras de faixa com menos volume real. Mas tem custo econômico (antecipado perdido + encargo). Então:

- **Antecipado geralmente vence** quando o valor extra não cruza fronteira de faixa (só paga custo extra).
- **28/42/56 pode vencer** quando está exatamente na borda de uma faixa — a inflação nominal empurra para cima sem precisar aumentar volume real tanto.

O simulador expõe isso claramente com o comparador lado a lado.

### Comparador

Botão "Comparar com outro prazo" abre um segundo painel ao lado. Permite ver antecipado vs 28/42/56 com os mesmos parâmetros. Diferença de saldo líquido fica visível.

---

## Histórico

Tab com timeline vertical de todos os trimestres registrados, mais recente em cima.

### Cada card mostra

- Header: "T{X} {ano}" com badge "Em andamento" para corrente, "Meta atingida" em verde para encerrados com sucesso, "Meta não atingida" em vermelho para encerrados sem sucesso.
- Meta pessoal do trimestre.
- Faturado final (último snapshot) ou posição ao vivo.
- Faixa DES atingida.
- Desconto DES calculado para o trimestre seguinte.
- Link "Ver detalhes" abre modal com breakdown completo.

### Gráfico no topo

Barras verticais de faturamento trimestre a trimestre, linha horizontal com meta. Visualização rápida da evolução.

### Filtros

Seletor de ano e toggle "Em andamento / Encerrados / Todos".

---

## Snapshots do GoodData

### O que é o GoodData

É a plataforma BI da Sayerlack que consolida todos os dados de vendas dos distribuidores. Toda segunda-feira, a Sayerlack envia para `noreply@gooddata.com` um PDF com seus números do trimestre corrente.

### Estrutura do PDF

Páginas típicas:

- **Objetivo vs realizado**: Pot TRI X $ (meta), Fat Brt $ TRI X (faturado), % de atingimento, pedidos em aberto.
- **Comparativo histórico**: trimestre anterior, mês a mês, preço médio.
- **Critérios qualitativos**: mix de produtos por categoria, Nitro+Diluentes, Tingimix, Lâminas MGH.

### Como o sistema consome

Cada PDF vira um snapshot em `des_trimestre_snapshot` com campos:

- `data_referencia` (sábado anterior ao envio — corte do GoodData)
- `fat_bruto_valor` (Fat Brt $ TRI X)
- `objetivo_valor` (Pot TRI X $)
- `pedidos_abertos_valor` (valor em pedidos aguardando faturamento)
- Campos dos critérios (Lâminas m², Tingimix qtde, etc)

O snapshot mais recente é a fonte de verdade. Snapshots antigos ficam como histórico.

### Upload atual

Enquanto o polling automático de emails não está implementado, o snapshot precisa ser cadastrado **manualmente via SQL**. Formato:

```sql
INSERT INTO des_trimestre_snapshot (
  empresa, ano, trimestre,
  data_referencia, data_envio_email,
  objetivo_valor, fat_bruto_valor,
  -- outros campos...
) VALUES (
  'OBEN', 2026, 2,
  '2026-04-18', '2026-04-20 04:00:00-03',
  400840.02, 103068.74,
  -- ...
);
```

### Upload futuro (roadmap)

Polling automático vai ler `noreply@gooddata.com` toda segunda, extrair dados via Vision do Gemini, e criar snapshot. Alerta cria evento no Calendar avisando do novo snapshot.

---

## Conceitos financeiros

### Frete

Fixo 2,5% sobre valor do pedido. Sempre é aplicado, independente do prazo. O frete **não** conta para meta DES porque o CTe é emitido para você separadamente — não aparece na NF Sayerlack que vai para o GoodData.

No simulador, o frete é sempre uma perda. Mas não afeta a conta nominal de faixa.

### Prazos de pagamento

Dois configurados hoje:

**Antecipado (à vista)**: +2% de desconto direto. NF sai com valor = pedido. Prazo padrão.

**28/42/56 dias**: -2,56% de encargo financeiro. NF sai **inflada em 2,56%** — ou seja, o encargo está embutido no valor da NF que a Sayerlack emite.

Outros prazos podem ser adicionados depois via `fornecedor_prazo_pagamento_config`.

### Custo de capital

Capital parado em estoque tem custo de oportunidade. Mesmo que você não financie a compra, o dinheiro que está em tinta poderia estar rendendo em outro lugar (Selic + spread de oportunidade + custo físico de armazenagem).

A taxa anual é configurada em `empresa_configuracao_custos` e composta por:
- Selic anual (atualmente ~13%)
- Spread de oportunidade (ROI que você teria em outra aplicação)
- Armazenagem física (custo de espaço, seguro, deterioração)

Para OBEN: ~25,75% ao ano. Aplicado proporcionalmente aos dias de estoque extra: `valor × 0,2575 × dias / 365`.

### Paradoxo do encargo no DES

Como o 28/42/56 infla o valor da NF, ele paradoxalmente ajuda a bater meta DES nominal mesmo sendo pior economicamente. É importante entender para não ser enganado pela matemática:

Se você precisa bater R$ 390k e está em R$ 385k, puxar R$ 5k antecipado não cruza (fica em R$ 390k, na borda). Mas puxar R$ 5k em 28/42/56 vira R$ 5.128 nominais e cruza para faixa 3 (4 estrelas) com folga.

O ganho futuro de 1% de desconto extra pode pagar o custo do encargo — ou não, dependendo do volume do trimestre seguinte. O simulador mostra o saldo líquido.

---

## Troubleshooting

**Posição ao vivo mostra R$ 0**

Provavelmente não há snapshot GoodData cadastrado e também não há pedidos Sayerlack no sistema. Verifica:

```sql
SELECT COUNT(*) FROM des_trimestre_snapshot WHERE empresa='OBEN';
SELECT COUNT(*) FROM pedido_compra_sugerido WHERE fornecedor_nome='RENNER SAYERLACK S/A';
```

Se os dois retornam zero, cadastra um snapshot manual.

**Cards mostram "Meta pessoal: R$ 0"**

A meta do trimestre não foi cadastrada em `des_meta_empresa`. Cadastra:

```sql
INSERT INTO des_meta_empresa (empresa, ano, trimestre, meta_faturamento, faixa_des_objetivo)
VALUES ('OBEN', 2026, X, 400840.02, 3);
```

**Checkin qualitativo: cards não atualizam o desconto projetado**

Verifica se há uma faixa conservadora calculada. Se posição atual é zero, o sistema não consegue determinar faixa, e o cálculo de qualitativos depende da faixa. Solução: cadastrar snapshot ou ter pedidos no trimestre.

**Simulador retorna "Nenhuma faixa encontrada"**

Posição final (atual + extra) está abaixo de R$ 40.655 (piso da faixa 1 estrela). Aumenta o valor extra até cruzar a primeira faixa.

**Simulador mostra ganho futuro zero apesar de mudar faixa**

Provavelmente não há checkin qualitativo cadastrado. Sem checkin, o sistema assume zero qualitativos atingidos — e o delta de faixa só considera mudança de percentual padrão, que às vezes é pequena. Cadastra pelo menos uma projeção qualitativa.

**Pedido em trânsito está em zona vermelha, não vai faturar no trimestre**

Duas opções:
1. Negociar com Sayerlack antecipação da emissão da NF (às vezes conseguem acelerar).
2. Aceitar que vai cair no próximo trimestre (ajuda a bater meta do próximo, mas não ajuda este).

**Histórico não mostra trimestres anteriores**

Não há dados em `des_trimestre_snapshot`, `des_meta_empresa` ou `des_checkin_qualitativo` para aqueles trimestres. Histórico aparece apenas quando há registros reais. Trimestres futuros aparecem quando a meta é cadastrada.

**Preciso trocar minha meta pessoal no meio do trimestre**

Atualiza a linha de `des_meta_empresa` diretamente via SQL:

```sql
UPDATE des_meta_empresa 
SET meta_faturamento = NOVO_VALOR 
WHERE empresa='OBEN' AND ano=2026 AND trimestre=X;
```

Cards atualizam no próximo carregamento da página.

---

## Apêndice: diagrama de dados

**Versão do contrato:**
- `des_contrato_versao` — anos do contrato DES (2026, 2027, etc)

**Matriz:**
- `des_faixa_quantitativa` — 6 faixas com volume_min, volume_max, desconto_padrao_perc
- `des_criterio_qualitativo` — 8 critérios + bônus
- `des_criterio_percentual` — matriz de percentuais por (critério × faixa)

**Meta pessoal:**
- `des_meta_empresa` — meta de faturamento por (empresa, ano, trimestre)

**Snapshots:**
- `des_trimestre_snapshot` — leitura semanal do GoodData

**Checkins:**
- `des_checkin_qualitativo` — sessão de avaliação (projeção ou confirmação)
- `des_checkin_qualitativo_resposta` — resposta booleana para cada critério

**Prazos e custos:**
- `fornecedor_prazo_pagamento_config` — antecipado, 28/42/56, etc
- `fornecedor_custo_adicional_config` — frete fixo 2,5%

**Views principais:**
- `v_des_posicao_trimestre_ao_vivo` — posição consolidada snapshot + pedidos em trânsito
- `v_des_pedidos_em_transito` — pedidos Omie pós-snapshot com zona de confiança
- `v_des_snapshot_mais_recente` — último snapshot por trimestre
- `v_des_checkin_atual` — último checkin por trimestre
- `v_des_desconto_por_checkin` — desconto total projetado

**Funções:**
- `des_determinar_faixa(valor)` — faixa correspondente a um valor
- `des_data_faturamento_prevista(emissao, grupo)` — data estimada de NF
- `simular_puxar_volume_trimestre(empresa, ano, trim, valor_extra, prazo, dias)` — simulador core

---

_Documentação viva. Atualizações conforme o módulo evolui._
