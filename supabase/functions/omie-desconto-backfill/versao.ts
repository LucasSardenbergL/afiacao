// Marcador de versão da edge `omie-desconto-backfill`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Esta edge nasce COM sensor: cada execução devolve o denominador (alvos, apurados, e as recusas
// por motivo) e o `cursor` de onde parou. "Rodou e não deu erro" não é sinal de nada aqui — o
// modo de falha característico do backfill é apurar POUCO e parecer bem-sucedido.
export const VERSAO = "v1.0-backfill-oben-ttm";

// O que a sonda prova quando responde: que o bundle no ar conhece a régua de conciliação por trio.
// A edge é de EFEITO (escreve `order_items.desconto_valor`), então a sonda NUNCA escreve: ela
// responde o marcador e sai, sem tocar no Omie e sem tocar no banco.
export const EFEITO = "escrita" as const;

import { criarRespostaSonda } from "../_shared/sonda-versao.ts";
export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";

export const respostaSonda = criarRespostaSonda("omie-desconto-backfill");
