# Módulo de Eventos Comerciais

Sistema integrado para gerir **promoções**, **aumentos anunciados** e **oportunidades de compra** do fornecedor Renner Sayerlack S/A. Este módulo consolida desconto promocional, antecipação de compra antes de aumento, negociações paralelas e ciclo automático de pedidos de oportunidade.

Toda a lógica econômica (quanto comprar, quando comprar, quanto você vai economizar) é calculada automaticamente pelo sistema a partir dos dados que você cadastra. O seu trabalho é manter os dados atualizados e decidir ativar ou não as campanhas.

---

## Índice

1. [Visão geral](#visão-geral)
2. [Fluxo mensal típico](#fluxo-mensal-típico)
3. [Promoções](#promoções)
4. [Aumentos anunciados](#aumentos-anunciados)
5. [Oportunidades unificadas](#oportunidades-unificadas)
6. [Ciclo de oportunidade](#ciclo-de-oportunidade)
7. [Negociações paralelas](#negociações-paralelas)
8. [Alertas](#alertas)
9. [Polling automático de emails](#polling-automático-de-emails)
10. [Troubleshooting](#troubleshooting)

---

## Visão geral

### O que o módulo faz

O módulo olha para três fontes de informação — o que você tem em estoque, o que está em promoção na Sayerlack, e quais aumentos estão por vir — e responde duas perguntas:

1. **O que eu deveria comprar hoje para maximizar economia?**
2. **Quando vai ter um ciclo especial de compra que não posso perder?**

Essas respostas aparecem consolidadas na **Página de Oportunidades** (`/admin/reposicao/oportunidades`), que é a tela central operacional.

### Vocabulário

- **Campanha**: uma promoção específica com janela de validade, descontos e SKUs afetados. Ex: "DES Promo Abril 2ª Quinzena 2026".
- **Aumento**: um anúncio de reajuste de preços futuro, com categorias de produtos afetadas e data de vigência.
- **Oportunidade**: um SKU que, hoje, vale a pena comprar por razão econômica — desconto de promoção, antecipação de aumento, ou ambos.
- **Cenário**: tipo de oportunidade. Pode ser `promo_flat`, `promo_volume`, `aumento_apenas`, ou `promo_e_aumento`.
- **Ciclo de oportunidade**: geração especial de pedidos que roda em datas críticas (último dia da promoção ou véspera de aumento). Diferente do ciclo normal diário de reposição.
- **Desconto extra negociado**: acordo esporádico seu com a Sayerlack para ter desconto adicional além da promoção oficial. Registrado manualmente.
- **Suspensão**: quando a Sayerlack encerra promoção antes do fim previsto. Gera alerta urgente.

### Limites de atuação

O sistema **não** aplica descontos no preço Omie — a Sayerlack aplica automaticamente quando você compra. O sistema **simula** quanto você vai economizar e sugere quanto comprar. Você ainda precisa colocar o pedido pelo fluxo normal (ciclo diário ou manual).

O sistema também **não** fala com Sayerlack. Não envia pedido, não confirma. Ele apenas prepara suas decisões.

---

## Fluxo mensal típico

Rotina esperada todo mês, do primeiro ao último dia:

**Início do mês (dia 1-3)**

Juliana (juliana@sayerlack.com.br) envia o PDF da promoção mensal. O polling automático baixa, extrai e cria campanha em estado `rascunho`. Alerta aparece no sistema.

Se o polling falhar ou se você preferir cadastrar manualmente, abre `/admin/reposicao/promocoes`, clica "Upload PDF", seleciona o arquivo. Extração automática cria rascunho.

**Revisão da campanha (1-2 horas após receber)**

Abre `/admin/reposicao/promocoes/:id` da campanha nova. Revisa: nome, datas de vigência, data de corte de pedido, data de corte de faturamento.

Tab "Itens" mostra SKUs extraídos. Cada linha tem um badge de mapeamento:

- Verde "OK" ou "Variante": o sistema mapeou para SKU Omie com confiança total. Nada a fazer.
- Azul "Manual": resolvido manualmente antes por você. Nada a fazer.
- Amarelo "Revisar - similaridade": sistema encontrou o SKU por busca aproximada (erro de grafia no PDF). Clica no badge para confirmar.
- Vermelho "Não encontrado": código no PDF não bate com nenhum SKU Omie OBEN. Clica no badge, busca manualmente no combobox, seleciona e confirma. Se não houver correspondência legítima, pode deletar a linha.

Quando todas as linhas estiverem confirmadas, botão "Ativar campanha" na sidebar direita passa a estar disponível. Clica para mudar estado para `ativa`.

**Ativação cria efeitos automáticos:**

1. Gera alerta `promocao_nova` na tabela de alertas
2. Cria evento no seu Google Calendar no dia `data_corte_pedido - 1 dia útil`, 08:00-10:00, chamado "Revisar pedidos oportunidade — [nome da campanha]"
3. Envia email para `lucascoelhosardenberg@gmail.com`

**Durante o mês**

Visita `/admin/reposicao/oportunidades` para ver SKUs com economia potencial. Acompanha:

- Economia total acumulada disponível
- Quantos SKUs têm oportunidade
- Quantos dias até a data limite mais próxima

Sempre que colocar pedido normal de reposição, o sistema já aplica desconto automaticamente aos SKUs em promoção flat (você não precisa fazer nada extra).

**Negociação esporádica de desconto extra (quando acontecer)**

Se você negociar desconto adicional com Sayerlack fora da campanha oficial (ex: +8% além dos 20% da promoção), registra assim: abre `/admin/reposicao/promocoes/:id` da campanha ativa, Tab Itens, clica "+ extra" no SKU específico, preenche percentual, observações, e salva.

A partir desse momento, o cálculo de economia desse SKU passa a considerar o desconto aditivo (base + extra).

**Último dia útil da campanha (geralmente dia 30 ou 31)**

Às 8:00 da manhã, o ciclo de oportunidade roda automaticamente. Gera pedido especial com todos os SKUs que valem a pena comprar aproveitando a promoção. Email chega avisando.

Você revisa o pedido gerado em `/admin/reposicao/pedidos`, ajusta se necessário, aprova. Às 10:00 o pedido é disparado para Sayerlack via API Omie.

**Final do mês**

Campanha muda automaticamente para estado `encerrada` quando `data_fim` é atingida. Nenhuma ação necessária.

---

## Promoções

### Cadastro via PDF (preferido)

Em `/admin/reposicao/promocoes`, botão "Upload PDF". Você pode:

- Marcar "Upload em lote" e selecionar vários arquivos ao mesmo tempo (útil para subir histórico antigo)
- Deixar desmarcado para upload de um só arquivo com redirect automático para o detalhe

O Gemini extrai nome, datas, lista de códigos Sayerlack e percentuais de desconto. Confiança (0 a 1) mostrada na interface: verde (>0.8) é confiável, amarelo (0.5-0.8) requer revisão, vermelho (<0.5) provavelmente falhou.

### Cadastro manual

Botão "Nova campanha" em `/admin/reposicao/promocoes`. Preenche campos e adiciona itens um a um na Tab Itens. Útil quando não tem PDF ou quer criar negociação paralela.

### Estados de uma campanha

- **Rascunho**: recém-criada. Ainda não afeta cálculo de oportunidades. Pode ser editada livremente.
- **Negociando**: só para campanhas `tipo_origem = 'negociacao_cliente'`. Indica que você está em tratativas com Sayerlack. Não afeta oportunidades.
- **Ativa**: vigente. Aparece em oportunidades. Tem alerta gerado.
- **Encerrada**: passou da `data_fim`. Histórico. Não afeta oportunidades.
- **Cancelada**: abortada manualmente ou por suspensão da Sayerlack. Alerta urgente quando cancelada durante vigência.

### Desconto extra negociado

Quando Sayerlack dá desconto além da promoção oficial (geralmente por negociação sua), registra em cada SKU afetado:

- Percentual extra (0-50%)
- Observação (com quem negociou, quando)
- Referência (assunto do email, se houver)

O desconto efetivo é aditivo: promoção 20% + extra 8% = 28%. Tooltip na tabela mostra a decomposição.

### Campos importantes da campanha

- **data_inicio**: quando promoção começa a valer. Default: segundo dia útil do mês.
- **data_fim**: quando promoção termina oficialmente. Default: último dia útil do mês.
- **data_corte_pedido**: último dia para colocar pedido dentro das regras normais. Default: igual data_fim.
- **data_corte_faturamento**: último dia em que a NF deve sair. Pode cair no mês seguinte. Default: último dia do mês subsequente a data_fim.

Você pode esticar `data_corte_pedido` e `data_corte_faturamento` quando negociar com Sayerlack, desde que Sayerlack confirme.

---

## Aumentos anunciados

### Diferença de promoção

Promoção é benefício passageiro — compre enquanto vale. Aumento é prejuízo futuro — compre antes de pagar mais. A matemática é simétrica com sinal trocado: evitar aumento de 5% equivale a ganhar desconto de 5%.

### Cadastro via PDF

Emails de aumento vêm de `sc@sayerlack.com.br` com assunto "Reajuste de preços...". O polling automático processa igual às promoções. Ou upload manual em `/admin/reposicao/aumentos`.

A extração identifica:
- Nome do anúncio
- Data de vigência (quando o preço novo começa)
- Categorias afetadas com percentuais (ex: "Diluentes PU - 5%")
- Opcionalmente, datas de vigência específicas por categoria

### Estados

- **Rascunho**: recém-criado, sem mapeamentos.
- **Ativo**: confirmado, aguardando data de vigência. Gera alertas e oportunidades.
- **Vigente**: passou da `data_vigencia`. Preços já subiram.
- **Expirado**: automaticamente após 30 dias de vigência. Histórico.
- **Cancelada**: abortado manualmente.

### Mapeamento categoria → famílias Omie

**Etapa crítica**: o PDF traz categorias em texto ("Diluentes PU", "Tintas Nitrocelulose"). O sistema precisa saber quais famílias do seu catálogo Omie correspondem a cada categoria.

Tab "Categorias e mapeamento" da página de detalhe. Para cada categoria extraída:

1. Ajusta o percentual se veio errado
2. Clica em "Mapeamento" da linha
3. No diálogo, marca opção "Aplicar a TODA a família" e seleciona as famílias Omie correspondentes (pode ser mais de uma)
4. Ou desmarca a opção e seleciona SKUs individuais específicos (raro, só se precisar de granularidade)
5. Salva
6. Marca checkbox "Confirmado" da categoria

### SKUs afetados

Tab "SKUs afetados" mostra em tempo real quais produtos serão atingidos pelo aumento. Valida antes de ativar. Se aparecer produto que não faz sentido, volta e ajusta o mapeamento.

### Ativação

Na sidebar direita, botão "Ativar anúncio" só habilita quando todas as categorias confirmadas tiverem pelo menos uma família mapeada. Ativação cria evento no Calendar para `data_vigencia - 1 dia útil` e envia email.

---

## Oportunidades unificadas

Página `/admin/reposicao/oportunidades`. Visão consolidada de todos os SKUs que valem a pena comprar hoje.

### Cards do topo

**Economia total potencial**: soma da economia bruta estimada de todos os SKUs com oportunidade ativa. Considera promoção + aumento simultaneamente.

**SKUs com oportunidade**: quantos SKUs têm algum benefício hoje, de quantos você tem cadastrados no total.

**Data limite mais próxima**: o SKU com prazo mais apertado para agir. Badge amarelo se menos de 7 dias, vermelho se menos de 3.

**Ciclo oportunidade do dia**: se hoje é dia em que um ciclo especial roda (último dia útil de campanha ou véspera de aumento), mostra botão para disparar. Se não, status cinza.

### Cenários

Cada linha da tabela tem um cenário que define a natureza da oportunidade:

- **promo_flat**: SKU em promoção sem volume mínimo. Compra normal já captura desconto. Sem antecipação necessária.
- **promo_volume**: SKU em promoção com volume mínimo. Vale inflar quantidade se economia líquida (desconto - custo de capital) for positiva.
- **aumento_apenas**: SKU não está em promoção mas vai sofrer aumento. Vale antecipar compra dentro do teto de "fim do mês subsequente ao aumento".
- **promo_e_aumento**: SKU está em promoção E vai sofrer aumento. Benefício aditivo, melhor momento para comprar.

### Como agir em cada cenário

**promo_flat**: nada especial. Seu ciclo normal de reposição já pega o desconto quando SKU atingir ponto de pedido. Você só vai ver esse SKU na lista porque economia existe, mas ação é automática.

**promo_volume**: se volume mínimo é maior que sua compra normal, sistema sugere inflar para atingir volume. Você decide se vale aceitar o estoque extra.

**aumento_apenas**: antecipar compra é a ação. No ciclo de oportunidade automático (um dia antes da vigência), sistema gera pedido com quantidade suficiente para cobrir até fim do mês subsequente.

**promo_e_aumento**: prioridade máxima. Maior benefício combinado. Ciclo especial vai pegar o maior entre "corte de promoção" e "véspera de aumento" para disparar.

### Decomposição por SKU

Expand de cada linha abre drawer lateral com:

- Parâmetros do SKU (demanda diária, preço EOQ, custo de capital aplicado, status de reposição)
- Card da campanha de promoção (se houver) com link para detalhe
- Card(s) de aumento(s) afetando (se houver) com link para detalhe
- Cálculo textual: "Comprando X unidades nos próximos Y dias captura Z% de benefício total, economizando R$ W bruto"

### Gerar ciclo manualmente

Se quiser disparar o ciclo fora do dia agendado (ex: você vai estar ausente no dia previsto), botão "Gerar ciclo oportunidade" no topo direito. Confirma, sistema gera pedidos especiais agora.

---

## Ciclo de oportunidade

### Quando roda

Automaticamente pelo cron diário, quando:

- `data_corte_pedido` de alguma campanha ativa bate com hoje, OU
- `data_vigencia` de algum aumento bate com amanhã (hoje é a véspera)

Horário fixo: 08:00 BRT.

### O que gera

Pedidos de compra com `tipo_ciclo = 'oportunidade_promo'` ou `oportunidade_aumento`, separados do ciclo normal. Aparecem em `/admin/reposicao/pedidos` com badge específico.

### Diferença do ciclo normal

Ciclo normal é diário, roda para todo SKU que atingiu ponto de pedido. Ciclo oportunidade é pontual, roda para SKUs que têm benefício econômico naquele dia específico.

Importante: pedidos de oportunidade **não contaminam** as estatísticas de lead time. Tem campo `origem_compra` em `sku_leadtime_history` que separa: só pedidos normais alimentam o cálculo de lead time. Isso protege os parâmetros de reposição de serem distorcidos por compras atípicas.

### Revisão e disparo

Mesmo fluxo do ciclo normal:

1. Ciclo gera pedidos em estado `pendente_aprovacao`
2. Você revisa em `/admin/reposicao/pedidos`
3. Aprova ou ajusta quantidades
4. Às 10:00 BRT, o disparador automático envia para Sayerlack via Omie

Se quiser ajustar antes das 10:00, você tem a manhã inteira.

---

## Negociações paralelas

### Quando usar

Promoção oficial da Sayerlack tem condições fixas. Mas às vezes você negocia condições especiais com um gerente ou vendedor, fora do catálogo oficial. Essas negociações são modeladas como campanhas `tipo_origem = 'negociacao_cliente'`.

Exemplos:
- Desconto extra em um SKU específico por volume
- Extensão de prazo de faturamento
- Condição especial em um ou dois SKUs pontuais

### Fluxo

Cria campanha manualmente em `/admin/reposicao/promocoes` → "Nova negociação". Estado inicial `negociando`.

Na Tab "Negociação" da campanha, registra eventos da conversa: proposta enviada, contraproposta recebida, aceite, recusa. Cada evento tem tipo, percentual proposto, volume mínimo proposto, conteúdo em texto livre e data.

A timeline serve como memória da negociação. Útil quando ela se estende por dias e você esquece onde parou.

Quando chegar a acordo, muda estado para `ativa` e o sistema passa a considerar nas oportunidades.

### Escolha de SKU para negociação paralela

No SQL 16 (em desenvolvimento) vai ter um ranking de SKUs candidatos a negociação paralela baseado em giro, volume e preço. Atualmente você escolhe baseado na sua experiência.

---

## Alertas

### Tipos e severidades

Tabela `fornecedor_alerta` centraliza avisos do sistema. Aparecem como badge no menu lateral e na página de Oportunidades.

- **promocao_nova** (info): campanha foi ativada. Cria evento de Calendar.
- **promocao_suspensa** (urgente): campanha cancelada durante vigência. Email imediato.
- **aumento_anunciado** (atenção): aumento cadastrado e ativado. Evento de Calendar para véspera.
- **polling_erro** (atenção): polling de email falhou. Investigar configuração.
- **mapeamento_pendente** (info): aumento cadastrado mas categorias sem mapeamento de família.
- **oportunidade_calculada** (atenção): ciclo oportunidade rodou, X pedidos gerados.

### Ação esperada

Cada alerta tem título e mensagem clara sobre o que fazer. A maioria se resolve visitando a página correspondente (campanha, aumento, pedidos). Alerta marca como resolvido automaticamente quando você age.

### Canais de notificação

1. **Badge visual** no menu lateral: sempre presente enquanto há alertas não resolvidos.
2. **Email** para `lucascoelhosardenberg@gmail.com`: apenas alertas urgentes ou mudanças de estado importantes.
3. **Evento no Google Calendar** (agenda `primary`): criado para alertas de tipo `promocao_nova` e `aumento_anunciado`, na véspera da ação necessária.

---

## Polling automático de emails

### Configuração

Três remetentes monitorados automaticamente:

- **juliana@sayerlack.com.br**: promoções mensais e suspensões. Processa como `campanha_sayerlack`.
- **sc@sayerlack.com.br**: anúncios de reajuste de preços. Processa como `aumento_sayerlack`.
- **noreply@gooddata.com**: relatório semanal de progresso trimestral (toda segunda-feira). Processa como `relatorio_trimestral`.

### Frequência

Polling roda a cada 60 minutos (configurável em `fornecedor_email_polling.intervalo_min`). Último horário de execução aparece na tabela de configuração.

### O que acontece com cada email

1. Sistema lista emails novos do remetente
2. Filtra por padrões de assunto configurados
3. Se encontra, baixa anexos PDF/imagem
4. Sobe para bucket `promocoes` ou `aumentos`
5. Invoca edge function de extração Vision com tipo apropriado
6. Cria campanha/aumento em rascunho
7. Gera alerta
8. Atualiza checkpoint (último email processado)

Se assunto contém padrão de suspensão (ex: "SUSPENSA", "CANCELADA"), cria alerta urgente **sem** processar o anexo — requer sua intervenção manual.

### Quando o polling falha

Alerta `polling_erro` é gerado com detalhes. Mais comum:
- Credenciais OAuth do Gmail expiradas — precisa renovar manualmente
- Remetente bloqueado ou spam — conferir filtros Gmail
- PDF corrompido ou em formato não suportado

---

## Troubleshooting

**Campanha aparece como "Campanha não encontrada" após upload**

O redirect da UI pode estar desatualizado. Volta para `/admin/reposicao/promocoes` e procura a campanha nova na lista. Se está lá, o upload funcionou — só o redirect falhou.

**Upload de PDF retorna baixa confiança**

Gemini não extraiu bem. Opções: (a) subir imagem da mesma campanha em vez de PDF; (b) cadastrar manualmente pela interface; (c) para campanhas históricas, baixa confiança é aceitável desde que nome, datas e a maioria dos SKUs estejam corretos.

**Promoção ativada mas não aparece em oportunidades**

Checar:

1. Estado é `ativa`? Sidebar direita mostra badge verde.

2. Data atual está entre `data_inicio` e `data_fim`?

3. Itens estão confirmados? Tab Itens, todos com checkbox confirmado marcado.

4. SKUs em `sku_parametros` estão com `ativo = true`? Para SKUs novos, pode não ter entrado ainda.

**Aumento ativado mas SKUs afetados mostra lista vazia**

Na Tab "Categorias e mapeamento", para cada categoria, você precisa ter mapeado pelo menos uma família Omie. Se mapeou SKUs específicos, confere se eles existem e estão ativos em `omie_products`.

**Economia bruta estimada vem NULL**

SKU não tem `preco_item_eoq` calculado. Significa que o SKU é novo (sem histórico de compra nem venda nos últimos 180 dias) e o sistema não tem base para calcular custo. Esse SKU não entra na otimização — considere primeira compra manual.

**Ciclo de oportunidade gerou zero pedidos**

Pode ter acontecido que os SKUs afetados já estavam com estoque acima do ponto de pedido (compra normal não era necessária) e também não havia economia líquida suficiente para justificar antecipação. Se quiser forçar, pode criar pedido manual baseado nas oportunidades mostradas na Página 3.

**Alerta de polling_erro recorrente**

Verifica configuração da conta Google no Supabase. Tokens OAuth expiram periodicamente e requerem renovação. Entra em contato com suporte Lovable se o erro persistir após renovação.

**Quero desfazer uma ativação**

Campanha/aumento ativo: volta na sidebar e clica "Cancelar". Isso move para estado `cancelada` e para de afetar oportunidades. Para realmente apagar (não recomendado após ter sido usado no sistema), só via SQL Editor com `DELETE FROM promocao_campanha WHERE id = X`.

**Desconto extra não está somando no desconto efetivo**

Confere que preencheu `desconto_extra_perc` com número positivo (1-50) e salvou. Se continuar zero na view `v_promocao_item_efetivo`, pode ser cache do navegador — recarrega a página.

---

## Apêndice: diagrama de dados
