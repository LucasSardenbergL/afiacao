// Testa a SEQUÊNCIA DE ESCRITA da process-nfe (fluxo.ts) no runtime real (Deno), com Omie, banco e
// auth falsos. Roda com: deno test --no-remote supabase/functions/process-nfe/fluxo_test.ts
//
// O que protege: (1) efeito ZERO sem auth / sem staff — nenhuma chamada ao Omie, nenhuma linha de
// trilha; (2) a ordem — trilha de INTENÇÃO gravada antes de cada escrita, e sem ela a escrita não
// sai; (3) falha em cada passo para a sequência ali (Alterar → nada de Etapa/Concluir; Etapa → nada de
// Concluir; Concluir indeterminado sai como tal); (4) guardas que param ANTES de escrever (já recebida,
// regra de quantidade); (5) a quantidade enviada é a do caso real (3 UN, não 54).
import { lerResposta, type RespostaOmie } from "../_shared/omie-cliente.ts";
import { OmieEscritaIndeterminada } from "../_shared/omie-chamada-relogio.ts";
import { type ResultadoAuth, tratarRequisicao } from "./fluxo.ts";
import type { DbTrilha } from "./trilha.ts";

function igual(a: unknown, b: unknown, msg: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}: esperado ${jb}, veio ${ja}`);
}

const STAFF: ResultadoAuth = { ok: true, via: "staff", userId: "00000000-0000-0000-0000-0000000000ee" };
const ESCRITAS = ["AlterarRecebimento", "AlterarEtapaRecebimento", "ConcluirRecebimento"];

function resp(corpo: unknown, status = 200): RespostaOmie {
  return lerResposta(status, JSON.stringify(corpo));
}

function consultaReal(over: { etapa?: string; recebido?: string; itens?: unknown[] } = {}) {
  return {
    cabec: { nIdReceb: 777, cChaveNfe: "4226", cEtapa: over.etapa ?? "20" },
    infoCadastro: { cRecebido: over.recebido ?? "N" },
    itensRecebimento: over.itens ?? [
      { itensCabec: { nSequencia: 5, cCodigoProduto: "PRD03454", nIdProduto: 501, nQtdeNFe: 54, cUnidadeNfe: "L", cIgnorarItem: "N", nValorUnitario: 10 },
        itensAjustes: { nQtdeRecebida: 3, cUnidade: "UN" } },
      { itensCabec: { nSequencia: 7, cCodigoProduto: "PRD00316", nIdProduto: 502, nQtdeNFe: 2, cUnidadeNfe: "L", cIgnorarItem: "N", nValorUnitario: 5 },
        itensAjustes: { nQtdeRecebida: 2, cUnidade: "L" } },
    ],
  };
}

type Roteiro = Record<string, () => RespostaOmie | Promise<RespostaOmie>>;

function cenario(o: { auth?: ResultadoAuth; roteiro?: Roteiro; falhaTrilha?: (passo: string, resultado: string) => boolean } = {}) {
  const log: string[] = [];
  const params: Record<string, unknown> = {};
  const linhas: Record<string, unknown>[] = [];
  const roteiro: Roteiro = {
    ListarRecebimentos: () => resp({ recebimentos: [{ cabec: { nIdReceb: 777, cNumeroNFe: "000955811", cChaveNfe: "4226", cNome: "RENNER SAYERLACK" } }] }),
    ConsultarRecebimento: () => resp(consultaReal()),
    ListarDepartamentos: () => resp({ departamentos: [{ codigo: "OPERA", descricao: "Operações" }] }),
    AlterarRecebimento: () => resp({ cCodStatus: "0" }),
    AlterarEtapaRecebimento: () => resp({ cCodStatus: "0" }),
    ConcluirRecebimento: () => resp({ cCodStatus: "0" }),
    ...o.roteiro,
  };
  const db: DbTrilha = {
    from: () => ({
      insert: (linha) => {
        const chave = `${linha.passo}/${linha.resultado}`;
        log.push(`trilha:${chave}`);
        if (o.falhaTrilha?.(String(linha.passo), String(linha.resultado))) return Promise.resolve({ error: { message: "falha simulada" } });
        linhas.push(linha);
        return Promise.resolve({ error: null });
      },
    }),
  };
  const deps = {
    autorizar: () => Promise.resolve(o.auth ?? STAFF),
    omie: async (_c: string, _e: string, metodo: string, param: Record<string, unknown>) => {
      log.push(`omie:${metodo}`);
      params[metodo] = param;
      const f = roteiro[metodo];
      if (!f) throw new Error(`método inesperado ${metodo}`);
      return await f();
    },
    db,
    novoId: () => "11111111-1111-1111-1111-111111111111",
  };
  const rodar = async (corpo: unknown = { nf_number: "955811", account: "oben" }) => {
    const res = await tratarRequisicao(new Request("http://x/process-nfe", { method: "POST", body: JSON.stringify(corpo) }), deps);
    return { status: res.status, corpo: await res.json() as Record<string, unknown> };
  };
  const omieChamados = () => log.filter((l) => l.startsWith("omie:")).map((l) => l.slice(5));
  const escritas = () => omieChamados().filter((m) => ESCRITAS.includes(m));
  return { log, params, linhas, rodar, omieChamados, escritas };
}

Deno.test("sem auth: devolve a resposta do gate e efeito ZERO (nenhum Omie, nenhuma trilha)", async () => {
  const c = cenario({ auth: { ok: false, response: new Response("{}", { status: 401 }) } });
  const r = await c.rodar();
  igual([r.status, c.log], [401, []], "401 sem efeito");
});

Deno.test("cron sem usuário (x-cron-secret): 403 e efeito ZERO — o recebimento exige staff", async () => {
  const c = cenario({ auth: { ok: true, via: "cron" } });
  const r = await c.rodar();
  igual([r.status, c.log], [403, []], "403 sem efeito");
  const s = cenario({ auth: { ok: true, via: "service_role" } });
  igual([(await s.rodar()).status, s.log], [403, []], "service_role também não");
});

Deno.test("sonda pelo cron responde a versão sem efeito", async () => {
  const c = cenario({ auth: { ok: true, via: "cron" } });
  const r = await c.rodar({ probe: true });
  igual([r.status, c.log], [200, []], "sonda sem efeito");
});

Deno.test("entrada inválida (NF não numérica, conta desconhecida) → 400 sem efeito", async () => {
  for (const corpo of [{ nf_number: "abc" }, {}, { nf_number: "955811", account: "xyz" }]) {
    const c = cenario();
    igual([(await c.rodar(corpo)).status, c.log], [400, []], JSON.stringify(corpo));
  }
});

Deno.test("caminho feliz: ordem exata, intenção antes de cada escrita, 3 UN (não 54) para o caso real", async () => {
  const c = cenario();
  const r = await c.rodar();
  igual(r.corpo.success, true, "success");
  igual(c.log, [
    "trilha:inicio/intencao",
    "omie:ListarRecebimentos", "trilha:nf_localizada/ok",
    "omie:ConsultarRecebimento", "trilha:consulta/ok",
    "omie:ListarDepartamentos",
    "trilha:quantidades/intencao", "omie:AlterarRecebimento", "trilha:alterar_recebimento/ok",
    "trilha:alterar_etapa/intencao", "omie:AlterarEtapaRecebimento", "trilha:alterar_etapa/ok",
    "trilha:concluir_recebimento/intencao", "omie:ConcluirRecebimento", "trilha:concluir_recebimento/ok",
    "trilha:fim/ok",
  ], "sequência");
  const alterar = c.params.AlterarRecebimento as { itensRecebimentoEditar: { itensIde: { nSequencia: number }; itensAjustes: { nQtdeRecebida: number } }[] };
  igual(alterar.itensRecebimentoEditar.map((i) => [i.itensIde.nSequencia, i.itensAjustes.nQtdeRecebida]), [[5, 3], [7, 2]], "quantidades enviadas");
  const linhaQtd = c.linhas.find((l) => l.passo === "quantidades") as { detalhe: { itens: { qtd_nf: number; qtd_enviada: number; regra: string }[] }; executado_por: string; n_id_receb: number; chave_nfe: string };
  igual([linhaQtd.executado_por, linhaQtd.n_id_receb, linhaQtd.chave_nfe], [STAFF.ok && STAFF.userId, 777, "4226"], "quem + NF/chave");
  igual(linhaQtd.detalhe.itens.map((i) => [i.qtd_nf, i.qtd_enviada, i.regra]), [[54, 3, "conversao_do_omie"], [2, 2, "nf_igual_omie"]], "itens na trilha");
});

Deno.test("etapa já 40 (repetição): não chama AlterarEtapaRecebimento", async () => {
  const c = cenario({ roteiro: { ConsultarRecebimento: () => resp(consultaReal({ etapa: "40" })) } });
  igual((await c.rodar()).corpo.success, true, "concluiu");
  igual(c.escritas(), ["AlterarRecebimento", "ConcluirRecebimento"], "sem etapa");
  igual(c.log.includes("trilha:alterar_etapa/pulado"), true, "pulado na trilha");
});

Deno.test("já recebida no Omie (cRecebido S ou etapa 80): para ANTES de escrever", async () => {
  for (const over of [{ recebido: "S" }, { etapa: "80" }]) {
    const c = cenario({ roteiro: { ConsultarRecebimento: () => resp(consultaReal(over)) } });
    const r = await c.rodar();
    igual([r.corpo.success, c.escritas()], [undefined, []], JSON.stringify(over));
    igual(c.log.slice(-2), ["trilha:consulta/recusado", "trilha:fim/recusado"], "trilha recusada");
  }
});

Deno.test("regra de quantidade recusa (conversão sem número do Omie): nenhuma escrita", async () => {
  const itens = [{ itensCabec: { nSequencia: 1, nQtdeNFe: 54, cUnidadeNfe: "L", cIgnorarItem: "N" }, itensAjustes: { cUnidade: "UN" } }];
  const c = cenario({ roteiro: { ConsultarRecebimento: () => resp(consultaReal({ itens })) } });
  const r = await c.rodar();
  igual([c.escritas(), c.log.includes("trilha:quantidades/recusado")], [[], true], "recusado sem escrita");
  igual(String(r.corpo.error).includes("nada foi enviado ao Omie"), true, "mensagem");
});

Deno.test("trilha fora do ar no INÍCIO: nenhuma chamada ao Omie", async () => {
  const c = cenario({ falhaTrilha: (p) => p === "inicio" });
  const r = await c.rodar();
  igual([c.omieChamados(), r.corpo.success], [[], undefined], "zero Omie");
});

Deno.test("trilha da INTENÇÃO falha: a escrita correspondente NÃO sai", async () => {
  for (const [passo, esperadas] of [
    ["quantidades", []],
    ["alterar_etapa", ["AlterarRecebimento"]],
    ["concluir_recebimento", ["AlterarRecebimento", "AlterarEtapaRecebimento"]],
  ] as const) {
    const c = cenario({ falhaTrilha: (p, r) => p === passo && r === "intencao" });
    const r = await c.rodar();
    igual([c.escritas(), r.corpo.success], [esperadas, undefined], `intenção ${passo}`);
  }
});

Deno.test("trilha do RESULTADO falha depois da escrita: segue e avisa trilha_incompleta", async () => {
  const c = cenario({ falhaTrilha: (p, r) => p === "alterar_recebimento" && r === "ok" });
  const r = await c.rodar();
  igual([r.corpo.success, r.corpo.trilha_incompleta, c.escritas().length], [true, true, 3], "segue com aviso");
});

Deno.test("falha em cada escrita para a sequência ali, com o desfecho certo na trilha", async () => {
  const fault = () => resp({ faultstring: "ERROR: recusado pelo Omie", faultcode: "SOAP-ENV:Client" }, 500);
  const indet = () => Promise.reject(new OmieEscritaIndeterminada("ConcluirRecebimento", "oben", "sem resposta dentro do teto da chamada", null));
  for (const [metodo, f, esperadas, resultado] of [
    ["AlterarRecebimento", fault, ["AlterarRecebimento"], "erro"],
    ["AlterarEtapaRecebimento", fault, ["AlterarRecebimento", "AlterarEtapaRecebimento"], "erro"],
    ["ConcluirRecebimento", fault, ESCRITAS, "erro"],
    ["ConcluirRecebimento", indet, ESCRITAS, "indeterminado"],
  ] as const) {
    const c = cenario({ roteiro: { [metodo]: f } });
    const r = await c.rodar();
    igual([c.escritas(), r.corpo.success], [esperadas, undefined], `${metodo}/${resultado}`);
    igual(c.log.slice(-1), [`trilha:fim/${resultado}`], `fim ${metodo}`);
    if (resultado === "indeterminado") igual(String(r.corpo.error).includes("confira no Omie antes de repetir"), true, "mensagem indeterminada");
  }
});

Deno.test("leitura que falha (Listar/Consultar) ou NF não achada até o fim: nenhuma escrita", async () => {
  const quebra = () => Promise.reject(new Error("OMIE_TRANSIENT (oben): timeout"));
  for (const roteiro of [
    { ListarRecebimentos: quebra },
    { ConsultarRecebimento: quebra },
    { ListarRecebimentos: () => resp({ faultstring: "ERROR: Não existem registros para a página [1]!" }, 500) },
    { ListarRecebimentos: () => resp({ recebimentos: [{ cabec: { nIdReceb: 1, cNumeroNFe: "123" } }] }) },
    { ListarRecebimentos: () => resp({}) },
  ] as Roteiro[]) {
    const c = cenario({ roteiro });
    const r = await c.rodar();
    igual([c.escritas(), r.corpo.success, typeof r.corpo.error], [[], undefined, "string"], Object.keys(roteiro)[0]);
  }
});
