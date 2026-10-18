// Testa a MATERIALIZAÇÃO do recebimento (importacao.ts) no runtime real (Deno), com o banco falso.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-nfe-webhook/
//
// O defeito (plano-melhoria-v2, item 1 do Top 5): o cabeçalho entrava em `nfe_recebimentos` ANTES
// dos itens, sem transação; se o insert dos itens falhasse, a edge respondia 500 e o cabeçalho
// ficava. O reenvio do Omie caía no guard de duplicata — que só olhava o `id` — e respondia "já
// importada" sem reinserir nada: recebimento sem itens para sempre, invisível para quem confere.
//
// O banco falso GUARDA estado entre chamadas e modela a atomicidade REAL de cada operação do
// PostgREST (um insert = uma transação; lote inteiro ou nada; PK barra com 23505) — e NADA além
// disso: não há operação indivisível aqui que o adaptador de produção não tenha. A prova do retry é
// a 2ª chamada enxergar o cabeçalho que a 1ª deixou e completar os itens exatamente uma vez; a
// prova da corrida é duas chamadas INTERCALADAS por barreiras (não `Promise.all`, que pode cair
// sempre na ordem favorável) terminarem com N linhas, não 2N.
import {
  type CabecalhoExistente,
  type ErroEscrita,
  idDeterministicoDoItem,
  type LeituraPorChave,
  materializarRecebimento,
  type PortaRecebimento,
  reparavel,
  type ResultadoImportacao,
} from "./importacao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

interface Cabecalho {
  id: string;
  chave_acesso: string;
  status: string;
  emUso?: boolean;
}

interface Item {
  id: string;
  nfe_recebimento_id: string;
  sequencia: number;
}

/** Espera até `cond()` — o caminho até `inserirItens` passa por `crypto.subtle`, então um tick não basta. */
async function ate(cond: () => boolean, rotulo: string) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error(`condição não alcançada: ${rotulo}`);
}

/** Barreira: quem chama `esperar()` fica parado até alguém chamar `soltar()`. */
function barreira() {
  let soltar!: () => void;
  const promessa = new Promise<void>((r) => (soltar = r));
  return { esperar: () => promessa, soltar };
}

interface BancoFalso extends PortaRecebimento {
  cabecalhos: Cabecalho[];
  itens: Item[];
  chamadas: { buscar: number; inserirCabecalho: number; inserirItens: number };
  /** Próximas respostas forçadas de `inserirItens` (erro). Vazio → grava normal. */
  falhasItens: ErroEscrita[];
  /** Próximas respostas forçadas de `inserirCabecalho`. */
  falhasCabecalho: ErroEscrita[];
  /** Se definido, `buscarPorChave` responde isto em vez de ler o estado. */
  leituraForcada: LeituraPorChave | null;
  /** Ganchos chamados ANTES de cada insert (para intercalar com barreiras). */
  antesDeInserirItens: (() => Promise<void>) | null;
  antesDeInserirCabecalho: (() => Promise<void>) | null;
}

function bancoFalso(semente: { cabecalhos?: Cabecalho[]; itens?: Item[] } = {}): BancoFalso {
  let proximoId = 1;
  const banco: BancoFalso = {
    cabecalhos: [...(semente.cabecalhos ?? [])],
    itens: [...(semente.itens ?? [])],
    chamadas: { buscar: 0, inserirCabecalho: 0, inserirItens: 0 },
    falhasItens: [],
    falhasCabecalho: [],
    leituraForcada: null,
    antesDeInserirItens: null,
    antesDeInserirCabecalho: null,
    // deno-lint-ignore require-await
    async buscarPorChave(chave) {
      banco.chamadas.buscar++;
      if (banco.leituraForcada) return banco.leituraForcada;
      const cab = banco.cabecalhos.find((c) => c.chave_acesso === chave);
      if (!cab) return { tipo: "nenhuma" };
      const n = banco.itens.filter((i) => i.nfe_recebimento_id === cab.id).length;
      return { tipo: "existe", id: cab.id, status: cab.status, itens: n, emUso: cab.emUso ?? false };
    },
    async inserirCabecalho(row) {
      if (banco.antesDeInserirCabecalho) await banco.antesDeInserirCabecalho();
      banco.chamadas.inserirCabecalho++;
      const forcada = banco.falhasCabecalho.shift();
      if (forcada) return forcada;
      const chave = String(row.chave_acesso);
      if (banco.cabecalhos.some((c) => c.chave_acesso === chave)) {
        return { erro: "duplicate key value violates unique constraint nfe_recebimentos_chave_acesso_key", code: "23505" };
      }
      const id = `cab-${proximoId++}`;
      banco.cabecalhos.push({ id, chave_acesso: chave, status: String(row.status) });
      return { id };
    },
    async inserirItens(linhas) {
      if (banco.antesDeInserirItens) await banco.antesDeInserirItens();
      banco.chamadas.inserirItens++;
      const forcada = banco.falhasItens.shift();
      if (forcada) return forcada;
      // Um statement: valida o lote INTEIRO antes de gravar qualquer linha (PK = 23505).
      const ids = new Set(banco.itens.map((i) => i.id));
      for (const l of linhas) {
        const id = String(l.id);
        if (ids.has(id)) {
          return { erro: "duplicate key value violates unique constraint nfe_recebimento_itens_pkey", code: "23505" };
        }
        ids.add(id);
      }
      for (const l of linhas) {
        banco.itens.push({
          id: String(l.id),
          nfe_recebimento_id: String(l.nfe_recebimento_id),
          sequencia: Number(l.sequencia),
        });
      }
      return null;
    },
  };
  return banco;
}

const CHAVE = "35260112345678000190550010000012341000012345";

function entrada(nItens = 3) {
  return {
    chaveAcesso: CHAVE,
    cabecalho: { chave_acesso: CHAVE, status: "pendente", numero_nfe: "1234" },
    itens: Array.from({ length: nItens }, (_, i) => ({ sequencia: i + 1, descricao: `item ${i + 1}` })),
  };
}

function itensDe(banco: BancoFalso, id: string): Item[] {
  return banco.itens.filter((i) => i.nfe_recebimento_id === id);
}

async function itemSemeado(id: string, sequencia: number, ocorrencia = 0): Promise<Item> {
  return { id: await idDeterministicoDoItem(id, sequencia, ocorrencia), nfe_recebimento_id: id, sequencia };
}

Deno.test("o incidente: itens falham após o cabeçalho → erro com o id; o reenvio COMPLETA os itens uma vez só; o 3º não escreve", async () => {
  const banco = bancoFalso();
  banco.falhasItens.push({ erro: "connection reset", code: null });

  const primeira = await materializarRecebimento(banco, entrada(3));
  assertEquals(primeira.tipo, "erro_itens", JSON.stringify(primeira));
  const id = (primeira as { id: string }).id;
  assertEquals(banco.cabecalhos.length, 1, "o cabeçalho ficou (é o estado real do defeito)");
  assertEquals(itensDe(banco, id).length, 0, "nenhum item gravado na 1ª");

  const segunda = await materializarRecebimento(banco, entrada(3));
  assertEquals(segunda, { tipo: "reparada", id, itens: 3 } satisfies ResultadoImportacao);
  assertEquals(banco.cabecalhos.length, 1, "nenhum 2º cabeçalho");
  assertEquals(itensDe(banco, id).map((i) => i.sequencia), [1, 2, 3], "N itens, não 2N nem zero");
  assertEquals(banco.chamadas.inserirCabecalho, 1, "o cabeçalho não é reinserido no reenvio");

  const terceira = await materializarRecebimento(banco, entrada(3));
  assertEquals(terceira, { tipo: "ja_importada", id, itens: 3 } satisfies ResultadoImportacao);
  assertEquals(banco.chamadas.inserirItens, 2, "o 3º envio não tenta inserir nada (já completa)");
});

Deno.test("timeout DEPOIS do commit: o lote persistiu mas a resposta falhou; o reenvio reconhece o lote (não 2N)", async () => {
  const banco = bancoFalso();
  // Modela o insert que gravou e cujo transporte morreu: o estado tem N itens, a resposta foi erro.
  const gravarMasFalhar = banco.inserirItens.bind(banco);
  banco.inserirItens = async (linhas) => {
    await gravarMasFalhar(linhas);
    banco.inserirItens = gravarMasFalhar;
    return { erro: "fetch failed: timeout", code: null };
  };
  const primeira = await materializarRecebimento(banco, entrada(2));
  assertEquals(primeira.tipo, "erro_itens");
  const id = (primeira as { id: string }).id;
  assertEquals(itensDe(banco, id).length, 2, "o lote persistiu apesar do erro de transporte");

  const segunda = await materializarRecebimento(banco, entrada(2));
  assertEquals(segunda, { tipo: "ja_importada", id, itens: 2 } satisfies ResultadoImportacao);
  assertEquals(itensDe(banco, id).length, 2, "exatamente N — o reenvio não duplica");
});

Deno.test("caminho feliz: cabeçalho e itens entram; cada item carrega id determinístico e o id do cabeçalho", async () => {
  const banco = bancoFalso();
  const r = await materializarRecebimento(banco, entrada(2));
  assertEquals(r.tipo, "importada", JSON.stringify(r));
  const id = (r as { id: string }).id;
  assertEquals((r as { itens: number }).itens, 2);
  assertEquals(itensDe(banco, id).map((i) => i.id), [
    await idDeterministicoDoItem(id, 1, 0),
    await idDeterministicoDoItem(id, 2, 0),
  ]);
  assertEquals(banco.chamadas.inserirItens, 1);
});

Deno.test("payload sem itens: cabeçalho entra, nenhum insert de itens", async () => {
  const banco = bancoFalso();
  const r = await materializarRecebimento(banco, entrada(0));
  assertEquals(r.tipo, "importada");
  assertEquals(banco.chamadas.inserirItens, 0);
});

Deno.test("já importada COM itens: responde sem tocar no banco", async () => {
  const banco = bancoFalso({
    cabecalhos: [{ id: "cab-x", chave_acesso: CHAVE, status: "pendente" }],
    itens: [await itemSemeado("cab-x", 1)],
  });
  const r = await materializarRecebimento(banco, entrada(1)); // MESMA cardinalidade do gravado
  assertEquals(r, { tipo: "ja_importada", id: "cab-x", itens: 1 } satisfies ResultadoImportacao);
  assertEquals(banco.chamadas.inserirItens, 0);
  assertEquals(banco.chamadas.inserirCabecalho, 0);
});

Deno.test("estado preexistente DIVERGENTE (menos itens que o payload) não ganha certificado nem reparo: `divergente`, nada acrescentado", async () => {
  const banco = bancoFalso({
    cabecalhos: [{ id: "cab-p", chave_acesso: CHAVE, status: "pendente" }],
    itens: [await itemSemeado("cab-p", 1)],
  });
  const r = await materializarRecebimento(banco, entrada(3));
  assertEquals(r, { tipo: "divergente", id: "cab-p", itens: 1, esperados: 3 } satisfies ResultadoImportacao);
  assertEquals(itensDe(banco, "cab-p").length, 1, "count > 0 encerra a recuperação — nada é acrescentado");
  assertEquals(banco.chamadas.inserirItens, 0);
});

Deno.test("gate de estado: sem itens mas já efetivado, ou pendente com sinal de uso, NÃO repara — e NÃO é 'já importada' (seria 2xx sem itens)", async () => {
  for (const cab of [
    { id: "cab-e", chave_acesso: CHAVE, status: "efetivado" },
    { id: "cab-f", chave_acesso: CHAVE, status: "falha_efetivacao" },
    { id: "cab-u", chave_acesso: CHAVE, status: "pendente", emUso: true },
  ]) {
    const banco = bancoFalso({ cabecalhos: [cab] });
    const r = await materializarRecebimento(banco, entrada(3));
    assertEquals(r.tipo, "bloqueada", `${cab.id}: ${JSON.stringify(r)}`);
    assertEquals((r as { id: string }).id, cab.id);
    assertEquals(banco.chamadas.inserirItens, 0, `${cab.id}: inseriu itens em recebimento que não é reparável`);
  }
  // Veto que depois SOLTA (lock liberado): o reenvio seguinte completa.
  const banco = bancoFalso({ cabecalhos: [{ id: "cab-u", chave_acesso: CHAVE, status: "pendente", emUso: true }] });
  assertEquals((await materializarRecebimento(banco, entrada(2))).tipo, "bloqueada");
  banco.cabecalhos[0].emUso = false;
  assertEquals(await materializarRecebimento(banco, entrada(2)), { tipo: "reparada", id: "cab-u", itens: 2 } satisfies ResultadoImportacao);
});

Deno.test("reparavel(): só pendente + zero comprovado + sem uso + payload com itens", () => {
  const base: CabecalhoExistente = { id: "x", status: "pendente", itens: 0, emUso: false };
  assertEquals(reparavel(base, 3), true);
  assertEquals(reparavel({ ...base, status: "efetivado" }, 3), false);
  assertEquals(reparavel({ ...base, itens: 1 }, 3), false);
  assertEquals(reparavel({ ...base, emUso: true }, 3), false);
  assertEquals(reparavel(base, 0), false);
});

Deno.test("cabeçalho pendente sem itens e payload SEM itens: não há o que reparar", async () => {
  const banco = bancoFalso({
    cabecalhos: [{ id: "cab-v", chave_acesso: CHAVE, status: "pendente" }],
  });
  const r = await materializarRecebimento(banco, entrada(0));
  assertEquals(r, { tipo: "ja_importada", id: "cab-v", itens: 0 } satisfies ResultadoImportacao);
  assertEquals(banco.chamadas.inserirItens, 0);
});

Deno.test("contagem de itens ilegível é ERRO, nunca 'já importada' (ausente ≠ zero)", async () => {
  const banco = bancoFalso({
    cabecalhos: [{ id: "cab-l", chave_acesso: CHAVE, status: "pendente" }],
  });
  banco.leituraForcada = { tipo: "erro", mensagem: "contagem de itens indisponível" };
  const r = await materializarRecebimento(banco, entrada(3));
  assertEquals(r.tipo, "erro_leitura", JSON.stringify(r));
  assertEquals(banco.chamadas.inserirItens, 0, "não insere às cegas");
  assertEquals(banco.chamadas.inserirCabecalho, 0, "não reinsere às cegas");
});

Deno.test("CORRIDA webhook×webhook na criação: ambos leem 'nenhuma'; o perdedor do UNIQUE relê ANTES do vencedor inserir itens — fim com N, não 2N", async () => {
  const banco = bancoFalso();
  const b1 = barreira(); // W1 parado antes de inserir itens
  const b2 = barreira(); // W2 parado antes de inserir itens
  let vez = 0;
  banco.antesDeInserirItens = async () => {
    const minha = ++vez; // local: depois do await, `vez` já é do outro
    if (minha === 1) await b1.esperar();
    if (minha === 2) await b2.esperar();
  };

  const w1 = materializarRecebimento(banco, entrada(3)); // lê nenhuma, insere cabeçalho, para antes dos itens
  await ate(() => vez === 1, "W1 na barreira");
  assertEquals(banco.cabecalhos.length, 1, "W1 já criou o cabeçalho");
  const w2 = materializarRecebimento(banco, entrada(3)); // lê existente (pendente, 0 itens) → tenta reparar, para
  await ate(() => vez === 2, "W2 na barreira");
  // Ordem adversa: W2 (o "reparador") insere PRIMEIRO; W1 (o criador) só depois.
  b2.soltar();
  await ate(() => banco.chamadas.inserirItens === 1, "W2 gravou");
  b1.soltar();
  const [r1, r2] = await Promise.all([w1, w2]);

  const id = banco.cabecalhos[0].id;
  assertEquals(itensDe(banco, id).length, 3, `exatamente N itens (W1=${r1.tipo}, W2=${r2.tipo})`);
  assertEquals(r2, { tipo: "reparada", id, itens: 3 } satisfies ResultadoImportacao);
  assertEquals(r1, { tipo: "ja_importada", id, itens: 3 } satisfies ResultadoImportacao, "W1 perdeu na PK e reconheceu o lote");
  assertEquals(banco.chamadas.inserirItens, 2, "as duas tentaram; só uma gravou");
});

Deno.test("CORRIDA de dois REPAROS do mesmo cabeçalho antigo: ambos observam zero; o 2º lote colide na PK — fim com N", async () => {
  const banco = bancoFalso({ cabecalhos: [{ id: "cab-r", chave_acesso: CHAVE, status: "pendente" }] });
  const b1 = barreira();
  const b2 = barreira();
  let vez = 0;
  banco.antesDeInserirItens = async () => {
    const minha = ++vez; // local: depois do await, `vez` já é do outro
    if (minha === 1) await b1.esperar();
    if (minha === 2) await b2.esperar();
  };
  const r1p = materializarRecebimento(banco, entrada(2));
  await ate(() => vez === 1, "R1 na barreira");
  const r2p = materializarRecebimento(banco, entrada(2));
  await ate(() => vez === 2, "R2 na barreira");
  assertEquals(banco.chamadas.buscar, 2, "os dois leram ZERO antes de qualquer insert");
  b1.soltar();
  await ate(() => banco.chamadas.inserirItens === 1, "R1 gravou");
  b2.soltar();
  const [r1, r2] = await Promise.all([r1p, r2p]);
  assertEquals(itensDe(banco, "cab-r").length, 2, "N, não 2N");
  assertEquals([r1.tipo, r2.tipo], ["reparada", "ja_importada"]);
});

Deno.test("corrida na criação (23505 no cabeçalho) com o concorrente JÁ completo: relê → 'já importada', zero inserts de itens", async () => {
  const banco = bancoFalso({
    cabecalhos: [{ id: "cab-d", chave_acesso: CHAVE, status: "pendente" }],
    itens: [await itemSemeado("cab-d", 1), await itemSemeado("cab-d", 2)],
  });
  banco.leituraForcada = { tipo: "nenhuma" };
  const original = banco.inserirCabecalho.bind(banco);
  banco.inserirCabecalho = async (row) => {
    const r = await original(row);
    banco.leituraForcada = null; // a releitura é REAL
    return r;
  };
  const r = await materializarRecebimento(banco, entrada(2));
  assertEquals(r, { tipo: "ja_importada", id: "cab-d", itens: 2 } satisfies ResultadoImportacao);
  assertEquals(banco.chamadas.inserirItens, 0);
});

Deno.test("erro no cabeçalho que NÃO é 23505 não relê nem insere itens", async () => {
  const banco = bancoFalso();
  banco.falhasCabecalho.push({ erro: "permission denied", code: "42501" });
  const r = await materializarRecebimento(banco, entrada(2));
  assertEquals(r.tipo, "erro_cabecalho", JSON.stringify(r));
  assertEquals(banco.chamadas.buscar, 1, "sem releitura");
  assertEquals(banco.chamadas.inserirItens, 0);
});

Deno.test("23505 cuja releitura não acha o cabeçalho (ou falha): erro, nunca 'importada' sem gravar", async () => {
  for (const releitura of [{ tipo: "nenhuma" }, { tipo: "erro", mensagem: "ler nfe_recebimentos: timeout" }] as LeituraPorChave[]) {
    const banco = bancoFalso();
    banco.falhasCabecalho.push({ erro: "duplicate key", code: "23505" });
    const real = banco.buscarPorChave.bind(banco);
    let n = 0;
    banco.buscarPorChave = async (chave) => (++n === 1 ? await real(chave) : releitura); // só a RELEITURA é forçada
    const r = await materializarRecebimento(banco, entrada(2));
    assertEquals(r.tipo, "erro_cabecalho", JSON.stringify(r));
    assertEquals(n, 2, "houve exatamente uma releitura");
    assertEquals(banco.chamadas.inserirItens, 0);
  }
});

Deno.test("23505 nos ITENS cuja releitura não comprova o lote (zero, erro ou outro cabeçalho): erro_itens, nunca sucesso", async () => {
  const casos: LeituraPorChave[] = [
    { tipo: "existe", id: "cab-1", status: "pendente", itens: 0, emUso: false },
    { tipo: "erro", mensagem: "timeout" },
    { tipo: "existe", id: "outro", status: "pendente", itens: 3, emUso: false },
    { tipo: "existe", id: "cab-1", status: "pendente", itens: 1, emUso: false }, // concorrente gravou [1]; nós trazíamos 3
  ];
  for (const releitura of casos) {
    const banco = bancoFalso();
    banco.falhasItens.push({ erro: "duplicate key", code: "23505" });
    const antes = banco.buscarPorChave.bind(banco);
    let n = 0;
    banco.buscarPorChave = async (chave) => (++n === 1 ? await antes(chave) : releitura);
    const r = await materializarRecebimento(banco, entrada(3));
    assertEquals(r.tipo, "erro_itens", JSON.stringify({ releitura, r }));
  }
});

Deno.test("idDeterministicoDoItem: estável para o mesmo (cabeçalho, sequência, posição), distinto quando qualquer um muda, UUID válido", async () => {
  const a = await idDeterministicoDoItem("cab-1", 1, 0);
  assertEquals(a, await idDeterministicoDoItem("cab-1", 1, 0));
  assertEquals(a === await idDeterministicoDoItem("cab-2", 1, 0), false);
  assertEquals(a === await idDeterministicoDoItem("cab-1", 2, 0), false);
  assertEquals(a === await idDeterministicoDoItem("cab-1", 1, 1), false, "sequência repetida no payload não colide: a ocorrência entra");
  assertEquals(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a), true, a);
});

Deno.test("sequência REPETIDA no payload (nItem duplicado) não derruba o lote por colisão interna", async () => {
  const banco = bancoFalso();
  const r = await materializarRecebimento(banco, {
    ...entrada(0),
    itens: [{ sequencia: 1 }, { sequencia: 1 }, { sequencia: 2 }],
  });
  assertEquals(r.tipo, "importada", JSON.stringify(r));
  assertEquals(banco.itens.length, 3);
});

Deno.test("conjunto de ids NÃO depende da ordem do payload: [1,2] e [2,1] produzem os MESMOS ids (é o que a PK precisa para barrar o 2º lote)", async () => {
  const a = bancoFalso();
  await materializarRecebimento(a, { ...entrada(0), itens: [{ sequencia: 1 }, { sequencia: 2 }, { sequencia: 2 }] });
  const b = bancoFalso();
  await materializarRecebimento(b, { ...entrada(0), itens: [{ sequencia: 2 }, { sequencia: 1 }, { sequencia: 2 }] });
  assertEquals(a.itens.map((i) => i.id).sort(), b.itens.map((i) => i.id).sort());
});

Deno.test("CORRIDA com payload REORDENADO: W1 [1,2] e W2 [2,1], ambos veem zero — fim com N, não 2N (achado P1 do adversarial)", async () => {
  const banco = bancoFalso({ cabecalhos: [{ id: "cab-o", chave_acesso: CHAVE, status: "pendente" }] });
  const b1 = barreira();
  const b2 = barreira();
  let vez = 0;
  banco.antesDeInserirItens = async () => {
    const minha = ++vez;
    if (minha === 1) await b1.esperar();
    if (minha === 2) await b2.esperar();
  };
  const w1 = materializarRecebimento(banco, { ...entrada(0), itens: [{ sequencia: 1 }, { sequencia: 2 }] });
  await ate(() => vez === 1, "W1 na barreira");
  const w2 = materializarRecebimento(banco, { ...entrada(0), itens: [{ sequencia: 2 }, { sequencia: 1 }] });
  await ate(() => vez === 2, "W2 na barreira");
  b2.soltar();
  await ate(() => banco.chamadas.inserirItens === 1, "W2 gravou");
  b1.soltar();
  const [r1, r2] = await Promise.all([w1, w2]);
  assertEquals(itensDe(banco, "cab-o").length, 2, `N, não 2N (W1=${r1.tipo}, W2=${r2.tipo})`);
  assertEquals([r1.tipo, r2.tipo], ["ja_importada", "reparada"]);
});

Deno.test("CORRIDA na CRIAÇÃO de verdade: ambos leem 'nenhuma' ANTES de qualquer cabeçalho; o perdedor do UNIQUE relê com zero itens e completa; o vencedor colide na PK", async () => {
  const banco = bancoFalso();
  const cab1 = barreira(); // W1 parado antes de inserir o cabeçalho
  const cab2 = barreira(); // W2 idem
  const it1 = barreira(); // W1 parado antes dos itens
  let vezCab = 0;
  let vezItens = 0;
  banco.antesDeInserirCabecalho = async () => {
    const minha = ++vezCab;
    if (minha === 1) await cab1.esperar();
    if (minha === 2) await cab2.esperar();
  };
  banco.antesDeInserirItens = async () => {
    if (++vezItens === 1) await it1.esperar();
  };
  const w1 = materializarRecebimento(banco, entrada(3));
  await ate(() => vezCab === 1, "W1 leu 'nenhuma' e está na barreira do cabeçalho");
  const w2 = materializarRecebimento(banco, entrada(3));
  await ate(() => vezCab === 2, "W2 leu 'nenhuma' e está na barreira do cabeçalho");
  assertEquals(banco.chamadas.buscar, 2, "os DOIS leram antes de qualquer cabeçalho existir");
  cab1.soltar(); // W1 cria o cabeçalho e para antes dos itens
  await ate(() => vezItens === 1, "W1 na barreira dos itens");
  cab2.soltar(); // W2 toma 23505, relê (zero itens) e COMPLETA
  await ate(() => banco.chamadas.inserirItens === 1, "W2 gravou (W1 ainda está parado ANTES do contador)");
  it1.soltar(); // W1 colide na PK
  const [r1, r2] = await Promise.all([w1, w2]);
  const id = banco.cabecalhos[0].id;
  assertEquals(banco.cabecalhos.length, 1);
  assertEquals(banco.chamadas.inserirCabecalho, 2, "duas tentativas de cabeçalho (uma barrada pelo UNIQUE)");
  assertEquals(itensDe(banco, id).length, 3, `N, não 2N (W1=${r1.tipo}, W2=${r2.tipo})`);
  assertEquals(r2, { tipo: "reparada", id, itens: 3 } satisfies ResultadoImportacao);
  assertEquals(r1, { tipo: "ja_importada", id, itens: 3 } satisfies ResultadoImportacao);
});
