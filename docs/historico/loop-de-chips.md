# Loop de chips — o `/fecho` abria a sessão seguinte, e 55% dos chips eram meta de passagem

**2026-09-28/29.** O founder perguntou: *"Porque quando rodamos o fecho é dificil uma sessao nao
abrir um chip? [...] parece que estou em um loop infinito de chip e nao consigo testar outras coisas
no codigo"*. E em seguida: *"você não consegue resolver ele só ao longo da própria sessão [...]?
Conseguimos evitar esses problemas já tomando algumas prerrogativas durante a construção do código."*

## A medição (transcrições + git, julho → 28/09)

Método: `spawn_task` extraído de `~/.claude/projects/*afiacao*/*.jsonl`; uma sessão "nasceu de chip"
quando a 1ª mensagem dela contém o começo (160 caracteres normalizados) do prompt de um `spawn_task`
anterior de OUTRA sessão. Um elo da cadeia foi conferido à mão; a taxa de clique medida (63%) bate
com a medição independente de 08/09 (65%, `chips-duplicados-por-estado-compartilhado.md`). As
transcrições de julho foram parcialmente podadas — o git é completo e mostra a mesma virada.

| | |
|---|---|
| Sessões desde julho | 848 |
| Nascidas de chip | **691 (81%)** — só 157 iniciadas pelo founder |
| R (chips clicados por sessão) | ~0,9 no pico (S33–S37) · 0,58 em S39 |
| Sessão de chip × sessão do founder | 1,34 × 0,87 chips/sessão; fecham sem chip 29% × 57% |
| Maior cadeia chip → sessão → chip | 28 gerações |
| Commits só-meta na main | 18–43%/semana em julho → 67–75% desde S34 (S39: 23 produto × 65 só-meta) |

**Linha do tempo.** 18/07: o `/fecho` ganha *"Pendência sem DESTINO não existe"* — e os opcionais
"viram chip". Em ~3 semanas as sessões nascidas de chip vão de 12% a 92% (o tempo de as gerações se
acumularem). 26/08 (#2042): o passo 6 passa a exigir *"CLIQUE OS CHIPS e então arquive"* — a semana
seguinte é o pico (96%, R=0,96). 08/09: dedup + retry + "rode, não chipe" derrubam R para ~0,6, sem
tocar o mecanismo.

**O que eram os chips** (150 sorteados dos 235 criados de 09 a 28/09, lidos um a um por subagente;
12 conferidos à mão, 9 concordâncias — nas 3 divergências o subagente foi conservador, então
"própria entrega" está subestimada):

| classe | % | cabia na própria sessão |
|---|---|---|
| M — meta achada de passagem (gate, sensor, CI, falsificação, hook) | 55 | 34 de 82, quase todos conserto de 1 linha |
| D — bug de produto achado de passagem | 22 | 8 de 33 |
| P — terminar a própria entrega | 13 | metade era "rodar o Codex quando a cota voltar" |
| H — continuação da mesma tarefa | 8 | — |
| T — depende de tempo | 2 | — |
| F — só o founder pode fazer | **0** | — |

~60 dos 82 M vinham de 5 máquinas (motor/corpus de exclusividade, mutation-check, ferramental de
deploy/sonda, infra de falsificação em `db/`, wrapper do Codex/hooks), vários causados por máquina
recém-criada por OUTRA sessão. ~16% eram duplicatas de estado compartilhado. Desde 09/09 só 24% dos
chips nasciam no `/fecho` — 76% no meio do trabalho, onde a skill nem está carregada. Caso de produto
evitável na construção: o #2469 passou o total do pedido a líquido do desconto e o cupom impresso
seguiu com preço cheio (*"faltariam R$ 139,91 de explicação no papel"*) — virou chip.

## Por quê — três peças que se encaixam, e a causa de fundo

1. **Chip era o destino mais barato.** Descartar exigia justificar; chip não exigia nada.
2. **O fecho exigia o clique para arquivar** — fechar a sessão A obrigava a abrir a B.
3. **Meta gera meta.** Gate → teste do gate → falsificação → controle da falsificação, sem regra de
   parada: cada camada nova é superfície nova onde achar defeito, e cada defeito virava chip.

**A causa de fundo é conformidade** (apontada pelo Fable): as regras de 18/07 e 26/08 nasceram de
pedidos do founder — *não depender da memória dele*. O objetivo era bom; o efeito colateral foi que
**"não fazer agora" deixou de existir**. Se o pedido voltar, a resposta é este doc: 81%.

## A decisão (Claude + Fable 5.1; o Codex estava sem cota)

O Codex foi consultado duas vezes e não respondeu: sensor de saldo (86% > teto 85%) e, forçado por
decisão do founder, o servidor recusou por cota até 03/10 19:11. O Fable 5.1 fez a 2ª opinião
adversarial (escreveu as 3 mudanças dele ANTES de ler a proposta; conferiu os arquivos e prod
read-only). Veredito dele: **aprovar com mudanças** — as mudanças dele entraram. Por decisão do
founder, aplica-se já e o Codex revisa depois de 03/10 (`sem-codex:` no corpo do PR, sem chip).

**Aplicado (texto, reversível):**

- `/fecho`: chip deixa de gatear o veredito; **descartar em 1 linha** vira destino de primeira classe
  e padrão para meta de passagem; chip **no máximo 1 por sessão**, só para bug de produto/dinheiro
  ou continuação via `/handoff-sessao`; achado sobre a PRÓPRIA entrega é resolvido na sessão; estado
  compartilhado nunca vira chip; Codex sem cota é DRAFT/Caminho B, nunca "rodar depois"; **espelho
  durável (issue) só para chip de produto** — o Fable mostrou (P0) que o espelho de TODO chip não
  clicado era o que alimentava a fila parada: #2614 e #2622 são literalmente "espelho durável do chip".
- `CLAUDE.md`: bullet 🎫 reescrito com o "quando chipar" (vale no meio do trabalho, onde nascem 76%);
  o 1º roadmap da sessão vira a **definição de pronto** (o que entrega · onde mais o comportamento
  aparece · camadas de deploy e quem faz); regra **máquina meta só com incidente**, com o critério do
  Fable em [`docs/agent/maquinas-meta.md`](../agent/maquinas-meta.md) — para onde foram 3 bullets de
  Armadilhas que eram resumo de `docs/historico/` sobre construir máquina meta (aplicar a política
  do arquivo, e tirar do boot de toda sessão ~350 palavras que a induziam a construir máquina).

**Divergências Claude × Fable, decididas pelo Claude (founder pode vetar):**

- Definição de pronto no bullet do roadmap (Claude) × na skill `spec` (Fable: cerimônia sem sensor).
  Ficou no roadmap: é a prerrogativa de construção que o founder pediu, o roadmap já existe em toda
  sessão e o sensor é a re-medição das classes P e D-vizinho.
- Fila de issues no `/fecho`: 1 linha informativa (Claude) × ❌ crítico para money-path parado ≥7d
  (Fable). A fila é estado compartilhado por ~30 worktrees — ❌ em todo fecho recria o loop pelo
  mesmo mecanismo dos 35 chips de 06–08/09. **Fica para o próximo PR** (junto do filtro por label).
- Reforço no `chip-duplicata-guard.sh`: já (Fable) × só se a re-medição mostrar que o texto falhou
  (Claude — aplicar a nós a regra "máquina só com incidente").

**Fora deste PR:** triagem única das 56 issues (27 são sobras; as 3 de "migration não aplicada"
abertas há 3 semanas já estão resolvidas em prod — conferido `reposicao_claim_disparo`) +
`fila-idade.ts` filtrando por label `produto`/`money-path` + a linha informativa no fecho. Poda das
5 máquinas: só se a re-medição mandar (abaixo).

## Como saber se funcionou — 📌 re-medir em ~13/10 (duas semanas)

Rodar o script abaixo (`python3 arvore_chips.py 2026-09-30`) e comparar com este doc:

- sessões nascidas de chip por sessão do founder, e R;
- **nº absoluto** de PRs que tocam produto por semana (o % de commits só-meta infla com squash);
- reclassificar ~100 chips (mesmas classes) — P + D-vizinho medem a definição de pronto.

**Falsificação:** R abaixo de 0,3 mas volume de meta estável ⇒ o problema é o CONTEÚDO das sessões,
não o clique — aí vem a poda das 5 máquinas, numa sessão única, lista fechada, sem chip filho.

## Validação — o mesmo fecho com a regra antiga e com a nova (2026-09-29)

Um cenário de 8 achados (PR entregue; bug no cupom apontado pelo Codex no próprio PR; bug de comissão
fora do escopo; pr-watch atrapalhando por check não obrigatório; ideia de sensor; main vermelha por
outra sessão; edge sem deploy; bug de DRE), rodado por agentes Fable que liam SÓ a cópia da regra:

| | regra antiga | regra nova |
|---|---|---|
| chips | 2 | 1 |
| veredito final | "CLIQUE OS CHIPS e então arquive" | "PODE ARQUIVAR" |
| ideia de sensor | 📌 "vira chip se…" | descartada (meta sem incidente) |
| bug de DRE | chip "por eliminação, não por necessidade" | issue `produto`, sem chip |
| sentiu-se obrigado a chipar | sim | não |

A 1ª rodada da regra nova achou um furo: o 2º bug de produto ficava só numa linha do resumo, que
morre com a sessão arquivada (o texto vetava espelho para o que não fosse chip). Corrigido — todo bug
de produto ganha issue com label; o limite de 1 é do chip — e a re-rodada confirmou: 1 chip, 2 issues
com label, nenhum achado real sem destino durável.

<details><summary>Script da medição (árvore de chips e R)</summary>

```python
"""Árvore de chips: quantos chips cada sessão abre, quantos viram sessão (clicados),
e quantos 'filhos' cada sessão gera (R do processo de ramificação).

Fonte: ~/.claude/projects/*afiacao*/*.jsonl (só sessões-raiz; subagentes ficam em subpastas).
Sessão nascida de chip = 1ª mensagem do usuário contém o início do prompt de um spawn_task.
"""
import glob, json, os, re, sys, collections, datetime as dt

BASE = os.path.expanduser('~/.claude/projects')
DESDE = sys.argv[1] if len(sys.argv) > 1 else '2026-07-13'

def norm(s):
    return re.sub(r'\s+', ' ', s or '').strip()

def walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)

def texto_user(o):
    m = o.get('message') or {}
    c = m.get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        partes = [b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text']
        if any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
            return None
        return '\n'.join(partes) if partes else None
    return None

sessoes = {}   # sid -> dict
chips = []     # dicts
arquivos = glob.glob(os.path.join(BASE, '*afiacao*', '*.jsonl'))
for f in arquivos:
    sid = os.path.basename(f)[:-6]
    s = {'sid': sid, 'wt': os.path.basename(os.path.dirname(f)), 'inicio': None,
         'primeira': None, 'fecho_ts': None, 'n_user': 0}
    try:
        fh = open(f, errors='ignore')
    except OSError:
        continue
    with fh:
        for line in fh:
            if not line.strip():
                continue
            # atalho barato: só parseia linha que pode interessar
            interessa = ('"type":"user"' in line) or ('spawn_task' in line and '"tool_use"' in line) \
                or ('"Skill"' in line and 'fecho' in line) or s['inicio'] is None
            if not interessa:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            ts = o.get('timestamp')
            if ts and s['inicio'] is None:
                s['inicio'] = ts
            if o.get('type') == 'user' and not o.get('isMeta') and not o.get('isSidechain'):
                t = texto_user(o)
                if t is not None:
                    s['n_user'] += 1
                    if s['primeira'] is None and not t.startswith('<local-command') and not t.startswith('Caveat:'):
                        s['primeira'] = t
                    if s['fecho_ts'] is None and ('<command-name>/fecho' in t):
                        s['fecho_ts'] = ts
            if o.get('type') == 'assistant':
                for b in walk(o.get('message') or {}):
                    if b.get('type') != 'tool_use':
                        continue
                    nome = str(b.get('name', ''))
                    inp = b.get('input') or {}
                    if nome.endswith('spawn_task'):
                        chips.append({'sid': sid, 'ts': ts, 'title': inp.get('title', ''),
                                      'prompt': inp.get('prompt', '')})
                    elif nome == 'Skill' and str(inp.get('skill', '')).split(':')[-1] == 'fecho':
                        if s['fecho_ts'] is None:
                            s['fecho_ts'] = ts
    if s['inicio'] and s['inicio'][:10] >= DESDE:
        sessoes[sid] = s

chips = [c for c in chips if c['sid'] in sessoes]

# casamento chip -> sessão filha (1ª msg do usuário contém o começo do prompt)
chave = {}
for i, c in enumerate(chips):
    k = norm(c['prompt'])[:160]
    if len(k) >= 60:
        chave.setdefault(k, []).append(i)
filho_de = {}          # sid_filho -> idx do chip
clicado = set()
for sid, s in sessoes.items():
    p = norm(s['primeira'] or '')
    if not p:
        continue
    for k, idxs in chave.items():
        if k in p[:4000]:
            # o chip tem de ser ANTERIOR à sessão filha e de outra sessão
            cand = [i for i in idxs if chips[i]['sid'] != sid and (chips[i]['ts'] or '') <= (s['inicio'] or 'z')]
            if cand:
                i = max(cand, key=lambda j: chips[j]['ts'] or '')
                filho_de[sid] = i
                clicado.add(i)
                break

# geração de cada sessão
def geracao(sid, prof=0):
    if prof > 60:
        return prof
    if sid not in filho_de:
        return 0
    pai = chips[filho_de[sid]]['sid']
    return 1 + geracao(pai, prof + 1)

ger = {sid: geracao(sid) for sid in sessoes}

def semana(ts):
    d = dt.date.fromisoformat(ts[:10])
    return f"{d.isocalendar()[0]}-S{d.isocalendar()[1]:02d}"

por_sem = collections.defaultdict(lambda: collections.Counter())
for sid, s in sessoes.items():
    w = semana(s['inicio'])
    por_sem[w]['sessoes'] += 1
    if sid in filho_de:
        por_sem[w]['nascidas_de_chip'] += 1
for i, c in enumerate(chips):
    if not c['ts']:
        continue
    w = semana(c['ts'])
    por_sem[w]['chips'] += 1
    if i in clicado:
        por_sem[w]['chips_clicados'] += 1

print(f"== janela: sessões iniciadas desde {DESDE} ==")
print(f"sessões: {len(sessoes)} | chips criados: {len(chips)} | chips que viraram sessão: {len(clicado)}")
nasc = sum(1 for s in sessoes if s in filho_de)
print(f"sessões nascidas de chip: {nasc} ({100*nasc/max(1,len(sessoes)):.0f}%)")
print()
print("semana     sessões  de_chip  %chip   chips  clicados  chips/sessão  filhos/sessão(R)")
for w in sorted(por_sem):
    c = por_sem[w]
    R = c['chips_clicados'] / max(1, c['sessoes'])
    print(f"{w}  {c['sessoes']:7d}  {c['nascidas_de_chip']:7d}  {100*c['nascidas_de_chip']/max(1,c['sessoes']):4.0f}%  "
          f"{c['chips']:6d}  {c['chips_clicados']:8d}  {c['chips']/max(1,c['sessoes']):12.2f}  {R:15.2f}")

# chips por sessão: fundador vs chip
cps = collections.Counter(c['sid'] for c in chips)
for rot, conj in (('nascidas do FOUNDER (ger 0)', [s for s in sessoes if ger[s] == 0]),
                  ('nascidas de CHIP (ger ≥1)', [s for s in sessoes if ger[s] >= 1])):
    n = len(conj)
    tot = sum(cps[s] for s in conj)
    filhos = sum(1 for i in clicado if chips[i]['sid'] in set(conj))
    zero = sum(1 for s in conj if cps[s] == 0)
    print(f"\n{rot}: {n} sessões · {tot/max(1,n):.2f} chips/sessão · {filhos/max(1,n):.2f} filhos clicados/sessão · "
          f"{100*zero/max(1,n):.0f}% fecham SEM chip")

print("\ndistribuição de geração:", dict(sorted(collections.Counter(ger.values()).items())))

# chips nascidos no /fecho
com_fecho = [s for s in sessoes.values() if s['fecho_ts']]
ch_pos = sum(1 for c in chips if sessoes[c['sid']]['fecho_ts'] and (c['ts'] or '') >= sessoes[c['sid']]['fecho_ts'])
ch_tot_fecho = sum(1 for c in chips if sessoes[c['sid']]['fecho_ts'])
print(f"\nsessões que rodaram /fecho: {len(com_fecho)} | chips delas: {ch_tot_fecho} | criados DEPOIS do /fecho: {ch_pos} "
      f"({100*ch_pos/max(1,ch_tot_fecho):.0f}%)")
sem_chip_pos = sum(1 for s in com_fecho if not any(c['sid'] == s['sid'] and (c['ts'] or '') >= s['fecho_ts'] for c in chips))
print(f"sessões com /fecho que fecharam SEM chip novo no fecho: {sem_chip_pos}/{len(com_fecho)}")

# classificação grosseira por título (heurística de palavra-chave)
META = re.compile(r'gate|sensor|sonda|teste|test|falsific|mutante|mutaç|hook|skill|doc|fecho|\bci\b|guard|lint|'
                  r'ledger|prova|vigia|canári|canari|claude\.md|script|regra|stripper|baseline|auditor|varr', re.I)
PROD = re.compile(r'tela|página|pagina|cliente|pedido|estoque|recebimento|picking|vendedor|reposi|financeir|dre|'
                  r'tintom|preço|preco|omie|rota|roteir|farmer|dashboard|relatório|relatorio|ui\b|ux\b|bug', re.I)
def classe(t):
    m, p = bool(META.search(t)), bool(PROD.search(t))
    return 'meta' if m and not p else 'produto' if p and not m else 'misto/indef'
for rot, filtro in (('TODOS os chips', lambda c: True),
                    ('chips abertos por sessão nascida de CHIP', lambda c: ger[c['sid']] >= 1),
                    ('chips abertos por sessão do FOUNDER', lambda c: ger[c['sid']] == 0)):
    sel = [c for c in chips if filtro(c)]
    cc = collections.Counter(classe(c['title']) for c in sel)
    print(f"\n{rot} ({len(sel)}): " + ' · '.join(f"{k} {v} ({100*v/max(1,len(sel)):.0f}%)" for k, v in cc.most_common()))

# maior cadeia
fundo = max(ger, key=lambda s: ger[s]) if ger else None
if fundo:
    cadeia = []
    s = fundo
    while s in filho_de:
        c = chips[filho_de[s]]
        cadeia.append(c['title'])
        s = c['sid']
    print(f"\nmaior cadeia: {ger[fundo]} gerações. Títulos (do mais recente ao mais antigo):")
    for t in cadeia[:12]:
        print('  ←', t[:100])
```

</details>
