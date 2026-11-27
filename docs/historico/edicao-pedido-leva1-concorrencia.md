# Edição de pedido em /sales — leva 1 da revisão: concorrência, desfecho e estado da tela (2026-11-27)

> Continuação de [edicao-pedido-envio-omie.md](edicao-pedido-envio-omie.md) (#4187 · #4198 · #4215). Money-path.
> Edge `omie-vendas-sync` **v1.54**, sem migration. PR 1 de 2 da leva 1 (o PR 2 leva a migration).

## Achados da revisão Codex r3 (2026-11-25) fechados aqui

| # | o que era | o que ficou |
|---|---|---|
| 4 | conta fora de oben/colacor virava Oben (catálogo e condições de outra empresa) | front trava a tela e o "repetir pedido"; edge já recusava (`conta_desconhecida`) |
| 6 | edge não conferia estado/exclusão/versão na fronteira | pedido excluído recusa; **reserva** antes do 1º AlterarPedidoVenda: UPDATE condicional de `updated_at` (versão da tela + PV + conta + status + hash exato + não excluído), exige 1 linha |
| 7 | duas edições se sobrescreviam | a tela manda `versao`; sem ela a edge recusa **por erro** (a tela antiga mostra "atualize o app"); 2º save com a mesma versão casa 0 linhas → `edicao_concorrente` |
| 10 | base alternativa fora do catálogo virava o SKU da original | recusa; devolve `'conflito'` (o diálogo não conta cor confirmada) |
| 15 | trocar de pedido herdava parcela/estado/respostas | a página remonta o editor por `:id` (`key`), e o `loadOrder` zera o estado |
| 16 | lista/detalhe/descontos em cache velho por 60 s | cancela e invalida o cache DESTE pedido após qualquer despacho (com e sem PV), sem segurar a navegação |
| 17 | limpar a observação não limpava | `""` limpa (NULL local, padrão da conta no ERP); a tela sempre envia a nota (ERP = cupom) |
| 18 | — | já fechado pelo #4215 (parcela só se mudou) |
| 30 | falha pós-Omie reabilitava o mesmo formulário | trava **divergente**: em todo desfecho pós-despacho sem prova (`precisa_recarregar: false` ou 401/403), inclusive 200 sem `success === true`, resposta perdida e prazo vencido; sobrevive à recarga (`registroEnvios.ts`) |
| 48 | editar durante o envio se perdia | formulário congelado durante o envio; aviso de alteração pendente (`beforeunload`) |

## Lições (para não repetir)

- **Instância de componente reaproveitada entre `:id` é a raiz de uma família de bugs.** Remendar pela "geração
  da carga" falhou duas vezes no Codex (estado preso, toast e navegação no pedido errado). `key={id}` na página +
  `montadoRef` resolveu a família; o que é do PEDIDO (em voo, divergente) mora num registro de módulo.
- **Prazo no caminho que não toca o ERP criou mais bugs do que resolveu** (liberação adiada, releitura soltando
  o total velho, recusa tardia apagando o rascunho). O caminho local voltou ao da main: a trava de versão já
  impede gravar retrato velho. Regra: só coloque máquina de desfecho onde há efeito irreversível fora do banco.
- **Omitir campo "intocado" para preservar o valor vivo no ERP desalinha ERP e cupom.** Mandar sempre o que o app
  guarda é o contrato mais simples de manter coerente.
- **Filtro de teste que não casa nada sai verde.** O laço de falsificação agora acusa `FILTRO-VAZIO`.

## Evidência

- Codex: desenho BLOQUEANTE (residuais → PR 2) · diff r1–r8 BLOQUEANTE, todos corrigidos · **r9 BLOQUEANTE: não**.
- Falsificação: 33 sabotagens × 2 locales (C e pt_BR.UTF-8), controle verde na mesma invocação, + S38 dirigida.
- Bateria em `ce73ad443`: 6 gates de edge, lint, typecheck, suíte completa (17.293 testes) — exit 0.

## Fica para o PR 2 (migration)

Reivindicação durável por (conta, PV) entre abas/dispositivos; RPC `aplicar_edicao_pedido_omie` conferindo posse e
`deleted_at` sob FOR UPDATE; exclusão respeitando edição em curso; reserva antes do registro de revisão de crédito;
divergência durável no banco; `success: true` que chega depois do prazo (hoje mantém a trava — lado seguro).

## Deploy

Ordem: **edge v1.54 ANTES do Publish** (e depois da `pedido-programado-enviar` v1.1, pela `deploy-ordem.json` do
#4250). Até o Publish, a tela antiga recebe "atualize o app" ao salvar e nada muda no Omie.
