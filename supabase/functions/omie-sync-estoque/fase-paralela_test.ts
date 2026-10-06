import { dispararFase } from "./fase-paralela.ts";

function confere(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Captura a rejeição sem `assertRejects` pelado: o caller compara a IDENTIDADE do erro, não "lançou algo".
async function rejeicaoDe(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("esperava rejeição e a promise resolveu");
}

const dorme = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

Deno.test("falha CEDO aguardada TARDE não vira rejeição sem handler, e o erro volta intacto", async () => {
  // O caso do run: a fase do PO pode falhar nos primeiros segundos enquanto o laço do físico ainda roda;
  // o handler só a aguarda depois. Sem a captura na criação, o Deno trata a rejeição como não tratada.
  const erro = new Error("PesquisarPedCompra fault: x");
  const fase = dispararFase(() => Promise.reject(erro));
  await dorme(20); // vários ticks de macrotask com a rejeição já assentada e ninguém aguardando
  const recebido = await rejeicaoDe(fase.resultado());
  confere(recebido === erro, "resultado() tem de relançar a MESMA referência do erro da fase");
});

Deno.test("fase que falha e NUNCA é aguardada (o físico lançou antes) não derruba o isolate", async () => {
  dispararFase(() => Promise.reject(new Error("PesquisarPedCompra: deadline do run atingido antes da chamada")));
  await dorme(20);
});

Deno.test("falhaJaConhecida(): null enquanto roda, o erro logo depois da falha — o gancho do aborto cedo", async () => {
  let rejeitar: (e: unknown) => void = () => {};
  const erro = new Error("em_transito query: timeout");
  const fase = dispararFase(() => new Promise<number>((_, rej) => { rejeitar = rej; }));
  confere(fase.falhaJaConhecida() === null, "fase em voo não pode reportar falha");
  confere(fase.duracaoMs() === null, "fase em voo não tem duração");
  rejeitar(erro);
  await dorme(0);
  const falha = fase.falhaJaConhecida();
  confere(falha !== null && falha.erro === erro, "depois da rejeição, falhaJaConhecida() devolve o MESMO erro");
});

Deno.test("sucesso: resultado() devolve o valor, sem falha, duração no relógio injetado", async () => {
  let agora = 1_000;
  const fase = dispararFase(async () => {
    await dorme(0);
    agora = 4_250;
    return 26;
  }, () => agora);
  confere((await fase.resultado()) === 26, "valor da fase");
  confere(fase.falhaJaConhecida() === null, "fase bem-sucedida não reporta falha");
  confere(fase.duracaoMs() === 3_250, `duração = fim − disparo no relógio injetado (veio ${fase.duracaoMs()})`);
});

Deno.test("a fase começa NO disparo (não num tick depois) e throw síncrono vira falha da fase", async () => {
  let comecou = false;
  const ok = dispararFase(() => {
    comecou = true;
    return Promise.resolve("ok");
  });
  confere(comecou, "fn tem de ser chamada de forma síncrona dentro de dispararFase");
  confere((await ok.resultado()) === "ok", "valor");

  const erro = new Error("sku_parametros: fora do ar");
  const sinc = dispararFase((): Promise<string> => {
    throw erro;
  });
  confere((await rejeicaoDe(sinc.resultado())) === erro, "throw síncrono dentro de fn é relançado em resultado()");
  confere(sinc.falhaJaConhecida()?.erro === erro, "e aparece em falhaJaConhecida()");
});
