// Marcador de versão da edge `desligar-funcionario`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: chama a RPC `desligar_funcionario` com o JWT do master (revoga papel, flag de equipe,
// commercial_roles, transfere carteira/mapa Omie/hunter/cobrança/tarefas, encerra cobertura, apaga a credencial
// SIP) e BANE o usuário no Auth (admin API). A sonda responde ANTES de tudo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("desligar-funcionario");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-desligamento-com-ban";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge DESLIGA um funcionário (tira papel e carteira, transfere a carteira para outro vendedor) e BLOQUEIA " +
  "o login dele no Auth";
