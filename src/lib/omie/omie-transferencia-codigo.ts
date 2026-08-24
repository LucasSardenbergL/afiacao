// MIRROR-START omie transferencia-codigo — espelhado verbatim em supabase/functions/omie-analytics-sync/index.ts
// P1-c (fail-closed money-path): o writer document-first grava a proof com `onConflict(user_id,account)`,
// que NÃO enxerga a segunda unicidade da tabela — `uq_ocam_codigo_account UNIQUE(omie_codigo_cliente,
// account)`. Quando um código migra de dono (user1 → user2 na MESMA conta), a linha antiga ainda segura o
// código: o INSERT viola a UNIQUE com 23505, que o ON CONFLICT declarado não trata, e o `throw` derruba o
// chunk de 500 e o run inteiro. Um único código migrando matava o sync do dia.
//
// A correção NÃO é aplicar a transferência. Parecer Codex (gpt-5.6-sol xhigh, 2026-08-24): o documento
// prova o PAREAMENTO ATUAL, não a AUTORIZAÇÃO da transferência. Migração legítima e captura de vínculo por
// edição do CNPJ no Omie produzem input IDÊNTICO — "código X agora tem o documento D2, que é do user2".
// Deletar a linha antiga automaticamente promoveria qualquer editor do Omie a autoridade sobre dono de
// pedido e comissão. Então: documento autoriza CRIAÇÃO e REFRESH; transferência vira CONFLITO.
//
// Trocar o onConflict para (codigo,account) — a outra "correção óbvia" — é PIOR: resolve a troca de dono e
// quebra a troca de código (INSERT de um código novo para um user que já tem linha viola
// uq_ocam_user_account), que é o caso COMUM do recadastro. E implementa exatamente a transferência que o
// caso A8 de db/test-register-carteira-member.sh existe para barrar.
//
// A UNIQUE permanece intocada no schema: ela segue sendo a barreira do writer SEM evidência (a RPC pontual
// `register_carteira_member`, cujo 23505 é fail-closed correto e tem teste com dente). O que muda é só que
// o writer COM evidência para de bater nela por acidente.
// Espelhado no edge (Deno não importa de src/); paridade textual no CI em
// src/__tests__/edge-money-path-invariants.test.ts.

export type DecisaoProof =
  | "aplicar" // código livre, ou já é deste user: criação/refresh — o caso normal
  | "transferencia" // o código pertence a OUTRO user na mesma conta: NÃO aplica, vira conflito
  | "manual_protegido"; // a linha do próprio user é override HUMANO: automação não rebaixa

export interface EntradaProof {
  readonly user_id: string;
  readonly omie_codigo_cliente: number;
}

/** Linha JÁ existente na proof-table, da MESMA conta. */
export interface LinhaIncumbente {
  readonly user_id: string;
  readonly omie_codigo_cliente: number;
  readonly source: string;
}

export interface ClassificacaoProof {
  readonly decisao: DecisaoProof;
  /** Só em `transferencia`: o dono ATUAL do código, que perde o vínculo se a transferência for aprovada. */
  readonly incumbente?: string;
}

/**
 * Decide, para UMA entrada do lote document-first, se ela pode ser gravada na proof-table.
 *
 * Duas linhas incumbentes importam, e o Codex nomeou as duas — proteger só uma deixa o furo aberto:
 *   · a que detém o CÓDIGO  (`porCodigo`) → transferência de dono;
 *   · a que pertence ao USER (`porUser`)  → o upsert manda `source:'document'` e rebaixaria um
 *     override humano do próprio user, apesar de o delete de ambíguos preservá-lo explicitamente.
 *     Hoje há ZERO linhas `manual` em produção (medido: 16097 `document` + 21 `rpc`), então o furo é
 *     LATENTE — a promessa de imunidade existe no código e nunca foi exercitada pelo dado.
 */
export function classificarEntradaProof(
  entrada: EntradaProof,
  porCodigo: ReadonlyMap<number, LinhaIncumbente>,
  porUser: ReadonlyMap<string, LinhaIncumbente>,
): ClassificacaoProof {
  // 1) Override humano do PRÓPRIO user vence a automação, mesmo que o código não mude. Vem antes da
  //    checagem de transferência: se a linha do user é manual, nada da automação a toca — nem para
  //    reescrever o mesmo código, porque o upsert rebaixaria `source` para 'document'.
  const doUser = porUser.get(entrada.user_id);
  if (doUser && doUser.source === "manual") return { decisao: "manual_protegido" };

  // 2) O código já tem dono? Se for OUTRO user, é transferência — fail-closed, não aplica.
  const doCodigo = porCodigo.get(entrada.omie_codigo_cliente);
  if (doCodigo && doCodigo.user_id !== entrada.user_id) {
    return { decisao: "transferencia", incumbente: doCodigo.user_id };
  }

  // 3) Código livre, ou já é deste user: criação/refresh. É o caminho de ~100% do volume.
  return { decisao: "aplicar" };
}

/**
 * Classifica o LOTE inteiro. Existe além do caso-a-caso por um motivo que a checagem contra o banco NÃO
 * cobre: a colisão pode nascer DENTRO do próprio lote.
 *
 * O `docsComCodigoAmbiguoNoOmie` (P1b) detecta um DOC com 2+ códigos. O inverso — um CÓDIGO que aparece com
 * 2+ documentos na mesma paginação, casando com users diferentes — não era detectado por ninguém, e produz
 * exatamente a mesma 23505: duas entradas do lote disputando `uq_ocam_codigo_account`, sem nenhuma linha
 * pré-existente envolvida. Fail-closed simétrico ao P1b: se 2+ users disputam um código, NENHUM o leva —
 * não há como saber qual documento é o correto, e escolher o último seria o last-write-wins que este épico
 * inteiro existe para matar.
 *
 * Retorna um Map por user_id (a mesma chave de `accountMapByUser`, para o chamador filtrar direto).
 */
export function classificarLoteProof(
  entradas: ReadonlyArray<EntradaProof>,
  porCodigo: ReadonlyMap<number, LinhaIncumbente>,
  porUser: ReadonlyMap<string, LinhaIncumbente>,
): Map<string, ClassificacaoProof> {
  // Quantos users DISTINTOS disputam cada código dentro do lote. `Set` e não contador: o mesmo user
  // repetido (duplicata pura da paginação do Omie) não é disputa e não pode zerar o vínculo.
  const usersPorCodigo = new Map<number, Set<string>>();
  for (const e of entradas) {
    const s = usersPorCodigo.get(e.omie_codigo_cliente) ?? new Set<string>();
    s.add(e.user_id);
    usersPorCodigo.set(e.omie_codigo_cliente, s);
  }

  const out = new Map<string, ClassificacaoProof>();
  for (const e of entradas) {
    const disputantes = usersPorCodigo.get(e.omie_codigo_cliente);
    if (disputantes && disputantes.size > 1) {
      // Disputa intra-lote. `incumbente` fica ausente de propósito: não há dono anterior a preservar —
      // o conflito é entre candidatos, não com o estado gravado.
      out.set(e.user_id, { decisao: "transferencia" });
      continue;
    }
    out.set(e.user_id, classificarEntradaProof(e, porCodigo, porUser));
  }
  return out;
}
// MIRROR-END
