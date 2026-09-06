// Marcador de versão da edge `elevenlabs-transcribe`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: consome COTA DE IA do usuário (`ia_consumir_cota`, que grava em
// `ia_uso_evento`) e manda o áudio para a ElevenLabs. Não escreve em tabela de aplicação.
//
// POR QUE ENTROU (2026-09-06): é a única das quatro edges de IA com uso PROVADO em produção —
// as 4 únicas linhas que `ia_uso_evento` chegou a ter eram dela (2026-08-29). Isso a torna a
// referência das outras três: prova que o gate do #1646 chegou a rodar no ar em ALGUMA edge.
// Mas a prova venceu — o cron `ia-uso-evento-purga` apagou as 4 linhas aos 7 dias —, e é
// exatamente esse vencimento que o `fonte` servido aqui substitui por algo que não expira.
//
// ⚠️ CORPO MULTIPART — o desvio de forma das outras três. O fluxo real lê `req.formData()`
// (o áudio), e `req.json()` sobre multipart lança; por isso a classificação só lê o corpo
// quando o `content-type` é JSON. Um `{"probe":true}` chega como JSON e é sonda; o multipart
// do app nem é lido aqui e segue direto para o fluxo real. O corpo continua sendo lido UMA vez
// em cada caminho.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR: BARATO, AMBÍGUO. Sem `Authorization: Bearer ` o bundle velho
// responde 401 `Não autorizado` nas linhas 19-25, antes de tocar o corpo ou a ElevenLabs.
// 401 é o 4xx ambíguo; só o 200 com `probe:true` é veredito positivo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("elevenlabs-transcribe");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge queima cota de IA do usuário e manda o áudio enviado para a ElevenLabs";
