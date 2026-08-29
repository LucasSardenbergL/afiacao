#!/usr/bin/env bash
# run.sh — GATE de regressão da skill lovable-deploy-verify. Roda os DOIS evals:
#   (1) classify        — classificação de diff do Passo 1 (classify.sh vs classify-eval.json)
#   (2) verify-frontend — enumeração + exit codes do Passo 4 (harness local determinístico)
#   (3) verify-edge-eco  — guard TEMPORAL do N3 passivo (só ticks pré-merge ⇒ indeterminado)
# Exit 0 = tudo passou. Exit 1 = alguma divergência.
# Falsificação (prova que os evals têm dente): --falsify sabota AMBOS e exige vermelho
#   (classify sabota o gabarito UMA CHAVE POR VEZ e depois muta o classify.sh real; verify-frontend
#   sabota a enumeração; verify-edge-eco arranca o guard temporal, o fail-closed do ping e o filtro
#   do tick mais recente). Exit 0 só se pegou tudo.
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

def sabota(valor, chave):
    # `secrets` não é booleano: inverter SIM/não não o tocaria. Sem regra própria, a sabotagem
    # das OUTRAS chaves já bastaria para divergir e a 4ª camada ficaria sem dente.
    if chave == "secrets":
        return "não" if valor != "não" else "POSTHOG_INGEST_KEY"
    return "SIM" if valor == "não" else "não"

# Mutações do classify.sh REAL (cópia em tmp; o versionado nunca é mutado). Cada uma arranca
# uma decisão da 4ª camada e precisa deixar ≥1 caso VERMELHO — se não deixar, o gabarito é cego
# naquele eixo e o eval está passando por acidente.
MUTACOES = [
    ("universo inclui os próprios arquivos tocados (edge se compara consigo mesma)",
     'comm -23 "$tmp/todos" "$tmp/tocados" > "$tmp/universo"',
     'cp "$tmp/todos" "$tmp/universo"'),
    ("nome dinâmico vira silêncio em vez de ?dinamico",
     'if [ "$dinamico" = 1 ]; then',
     'if [ "$dinamico" = 9 ]; then'),
    ("_test.ts tocado conta como código de edge",
     "/^supabase\\/functions\\/.*\\.ts$/ && !/_test\\.ts$/",
     "/^supabase\\/functions\\/.*\\.ts$/"),
    ("não subtrai o universo: todo secret lido vira 'novo'",
     'comm -23 "$tmp/usados" "$tmp/conhecidos" > "$tmp/novos"',
     'cp "$tmp/usados" "$tmp/novos"'),
    ("_test.ts entra no universo e faz secret novo parecer conhecido",
     "| awk '!/_test\\.ts$/' | sort -u > \"$tmp/todos\"",
     '| sort -u > "$tmp/todos"'),
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
    # (a) gabarito sabotado UMA CHAVE POR VEZ — prova que cada chave participa da comparação.
    #     Sabotar todas de uma vez deixaria a 4ª camada carona nas outras três.
    cegas = []
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
    #     compara, não que a lógica tem dente. Aqui a lógica é arrancada e exigimos vermelho.
    fonte = open("classify.sh").read()
    with tempfile.TemporaryDirectory() as td:
        mutante = os.path.join(td, "classify.sh")
        for nome, de, para in MUTACOES:
            if de not in fonte:
                cegas.append(f"mutação NO-OP (alvo sumiu do classify.sh): {nome}")
                print(f"    [XX ] mutação NO-OP: {nome}")
                continue
            with open(mutante, "w") as fh:
                fh.write(fonte.replace(de, para, 1))
            pegou = [c["name"] for c in cases if roda(c, mutante) != c["expect"]]
            if pegou:
                print(f"  [ok ] mutação pega ({len(pegou)} caso(s)): {nome}")
            else:
                cegas.append(f"mutação NÃO pega por nenhum caso: {nome}")
                print(f"  [XX ] mutação passou despercebida: {nome}")
    falha = 1 if cegas else 0
    print(f"--falsify: {len(cegas)} cegueira(s) (esperado: 0)")

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
if [ "$rc" -eq 0 ]; then echo "✅ evals lovable-deploy-verify: OK"; else echo "❌ evals lovable-deploy-verify: FALHOU"; fi
exit "$rc"
