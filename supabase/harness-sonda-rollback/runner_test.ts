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

Deno.test("runner: handler que ESPERA um timer antes do IO tem o controle visto, não pendura", async () => {
  // Antes do relógio andar durante o handler, este sintético deixava o laço de eventos vazio com a
  // resposta pendente e o runner morria sem veredito. Agora o OPTIONS segue inerte e o controle
  // positivo alcança o select depois da espera.
  const v = await correr("espera-no-handler");
  if (!inerte(v)) {
    throw new Error(`espera-no-handler: é seguro ao OPTIONS e o runner reprovou — a=${JSON.stringify(v.a)}`);
  }
  if (v.c.classe === "inconclusivo" || v.c.efeitos === 0) {
    throw new Error(`espera-no-handler: o controle não enxergou o select depois da espera — c=${JSON.stringify(v.c)}`);
  }
});

Deno.test("runner: timer CONDICIONAL agendado no OPTIONS segue contado (timers reais só no controle)", async () => {
  // Contraexemplo do challenge Codex: antecipar o timer durante o handler suprimiria o insert e o
  // OPTIONS sairia inerte. Com o relógio restrito ao controle, o efeito pós-return é drenado e contado.
  // Mira a chamada (a) — o OPTIONS do relé — e não o veredito inteiro: os negativos (b) também
  // pegariam este IO e mascarariam uma regressão que tirasse a contagem só de (a).
  const v = await correr("timer-condicional-no-options");
  if (v.a.efeitos === 0) {
    throw new Error(`timer-condicional-no-options: o OPTIONS do relé executa IO e (a) contou zero — a=${JSON.stringify(v.a)}`);
  }
  if (inerte(v)) {
    throw new Error(`timer-condicional-no-options: o OPTIONS executa IO e o runner o deu como inerte`);
  }
});

Deno.test("runner: no controle, a ordem dos timers é a nativa (não registra chamada inexistente)", async () => {
  const v = await correr("controle-ordem-dos-timers");
  if (v.c.efeitos !== 0 || v.c.fetches !== 0) {
    throw new Error(`controle-ordem-dos-timers: o controle fabricou efeito que a ordem real dos timers não produz — c=${JSON.stringify(v.c)}`);
  }
});

Deno.test("runner: no controle, Date.now, performance.now e new Date() medem a espera real", async () => {
  const v = await correr("controle-relogio-observavel");
  if (v.c.efeitos !== 0 || v.c.fetches !== 0) {
    throw new Error(`controle-relogio-observavel: o controle fabricou efeito pelo relógio real — c=${JSON.stringify(v.c)}`);
  }
});

Deno.test("runner: relógios e timers CAPTURADOS no import seguem nativos no controle", async () => {
  const v = await correr("controle-relogio-capturado");
  if (v.c.efeitos !== 0 || v.c.fetches !== 0) {
    throw new Error(`controle-relogio-capturado: o controle fabricou efeito por um relógio capturado no import — c=${JSON.stringify(v.c)}`);
  }
});

Deno.test("runner: Date() sem new, instanceof e estáticos seguem nativos no preflight", async () => {
  const v = await correr("date-sem-new-no-options");
  if (v.a.status !== 204) {
    throw new Error(`date-sem-new-no-options: o preflight que só usa Date() saiu ${v.a.status} — o substituto mudou a semântica do Date`);
  }
  if (!inerte(v)) throw new Error(`date-sem-new-no-options: bundle inofensivo ao OPTIONS reprovado — a=${JSON.stringify(v.a)}`);
});

Deno.test("runner: no controle, timer nativo não vence uma operação nativa que termina antes", async () => {
  const v = await correr("controle-corrida-nativa");
  if (v.c.efeitos !== 0 || v.c.fetches !== 0) {
    throw new Error(`controle-corrida-nativa: o controle registrou uma chamada que a execução real não faz — c=${JSON.stringify(v.c)}`);
  }
});

Deno.test("runner: IO agendado no OPTIONS para depois do teto de espera segue contado em (a)", async () => {
  const v = await correr("options-timer-longo");
  if (v.a.efeitos === 0) {
    throw new Error(`options-timer-longo: o OPTIONS agenda IO e (a) contou zero — a=${JSON.stringify(v.a)}`);
  }
});

Deno.test("runner: a fila de (a)/(b) chama o callback SEM os argumentos extras, como antes", async () => {
  const v = await correr("options-timeout-com-args");
  if (v.a.fetches !== 0 || v.a.efeitos !== 0) {
    throw new Error(`options-timeout-com-args: a fila de (a) mudou de comportamento — a=${JSON.stringify(v.a)}`);
  }
});

Deno.test("runner: no controle, setInterval é periódico de verdade (watchdog não registra chamada)", async () => {
  const v = await correr("controle-intervalo-watchdog");
  if (v.c.efeitos !== 0 || v.c.fetches !== 0) {
    throw new Error(`controle-intervalo-watchdog: o controle registrou uma chamada que o intervalo nativo impediria — c=${JSON.stringify(v.c)}`);
  }
});

Deno.test("runner: no controle, clearTimeout cancela intervalo e clearInterval cancela timeout", async () => {
  const v = await correr("controle-cancelamento-cruzado");
  if (v.c.efeitos !== 0 || v.c.fetches !== 0) {
    throw new Error(`controle-cancelamento-cruzado: timer cancelado de forma cruzada ainda disparou — c=${JSON.stringify(v.c)}`);
  }
});

Deno.test("runner: no controle, tarefa de fundo (waitUntil) roda com timers nativos até assentar", async () => {
  const v = await correr("controle-waituntil-watchdog");
  if (v.c.efeitos !== 0 || v.c.fetches !== 0) {
    throw new Error(`controle-waituntil-watchdog: alerta cancelado na tarefa de fundo ainda disparou — c=${JSON.stringify(v.c)}`);
  }
});

Deno.test("runner: o sintético SEM gate é classificado como sem-gate (o POST cru executa)", async () => {
  const v = await correr("gate-ignorado");
  if (v.c.classe !== "sem-gate") {
    throw new Error(`gate-ignorado: esperava classe sem-gate (o POST cru executa), veio ${v.c.classe}`);
  }
});
