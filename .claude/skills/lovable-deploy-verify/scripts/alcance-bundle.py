#!/usr/bin/env python3
"""alcance-bundle.py — elo de CONTEÚDO do monitor-deploy.sh: o delta ar..main alcança o bundle?

Quando chega aqui, o monitor já provou que o ar é ANCESTRAL da main e que todo arquivo do delta é
INERTE (ou package.json) pela tabela única do `evals/classify.sh --bundle`. A tabela classifica
NOMES. O que ela sozinha não prova, e este script prova ou recusa:

  (b) BUILD PURO — na main, todo script que o pipeline EXECUTA (build*, pre/post-build, ganchos
      de install) é `vite build [--mode x]`, e não existe gancho de install. Senão
      `vite build && node scripts/gera.js` faria um delta "só de scripts/" mudar o bundle.
  (c) PACKAGE.JSON — se ele está no delta, mudou SÓ em scripts que o pipeline não executa. A
      seção `scripts` não é toda inerte: `build` É o comando do build.
  (a) FECHAMENTO — nenhum arquivo ALCANCA da main (fora teste) importa ou referencia caminho que
      a tabela não classifica como ALCANCA. Sem isto "supabase/ é inerte" seria pressuposto: um
      `import x from '../../supabase/functions/_shared/y'` em src/ faria um delta "só de edge"
      mudar o bundle. Medido em 2026-09-10: 2274 arquivos em src/, 1 import escapando, e num teste.

Saída: UMA linha. `PROVA_INERCIA_OK ...` com exit 0 é a ÚNICA forma de verde. Refutação = marca
(BUILD_NAO_RECONHECIDO | PACKAGE_JSON_ALCANCA | ALCANCE_VAZA) + exit 1. Qualquer erro, inclusive
inesperado = PROVA_FALHOU + exit 2. O monitor exige as duas coisas (exit 0 E a marca) para rebaixar.

Uso: alcance-bundle.py --ar <sha> --main <sha> --classify <classify.sh> [--package-json]
Lê a REF (ls-tree / cat-file), nunca o working tree: a worktree pode estar atrás da main.
"""
import argparse
import json
import posixpath
import re
import subprocess
import sys


class Refutado(Exception):
    """A prova foi REFUTADA: o delta pode alcançar o bundle (exit 1)."""


class Falhou(Exception):
    """Não consegui provar nem refutar (exit 2)."""


# Scripts que o pipeline de install/build EXECUTA: npm e bun rodam os ganchos da raiz no install,
# e `npm run build` roda pre/post. Mudou um destes ⇒ alcança; os demais (sonda:*, test:*…) não.
GANCHOS_INSTALL = {"preinstall", "install", "postinstall", "preprepare", "prepare",
                   "postprepare", "prepublish", "prepack", "postpack", "dependencies"}
RE_BUILD = re.compile(r"(pre|post)?build(:.*)?")
RE_BUILD_PURO = re.compile(r"vite build(?: --mode [A-Za-z0-9_-]+)?")

# Fechamento: o que varrer e como achar referência a caminho.
EXT_CODIGO = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".css", ".html")
RE_TESTE = re.compile(r"(^|/)__tests__/|\.(test|spec)\.[^/]+$")
RE_CONFIG_RAIZ = re.compile(r"(vite|tailwind|postcss)\.config\.[^/]+")
STR = r"""(['"`])([^'"`\n]*)\1"""
RE_STR = re.compile(STR)
RE_IMPORT = re.compile(r"(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*" + STR)
# `new URL('./x', import.meta.url)` é asset para o Vite; `new URL('/api', base)` é URL de runtime.
RE_URL = re.compile(r"(?:\bnew\s+URL\s*\(|\bimportScripts\s*\()\s*" + STR)
RE_GLOB = re.compile(r"import\.meta\.glob(?:Eager)?\s*(?:<[^>]*>)?\s*\(([^)]*)\)")
RE_CSS = re.compile(r"""(?:@(?:import|config|plugin|source|reference)\s+(?:url\(\s*)?|url\(\s*)"""
                    r"""(['"]?)([^'"()\s;]+)\1""")
RE_HTML = re.compile(r"""\b(?:src|href)\s*=\s*(['"])([^'"]*)\1""")
CANDIDATOS = ("", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".css",
              "/index.ts", "/index.tsx", "/index.js", "/index.jsx")


def executado_pelo_pipeline(chave):
    return chave in GANCHOS_INSTALL or RE_BUILD.fullmatch(chave) is not None


def git(*args, entrada=None):
    r = subprocess.run(["git", *args], input=entrada, capture_output=True)
    if r.returncode != 0:
        raise Falhou("git %s saiu %d" % (args[0], r.returncode))
    return r.stdout


def classificar(classify, paths):
    """Tabela única do classify.sh --bundle. Resposta POSITIVA: uma linha por path + marca de fim."""
    paths = list(paths)
    for p in paths:
        if not p or "\n" in p or "\t" in p:
            raise Falhou("nome irrepresentavel na tabela: %r" % p)
    r = subprocess.run(["bash", classify, "--bundle"], capture_output=True,
                       input="".join(p + "\n" for p in paths).encode("utf-8"))
    if r.returncode != 0:
        raise Falhou("classify.sh --bundle saiu %d" % r.returncode)
    linhas = r.stdout.decode("utf-8").split("\n")
    if linhas and linhas[-1] == "":
        linhas.pop()
    if len(linhas) != len(paths) + 1 or linhas[-1] != "FIM_CLASSIFICACAO_BUNDLE %d" % len(paths):
        raise Falhou("classify.sh --bundle sem resposta completa para %d caminho(s)" % len(paths))
    classes = {}
    for linha, p in zip(linhas, paths):
        cl, _, nome = linha.partition("\t")
        if nome != p or cl not in ("ALCANCA", "PACKAGE_JSON", "INERTE", "DESCONHECIDO"):
            raise Falhou("classify.sh --bundle devolveu linha inesperada: %r" % linha[:120])
        classes[p] = cl
    return classes


def ler_pkg(ref):
    try:
        dado = json.loads(git("cat-file", "blob", "%s:package.json" % ref))
    except ValueError as e:
        raise Falhou("package.json de %s nao e JSON: %s" % (ref[:8], e))
    if not isinstance(dado, dict):
        raise Falhou("package.json de %s nao e um objeto" % ref[:8])
    return dado


def provar_build_puro(pkg):
    scripts = pkg.get("scripts", {})
    if not isinstance(scripts, dict):
        raise Refutado("BUILD_NAO_RECONHECIDO scripts do package.json nao e um objeto")
    for k in sorted(scripts):
        if not executado_pelo_pipeline(k):
            continue
        v = scripts[k]
        if k in GANCHOS_INSTALL:
            raise Refutado("BUILD_NAO_RECONHECIDO scripts.%s existe: gancho de install roda "
                           "antes do build e pode ler qualquer arquivo" % k)
        if not isinstance(v, str) or not RE_BUILD_PURO.fullmatch(v.strip()):
            raise Refutado("BUILD_NAO_RECONHECIDO scripts.%s=%s nao e vite build puro: o que ele "
                           "le fica fora da tabela" % (k, json.dumps(v)[:80]))


def podar(pkg):
    """package.json sem os scripts que o pipeline NÃO executa — só eles podem mudar sem alcançar."""
    d = dict(pkg)
    s = d.get("scripts")
    if isinstance(s, dict):
        mantidos = {k: v for k, v in s.items() if executado_pelo_pipeline(k)}
        if mantidos:
            d["scripts"] = mantidos
        else:
            d.pop("scripts")
    return d


def provar_package_json(pkg_ar, pkg_main):
    a, b = podar(pkg_ar), podar(pkg_main)
    if a != b:
        chaves = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
        if "scripts" in chaves:
            sa, sb = a.get("scripts", {}), b.get("scripts", {})
            chaves.remove("scripts")
            chaves += sorted("scripts." + k for k in set(sa) | set(sb) if sa.get(k) != sb.get(k))
        raise Refutado("PACKAGE_JSON_ALCANCA mudou fora dos scripts inertes: %s" % ",".join(chaves))
    sa = pkg_ar.get("scripts") if isinstance(pkg_ar.get("scripts"), dict) else {}
    sb = pkg_main.get("scripts") if isinstance(pkg_main.get("scripts"), dict) else {}
    return sorted(k for k in set(sa) | set(sb) if sa.get(k) != sb.get(k))


def ler_blobs(ref, paths):
    """Conteúdo de cada path NA REF, num processo só (cat-file --batch)."""
    out = git("cat-file", "--batch",
              entrada="".join("%s:%s\n" % (ref, p) for p in paths).encode("utf-8"))
    res, i = {}, 0
    for p in paths:
        nl = out.index(b"\n", i)
        cab = out[i:nl].split(b" ")
        if len(cab) != 3 or cab[1] != b"blob":
            raise Falhou("cat-file nao devolveu blob para %s" % p)
        ini = nl + 1
        fim = ini + int(cab[2])
        res[p] = out[ini:fim].decode("utf-8", errors="replace")
        i = fim + 1
    if i != len(out):
        raise Falhou("cat-file devolveu bytes alem dos pedidos")
    return res


def specs_de(path, texto):
    """(spec, modo) de toda string que o arquivo usa como CAMINHO. Comentário entra de propósito:
    varrer a mais só segura o alarme; limpar comentário com regex local é o que cega gate textual
    (docs/historico/gates-textuais-cegos.md). modo: "qualquer" (import/glob/CSS/HTML), "relativo"
    (só `./`/`../` contam) ou "config" (config de build: ver alvo_de)."""
    specs = [(m.group(2), "qualquer") for m in RE_IMPORT.finditer(texto)]
    specs += [(m.group(2), "relativo") for m in RE_URL.finditer(texto)]
    for m in RE_GLOB.finditer(texto):
        specs += [(s.group(2).lstrip("!"), "qualquer") for s in RE_STR.finditer(m.group(1))]
    if path.endswith(".css"):
        specs += [(m.group(2), "qualquer") for m in RE_CSS.finditer(texto)]
    if path.endswith(".html"):
        specs += [(m.group(2), "qualquer") for m in RE_HTML.finditer(texto)]
    if "/" not in path and RE_CONFIG_RAIZ.fullmatch(path):
        # config de build: TODA string conta (alias, content do Tailwind, publicDir, readFileSync).
        specs += [(m.group(2), "config") for m in RE_STR.finditer(texto)]
    return specs


def nome_no_config(spec, uniao, dirs_uniao):
    """String SEM `./` num config de build: vale se NOMEIA caminho que existe na raiz. É assim que
    `path.resolve(__dirname, "supabase/functions/_shared")` vira alias, publicDir, envDir ou root
    fora de src/ — e o import `@edge/x` que ele habilita parece PACOTE para quem lê só o src/.
    Glob vale pelo diretório estático (`"docs/**/*.md"` → docs/); `"**/*.js"` do Workbox (relativo
    ao dist) não nomeia nada e passa."""
    if spec.startswith(("/", "@")) or spec in (".", ".."):
        return None
    curinga = re.search(r"[*{\[]", spec)
    nome = spec[:curinga.start()] if curinga else spec
    nome = (nome[:nome.rfind("/")] if "/" in nome else "") if curinga else nome.rstrip("/")
    if not nome:
        return None
    nome = posixpath.normpath(nome)
    if nome == "." or nome.startswith(".."):
        return None
    if curinga:
        return nome + "/" if nome in dirs_uniao else None
    return nome if (nome in uniao or nome in dirs_uniao) else None


def alvo_de(arq, spec, modo, uniao, dirs_uniao):
    """Caminho (relativo à raiz) que `spec` referencia a partir de `arq`, ou None se não é arquivo
    do repo. Prefixo de glob volta terminado em "/". `uniao` = árvores do ar E da main: arquivo
    apagado no delta ainda é referência do bundle que o ar serve."""
    spec = re.split(r"[?#]", spec.split("${", 1)[0], maxsplit=1)[0]
    if not spec or spec.startswith("//") or re.match(r"[A-Za-z][A-Za-z0-9+.-]*:", spec):
        return None                          # http:, data:, virtual:, node:, protocolo-relativo
    relativo = spec in (".", "..") or spec.startswith(("./", "../"))
    if modo == "config" and not relativo:
        return nome_no_config(spec, uniao, dirs_uniao)
    if modo == "relativo" and not relativo:
        return None
    if spec.startswith("@/"):
        base = "src/" + spec[2:]
    elif relativo:
        base = posixpath.join(posixpath.dirname(arq), spec)
    elif spec.startswith("/"):
        base = spec.lstrip("/")
        if not re.search(r"[*{\[]", base):
            if "public/" + base in uniao:    # o Vite serve "/x" do public/ antes da raiz
                return "public/" + base
            if base not in dirs_uniao and not any(base + c in uniao for c in CANDIDATOS):
                return None                  # gerado pelo build (manifest do PWA) ou rota de runtime
    else:
        return None                          # pacote: coberto pelo package.json e lockfile
    curinga = re.search(r"[*{\[]", base)
    if curinga:                              # glob: vale o DIRETÓRIO estático antes do curinga
        base = base[:curinga.start()]
        base = base[:base.rfind("/")] if "/" in base else "."
        return posixpath.normpath(base) + "/"
    return posixpath.normpath(base)


def listar(ref):
    """[(path, é_symlink)] da árvore inteira da REF."""
    res = []
    for e in git("ls-tree", "-r", "-z", ref).split(b"\0"):
        if not e:
            continue
        meta, _, nome = e.partition(b"\t")
        try:
            res.append((nome.decode("utf-8"), meta.startswith(b"120000 ")))
        except UnicodeDecodeError:
            raise Falhou("nome de arquivo nao-UTF-8 em %s" % ref[:8])
    return res


def diretorios(paths):
    dirs = {"."}
    for p in paths:
        partes = p.split("/")
        for i in range(1, len(partes)):
            dirs.add("/".join(partes[:i]))
    return dirs


def provar_fechamento(ar, main, classify):
    entradas = listar(main)
    arvore = [p for p, _ in entradas]
    links = {p for p, link in entradas if link}
    classes = classificar(classify, arvore)
    arvore_set = set(arvore)
    dirs = diretorios(arvore)
    uniao = arvore_set | {p for p, _ in listar(ar)}
    dirs_uniao = diretorios(uniao)

    varridos = [p for p in arvore
                if classes[p] == "ALCANCA" and p.endswith(EXT_CODIGO)
                and not p.startswith("public/") and not RE_TESTE.search(p) and p not in links]
    links_bundle = sorted(p for p in links if classes[p] == "ALCANCA")
    conteudo = ler_blobs(main, varridos + links_bundle)
    refs = []
    for p in varridos:
        for spec, modo in specs_de(p, conteudo[p]):
            alvo = alvo_de(p, spec, modo, uniao, dirs_uniao)
            if alvo is not None:
                refs.append((p, alvo))
    for p in links_bundle:                   # symlink no bundle: o build lê o ALVO
        refs.append((p, posixpath.normpath(posixpath.join(posixpath.dirname(p),
                                                          conteudo[p].strip()))))

    # Classe de cada alvo. Arquivo existente usa a da árvore; diretório, prefixo de glob e nome
    # inexistente são classificados pelo NOME na mesma tabela (nunca "não sei, então passa").
    sinteticos, resolvidos = set(), []
    for p, alvo in refs:
        if alvo == ".." or alvo.startswith("../"):
            resolvidos.append((p, alvo, "FORA_DO_REPO", None))
            continue
        d = alvo[:-1] if alvo.endswith("/") else None
        if d is None:
            achado = next((alvo + c for c in CANDIDATOS if alvo + c in arvore_set), None)
            if achado is not None:
                resolvidos.append((p, alvo, classes[achado], None))
                continue
            if alvo in dirs:
                d = alvo
        nome = (("" if d == "." else d + "/") + "__sonda__") if d is not None else alvo
        sinteticos.add(nome)
        resolvidos.append((p, alvo, None, nome))
    cls_sint = classificar(classify, sorted(sinteticos))
    vazamentos = [(p, alvo, c if c is not None else cls_sint[nome])
                  for p, alvo, c, nome in resolvidos
                  if (c if c is not None else cls_sint[nome]) != "ALCANCA"]
    if vazamentos:
        p, alvo, c = vazamentos[0]
        raise Refutado("ALCANCE_VAZA %s -> %s (%s)%s: o bundle le caminho fora da tabela de "
                       "alcance" % (p, alvo, c, "" if len(vazamentos) == 1
                                    else " e mais %d" % (len(vazamentos) - 1)))
    return len(varridos), len(refs)


def main(argv):
    ap = argparse.ArgumentParser(description="prova que o delta ar..main nao alcanca o bundle")
    ap.add_argument("--ar", required=True)
    ap.add_argument("--main", required=True)
    ap.add_argument("--classify", required=True)
    ap.add_argument("--package-json", action="store_true")
    a = ap.parse_args(argv)
    try:
        pkg_main = ler_pkg(a.main)
        provar_build_puro(pkg_main)
        det_pkg = ""
        if a.package_json:
            mudados = provar_package_json(ler_pkg(a.ar), pkg_main)
            det_pkg = "; package.json: so scripts fora do pipeline (%s)" % (
                ",".join(mudados) or "so formatacao")
        n_arq, n_refs = provar_fechamento(a.ar, a.main, a.classify)
    except Refutado as e:
        print(str(e).replace("\n", " "))
        return 1
    except Falhou as e:
        print(("PROVA_FALHOU " + str(e)).replace("\n", " "))
        return 2
    except Exception as e:  # erro inesperado NUNCA vira verde
        print(("PROVA_FALHOU %s: %s" % (type(e).__name__, e)).replace("\n", " "))
        return 2
    print("PROVA_INERCIA_OK fechamento: %d arquivo(s) do bundle, %d ref(s) locais, 0 vazamento; "
          "build: vite build puro%s" % (n_arq, n_refs, det_pkg))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
