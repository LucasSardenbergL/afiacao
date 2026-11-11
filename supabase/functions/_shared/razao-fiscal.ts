// CPF de titular de MEI na razão social: a máscara e a guarda que impede a forma mascarada de virar cadastro no Omie.
//
// O app GRAVA mascarado o CPF que vem na razão de MEI ('FULANO DE TAL ***456789**', o formato do QSA público da RFB):
// no Radar (pacote J, migrations 20261111150000 e 20261112100000) e nos clientes (`profiles.name` e
// `venda_items_history.cliente_razao_social`, migration 20261113090000). A razão FISCAL, com o CPF, continua no
// próprio Omie, e o app nunca a regrava (não há AlterarCliente). O risco que sobra é o IncluirCliente: um cliente
// montado a partir do perfil (deep-link do Customer 360, fluxo de IA) leva a razão mascarada, e o cadastro numa conta
// onde o documento ainda não existe gravaria dado fiscal errado no ERP. `exigirRazaoFiscal` fecha isso no servidor,
// para qualquer build do front.
//
// O padrão é o MESMO da `private.radar_razao_mascarada` (SQL): 3-3-3-2 dígitos com até 3 separadores entre os blocos,
// sem dígito colado dos lados, em qualquer posição.

/** Máscara do CPF em texto livre: espelho exato da `private.radar_razao_mascarada` (SQL). */
const CPF_LIVRE = /(?<![0-9])[0-9]{3}([ ./-]{0,3}[0-9]{3}[ ./-]{0,3})([0-9]{3})([ ./-]{0,3})[0-9]{2}(?![0-9])/g;

/** A forma que a máscara deixa: '***456789**', '***.456.789-**', '*** 456 789 **', no fim ou no meio do nome. */
const RAZAO_MASCARADA = /\*\*\*[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}\*\*/;

/** Troca todo CPF do texto pela máscara (dígitos 4 a 9 visíveis), como a SQL faz na entrada do banco. */
export function razaoSemCpf<T extends string | null | undefined>(razao: T): T {
  if (typeof razao !== "string") return razao;
  return razao.replace(CPF_LIVRE, "***$1$2$3**") as T;
}

/** Lança se a razão social chegou na forma mascarada (nunca é a razão de verdade de ninguém). */
export function exigirRazaoFiscal(razao: unknown): void {
  if (typeof razao === "string" && RAZAO_MASCARADA.test(razao)) {
    throw new Error(
      "RAZAO_MASCARADA: a razão social chegou com o CPF mascarado (***dddddd**). Busque o cliente pelo documento no Omie, que traz a razão fiscal, ou recarregue a página para atualizar o app",
    );
  }
}
