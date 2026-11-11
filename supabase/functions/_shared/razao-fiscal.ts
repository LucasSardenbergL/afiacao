// CPF de titular de MEI na razão social: a máscara e a guarda que impede a forma mascarada de virar cadastro no Omie.
//
// O app GRAVA mascarado o CPF que vem na razão de MEI ('FULANO DE TAL ***456789**', o formato do QSA público da RFB):
// no Radar (pacote J, migrations 20261111150000 e 20261112100000) e nos clientes (`profiles.name` e
// `venda_items_history.cliente_razao_social`, migration 20261113090000). A razão FISCAL, com o CPF, continua no
// próprio Omie, e o app nunca a regrava (não há AlterarCliente). O risco que sobra é o IncluirCliente: um cliente
// montado a partir do perfil (deep-link do Customer 360, fluxo de IA) leva a razão mascarada, e o cadastro numa conta
// onde o documento ainda não existe gravaria dado fiscal errado no ERP. `razaoFiscalParaCadastro` fecha isso no servidor,
// para qualquer build do front: troca a máscara pela razão fiscal da outra conta, ou recusa.
//
// O padrão é o MESMO da `private.radar_razao_mascarada` (SQL): 3-3-3-2 dígitos com até 3 separadores entre os blocos,
// sem dígito colado dos lados, em qualquer posição.

/** Máscara do CPF em texto livre: espelho exato da `private.radar_razao_mascarada` (SQL). */
const CPF_LIVRE = /(?<![0-9])[0-9]{3}([ ./-]{0,3}[0-9]{3}[ ./-]{0,3})([0-9]{3})([ ./-]{0,3})[0-9]{2}(?![0-9])/g;

/** A forma que a máscara deixa: '***456789**', '***.456.789-**', '*** 456 789 **', no fim ou no meio do nome. */
const RAZAO_MASCARADA = /\*\*\*[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}\*\*/;

/** O texto traz um CPF já mascarado (nome de perfil, razão de lead do Radar) — nunca é dado fiscal de ninguém. */
export function temCpfMascarado(texto: string): boolean {
  return RAZAO_MASCARADA.test(texto);
}

/** Troca todo CPF do texto pela máscara (dígitos 4 a 9 visíveis), como a SQL faz na entrada do banco. */
export function razaoSemCpf<T extends string | null | undefined>(razao: T): T {
  if (typeof razao !== "string") return razao;
  return razao.replace(CPF_LIVRE, "***$1$2$3**") as T;
}

/**
 * O cliente que vem AO VIVO do Omie para o navegador do staff (busca do pedido, M1 da revisão do Fable, 2026-11-11):
 * `razao_social` sai mascarada, porque é ela que a tela, a impressão, o `lastOrderData`, o bloqueio de crédito, o
 * e-mail "Novo Pedido" e o LLM leem. `razao_fiscal` só existe quando a máscara mudou algo (MEI com o CPF na razão) e
 * só serve ao payload do autocadastro (`criar_cliente` / `criar_cliente_afiacao`): nenhuma exibição a lê.
 * Sem `razao_fiscal` (build velho do front, cliente montado do perfil), o cadastro manda a mascarada e
 * `razaoFiscalParaCadastro` resolve a razão fiscal noutra conta.
 */
export function razaoParaExibicao(razao: string): { razao_social: string; razao_fiscal?: string } {
  const mascarada = razaoSemCpf(razao);
  return mascarada === razao ? { razao_social: razao } : { razao_social: mascarada, razao_fiscal: razao };
}

/** O mesmo para o nome fantasia (o de MEI costuma repetir a razão; o de loja pode ter telefone de 11 dígitos, que a
 *  máscara também pega): `fantasia_fiscal` leva o original ao cadastro, para o IncluirCliente não perder a fantasia. */
export function fantasiaParaExibicao(fantasia: string): { nome_fantasia: string; fantasia_fiscal?: string } {
  const mascarada = razaoSemCpf(fantasia);
  return mascarada === fantasia ? { nome_fantasia: fantasia } : { nome_fantasia: mascarada, fantasia_fiscal: fantasia };
}

/**
 * Onde buscar a razão fiscal quando o autocadastro de VENDAS (`omie-vendas-sync` `criar_cliente`) chega com a mascarada:
 * a outra conta de vendas e, depois, a Colacor SC (Afiação), que tem a razão completa de MEI que as duas não têm (3 casos
 * medidos — MÉDIO 1 do Codex no #3803). A conta que cadastra nunca entra: o lookup dela já provou que não tem o documento.
 */
export function fontesDaRazaoFiscalVendas(conta: "oben" | "colacor"): Array<"oben" | "colacor" | "colacor_sc"> {
  return [conta === "oben" ? "colacor" : "oben", "colacor_sc"];
}

/**
 * A razão social que pode ir ao IncluirCliente. A não mascarada passa como veio. A mascarada (cliente montado do
 * perfil, que guarda o CPF mascarado) é trocada pela razão FISCAL do MESMO documento noutra conta Omie do grupo, onde
 * o cliente já existe — a Oben tem 1.882 dos 1.888 MEI medidos em 2026-11-10.
 *
 * `consultar(conta)` devolve a razão daquele documento na conta, `null` quando a conta PROVOU que não o tem, e lança
 * quando não conseguiu ver (resposta inválida, documento divergente, ambíguo): o erro sobe, porque "não consegui ver"
 * não é "não existe". Nenhuma conta com a razão fiscal → `RAZAO_MASCARADA`, nunca o cadastro com a máscara.
 */
export async function razaoFiscalParaCadastro(
  razao: string,
  contas: readonly string[],
  consultar: (conta: string) => Promise<string | null>,
): Promise<string> {
  if (!RAZAO_MASCARADA.test(razao)) return razao;
  for (const conta of contas) {
    const fiscal = await consultar(conta);
    if (typeof fiscal === "string" && fiscal.trim() !== "" && !RAZAO_MASCARADA.test(fiscal)) return fiscal.trim();
  }
  throw new Error(
    "RAZAO_MASCARADA: a razão social chegou com o CPF mascarado e nenhuma outra conta Omie do grupo tem este documento para dar a razão fiscal. Cadastre o cliente no Omie com a razão completa",
  );
}
