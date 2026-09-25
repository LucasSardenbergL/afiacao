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

## Pendências em aberto (fecho da sessão de 2026-09-25)

1. **Rodar no Mac** (o claude-mem só existe lá; a sessão cloud não alcança):
   `cd /Users/lucassardenberg/Projetos/afiacao && git fetch -q origin claude/funny-johnson-d8z2cm && git show FETCH_HEAD:scripts/claude-mem-reanimar.sh > /tmp/claude-mem-reanimar.sh && bash /tmp/claude-mem-reanimar.sh`
   — terminou em `RECUPERADO` = ok; qualquer outra coisa, colar a saída numa sessão.
2. **Atualizar o plugin para ≥ 13.25.3** (≥ 13.24.18 bloqueia 1 prompt por queda em vez de todos):
   `claude plugin marketplace update thedotmack && claude plugin update claude-mem@thedotmack` e reabrir as sessões.
3. **Levar para a `main`** (chip "Levar claude-mem-reanimar e seu laboratório para a main"):
   override de tempos por env para o lab caber no `test:hooks`; registrar no `test:hooks`; apontar
   `docs/agent/skills.md` (linha do claude-mem), `docs/agent/worktrees.md` (item "Vigia acusou
   worker-service.cjs") e `docs/historico/claude-mem-worker-vivo-mas-surdo.md` para o script; e um
   aviso no SessionStart (contador de falhas > 0 ou última observação velha), porque a partir da
   13.24.18 o plugin falha em silêncio.
