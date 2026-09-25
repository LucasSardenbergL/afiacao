# Laboratório do `scripts/claude-mem-reanimar.sh`

Prova o script de reanimação do worker do claude-mem **sem** tocar no claude-mem real: um plugin
falso (`fake/`) com worker controlável, instalado num `HOME` descartável por cenário (`home-*/`,
ignorado pelo git).

**Só Linux** (usa `setsid`, `script` do util-linux, `prctl` e loopback `127.0.0.2`). Precisa de
`node`, `python3`, `curl`, `lsof` e `sqlite3`. Rode de dentro deste diretório:

```bash
python3 subreaper.py bash lab.sh              # 16 cenários (~8 min; 2 esperam 62 s)
python3 subreaper.py bash lab.sh c_surdo_sim  # um cenário
python3 subreaper.py bash falsifica.sh        # 11 sabotagens, controle verde + sabotado vermelho
```

**Por que o `subreaper.py`:** em container, o PID 1 costuma não recolher zumbis, e aí `kill -0`
acusa como vivo um processo que já morreu. No macOS quem recolhe é o `launchd`. O subreaper
reproduz isso (controle medido: sem ele, 1 zumbi; com ele, 0).

**Por que cada `home-*/` ganha um `package.json` CommonJS:** o repo é `"type": "module"`, e o
`bun-runner.js` falso usa `require()`. Sem esse marcador, todo cenário que chama o CLI falso
quebra com erro do Node (foi o que aconteceu na 1ª rodada dentro do repo).

**Estado em 2026-09-24:** 98 asserções verdes em 16 cenários; falsificação 11/11. Ainda **não**
está no CI: para entrar no `test:hooks`, os tempos (idade mínima de 60 s, sondas de 5 s, prova de
30 s) precisam de override por env, senão a suíte leva ~8 min.

**Cenários:** saudável · morto · pid reciclado · surdo (confirma / cancela / `--so-olhar`) ·
porta de outro programa · curl quebrado · start que não sobe · subindo · hook falha com worker
saudável · host configurado · não-pronto → restart · restart ignorado → derruba · vivo sem porta ·
incoerente (dono na porta que a sonda não alcança).

Contexto do incidente: `docs/historico/claude-mem-worker-vivo-mas-surdo.md`.
