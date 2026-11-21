# Placar da Visão do CEO sem número enganoso (2026-11-21)

Origem: revisão da home do master pelo Codex e pelo Fable, feita sobre um print. Os dois chegaram aos
mesmos problemas, e três deles foram confirmados no código. O PR é só front-end e vai ao ar pelo Publish.

## O que estava errado no placar

- **Margem bruta de 100% na Colacor SC (out).** A DRE calcula `lucro_bruto = receita_liquida − cmv`, e o
  CMV fica 0 quando nada foi classificado como CMV. A margem saía 100% e contaminava o consolidado. O
  mecanismo está provado. **Causa (founder + DRE de prod, 2026-11-21):** a Colacor SC só presta serviço.
  Ela tem CMV 0 em todo mês de jul a out (só R$ 700 em ago) e o custo inteiro (~R$ 34 mil/mês) fica em
  despesas operacionais. Não é custo sem classificação.
- **NCG legendada sempre como "absorvido".** NCG ≤ 0 é folga (o passivo operacional financia o giro). Além
  disso, o placar aceitava um snapshot com `ncg_completa = false`, calculado sem estoque, e sem estoque até
  o sinal pode virar.
- **"Caixa disponível".** O valor somava os saldos bancários dos CNPJs e compensava dois CNPJs negativos.
  Caixa não passa de um CNPJ para outro.
- **Falha de leitura parecia ausência de dado.** Quando a leitura das exceções falhava, a tela mostrava
  "Tudo no lugar hoje".
- **Atalho `r`.** Invalidava só `['dashboard']` e não recarregava o placar nem as exceções.

## Régua aplicada

- A margem bruta conta só as empresas de mercadoria (Oben e Colacor). A Colacor SC entra em
  `EMPRESAS_SERVICO` (`ceo-placar.ts`), fica fora da conta (`Margem.servicoFora`) e aparece como
  "serviço" na tabela. Com a SC sozinha no seletor, o tile diz "só serviço". Na 1ª versão (#4073) ela
  derrubava a margem do grupo para "—" todo mês.
- Nas empresas de mercadoria, receita > 0 com CMV ausente ou zero → margem `null` (aparece "—"), com
  "CMV não classificado em X".
- NCG de alguma empresa sem estoque → aparece "parcial · snapshot sem estoque", sem legenda de sinal. A
  legenda folga × capital preso só sai com a NCG completa (`ncg_por_empresa[].completa`).
- O tile de caixa passa a se chamar "Saldo bancário líquido" e lista os CNPJs com saldo negativo
  (`Caixa.empresasNegativas`).
- Quando uma leitura falha, o detalhe diz "leitura falhou". As exceções mostram um alerta com o botão
  "Tentar de novo" (`useExcecoesGestor().isError`). O gate `erro-colapsado-em-vazio` perdeu a entrada de
  `GestorExcecoes.tsx` na baseline.
- O mês corrente vem de `hojeSP()` (`@/lib/time/sp-day`), não de `new Date()`.

## Fases seguintes (sem sinal de uso ainda, não iniciadas)

Caixa em 13 semanas por CNPJ (primeira semana negativa e o déficit) · vencidos abertos para cobrança ·
composição da margem (CMV e confiança do mapeamento) · composição da NCG · vendas por empresa em dias
úteis. O sensor já existe: `dashboard.ceo.kpi_click`.
