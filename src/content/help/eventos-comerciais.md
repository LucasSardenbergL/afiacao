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
