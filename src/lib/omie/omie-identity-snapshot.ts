// MIRROR-START omie identity-snapshot-parse — espelhado verbatim nos edges omie-vendas-sync e omie-analytics-sync
// Valida o CONTRATO JSON da RPC omie_sync_identity_snapshot e constrói os mapas. FAIL-CLOSED (Codex
// challenge PR-1): supabase-js .rpc() resolve {error} — error=null só prova HTTP/SQL bem-sucedido, NÃO o
// contrato. Uma RPC revertida/malformada pode devolver HTTP 200 com {doc_to_user:null,...}; o `?? {}` a
// degradaria para Map(0) SILENCIOSO (vendas pula pedidos, analytics não vincula) sem SQLSTATE. Aqui shape
// inválido (null/array/tipo errado/valor não-UUID/doc ambíguo vazado em doc_to_user) LANÇA — precisão>recall.
const OMIE_SNAPSHOT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PR-2/A2: código Omie decimal puro. NÃO usar só `Number()`: ele aceita '0x10' (16), '1e3' (1000),
// ' 12 ' e '' (0) — cada um vira um código de cliente FABRICADO no cache do sync, que é a família
// `Number(null)===0` aplicada a uma CHAVE de identidade. Só dígitos, sem zero à esquerda.
const OMIE_SNAPSHOT_CODIGO_RE = /^[1-9][0-9]*$/;

export function parseIdentitySnapshot(
  snap: unknown,
): {
  docToUserMap: Map<string, string>;
  ambiguousDocs: Set<string>;
  clientToUser: Map<number, string>;
  revokedClientCodes: Set<number>;
} {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    throw new Error("identity snapshot: resposta não é objeto (fail-closed)");
  }
  const s = snap as Record<string, unknown>;
  const d2u = s.doc_to_user;
  const amb = s.ambiguous_docs;
  if (!d2u || typeof d2u !== "object" || Array.isArray(d2u)) {
    throw new Error("identity snapshot: doc_to_user ausente ou não-objeto (fail-closed)");
  }
  if (!Array.isArray(amb)) {
    throw new Error("identity snapshot: ambiguous_docs ausente ou não-array (fail-closed)");
  }
  const ambiguousDocs = new Set<string>();
  for (const doc of amb) {
    if (typeof doc !== "string") throw new Error("identity snapshot: ambiguous_docs com item não-string (fail-closed)");
    ambiguousDocs.add(doc);
  }
  const docToUserMap = new Map<string, string>();
  for (const [doc, user] of Object.entries(d2u)) {
    if (typeof user !== "string" || !OMIE_SNAPSHOT_UUID_RE.test(user)) {
      throw new Error("identity snapshot: user_id não-UUID em doc_to_user (fail-closed)");
    }
    // disjunção: um doc não pode estar em doc_to_user E em ambiguous_docs (seria fail-open da RPC)
    if (ambiguousDocs.has(doc)) {
      throw new Error("identity snapshot: doc presente em doc_to_user E ambiguous_docs — fail-open da RPC (fail-closed)");
    }
    docToUserMap.set(doc, user);
  }
  // PR-2/A2 — PROVA POSITIVA código Omie → user, por conta. Vazio é o estado ESPERADO enquanto o
  // omie-analytics-sync não repovoar `evidence_document_normalized` (o backfill é NULL, fail-closed):
  // o leitor degrada para o comportamento de hoje. Ausente/não-objeto, porém, é contrato QUEBRADO —
  // uma RPC anterior ao PR-1 não tem a chave, e aí `{}` silencioso seria indistinguível de "sem prova".
  const c2u = s.client_to_user;
  if (!c2u || typeof c2u !== "object" || Array.isArray(c2u)) {
    throw new Error("identity snapshot: client_to_user ausente ou não-objeto (fail-closed)");
  }
  // A prova v1 é só `source='document'`, e ela exige um doc ÚNICO apontando para o MESMO user do
  // vínculo — logo TODO user provado está, por construção, no contradomínio de doc_to_user. Um user
  // fora dele significa que a RPC no ar não é a deste contrato (revertida, ou já com manual/code):
  // fail-closed em vez de confiar num vínculo cuja regra não conhecemos.
  const usuariosComDocUnico = new Set(docToUserMap.values());
  const clientToUser = new Map<number, string>();
  for (const [codigo, user] of Object.entries(c2u)) {
    if (typeof user !== "string" || !OMIE_SNAPSHOT_UUID_RE.test(user)) {
      throw new Error("identity snapshot: user_id não-UUID em client_to_user (fail-closed)");
    }
    if (!OMIE_SNAPSHOT_CODIGO_RE.test(codigo) || !Number.isSafeInteger(Number(codigo))) {
      throw new Error("identity snapshot: código de cliente inválido em client_to_user (fail-closed)");
    }
    if (!usuariosComDocUnico.has(user)) {
      throw new Error("identity snapshot: user de client_to_user fora de doc_to_user — RPC divergente do contrato v1 (fail-closed)");
    }
    clientToUser.set(Number(codigo), user);
  }
  // PR-2/A2 — REVOGAÇÃO. Sem ela a prova só OMITE, e omitir não corrige nada: o código obsoleto
  // continua no cache do leitor. Aqui vêm os códigos cuja evidência EXISTE mas deixou de sustentar o
  // vínculo (doc migrou de dono, virou ambíguo, ou o profile sumiu) — o leitor os REMOVE do cache e
  // refaz pela API. Ausente/não-array é contrato QUEBRADO: `[]` silencioso reabriria o fail-open.
  const rev = s.revoked_client_codes;
  if (!Array.isArray(rev)) {
    throw new Error("identity snapshot: revoked_client_codes ausente ou não-array (fail-closed)");
  }
  const revokedClientCodes = new Set<number>();
  for (const codigo of rev) {
    if (typeof codigo !== "string" || !OMIE_SNAPSHOT_CODIGO_RE.test(codigo) || !Number.isSafeInteger(Number(codigo))) {
      throw new Error("identity snapshot: código de cliente inválido em revoked_client_codes (fail-closed)");
    }
    const cod = Number(codigo);
    // disjunção: um código não pode ser provado E revogado (seria fail-open da RPC). A UNIQUE
    // (omie_codigo_cliente, account) garante 1 linha por código/conta, então os dois conjuntos nascem
    // disjuntos; ver os dois juntos significa que a RPC no ar não é a deste contrato.
    if (clientToUser.has(cod)) {
      throw new Error("identity snapshot: código em client_to_user E revoked_client_codes — fail-open da RPC (fail-closed)");
    }
    revokedClientCodes.add(cod);
  }
  return { docToUserMap, ambiguousDocs, clientToUser, revokedClientCodes };
}
// MIRROR-END

// MIRROR-START omie prova-positiva-cache — espelhado verbatim no edge omie-vendas-sync
// PR-2/A2: sobrepõe a PROVA POSITIVA (`client_to_user`) ao cache de identidade montado da view fresca
// `omie_customer_account_map_fresco`. O cache é vínculo por AUSÊNCIA DE CONTRAINDICAÇÃO — a view só
// atesta "existe vínculo com menos de 7 dias", nunca QUAL documento o provou; a prova vem do mesmo
// snapshot MVCC de `doc_to_user` e exige evidência viva, única e consistente. Onde há prova, ela VENCE.
// MUTA o cache de propósito: é a fronteira única por onde toda leitura de dono de pedido passa (o
// `clientCache.get()` que decide o dono, e o `resolveClientUserId` dos códigos ausentes). Uma correção
// feita só dentro de resolveClientUserId seria inerte justamente no caso do achado — o vínculo obsoleto
// mora NO cache, e resolveClientUserId só roda para quem está FORA dele.
// `divergencias` e `revogados` são os sensores do achado em produção. `cobertura` é o denominador —
// enquanto o writer não repovoar a evidência, os dois conjuntos vêm vazios e a função é no-op (nasce
// INERTE). Ausência de prova NUNCA apaga o cache: degrada para o status quo, não fabrica nem zera.
//
// A REVOGAÇÃO é o que de fato fecha o achado, e sobrepor positivos não a substitui (challenge Codex
// xhigh): a prova só EMITE o código quando a evidência ainda concorda com a linha que alimenta a view,
// então em estado estável ela sempre concorda — omitir o vínculo podre deixa o cache servindo-o igual.
// Remover do cache faz o código cair em `unknownCodes` e ser refeito pelo ConsultarCliente, que resolve
// pelo doc ATUAL do Omie via doc_to_user. Por isso o `delete` tem de acontecer ANTES de `unknownCodes`.
export function aplicarProvaPositivaNoCache(
  cache: Map<number, string | null>,
  prova: ReadonlyMap<number, string>,
  revogados: ReadonlySet<number>,
): { cacheDaView: number; provados: number; divergencias: number; revogados: number; cobertura: number } {
  const cacheDaView = cache.size;
  // Teto de sanidade ANTES de mutar (2ª rodada do challenge Codex xhigh). Revogar é caro: cada código
  // removido vira uma chamada ConsultarCliente no fallback. Transferência de documento é rara, então
  // revogação em MASSA não é a realidade — é assinatura de snapshot degradado (doc_to_user parcial,
  // migration meio-aplicada, conta errada no p_account). Nesse estado, empurrar milhares de códigos
  // para a API do Omie derrubaria o run por rate-limit de qualquer forma, só que depois de já ter
  // gravado metade dos pedidos. Abortar aqui é a mesma decisão, tomada cedo e com nome: o run pausa e
  // retoma na próxima janela (a RPC de criação de pedidos é idempotente), nada se perde e o alarme
  // aparece. 30% é folgado de propósito — pega catástrofe, não regula o regime normal.
  //
  // O PISO de 100 não é detalhe: percentual sobre denominador pequeno é ruído. Numa conta com 3
  // clientes no cache, revogar 1 já daria 33% e abortaria o sync inteiro por um caso banal. Abaixo de
  // 100 o volume absoluto de chamadas é pequeno por definição, então não há catástrofe a evitar —
  // o guard só faz sentido onde a proporção significa alguma coisa.
  if (cacheDaView >= 100 && revogados.size > cacheDaView * 0.3) {
    throw new Error(
      `identity snapshot: ${revogados.size} de ${cacheDaView} vínculos do cache revogados (>30%) — ` +
        `revogação em massa é sinal de snapshot degradado, não de realidade; abortando fail-closed`,
    );
  }
  let divergencias = 0;
  for (const [codigo, userProvado] of prova) {
    const doCache = cache.get(codigo);
    if (doCache !== undefined && doCache !== userProvado) divergencias++;
    cache.set(codigo, userProvado);
  }
  // Depois da sobreposição, de propósito: os conjuntos são disjuntos por construção (e o parser
  // assere isso), mas se algum dia deixarem de ser, a revogação vence — fail-closed, não fail-open.
  let revogadosNoCache = 0;
  for (const codigo of revogados) {
    if (cache.delete(codigo)) revogadosNoCache++;
  }
  return {
    cacheDaView,
    provados: prova.size,
    divergencias,
    revogados: revogadosNoCache,
    cobertura: cacheDaView > 0 ? Math.round((prova.size / cacheDaView) * 100) : 0,
  };
}
// MIRROR-END
