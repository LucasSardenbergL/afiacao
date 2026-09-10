# AGENTS.md + gate de paridade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao Codex um `AGENTS.md` na raiz com as armadilhas do repo que se aplicam a ele, gerado do `CLAUDE.md` por script, com gate que impede o arquivo de derivar em silêncio.

**Architecture:** Fonte única é o `CLAUDE.md`. Um gerador determinístico junta um preâmbulo escrito à mão com os bullets da seção "⚠️ Armadilhas recorrentes" **selecionados por allowlist versionada**. O gate não valida conteúdo: ele **regenera e compara** — se `git diff` acusar, alguém editou à mão ou esqueceu de regenerar. Toda armadilha precisa de decisão explícita (`INCLUIR` ou `IGNORAR # motivo`); silêncio é CI vermelho.

**Tech Stack:** bash + awk/perl (mesmo ferramental de `scripts/check-claude-md-budget.sh`), sem dependência nova.

## Global Constraints

- Idioma de todo texto novo: **português brasileiro**.
- `AGENTS.md` teto **10.240 bytes** (10 KB), medido em bytes.
- Shell: `set -u`, `-v ON_ERROR_STOP=1` onde houver psql (não há aqui), marcador positivo de fim em script de teste.
- Todo script novo em `scripts/` entra no `lint:shell` (shellcheck) — rode antes de commitar.
- Exit codes seguem o molde do repo: `2` = gate reprovou, `3` = estado inconsistente, `64` = uso errado.
- O `AGENTS.md` carrega **regras genéricas**, nunca respostas de caso (`#1483`, nomes de PR) — a spec §3 explica por quê (envenenaria a medição futura).

---

### Task 1: Extrair âncoras do CLAUDE.md

**Files:**
- Create: `scripts/lib-agents-md.sh`
- Test: `scripts/test-agents-md-paridade.sh`

**Interfaces:**
- Produces: `ancoras_do_claude_md <arquivo>` — imprime uma âncora por linha, na ordem do arquivo. Âncora = conteúdo do **primeiro** `**...**` de cada bullet de nível 1 da seção "⚠️ Armadilhas recorrentes".

- [ ] **Step 1: Escrever o teste que falha**

Crie `scripts/test-agents-md-paridade.sh`:

```bash
#!/usr/bin/env bash
# test-agents-md-paridade.sh — suíte do gerador/gate do AGENTS.md.
set -u
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
ok=0; ruim=0

esperar() { # esperar "nome" "esperado" "obtido"
  if [ "$2" = "$3" ]; then ok=$((ok+1)); else
    ruim=$((ruim+1)); printf '  ❌ %s\n     esperado: [%s]\n     obtido:   [%s]\n' "$1" "$2" "$3" >&2
  fi
}

# shellcheck source=scripts/lib-agents-md.sh
. scripts/lib-agents-md.sh

cat > "$tmp/claude.md" <<'FIM'
# Titulo

## ⚠️ Armadilhas recorrentes (caras)

- **Primeira armadilha:** corpo com **negrito extra** que não é âncora.
- **Segunda armadilha** sem dois-pontos, com `código` no meio.

## Outra seção

- **Não é armadilha:** este bullet está fora da seção.
FIM

esperar "extrai 2 âncoras, ignora negrito interno e outras seções" \
  "Primeira armadilha:
Segunda armadilha" \
  "$(ancoras_do_claude_md "$tmp/claude.md")"

if [ "$ruim" -gt 0 ]; then
  echo "❌ test-agents-md-paridade: $ruim falha(s) em $((ok + ruim)) asserções" >&2; exit 1
fi
echo "✅ test-agents-md-paridade: $ok asserções OK"
```

- [ ] **Step 2: Rodar e verificar que falha**

```bash
bash scripts/test-agents-md-paridade.sh
```

Esperado: FALHA com `No such file or directory` em `scripts/lib-agents-md.sh`.

- [ ] **Step 3: Implementar o extrator**

Crie `scripts/lib-agents-md.sh`:

```bash
#!/usr/bin/env bash
# lib-agents-md.sh — funções compartilhadas pelo gerador e pelo gate do AGENTS.md.
# Não executa nada ao ser carregado (é `source`-ado por 3 scripts).

SECAO_ARMADILHAS='## ⚠️ Armadilhas recorrentes'

# ancoras_do_claude_md <arquivo> — uma âncora por linha, na ordem do arquivo.
ancoras_do_claude_md() {
  perl -ne '
    if (/^\Q'"$SECAO_ARMADILHAS"'\E/) { $dentro = 1; next }
    if ($dentro && /^## /) { $dentro = 0 }
    next unless $dentro;
    next unless /^- \*\*(.+?)\*\*/;
    print "$1\n";
  ' "$1"
}
```

- [ ] **Step 4: Rodar e verificar que passa**

```bash
bash scripts/test-agents-md-paridade.sh
```

Esperado: `✅ test-agents-md-paridade: 1 asserções OK`

- [ ] **Step 5: Commit**

```bash
git add scripts/lib-agents-md.sh scripts/test-agents-md-paridade.sh
git commit -m "feat(agents): extrator de âncoras das armadilhas do CLAUDE.md"
```

---

### Task 2: Allowlist com decisão obrigatória

**Files:**
- Create: `scripts/agents-md-armadilhas.txt`
- Modify: `scripts/lib-agents-md.sh`
- Test: `scripts/test-agents-md-paridade.sh`

**Interfaces:**
- Consumes: `ancoras_do_claude_md` (Task 1)
- Produces: `decisao_da_ancora <allowlist> <âncora>` — imprime `INCLUIR`, `IGNORAR` ou `AUSENTE`.

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `scripts/test-agents-md-paridade.sh`, **antes** do bloco `if [ "$ruim" -gt 0 ]`:

```bash
cat > "$tmp/allow.txt" <<'FIM'
# comentário é ignorado
INCLUIR | Primeira armadilha:
IGNORAR | Segunda armadilha # Codex não faz deploy
FIM

esperar "âncora marcada INCLUIR" "INCLUIR" "$(decisao_da_ancora "$tmp/allow.txt" 'Primeira armadilha:')"
esperar "âncora marcada IGNORAR" "IGNORAR" "$(decisao_da_ancora "$tmp/allow.txt" 'Segunda armadilha')"
esperar "âncora sem entrada é AUSENTE" "AUSENTE" "$(decisao_da_ancora "$tmp/allow.txt" 'Terceira armadilha')"
esperar "âncora com regex dentro não casa por engano" "AUSENTE" "$(decisao_da_ancora "$tmp/allow.txt" 'Primeira.armadilha:')"
```

- [ ] **Step 2: Rodar e verificar que falha**

```bash
bash scripts/test-agents-md-paridade.sh
```

Esperado: FALHA — `decisao_da_ancora: command not found`.

- [ ] **Step 3: Implementar**

Acrescente a `scripts/lib-agents-md.sh`:

```bash
# decisao_da_ancora <allowlist> <âncora> — INCLUIR | IGNORAR | AUSENTE.
# Compara por igualdade LITERAL (não regex): âncora com `.` ou `*` não pode casar vizinha.
decisao_da_ancora() {
  awk -v alvo="$2" '
    /^[[:space:]]*#/ { next }
    /\|/ {
      d = $0; sub(/\|.*/, "", d); gsub(/[[:space:]]+$/, "", d); gsub(/^[[:space:]]+/, "", d)
      a = $0; sub(/^[^|]*\|[[:space:]]*/, "", a); sub(/[[:space:]]*#.*/, "", a)
      gsub(/[[:space:]]+$/, "", a)
      if (a == alvo) { print d; achou = 1; exit }
    }
    END { if (!achou) print "AUSENTE" }
  ' "$1"
}
```

- [ ] **Step 4: Rodar e verificar que passa**

```bash
bash scripts/test-agents-md-paridade.sh
```

Esperado: `✅ test-agents-md-paridade: 5 asserções OK`

- [ ] **Step 5: Criar a allowlist real**

```bash
bash -c '. scripts/lib-agents-md.sh; ancoras_do_claude_md CLAUDE.md' | \
  awk '{ print "INCLUIR | " $0 }' > scripts/agents-md-armadilhas.txt
```

Depois **edite à mão**: troque para `IGNORAR | <âncora> # <motivo>` toda armadilha que o Codex nunca aciona (deploy Lovable, worktrees/multi-sessão, `/compact`, chips, ledger de deploy). Motivo após `#` é **obrigatório** — é o que se lê no diff daqui a seis meses.

Acrescente o cabeçalho no topo do arquivo:

```
# Allowlist do AGENTS.md — decide o que do CLAUDE.md o Codex enxerga.
# INCLUIR = copia o bullet · IGNORAR = fica de fora, motivo obrigatório após `#`.
# Armadilha SEM entrada aqui = CI vermelho (silêncio não é decisão).
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib-agents-md.sh scripts/agents-md-armadilhas.txt scripts/test-agents-md-paridade.sh
git commit -m "feat(agents): allowlist com decisão obrigatória por armadilha"
```

---

### Task 3: Gerador do AGENTS.md

**Files:**
- Create: `AGENTS.preambulo.md`
- Create: `scripts/gerar-agents-md.sh`
- Create: `AGENTS.md` (saída, versionada)
- Test: `scripts/test-agents-md-paridade.sh`

**Interfaces:**
- Consumes: `ancoras_do_claude_md`, `decisao_da_ancora`
- Produces: `bash scripts/gerar-agents-md.sh [--saida ARQUIVO]` — escreve o `AGENTS.md`; exit `3` se alguma âncora estiver `AUSENTE` da allowlist.

- [ ] **Step 1: Escrever o preâmbulo à mão**

Crie `AGENTS.preambulo.md`. Este arquivo é a única parte editada à mão:

```markdown
# AGENTS.md — repo Afiação (ERP B2B Sardenberg)

Você foi chamado como **revisor independente**. Quem escreveu o código é outro agente; seu valor está em refutar, não em concordar.

## Proibições

- **NUNCA abra `supabase/schema-snapshot.sql`** (~36k linhas — já travou uma sessão inteira). Fatos de schema chegam no próprio prompt.
- Não proponha rodar comando que escreva no repo, no banco ou na rede: você roda em sandbox read-only.

## A barra deste repo

Um achado só conta com **localização** (`arquivo:linha`), **impacto** (o que quebra, para quem), **contraexemplo** (entrada concreta que produz o erro) e **evidência** (o que você verificou versus o que supôs).

- Hipótese declarada como hipótese não é demérito — hipótese vendida como fato é.
- **Zero achados é resposta válida e bem-vinda.** Objeção inventada para parecer rigoroso custa mais caro que silêncio: alguém vai gastar uma hora investigando.
- Severidade sem denominador não é severidade. "Afeta 3 de 12.000 pedidos" é útil; "crítico" sozinho não é.
- **Money-path** = qualquer código que produza número que vá para tela de cliente, cobrança, estoque ou decisão de compra. Nele, precisão vale mais que recall, e valor ausente **nunca** vira zero.

## Armadilhas já pagas neste repo

O que segue foi destilado de defeitos reais que chegaram a produção. São regras genéricas — aplique-as ao código que você está vendo agora.
```

- [ ] **Step 2: Escrever o teste que falha**

Acrescente à suíte, antes do bloco final:

```bash
cat > "$tmp/preambulo.md" <<'FIM'
# Preambulo
FIM

saida="$(CLAUDE_MD="$tmp/claude.md" ALLOWLIST="$tmp/allow.txt" PREAMBULO="$tmp/preambulo.md" \
  bash scripts/gerar-agents-md.sh --saida "$tmp/out.md" >/dev/null 2>&1; echo "rc=$?")"
esperar "gerador roda com allowlist completa" "rc=0" "$saida"
esperar "inclui a marcada INCLUIR" "1" "$(grep -c 'Primeira armadilha' "$tmp/out.md")"
esperar "exclui a marcada IGNORAR"  "0" "$(grep -c 'Segunda armadilha'  "$tmp/out.md")"
esperar "preserva o preâmbulo"      "1" "$(grep -c '^# Preambulo'       "$tmp/out.md")"

cat > "$tmp/allow-incompleta.txt" <<'FIM'
INCLUIR | Primeira armadilha:
FIM
rc="$(CLAUDE_MD="$tmp/claude.md" ALLOWLIST="$tmp/allow-incompleta.txt" PREAMBULO="$tmp/preambulo.md" \
  bash scripts/gerar-agents-md.sh --saida "$tmp/out2.md" >/dev/null 2>&1; echo "$?")"
esperar "armadilha AUSENTE da allowlist reprova com 3" "3" "$rc"
```

- [ ] **Step 3: Rodar e verificar que falha**

```bash
bash scripts/test-agents-md-paridade.sh
```

Esperado: FALHA — o gerador ainda não existe (`rc=127`).

- [ ] **Step 4: Implementar o gerador**

Crie `scripts/gerar-agents-md.sh`:

```bash
#!/usr/bin/env bash
# gerar-agents-md.sh — monta o AGENTS.md a partir do preâmbulo + armadilhas selecionadas.
#
# O AGENTS.md NÃO se edita à mão: edite o CLAUDE.md (conteúdo) ou a allowlist (seleção)
# e rode este script. O gate `agents:paridade` regenera e compara.
set -u
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib-agents-md.sh
. scripts/lib-agents-md.sh

CLAUDE_MD="${CLAUDE_MD:-CLAUDE.md}"
ALLOWLIST="${ALLOWLIST:-scripts/agents-md-armadilhas.txt}"
PREAMBULO="${PREAMBULO:-AGENTS.preambulo.md}"
saida="AGENTS.md"

while [ $# -gt 0 ]; do
  case "$1" in
    --saida) saida="${2:?--saida exige caminho}"; shift 2 ;;
    -h|--help) echo "uso: $0 [--saida ARQUIVO]"; exit 0 ;;
    *) echo "❌ flag desconhecida: $1" >&2; exit 64 ;;
  esac
done

for f in "$CLAUDE_MD" "$ALLOWLIST" "$PREAMBULO"; do
  [ -r "$f" ] || { echo "❌ não consigo ler: $f" >&2; exit 3; }
done

ausentes=""
while IFS= read -r ancora; do
  [ -n "$ancora" ] || continue
  [ "$(decisao_da_ancora "$ALLOWLIST" "$ancora")" = "AUSENTE" ] && ausentes="$ausentes  - $ancora"$'\n'
done < <(ancoras_do_claude_md "$CLAUDE_MD")

if [ -n "$ausentes" ]; then
  {
    echo "❌ armadilha do CLAUDE.md sem decisão na allowlist:"
    printf '%s' "$ausentes"
    echo "   → acrescente 'INCLUIR | <âncora>' ou 'IGNORAR | <âncora> # <motivo>' em $ALLOWLIST"
    echo "   (silêncio não é decisão: o Codex ficaria cego sem ninguém notar)"
  } >&2
  exit 3
fi

{
  cat "$PREAMBULO"
  echo
  perl -e '
    my ($claude, $allow, $secao) = @ARGV;
    my %dec;
    open my $a, "<:encoding(UTF-8)", $allow or die;
    while (<$a>) {
      next if /^\s*#/;
      next unless /^\s*(INCLUIR|IGNORAR)\s*\|\s*(.+?)\s*(?:#.*)?$/;
      $dec{$2} = $1;
    }
    open my $c, "<:encoding(UTF-8)", $claude or die;
    my ($dentro, $bullet, $ancora) = (0, "", "");
    my $emitir = sub {
      return unless length $bullet;
      print $bullet if ($dec{$ancora} // "") eq "INCLUIR";
      ($bullet, $ancora) = ("", "");
    };
    while (my $l = <$c>) {
      if ($l =~ /^\Q$secao\E/) { $dentro = 1; next }
      if ($dentro && $l =~ /^## /) { $emitir->(); last }
      next unless $dentro;
      if ($l =~ /^- \*\*(.+?)\*\*/) { $emitir->(); $ancora = $1; $bullet = $l }
      elsif (length $bullet) { $bullet .= $l }
    }
    $emitir->();
  ' "$CLAUDE_MD" "$ALLOWLIST" "$SECAO_ARMADILHAS"
} > "$saida"

echo "✅ $saida gerado ($(wc -c < "$saida" | tr -d ' ') bytes)"
```

- [ ] **Step 5: Rodar e verificar que passa**

```bash
bash scripts/test-agents-md-paridade.sh
```

Esperado: `✅ test-agents-md-paridade: 11 asserções OK`

- [ ] **Step 6: Gerar o AGENTS.md real e conferir o teto**

```bash
bash scripts/gerar-agents-md.sh && wc -c AGENTS.md
```

Esperado: `✅ AGENTS.md gerado (N bytes)` com **N ≤ 10240**. Se estourar, marque mais armadilhas como `IGNORAR` com motivo — não suba o teto sem discutir.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.preambulo.md scripts/gerar-agents-md.sh AGENTS.md scripts/test-agents-md-paridade.sh
git commit -m "feat(agents): gerador do AGENTS.md a partir do CLAUDE.md"
```

---

### Task 4: Gate de paridade + falsificação

**Files:**
- Create: `scripts/check-agents-md-paridade.sh`
- Modify: `package.json`
- Test: `scripts/test-agents-md-paridade.sh`

**Interfaces:**
- Consumes: `scripts/gerar-agents-md.sh`
- Produces: `bash scripts/check-agents-md-paridade.sh` — exit `0` limpo, `2` divergiu/estourou teto, `3` allowlist incompleta.

- [ ] **Step 1: Escrever o teste que falha**

Acrescente à suíte:

```bash
cp AGENTS.md "$tmp/fiel.md"
rc="$(AGENTS_MD="$tmp/fiel.md" bash scripts/check-agents-md-paridade.sh >/dev/null 2>&1; echo $?)"
esperar "gate verde na cópia fiel (CONTROLE)" "0" "$rc"

cp AGENTS.md "$tmp/sujo.md"; printf '\nlinha editada à mão\n' >> "$tmp/sujo.md"
rc="$(AGENTS_MD="$tmp/sujo.md" bash scripts/check-agents-md-paridade.sh >/dev/null 2>&1; echo $?)"
esperar "gate reprova AGENTS.md editado à mão" "2" "$rc"
```

> **Ordem importa:** o controle verde roda **antes** da sabotagem, na mesma invocação. Gate sempre-vermelho aprova tudo — é a lição de `docs/historico/falsificacao-sem-linha-de-base.md`.
> **A suíte nunca escreve no `AGENTS.md` versionado** — opera em cópias sob `$tmp`. Suíte que suja a árvore deixa resíduo quando morre no meio, e o próximo `git add -A` o commita.

- [ ] **Step 2: Rodar e verificar que falha**

```bash
bash scripts/test-agents-md-paridade.sh
```

Esperado: FALHA — gate ainda não existe (`rc=127`).

- [ ] **Step 3: Implementar o gate**

Crie `scripts/check-agents-md-paridade.sh`:

```bash
#!/usr/bin/env bash
# check-agents-md-paridade.sh — o AGENTS.md versionado é EXATAMENTE o que o gerador produz hoje?
#
# Não valida conteúdo: regenera e compara. Pega os dois modos de deriva —
# editar o AGENTS.md à mão, e mudar o CLAUDE.md sem regenerar.
set -u
cd "$(dirname "$0")/.."
MAX_BYTES=10240
alvo="${AGENTS_MD:-AGENTS.md}"   # parametrizado só para a suíte testar sem sujar a árvore

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

if ! bash scripts/gerar-agents-md.sh --saida "$tmp/AGENTS.md" >/dev/null 2>"$tmp/err"; then
  rc=$?
  cat "$tmp/err" >&2
  exit "$rc"   # 3 = allowlist incompleta, preserva o código do gerador
fi

if ! diff -u "$alvo" "$tmp/AGENTS.md" > "$tmp/diff"; then
  {
    echo "❌ AGENTS.md divergiu do que o gerador produz."
    head -40 "$tmp/diff"
    echo "   → rode \`bun run agents:gerar\` e COMMITE o AGENTS.md (não edite o arquivo à mão)"
  } >&2
  exit 2
fi

bytes="$(wc -c < "$alvo" | tr -d ' ')"
if [ "$bytes" -gt "$MAX_BYTES" ]; then
  {
    echo "❌ AGENTS.md com $bytes bytes, teto $MAX_BYTES."
    echo "   → marque armadilha como \`IGNORAR | <âncora> # <motivo>\` em scripts/agents-md-armadilhas.txt"
    echo "   (subir o teto é decisão de produto: o arquivo é lido em TODA chamada ao Codex)"
  } >&2
  exit 2
fi

echo "✅ $alvo em paridade com o CLAUDE.md ($bytes bytes, teto $MAX_BYTES)"
```

- [ ] **Step 4: Rodar e verificar que passa**

```bash
bash scripts/test-agents-md-paridade.sh
```

Esperado: `✅ test-agents-md-paridade: 13 asserções OK`

- [ ] **Step 5: Falsificar o gate de verdade**

Prove que o gate pega o modo de falha que mais importa — `CLAUDE.md` mudou e ninguém regenerou:

```bash
cp CLAUDE.md /tmp/claude-backup.md
printf '\n- **Armadilha inventada para falsificar:** texto qualquer.\n' >> CLAUDE.md
bash scripts/check-agents-md-paridade.sh; echo "EXIT=$?"
cp /tmp/claude-backup.md CLAUDE.md
bash scripts/check-agents-md-paridade.sh; echo "EXIT_RESTAURADO=$?"
```

Esperado: `EXIT=3` (âncora nova sem decisão na allowlist) e depois `EXIT_RESTAURADO=0`.

> Se o primeiro sair `0`, o gate está cego — **pare e conserte**. Um gate que não reprova aqui não protege nada.
>
> Repare que a sabotagem foi no `CLAUDE.md`, arquivo **commitado**: `cp` restaura. Nunca sabote arquivo não commitado.

- [ ] **Step 6: Registrar no package.json**

Acrescente aos `scripts`:

```json
"agents:gerar": "bash scripts/gerar-agents-md.sh",
"agents:paridade": "bash scripts/check-agents-md-paridade.sh",
```

E no `test:hooks`, acrescente `agents-md-paridade` ao **segundo** laço (o dos `scripts/test-$t.sh`), logo após `claude-md-budget`:

```
... codex-async claude-md-budget agents-md-paridade hooks-sessionstart ...
```

- [ ] **Step 7: Rodar a suíte completa e o shellcheck**

```bash
bun run test:hooks 2>&1 | tail -20 && bun run lint:shell
```

Esperado: ambos terminam com exit 0. Confirme que a linha `✅ test-agents-md-paridade` **apareceu** na saída — ausência de erro não prova que a suíte rodou.

- [ ] **Step 8: Commit**

```bash
git add scripts/check-agents-md-paridade.sh package.json scripts/test-agents-md-paridade.sh
git commit -m "feat(agents): gate de paridade AGENTS.md e registro no test:hooks"
```

---

## Verificação final

- [ ] `bun run agents:paridade` sai 0 e imprime a contagem de bytes.
- [ ] `bun run test:hooks` sai 0 **e** a linha `✅ test-agents-md-paridade` aparece.
- [ ] `bun run lint:shell` sai 0.
- [ ] Sabotagem do Step 5 da Task 4 reproduz `EXIT=3` seguido de `EXIT_RESTAURADO=0`.
- [ ] `AGENTS.md` ≤ 10.240 bytes.
- [ ] Nenhuma armadilha `IGNORAR` sem motivo após `#`.
- [ ] Sanidade de conteúdo: `grep -c '#[0-9]\{3,\}' AGENTS.md` deve ser **0** — número de PR é resposta de caso, e a spec §3 proíbe (envenenaria a medição futura).
