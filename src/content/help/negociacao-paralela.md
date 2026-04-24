# Módulo Negociação Paralela

Sistema para gerar, gerir e concretizar negociações de desconto flat condicional com o gerente Sayerlack, fora do ciclo de promoção oficial mensal. O módulo responde duas perguntas de negócio:

1. **Quais SKUs valem a pena eu levar para o gerente negociar?**
2. **Como registro e acompanho uma negociação aberta até fechar em desconto?**

---

## Índice

1. [Conceito: desconto flat condicional](#conceito-desconto-flat-condicional)
2. [Ranking de candidatos](#ranking-de-candidatos)
3. [Sugestões proativas](#sugestões-proativas)
4. [Fluxo de negociação](#fluxo-de-negociação)
5. [Conversão em campanha](#conversão-em-campanha)
6. [Monitoramento de ofertas ativas](#monitoramento-de-ofertas-ativas)
7. [Integração com outros módulos](#integração-com-outros-módulos)
8. [Troubleshooting](#troubleshooting)

---

## Conceito: desconto flat condicional

### O que é

A Sayerlack oferece dois tipos de desconto fora do DES trimestral:

**Promoção oficial mensal.** Lista fechada de SKUs com desconto por 2-4 semanas, definida pela Juliana. Aplicável para todos os distribuidores.

**Desconto flat condicional.** Oferta pontual, negociada caso a caso. O gerente (André ou Paulo) oferece desconto específico num SKU específico, condicionado a você atingir volume X no mês. Não aparece em lista oficial — é acordo particular.

### Quando acontece

Três gatilhos típicos:

1. **Gerente oferece proativamente.** André liga ou manda email dizendo "se você fechar 20 unidades de NLO.9525.00 esse mês, tem +8% de desconto". Você registra no sistema como campanha tipo `desconto_flat_condicional`.

2. **Você vai atrás.** Em vez de esperar, você identifica um SKU candidato (via o ranking do sistema), liga para André e propõe "preciso de desconto em X, posso fechar Y unidades". Se ele topar, mesmo registro.

3. **Sistema sugere.** No fim do mês, o sistema identifica SKUs com score alto que não tiveram promoção nos últimos meses e sugere: "Vale ligar para o gerente esta semana sobre SKU Z". Você decide se abordar.

O módulo de Negociação Paralela cobre os três caminhos.

### Diferença da promoção com "desconto extra"

Na promoção oficial, você pode ter `desconto_extra_perc` negociado em cima do desconto oficial (ex: oficial 20% + extra 8% = 28% total). Isso é diferente do flat condicional. No flat condicional, não há promoção oficial do SKU — o desconto inteiro é condicional.

Comparação:

- **Promoção + desconto extra**: "estou em promoção, negociei um adicional"
- **Flat condicional**: "NÃO estou em promoção, estou em acordo particular"

Ambos viram campanhas em `promocao_campanha`, mas com `tipo_origem` diferente.

---

## Ranking de candidatos

### O algoritmo

O sistema analisa seu histórico de compras Sayerlack dos últimos 365 dias e classifica cada SKU com score de 0 a 100 combinando quatro dimensões:

**Score volume financeiro (peso 1.0).** Quanto mais você gasta nesse SKU, maior o score. SKU que representa R$ 15 mil por ano tem score mais alto que SKU de R$ 1 mil.

**Score consistência (peso 0.8).** Baixa variabilidade nos valores mensais = alto score. Se você compra 5 unidades todo mês, consistência alta. Se um mês compra 50 e outro mês 2, consistência baixa. A lógica: SKU consistente é candidato confiável para desconto condicional porque o gerente sabe que você vai cumprir o volume.

**Score preço unitário (peso 0.6).** Quanto mais caro o SKU, maior o score. Ganhar 1% num SKU de R$ 1.000 vale mais que ganhar 10% num SKU de R$ 50. Um percentual pequeno em SKU caro movimenta mais dinheiro.

**Score ausência de promoção (peso 0.4).** SKU que nunca entrou em promoção oficial nos últimos 12 meses tem score 100. Cada mês que entrou reduz o score. Lógica: SKU com promoção frequente não precisa de negociação paralela (você já ganha pelo oficial). SKU sem promoção é candidato ideal.

### Score final e categorias

A ponderação das quatro dimensões gera o **score final** de cada SKU (0-100). Categorias baseadas no score final:

| Score | Categoria | Uso |
|-------|-----------|-----|
| ≥ 80 | Prioritário | Levar logo para o gerente |
| 60-79 | Forte | Vale tentar em um momento oportuno |
| 40-59 | Moderado | Considerar em pacote de negociação maior |
| < 40 | Fraco | Provavelmente não vale a pena perseguir |

### Onde ver o ranking

Página `/admin/reposicao/negociacao-paralela`, bloco 2 (inferior). Tabela paginada com todos os SKUs Sayerlack ordenados por score, com filtros por categoria e busca.

Quatro cards no topo do bloco mostram distribuição — quantos prioritários, fortes, moderados, fracos.

### Refresh do ranking

O ranking é uma **materialized view** (`mv_sku_ranking_negociacao_paralela`). Não atualiza em tempo real — é calculado e armazenado.

Refresh automático: uma vez por semana via cron (segundas às 07:00). Use botão "Atualizar ranking agora" no topo do bloco 2 se precisar do estado mais recente imediatamente. Leva alguns segundos.

### Quando o ranking pode ser impreciso

**SKU novo sem histórico.** Se tem menos de 1 compra nos últimos 365 dias, não entra no ranking. Quando começar a comprar, entra automaticamente no próximo refresh.

**Lista de mudança de mix.** Se você mudou de estratégia recentemente (parou de comprar um produto, começou outro), o ranking pega 365 dias inteiros — pode mostrar SKU antigo ainda como relevante. Dá tempo para o ranking se ajustar conforme o histórico se atualiza.

**Compras de oportunidade distorcem?** Não. O ranking só considera compras com `origem_compra = 'normal'`. Compras via ciclo de oportunidade (promo ou aumento) são filtradas.

---

## Sugestões proativas

### Como são geradas

Diferente do ranking (lista fria de candidatos), **sugestão** é uma recomendação ativa: "esse SKU vale ligar hoje". Sugestões são criadas pela função `sugerir_negociacao_paralela_hoje`.

A função combina o ranking com heurística temporal:

**Heurística "combinação" (dias 20+).** No fim do mês (a partir do dia 20), para SKUs categoria prioritário ou forte sem promoção recente, gera sugestão com motivo "Candidato X (score Y) sem promoção nos últimos Z% dos meses, estamos em fim de mês. Momento ótimo para negociar."

**Heurística "candidato forte" (sempre).** Para SKUs prioritário ou forte que raramente entram em promoção (menos de 30% dos meses), independente da data, sugere abordar com motivo explicativo.

**Heurística "fim de mês genérico".** Para SKUs categoria moderado no fim do mês, sugestão genérica para considerar completar volume via negociação.

**Heurística "top ciclo semanal".** Para SKUs de score alto fora dos gatilhos acima, sugestão "top candidato vale avaliar".

### Ciclo de vida de uma sugestão

Cada sugestão nasce com status `nova` e evolui:

- **nova**: recém-criada, você ainda não abriu
- **visualizada**: abriu o card, marcou como visto
- **acao_tomada**: você ligou/mandou email para o gerente, negociação em curso
- **fechada_desconto**: negociou e fechou (converteu em campanha)
- **fechada_sem_acordo**: contatou mas não rolou
- **ignorada**: decidiu não agir, ou expirou sem ação

Cada sugestão tem `valido_ate` (14 dias por padrão). Sugestões expiradas viram `ignorada` automaticamente na próxima execução.

### Geração automática vs manual

**Automática**: diariamente via cron (programa o horário, tipicamente 08:00). A função gera até 10 sugestões por execução, evitando duplicar SKUs que já têm sugestão ativa ou campanha ativa.

**Manual**: botão "Gerar novas sugestões" na página. Força execução imediata. Útil quando quer testar novas sugestões ou se o cron falhar.

### Por que um SKU não recebe sugestão

O sistema **não gera sugestão** para SKUs que:

- Estão fora das categorias prioritário/forte/moderado (fracos não entram)
- Já têm sugestão ativa (status nova/visualizada/acao_tomada)
- Já têm campanha flat condicional ativa ou em negociação
- Não aparecem no ranking (menos de 1 compra em 365 dias)

Para forçar uma sugestão em SKU específico fora do fluxo automático, use o botão "Criar sugestão" na tabela de ranking.

---

## Fluxo de negociação

Roteiro operacional para maximizar acordos:

### Passo 1 — Revisão semanal

Toda segunda ou terça, abre `/admin/reposicao/negociacao-paralela`. Veja quantas sugestões novas apareceram. Se houver muitas (5+), priorize por categoria prioritário.

Para cada sugestão, leia o motivo em português. O sistema já explica por que esse SKU é bom candidato. Considere também:

- Valor da compra potencial (volume 12m × 8% hipotético)
- Seu relacionamento atual com o gerente (ele está responsivo?)
- Tamanho do pacote que consegue prometer

### Passo 2 — Abordagem

Marque a sugestão como "visualizada" antes de contatar o gerente. Isso organiza o que já foi triado.

Na conversa com o gerente:

- Apresente o SKU específico
- Proponha volume que você consegue fechar (realista, não inflado)
- Peça desconto percentual razoável (8-15% típico para flat condicional)
- Negocie data fim (prazo para atingir o volume)

Se ele topa com ajuste, passe para o próximo passo. Se propõe condição diferente, anote e decida se vale. Se recusa, marque sugestão como "fechada_sem_acordo" e anote motivo.

### Passo 3 — Marcar "em andamento"

Assim que tiver conversa encaminhada (mesmo antes de fechar), marque a sugestão como `acao_tomada` via botão "Marcar como em andamento". Isso registra que você está trabalhando nela.

### Passo 4 — Fechar acordo

Quando tiver acordo confirmado por escrito (email ou WhatsApp), clique "Registrar desconto fechado". Dialog pede:

- **Desconto percentual**: o que ficou acordado (ex: 8%)
- **Volume mínimo condicional**: quanto precisa fechar (ex: 20 unidades)
- **Unidade**: unidades, reais, kg ou litros
- **Data fim**: até quando para atingir volume
- **Responsável**: nome do gerente (André, Paulo, etc.)
- **Canal**: como fechou (email, whatsapp, ligação, visita)
- **Observações**: contexto livre

Ao confirmar, o sistema:

1. Cria campanha em `promocao_campanha` com `tipo_origem = 'desconto_flat_condicional'`
2. Adiciona o SKU como item na campanha com o desconto acordado
3. Marca a sugestão como `fechada_desconto` com link para a campanha
4. Redireciona para a página da campanha nova

### Passo 5 — Durante o mês

A campanha fica em estado `negociando` até você ativar. Para que ela passe a afetar oportunidades de compra, ativa normalmente como qualquer outra campanha na página de promoções.

Enquanto está ativa e você está perseguindo o volume, o sistema não adiciona esse SKU automaticamente ao ciclo de oportunidade (flat condicional tem `permite_pedido_oportunidade = false` por padrão). A responsabilidade de atingir volume é sua, manual.

### Passo 6 — Final do prazo

Quando atingir o volume mínimo, manualmente muda o `status_aceite` da campanha para `cumprida`. Isso registra o sucesso.

Se não atingir no prazo, muda para `expirada`. Isso ainda preserva o histórico para futura análise (você pode ter fechado a negociação mesmo sem atingir).

---

## Conversão em campanha

### O que acontece tecnicamente

A função SQL `converter_sugestao_em_campanha_flat` executa transação atômica:

1. Cria linha em `promocao_campanha` com:
   - `tipo_origem = 'desconto_flat_condicional'`
   - `estado = 'negociando'` (não ativa ainda, você decide quando ativar)
   - `nome = 'Desconto Flat Condicional - {SKU}'`
   - Datas preenchidas a partir do dialog
   - Campos específicos do flat: `responsavel_oferta_nome`, `canal_oferta`, `data_oferta`, `volume_minimo_condicional`, `volume_minimo_unidade`, `status_aceite = 'aceita'`, observações
   - `permite_pedido_oportunidade = false` (explicação acima)

2. Cria linha em `promocao_item` com:
   - `sku_codigo_omie` da sugestão
   - `desconto_base_perc` preenchido
   - `mapeamento_origem = 'sugestao_sistema'` e `mapeamento_confianca = 1.0`
   - `ativo = true`

3. Atualiza sugestão:
   - `status = 'fechada_desconto'`
   - `campanha_id_gerada = {id da campanha}`
   - `data_acao = now()`

### Por que precisa ativar depois

A campanha é criada em estado `negociando`, não `ativa`. Isso dá espaço para:

- Revisar dados antes de comprometer
- Aguardar confirmação formal do gerente
- Ajustar condições (data, desconto, volume)
- Decidir quando começar a valer

Quando estiver confortável, ativa via botão "Ativar campanha" na página de detalhe da campanha, como qualquer outra.

---

## Monitoramento de ofertas ativas

Campanhas flat condicionais ativas aparecem em dois lugares:

### Lista de promoções

Em `/admin/reposicao/promocoes`, aparecem junto com as oficiais. Filtra por tipo de origem para ver só as flat condicionais.

### View de ofertas ativas (futuro)

Existe view `v_desconto_flat_condicional_ativo` que o backend pode consumir. Será usada para dashboard específico "Quais negociações condicionais estão ativas e próximas do prazo" em iteração futura.

### Urgência

Cada oferta tem cálculo automático de urgência:

- **expirada**: passou da data_fim (deveria estar marcada como `cumprida` ou `expirada` em `status_aceite`)
- **urgente**: menos de 3 dias para o fim
- **atencao**: 3-7 dias
- **confortavel**: mais de 7 dias

Alertas urgentes aparecem no topo das páginas relacionadas.

### Quando uma campanha flat está vigente

Enquanto `estado = 'ativa'` e a data atual está entre `data_inicio` e `data_fim`:

- O SKU aparece em oportunidades com cenário apropriado (se cruzar com outras lógicas, tipo aumento anunciado)
- Pedidos normais desse SKU **recebem automaticamente o desconto** quando compra Sayerlack (a Sayerlack aplica, não o sistema)
- O valor do faturamento reduzido é capturado no snapshot GoodData quando vier

---

## Integração com outros módulos

### Com Eventos Comerciais

Negociação paralela **é** um subtipo de Eventos Comerciais. A campanha criada tem mesma estrutura das promoções oficiais, só difere em `tipo_origem`. Todo o fluxo de aprovação, ativação, itens, e histórico é compartilhado.

### Com Avaliação Trimestral DES

Descontos flat condicionais afetam a NF Sayerlack — o valor faturado pode ser menor pelo desconto. Isso impacta a posição trimestral DES. O snapshot GoodData captura automaticamente.

Considere: se o acordo dá 8% de desconto em R$ 20.000 de compras, você "perde" R$ 1.600 de faturamento que conta para DES. Mas economiza R$ 1.600 líquidos. Trade-off neutro ou positivo financeiramente (economia pura) mas levemente negativo para meta DES. Em decisões próximas de fronteira de faixa, vale rodar o simulador antes de fechar.

### Com módulo de Reposição

O SKU em campanha flat condicional aparece normalmente em reposição. Quando chega no ponto de pedido, o sistema sugere comprar — e o desconto é aplicado automaticamente pela Sayerlack.

Como `permite_pedido_oportunidade = false` em flat condicional, o SKU **não** é "puxado" para antes do tempo pelo ciclo de oportunidade. Você compra conforme giro normal.

---

## Troubleshooting

**Ranking retorna vazio**

Pode ser uma de três causas: (a) `sku_leadtime_history` não tem compras Sayerlack no último ano, (b) nenhum SKU tem pelo menos 1 compra no período, (c) materialized view não foi refreshada ainda. Rode o refresh manualmente: `SELECT refresh_sku_ranking_negociacao();`.

**Sugestão não apareceu para um SKU que deveria**

Verifica se o SKU:
1. Está no ranking com categoria prioritário/forte/moderado
2. Não tem outra sugestão ativa (status nova/visualizada/acao_tomada)
3. Não tem campanha flat condicional ativa

Se passou nos 3 filtros, tenta forçar geração via "Gerar sugestões agora". Se ainda não aparecer, use "Criar sugestão" direto na linha do ranking.

**Conversão em campanha falha**

Dialog rejeita salvar: provavelmente algum campo obrigatório em branco. Confere desconto (número entre 0 e 50), volume mínimo (número positivo), data fim (posterior a hoje).

**Sugestão antiga continua em "nova" mesmo já expirada**

A expiração automática roda junto com `sugerir_negociacao_paralela_hoje`. Se não foi executada recentemente, expirações pendentes ficam. Forçar via botão "Gerar novas sugestões" também limpa as expiradas.

**Erro de função "sku_codigo_omie is ambiguous"**

Bug de versão antiga da função (anterior ao fix com prefixo `out_` nos parâmetros de retorno). Se aparecer, confirmar que a função atual está com os parâmetros `out_sugestao_id`, `out_sku_codigo_omie`, etc. via: `\df sugerir_negociacao_paralela_hoje` no psql.

**Score alto mas categoria "fraco"**

Score final considera os 4 componentes ponderados. Um SKU pode ter volume alto mas preço unitário baixo + alta frequência de promoção, levando à categoria fraco. A categoria reflete equilíbrio dos fatores.

**Campanha flat condicional criada mas não aparece em oportunidades**

Estado provável é `negociando`. Para afetar oportunidades, precisa ativar explicitamente. Abre a campanha em `/admin/reposicao/promocoes/:id`, clica "Ativar" na sidebar.

**Quero remover uma sugestão sem apagar**

Use botão "Ignorar". A sugestão muda status para `ignorada` e sai da tela principal, mas fica no histórico. Isso preserva contexto se quiser analisar depois "SKU X foi ignorado 3 vezes nos últimos 6 meses, talvez não seja bom candidato".

---

## Apêndice: diagrama de dados

**Ranking e sugestões:**
- `mv_sku_ranking_negociacao_paralela` — materialized view com scores e categorias de todos os SKUs Sayerlack elegíveis
- `sugestao_negociacao_paralela` — sugestões geradas com ciclo de vida completo

**Campanhas flat condicionais:**
- `promocao_campanha` com `tipo_origem = 'desconto_flat_condicional'` — extends estrutura existente
- Campos específicos: `responsavel_oferta_nome`, `canal_oferta`, `data_oferta`, `volume_minimo_condicional`, `volume_minimo_unidade`, `status_aceite`, `observacoes_negociacao`

**Views:**
- `v_desconto_flat_condicional_ativo` — campanhas flat condicionais em status operacional
- `v_sugestao_negociacao_ativa` — sugestões em ciclo de vida ativo com dados de ranking

**Funções:**
- `refresh_sku_ranking_negociacao()` — atualiza o ranking semanalmente
- `sugerir_negociacao_paralela_hoje(empresa, limite)` — gera sugestões proativas
- `converter_sugestao_em_campanha_flat(sugestao_id, desconto, volume, unidade, data_fim, responsavel, canal, observacoes)` — transforma sugestão em campanha concreta

---

_Documentação viva. Atualizações conforme o módulo evolui._
