// Marcador de versão da edge `nvoip-sip-creds`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: entrega a SENHA do ramal SIP do vendedor ao navegador (segredo da central
// Nvoip). Entrou no mapa no lote 2 do rescan do scanner (2026-11-14), quando perdeu o fallback
// para o ramal master compartilhado: sem `versao.ts`, o deploy dessa correção não seria julgável
// pelo `pendencias:deploy` (gate `sonda:nova`).

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("nvoip-sip-creds");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sem-ramal-compartilhado";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge entrega a senha do ramal SIP do vendedor (segredo da central Nvoip)";
