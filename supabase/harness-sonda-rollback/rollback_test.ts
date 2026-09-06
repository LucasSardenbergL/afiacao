// ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
// ║  O TESTE DECISIVO: "a edge respondeu sonda, sofre ROLLBACK para bundle velho, e o contador    ║
// ║  de efeito real fica em ZERO."                                                                ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
//
// Não é leitura de código: cada bundle sai do git (`git archive <sha>`), roda de verdade com o
// `OPTIONS` que o relé emite, e o efeito é CONTADO. O controle positivo do mesmo bundle prova que o
// contador enxerga o fluxo real — sem ele, "zero" seria cegueira.
//
// Os dois primeiros shas são os contraexemplos que derrubaram o desenho anterior (credencial num
// header de POST): bundles que NÃO AUTENTICAM NADA. Neles, o POST cru executa o fluxo real —
// `monthly-report@ef08dddd2` chega ao Resend — e o `OPTIONS` não faz nada. É essa assimetria que o
// mecanismo inteiro compra.
import { executarRunner, materializar, type Veredito } from "./materializar.ts";
import { derivarCredencial, HEADER_SONDA } from "../functions/_shared/sonda-cron.ts";
import { SONDA_CRON_ALVOS } from "../functions/_shared/sonda-cron-alvos.ts";

const RAIZ = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const REPO = RAIZ.replace(/\/supabase\/harness-sonda-rollback$/, "");
const CHAVE = "u".repeat(44);

function assert(c: unknown, m: string): void {
  if (!c) throw new Error(m);
}

function controlesDe(edge: string) {
  const a = SONDA_CRON_ALVOS.find((x) => x.edge === edge);
  assert(a, `${edge} não está na allowlist — o teste mediria uma edge que o cron nunca sonda`);
  return a!.controles;
}

/** O que o cron faz contra este bundle não pode produzir efeito, nem depois de drenar o relógio. */
function exigirInerte(v: Veredito, rotulo: string): void {
  assert(v.importErro === null && v.handler, `${rotulo}: closure INVERIFICAVEL (${v.importErro ?? "sem handler"})`);
  assert(v.efeitosNoImport === 0, `${rotulo}: IO no import do módulo (${v.efeitosNoImport} efeito(s))`);
  assert(
    v.a.status >= 200 && v.a.status < 300 && v.a.efeitos === 0 && v.a.fetches === 0 && v.a.quiesceu,
    `${rotulo}: (a) o OPTIONS do relé produziu efeito, fetch, status fora de 2xx ou não quiesceu: ${JSON.stringify(v.a)}`,
  );
  for (const b of v.b) {
    assert(
      b.efeitos === 0 && b.fetches === 0 && b.quiesceu,
      `${rotulo}: negativo ${b.nome} produziu efeito: ${JSON.stringify(b)}`,
    );
    assert(
      b.corpoHash === v.b[0].corpoHash && b.status === v.b[0].status,
      `${rotulo}: negativo ${b.nome} respondeu DIFERENTE do preflight do browser — credencial inválida não pode mudar o CORS`,
    );
  }
}

const VELHAS: Array<{ edge: string; sha: string; rotulo: string; semGate?: boolean }> = [
  { edge: "monthly-report", sha: "ef08dddd2", rotulo: "SEM gate (2026-02) — manda e-mail para qualquer POST", semGate: true },
  { edge: "monthly-report", sha: "81f9a111c", rotulo: "pré-sensor com gate" },
  { edge: "monthly-report", sha: "0ed5a9b31", rotulo: "intermediário: classifica probe, mas não conhece a credencial" },
  { edge: "calculate-scores", sha: "45a80118b", rotulo: "SEM gate (2026-03) — 11 escritas para qualquer POST", semGate: true },
  { edge: "calculate-scores", sha: "d33c83836", rotulo: "pré-sensor com gate" },
];

Deno.test("ROLLBACK: bundles velhos REAIS ficam em ZERO efeito ao OPTIONS do relé — e o controle positivo vê o fluxo real", async () => {
  for (const { edge, sha, rotulo, semGate } of VELHAS) {
    const m = await materializar(sha, edge, REPO);
    try {
      assert(
        m.desconhecidos.length === 0,
        `${edge}@${sha}: especificador fora do catálogo de stubs: ${m.desconhecidos.join(",")} — closure INVERIFICAVEL`,
      );
      const v = await executarRunner(m.indexPath, m.mapaPath, edge, CHAVE, controlesDe(edge), `${RAIZ},${m.dir}`);
      exigirInerte(v, `${edge}@${sha} (${rotulo})`);
      assert(!v.a.probe, `${edge}@${sha}: respondeu probe:true sem ter o ramo — bundle velho não pode atestar`);
      assert(
        v.c.classe !== "inconclusivo",
        `${edge}@${sha}: controle positivo INCONCLUSIVO — o contador não vê o fluxo real deste bundle, então o zero de (a) não vale nada. Tentativas: ${JSON.stringify(v.tentativasControle)}`,
      );
      if (semGate) {
        assert(
          v.c.classe === "sem-gate",
          `${edge}@${sha}: era para o POST CRU executar o fluxo real (classe sem-gate) — veio ${v.c.classe}. É este bundle que torna insuficiente qualquer credencial em header de POST.`,
        );
      }
    } finally {
      await Deno.remove(m.dir, { recursive: true });
    }
  }
});

Deno.test("ATUAL: o OPTIONS do relé atesta com contrato completo; credencial inválida devolve o CORS de hoje", async () => {
  for (const { edge } of SONDA_CRON_ALVOS) {
    const v = await executarRunner(
      `${REPO}/supabase/functions/${edge}/index.ts`,
      `${RAIZ}/import_map.json`,
      edge,
      CHAVE,
      controlesDe(edge),
      `${RAIZ},${REPO}/supabase/functions`,
    );
    assert(v.importErro === null && v.handler, `${edge}: import falhou — ${v.importErro}`);
    assert(v.efeitosNoImport === 0, `${edge}: IO no import`);
    assert(
      v.a.status === 200 && v.a.probe && v.a.efeitos === 0 && v.a.fetches === 0,
      `${edge}: o bundle ATUAL tinha de atestar sem efeito: ${JSON.stringify(v.a)}`,
    );
    for (const b of v.b) {
      assert(
        b.efeitos === 0 && !b.probe && b.corpoHash === v.b[0].corpoHash && b.status === v.b[0].status,
        `${edge}: negativo ${b.nome} — tinha de ser byte a byte o CORS de hoje, veio ${JSON.stringify(b)}`,
      );
    }
  }
});

Deno.test("RELÉ: o POST operacional emite exatamente UM fetch, e ele é o OPTIONS na alvo", async () => {
  const v = await executarRunner(
    `${REPO}/supabase/functions/sonda-relay/index.ts`,
    `${RAIZ}/import_map.json`,
    "sonda-relay",
    CHAVE,
    controlesDe("sonda-relay"),
    `${RAIZ},${REPO}/supabase/functions`,
  );
  assert(v.c.classe === "controle", `relé: o POST do cron tinha de produzir o fetch de saída, veio ${v.c.classe}`);
  assert(
    v.c.fetches === 1 && v.c.efeitos === 0,
    `relé: esperava 1 fetch e 0 efeitos de banco, veio ${JSON.stringify(v.c)}`,
  );
  assert(
    v.fetchUrls[0] === "OPTIONS http://projeto.local/functions/v1/monthly-report",
    `relé: o request de saída não é o OPTIONS na alvo: ${v.fetchUrls[0]}`,
  );
});

Deno.test("paridade HMAC: os vetores congelados batem com a implementação", async () => {
  assert(HEADER_SONDA === "x-sonda-credencial", "o nome do header mudou — a migration (F2) e o relé divergiriam");
  assert(
    (await derivarCredencial("Jefe", "monthly-report")) === "04855b66e0237a22cb2039fa2859d597b90adf29ee61ce9cd2f3d03c37e7ce42",
    "vetor de monthly-report divergiu",
  );
});
