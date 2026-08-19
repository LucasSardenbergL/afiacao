// Sonda de versão compartilhada — "qual bundle está no ar?" sem efeito colateral.
//
// POR QUE EXISTE (2026-08-14, #1747): edges de money-path costumam não ter NENHUM caminho barato
// para provar deploy. Na `disparar-pedidos-aprovados` o `dry_run` não servia (chama
// `IncluirPedCompra` incondicionalmente e cria PO real no Omie) e nem o caminho "zero itens"
// (ainda escreve auditoria) — a única prova era esperar o efeito caro acontecer de verdade.
// `docs/agent/deploy.md` já mandava criar a prova JUNTO do fix, "porque depois não haverá como
// provar"; isto é o mecanismo reutilizável para cumprir essa regra.
//
// Mora em `_shared/` de propósito: o classificador é money-path e idêntico em toda edge, então
// tem de ter UM dono e UM conjunto de testes. Cada edge contribui só o seu marcador `VERSAO`.
// (Import entre diretórios de function não é sancionado no deploy do Supabase; `_shared/` é.)

export type DecisaoSonda =
  | { tipo: "sonda" }
  | { tipo: "disparo" }
  | { tipo: "ambiguo"; valor: string };

const SONDA_SIM = new Set(["true", "1"]);
const SONDA_NAO = new Set(["false", "0"]);

/**
 * Decide se o corpo da requisição pede a SONDA (diagnóstico puro) ou o FLUXO REAL.
 *
 * A assimetria manda no desenho (`docs/agent/sync.md` §"o default de um classificador cai no lado
 * CARO"):
 *   - ler sonda como fluxo real → efeito irreversível (PO no ERP, pedido no portal do fornecedor);
 *   - ler fluxo real como sonda → o tick não roda (visível no log, retentável).
 *
 * Daí as duas regras que um `body.probe === true` cru não dá:
 *   1. grafias que um humano digita no SQL Editor (`"true"`, `"1"`, com caixa/espaço) são SONDA —
 *      `jsonb_build_object('probe', true)` vira string com facilidade, e cair no fluxo real seria
 *      catastrófico;
 *   2. `probe` presente com valor NÃO reconhecido é AMBÍGUO (quis sondar e errou a grafia) →
 *      recusa explícita, nunca fluxo real por omissão.
 *
 * A chave AUSENTE é o caminho do cron e de todo chamador legítimo: segue direto para o fluxo real.
 * Sem isso, todo tick viraria sonda e o trabalho do dia não sairia.
 */
export function classificarSonda(body: unknown): DecisaoSonda {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { tipo: "disparo" };
  }
  if (!("probe" in body)) return { tipo: "disparo" };

  const bruto = (body as { probe: unknown }).probe;
  if (typeof bruto === "boolean") return { tipo: bruto ? "sonda" : "disparo" };

  if (typeof bruto === "string" || typeof bruto === "number") {
    const norm = String(bruto).trim().toLowerCase();
    if (SONDA_SIM.has(norm)) return { tipo: "sonda" };
    if (SONDA_NAO.has(norm)) return { tipo: "disparo" };
  }

  return { tipo: "ambiguo", valor: JSON.stringify(bruto) ?? String(bruto) };
}

/**
 * Fábrica do corpo da resposta da sonda, LIGADA à edge que a serve.
 *
 * O eco `probe:true` é OBRIGATÓRIO na verificação: um bundle ANTERIOR à sonda IGNORA o parâmetro e
 * roda o FLUXO REAL (`docs/agent/deploy.md` §Canárias, armadilha 1) — sem o eco, a resposta do fluxo
 * real se confundiria com "a sonda respondeu". Resposta sem `probe:true` já é o veredito: bundle
 * velho — e ele executou o efeito caro.
 *
 * O campo `edge` existe porque `versao` NÃO identifica quem respondeu: o marcador nasce igual em
 * todas as edges de uma leva (o gate de contrato até assere isso), então duas respostas de edges
 * diferentes eram byte a byte IDÊNTICAS. E nada no banco desfazia o empate — `net._http_response`
 * não guarda a URL, a `net.http_request_queue` é esvaziada ao processar, os headers são só do
 * Cloudflare e o `created` é o ciclo de coleta do worker do pg_net (respostas de edges distintas
 * compartilham timestamp ao microssegundo). Custo real (2026-08-18): 10 sondas respondidas com
 * sucesso e NENHUM veredito por edge possível — a verificação inteira se perdeu.
 * Detalhe: `docs/historico/verificar-sonda-versao.md` §7.
 *
 * É fábrica, e não um parâmetro a mais em cada chamada, para que a identidade fique declarada UMA
 * vez no `versao.ts` da edge — o `index.ts` segue chamando `respostaSonda(VERSAO)` sem mudança, e
 * não há como uma chamada nova esquecer de passar o nome.
 */
export function criarRespostaSonda(edge: string) {
  return function respostaSonda(
    versao: string,
  ): { ok: true; probe: true; versao: string; edge: string } {
    return { ok: true, probe: true, versao, edge };
  };
}

/** Mensagem do 400 de `probe` ambíguo. `efeito` descreve o custo real daquela edge. */
export function erroSondaAmbigua(valor: string, efeito: string): string {
  return `Parâmetro 'probe' com valor não reconhecido (${valor}). Use {"probe":true} para a sonda ` +
    `de versão, ou omita a chave para executar. Recusado por segurança: ${efeito}.`;
}
