// Testa o CÓDIGO REAL de consulta.ts no runtime real (Deno), contra um Omie FALSO que responde um
// roteiro e controla o relógio e o sono. Roda com:
//   deno test --no-remote supabase/functions/omie-sync-sku-items/consulta_test.ts
//
// Por que existe (achado do Codex no desenho): testar só a decisão pura prova a REGRA, não que o
// encanamento a respeita — um teste que fabrica `{adiada:true}` fica verde enquanto o wrapper
// lança e o laço pune a NFe. Aqui o caminho é o de produção: request → corpo → classificação →
// retentativa/sono → adiamento ou exceção → desfecho por NFe.
import {
  consultarNfe,
  type DepsConsulta,
  OMIE_ENDPOINT_RECEBIMENTO,
  type ResultadoConsulta,
} from "./consulta.ts";
import { MIN_REQUEST_MS } from "../_shared/omie-deadline.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(msg ?? `esperado ${jb}, veio ${ja}`);
}

type Passo = { status: number; corpo: string } | { lancar: string };

const T0 = 1_000_000;
const CRED = { app_key: "chave-teste", app_secret: "segredo-teste" };
const json = (o: unknown) => JSON.stringify(o);
const redundant = (s: number) => json({ faultstring: `Consumo redundante detectado. Aguarde ${s} segundos (REDUNDANT)` });

/** Omie falso: cada request consome UM passo do roteiro. Request além do roteiro é defeito do
 *  código sob teste (fez mais chamadas do que o cenário permite) e reprova na hora. */
function omieFalso(roteiro: Passo[], opts: { latenciaMs?: number; derivaSonoMs?: number } = {}) {
  let agora = T0;
  const chamadas: { url: string; timeoutMs: number; corpo: string; metodo: string }[] = [];
  const sonos: number[] = [];
  const deps: DepsConsulta = {
    requisitar: (url, init, timeoutMs) => {
      chamadas.push({ url, timeoutMs, corpo: String(init.body), metodo: String(init.method) });
      agora += opts.latenciaMs ?? 0;
      const passo = roteiro.shift();
      if (!passo) return Promise.reject(new Error("ROTEIRO_ESGOTADO: request além do previsto"));
      if ("lancar" in passo) return Promise.reject(new Error(passo.lancar));
      return Promise.resolve(new Response(passo.corpo, { status: passo.status }));
    },
    agora: () => agora,
    dormir: (ms) => {
      sonos.push(ms);
      agora += ms + (opts.derivaSonoMs ?? 0);
      return Promise.resolve();
    },
  };
  return { deps, chamadas, sonos };
}

async function rodar(roteiro: Passo[], deadline: number, opts: { latenciaMs?: number; derivaSonoMs?: number } = {}) {
  const o = omieFalso(roteiro, opts);
  const contador = { requisicoes: 0 };
  const r: ResultadoConsulta = await consultarNfe(o.deps, CRED, 4242, deadline, contador);
  return { r, contador, ...o };
}

Deno.test("INCIDENTE: REDUNDANT pedindo 51s num run de 50s → ADIADA, 1 request, sem dormir, sem exceção", async () => {
  const { r, contador, sonos, chamadas } = await rodar([{ status: 200, corpo: redundant(51) }], T0 + 50_000);
  assertEquals(r.tipo, "adiada", "era aqui que o callOmie lançava e o catch punia a NFe com backoff");
  if (r.tipo !== "adiada") throw new Error("inalcançável");
  assertEquals(r.adiamento.motivo, "limite_nao_cabe_no_deadline");
  assertEquals(r.adiamento.esperaMs, 54_000);
  assertEquals(contador.requisicoes, 1);
  assertEquals(sonos, [], "dormir 54s num run de 50s é sono que nunca acorda");
  assertEquals(chamadas[0].url, OMIE_ENDPOINT_RECEBIMENTO);
});

Deno.test("o request é POST no endpoint de recebimento, com a chamada, o nIdReceb e o teto de relógio", async () => {
  const { chamadas } = await rodar([{ status: 200, corpo: json({ itensRecebimento: [] }) }], T0 + 50_000);
  assertEquals(chamadas.length, 1);
  assertEquals(chamadas[0].metodo, "POST");
  const corpo = JSON.parse(chamadas[0].corpo);
  assertEquals(corpo.call, "ConsultarRecebimento");
  assertEquals(corpo.param, [{ nIdReceb: 4242 }]);
  assertEquals(chamadas[0].timeoutMs, 20_000, "com tempo de sobra, vale o teto por request (#2017)");
});

Deno.test("o teto do request ENCOLHE com o deadline do run", async () => {
  const { chamadas } = await rodar([{ status: 200, corpo: json({ itensRecebimento: [] }) }], T0 + 12_000);
  assertEquals(chamadas[0].timeoutMs, 12_000);
});

Deno.test("limite curto que PERSISTE: dorme entre as tentativas e ADIA na 3ª sem dormir depois", async () => {
  const { r, contador, sonos } = await rodar(
    [{ status: 200, corpo: redundant(1) }, { status: 200, corpo: redundant(1) }, { status: 200, corpo: redundant(1) }],
    T0 + 50_000,
  );
  assertEquals(r.tipo, "adiada", "antes: throw 'rate limit após 3 tentativas' → catch → backoff");
  if (r.tipo !== "adiada") throw new Error("inalcançável");
  assertEquals(r.adiamento.motivo, "limite_persistiu_apos_retentativas");
  assertEquals(contador.requisicoes, 3);
  assertEquals(sonos, [4_000, 4_000], "não há 3º sono: depois da última tentativa não vem request");
});

Deno.test("429 que cede: espera o padrão, retenta e devolve a resposta", async () => {
  const { r, contador, sonos } = await rodar(
    [{ status: 429, corpo: "" }, { status: 200, corpo: json({ itensRecebimento: [{ itensCabec: { nIdProduto: 7 } }] }) }],
    T0 + 50_000,
  );
  assertEquals(r.tipo, "respondida");
  if (r.tipo !== "respondida") throw new Error("inalcançável");
  assertEquals(r.detalhe.itensRecebimento?.length, 1);
  assertEquals(contador.requisicoes, 2);
  assertEquals(sonos, [5_000]);
});

Deno.test("'Já existe uma requisição desse método' é LIMITE, não resposta", async () => {
  const { r, sonos } = await rodar(
    [
      { status: 200, corpo: json({ faultstring: "Já existe uma requisição desse método em andamento" }) },
      { status: 200, corpo: json({ itensRecebimento: [] }) },
    ],
    T0 + 50_000,
  );
  assertEquals(r.tipo, "respondida");
  assertEquals(sonos, [5_000], "antes da fatia esta mensagem virava resposta detalhada e backoff");
});

Deno.test("deadline antes do 1º request → ADIADA sem request nenhum", async () => {
  const { r, contador, chamadas } = await rodar([], T0 + MIN_REQUEST_MS - 1);
  assertEquals(r.tipo, "adiada");
  if (r.tipo !== "adiada") throw new Error("inalcançável");
  assertEquals(r.adiamento.motivo, "deadline_antes_da_chamada");
  assertEquals(contador.requisicoes, 0, "nada saiu para a Omie — conta zero requests");
  assertEquals(chamadas.length, 0);
});

Deno.test("deadline vencido ANTES da retentativa (sono com deriva) → ADIADA depois de 1 request", async () => {
  // cabeEspera(T0, T0+7000, 4000) aprova o sono; a deriva de 1,5s do timer come a margem e a
  // retentativa não tem mais o mínimo viável — tem de adiar, não chamar com o que sobrou.
  const { r, contador, sonos } = await rodar([{ status: 200, corpo: redundant(1) }], T0 + 7_000, { derivaSonoMs: 1_500 });
  assertEquals(r.tipo, "adiada");
  if (r.tipo !== "adiada") throw new Error("inalcançável");
  assertEquals(r.adiamento.motivo, "deadline_antes_da_chamada");
  assertEquals(contador.requisicoes, 1);
  assertEquals(sonos, [4_000]);
});

Deno.test("HTTP 500 sem faultstring de limite → FALHOU (marca tentativa), com o status na mensagem", async () => {
  // O corpo é JSON VÁLIDO de propósito — a Omie responde fault SOAP em 500 com JSON. Com corpo HTML
  // o caso passava pela checagem de "não é objeto JSON" e o `if (!res.ok)` ficava INALCANÇADO:
  // a falsificação tirou a checagem de status e este teste seguiu verde (2026-09-24).
  const { r } = await rodar([{ status: 500, corpo: json({ faultstring: "SOAP-ERROR: Broken response" }) }], T0 + 50_000);
  assertEquals(r.tipo, "falhou", "5xx com JSON não pode virar resposta com 'fault:' e contar como consulta OK");
  if (r.tipo !== "falhou") throw new Error("inalcançável");
  if (!r.mensagem.includes("ConsultarRecebimento HTTP 500")) throw new Error(`a mensagem perdeu o status: ${r.mensagem}`);
});

Deno.test("HTTP 500 com corpo HTML → FALHOU também (as duas camadas recusam; o status fala primeiro)", async () => {
  const { r } = await rodar([{ status: 500, corpo: "<html>erro interno</html>" }], T0 + 50_000);
  assertEquals(r.tipo, "falhou");
  if (r.tipo !== "falhou") throw new Error("inalcançável");
  if (!r.mensagem.includes("ConsultarRecebimento HTTP 500")) throw new Error(`a mensagem perdeu o status: ${r.mensagem}`);
});

Deno.test("HTTP 500 COM faultstring REDUNDANT → é LIMITE (a faultstring vence o status)", async () => {
  const { r } = await rodar([{ status: 500, corpo: redundant(51) }], T0 + 50_000);
  assertEquals(r.tipo, "adiada");
});

Deno.test("2xx cujo corpo não é objeto JSON → FALHOU, nunca 'resposta sem itens' (ausente ≠ zero)", async () => {
  for (const corpo of ["<html>manutencao</html>", "[1,2]", "null", ""]) {
    const { r } = await rodar([{ status: 200, corpo }], T0 + 50_000);
    assertEquals(r.tipo, "falhou", `corpo ${JSON.stringify(corpo)} virou ${r.tipo}`);
    if (r.tipo !== "falhou") throw new Error("inalcançável");
    if (!r.mensagem.includes("objeto JSON")) throw new Error(`mensagem sem o diagnóstico: ${r.mensagem}`);
  }
});

Deno.test("socket abortado / request que lança → FALHOU, e o request conta", async () => {
  const { r, contador } = await rodar([{ lancar: "The signal has been aborted" }], T0 + 50_000);
  assertEquals(r.tipo, "falhou");
  if (r.tipo !== "falhou") throw new Error("inalcançável");
  if (!r.mensagem.includes("aborted")) throw new Error(`mensagem perdida: ${r.mensagem}`);
  assertEquals(contador.requisicoes, 1);
});

Deno.test("um Error com o TEXTO do adiamento continua FALHOU — o contrato é a marca, não a frase", async () => {
  const { r } = await rodar(
    [{ lancar: "Omie ConsultarRecebimento: limite pede 54s de espera, não cabe antes do deadline do run" }],
    T0 + 50_000,
  );
  assertEquals(r.tipo, "falhou");
});

Deno.test("fault de NEGÓCIO em 2xx → RESPONDIDA (a NFe sai por backoff com o motivo fault)", async () => {
  const { r } = await rodar([{ status: 200, corpo: json({ faultstring: "Recebimento não encontrado" }) }], T0 + 50_000);
  assertEquals(r.tipo, "respondida");
  if (r.tipo !== "respondida") throw new Error("inalcançável");
  assertEquals(r.detalhe.faultstring, "Recebimento não encontrado");
});
