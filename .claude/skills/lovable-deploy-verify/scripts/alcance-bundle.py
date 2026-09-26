#!/usr/bin/env python3
"""alcance-bundle.py — elo de CONTEÚDO do monitor-deploy.sh: o delta ar..main alcança o bundle?

Quando chega aqui, o monitor já provou que o ar é ANCESTRAL da main e que todo arquivo do delta é
INERTE, TESTE (ou package.json) pela tabela única do `evals/classify.sh --bundle`. A tabela classifica
NOMES. O que ela sozinha não prova, e este script prova ou recusa:

  (b) BUILD PURO — na main, todo script que o pipeline EXECUTA (build*, pre/post-build, ganchos
      de install) é `vite build [--mode x]`, e não existe gancho de install. Senão
      `vite build && node scripts/gera.js` faria um delta "só de scripts/" mudar o bundle.
  (c) PACKAGE.JSON — se ele está no delta, mudou SÓ em scripts que o pipeline não executa. A
      seção `scripts` não é toda inerte: `build` É o comando do build.
  (a) FECHAMENTO — nada do bundle importa ou referencia caminho que a tabela não classifica como
      ALCANCA (ou TESTE, que então ENTRA no bundle — ver (d)). Sem isto "supabase/ é inerte" seria
      pressuposto: um `import x from '../../supabase/functions/_shared/y'` em src/ faria um delta
      "só de edge" mudar o bundle. Medido em 2026-09-10: 2274 arquivos em src/, 1 import escapando,
      e num teste. "Do bundle" = TODO arquivo ALCANCA de código da main — SUPERCONJUNTO do que o
      entry alcança (varrer a mais só segura o alarme; um grafo a partir do entry que perdesse uma
      aresta abriria) — mais todo TESTE que algum deles alcança, TRANSITIVAMENTE: teste puxado para
      o grafo é varrido também (app → helper de teste → teste), e o import dele passa a contar.
  (d) TESTES — só quando o delta muda arquivo TESTE (modo/objeto do ls-tree diferente no ar e na
      main). Nome de teste não prova inércia (2026-09-26: o `--pr 2547` pedia Publish por um teste,
      mas um teste importado pelo app, ou lido pelo Tailwind, muda o que o ar serve):
      (d1) MÓDULO — o teste mudado não está no grafo de (a): nenhum arquivo do bundle o importa
           (inclusive `import(/* c */ "./x")`, `./x.js` que o Vite abre como `x.ts`, `new URL("x")`
           sem `./`), nenhum import.meta.glob / import dinâmico com template ou concatenação o cobre
           (ref que resolve para DIRETÓRIO ou prefixo de glob cobre todo TESTE abaixo dele), nem
           symlink do bundle aponta para ele. LEITOR — nenhuma string de config de build nomeia
           pasta ou arquivo dele (lê os BYTES; exceto o alias `@` → ./src, cujo `@/x` alvo_de já
           resolve, e as strings DO array `content`, que são (d2)), e nenhum config da raiz lê
           arquivo por API (fs, glob, processo além do `git rev-parse` do carimbo): caminho MONTADO
           em tempo de execução escapa da varredura de strings (Codex, 2026-09-26).
      (d2) TAILWIND — o `content` do tailwind.config lê src/**/*.{ts,tsx} como TEXTO: um teste com
           palavra nova (um `toHaveClass('x')`) pode criar classe no CSS sem ser importado — medido:
           hoje `.m-1` e `.overscroll-contain` estão no CSS de produção SÓ porque testes as citam.
           No tailwindcss 3.4.17 (lido em node_modules): expandTailwindAtRules.getClassCandidates
           extrai POR LINHA e ORDENA os candidatos antes do generateRules; nenhum padrão do
           defaultExtractor casa `\\s`, não há lookbehind e os lookaheads não atravessam `\\s` ⇒ o
           conjunto de candidatos é função do conjunto de PALAVRAS (sequências máximas sem o `\\s`
           do JS). Prova: cada teste mudado, arquivo regular nas duas pontas, tem o MESMO conjunto de
           palavras no ar e na main. Vale só para o extrator AUDITADO (extrator_nao_auditado): o
           lockfile trava o 3.4.17; UM tailwind.config exportando objeto literal, `content` = UM
           array só de strings, sem purge/separator/extract/presets/spread/mutação/import local,
           transform só como propriedade CSS, prefix sem espaço; UM postcss.config com
           `tailwindcss: {}`; nada de PostCSS em linha no vite.config nem `@config` em CSS. Medido:
           das 11 mudanças só-de-teste em src/ dos últimos 300 commits da main, 1 (o #2547, um `4` →
           `3` num mapa) tem as mesmas palavras; as outras acrescentam palavra e seguem ALCANCA — a
           regra erra para MAIS.

Saída: UMA linha. `PROVA_INERCIA_OK ...` com exit 0 é a ÚNICA forma de verde. Refutação = marca
(BUILD_NAO_RECONHECIDO | PACKAGE_JSON_ALCANCA | TESTE_ALCANCA | ALCANCE_VAZA) + exit 1. Qualquer
erro, inclusive inesperado = PROVA_FALHOU + exit 2. O monitor exige as duas coisas (exit 0 E a
marca) para rebaixar — e, com TESTE no delta, qualquer outra resposta deixa o teste ALCANCA.

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
RE_CONFIG_RAIZ = re.compile(r"(vite|tailwind|postcss)\.config\.[^/]+")
STR = r"""(['"`])([^'"`\n]*)\1"""
RE_STR = re.compile(STR)
# Comentário entre a palavra e a string (`import(/* c */ "./x")`) não esconde o import: sem isto a
# aresta sumia, e ponto fixo nenhum recupera aresta que nunca foi reconhecida (Codex, 2026-09-26).
COMENTARIO = r"(?:\s|/\*.*?\*/|//[^\n]*\n)*"
RE_IMPORT = re.compile(r"(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()" + COMENTARIO + STR, re.S)
# `import('./a/' + b + '.ts')`: o dynamic-import-vars do Vite vira glob — o prefixo vale como pasta
RE_IMPORT_CONCAT = re.compile(r"(?:\bimport\s*\(|\brequire\s*\()" + COMENTARIO + STR + r"\s*\+", re.S)
# `new URL('./x', import.meta.url)` é asset para o Vite — e `new URL('x', …)` sem `./` também é
# relativo ao arquivo; `new URL('/api', base)` é URL de runtime.
RE_URL = re.compile(r"(?:\bnew\s+URL\s*\(|\bimportScripts\s*\()" + COMENTARIO + STR, re.S)
RE_GLOB = re.compile(r"import\.meta\.glob(?:Eager)?\s*(?:<[^>]*>)?\s*\(([^)]*)\)")
RE_CSS = re.compile(r"""(?:@(?:import|config|plugin|source|reference)\s+(?:url\(\s*)?|url\(\s*)"""
                    r"""(['"]?)([^'"()\s;]+)\1""")
RE_HTML = re.compile(r"""\b(?:src|href)\s*=\s*(['"])([^'"]*)\1""")
CANDIDATOS = ("", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".css",
              "/index.ts", "/index.tsx", "/index.js", "/index.jsx")
# `import "./x.js"` abre `x.ts` quando o importador é TS (tryFsResolve do Vite): acrescentar
# extensão não enxerga a TROCA, e o teste importado assim sumia da prova.
TROCA_EXT = ((".js", (".ts", ".tsx")), (".jsx", (".tsx",)), (".mjs", (".mts",)), (".cjs", (".cts",)))

# (d1) O alias `@` → ./src do vite.config NÃO é leitor de pasta: `@/x` vira `src/x` em alvo_de, e o
# teste importado assim cai no grafo como qualquer import. Só vale se TODA string "./src" do config
# for o alvo desse alias — outra ocorrência (um plugin que lê ./src) é leitor genérico.
RE_ALIAS_ARROBA = re.compile(r"""(['"])@\1\s*:\s*path\.resolve\(\s*__dirname\s*,\s*(['"])\./src/?\2\s*\)""")

# (d2) O `\s` do JS, EXATO (WhiteSpace ∪ LineTerminator do ECMAScript). Separar por MENOS caracteres
# só perderia precisão (palavra maior, igualdade mais rara); por MAIS — o str.split() do Python corta
# também em \x1c-\x1f e \x85 — seria fail-OPEN: duas palavras para a prova, uma para o extrator.
RE_ESPACO_JS = re.compile("[\t\n\v\f\r    -     　﻿]+")
# O extrator AUDITADO é o do 3.4.17 — "major 3" seria mais largo do que o que foi lido. O lockfile é
# a evidência da versão (o build do Lovable não é nosso); versão nova recusa até alguém reler o
# defaultExtractor.js e atualizar esta constante.
TAILWIND_AUDITADO = "3.4.17"
RE_TW_CONTENT_ARRAY = re.compile(r"\bcontent\s*:\s*\[")
RE_ITEM_CONTENT = re.compile(r"""\s*(?:(['"`])([^'"`\n]*)\1\s*(,?)|(\]))""")
RE_FIM_ARRAY = re.compile(r"\s*\]")
# Tudo que o normalizeConfig do Tailwind consulta para trocar extração/transformação — inclusive
# num `content` ARRAY, que pode carregar `.transform` (o Codex reproduziu CSS diferente com as
# mesmas palavras) — e toda forma de compor/mutar a config que a leitura textual não acompanha.
RE_TW_PROIBIDO = re.compile(r"\b(?:purge|separator|extract|extractors|defaultExtractor|presets)\b"
                            r"|\.\.\.|\bObject\s*\.\s*(?:assign|defineProperty|defineProperties)\b"
                            r"|\.\s*content\b|\[\s*['\"`]content['\"`]\s*\]")
RE_TW_TRANSFORM = re.compile(r"\btransform\b")
RE_TW_TRANSFORM_CSS = re.compile(r"""\btransform\s*:\s*['"`]""")   # a propriedade CSS dos keyframes
RE_TW_EXPORT = re.compile(r"\bexport\s+default\s*\{|\bmodule\.exports\s*=\s*\{")
RE_TW_PREFIX_CHAVE = re.compile(r"\bprefix\s*:")
RE_TW_PREFIX = re.compile(r"""\bprefix\s*:\s*(['"`])([^'"`]*)\1""")
RE_POSTCSS_TW_PADRAO = re.compile(r"\btailwindcss\s*:\s*\{\s*\}")
RE_POSTCSS_PROIBIDO = re.compile(r"\b(?:content|config|extract|transform|separator|prefix)\b"
                                 r"|\btailwindcss\s*\(|\.\.\.")
RE_AT_CONFIG = re.compile(r"@config\b")
# (d1) Config de build que lê arquivo por API monta o caminho em tempo de execução
# (`path.join(base, "test", "x.ts")`) — o que a varredura de strings não vê (Codex, 2026-09-26).
# Com teste no delta, a prova exige POSITIVAMENTE que os configs da raiz não leiam arquivo: nem
# fs/glob, nem processo além do `git rev-parse` literal que carimba o SHA (vite.config.ts).
RE_API_LEITURA = re.compile(r"\b(?:readFileSync|readFile|readdirSync|readdir|createReadStream|opendirSync"
                            r"|opendir|globSync|fast-glob|globby|tinyglobby|fdir)\b"
                            r"""|['"`](?:node:)?fs(?:/promises)?['"`]""")
RE_PROCESSO = re.compile(r"\b(?:execSync|execFileSync|spawnSync|exec|execFile|spawn|fork)\s*\(")
RE_PROCESSO_GIT = re.compile(r"\b(?:execSync|execFileSync|spawnSync|exec|execFile|spawn|fork)\s*\(\s*"
                             r"""(['"`])git rev-parse\b[^'"`\n]*\1""")


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
        if nome != p or cl not in ("ALCANCA", "TESTE", "PACKAGE_JSON", "INERTE", "DESCONHECIDO"):
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


def ler_blobs(ref, paths, cru=False):
    """Conteúdo de cada path NA REF, num processo só (cat-file --batch). `cru` devolve os bytes."""
    if not paths:
        return {}
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
        res[p] = out[ini:fim] if cru else out[ini:fim].decode("utf-8", errors="replace")
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
    specs += [(m.group(2) + "*", "qualquer") for m in RE_IMPORT_CONCAT.finditer(texto)]
    specs += [(m.group(2), "relativo") for m in RE_URL.finditer(texto)]
    for m in RE_GLOB.finditer(texto):
        achados = [(s.group(2).lstrip("!"), "qualquer") for s in RE_STR.finditer(m.group(1))]
        # glob sem string legível (um `)` dentro do padrão corta o grupo): cobre o REPO inteiro —
        # sem isto ele sumiria da prova (ausência de ref não é ausência de glob), e a pasta do
        # arquivo não bastaria (um `../` no padrão sai dela)
        specs += achados or [("/**", "qualquer")]
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
    if "${" in spec:                         # template: o dynamic-import-vars do Vite o vira GLOB
        spec = spec.split("${", 1)[0] + "*"
    spec = re.split(r"[?#]", spec, maxsplit=1)[0]
    if not spec or spec.startswith("//") or re.match(r"[A-Za-z][A-Za-z0-9+.-]*:", spec):
        return None                          # http:, data:, virtual:, node:, protocolo-relativo
    relativo = spec in (".", "..") or spec.startswith(("./", "../"))
    if modo == "config" and not relativo:
        return nome_no_config(spec, uniao, dirs_uniao)
    if modo == "relativo" and not relativo and not spec.startswith(("/", "@/")):
        spec, relativo = "./" + spec, True   # new URL("x", import.meta.url): relativo ao arquivo
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
    """{path: (modo, objeto)} da árvore inteira da REF — o par diz se o arquivo MUDOU entre duas
    refs sem ler conteúdo, e o modo 120000 é symlink."""
    res = {}
    for e in git("ls-tree", "-r", "-z", ref).split(b"\0"):
        if not e:
            continue
        meta, _, nome = e.partition(b"\t")
        partes = meta.split(b" ")
        if len(partes) != 3:
            raise Falhou("ls-tree devolveu entrada inesperada em %s" % ref[:8])
        try:
            res[nome.decode("utf-8")] = (partes[0].decode("ascii"), partes[2].decode("ascii"))
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


def candidatos(alvo):
    """Caminhos que uma ref a `alvo` pode abrir: como está, com extensão ou índice, e a troca
    `.js`→`.ts` do Vite."""
    res = [alvo + c for c in CANDIDATOS]
    for de, paras in TROCA_EXT:
        if alvo.endswith(de):
            res += [alvo[:-len(de)] + p for p in paras]
    return res


def alias_arroba_so(texto):
    """True se TODA string "./src" do vite.config é o alvo do alias `@` (ver RE_ALIAS_ARROBA)."""
    n = sum(1 for m in RE_STR.finditer(texto) if m.group(2).rstrip("/") == "./src")
    return n > 0 and n == len(RE_ALIAS_ARROBA.findall(texto))


def strings_do_content(texto):
    """As strings do array `content` do tailwind.config — o único canal de TEXTO que (d2) prova. None
    se não há UM array feito só de strings literais, ou se alguma delas reaparece fora dele (a mesma
    string servindo a outro leitor, um readFileSync, não é content)."""
    ms = list(RE_TW_CONTENT_ARRAY.finditer(texto))
    if len(ms) != 1:
        return None
    i, res = ms[0].end(), []
    while True:
        m = RE_ITEM_CONTENT.match(texto, i)
        if not m:
            return None
        if m.group(4):
            break
        if "${" in m.group(2):
            return None
        res.append(m.group(2))
        i = m.end()
        if not m.group(3):
            if not RE_FIM_ARRAY.match(texto, i):
                return None
            break
    todas = [m.group(2) for m in RE_STR.finditer(texto)]
    if any(todas.count(s) != res.count(s) for s in set(res)):
        return None
    return set(res)


def versoes_no_lockfile(p, texto):
    """Versões do tailwindcss que o lockfile trava — None se o formato não é um que eu sei ler."""
    if p == "bun.lock":
        return set(re.findall(r'"tailwindcss@([^"]+)"', texto))
    if p in ("package-lock.json", "npm-shrinkwrap.json"):
        try:
            d = json.loads(texto)
        except ValueError:
            return None
        pacotes = d.get("packages") if isinstance(d, dict) else None
        if isinstance(pacotes, dict):
            e = pacotes.get("node_modules/tailwindcss")
        else:
            deps = d.get("dependencies") if isinstance(d, dict) else None
            e = deps.get("tailwindcss") if isinstance(deps, dict) else None
        v = e.get("version") if isinstance(e, dict) else None
        return {v} if isinstance(v, str) else set()
    return None


def extrator_nao_auditado(arvore, css_bundle, texto_de):
    """None se o Tailwind da main é o que a prova (d2) auditou, lido pela config da raiz na forma
    auditada; senão o MOTIVO. Cada item existe porque, sem ele, as MESMAS palavras dariam outro CSS."""
    versoes, lidos = set(), 0
    for p in ("bun.lock", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"):
        if p not in arvore:
            continue
        v = versoes_no_lockfile(p, texto_de(p))
        if v is None:
            return "%s: lockfile que a prova nao sabe ler" % p
        versoes |= v
        lidos += 1
    if not lidos or versoes != {TAILWIND_AUDITADO}:
        return "tailwindcss travado em %s nos lockfiles, e o extrator auditado e o %s" % (
            ",".join(sorted(versoes)) or "nenhuma versao", TAILWIND_AUDITADO)
    raiz = [p for p in arvore if "/" not in p]
    configs = [p for p in raiz if p.startswith("tailwind.config.")]
    if len(configs) != 1:
        return "%d tailwind.config na raiz (a auditada e UMA)" % len(configs)
    t = texto_de(configs[0])
    if len(RE_TW_EXPORT.findall(t)) != 1:
        return "%s: nao exporta UM objeto literal" % configs[0]
    if strings_do_content(t) is None:
        return "%s: content nao e UM array so de strings literais" % configs[0]
    m = RE_TW_PROIBIDO.search(t)
    if m:
        return "%s: '%s' pode trocar o que o extrator ve" % (configs[0], m.group(0))
    if len(RE_TW_TRANSFORM.findall(t)) != len(RE_TW_TRANSFORM_CSS.findall(t)):
        return "%s: transform que nao e a propriedade CSS" % configs[0]
    locais = [s for s, modo in specs_de("", t) if modo == "qualquer" and s.startswith((".", "/", "@/"))]
    if locais:
        return "%s: importa arquivo local (%s) que a leitura textual nao acompanha" % (configs[0], locais[0])
    prefixos = [v for _, v in RE_TW_PREFIX.findall(t)]
    if len(prefixos) != len(RE_TW_PREFIX_CHAVE.findall(t)) or any(RE_ESPACO_JS.search(x) for x in prefixos):
        return "%s: prefix que nao e string sem espaco" % configs[0]
    postcss = [p for p in raiz if p.startswith("postcss.config.")]
    if len(postcss) != 1:
        return "%d postcss.config na raiz (o auditado e UM, com tailwindcss: {})" % len(postcss)
    t = texto_de(postcss[0])
    m = RE_POSTCSS_PROIBIDO.search(t)
    if not RE_POSTCSS_TW_PADRAO.search(t) or m:
        return "%s: fora da forma tailwindcss: {} (%s)" % (postcss[0], m.group(0) if m else "sem ela")
    for p in raiz:
        if p.startswith("vite.config.") and re.search(r"\bpostcss\b", texto_de(p)):
            return "%s: PostCSS em linha no vite.config (o postcss.config deixa de valer)" % p
    for p in css_bundle:
        if RE_AT_CONFIG.search(texto_de(p)):
            return "%s: @config aponta outra config do Tailwind" % p
    return None


def palavras(cru):
    """Conjunto de palavras (sequências máximas sem o `\\s` do JS) — None se não é UTF-8 válido: o
    Node substitui o byte ruim de um jeito, o Python de outro, e a prova não compara adivinhação."""
    try:
        texto = cru.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return {w for w in RE_ESPACO_JS.split(texto) if w}


def provar_fechamento(ar, main, classify):
    ent_main, ent_ar = listar(main), listar(ar)
    arvore = sorted(ent_main)
    arvore_set = set(arvore)
    uniao = arvore_set | set(ent_ar)
    classes = classificar(classify, sorted(uniao))
    dirs = diretorios(arvore)
    dirs_uniao = diretorios(uniao)
    links = {p for p, (modo, _) in ent_main.items() if modo == "120000"}
    testes = sorted(p for p in uniao if classes[p] == "TESTE")
    mudados = [p for p in testes if ent_ar.get(p) != ent_main.get(p)]

    def modulo(p):   # arquivo que o build lê como código e que a prova sabe varrer
        return (p in arvore_set and p.endswith(EXT_CODIGO) and not p.startswith("public/")
                and p not in links)

    def testes_sob(d):
        return [t for t in testes if d == "." or t.startswith(d + "/")]

    def testes_de(alvo):
        """TESTE que uma ref alcança: o ARQUIVO resolvido na união, ou todo teste sob o diretório
        (ou prefixo de glob) — pasta lida inteira é teste lido."""
        if alvo == ".." or alvo.startswith("../"):
            return []
        if alvo.endswith("/"):
            return testes_sob(alvo[:-1] or ".")
        achados = [c for c in candidatos(alvo) if c in uniao]
        if achados:   # TODO candidato que existe: qual o Vite escolhe não é a prova que decide
            return [c for c in achados if classes[c] == "TESTE"]
        return testes_sob(alvo) if alvo in dirs_uniao else []

    varridos = [p for p in arvore if classes[p] == "ALCANCA" and modulo(p)]
    # symlink: o build lê o ALVO. TESTE entra aqui também — era ALCANCA até 2026-09-26, e o content
    # do Tailwind segue o link: um teste-link para docs/ tornaria docs/ parte do CSS.
    links_bundle = sorted(p for p in links if classes[p] in ("ALCANCA", "TESTE"))
    conteudo = ler_blobs(main, varridos + links_bundle)
    alvo_link = {p: posixpath.normpath(posixpath.join(posixpath.dirname(p), conteudo[p].strip()))
                 for p in links_bundle}
    refs = list(alvo_link.items())
    # Três papéis de quem lê um TESTE, e só o de MÓDULO põe os imports dele no bundle:
    #   no_bundle     — grafo de módulos (import, glob, import dinâmico, new URL, symlink do bundle);
    #   por_leitor    — config de build que nomeia pasta/arquivo dele: lê os BYTES, sem executar;
    #   pelo_tailwind — string do array `content`: lê como TEXTO, e (d2) prova pelas palavras.
    no_bundle, por_leitor, pelo_tailwind, fila = {}, {}, {}, []

    def entra(t, origem, spec):
        """Teste puxado para o grafo de módulos: vira arquivo do bundle e é varrido também."""
        if t in no_bundle:
            return
        no_bundle[t] = (origem, spec)
        if t in alvo_link:
            for u in testes_de(alvo_link[t]):
                entra(u, t, "symlink")
        elif modulo(t):
            fila.append(t)

    for p in links_bundle:
        if classes[p] == "ALCANCA":
            for t in testes_de(alvo_link[p]):
                entra(t, p, "symlink")
    rodada = list(varridos)
    while rodada:
        for p in rodada:
            texto = conteudo[p]
            raiz_cfg = "/" not in p
            alias_ok = raiz_cfg and p.startswith("vite.config.") and alias_arroba_so(texto)
            content = (strings_do_content(texto) or set()) if (
                raiz_cfg and p.startswith("tailwind.config.")) else set()
            for spec, modo in specs_de(p, texto):
                alvo = alvo_de(p, spec, modo, uniao, dirs_uniao)
                if alvo is None:
                    continue
                refs.append((p, alvo))
                if modo != "config":
                    for t in testes_de(alvo):          # (d1): import, glob, new URL
                        entra(t, p, spec)
                elif spec in content:
                    for t in testes_de(alvo):          # (d2): content lido como TEXTO
                        pelo_tailwind.setdefault(t, p)
                elif not (alias_ok and spec.rstrip("/") == "./src"):
                    for t in testes_de(alvo):          # (d1): config que lê a pasta ou o arquivo
                        por_leitor.setdefault(t, (p, spec))
        rodada, fila = fila, []
        conteudo.update(ler_blobs(main, rodada))

    css_bundle = [p for p in varridos + sorted(no_bundle) if p.endswith(".css") and p in conteudo]
    det_testes = provar_testes(ar, main, arvore, css_bundle, conteudo, ent_ar, ent_main, mudados,
                               no_bundle, por_leitor, pelo_tailwind)

    # Classe de cada alvo. Arquivo existente usa a da árvore; diretório, prefixo de glob e nome
    # inexistente são classificados pelo NOME na mesma tabela (nunca "não sei, então passa").
    sinteticos, resolvidos = set(), []
    for p, alvo in refs:
        if alvo == ".." or alvo.startswith("../"):
            resolvidos.append((p, alvo, "FORA_DO_REPO", None))
            continue
        d = alvo[:-1] if alvo.endswith("/") else None
        if d is None:
            achado = next((c for c in candidatos(alvo) if c in arvore_set), None)
            if achado is not None:
                resolvidos.append((p, alvo, classes[achado], None))
                continue
            if alvo in dirs:
                d = alvo
        nome = (("" if d == "." else d + "/") + "__sonda__") if d is not None else alvo
        sinteticos.add(nome)
        resolvidos.append((p, alvo, None, nome))
    cls_sint = classificar(classify, sorted(sinteticos))
    # TESTE não é vazamento: ou ficou fora do grafo, ou entrou nele e foi varrido acima (d1)
    vazamentos = [(p, alvo, c if c is not None else cls_sint[nome])
                  for p, alvo, c, nome in resolvidos
                  if (c if c is not None else cls_sint[nome]) not in ("ALCANCA", "TESTE")]
    if vazamentos:
        p, alvo, c = vazamentos[0]
        raise Refutado("ALCANCE_VAZA %s -> %s (%s)%s: o bundle le caminho fora da tabela de "
                       "alcance" % (p, alvo, c, "" if len(vazamentos) == 1
                                    else " e mais %d" % (len(vazamentos) - 1)))
    return len(varridos) + len(no_bundle), len(refs), det_testes


def provar_testes(ar, main, arvore, css_bundle, conteudo, ent_ar, ent_main, mudados, no_bundle,
                  por_leitor, pelo_tailwind):
    """(d) Todo TESTE mudado fora do grafo de módulos, sem leitor de bytes, e — se o Tailwind o lê
    — com o mesmo conjunto de palavras no ar e na main."""
    if not mudados:
        return ""

    def texto_de(p):
        if p not in conteudo:
            conteudo.update(ler_blobs(main, [p]))
        return conteudo[p]

    def mais(lista):
        return "" if len(lista) == 1 else " e mais %d teste(s)" % (len(lista) - 1)

    no_grafo = [t for t in mudados if t in no_bundle]
    if no_grafo:
        origem, spec = no_bundle[no_grafo[0]]
        raise Refutado("TESTE_ALCANCA MODULO %s entra no grafo do bundle por %s (%s)%s" % (
            no_grafo[0], origem, spec[:80], mais(no_grafo)))
    lidos_bytes = [t for t in mudados if t in por_leitor]
    if lidos_bytes:
        origem, spec = por_leitor[lidos_bytes[0]]
        raise Refutado("TESTE_ALCANCA LEITOR %s e lido por %s (%s): config de build le os bytes, "
                       "e o teste mudou%s" % (lidos_bytes[0], origem, spec[:80], mais(lidos_bytes)))
    for p in arvore:
        if "/" in p or not RE_CONFIG_RAIZ.fullmatch(p):
            continue
        t = texto_de(p)
        m = RE_API_LEITURA.search(t)
        if m or len(RE_PROCESSO.findall(t)) != len(RE_PROCESSO_GIT.findall(t)):
            raise Refutado("TESTE_ALCANCA LEITOR %s: %s le arquivo em tempo de execucao (%s) — "
                           "caminho montado escapa da varredura de strings" % (
                               mudados[0], p, m.group(0) if m else "processo alem do git rev-parse"))
    lidos = [t for t in mudados if t in pelo_tailwind]
    if lidos:
        motivo = extrator_nao_auditado(arvore, css_bundle, texto_de)
        if motivo:
            raise Refutado("TESTE_ALCANCA EXTRATOR %s: o content do Tailwind o le como texto, e %s"
                           % (lidos[0], motivo))
        link = [t for t in lidos if "120000" in (ent_ar.get(t, ("",))[0], ent_main.get(t, ("",))[0])]
        if link:
            raise Refutado("TESTE_ALCANCA TAILWIND %s e symlink: o Tailwind le o ALVO, e a prova "
                           "so enxerga o texto do link" % link[0])
        cru_ar = ler_blobs(ar, [t for t in lidos if t in ent_ar], cru=True)
        cru_main = ler_blobs(main, [t for t in lidos if t in ent_main], cru=True)
        for t in lidos:
            pa = palavras(cru_ar[t]) if t in cru_ar else set()
            pm = palavras(cru_main[t]) if t in cru_main else set()
            if pa is None or pm is None:
                raise Refutado("TESTE_ALCANCA TAILWIND %s nao e UTF-8 valido: sem o texto exato "
                               "nao ha conjunto de palavras a comparar" % t)
            if pa != pm:
                novas, sumidas = sorted(pm - pa), sorted(pa - pm)
                raise Refutado("TESTE_ALCANCA TAILWIND %s: o content de %s le o teste como texto, "
                               "e o conjunto de palavras mudou (+%d/-%d, ex.: %s) — palavra nova "
                               "pode virar classe no CSS" % (
                                   t, pelo_tailwind[t], len(novas), len(sumidas),
                                   json.dumps((novas + sumidas)[:3], ensure_ascii=True)[:120]))
    return "; testes: %d mudado(s) fora do grafo de modulos, %d lido(s) pelo Tailwind com as " \
           "mesmas palavras" % (len(mudados), len(lidos))


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
        n_arq, n_refs, det_testes = provar_fechamento(a.ar, a.main, a.classify)
    except Refutado as e:
        print(str(e).replace("\n", " "))
        return 1
    except Falhou as e:
        print(("PROVA_FALHOU " + str(e)).replace("\n", " "))
        return 2
    except Exception as e:  # erro inesperado NUNCA vira verde
        print(("PROVA_FALHOU %s: %s" % (type(e).__name__, e)).replace("\n", " "))
        return 2
    print("PROVA_INERCIA_OK fechamento: %d arquivo(s) do bundle, %d ref(s) locais, 0 vazamento%s; "
          "build: vite build puro%s" % (n_arq, n_refs, det_testes, det_pkg))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
