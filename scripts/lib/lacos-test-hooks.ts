/**
 * Os laços do `test:hooks` (package.json) expandidos para os ARQUIVOS que eles executam.
 *
 * Mora aqui, e não dentro de um `.test.ts`, porque tem DOIS leitores que precisam da MESMA
 * resposta: `hooks-guard-cobertura.test.ts` (toda suíte `scripts/test-*.sh` roda em algum laço) e
 * `gates-frescura-check.ts` (todo hook ligado no `settings.json` tem uma suíte que roda). São as
 * duas pontas da mesma pergunta — "o que o `test:hooks` executa?" —, e dois parsers do mesmo laço
 * divergem no dia em que alguém muda a forma dele; um só não tem com quem divergir.
 */

/**
 * Expande os `for VAR in a b c; do ... scripts/test-$VAR....sh ... done` de um comando de shell
 * para a lista de ARQUIVOS que ele de fato executa. Lê TODOS os laços, e tira o molde do nome do
 * corpo de cada um — não presume sufixo.
 */
export function arquivosExecutados(cmd: string): string[] {
  const encontrados: string[] = [];
  const laco = /for\s+(\w+)\s+in\s+([^;]+);\s*do\b([\s\S]*?)\bdone\b/g;
  for (const [, variavel, lista, corpo] of cmd.matchAll(laco)) {
    const alvos = lista.trim().split(/\s+/).filter(Boolean);
    const cifra = `\\$\\{?${variavel}\\}?`;
    const molde = new RegExp(`scripts/([A-Za-z0-9_.-]*${cifra}[A-Za-z0-9_.-]*\\.sh)`, 'g');
    for (const [, template] of corpo.matchAll(molde)) {
      for (const alvo of alvos) {
        encontrados.push(template.replace(new RegExp(cifra), alvo));
      }
    }
  }
  return [...new Set(encontrados)].sort();
}
