// Assinatura comportamental do #1888 (PR-2/A2) — os casos que a canária `identidade_probe` da
// `omie-vendas-sync` roda contra o bundle DEPLOYADO.
//
// POR QUE EXISTE (medido em 2026-08-23). Esta edge é a LEITORA do `client_to_user`. Do lado do
// ESCRITOR (`omie-analytics-sync`) o deploy do #1888 se provou pelo dado — a coluna
// `evidence_document_normalized` saiu de 0 para 10.822 de 16.118 após o sync das 05:00 UTC, e só o
// código novo a escreve. Aqui não há efeito observável de fora, e a escada de `docs/agent/deploy.md`
// tinha um degrau só:
//
//   N1 existência ... verde, mas prova apenas que a função é SERVIDA.
//   N2 versão ....... estruturalmente indisponível (Supabase da org do Lovable; ⛔ não peça PAT).
//   N3 comportamento  a `identidade_probe` roda a decisão pura `decideAccountIdentity` do P0-B, e o
//                     #1888 NÃO tocou aquele bloco (0 linhas: `git diff a9410fdaa^ a9410fdaa`).
//
// O marcador `contrato` que o #1922 deu à canária JÁ resolve a pergunta "qual bundle está no ar?":
// como ele nasceu depois do #1888, um bundle que o responde é necessariamente ≥ #1888. O que ele
// NÃO dá é o passo seguinte, e é para ele que este arquivo existe: a transitividade assume que o
// binário no ar É o arquivo da main, e este repo tem duas maneiras REGISTRADAS de essa premissa ser
// falsa — o Lovable reinterpreta código no deploy (#1272) e o sync bidirecional já reverteu a main
// por cima de arquivo recém-mergeado (#1445→#1478). Os gates de PARIDADE textual pegam isso na
// MAIN; nenhum deles vê o bundle DEPLOYADO. Sob esse modo de falha a canária responderia
// `ok:true` com o `contrato` certo, porque ela exercita o P0-B e não o A2.
//
// Daí a assinatura: exercita, no bundle no ar, as duas funções que o #1888 introduziu nesta edge —
// `parseIdentitySnapshot` (com `client_to_user`/`revoked_client_codes`) e
// `aplicarProvaPositivaNoCache`. Continua READ-ONLY e IO-free: as duas são puras, e a segunda muta
// apenas Maps criados aqui dentro. Nada de Omie, nada de banco, nada de `supabaseAdmin`.
//
// As funções chegam por PARÂMETRO em vez de import porque o `index.ts` importa
// `npm:@supabase/supabase-js@2` e `test:edges` roda `deno test --no-remote` — nenhum teste o
// alcança. Com a injeção o avaliador fica testável (`assinatura-a2_test.ts` o falsifica com duplos
// pré-#1888), e quem garante que o `index.ts` passa as funções REAIS é o gate textual do mesmo
// arquivo.

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

/** Contrato estrutural das duas funções DEPLOYADAS que a assinatura exercita. */
export type DepsAssinaturaA2 = {
  parse: (snap: unknown) => {
    docToUserMap: Map<string, string>;
    ambiguousDocs: Set<string>;
    clientToUser: Map<number, string>;
    revokedClientCodes: Set<number>;
  };
  aplicar: (
    cache: Map<number, string | null>,
    prova: ReadonlyMap<number, string>,
    revogados: ReadonlySet<number>,
  ) => {
    cacheDaView: number;
    provados: number;
    divergencias: number;
    revogados: number;
    cobertura: number;
  };
};

/** Local de propósito: só `AssinaturaA2` o referencia, e export sem consumidor é o que o
 *  gate `knip` do CI barra. */
type CasoAssinatura = { caso: string; ok: boolean; detalhe: string };
export type AssinaturaA2 = { contrato: string; ok: boolean; casos: CasoAssinatura[] };

/**
 * Nome do contrato exercitado — vai na resposta da canária, ao lado do `contrato` da fatia, para
 * quem lê saber O QUE o `assinatura_a2.ok` afirma.
 */
export const CONTRATO_A2 = "pr2-a2-client-to-user";

export const MARCAS_A2 = {
  clientToUserAusente: /client_to_user ausente/,
  revogadosAusente: /revoked_client_codes ausente/,
  userForaDeDocToUser: /fora de doc_to_user/,
  provadoERevogado: /client_to_user E revoked_client_codes/,
  codigoInvalido: /código de cliente inválido em client_to_user/,
  revogacaoEmMassa: /revogação em massa/,
} as const;

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const DOC_A = "12345678000199";
const DOC_B = "98765432000188";

/** Snapshot VÁLIDO no contrato v1 do #1888 — os casos negativos partem daqui e sabotam um campo. */
function snapshotValido(): Record<string, unknown> {
  return {
    doc_to_user: { [DOC_A]: UUID_A, [DOC_B]: UUID_B },
    ambiguous_docs: [],
    client_to_user: { "10": UUID_A },
    revoked_client_codes: ["20"],
  };
}

/**
 * Caso que exige SUCESSO com uma propriedade verificável. Nunca propaga exceção: um throw
 * inesperado viraria HTTP 500, e 500 é justamente o veredito de "bundle velho" — a sonda
 * mentiria o pior erro possível sobre si mesma.
 */
function exigeOk(caso: string, fn: () => string | null): CasoAssinatura {
  try {
    const falha = fn();
    return falha === null
      ? { caso, ok: true, detalhe: "" }
      : { caso, ok: false, detalhe: falha };
  } catch (e) {
    // `mensagemDeErro` e não `String(e)`: o gate `erro-object-object` (#1642) existe porque o
    // ramo `String()` de um objeto plano rende literalmente "[object Object]" — aqui isso apagaria
    // a única pista de POR QUE o bundle no ar divergiu.
    const motivo = mensagemDeErro(e) ?? "erro sem mensagem utilizável";
    return { caso, ok: false, detalhe: `lançou onde devia passar: ${motivo}` };
  }
}

/**
 * Caso que exige FAIL-CLOSED. Casa a MARCA do ramo, não "lançou algo" (CLAUDE.md §teste negativo):
 * um bundle que lança por outro motivo — TypeError ao ler uma chave que ele não conhece, por
 * exemplo — não pode ser lido como "o fail-closed do #1888 está no ar".
 */
function exigeFailClosed(caso: string, marca: RegExp, fn: () => unknown): CasoAssinatura {
  try {
    fn();
    return { caso, ok: false, detalhe: "não lançou — o fail-closed do #1888 não está neste bundle" };
  } catch (e) {
    // Sem mensagem utilizável não há como afirmar QUAL ramo lançou, e o fallback é escolhido
    // para não casar marca nenhuma: o caso reprova, que é o desfecho fail-closed correto.
    const msg = mensagemDeErro(e) ?? "(erro sem mensagem — ramo indeterminado)";
    return marca.test(msg)
      ? { caso, ok: true, detalhe: "" }
      : { caso, ok: false, detalhe: `lançou OUTRO ramo: ${msg}` };
  }
}

/**
 * Roda a tabela-verdade do contrato A2 contra as funções deployadas.
 *
 * Cada caso é uma propriedade que o #1888 INTRODUZIU: um bundle anterior a ele falha em todos
 * (o parse dele nem devolve `clientToUser`, e `aplicarProvaPositivaNoCache` não existe). É o que
 * torna a assinatura DISCRIMINANTE em vez de teatro verde.
 */
export function avaliarAssinaturaA2(deps: DepsAssinaturaA2): AssinaturaA2 {
  const casos: CasoAssinatura[] = [
    // ── contrato do snapshot (parseIdentitySnapshot) ──
    exigeFailClosed(
      "parse_exige_client_to_user",
      MARCAS_A2.clientToUserAusente,
      () => {
        const snap = snapshotValido();
        delete snap.client_to_user;
        return deps.parse(snap);
      },
    ),
    exigeFailClosed(
      "parse_exige_revoked_client_codes",
      MARCAS_A2.revogadosAusente,
      () => {
        const snap = snapshotValido();
        delete snap.revoked_client_codes;
        return deps.parse(snap);
      },
    ),
    exigeOk("parse_devolve_prova_e_revogados", () => {
      const p = deps.parse(snapshotValido());
      if (p.clientToUser.get(10) !== UUID_A) return `clientToUser[10]=${String(p.clientToUser.get(10))}`;
      if (!p.revokedClientCodes.has(20)) return "revokedClientCodes não contém 20";
      return null;
    }),
    exigeFailClosed(
      // A prova v1 é só `source='document'`: todo user provado está no contradomínio de doc_to_user.
      "parse_recusa_user_fora_de_doc_to_user",
      MARCAS_A2.userForaDeDocToUser,
      () => deps.parse({ ...snapshotValido(), client_to_user: { "10": UUID_C } }),
    ),
    exigeFailClosed(
      // Provado E revogado ao mesmo tempo = fail-open da RPC.
      "parse_recusa_provado_e_revogado",
      MARCAS_A2.provadoERevogado,
      () => deps.parse({ ...snapshotValido(), revoked_client_codes: ["10"] }),
    ),
    exigeFailClosed(
      // `Number('1e3')` é 1000: código FABRICADO como chave de identidade (família `Number(null)===0`).
      "parse_recusa_codigo_nao_decimal",
      MARCAS_A2.codigoInvalido,
      () => deps.parse({ ...snapshotValido(), client_to_user: { "1e3": UUID_A } }),
    ),
    // ── sobreposição e revogação sobre o cache (aplicarProvaPositivaNoCache) ──
    exigeOk("prova_vence_cache_divergente", () => {
      const cacheLocal = new Map<number, string | null>([[10, UUID_B]]);
      const r = deps.aplicar(cacheLocal, new Map([[10, UUID_A]]), new Set());
      if (cacheLocal.get(10) !== UUID_A) return `o cache seguiu com ${String(cacheLocal.get(10))} — a prova não venceu`;
      if (r.divergencias !== 1) return `divergencias=${r.divergencias}, esperado 1`;
      return null;
    }),
    exigeOk("revogado_sai_do_cache", () => {
      // É o `delete` que fecha o achado: só saindo do cache o código podre cai em `unknownCodes` e
      // é refeito pelo ConsultarCliente. Omitir a prova não bastaria.
      const cacheLocal = new Map<number, string | null>([[10, UUID_A], [20, UUID_B]]);
      const r = deps.aplicar(cacheLocal, new Map(), new Set([20]));
      if (cacheLocal.has(20)) return "o código revogado continuou no cache";
      if (cacheLocal.get(10) !== UUID_A) return "a revogação levou junto um vínculo que não era dela";
      if (r.revogados !== 1) return `revogados=${r.revogados}, esperado 1`;
      return null;
    }),
    exigeFailClosed(
      // Teto de sanidade do challenge Codex: revogação em massa é snapshot degradado, não realidade.
      "revogacao_em_massa_aborta",
      MARCAS_A2.revogacaoEmMassa,
      () => {
        const cacheLocal = new Map<number, string | null>();
        for (let i = 1; i <= 100; i++) cacheLocal.set(i, UUID_A);
        const emMassa = new Set<number>();
        for (let i = 101; i <= 131; i++) emMassa.add(i);
        return deps.aplicar(cacheLocal, new Map(), emMassa);
      },
    ),
  ];
  return { contrato: CONTRATO_A2, ok: casos.every((c) => c.ok), casos };
}
