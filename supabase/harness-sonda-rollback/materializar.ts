// Materializa um closure histórico REAL a partir do git — nada de fixture copiada para o repo.
//
// Fixture copiada envelhece e mente: ela vira uma cópia que alguém edita, e a prova passa a ser
// sobre a cópia. Aqui o bundle sai de `git archive <sha>`, com o fecho de `_shared/` DAQUELE sha
// (o achado do challenge: fecho do HEAD sobre código antigo prova outra coisa).
import { extrairRemotos, gerarImportMap } from "./mapa-imports.ts";

const RAIZ = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

export type Chamada = {
  status: number;
  probe: boolean;
  efeitos: number;
  fetches: number;
  corpoHash: string;
  headers: Record<string, string>;
  quiesceu: boolean;
};

export type Veredito = {
  importErro: string | null;
  efeitosNoImport: number;
  handler: boolean;
  a: Chamada;
  b: Array<Chamada & { nome: string }>;
  c: { classe: string; efeitos: number; fetches: number; degrau: string | null };
  tentativasControle: Array<{ nome: string; status: number; efeitos: number; fetches: number }>;
  chamadas: string[];
  fetchUrls: string[];
};

async function rodar(args: string[], cwd: string): Promise<Uint8Array> {
  const o = await new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!o.success) {
    throw new Error(`${args.join(" ")} falhou: ${new TextDecoder().decode(o.stderr).slice(0, 200)}`);
  }
  return o.stdout;
}

const IMPORT_LOCAL = /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g;

/** Fecho transitivo dos imports LOCAIS a partir do `index.ts` materializado. */
async function fechoLocal(entrada: string): Promise<string[]> {
  const vistos = new Set<string>();
  const fila = [entrada];
  while (fila.length > 0) {
    const arq = fila.pop()!;
    if (vistos.has(arq)) continue;
    let fonte: string;
    try {
      fonte = await Deno.readTextFile(arq);
    } catch {
      continue; // import que não resolve no closure: o próprio Deno vai acusar na execução
    }
    vistos.add(arq);
    const base = arq.slice(0, arq.lastIndexOf("/"));
    for (const m of fonte.matchAll(IMPORT_LOCAL)) {
      const esp = m[1] ?? m[2];
      if (!esp) continue;
      const partes = `${base}/${esp}`.split("/");
      const norm: string[] = [];
      for (const p of partes) {
        if (p === "." || p === "") continue;
        if (p === "..") norm.pop();
        else norm.push(p);
      }
      fila.push(`/${norm.join("/")}`);
    }
  }
  return [...vistos];
}

async function* percorrer(d: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(d)) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory) yield* percorrer(p);
    else yield p;
  }
}

/** Existe este caminho NESTE sha? (`_shared/` só nasceu em meados de 2026; antes disso não havia.) */
async function existeNoSha(sha: string, caminho: string, raizRepo: string): Promise<boolean> {
  const o = await new Deno.Command("git", {
    args: ["ls-tree", "-d", "--name-only", sha, caminho],
    cwd: raizRepo,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return o.success && new TextDecoder().decode(o.stdout).trim().length > 0;
}

export async function materializar(sha: string, edge: string, raizRepo: string) {
  const dir = await Deno.makeTempDir({ prefix: `closure-${edge}-${sha}-` });
  // `git archive` ABORTA se um pathspec não casa, e `supabase/functions/_shared` não existia nos
  // bundles de fevereiro/março de 2026. Filtrar os caminhos ausentes é correto; o que NÃO pode é
  // materializar vazio em silêncio — daí a checagem do `index.ts` logo abaixo (fail-closed).
  const candidatos = [`supabase/functions/${edge}`, "supabase/functions/_shared"];
  const caminhos: string[] = [];
  for (const c of candidatos) if (await existeNoSha(sha, c, raizRepo)) caminhos.push(c);
  if (caminhos.length === 0) {
    throw new Error(`materializar: nenhum caminho de ${edge} existe em ${sha} — a edge nasceu depois?`);
  }
  const tar = await rodar(["git", "archive", sha, ...caminhos], raizRepo);
  const tarPath = `${dir}/closure.tar`;
  await Deno.writeFile(tarPath, tar);
  await rodar(["tar", "-x", "-C", dir, "-f", tarPath], raizRepo);
  const indexEsperado = `${dir}/supabase/functions/${edge}/index.ts`;
  try {
    await Deno.stat(indexEsperado);
  } catch (e) {
    // A CAUSA vai na mensagem. Um `catch` mudo aqui já transformou um PermissionDenied do sandbox
    // (tempdir fora do --allow-read) em "materialização vazia" — a mesma família de "ausência de
    // sinal lida como afirmação" que este mecanismo inteiro existe para evitar.
    const causa = e instanceof Deno.errors.NotFound
      ? "o archive não trouxe o arquivo"
      : `${(e as Error).name}: ${(e as Error).message}`;
    throw new Error(
      `materializar: ${edge}@${sha} não produziu index.ts (${causa}) — materialização vazia não é 'zero efeito'`,
    );
  }

  // Os remotos vêm do FECHO da edge (index + imports locais transitivos), não do diretório inteiro.
  // `_shared/` é materializado completo (é mais barato que resolver antes de extrair), mas um
  // arquivo que a edge NÃO importa não influencia a execução dela — exigir stub para ele tornaria
  // `INVERIFICAVEL` um closure perfeitamente executável, e a allowlist travaria por medida errada.
  const remotos = new Set<string>();
  for (const arq of await fechoLocal(indexEsperado)) {
    for (const r of extrairRemotos(await Deno.readTextFile(arq))) remotos.add(r);
  }
  const mapa = gerarImportMap([...remotos].sort(), `file://${RAIZ}/stubs`);
  const mapaPath = `${dir}/import_map.json`;
  await Deno.writeTextFile(mapaPath, JSON.stringify(mapa, null, 1));
  return {
    dir,
    indexPath: `${dir}/supabase/functions/${edge}/index.ts`,
    mapaPath,
    desconhecidos: mapa.desconhecidos,
  };
}

export async function executarRunner(
  indexPath: string,
  mapaPath: string,
  edge: string,
  chave: string,
  controles: unknown,
  leituraExtra?: string,
): Promise<Veredito> {
  const leitura = [RAIZ, leituraExtra ?? indexPath.replace(/\/supabase\/functions\/.*$/, "")].join(",");
  const o = await new Deno.Command("deno", {
    args: [
      "run", "--no-remote", `--import-map=${mapaPath}`, `--allow-read=${leitura}`,
      `${RAIZ}/runner.ts`, indexPath, edge, chave, JSON.stringify(controles),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const linhas = new TextDecoder().decode(o.stdout).trim().split("\n").filter((l) => l.startsWith("{"));
  if (linhas.length === 0) {
    throw new Error(
      `runner sem veredito para ${edge} (${indexPath}): ${new TextDecoder().decode(o.stderr).slice(0, 400)}`,
    );
  }
  return JSON.parse(linhas[linhas.length - 1]);
}
