// Mapa código→descrição da condição de pagamento da via impressa, POR CONTA (revisão /sales L2-c).
// O código de parcela é do Omie de CADA empresa: o mesmo "001" pode ser "À vista" na Oben e "30 dias" na
// Colacor. Chavear só por `codigo` fazia a lista da Colacor (lida depois) sobrescrever a da Oben — e a
// via da Oben saía com o prazo da Colacor. Pior: com a Colacor degradada, o código cru dela ganhava a
// descrição da Oben, fabricando um prazo que ninguém leu na conta certa (money-path §2).

export type ContaDaParcela = 'oben' | 'colacor';

export const chaveParcela = (conta: ContaDaParcela, codigo: string) => `${conta}:${codigo}`;

/** Descrição da parcela NA CONTA do pedido; `undefined` quando aquela conta não a listou (degradada/ausente). */
export function descricaoDaParcela(
  mapa: Readonly<Record<string, string>>,
  conta: string,
  codigo: string | null | undefined,
): string | undefined {
  if (!codigo || (conta !== 'oben' && conta !== 'colacor')) return undefined;
  return mapa[chaveParcela(conta, codigo)];
}
