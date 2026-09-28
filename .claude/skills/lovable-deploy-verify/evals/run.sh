#!/usr/bin/env bash
# run.sh — GATE de regressão da skill lovable-deploy-verify. Roda os NOVE evals:
#   (1) classify        — classificação de diff do Passo 1 (classify.sh vs classify-eval.json)
#   (2) verify-frontend — enumeração + exit codes do Passo 4 (harness local determinístico)
#   (3) verify-edge-eco  — guard TEMPORAL do N3 passivo (só ticks pré-merge ⇒ indeterminado)
#   (4) verify-edge-escrita — N3 passivo por escrita de aplicação
#   (5) sonda-veredito-401  — guard de CREDENCIAL do SQL de sondagem (401 é ambíguo; EXECUTA o SQL)
#   (6) criterio-caro      — critério MEDIDO do `--caro` (efeito, não forma do handler)
#   (7) edges-pendentes-sql — classificação do Passo 3 do /fecho (EXECUTA o SQL do gate passivo)
#   (8) monitor-deploy     — "SHA atrás ≠ bundle atrás": exit 5 só com prova positiva (repo-fixture)
#   (9) monitor-deploy-pr  — "o PR está no ar?" por ANCESTRALIDADE + estado por checkout (repo-fixture)
# Exit 0 = tudo passou. Exit 1 = alguma divergência.
# Falsificação (prova que os evals têm dente): --falsify sabota TODOS e exige o vermelho PREVISTO —
#   cada sabotagem declara o assert/caso que a acusa e o desfecho dele (exit + marca, IDs, veredito,
#   chave=valor), sobre um controle íntegro da mesma invocação, e cada eval roda um CONTROLE NEGATIVO
#   do próprio juiz (uma sabotagem que só derruba o alvo tem de ser RECUSADA). "Ficou vermelho"
#   sozinho aceitava crash e erro alheio → docs/historico/falsificacao-exit-nao-e-dente.md.
#   (classify sabota o gabarito UMA CHAVE POR VEZ e depois muta o classify.sh real; verify-frontend
#   sabota a enumeração; verify-edge-eco arranca o guard temporal, o fail-closed do ping e o filtro
#   do tick mais recente; criterio-caro sabota SKILL.md e as três edges-exemplo, uma por vez).
#   Exit 0 só se pegou tudo.
set -uo pipefail
cd "$(dirname "$0")" || exit 2

FALSIFY=0
[ "${1:-}" = "--falsify" ] && FALSIFY=1
rc=0

echo "== (1) classify — Passo 1 =="
if python3 - "$@" <<'PY'
import json, os, subprocess, sys, tempfile

falsify = "--falsify" in sys.argv
cases = json.load(open("classify-eval.json"))

def roda(caso, script="classify.sh"):
    """Cada caso roda num tmpdir PRÓPRIO: as 3 primeiras camadas são função pura dos nomes,
    mas a 4ª (secrets) lê o disco. Sem sandbox o eval passaria a depender do estado do repo
    real — caso sem `fixtures` roda contra árvore vazia e por isso dá secrets=não."""
    with tempfile.TemporaryDirectory() as raiz:
        for p, conteudo in caso.get("fixtures", {}).items():
            alvo = os.path.join(raiz, p)
            os.makedirs(os.path.dirname(alvo), exist_ok=True)
            with open(alvo, "w") as fh:
                fh.write(conteudo)
        r = subprocess.run(["bash", script],
                           input="\n".join(caso["files"]) + "\n",
                           capture_output=True, text=True,
                           env=dict(os.environ, CLASSIFY_RAIZ=raiz))
    return dict(l.split("=", 1) for l in r.stdout.strip().splitlines())

def roda_bruto(caso, script, loc):
    """Para a falsificação: devolve (saída, rc, stderr) sob o locale pedido. Mutante que MORRE (rc≠0
    ou stderr) é erro de execução, nunca "divergiu do gabarito" — a saída vazia de um classify que
    nem rodou diverge de TODOS os casos, e o juiz de antes contava isso como dente (medido)."""
    with tempfile.TemporaryDirectory() as raiz:
        for p, conteudo in caso.get("fixtures", {}).items():
            alvo = os.path.join(raiz, p)
            os.makedirs(os.path.dirname(alvo), exist_ok=True)
            with open(alvo, "w") as fh:
                fh.write(conteudo)
        r = subprocess.run(["bash", script],
                           input="\n".join(caso["files"]) + "\n",
                           capture_output=True, text=True,
                           env=dict(os.environ, CLASSIFY_RAIZ=raiz, LC_ALL=loc, LANG=loc))
    linhas = [l for l in r.stdout.strip().splitlines() if l]
    return dict(l.split("=", 1) for l in linhas if "=" in l), r.returncode, r.stderr.strip()

def locales():
    """Sonda POSITIVA: "setei LC_ALL" não prova que o locale existe (glibc cai em C calado)."""
    ls = ["C"]
    for cand in ("pt_BR.UTF-8", "pt_BR.utf8", "en_US.UTF-8", "en_US.utf8", "C.UTF-8", "C.utf8"):
        r = subprocess.run(["locale", "charmap"], capture_output=True, text=True,
                           env=dict(os.environ, LC_ALL=cand))
        if r.stdout.strip() == "UTF-8":
            ls.append(cand)
            break
    return ls

def sabota(valor, chave):
    # `secrets` não é booleano: inverter SIM/não não o tocaria. Sem regra própria, a sabotagem
    # das OUTRAS chaves já bastaria para divergir e a 4ª camada ficaria sem dente.
    if chave == "secrets":
        return "não" if valor != "não" else "POSTHOG_INGEST_KEY"
    return "SIM" if valor == "não" else "não"

# Mutações do classify.sh REAL (cópia em tmp; o versionado nunca é mutado). Cada uma arranca
# uma decisão da 4ª camada e DECLARA o caso que a acusa, a chave e o valor que ele TEM de dar —
# MEDIDOS (2026-09-27) e lidos um a um. "≥1 caso vermelho" (o juiz de antes) aprovava uma mutação
# que só quebrava a sintaxe: saída vazia diverge de todos os casos. → docs/historico/falsificacao-exit-nao-e-dente.md
MUTACOES = [
    ("universo inclui os próprios arquivos tocados (edge se compara consigo mesma)",
     'comm -23 "$tmp/todos" "$tmp/tocados" > "$tmp/universo"',
     'cp "$tmp/todos" "$tmp/universo"',
     "edge MODIFICADA ganha secret novo — não pode se comparar consigo mesma", "secrets", "não"),
    ("nome dinâmico vira silêncio em vez de ?dinamico",
     'if [ "$dinamico" = 1 ]; then',
     'if [ "$dinamico" = 9 ]; then',
     "nome COMPUTADO ⇒ ?dinamico (ausência de literal não é ausência de secret)", "secrets", "não"),
    ("_test.ts tocado conta como código de edge",
     "/^supabase\\/functions\\/.*\\.ts$/ && !/_test\\.ts$/",
     "/^supabase\\/functions\\/.*\\.ts$/",
     "_test.ts tocado não pede secret (não vai pro bundle)", "secrets", "SECRET_DE_TESTE"),
    ("não subtrai o universo: todo secret lido vira 'novo'",
     'comm -23 "$tmp/usados" "$tmp/conhecidos" > "$tmp/novos"',
     'cp "$tmp/usados" "$tmp/novos"',
     "secret que OUTRA edge já usa não é novo (senão o detector grita sempre)", "secrets", "CRON_SECRET,SUPABASE_URL"),
    ("_test.ts entra no universo e faz secret novo parecer conhecido",
     "| awk '!/_test\\.ts$/' | sort -u > \"$tmp/todos\"",
     '| sort -u > "$tmp/todos"',
     "secret citado só em _test.ts do universo NÃO vira conhecido", "secrets", "não"),
]

falha = 0
if not falsify:
    diverg = 0
    for c in cases:
        got, exp = roda(c), dict(c["expect"])
        ok = (got == exp)
        if not ok:
            diverg += 1
            print(f"  [XX ] {c['name']}\n        esperado {exp}\n        obtido   {got}")
        else:
            print(f"  [ok ] {c['name']}")
    print(f"{len(cases) - diverg}/{len(cases)} passaram")
    falha = 1 if diverg else 0
else:
    # CONTROLE VERDE na MESMA invocação, por locale, ANTES de sabotar: o classify.sh íntegro bate o
    # gabarito em TODOS os casos, com rc 0 e stderr vazio. Sem ele, um classify sempre-errado passaria
    # no (a) — que só compara com o gabarito SABOTADO — e em toda mutação do (b).
    LOCALES = locales()
    cegas = []
    for loc in LOCALES:
        for c in cases:
            got, rc, err = roda_bruto(c, "classify.sh", loc)
            if got != c["expect"] or rc != 0 or err:
                cegas.append(f"CONTROLE VERMELHO (LC_ALL={loc}) em '{c['name']}': rc={rc} obtido {got}")
    if cegas:
        for c in cegas:
            print(f"    [XX ] {c}")
        print("--falsify: controle vermelho com o classify.sh ÍNTEGRO — nenhuma sabotagem foi tentada")
        sys.exit(1)
    print(f"  [ok ] controle: {len(cases)} casos batem o gabarito com o classify.sh íntegro "
          f"(locales: {' '.join(LOCALES)})")

    # (a) gabarito sabotado UMA CHAVE POR VEZ — prova que cada chave participa da comparação.
    #     Sabotar todas de uma vez deixaria a 4ª camada carona nas outras três.
    for c in cases:
        got = roda(c)
        if set(got) != set(c["expect"]):
            cegas.append(f"{c['name']}: saída {sorted(got)} ≠ gabarito {sorted(c['expect'])}")
            continue
        for chave, valor in c["expect"].items():
            exp = dict(c["expect"], **{chave: sabota(valor, chave)})
            if got == exp:
                cegas.append(f"{c['name']}: chave '{chave}' sem dente")
    n = len(cases) * 4
    print(f"  gabarito por chave: {n - len(cegas)}/{n} sabotagens pegas")
    for c in cegas:
        print(f"    [XX ] {c}")

    # (b) mutação do classify.sh real — o gabarito acima não cobre isto: ele prova que o eval
    #     compara, não que a lógica tem dente. Cada mutação arranca uma decisão e o caso que ela
    #     DECLARA tem de dar o valor previsto na chave, em cada locale; mutante que morre (rc≠0,
    #     stderr) é erro de execução, e alvo que não aparece EXATAMENTE 1 vez é mutação que não aplicou.
    fonte = open("classify.sh").read()
    por_nome = {c["name"]: c for c in cases}

    def julga_mutacao(nome, de, para, alvo, chave, previsto, mutante):
        """Devolve None se a mutação foi pega PELO PREVISTO; senão, o motivo."""
        if fonte.count(de) != 1:
            return f"NÃO aplicou: o alvo aparece {fonte.count(de)} vez(es) no classify.sh"
        if alvo not in por_nome:
            return f"caso-alvo inexistente: {alvo!r}"
        with open(mutante, "w") as fh:
            fh.write(fonte.replace(de, para, 1))
        if subprocess.run(["bash", "-n", mutante], capture_output=True).returncode != 0:
            return "quebrou a SINTAXE do classify.sh (vermelho pelo motivo errado)"
        errado = []
        for loc in LOCALES:
            got, rc, err = roda_bruto(por_nome[alvo], mutante, loc)
            if rc != 0 or err:
                errado.append(f"{loc}: ERRO de execução rc={rc} {err[:60]}")
            elif got.get(chave) != previsto:
                errado.append(f"{loc}: {chave}={got.get(chave)!r}")
        return f"'{alvo}' não deu {chave}={previsto!r} ({'; '.join(errado)})" if errado else None

    with tempfile.TemporaryDirectory() as td:
        mutante = os.path.join(td, "classify.sh")
        for nome, de, para, alvo, chave, previsto in MUTACOES:
            motivo = julga_mutacao(nome, de, para, alvo, chave, previsto, mutante)
            if motivo is None:
                print(f"  [ok ] mutação pega por '{alvo}' ({chave}={previsto}) em {len(LOCALES)} locale(s): {nome}")
            else:
                cegas.append(f"mutação NÃO pega pelo previsto: {nome} — {motivo}")
                print(f"  [XX ] mutação NÃO pega pelo previsto: {nome} — {motivo}")
        # CONTROLE NEGATIVO DO JUIZ — o gate de reintrodução: um `exit 3` que só DERRUBA o classify.sh
        # (sem sintaxe quebrada) declarando o previsto da 2ª mutação tem de ser RECUSADO.
        negativo = julga_mutacao("juiz-negativo", MUTACOES[1][1], "exit 3; " + MUTACOES[1][1],
                                 MUTACOES[1][3], MUTACOES[1][4], MUTACOES[1][5], mutante)
        if negativo is None:
            cegas.append("controle negativo do juiz: um classify.sh que MORRE foi creditado como dente")
            print("  [XX ] controle negativo do juiz: um CRASH foi creditado — o juiz perdeu a identidade")
        else:
            print("  [ok ] controle negativo do juiz: a mutação que só derruba o classify.sh foi RECUSADA")
    falha = 1 if cegas else 0
    print(f"--falsify: {len(cegas)} cegueira(s) em {len(MUTACOES)} mutação(ões) (esperado: 0)")

sys.exit(falha)
PY
then :; else rc=1; fi

echo ""
echo "== (2) verify-frontend — Passo 4 =="
if [ "$FALSIFY" = 1 ]; then
  bash verify-frontend-eval.sh --falsify || rc=1
else
  bash verify-frontend-eval.sh || rc=1
fi

echo ""
echo "== (3) verify-edge-eco — guard temporal do N3 passivo =="
if [ "$FALSIFY" = 1 ]; then
  bash verify-edge-eco-eval.sh --falsify || rc=1
else
  bash verify-edge-eco-eval.sh || rc=1
fi

echo ""
echo "== (4) verify-edge-escrita — N3 passivo por escrita de aplicação =="
if [ "$FALSIFY" = 1 ]; then
  bash verify-edge-escrita-eval.sh --falsify || rc=1
else
  bash verify-edge-escrita-eval.sh || rc=1
fi

echo ""
# (5) O ÚNICO eval que EXECUTA SQL: o veredito do Passo 2 da sonda de versão decide por semântica
# de NULL e ordem de WHEN, que casamento de string não observa. Sobe um Postgres efêmero (initdb
# local, zero rede — mesmo padrão dos db/test-*.sh) e lê a coluna `veredito` do banco.
# Exit 2 do eval = via de prova não observável; propaga como FALHA de propósito: sem Postgres o
# gate não passa em silêncio (ausência de dado nunca vira aprovação — é a regra que este próprio
# eval guarda no SQL).
echo "== (5) sonda-veredito-401 — 401 ambíguo: bundle velho × CRON_SECRET =="
if [ "$FALSIFY" = 1 ]; then
  bash sonda-veredito-401-eval.sh --falsify || rc=1
else
  bash sonda-veredito-401-eval.sh || rc=1
fi

echo ""
# (6) Prosa que cita CÓDIGO VIVO apodrece calada: o `docs:citacoes` prova que a linha citada
# existe, e mais nada. Este eval EXECUTA o grep do critério — extraído da própria SKILL.md,
# fail-CLOSED se sumir — contra as três edges que ela classifica, e exige o veredito de volta.
echo "== (6) criterio-caro — quem entra no --caro: efeito medido, não forma do handler =="
if [ "$FALSIFY" = 1 ]; then
  bash criterio-caro-eval.sh --falsify || rc=1
else
  bash criterio-caro-eval.sh || rc=1
fi

echo ""
# (7) O irmão PASSIVO do (5): o Passo 3 do /fecho decide quais edges da janela ainda precisam de
# chip, e é ele quem APAGA pendência. O SQL dele ganhou CTE de vínculo, três classes em UNION ALL
# e uma contagem que viaja na mesma resposta — nada disso é legível por grep, e uma CTE quebrada
# derruba o script para exit 2, que vira chip para TODA a janela (o ruído que ele corta). Mora
# aqui, e não na skill `fecho`, porque este é o único agregador de evals que o CI roda: eval fora
# do CI é falsificação que só roda à mão. A suíte de FORMA segue em
# `scripts/test-fecho-edges-pendentes.sh` (rodada por `bun run test:falsificacao`).
echo "== (7) edges-pendentes-sql — classificação do Passo 3 do /fecho, EXECUTANDO o SQL =="
if [ "$FALSIFY" = 1 ]; then
  bash edges-pendentes-sql-eval.sh --falsify || rc=1
else
  bash edges-pendentes-sql-eval.sh || rc=1
fi

echo ""
# (8) O monitor-deploy.sh rebaixa "ATRASADO" para SINCRONIZADO_EM_BUNDLE (exit 5) quando o delta
# ar→main não alcança o bundle — um VERDE novo, e verde novo só vale com prova de cada elo. Roda o
# monitor REAL num repo-fixture com origin bare local e `curl` falso (zero rede, não lê o repo real),
# e casa exit + MARCA do ramo; o --falsify arranca cada elo em cópia e exige o desfecho PREVISTO.
echo "== (8) monitor-deploy — SHA atrás não é bundle atrás (exit 5 só com prova positiva) =="
if [ "$FALSIFY" = 1 ]; then
  bash monitor-deploy-eval.sh --falsify || rc=1
else
  bash monitor-deploy-eval.sh || rc=1
fi

echo ""
# (9) O mesmo monitor responde OUTRA pergunta com `--pr <n>`: o squash do PR está na história do
# commit servido? As armadilhas são as que fabricam "fora do ar" — rc 128 lido como 1, o head do
# branch no lugar do squash (#2459), PR não mergeado, fetch falho, clone raso — e cada uma tem de
# sair exit 6 (não consegui), nunca 3. Harness próprio para não colidir com o (8).
echo "== (9) monitor-deploy --pr — o PR está no ar? (ancestralidade; 'não sei' é exit 6) =="
if [ "$FALSIFY" = 1 ]; then
  bash monitor-deploy-pr-eval.sh --falsify || rc=1
else
  bash monitor-deploy-pr-eval.sh || rc=1
fi

echo ""
if [ "$rc" -eq 0 ]; then echo "✅ evals lovable-deploy-verify: OK"; else echo "❌ evals lovable-deploy-verify: FALHOU"; fi
exit "$rc"
