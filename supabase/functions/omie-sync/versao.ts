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

// v1.1 (2026-10-01) — o dia de SP no vencimento das parcelas da OS (`./parcelas-os.ts`, classe ii do fuso,
// fase 3): o `getDate()` do servidor UTC fazia a OS criada das 21:00 às 23:59 BRT vencer tudo um dia
// adiante (a à vista, amanhã). Prazos e percentuais iguais; nenhuma pré-condição de banco.
// v1.3 (2026-10-12) — teto de relógio de 140s no fetch ao Omie (M-33 p3, `_shared/omie-chamada-relogio.ts`):
// falha de ESCRITA sai como OMIE_ESCRITA_INDETERMINADA (o Omie pode ter gravado). Nenhuma pré-condição de banco.
// v1.7 (2026-10-21) — `_shared/cnpj-alfanumerico.ts`: `documentoParaCadastro` só remove rótulo CPF/CNPJ explícito;
// letra fora dele recusa (antes "ABC12345678909" virava o CPF 12345678909 de outra pessoa — Codex ALTO, #3180).
// Vale no criar_cliente_afiacao E nos lookups que dão o cliente do pedido (buscar_cliente_por_documento, que
// agora falha 500 em vez de "não existe", e o autosserviço por profile.document — 0 profiles com letra).
// Alfabeto fechado antes de normalizar (dígito Unicode/símbolo/ß recusam). criar_cliente_afiacao confere o
// documento do cliente devolvido pelo lookup (OMIE_LOOKUP_DIVERGENTE → success:false, não reaproveita).
// Nenhuma pré-condição de banco, nenhuma ordem de deploy.
/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.7-rotulo-documento-explicito";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge cria, altera e EXCLUI ordem de serviço no Omie e cadastra cliente no ERP, além " +
  "de reescrever orders/omie_ordens_servico/loyalty_points e a carteira no nosso banco";
