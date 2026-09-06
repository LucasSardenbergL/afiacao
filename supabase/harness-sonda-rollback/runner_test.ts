// O runner é o instrumento: se ele não enxergar uma forma de efeito, todo veredito "zero" que ele
// produzir é cegueira. Estes sintéticos são o CONTROLE do instrumento — seis formas que ele tem de
// reprovar, e três que ele NÃO pode reprovar (senão reprova bundle seguro e a allowlist trava).
import { gerarImportMap } from "./mapa-imports.ts";

const RAIZ = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const CHAVE = "u".repeat(44);

type Chamada = { status: number; probe: boolean; efeitos: number; fetches: number; corpoHash: string; quiesceu: boolean };
type Veredito = {
  importErro: string | null;
  efeitosNoImport: number;
  handler: boolean;
  a: Chamada;
  b: Array<Chamada & { nome: string }>;
  c: { classe: string; efeitos: number; fetches: number; degrau: string | null };
};

async function correr(nome: string): Promise<Veredito> {
  const mapa = gerarImportMap(["npm:@supabase/supabase-js@2"], `file://${RAIZ}/stubs`);
  const mapaPath = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(mapaPath, JSON.stringify(mapa));
  const controles = JSON.stringify([{
    metodo: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": "$CRON_SECRET" },
    corpo: "{}",
    nota: "controle padrão do sintético",
  }]);
  const cmd = new Deno.Command("deno", {
    args: [
      "run", "--no-remote", `--import-map=${mapaPath}`, `--allow-read=${RAIZ}`,
      `${RAIZ}/runner.ts`, `${RAIZ}/sinteticos/${nome}/index.ts`, nome, CHAVE, controles,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const o = await cmd.output();
  await Deno.remove(mapaPath);
  const linhas = new TextDecoder().decode(o.stdout).trim().split("\n").filter((l) => l.startsWith("{"));
  if (linhas.length === 0) {
    throw new Error(`${nome}: runner sem veredito — ${new TextDecoder().decode(o.stderr).slice(0, 300)}`);
  }
  return JSON.parse(linhas[linhas.length - 1]);
}

/** Inerte = o que o cron faria contra este bundle não produziu efeito NENHUM, nem depois de drenar. */
function inerte(v: Veredito): boolean {
  if (v.efeitosNoImport > 0 || v.importErro !== null || !v.handler) return false;
  if (v.a.efeitos > 0 || v.a.fetches > 0 || !v.a.quiesceu || v.a.probe) return false;
  return v.b.every((x) =>
    x.efeitos === 0 && x.fetches === 0 && x.quiesceu &&
    x.corpoHash === v.b[0].corpoHash && x.status === v.b[0].status
  );
}

Deno.test("runner: as 6 formas perigosas do OPTIONS são REPROVADAS", async () => {
  const perigosas = [
    "io-top-level",
    "io-antes-do-metodo",
    "helper-no-ramo",
    "fallthrough",
    "assincrono-antes-do-return",
    "header-qualquer",
  ];
  for (const nome of perigosas) {
    const v = await correr(nome);
    if (inerte(v)) {
      throw new Error(
        `${nome}: tinha de REPROVAR e passou — o runner não enxerga esta forma de efeito ` +
          `(a=${JSON.stringify(v.a)}, import=${v.efeitosNoImport})`,
      );
    }
  }
});

Deno.test("runner: as 3 formas inofensivas ao OPTIONS PASSAM, com controle positivo", async () => {
  for (const nome of ["gate-ignorado", "ramo-morto", "padrao"]) {
    const v = await correr(nome);
    if (!inerte(v)) {
      throw new Error(`${nome}: é seguro ao OPTIONS e o runner reprovou — a=${JSON.stringify(v.a)}`);
    }
    if (v.c.classe === "inconclusivo") {
      throw new Error(`${nome}: controle positivo inconclusivo — o contador não vê o fluxo real deste bundle`);
    }
  }
});

Deno.test("runner: o sintético SEM gate é classificado como sem-gate (o POST cru executa)", async () => {
  const v = await correr("gate-ignorado");
  if (v.c.classe !== "sem-gate") {
    throw new Error(`gate-ignorado: esperava classe sem-gate (o POST cru executa), veio ${v.c.classe}`);
  }
});
