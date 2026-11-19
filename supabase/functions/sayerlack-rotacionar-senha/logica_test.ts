// Asserts locais em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}
function assertNotEquals(atual: unknown, outro: unknown) {
  if (JSON.stringify(atual) === JSON.stringify(outro)) throw new Error(`nao esperava ${JSON.stringify(outro)}`);
}
function assert(cond: boolean, msg = "assert falhou") {
  if (!cond) throw new Error(msg);
}
import {
  classificarResultadoTroca,
  decidirAposTroca,
  decidirReconciliacao,
  gerarSenha,
  MAX_RECONCILIACOES,
  montarEmailSenha,
  TAMANHO_SENHA,
} from "./logica.ts";

Deno.test("gerarSenha: 16 chars, as 3 classes, sem caracteres ambíguos", () => {
  for (let i = 0; i < 200; i++) {
    const s = gerarSenha("colacor");
    assertEquals(s.length, TAMANHO_SENHA);
    assert(/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s), s);
    assert(!/[0O1lI]/.test(s), s);
  }
});

Deno.test("gerarSenha: nunca igual ao usuário (fonte forçada a repetir o usuário)", () => {
  // Fonte determinística que produz sempre o mesmo byte: a senha sai igual em toda tentativa.
  // Com usuário igual a essa saída, a função tem que desistir — nunca devolver o usuário.
  const fixa = () => 0;
  const s = gerarSenha("x", fixa);
  let lancou = "";
  try {
    gerarSenha(s, fixa);
  } catch (e) {
    lancou = (e as Error).message;
  }
  assertEquals(lancou, "GERAR_SENHA: nao consegui gerar senha diferente do usuario");
});

Deno.test("gerarSenha: duas chamadas reais diferem", () => {
  assertNotEquals(gerarSenha("colacor"), gerarSenha("colacor"));
});

Deno.test("classificarResultadoTroca: recusa SÓ com formulário na tela + termo de recusa", () => {
  assertEquals(classificarResultadoTroca({ url: "u", formularioDeTrocaVisivel: true, texto: "A senha deve ser diferente das últimas 10 senhas" }), "rejeitada");
  assertEquals(classificarResultadoTroca({ url: "u", formularioDeTrocaVisivel: true, texto: "Senha atual INCORRETA" }), "rejeitada");
  // formulário sumiu com o mesmo texto: não é recusa inequívoca
  assertEquals(classificarResultadoTroca({ url: "u", formularioDeTrocaVisivel: false, texto: "Senha atual incorreta" }), "incerta");
});

Deno.test("classificarResultadoTroca: 'sua senha expirou' na tela NÃO é recusa", () => {
  assertEquals(classificarResultadoTroca({ url: "u", formularioDeTrocaVisivel: true, texto: "Sua senha expirou. Proteja sua conta" }), "incerta");
});

Deno.test("classificarResultadoTroca: sucesso aparente e conflito", () => {
  assertEquals(classificarResultadoTroca({ url: "u", formularioDeTrocaVisivel: false, texto: "Senha alterada com sucesso" }), "aceita_aparente");
  assertEquals(classificarResultadoTroca({ url: "u", formularioDeTrocaVisivel: true, texto: "Senha alterada com sucesso" }), "incerta");
  assertEquals(classificarResultadoTroca(null), "incerta");
});

Deno.test("decidirAposTroca: rejeitada descarta; dashboard promove; o resto é ambíguo", () => {
  assertEquals(decidirAposTroca("rejeitada", null).acao, "falhar");
  assertEquals(decidirAposTroca("aceita_aparente", "dashboard").acao, "promover");
  assertEquals(decidirAposTroca("incerta", "dashboard").acao, "promover");
  assertEquals(decidirAposTroca("aceita_aparente", "erro").acao, "ambigua");
  assertEquals(decidirAposTroca("incerta", "troca_de_senha").acao, "ambigua");
  assertEquals(decidirAposTroca("incerta", null).acao, "ambigua");
});

Deno.test("decidirReconciliacao: só dashboard promove; teto pede humano", () => {
  assertEquals(decidirReconciliacao("dashboard", 1).acao, "promover");
  const r = decidirReconciliacao("erro", MAX_RECONCILIACOES);
  assertEquals(r.acao, "manter_ambigua");
  assert(r.acao === "manter_ambigua" && r.motivo.includes("adotar_env"), JSON.stringify(r));
});

Deno.test("montarEmailSenha: leva usuário, senha e pedidos", () => {
  const e = montarEmailSenha("colacor", "Abc23456defGHJk9", [4505]);
  assert(e.texto.includes("colacor") && e.texto.includes("Abc23456defGHJk9") && e.texto.includes("#4505"));
});
