// Marcador de versão da edge `omie-desconto-backfill`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Esta edge nasce COM sensor: cada execução devolve o denominador (alvos, apurados, e as recusas
// por motivo) e o `cursor` de onde parou. "Rodou e não deu erro" não é sinal de nada aqui — o
// modo de falha característico do backfill é apurar POUCO e parecer bem-sucedido.
export const VERSAO = "v1.4-recusas-da-escrita-por-motivo";

// v1.4 — as recusas da ESCRITA deixam de ser um número só. `recusadas` da RPC junta a linha cuja
// base mudou (conserto: reler o Omie) e a que outro writer ou um run anterior já tinha apurado
// (conserto: nenhum), e a edge somava as duas em `escrita_recusada_base_mudou` nos dois caminhos
// (lote e retry linha a linha). Agora ela lê `ja_apuradas` — contado certo desde o #2475 — e
// reparte em `escrita_recusada_base_mudou` e `escrita_recusada_ja_apurada`. Retorno sem
// `ja_apuradas` legível vai inteiro para `escrita_recusada_nao_classificada`, com a causa em
// `diagnostico.escrita_retornos_nao_classificados`; retorno sem `aplicadas`/`recusadas` legíveis
// derruba a execução (HTTP 500) em vez de virar "0 aplicadas".

// v1.3 —a resposta passa a dizer DE ONDE saiu o número apurado, não só quantos: separa o 0 que o
// Omie informou do 0 que saiu da AUSÊNCIA dos campos de desconto (`diagnostico.zero_por_campos`),
// confere cada pedido contra o `total_pedido.valor_descontos` do próprio Omie, traz amostra de
// positivas (um representante por combinação tipo × qtd>1) com o nº do pedido para conferência à
// mão, reconfere as linhas que a ingestão já gravou, e devolve o PLANO por id (`desfechos`).
// Motivo: a 1ª execução real (2026-09-10, dry-run da pág. 1) apurou 215/215 com zero recusas —
// número que é o MESMO se os campos de desconto não viessem na resposta.
// E a ESCRITA fica restrita à janela que o denominador mede (`pedidoNaJanela`): o filtro do Omie é
// por inclusão OU alteração, e um pedido antigo alterado na janela entrava no plano (Codex).

// O que a sonda prova quando responde: que o bundle no ar conhece a régua de conciliação por trio
// E que o preflight já está na forma canônica — a guarda `atenderSondaOptions` DENTRO do bloco
// `if (req.method === "OPTIONS")`, que é a única que o `gateG1` de `scripts/sonda-cron-prova.ts`
// sabe medir. Esse é o pré-requisito de forma para a edge entrar na allowlist do cron (F4 onda 5)
// e passar a ser atestada passivamente, em vez de por sonda humana a cada PR que a toca.
// A edge é de EFEITO (escreve `order_items.desconto_valor`), então a sonda NUNCA escreve: ela
// responde o marcador e sai, sem tocar no Omie e sem tocar no banco.
export const EFEITO =
  "esta edge REESCREVE order_items.desconto_valor do acervo: ela relê pedidos do Omie e grava o " +
  "desconto apurado nas linhas que ainda estão NULL, via desconto_backfill_aplicar — um run não " +
  "pedido consome quota da API do Omie e carimba desconto em milhares de linhas de venda, que é " +
  "a base da receita líquida do fin-valor-cockpit; `dry_run: true` roda a conciliação inteira e " +
  "devolve as contagens e o plano por id SEM escrever nada";

import { criarRespostaSonda } from "../_shared/sonda-versao.ts";
export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";

export const respostaSonda = criarRespostaSonda("omie-desconto-backfill");
