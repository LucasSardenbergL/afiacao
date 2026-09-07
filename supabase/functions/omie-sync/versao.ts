// Marcador de versão da edge `omie-sync`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: roteia por `action` e escreve dos dois lados — no Omie inclui/altera/EXCLUI
// ordem de serviço (`IncluirOS`/`AlterarOS`/`ExcluirOS`) e cadastra cliente (`IncluirCliente`); no
// nosso banco reescreve `orders`, `omie_ordens_servico`, `loyalty_points` e a carteira
// (`register_carteira_member`).
//
// Entrou na 12ª leva (2026-09-05) pelo critério "escrita money-path no NOSSO banco", e é a
// continuação direta da 11ª: ela também estava na CLASSE CEGA do Passo 3 do `/fecho` — fora do
// mapa de fingerprints E importando `_shared/`, logo invisível para as vias (a) e (b) do
// `edges-pendentes.sh`. A via (c) (grafo de imports, #2170) fechou a ENUMERAÇÃO; o `versao.ts` é o
// que dá SUPRESSÃO por evidência positiva servida.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR (a triagem de `docs/agent/deploy.md` §"O CUSTO da sonda, edge a
// edge", que decide `--caro`): BARATA e INEQUÍVOCA. O corpo `{"probe":true}` não traz `action`, e o
// `switch` cai no `default:` com 400 `Ação não reconhecida` antes de tocar Omie ou banco — 400 e
// não 401, então o veredito não se confunde com `CRON_SECRET` errado.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-sync");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge cria, altera e EXCLUI ordem de serviço no Omie e cadastra cliente no ERP, além " +
  "de reescrever orders/omie_ordens_servico/loyalty_points e a carteira no nosso banco";
