// Marcador de versão da edge `banco-extrato-importar`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: recebe o caminho de um extrato bancário (Itaú) já enviado ao bucket privado
// `banco-extratos`, faz o parse e entrega à RPC `banco_extrato_registrar`, que decide
// (aceito/pendente_revisao/recusado/ja_importado) e grava `banco_extrato_arquivo` e, no aceite,
// `banco_extrato_linha`. O saldo e o fluxo bancário que a gestão lê saem dessas linhas — um bundle
// velho aqui não devolve erro, devolve linha/saldo errado com carimbo de hoje.
//
// O gate é o `authorizeCronOrStaff` de `_shared/auth.ts`; a sonda entra logo APÓS ele (aceita
// x-cron-secret) e ANTES de qualquer leitura de banco/Storage. O FLUXO REAL, ao contrário, só aceita
// JWT de usuário (a RPC exige `enviado_por` real): cron/service_role → 403.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("banco-extrato-importar");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
//
// v1.0: nascimento (F1 extrato bancário, Task 6). Só OFX; CNAB 240 é recusado como
// `formato_desconhecido/cnab240_ainda_nao_suportado` até existir o parser (Task 5).
//
// v1.1: o parser OFX recusa DTEND anterior a DTSTART (`data_invalida`) em vez de deixar a RPC levantar 22023.
export const VERSAO = "v1.1-extrato-ofx";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge baixa um extrato do bucket banco-extratos e o registra via banco_extrato_registrar, " +
  "gravando banco_extrato_arquivo e (no aceite) as linhas do extrato que alimentam o saldo bancário";

/**
 * Estratégia de chave de dedupe das linhas quando `banco_conta.estrategia_chave` é NULL.
 * 'tupla' (data+sentido+valor+documento, com contador de repetição; a descrição normalizada fica FORA da
 * chave de propósito, pois o banco pode reescrevê-la entre exports) não
 * depende de o banco entregar um id estável por lançamento.
 * ATENÇÃO: a Task 0 (medição do arquivo REAL do Itaú) pode trocar este valor para 'id_bancario'
 * (FITID estável); trocar é mudança de comportamento → bump de VERSAO. Uma vez gravadas linhas com
 * uma estratégia, a conta deve ter `estrategia_chave` explícita em `banco_conta` (a RPC confere).
 */
export const ESTRATEGIA_CHAVE_PADRAO = "tupla" as const;
