// Fluxo do bloco com Omie e banco FALSOS (sem rede).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-cliente-trocar-vendedor/
import { cadastroEsperado as esperadoDe, hashCadastro as hashDe, lerParametros, type Parametros, VENDEDOR } from "./decisao.ts";
import { type Candidato, type Dependencias, processarBloco, type Recibo, type RespostaOmieSimples } from "./processar.ts";

function igual(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: recebido ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`);
}

const TATY_OBEN = 8689670840;
const REGINA_OBEN = VENDEDOR.REGINA.oben;
class Indeterminada extends Error {}

function cadastro(codigo: number, vendedor: number | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    codigo_cliente_omie: codigo, nome_fantasia: `CLI ${codigo}`, razao_social: "X", info: { dAlt: "01/01/2026" },
    endereco: "RUA A", endereco_numero: "10", bairro: "CENTRO", cidade: "ITAUNA (MG)", estado: "MG", cep: "35680-000", email: "a@b.com", tags: [{ tag: "Cliente" }],
    recomendacoes: { codigo_transportadora: 77, gerar_boletos: "N", ...(vendedor === null ? {} : { codigo_vendedor: vendedor }) },
    ...extra,
  };
}

interface Cenario {
  omie: Map<number, Record<string, unknown>>;
  candidatos: Candidato[];
  vendedores?: { codigo: number; nome: string; inativo: string }[];
  /** Hook para sabotar a escrita (ex.: o Omie apagar a transportadora junto). */
  espelhoFalha?: boolean;
  vinculo?: (codigo: number, userId: string) => boolean;
  registrarFalhaNo?: number;
  /** Resposta do Consultar sabotada (ex.: o Omie devolve OUTRO cliente). */
  consultaTroca?: (cod: number) => Record<string, unknown> | undefined;
  aoAlterar?: (payload: Record<string, unknown>, atual: Record<string, unknown>) => Record<string, unknown> | "indeterminada" | { fault: string; gravou?: boolean };
}

function montar(c: Cenario) {
  let relogio = 0;
  const recibos = new Map<number, Recibo>();
  const espelho: { conta: string; codigo: number; alvo: number }[] = [];
  const chamadas: string[] = [];
  let seq = 0;
  const criadoEm = new Map<number, number>();
  const ok = (corpo: Record<string, unknown>): RespostaOmieSimples => ({ corpo, fault: null });
  const d: Dependencias = {
    consultarCliente: async (cod) => {
      relogio += 1000; chamadas.push(`Consultar:${cod}`);
      const x = c.consultaTroca?.(cod) ?? c.omie.get(cod);
      return x ? ok(structuredClone(x)) : { corpo: null, fault: "cliente não cadastrado" };
    },
    relerCliente: async (cod) => {
      relogio += 1000; chamadas.push(`Listar:${cod}`);
      const x = c.omie.get(cod);
      return ok({ clientes_cadastro: x ? [structuredClone(x)] : [] });
    },
    alterarCliente: async (payload) => {
      relogio += 1000;
      const cod = payload.codigo_cliente_omie as number;
      chamadas.push(`Alterar:${cod}`);
      const atual = c.omie.get(cod)!;
      // O Omie real recusa payload sem o bloco de endereço inteiro (canários de 2026-11-21) — o fake imita, sem gravar nada.
      if (["endereco", "endereco_numero", "bairro", "cidade", "estado", "cep"].some((k) => typeof payload[k] !== "string" || payload[k] === "")) {
        return { corpo: null, fault: "ERROR: É obrigatório o preenchimento do endereço (Endereço, Número, Bairro, Cidade, Estado e CEP)." };
      }
      if (typeof payload.email !== "string" || payload.email === "") return { corpo: null, fault: "ERROR: É obrigatório o preenchimento do e-mail." };
      if ("tags" in payload || "info" in payload) throw new Error("payload levou lista/objeto do cadastro");
      const r = c.aoAlterar ? c.aoAlterar(payload, atual) : { ...atual, recomendacoes: payload.recomendacoes };
      if (r === "indeterminada") throw new Indeterminada("sem desfecho");
      if ("fault" in r && typeof r.fault === "string") {
        // { fault, gravou: true } = o Omie gravou e a resposta final foi fault (retry REDUNDANT).
        if ((r as Record<string, unknown>).gravou) c.omie.set(cod, { ...atual, recomendacoes: payload.recomendacoes });
        return { corpo: null, fault: r.fault };
      }
      c.omie.set(cod, r as Record<string, unknown>);
      return ok({ codigo_status: "0" });
    },
    listarVendedores: async () => ({ vendedores: c.vendedores ?? [{ codigo: REGINA_OBEN, nome: "REGINA", inativo: "N" }] }),
    ehIndeterminada: (e) => e instanceof Indeterminada,
    candidatos: async () => c.candidatos,
    registrar: async (r) => {
      if (c.registrarFalhaNo !== undefined && seq + 1 === c.registrarFalhaNo) throw new Error("banco caiu");
      const id = ++seq; recibos.set(id, { ...r }); criadoEm.set(id, relogio); return id; },
    atualizar: async (id, patch) => { recibos.set(id, { ...recibos.get(id)!, ...patch }); },
    atualizarEspelho: async (conta, codigo, _u, alvo) => { espelho.push({ conta, codigo, alvo }); return c.espelhoFalha !== true; },
    confirmarVinculo: async (_conta, codigo, userId) => (c.vinculo ? c.vinculo(codigo, userId) : true),
    pendentesVerificacao: async (eid, conta) => [...recibos.entries()]
      .filter(([, r]) => r.execucao_id === eid && r.account === conta && (r.status === "alterado" || r.status === "indeterminado"))
      .map(([id, r]) => ({
        id, omie_codigo_cliente: r.omie_codigo_cliente, customer_user_id: r.customer_user_id,
        status: r.status as "alterado" | "indeterminado", vendedor_antes: r.vendedor_antes, vendedor_alvo: r.vendedor_alvo,
        hash_antes: r.hash_antes ?? null, criado_em_ms: criadoEm.get(id)!,
      })),
    agora: () => relogio,
    dormir: async (ms) => { relogio += ms; },
    novoId: () => "00000000-0000-4000-8000-000000000001",
  };
  return { d, recibos, espelho, chamadas };
}

function params(extra: Record<string, unknown>): Parametros {
  const r = lerParametros({ lote: "saida_vendedora", conta: "oben", ...extra });
  if (!r.ok) throw new Error(r.erro);
  return r.p;
}
const OPC = { executadoPor: "teste", orcamentoEscritaMs: 50_000, orcamentoTotalMs: 115_000 };
const cand = (cod: number): Candidato => ({ omie_codigo_cliente: cod, customer_user_id: null, dono: "REGINA" });

Deno.test("dry_run: lista antes/depois e NÃO escreve no Omie nem no espelho", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, REGINA_OBEN)], [3, cadastro(3, 999)]]);
  const { d, recibos, espelho, chamadas } = montar({ omie, candidatos: [cand(1), cand(2), cand(3)] });
  const r = await processarBloco(params({ modo: "dry_run" }), d, OPC);
  igual(r.itens.map((i) => [i.omie_codigo_cliente, i.vendedor_antes, i.vendedor_alvo, i.status]),
    [[1, TATY_OBEN, REGINA_OBEN, "planejado"], [2, REGINA_OBEN, REGINA_OBEN, "ja_certo"], [3, 999, REGINA_OBEN, "precondicao_falhou"]], "itens");
  igual(chamadas.filter((x) => x.startsWith("Alterar")), [], "nenhum AlterarCliente");
  igual(espelho, [], "espelho intocado");
  igual([...recibos.values()].map((x) => x.status), ["planejado", "ja_certo", "precondicao_falhou"], "recibos");
  igual(omie.get(1)!.recomendacoes, cadastro(1, TATY_OBEN).recomendacoes, "Omie igual");
  igual(r.fim, true, "fim");
});

Deno.test("aplicar: troca, relê por OUTRA chamada, atualiza espelho e verifica o hash ≥61s depois", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  const { d, recibos, espelho, chamadas } = montar({ omie, candidatos: [cand(1), cand(2)] });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual(r.itens.map((i) => i.status), ["verificado", "verificado"], "status");
  igual((omie.get(1)!.recomendacoes as Record<string, unknown>), { codigo_transportadora: 77, gerar_boletos: "N", codigo_vendedor: REGINA_OBEN }, "recomendacoes preservado");
  igual(espelho.map((e) => e.codigo), [1, 2], "espelho");
  igual(chamadas.slice(0, 3), ["Consultar:1", "Alterar:1", "Listar:1"], "releitura não repete o Consultar");
  const recibo1 = recibos.get(1)!;
  igual([recibo1.status, recibo1.vendedor_antes, recibo1.vendedor_depois, recibo1.hash_antes === recibo1.hash_depois], ["verificado", TATY_OBEN, REGINA_OBEN, true], "recibo");
  igual([r.contagem.verificado, r.contagem.alterado], [2, 0], "contagem");
});

Deno.test("aplicar idempotente: 2ª rodada só acha 'ja_certo' e não escreve", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)]]);
  const m1 = montar({ omie, candidatos: [cand(1)] });
  await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), m1.d, OPC);
  const m2 = montar({ omie, candidatos: [cand(1)] });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), m2.d, OPC);
  igual(r.itens[0].status, "ja_certo", "já certo");
  igual(m2.chamadas.filter((x) => x.startsWith("Alterar")), [], "sem escrita");
});

Deno.test("aplicar: Omie mexe em outro campo → 'divergente' e o bloco PARA", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  const { d, chamadas } = montar({
    omie, candidatos: [cand(1), cand(2)],
    aoAlterar: (payload, atual) => ({ ...atual, recomendacoes: { codigo_vendedor: (payload.recomendacoes as Record<string, unknown>).codigo_vendedor } }),
  });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual(r.itens[0].status, "divergente", "1º divergente (transportadora sumiu)");
  igual(r.parou?.startsWith("divergência"), true, "parou");
  igual(r.fim, false, "não é fim");
  // A releitura do 2º mostrou o alvo (a sabotagem só aparece no hash): ele foi escrito, mas a verificação parou no 1º
  // divergente — fica 'alterado' (sem prova), nunca 'verificado'. O teto do estrago é o tamanho do bloco: daí o canário.
  igual(chamadas.includes("Alterar:2"), true, "o 2º foi escrito antes da prova do 1º");
  igual(r.itens[1].status, "alterado", "o 2º fica sem prova");
});

Deno.test("aplicar: releitura sem o alvo → 'divergente', para ANTES do próximo cliente", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  const { d, chamadas, espelho } = montar({ omie, candidatos: [cand(1), cand(2)], aoAlterar: (_p, atual) => atual });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual(r.itens.map((i) => i.status), ["divergente"], "só o 1º");
  igual(chamadas.includes("Consultar:2"), false, "não tocou o 2º");
  igual(espelho, [], "espelho intocado");
});

Deno.test("aplicar: escrita indeterminada → recibo segue 'indeterminado' e o bloco PARA", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  const { d, recibos, chamadas } = montar({ omie, candidatos: [cand(1), cand(2)], aoAlterar: () => "indeterminada" });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual(recibos.get(1)!.status, "indeterminado", "recibo");
  igual(chamadas.includes("Consultar:2"), false, "parou");
  igual(r.parou?.startsWith("escrita indeterminada"), true, "motivo");
});

Deno.test("aplicar: fault do Omie (validação) → 'erro_omie' e segue para o próximo", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  let n = 0;
  const { d } = montar({
    omie, candidatos: [cand(1), cand(2)],
    aoAlterar: (p, atual) => (++n === 1 ? { fault: "Inscrição estadual inválida" } : { ...atual, recomendacoes: p.recomendacoes }),
  });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual(r.itens.map((i) => i.status), ["erro_omie", "verificado"], "status");
});

Deno.test("alvo inativo ou ausente na conta: aborta ANTES de ler qualquer cliente", async () => {
  for (const vendedores of [[{ codigo: REGINA_OBEN, nome: "REGINA", inativo: "S" }], [], [{ codigo: REGINA_OBEN, nome: "TATYANA", inativo: "N" }]]) {
    const { d, chamadas } = montar({ omie: new Map([[1, cadastro(1, TATY_OBEN)]]), candidatos: [cand(1)], vendedores });
    const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
    igual(chamadas, [], "nenhuma chamada a cliente");
    igual(r.parou?.startsWith("alvo REGINA/oben"), true, "motivo");
  }
});

Deno.test("orfaos: só quem está sem vendedor, com o alvo do dono escolhido", async () => {
  const omie = new Map([[1, cadastro(1, null)], [2, cadastro(2, TATY_OBEN)]]);
  const { d } = montar({
    omie,
    candidatos: [{ omie_codigo_cliente: 1, customer_user_id: "u1", dono: "LUCAS" }, { omie_codigo_cliente: 2, customer_user_id: "u2", dono: "REGINA" }],
    vendedores: [{ codigo: REGINA_OBEN, nome: "REGINA", inativo: "N" }, { codigo: VENDEDOR.LUCAS.oben, nome: "LUCAS", inativo: "N" }],
  });
  const p = lerParametros({
    modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE", lote: "orfaos", conta: "oben",
    escolhas: [{ customer_user_id: "00000000-0000-4000-8000-0000000000a1", dono: "LUCAS" }, { customer_user_id: "00000000-0000-4000-8000-0000000000a2", dono: "REGINA" }],
  });
  if (!p.ok) throw new Error(p.erro);
  const r = await processarBloco(p.p, d, OPC);
  igual(r.itens.map((i) => [i.status, i.vendedor_alvo]), [["verificado", VENDEDOR.LUCAS.oben], ["precondicao_falhou", REGINA_OBEN]], "itens");
});

Deno.test("sem tempo para verificar: fica 'alterado' e o modo verificar conclui depois", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)]]);
  const m = montar({ omie, candidatos: [cand(1)] });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), m.d, { ...OPC, orcamentoTotalMs: 10_000 });
  igual(r.itens[0].status, "alterado", "alterado");
  await m.d.dormir(61_000);
  const v = await processarBloco(params({ modo: "verificar", execucao_id: "00000000-0000-4000-8000-000000000001" }), m.d, OPC);
  igual(v.itens.map((i) => i.status), ["verificado"], "verificado depois");
  igual(m.recibos.get(1)!.status, "verificado", "recibo");
});

const APLICAR = { modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" };

Deno.test("Codex P1: fault que ESCONDE escrita feita (retry REDUNDANT) → releitura acha o alvo → 'alterado'/'verificado'", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)]]);
  const { d, espelho } = montar({ omie, candidatos: [cand(1)], aoAlterar: () => ({ fault: "Consumo redundante (REDUNDANT)", gravou: true }) });
  const r = await processarBloco(params(APLICAR), d, OPC);
  igual(r.itens[0].status, "verificado", "a escrita feita foi reconhecida");
  igual(espelho.length, 1, "espelho atualizado");
});

Deno.test("Codex P1: ConsultarCliente devolve OUTRO cliente → nada é escrito", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  const { d, chamadas } = montar({ omie, candidatos: [cand(1)], consultaTroca: (cod) => (cod === 1 ? omie.get(2) : undefined) });
  const r = await processarBloco(params(APLICAR), d, OPC);
  igual(r.itens[0].status, "erro_omie", "erro");
  igual(chamadas.filter((x) => x.startsWith("Alterar")), [], "sem escrita");
});

Deno.test("Codex P2: vendedor ilegível ('123 ') não vira 'vazio' no lote orfaos", async () => {
  const omie = new Map([[1, { ...cadastro(1, null), recomendacoes: { codigo_vendedor: "123 " } }]]);
  const { d, chamadas } = montar({
    omie, candidatos: [{ omie_codigo_cliente: 1, customer_user_id: "u1", dono: "REGINA" }],
  });
  const p = lerParametros({ ...APLICAR, lote: "orfaos", conta: "oben", escolhas: [{ customer_user_id: "00000000-0000-4000-8000-0000000000a1", dono: "REGINA" }] });
  if (!p.ok) throw new Error(p.erro);
  const r = await processarBloco(p.p, d, OPC);
  igual(r.itens[0].status, "precondicao_falhou", "não toca");
  igual(chamadas.filter((x) => x.startsWith("Alterar")), [], "sem escrita");
});

Deno.test("Codex P2: órfão SEM o objeto recomendacoes → depois da troca o hash bate ('verificado', não falso divergente)", async () => {
  const semRec: Record<string, unknown> = cadastro(1, null);
  delete semRec.recomendacoes;
  const omie = new Map([[1, semRec]]);
  const { d } = montar({ omie, candidatos: [{ omie_codigo_cliente: 1, customer_user_id: "u1", dono: "REGINA" }] });
  const p = lerParametros({ ...APLICAR, lote: "orfaos", conta: "oben", escolhas: [{ customer_user_id: "00000000-0000-4000-8000-0000000000a1", dono: "REGINA" }] });
  if (!p.ok) throw new Error(p.erro);
  const r = await processarBloco(p.p, d, OPC);
  igual(r.itens[0].status, "verificado", "verificado");
});

Deno.test("Codex P1: espelho não atualizou → expõe espelho_ok=false e o bloco PARA", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  const { d, chamadas } = montar({ omie, candidatos: [cand(1), cand(2)], espelhoFalha: true });
  const r = await processarBloco(params(APLICAR), d, OPC);
  igual(r.itens[0].espelho_ok, false, "exposto");
  igual(r.parou?.startsWith("espelho"), true, "parou");
  igual(chamadas.includes("Consultar:2"), false, "não seguiu");
});

Deno.test("Codex P1: verificar não anuncia fim com pendente novo demais, e reusa o execucao_id pedido", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)]]);
  const m = montar({ omie, candidatos: [cand(1)] });
  await processarBloco(params(APLICAR), m.d, { ...OPC, orcamentoTotalMs: 5_000 });
  const eid = "00000000-0000-4000-8000-000000000001";
  // relógio do fake está ~3s depois do Consultar: cedo demais para outro ConsultarCliente.
  const v1 = await processarBloco(params({ modo: "verificar", execucao_id: eid }), m.d, OPC);
  igual([v1.fim, v1.itens.length, v1.execucao_id], [false, 0, eid], "não é fim");
  await m.d.dormir(61_000);
  const v2 = await processarBloco(params({ modo: "verificar", execucao_id: eid }), m.d, OPC);
  igual([v2.fim, v2.itens[0].status], [true, "verificado"], "agora sim");
});

Deno.test("verificar decide o 'indeterminado': nada gravado → 'erro_omie'; gravado → 'verificado' + espelho", async () => {
  for (const gravou of [false, true]) {
    const omie = new Map([[1, cadastro(1, TATY_OBEN)]]);
    const m = montar({
      omie, candidatos: [cand(1)],
      aoAlterar: (p, atual) => { if (gravou) omie.set(1, { ...atual, recomendacoes: p.recomendacoes }); return "indeterminada"; },
    });
    await processarBloco(params(APLICAR), m.d, OPC);
    await m.d.dormir(61_000);
    const v = await processarBloco(params({ modo: "verificar", execucao_id: "00000000-0000-4000-8000-000000000001" }), m.d, OPC);
    igual(v.itens[0].status, gravou ? "verificado" : "erro_omie", `gravou=${gravou}`);
    igual(m.espelho.length, gravou ? 1 : 0, `espelho gravou=${gravou}`);
  }
});

Deno.test("fault na escrita + releitura sem o cliente → 'indeterminado' (nunca 'erro_omie'), e o bloco PARA", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  const m = montar({ omie, candidatos: [cand(1), cand(2)], aoAlterar: () => { omie.delete(1); return { fault: "timeout" }; } });
  const r = await processarBloco(params(APLICAR), m.d, OPC);
  igual(r.itens.map((i) => i.status), ["indeterminado"], "indeterminado");
  igual(m.recibos.get(1)!.status, "indeterminado", "recibo");
  igual(m.chamadas.includes("Consultar:2"), false, "parou");
});

Deno.test("Codex r2 P1: fault com vendedor inalterado mas OUTRO campo perdido → a prova por hash acusa 'divergente'", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)]]);
  const { d, recibos } = montar({
    omie, candidatos: [cand(1)],
    aoAlterar: (_p, atual) => { omie.set(1, { ...atual, recomendacoes: { codigo_vendedor: TATY_OBEN } }); return { fault: "REDUNDANT" }; },
  });
  const r = await processarBloco(params(APLICAR), d, OPC);
  igual(r.itens[0].status, "divergente", "divergente");
  igual(recibos.get(1)!.status, "divergente", "recibo");
  igual(r.parou?.startsWith("divergência"), true, "parou");
});

Deno.test("Codex r2 P1: fault com cadastro intacto → 'erro_omie' PROVADO pelo hash, e o bloco segue", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  let n = 0;
  const { d, recibos } = montar({
    omie, candidatos: [cand(1), cand(2)],
    aoAlterar: (p, atual) => (++n === 1 ? { fault: "IE inválida" } : { ...atual, recomendacoes: p.recomendacoes }),
  });
  const r = await processarBloco(params(APLICAR), d, OPC);
  igual(r.itens.map((i) => i.status), ["erro_omie", "verificado"], "status");
  igual(recibos.get(1)!.status, "erro_omie", "recibo provado");
});

Deno.test("Codex r2 P1: 'ja_certo' com espelho que não atualiza → PARA o bloco", async () => {
  const omie = new Map([[1, cadastro(1, REGINA_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  const { d, chamadas } = montar({ omie, candidatos: [cand(1), cand(2)], espelhoFalha: true });
  const r = await processarBloco(params(APLICAR), d, OPC);
  igual(r.parou?.startsWith("espelho"), true, "parou");
  igual(chamadas.includes("Consultar:2"), false, "não seguiu");
});

Deno.test("Codex r2 P1: orfaos com vínculo que mudou entre a seleção e a escrita → não escreve", async () => {
  const omie = new Map([[1, cadastro(1, null)]]);
  const { d, chamadas } = montar({
    omie, candidatos: [{ omie_codigo_cliente: 1, customer_user_id: "u1", dono: "REGINA" }], vinculo: () => false,
  });
  const p = lerParametros({ ...APLICAR, lote: "orfaos", conta: "oben", escolhas: [{ customer_user_id: "00000000-0000-4000-8000-0000000000a1", dono: "REGINA" }] });
  if (!p.ok) throw new Error(p.erro);
  const r = await processarBloco(p.p, d, OPC);
  igual(r.itens[0].status, "precondicao_falhou", "não toca");
  igual(chamadas.filter((x) => x.startsWith("Alterar")), [], "sem escrita");
});

Deno.test("Codex r2 P1: exceção no meio do bloco devolve o execucao_id e os itens feitos (não 500 cego)", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)], [2, cadastro(2, TATY_OBEN)]]);
  const { d } = montar({ omie, candidatos: [cand(1), cand(2)], registrarFalhaNo: 2 });
  const r = await processarBloco(params(APLICAR), d, OPC);
  igual([r.execucao_id, r.fim, r.parou?.startsWith("exceção")], ["00000000-0000-4000-8000-000000000001", false, true], "resultado parcial");
  igual(r.itens[0].status, "alterado", "o 1º ficou alterado, à espera do verificar");
});

Deno.test("v1.2: cadastro com endereço incompleto no Omie → 'precondicao_falhou' no dry_run e no aplicar, sem AlterarCliente", async () => {
  for (const modo of ["dry_run", "aplicar"] as const) {
    const omie = new Map([[1, cadastro(1, TATY_OBEN, { bairro: "", cep: "  " })], [2, cadastro(2, TATY_OBEN)]]);
    const { d, chamadas } = montar({ omie, candidatos: [cand(1), cand(2)] });
    const r = await processarBloco(params(modo === "aplicar" ? { modo, confirmo: "TROCAR VENDEDOR NO OMIE" } : { modo }), d, OPC);
    igual(r.itens.map((i) => [i.omie_codigo_cliente, i.status]), [[1, "precondicao_falhou"], [2, modo === "dry_run" ? "planejado" : "verificado"]], `${modo}: status`);
    igual(r.itens[0].erro, "endereço incompleto no Omie (o AlterarCliente exige): falta bairro, cep", `${modo}: motivo`);
    if (chamadas.includes("Alterar:1")) throw new Error(`${modo}: escreveu no cliente sem estado`);
    igual(omie.get(1)!.recomendacoes, cadastro(1, TATY_OBEN).recomendacoes, `${modo}: Omie igual`);
  }
});

Deno.test("v1.3: o payload leva os escalares EXATAMENTE como lidos (endereço, e-mail…) e nenhuma lista/objeto", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN, { estado: "SC", cidade: "JOINVILLE (SC)", cep: "89201-000" })]]);
  const enviados: Record<string, unknown>[] = [];
  const { d } = montar({ omie, candidatos: [cand(1)], aoAlterar: (payload, atual) => { enviados.push(payload); return { ...atual, recomendacoes: payload.recomendacoes }; } });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual(r.itens[0].status, "verificado", "status");
  igual(["endereco", "endereco_numero", "bairro", "cidade", "estado", "cep"].map((k) => enviados[0][k]), ["RUA A", "10", "CENTRO", "JOINVILLE (SC)", "SC", "89201-000"], "endereço do lido");
  igual(Object.keys(enviados[0]).sort(), ["bairro", "cep", "cidade", "codigo_cliente_omie", "email", "endereco", "endereco_numero", "estado", "nome_fantasia", "razao_social", "recomendacoes"], "escalares como lidos + recomendações; nada de info/tags");
});

Deno.test("Codex v1.1 P2: verificar que acha 'divergente' PARA (parou preenchido, fim=false), não anuncia fim", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)]]);
  const m = montar({ omie, candidatos: [cand(1)] });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), m.d, { ...OPC, orcamentoTotalMs: 10_000 });
  igual(r.itens[0].status, "alterado", "alterado");
  omie.set(1, { ...omie.get(1)!, razao_social: "MUDOU" }); // alguém mexeu em outro campo antes da prova
  await m.d.dormir(61_000);
  const v = await processarBloco(params({ modo: "verificar", execucao_id: "00000000-0000-4000-8000-000000000001" }), m.d, OPC);
  igual(v.itens.map((i) => i.status), ["divergente"], "divergente");
  igual([v.parou, v.fim], ["cadastro divergente no cliente 1", false], "para o operador");
});

Deno.test("v1.3: cadastro SEM e-mail na conta que exige → Omie recusa, 'erro_omie' provado (nada gravado), bloco segue", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN, { email: "" })], [2, cadastro(2, TATY_OBEN)]]);
  const { d } = montar({ omie, candidatos: [cand(1), cand(2)] });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual(r.itens.map((i) => [i.omie_codigo_cliente, i.status]), [[1, "erro_omie"], [2, "verificado"]], "status");
  igual(omie.get(1)!.recomendacoes, cadastro(1, TATY_OBEN).recomendacoes, "cliente 1 intacto");
});

Deno.test("Codex v1.3 P2: fault sem tempo para a prova → resposta 'indeterminado' (nunca 'erro_omie' sem prova)", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN, { email: "" })]]);
  const { d, recibos } = montar({ omie, candidatos: [cand(1)] });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, { ...OPC, orcamentoTotalMs: 10_000 });
  igual([r.itens[0].status, recibos.get(1)!.status], ["indeterminado", "indeterminado"], "resposta = recibo");
  igual([r.contagem.indeterminado, r.contagem.erro_omie ?? 0], [1, 0], "contagem");
});

Deno.test("v1.4: divergência NOMEIA o campo que mudou (de → para) no erro do item e do recibo", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN, { importado_api: "N" })]]);
  const { d, recibos } = montar({ omie, candidatos: [cand(1)], aoAlterar: (payload, atual) => ({ ...atual, recomendacoes: payload.recomendacoes, importado_api: "S" }) });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual(r.itens[0].status, "divergente", "status");
  igual(r.itens[0].erro, 'o cadastro mudou além do vendedor: importado_api: "N" → "S"', "erro nomeia o campo");
  igual(recibos.get(1)!.erro, r.itens[0].erro, "recibo igual");
});

Deno.test("v1.4: texto vazio NÃO vai no payload (o Omie recusa vazio em campo com domínio)", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN, { tipo_atividade: "", bloqueado: " ", complemento: "SALA 1" })]]);
  const enviados: Record<string, unknown>[] = [];
  const { d } = montar({ omie, candidatos: [cand(1)], aoAlterar: (payload, atual) => { enviados.push(payload); return { ...atual, recomendacoes: payload.recomendacoes }; } });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual(r.itens[0].status, "verificado", "status");
  igual(["tipo_atividade" in enviados[0], "bloqueado" in enviados[0], enviados[0].complemento], [false, false, "SALA 1"], "vazios fora, preenchido vai");
});

Deno.test("Codex v1.4 P2: divergência SÓ no vendedor (hash bate) → erro diz esperado × lido, não 'mudou além'", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN)]]);
  let consultas = 0;
  const { d } = montar({ omie, candidatos: [cand(1)], consultaTroca: (cod) => (++consultas === 2 ? cadastro(cod, 999) : undefined) });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual([r.itens[0].status, r.itens[0].erro], ["divergente", `vendedor esperado ${REGINA_OBEN}, lido 999`], "diagnóstico certo");
});

// Omie como medido em 2026-11-22: CODIFICA o texto recebido (& < > " ') antes de gravar.
const codificar = (x: string) => x.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const gravaComoOmie = (payload: Record<string, unknown>, atual: Record<string, unknown>) => {
  const r: Record<string, unknown> = { ...atual };
  for (const [k, v] of Object.entries(payload)) r[k] = typeof v === "string" ? codificar(v) : v;
  return r;
};

Deno.test("v1.6: cadastro com &amp;/&apos; → payload decodificado, Omie recodifica e o hash bate LITERAL ('verificado')", async () => {
  const orig = { razao_social: "TRES R MOVEIS &amp; CIA LTDA", nome_fantasia: "MOVEIS &amp; CIA", observacao: "base d&apos;água\nLINHA 2" };
  const omie = new Map([[1, cadastro(1, TATY_OBEN, orig)]]);
  const enviados: Record<string, unknown>[] = [];
  const { d } = montar({ omie, candidatos: [cand(1)], aoAlterar: (payload, atual) => { enviados.push(payload); return gravaComoOmie(payload, atual); } });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual([enviados[0].razao_social, enviados[0].observacao], ["TRES R MOVEIS & CIA LTDA", "base d'água\nLINHA 2"], "payload decodificado");
  igual([omie.get(1)?.razao_social, omie.get(1)?.observacao], [orig.razao_social, orig.observacao], "Omie regravou o original");
  igual(r.itens[0].status, "verificado", "status");
});

Deno.test("v1.6: o Omie da v1.4 (reenvio como lido) seria pego — & cru no cadastro → 'precondicao_falhou' sem AlterarCliente", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN, { razao_social: "P&D LTDA" })]]);
  const enviados: Record<string, unknown>[] = [];
  const { d } = montar({ omie, candidatos: [cand(1)], aoAlterar: (payload, atual) => { enviados.push(payload); return gravaComoOmie(payload, atual); } });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual([r.itens[0].status, enviados.length], ["precondicao_falhou", 0], "recusa sem escrever");
  if (!String(r.itens[0].erro).includes("razao_social")) throw new Error(`erro deve nomear o campo: ${r.itens[0].erro}`);
});

// Prova do reparo para o teste: o hash do cadastro "de antes do dano" (o lido com uma camada a menos).

const provaDe = async (cod: number, cad: Record<string, unknown>) => ({ [cod]: { hash: await hashDe(esperadoDe(cad, true)), recorte: "literal" as const } });
const REPARAR = { modo: "aplicar", lote: "reparo_entidades", confirmo: "TROCAR VENDEDOR NO OMIE" };

Deno.test("v1.6 reparo_entidades: &amp;amp; volta a &amp; e fica 'verificado'; vendedor segue o alvo", async () => {
  const dano = cadastro(1, REGINA_OBEN, { razao_social: "TRES R MOVEIS &amp;amp; CIA LTDA", observacao: "d&amp;apos;água" });
  const omie = new Map([[1, dano]]);
  const { d } = montar({ omie, candidatos: [cand(1)], aoAlterar: gravaComoOmie });
  const r = await processarBloco(params(REPARAR), d, { ...OPC, provasReparo: await provaDe(1, dano) });
  igual([omie.get(1)?.razao_social, omie.get(1)?.observacao], ["TRES R MOVEIS &amp; CIA LTDA", "d&apos;água"], "reparado");
  igual([r.itens[0].status, r.itens[0].vendedor_depois], ["verificado", REGINA_OBEN], "status");
});

Deno.test("v1.6 reparo_entidades: Omie que NÃO grava → 'divergente' (nunca 'verificado'), e quem não está no alvo não é tocado", async () => {
  const c1 = cadastro(1, REGINA_OBEN, { razao_social: "X &amp;amp; Y" }), c2 = cadastro(2, TATY_OBEN, { razao_social: "X &amp;amp; Y" });
  const omie = new Map([[1, c1], [2, c2]]);
  const enviados: Record<string, unknown>[] = [];
  const { d } = montar({ omie, candidatos: [cand(2), cand(1)], aoAlterar: (payload, atual) => { enviados.push(payload); return { ...atual }; } });
  const r = await processarBloco(params(REPARAR), d, { ...OPC, provasReparo: { ...await provaDe(1, c1), ...await provaDe(2, c2) } });
  igual(r.itens.map((i) => i.status), ["precondicao_falhou", "divergente"], "status");
  igual(enviados.length, 1, "só o do alvo recebeu AlterarCliente");
});

Deno.test("Codex v1.6 P1: reparo cuja camada a menos NÃO reproduz o hash do recibo → recusa sem escrever; fora da lista também", async () => {
  const dano = cadastro(1, REGINA_OBEN, { razao_social: "X &amp;amp; Y" });
  const outro = cadastro(2, REGINA_OBEN, { razao_social: "X &amp;amp; Y" });
  const omie = new Map([[1, dano], [2, outro]]);
  const enviados: Record<string, unknown>[] = [];
  const { d } = montar({ omie, candidatos: [cand(1), cand(2)], aoAlterar: (payload, atual) => { enviados.push(payload); return gravaComoOmie(payload, atual); } });
  const r = await processarBloco(params(REPARAR), d, { ...OPC, provasReparo: { 1: { hash: "0".repeat(64), recorte: "literal" } } });
  igual(r.itens.map((i) => i.status), ["precondicao_falhou", "precondicao_falhou"], "status");
  igual(enviados.length, 0, "nenhuma escrita");
  if (!String(r.itens[0].erro).includes("não reproduz") || !String(r.itens[1].erro).includes("fora da lista")) throw new Error(`motivos: ${r.itens.map((i) => i.erro)}`);
});

Deno.test("Codex v1.6 P3: reparo de cadastro SEM entidade dupla → 'ja_certo', sem AlterarCliente", async () => {
  const limpo = cadastro(1, REGINA_OBEN, { razao_social: "SEM ENTIDADE" });
  const omie = new Map([[1, limpo]]);
  const enviados: Record<string, unknown>[] = [];
  const { d } = montar({ omie, candidatos: [cand(1)], aoAlterar: (payload, atual) => { enviados.push(payload); return atual; } });
  const r = await processarBloco(params(REPARAR), d, { ...OPC, provasReparo: await provaDe(1, limpo) });
  igual([r.itens[0].status, enviados.length], ["ja_certo", 0], "não escreve");
});

Deno.test("Codex v1.6 P2: &lt; &gt; &quot; (codificação não medida) → 'precondicao_falhou' sem escrever", async () => {
  const omie = new Map([[1, cadastro(1, TATY_OBEN, { observacao: "NAO ENTREGAR &lt;SAB&gt;" })]]);
  const enviados: Record<string, unknown>[] = [];
  const { d } = montar({ omie, candidatos: [cand(1)], aoAlterar: (payload, atual) => { enviados.push(payload); return gravaComoOmie(payload, atual); } });
  const r = await processarBloco(params({ modo: "aplicar", confirmo: "TROCAR VENDEDOR NO OMIE" }), d, OPC);
  igual([r.itens[0].status, enviados.length], ["precondicao_falhou", 0], "recusa");
});

Deno.test("v1.6: recibo do reparo grava lote 'saida_vendedora' (CHECK do banco só conhece saida_vendedora|orfaos)", async () => {
  const dano = cadastro(1, REGINA_OBEN, { razao_social: "X &amp;amp; Y" });
  const { d, recibos } = montar({ omie: new Map([[1, dano]]), candidatos: [cand(1)], aoAlterar: gravaComoOmie });
  await processarBloco(params(REPARAR), d, { ...OPC, provasReparo: await provaDe(1, dano) });
  igual([...new Set([...recibos.values()].map((x) => x.lote))], ["saida_vendedora"], "lote no recibo");
});

Deno.test("v1.6 reparo + verificar tardio: 'nada gravado' dá 'divergente'; gravado dá 'verificado' (recibo guarda o hash ESPERADO)", async () => {
  for (const grava of [false, true]) {
    const dano = cadastro(1, REGINA_OBEN, { razao_social: "X &amp;amp; Y" });
    const m = montar({ omie: new Map([[1, dano]]), candidatos: [cand(1)], aoAlterar: grava ? gravaComoOmie : (_p, atual) => ({ ...atual }) });
    const r = await processarBloco(params(REPARAR), m.d, { ...OPC, orcamentoTotalMs: 10_000, provasReparo: await provaDe(1, dano) });
    igual(r.itens[0].status, "alterado", `grava=${grava}: alterado`);
    await m.d.dormir(61_000);
    const v = await processarBloco(params({ modo: "verificar", lote: "reparo_entidades", execucao_id: "00000000-0000-4000-8000-000000000001" }), m.d, OPC);
    igual(v.itens.map((i) => i.status), [grava ? "verificado" : "divergente"], `grava=${grava}: verificar`);
  }
});
