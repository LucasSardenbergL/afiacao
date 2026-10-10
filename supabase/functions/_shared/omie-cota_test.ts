// Roda com: deno test --no-remote supabase/functions/_shared/omie-cota_test.ts
import {
  classificarFaultCota,
  clienteCotaDoAmbiente,
  type ClienteCota,
  comVezOmie,
  CotaOmieIndisponivel,
  esperaAte,
  lerVez,
  obterVez,
} from "./omie-cota.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

/** Banco falso: responde `omie_cota_tentar` a partir de uma fila de respostas e grava as chamadas. */
function bancoFalso(respostasTentar: unknown[], erro: string | null = null) {
  const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db: ClienteCota = {
    rpc(fn, args) {
      chamadas.push({ fn, args });
      if (erro) return Promise.resolve({ data: null, error: { message: erro } });
      if (fn === "omie_cota_tentar") return Promise.resolve({ data: respostasTentar.shift() ?? null, error: null });
      return Promise.resolve({ data: true, error: null });
    },
  };
  return { db, chamadas };
}

const LIVRE = [{ ok: true, motivo: "livre", ate: "2026-10-10T12:00:00Z" }];

Deno.test("classificarFaultCota: REDUNDANT com prazo usa o prazo do Omie + margem", () => {
  assertEquals(
    classificarFaultCota("Consumo redundante detectado. Aguarde 47 segundos (REDUNDANT)"),
    { tipo: "redundante", segundos: 49 },
  );
});

Deno.test("classificarFaultCota: REDUNDANT sem prazo legível assume 60 s (nunca chamar cedo)", () => {
  assertEquals(classificarFaultCota("SOAP-ERROR: REDUNDANT"), { tipo: "redundante", segundos: 62 });
});

Deno.test("classificarFaultCota: bloqueio por consumo indevido lê minutos ou cai em 30 min", () => {
  assertEquals(
    classificarFaultCota("API bloqueada por consumo indevido. Tente novamente em 12 minutos."),
    { tipo: "bloqueio", segundos: 12 * 60 + 2 },
  );
  assertEquals(classificarFaultCota("API bloqueada por consumo indevido."), { tipo: "bloqueio", segundos: 1802 });
});

Deno.test("classificarFaultCota: concorrência e erros alheios", () => {
  assertEquals(
    classificarFaultCota("Já existe uma requisição desse método sendo executada"),
    { tipo: "concorrente" },
  );
  assertEquals(classificarFaultCota("Não existem registros para a página [2]!"), null);
  assertEquals(classificarFaultCota("SOAP-ERROR: Broken response"), null);
});

Deno.test("lerVez: as três respostas da RPC e a forma inesperada", () => {
  assertEquals(lerVez(LIVRE), { tipo: "livre" });
  assertEquals(lerVez([{ ok: false, motivo: "bloqueado", ate: "X" }]), { tipo: "bloqueado", ate: "X" });
  assertEquals(lerVez([{ ok: false, motivo: "ocupado", ate: null }]), { tipo: "ocupado", ate: null });
  assertEquals(lerVez([]).tipo, "sem_trava");
  assertEquals(lerVez([{ ok: true, motivo: "bloqueado" }]).tipo, "sem_trava");
});

Deno.test("esperaAte: prazo curto espera o prazo inteiro; prazo longo desiste", () => {
  const agora = Date.parse("2026-10-10T12:00:00Z");
  assertEquals(esperaAte("2026-10-10T12:00:05Z", agora, 20_000), 5_250);
  assertEquals(esperaAte("2026-10-10T12:00:30Z", agora, 20_000), null);
  assertEquals(esperaAte(null, agora, 20_000), 2_000);
});

Deno.test("obterVez: 'bloqueado' longo lança SEM esperar", async () => {
  const { db } = bancoFalso([[{ ok: false, motivo: "bloqueado", ate: "2026-10-10T12:30:00Z" }]]);
  const esperas: number[] = [];
  let lancou: unknown = null;
  try {
    await obterVez(db, "oben", "ListarPedidos", {
      agora: () => Date.parse("2026-10-10T12:00:00Z"),
      esperar: (ms) => (esperas.push(ms), Promise.resolve()),
    });
  } catch (e) {
    lancou = e;
  }
  if (!(lancou instanceof CotaOmieIndisponivel) || lancou.motivo !== "bloqueado") {
    throw new Error(`esperava CotaOmieIndisponivel/bloqueado, veio ${String(lancou)}`);
  }
  assertEquals(esperas, []);
});

Deno.test("obterVez: 'ocupado' curto espera e consegue na 2ª", async () => {
  const { db, chamadas } = bancoFalso([[{ ok: false, motivo: "ocupado", ate: "2026-10-10T12:00:03Z" }], LIVRE]);
  const esperas: number[] = [];
  const token = await obterVez(db, "colacor", "ListarPedidos", {
    agora: () => Date.parse("2026-10-10T12:00:00Z"),
    esperar: (ms) => (esperas.push(ms), Promise.resolve()),
  });
  assertEquals(typeof token, "string");
  assertEquals(esperas, [3_250]);
  // o MESMO token nas duas tentativas — é ele que permite renovar o próprio lease
  assertEquals(chamadas[0].args.p_token, chamadas[1].args.p_token);
});

Deno.test("obterVez: banco fora → null (fail-open), sem lançar", async () => {
  const { db } = bancoFalso([], "connection refused");
  assertEquals(await obterVez(db, "oben", "ListarPedidos"), null);
});

Deno.test("comVezOmie: método não coordenado não toca o banco", async () => {
  const { db, chamadas } = bancoFalso([]);
  assertEquals(await comVezOmie(db, "oben", "ConsultarPedido", () => Promise.resolve(7), () => null), 7);
  assertEquals(chamadas.length, 0);
});

Deno.test("comVezOmie: REDUNDANT na resposta registra o prazo e devolve a vez", async () => {
  const { db, chamadas } = bancoFalso([LIVRE]);
  const r = await comVezOmie(
    db,
    "oben",
    "ListarPedidos",
    () => Promise.resolve({ faultstring: "Consumo redundante detectado. Aguarde 20 segundos (REDUNDANT)" }),
    (x) => x.faultstring,
  );
  assertEquals(r.faultstring.includes("REDUNDANT"), true);
  assertEquals(chamadas.map((c) => c.fn), ["omie_cota_tentar", "omie_cota_registrar_fault", "omie_cota_liberar"]);
  assertEquals(chamadas[1].args.p_bloqueio_segundos, 22);
});

Deno.test("comVezOmie: fault no erro lançado registra, devolve a vez e RE-LANÇA o mesmo erro", async () => {
  const { db, chamadas } = bancoFalso([LIVRE]);
  const original = new Error("Omie (oben): API bloqueada por consumo indevido.");
  let lancou: unknown = null;
  try {
    await comVezOmie(db, "oben", "ListarPedidos", () => Promise.reject(original), () => null);
  } catch (e) {
    lancou = e;
  }
  if (lancou !== original) throw new Error(`esperava o MESMO erro re-lançado, veio ${String(lancou)}`);
  assertEquals(chamadas.map((c) => c.fn), ["omie_cota_tentar", "omie_cota_registrar_fault", "omie_cota_liberar"]);
  assertEquals(chamadas[1].args.p_bloqueio_segundos, 1802);
});

Deno.test("comVezOmie: concorrência não registra prazo (o Omie não deu um)", async () => {
  const { db, chamadas } = bancoFalso([LIVRE]);
  await comVezOmie(
    db,
    "oben",
    "ListarPedidos",
    () => Promise.resolve("Já existe uma requisição desse método sendo executada"),
    (x) => x,
  );
  assertEquals(chamadas.map((c) => c.fn), ["omie_cota_tentar", "omie_cota_liberar"]);
});

Deno.test("comVezOmie: banco fora segue para o Omie (fail-open) e não tenta liberar", async () => {
  const { db, chamadas } = bancoFalso([], "timeout");
  let chamou = false;
  await comVezOmie(db, "oben", "ListarPedidos", () => (chamou = true, Promise.resolve(null)), () => null);
  assertEquals(chamou, true);
  assertEquals(chamadas.map((c) => c.fn), ["omie_cota_tentar"]);
});

Deno.test("clienteCotaDoAmbiente: sem env → null; com env cria UMA vez", () => {
  let criados = 0;
  const criar = () => (criados++, { rpc: () => Promise.resolve({ data: null, error: null }) });
  assertEquals(clienteCotaDoAmbiente(criar, () => undefined)(), null);
  const obter = clienteCotaDoAmbiente(criar, (k) => (k === "SUPABASE_URL" ? "http://x" : "chave"));
  obter();
  obter();
  assertEquals(criados, 1);
});
