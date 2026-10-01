// Gate do "hoje" UTC no TypeScript — a classe (ii) do fuso, fase 3
// (docs/historico/hoje-sp-typescript-e-data-ciclo.md).
//
// A CLASSE: `toISOString()` é UTC, no navegador e no servidor. Das 21:00 às 23:59 BRT, a data que sai de
// `new Date().toISOString().slice(0, 10)` já é o dia SEGUINTE ao de São Paulo — e o mês seguinte na noite
// do último dia. Nas edges (Deno, servidor em UTC) o mesmo vale para `getDate()`/`getMonth()`/... e para
// `toLocaleDateString()` sem `timeZone`: o "local" do servidor É o UTC. No navegador, `get*()` e
// `format(new Date(), ...)` usam o fuso do usuário (SP) e estão certos — por isso as formas do servidor
// só valem em `supabase/functions/`.
//
// O caso que abriu a fase: o botão do Cockpit chamava `gerar-pedidos-diario` sem data, a edge fazia
// `toISOString().slice(0, 10)`, e das 21h em diante o ciclo nascia AMANHÃ — e a RPC expirava os pendentes
// de HOJE. 135 sítios varridos, 34 afetados de gravidade alta (as datas mandadas ao Omie, os eventos de
// caixa persistidos, a agenda de visitas).
//
// AS FORMAS (por AST — comentário e string não são código para o parser; nenhum stripper aqui):
//   · iso-fatiado (front e edges): `X.toISOString().slice|substring|substr(...)` e
//     `X.toISOString().split('T')[0]` (e o mesmo com `toJSON()`), com qualquer receptor;
//   · calendario-local-no-servidor (só edges): `.getDate()`, `.getDay()`, `.getMonth()`, `.getFullYear()`,
//     `.getHours()`, `.setDate(...)`, `.setHours(...)`, `.setMonth(...)`, `.setFullYear(...)` — as
//     variantes `getUTC*`/`setUTC*` passam: UTC escrito é intenção;
//   · locale-sem-fuso-no-servidor (só edges): `toLocaleDateString(...)`/`toLocaleTimeString(...)` e
//     `new Intl.DateTimeFormat(...)` sem um objeto literal com `timeZone`; e `new Date(...).toLocaleString(...)`
//     sem `timeZone` (o `toLocaleString` de NÚMERO é a maioria — só o receptor `new Date` é data sem dúvida).
//
// O CERTO: no front, `hojeSP()`/`addDias()` (`@/lib/dashboard/sp-date`) e `spBusinessDate()`/
// `spDayRangeUtc()` (`@/lib/time/sp-day`); nas edges, `hojeSP()`/`diaSP()`/`somarDias()`/`paraDataOmie()`
// (`supabase/functions/_shared/hoje-sp.ts`). UTC de propósito: `getUTC*()`/`Date.UTC` montando a string.
//
// LIMITES DECLARADOS (o que o AST sem tipos não vê): o ISO guardado numa variável e fatiado depois
// (`const iso = d.toISOString(); iso.slice(0, 10)` — 0 casos em `src/` na varredura de 2026-10-01);
// `date-fns` `format(...)` numa edge (0 imports de date-fns em `supabase/functions/`); opções de locale
// passadas por variável (o `timeZone` não está no literal → reprova; ponha na baseline com o motivo);
// `getDate()` de um objeto que não é Date (sem tipos não se distingue — baseline).
import tsInterop from "typescript";
// `import =` e não `const` (o porquê em erro-colapsado-em-vazio.ts: o Proxy de interop do vite-node).
import ts = tsInterop;

export type Forma = "iso-fatiado" | "calendario-local-no-servidor" | "locale-sem-fuso-no-servidor";

export interface Sitio {
  arquivo: string;
  linha: number;
  /** O texto da expressão, com espaço colapsado — a identidade do sítio na baseline. */
  trecho: string;
  forma: Forma;
}

const ISO = new Set(["toISOString", "toJSON"]);
const FATIA = new Set(["slice", "substring", "substr"]);
const CALENDARIO_LOCAL = new Set([
  "getDate", "getDay", "getMonth", "getFullYear", "getHours", "setDate", "setHours", "setMonth", "setFullYear",
]);
const LOCALE_DE_DATA = new Set(["toLocaleDateString", "toLocaleTimeString"]);
const SPLIT = new Set(["split"]);
const LOCALE_STRING = new Set(["toLocaleString"]);

/** O arquivo é de edge (servidor UTC)? É o que liga as formas do servidor. */
export const ehEdge = (arquivo: string): boolean => arquivo.replace(/\\/g, "/").startsWith("supabase/functions/");

/** Filtro barato ANTES do parser: só se analisa arquivo que pode ter sítio. */
const PODE_TER = /toISOString|toJSON|getDate|getDay|getMonth|getFullYear|getHours|setDate|setHours|setMonth|setFullYear|toLocale|DateTimeFormat/;

const normalizar = (s: string): string => s.replace(/\s+/g, " ").trim();

function chamadaDe(n: ts.Node, nomes: ReadonlySet<string>): n is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && nomes.has(n.expression.name.text);
}

/** `new Date(...)` — o único receptor de `toLocaleString` que é data sem dúvida (sem tipos). */
const ehNewDate = (e: ts.Expression): boolean =>
  ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Date";

const ehIntlDateTimeFormat = (n: ts.NewExpression): boolean =>
  ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
  && n.expression.expression.text === "Intl" && n.expression.name.text === "DateTimeFormat";

function temTimeZone(args: readonly ts.Expression[]): boolean {
  return args.some((a) => ts.isObjectLiteralExpression(a) && a.properties.some((p) => {
    const nome = p.name;
    return nome !== undefined && (ts.isIdentifier(nome) || ts.isStringLiteral(nome)) && nome.text === "timeZone";
  }));
}

export function detectar(arquivo: string, fonte: string): Sitio[] {
  if (!PODE_TER.test(fonte)) return [];
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true,
    arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const servidor = ehEdge(arquivo);
  const sitios: Sitio[] = [];
  const marca = (n: ts.Node, forma: Forma) => sitios.push({
    arquivo, forma, trecho: normalizar(n.getText(sf)),
    linha: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
  });

  const visita = (n: ts.Node): void => {
    // X.toISOString().slice(...) — qualquer fatia do ISO é o calendário UTC
    if (chamadaDe(n, FATIA) && chamadaDe(n.expression.expression, ISO)) marca(n, "iso-fatiado");
    // X.toISOString().split('T')[0]
    if (ts.isElementAccessExpression(n) && ts.isNumericLiteral(n.argumentExpression) && n.argumentExpression.text === "0"
        && chamadaDe(n.expression, SPLIT) && chamadaDe(n.expression.expression.expression, ISO)) {
      const a = n.expression.arguments[0];
      if (a !== undefined && ts.isStringLiteralLike(a) && a.text === "T") marca(n, "iso-fatiado");
    }
    if (servidor) {
      if (chamadaDe(n, CALENDARIO_LOCAL)) marca(n, "calendario-local-no-servidor");
      if (chamadaDe(n, LOCALE_DE_DATA) && !temTimeZone(n.arguments)) marca(n, "locale-sem-fuso-no-servidor");
      if (chamadaDe(n, LOCALE_STRING) && ehNewDate(n.expression.expression) && !temTimeZone(n.arguments)) marca(n, "locale-sem-fuso-no-servidor");
      if (ts.isNewExpression(n) && ehIntlDateTimeFormat(n) && !temTimeZone(n.arguments ?? [])) marca(n, "locale-sem-fuso-no-servidor");
    }
    ts.forEachChild(n, visita);
  };
  visita(sf);
  return sitios;
}

export type Veredito = "afetado-alto" | "afetado-baixo" | "utc-consistente" | "latente" | "falso-positivo" | "ja-correto";

export interface SitioConhecido {
  arquivo: string;
  trecho: string;
  /** Quantas vezes o trecho aparece no arquivo. Muda para MAIS = sítio novo; para MENOS = quitou. */
  n: number;
  veredito: Veredito;
  motivo: string;
}

/** Diferença entre o que a varredura achou e a baseline: o que é NOVO e o que foi QUITADO. */
export function confrontar(sitios: readonly Sitio[], conhecidos: readonly SitioConhecido[]) {
  const achado = new Map<string, number>();
  for (const s of sitios) {
    const k = `${s.arquivo} · ${s.trecho}`;
    achado.set(k, (achado.get(k) ?? 0) + 1);
  }
  const esperado = new Map(conhecidos.map((c) => [`${c.arquivo} · ${c.trecho}`, c.n]));
  const novos: string[] = [];
  const quitados: string[] = [];
  for (const [k, n] of achado) if ((esperado.get(k) ?? 0) < n) novos.push(`${k} (${n}× no arquivo, baseline ${esperado.get(k) ?? 0})`);
  for (const [k, n] of esperado) if ((achado.get(k) ?? 0) < n) quitados.push(`${k} (baseline ${n}, no arquivo ${achado.get(k) ?? 0})`);
  return { novos, quitados };
}
