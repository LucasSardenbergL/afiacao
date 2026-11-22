// Escolha da conta (oben × colacor do mesmo `codigo`) considerando a QUANTIDADE pedida.
//
// Mora aqui, e não em `_shared/estoque-desconhecido.ts`, porque `recommend` também empacota aquele
// módulo: mexer nele mudaria o fingerprint dela e pediria um deploy sem mudança de comportamento.
// Testes: `_shared/estoque-desconhecido_test.ts`.
//
// Defeito corrigido (Codex P2 no #4095): a regra só por saldo escolhe o MENOR saldo positivo. Num
// pedido de 5 com 10 na Oben e 3 na Colacor, ela escolhia a Colacor e atribuía as 5 unidades a uma
// conta que não as cobre.
//
// Níveis (o menor vence):
//   1. saldo conhecido ≥ quantidade — cobre o pedido. Entre dois, vence o MENOR (esvaziar o lote
//      menor, a intenção da regra antiga, agora só entre contas que de fato atendem);
//   2. saldo conhecido > 0 e < quantidade — atende em parte. Entre dois, vence o MAIOR (cobrir o
//      máximo do pedido);
//   3. desconhecido (`null`) — pode ter saldo, mas nada o prova; fica abaixo do parcial porque o
//      parcial é saldo CERTO e o desconhecido pode ser zero;
//   4. zero real (ou negativo).
// Empate mantém a escolha da IA. Quantidade ausente ou inválida (não-número, ≤ 0) NÃO vira 1 nem 0:
// degrada para `escolherContaPorEstoque`, a regra anterior (ausente ≠ zero).

import { escolherContaPorEstoque, lerEstoque } from "../_shared/estoque-desconhecido.ts";

function quantidadeValida(q: unknown): number | null {
  const n = lerEstoque(q);
  return n !== null && n > 0 ? n : null;
}

function nivel(saldo: number | null, quantidade: number): 1 | 2 | 3 | 4 {
  if (saldo === null) return 3;
  if (saldo <= 0) return 4;
  return saldo >= quantidade ? 1 : 2;
}

export function escolherContaPorQuantidade(
  atual: unknown,
  outra: unknown,
  quantidade: unknown,
): "atual" | "outra" {
  const q = quantidadeValida(quantidade);
  if (q === null) return escolherContaPorEstoque(atual, outra);
  const sa = lerEstoque(atual);
  const so = lerEstoque(outra);
  const na = nivel(sa, q);
  const no = nivel(so, q);
  if (na !== no) return no < na ? "outra" : "atual";
  if (na === 1) return (so as number) < (sa as number) ? "outra" : "atual";
  if (na === 2) return (so as number) > (sa as number) ? "outra" : "atual";
  return "atual";
}
