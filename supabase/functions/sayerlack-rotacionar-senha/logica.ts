// Lógica pura da rotação de senha do portal Sayerlack (sem rede, sem banco) — testada em logica_test.ts.
//
// Regra-mãe (Codex challenge 2026-11-19): a candidata só é DESCARTADA com rejeição INEQUÍVOCA do portal,
// e só é PROMOVIDA com login real que chegue ao dashboard. Qualquer coisa no meio é AMBÍGUA: as duas
// senhas ficam guardadas e ninguém faz outro POST de troca.

// Sem caracteres que se confundem ao repassar a senha a outra pessoa (0/O, 1/l/I).
const MAIUSCULAS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MINUSCULAS = "abcdefghijkmnopqrstuvwxyz";
const DIGITOS = "23456789";
// Especial obrigatório: a 1ª troca real (rodada c36305cb, 2026-11-20) foi RECUSADA pelo TOTVS com senha só de
// letras+dígitos. Conjunto curto e sem aspas/barra/&/<>/espaço: nada que quebre ao digitar, colar ou repassar.
const ESPECIAIS = "@#$%*!";
const TODOS = MAIUSCULAS + MINUSCULAS + DIGITOS;
export const TAMANHO_SENHA = 16;

/** Índice uniforme em [0, n) por rejeição (sem viés de módulo). */
function indice(n: number, bytes: () => number): number {
  const limite = 256 - (256 % n);
  for (;;) {
    const b = bytes();
    if (b < limite) return b % n;
  }
}

/**
 * Senha nova: 16 chars, ≥1 maiúscula, ≥1 minúscula, ≥1 dígito, ≥1 especial, diferente do usuário (política TOTVS:
 * mínimo 8, ≠ usuário, ≠ últimas 10 — esta última é garantida pela aleatoriedade de ~94 bits).
 * `bytes` injeta a fonte aleatória (produção: crypto.getRandomValues).
 */
export function gerarSenha(usuario: string, bytes: () => number = byteSeguro): string {
  for (let tentativa = 0; tentativa < 20; tentativa++) {
    const chars: string[] = [
      MAIUSCULAS[indice(MAIUSCULAS.length, bytes)],
      MINUSCULAS[indice(MINUSCULAS.length, bytes)],
      DIGITOS[indice(DIGITOS.length, bytes)],
      ESPECIAIS[indice(ESPECIAIS.length, bytes)],
    ];
    while (chars.length < TAMANHO_SENHA) chars.push(TODOS[indice(TODOS.length, bytes)]);
    // embaralha (Fisher–Yates) para as classes obrigatórias não ficarem sempre no começo
    for (let i = chars.length - 1; i > 0; i--) {
      const j = indice(i + 1, bytes);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const s = chars.join("");
    if (s.toLowerCase() !== usuario.trim().toLowerCase()) return s;
  }
  throw new Error("GERAR_SENHA: nao consegui gerar senha diferente do usuario");
}

function byteSeguro(): number {
  const b = new Uint8Array(1);
  crypto.getRandomValues(b);
  return b[0];
}

/** O que a página mostrou DEPOIS do clique em Trocar (colhido no Browserless, sem valores de campo). */
export interface SinaisPosTroca {
  url: string;
  /** O campo "Nova senha" (#txtNewPassword) continua visível = o formulário foi re-renderizado. */
  formularioDeTrocaVisivel: boolean;
  texto: string;
}

export type ResultadoTroca = "rejeitada" | "aceita_aparente" | "incerta";

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Mensagens de recusa do formulário de troca TOTVS (política: mínimo, histórico, igual ao usuário,
// senha atual errada, confirmação divergente). Termos ASCII, caixa fixa, após normalizar acento.
const TERMOS_RECUSA = [
  "invalid", "incorret", "nao confere", "nao conferem", "nao corresponde", "diferente das ultimas",
  "ultimas 10", "minimo de", "nao pode ser igual", "deve ser diferente", "ja utilizada", "ja foi utilizada",
];
// Fora de propósito: "expirad"/"erro"/"bloquead" — a própria tela de troca pode dizer "sua senha
// expirou" ANTES do POST; tratar isso como recusa descartaria uma candidata que pode ter sido aplicada.
const TERMOS_SUCESSO = ["sucesso", "alterada", "atualizada", "trocada"];

/**
 * Classifica a resposta do portal ao POST de troca.
 *  - `rejeitada`: formulário de troca ainda na tela E mensagem de recusa ⇒ a troca NÃO aconteceu.
 *  - `aceita_aparente`: mensagem de sucesso e o formulário sumiu ⇒ ainda precisa da PROVA por login.
 *  - `incerta`: todo o resto (timeout, página desconhecida, sinais em conflito).
 * Só `rejeitada` autoriza descartar a candidata.
 */
export function classificarResultadoTroca(s: SinaisPosTroca | null): ResultadoTroca {
  if (!s) return "incerta";
  const t = normalizar(s.texto || "");
  const recusa = TERMOS_RECUSA.some((x) => t.includes(x));
  const sucesso = TERMOS_SUCESSO.some((x) => t.includes(x));
  if (s.formularioDeTrocaVisivel && recusa && !sucesso) return "rejeitada";
  if (!s.formularioDeTrocaVisivel && sucesso && !recusa) return "aceita_aparente";
  return "incerta";
}

export type TipoLogin = "dashboard" | "troca_de_senha" | "desconhecido" | "erro";

export type Decisao =
  | { acao: "promover" }
  | { acao: "falhar"; descartar: true; motivo: string }
  | { acao: "ambigua"; motivo: string };

/** Depois do POST: decide com o resultado da troca e o login de PROVA feito com a candidata. */
export function decidirAposTroca(troca: ResultadoTroca, loginCandidata: TipoLogin | null): Decisao {
  if (troca === "rejeitada") {
    return { acao: "falhar", descartar: true, motivo: "O portal recusou a troca de senha (formulario voltou com erro)" };
  }
  if (loginCandidata === "dashboard") return { acao: "promover" };
  return {
    acao: "ambigua",
    motivo: "Troca " + troca + " e o login com a senha nova deu " + String(loginCandidata) +
      ": guardei a senha atual e a candidata, e nao vou tentar outra troca sozinho",
  };
}

/** Reconciliação de rodada ambígua: só a PROVA por login com a candidata promove; teto de tentativas. */
export const MAX_RECONCILIACOES = 3;
export function decidirReconciliacao(
  loginCandidata: TipoLogin | null,
  tentativas: number,
): { acao: "promover" } | { acao: "manter_ambigua"; motivo: string } {
  if (loginCandidata === "dashboard") return { acao: "promover" };
  return {
    acao: "manter_ambigua",
    motivo: tentativas >= MAX_RECONCILIACOES
      ? "Reconciliacao esgotada (" + tentativas + " tentativas): precisa de acao humana (adotar_env)"
      : "Login com a candidata deu " + String(loginCandidata) + " (tentativa " + tentativas + " de " + MAX_RECONCILIACOES + ")",
  };
}

/** Corpo do e-mail ao founder — a senha só vai aqui, nunca em log/diagnóstico. */
export function montarEmailSenha(usuario: string, senha: string, pedidos: number[]): { assunto: string; texto: string } {
  const lista = pedidos.length > 0
    ? "Pedidos que voltaram para a fila de envio: " + pedidos.map((p) => "#" + p).join(", ") + "."
    : "Nenhum pedido estava parado por causa da senha.";
  return {
    assunto: "[Portal Sayerlack] Senha trocada automaticamente",
    texto:
      "A senha do portal Sayerlack expirou e foi trocada automaticamente.\n\n" +
      "Usuario: " + usuario + "\n" +
      "Senha nova: " + senha + "\n\n" +
      "Ela ja foi confirmada com um login real no portal e as integracoes ja estao usando-a. " +
      "Se for repassar, use um canal seguro e apague este e-mail depois.\n\n" + lista + "\n",
  };
}

/**
 * Texto da tela pós-troca para diagnóstico (alerta + log da rodada), SEM as senhas: toda ocorrência de
 * cada segredo vira `[senha]`, espaços são colapsados e o resultado é cortado. A 1ª recusa real
 * (rodada c36305cb) não deixou o motivo escrito — sem isto, a próxima recusa também seria um chute.
 */
export function textoDaTelaSemSegredo(
  texto: unknown,
  segredos: ReadonlyArray<string | null | undefined>,
  max = 600,
): string | null {
  if (typeof texto !== "string" || texto.trim() === "") return null;
  let t = texto;
  for (const s of segredos) {
    if (typeof s === "string" && s.length >= 4) t = t.split(s).join("[senha]");
  }
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
