// Baseline do ratchet de cobertura do `test:hooks` (scripts/hooks-guard-cobertura.test.ts).
//
// As suítes `scripts/test-*.sh` que NINGUÉM roda no CI, inventariadas em 2026-08-22 com o
// motivo de cada uma. Burn-down OBRIGATÓRIO: o gate cobra nos DOIS sentidos — suíte nova fora
// dos loops = vermelho, e entrada daqui que voltou a rodar (ou que sumiu do disco) TAMBÉM =
// vermelho, pra lista não apodrecer virando álibi.
//
// Só entra aqui suíte que NÃO PODE rodar no runner ubuntu. "É lenta" ou "dá trabalho" não é
// motivo: teste que existe e não roda é AUSÊNCIA DE DADO, não aprovação.

export type SuiteForaDoCI = {
  /** Nome do arquivo em scripts/, exatamente como está em disco. */
  arquivo: string;
  /** Por que não roda no loop — ou o workflow que a roda no lugar. */
  motivo: string;
};

export const SUITES_FORA_DO_CI: SuiteForaDoCI[] = [
  {
    arquivo: 'test-heavy.sh',
    motivo:
      'macOS-only: exercita o semáforo de RAM real (sysctl/stat -f, BSD) com N processos em ' +
      'disputa — o `heavy` não existe no runner ubuntu (exit 127). Além disso é FLAKY sob carga ' +
      '(medido 2026-08-22: 2 verdes e 1 vermelho em 3 execuções na M2 com 36 sessões vivas) e ' +
      'leva ~50s. Rodar à mão na M2 ao mexer em scripts/heavy.sh.',
  },
  {
    arquivo: 'test-heavy-install.sh',
    motivo:
      'macOS-only: compara inode com `stat -f %i` (BSD). No GNU coreutils do ubuntu `-f` é ' +
      'OUTRA flag (status do FILESYSTEM), então não falha — passa medindo a coisa errada, que é ' +
      'pior que vermelho. Rodar à mão na M2 ao mexer em scripts/heavy-install.sh.',
  },
];
