// Razão social mascarada NUNCA vai para o Omie (pacote J do Radar, migration 20261111150000).
//
// O Radar passou a GUARDAR a razão de MEI com o CPF do titular mascarado ('FULANO ***456789**', o formato do QSA
// público da RFB). A razão FISCAL (com o CPF) vem de uma RPC própria, que só o build novo do front chama. Uma aba
// num build anterior — o service worker só troca de build quando o usuário clica — mandaria a forma mascarada, e o
// cadastro gravaria dado fiscal errado no ERP. Esta guarda fecha isso no servidor, para qualquer cliente.

/** O sufixo que o Radar grava no lugar do CPF do titular de MEI. */
export const SUFIXO_MASCARADO = / \*\*\*[0-9]{6}\*\*$/;

/** Lança se a razão social chegou na forma mascarada (nunca é a razão de verdade de ninguém). */
export function exigirRazaoFiscal(razao: unknown): void {
  if (typeof razao === "string" && SUFIXO_MASCARADO.test(razao.trim())) {
    throw new Error(
      "RAZAO_MASCARADA: a razão social chegou com o CPF mascarado (***dddddd**) — recarregue a página para atualizar o app e tente de novo",
    );
  }
}
