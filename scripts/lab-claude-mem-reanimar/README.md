# Laboratório do `scripts/claude-mem-reanimar.sh`

Prova o script de reanimação do worker do claude-mem **sem** tocar no claude-mem real: um plugin
falso (`fake/`) com worker controlável, instalado num `HOME` descartável por cenário, tudo num
diretório temporário (nada fica no repo).

**Roda no Linux (CI) e no macOS** (onde o script é usado de verdade), com bash 3.2+. Precisa de
`python3`, `node`, `curl`, `lsof`, `sqlite3` e `pkill`; no Linux, também do `prctl` (subreaper).
Quem roda no `test:hooks` e no `test:falsificacao` é o wrapper, que sonda cada ferramenta antes
(ausente **reprova**, nunca pula) e exige o marcador além do exit 0:

```bash
bash scripts/test-claude-mem-reanimar.sh               # LAB-VERDE: 17 cenários (~50 s no M2)
bash scripts/test-claude-mem-reanimar.sh --falsificar  # FALSIFICACAO-VERDE: 12 guardas
bash scripts/lab-claude-mem-reanimar/lab.sh c_surdo_sim  # um cenário (no Linux: sob subreaper.py)
```

## Como cabe no CI

- **Tempos por env, só de teste:** o script aceita `REANIMAR_TESTE_IDADE_MIN_S`, `_SONDA_S`,
  `_ESPERA_S`, `_PROVA_S` e `_DIAGNOSTICO_S` (defaults 60/5/2/30/3 — a receita). O lab usa
  8/1/0/5/1 e avisa `MODO TESTE` na saída; o cenário `c_saudavel` roda com os tempos REAIS e
  exige que o aviso NÃO apareça. Override que não é inteiro ≥ mínimo **para** o script
  (`c_tempo_invalido`): num script que mata processo, override quebrado não vira fail-OPEN.
- **Faixas paralelas:** cada cenário tem porta (`LAB_PORTA_BASE`+k) e HOME próprios, então
  rodam em 4 faixas (`LAB_FAIXAS`). Cada um termina com a linha `CONTAGEM`; sem ela, o cenário
  não terminou e conta como falha. Os que precisam de worker "velho" (> idade mínima) sobem o
  worker no início e envelhecem enquanto os outros rodam.
- **Portas fixas** a partir de 37780: duas execuções simultâneas precisam de bases diferentes
  (a falsificação usa uma por execução); porta ocupada **reprova** o cenário, nunca pula.

## Por que cada peça

- **`com_tty.py`:** o script confirma lendo `/dev/tty` (nunca decide matar lendo pipe). O
  `script(1)` do util-linux não existe no macOS, o do macOS manda o EOF antes da resposta
  (medido: o `read` lia vazio), e o `pty.spawn` do python 3.9 da Command Line Tools trava num
  `select` vazio quando o filho sai. O helper tem teto: pendurou → mata o grupo e sai 124.
- **`desanexa.py`:** `setsid` portátil — o worker falso sobe desanexado como o real, e é o
  pgid próprio dele que o `arvore()` do script usa para achar os filhos.
- **`::1` como "outro endereço":** o `127.0.0.2` não existe no macOS. `c_host_config` prova o
  host entre colchetes (`[::1]`) e `c_incoerente` o worker escutando num endereço que a sonda
  não alcança; sem `::1`, os dois **reprovam** (não pulam).
- **`subreaper.py` (só Linux):** em container, o PID 1 costuma não recolher zumbis, e aí
  `kill -0` acusa como vivo um processo que já morreu. No macOS quem recolhe é o `launchd`.
- **`package.json` CommonJS em cada HOME:** o fake usa `require()`; se o `TMPDIR` cair dentro
  de um repo `"type": "module"`, o marcador o mantém CommonJS.

## Falsificação (`falsifica.sh`)

Cada guarda do script é sabotada **uma** por vez com `sed` e o cenário que a vigia tem de ficar
vermelho **com a FALHA esperada daquela guarda** (vermelho por outro motivo não conta). Antes do
1º `sed`, o **controle** — a mesma invocação, cópia do alvo, os mesmos cenários — tem de sair
`LAB-VERDE`; senão aborta. Roda em `C` e em `pt_BR.UTF-8` quando o locale existe (no runner
Ubuntu não existe, e a saída diz isso). Sabotagens: ordenação lexicográfica · `.orphaned_at`
ignorado · porta alheia vira nossa · árvore só com a raiz · confirmação ignorada ·
`--so-olhar` ignorado · sem a guarda SUBINDO · prova frouxa · curl quebrado vira surdo · sonda
ignora o host · sem a trava INCOERENTE · override de tempo inválido aceito.

**Cenários:** saudável (tempos reais) · morto · pid reciclado · surdo (confirma / cancela /
`--so-olhar`) · porta de outro programa · curl quebrado · start que não sobe · subindo · hook
falha com worker saudável · host configurado (`::1`) · não-pronto → restart · restart ignorado
→ derruba · vivo sem porta · incoerente · tempo de teste inválido.

Contexto: `docs/historico/claude-mem-worker-vivo-mas-surdo.md` (05/09, recorrência de 24/09 e o
achado de 25/09). O sensor que avisa no SessionStart é outra peça: `scripts/claude-mem-saude.sh`.
