// INVERIFICAVEL (continua BARRANDO): o arquivo PARSEIA perfeitamente; o que falha é resolver o
// módulo, porque o harness não tem stub para ele. Isso é falha da MATERIALIZAÇÃO, não do bundle:
// em produção este import resolveria e a função bootaria normalmente.
//
// É o contraexemplo que separa `NAO_COMPILA` de uma porta dos fundos. Se a classe nova passar a
// aceitar erro de RESOLUÇÃO, bastaria o harness perder um stub para uma edge inteira ser
// perdoada sem prova — e a asserção deste sintético fica vermelha.
import { algo } from "npm:pacote-que-nao-existe-em-lugar-nenhum@9";
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  await algo();
  return new Response(JSON.stringify({ ok: true }));
});
