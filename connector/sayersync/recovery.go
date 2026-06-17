// recovery.go — recuperação de crash-loop de BOOT do conector (Codex F2).
//
// O crash-loop guard de update.go cobre falhas do UPDATER (fetch/download/
// sha256/install). NÃO cobre um binário que passa no sha256 mas PANICA no boot
// (init/main/LoadConfig/cmdRun): o SCM (OnFailure=restart) o relança para sempre
// e o .prev nunca é restaurado, porque o código de restauração vive no MESMO
// binário que não boota. A correção exige um ATOR EXTERNO ao binário que quebra.
//
// Mecanismo (parte cross-platform aqui; syscalls do SCM em recovery_windows.go):
//   - install grava uma CÓPIA estável `sayersync-recovery.exe` (intocada pelo
//     auto-update) e configura a recovery do serviço como
//     [restart, restart, run_command], onde run_command =
//     `sayersync-recovery.exe rollback --target <exe>`.
//   - após N crashes de boot, o SCM roda esse comando num processo FRESCO e BOM
//     (a recovery-copy sempre boota), que restaura o .prev (rename-based) e
//     reinicia o serviço.
//
// Verificação ponta-a-ponta EXIGE um balcão Windows real (semântica do SCM:
// contagem de falhas, dwResetPeriod, execução do run_command).
package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// serviceName é o nome do serviço Windows (deve casar com svcConfig em main.go).
// Usado pelas syscalls de recovery (recovery_windows.go) para abrir o serviço.
const serviceName = "SayerSync"

// recoveryExeName é a cópia estável do binário usada como ATOR do rollback. O
// auto-update NUNCA a substitui, então ela sempre boota — diferente do exe
// principal (que pode estar quebrado) e do .prev (cujo nome `.exe.prev` o SCM
// poderia recusar executar). Fica ao lado do exe principal.
const recoveryExeName = "sayersync-recovery.exe"

// renameRetries/renameBackoff controlam o retry de rename contra
// ERROR_SHARING_VIOLATION transitório no Windows (AV/indexer/teardown do handle
// do processo do serviço que acabou de morrer). Fora do Windows a 1ª tentativa
// sucede. São variáveis para permitir override em testes.
var (
	renameRetries = 5
	renameBackoff = 100 * time.Millisecond
)

// renameWithRetry tenta renomear com backoff — defesa contra sharing violation
// transitória logo após o processo do serviço encerrar.
func renameWithRetry(oldPath, newPath string) error {
	var err error
	for i := 0; i < renameRetries; i++ {
		if err = renameFile(oldPath, newPath); err == nil {
			return nil
		}
		if i < renameRetries-1 {
			time.Sleep(renameBackoff)
		}
	}
	return err
}

// restorePrevTo restaura <targetExe>.prev por cima de targetExe usando RENAME
// (Windows-safe), não cópia: a imagem em uso pode ser renomeada mas não
// sobrescrita. Ordem obrigatória (Codex F3):
//  1. valida o .prev ANTES de tocar no target — sem fonte, não mexe em nada
//     (jamais deixar o serviço sem binário no exePath);
//  2. move o target (binário ruim, possivelmente em uso) para .bad.<ts>
//     (preserva para diagnóstico; o destino fica ausente);
//  3. move o .prev para o target.
//
// Se o passo 3 falhar depois do 2, devolve o .bad ao target (best-effort).
func restorePrevTo(targetExe string) error {
	prevPath := targetExe + ".prev"

	// 1. Valida a fonte antes de qualquer rename destrutivo.
	info, err := os.Stat(prevPath)
	if err != nil {
		return fmt.Errorf("restore: .prev indisponível (%s): %w", prevPath, err)
	}
	if info.Size() == 0 {
		return fmt.Errorf("restore: .prev vazio (%s) — não restaura", prevPath)
	}

	// 2. Move o binário atual (ruim) para .bad.<ts>. Renomear a imagem em uso é
	//    permitido no Windows; sobrescrever não é — por isso o destino fica
	//    ausente antes do passo 3.
	badPath := targetExe + ".bad." + strconv.FormatInt(time.Now().UnixNano(), 10)
	if err := renameWithRetry(targetExe, badPath); err != nil {
		return fmt.Errorf("restore: mover binário atual para .bad: %w", err)
	}

	// 3. Coloca o .prev no lugar do target.
	if err := renameWithRetry(prevPath, targetExe); err != nil {
		// Reverte: devolve o .bad ao target para não deixar o serviço sem binário.
		if rbErr := renameFile(badPath, targetExe); rbErr != nil {
			return fmt.Errorf("restore: mover .prev para target: %w; ROLLBACK FALHOU — exe ficou em %s: %v", err, badPath, rbErr)
		}
		return fmt.Errorf("restore: mover .prev para target (revertido ao binário atual): %w", err)
	}

	return nil
}

// isQuarantined reporta se `version` está quarentenada (causou um rollback) e deve
// ser PULADA pelo auto-update até o manifesto publicar uma versão diferente.
func isQuarantined(version string, st *State) bool {
	return st.QuarantinedVersion != "" && version == st.QuarantinedVersion
}

// buildRollbackCommand monta o lpCommand do SC_ACTION_RUN_COMMAND: o ator é a
// recovery-copy (sempre boota), com caminhos ABSOLUTOS entre aspas (o working dir
// do SCM não é contrato; paths com espaço, ex. "Program Files", precisam de aspas).
// Aspas literais, não %q — %q escaparia os "\" do path Windows.
func buildRollbackCommand(recoveryExe, targetExe string) string {
	return `"` + recoveryExe + `" rollback --target "` + targetExe + `"`
}

// parseTargetFlag extrai o valor de `--target` dos argumentos do subcomando
// rollback (o SCM passa o caminho absoluto do exe a restaurar).
func parseTargetFlag(args []string) string {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--target" {
			return args[i+1]
		}
	}
	return ""
}

// recoveryExePath é o caminho da recovery-copy ao lado do exe principal.
func recoveryExePath(exePath string) string {
	return filepath.Join(filepath.Dir(exePath), recoveryExeName)
}

// ensureRecoveryCopy grava/atualiza a recovery-copy (cópia estável do exe usada
// como ator do rollback). Idempotente: não reescreve se já idêntica. O auto-update
// NUNCA chama esta função — a recovery-copy precisa ficar numa versão boa e estável.
func ensureRecoveryCopy(exePath string) error {
	dst := recoveryExePath(exePath)
	data, err := os.ReadFile(exePath)
	if err != nil {
		return fmt.Errorf("recovery-copy: ler exe atual: %w", err)
	}
	if existing, err := os.ReadFile(dst); err == nil && bytes.Equal(existing, data) {
		return nil // já idêntica — evita I/O e churn de mtime
	}
	if err := os.WriteFile(dst, data, 0755); err != nil { //nolint:gosec
		return fmt.Errorf("recovery-copy: gravar %s: %w", dst, err)
	}
	return nil
}

// ensureRecoveryConfigured garante que o serviço tem a rede de recuperação (as
// failure actions com a 3ª ação run_command) ANTES de um update. Verifica e, se
// divergir, tenta reparar; se o reparo falhar, retorna erro — o chamador PULA o
// update, porque ativar um binário novo sem rollback automático é o que o F2
// proíbe (o os.Exit(90) pós-install passa a depender do SCM para se recuperar). (Codex F5)
func ensureRecoveryConfigured() error {
	exePath, err := executablePath()
	if err != nil {
		return fmt.Errorf("recovery: caminho do exe: %w", err)
	}
	ok, vErr := verifyServiceRecovery(exePath)
	if ok {
		return nil
	}
	if cErr := configureServiceRecovery(exePath); cErr != nil {
		return fmt.Errorf("rede de recuperação ausente e reparo falhou (verify=%v): %w", vErr, cErr)
	}
	logger.Infof("recovery: ações de recovery do serviço (re)configuradas antes do update")
	return nil
}

// As ações de recovery do serviço são syscalls do SCM (recovery_windows.go) por
// trás de variáveis, para permitir override nos testes do gate/wiring. Em produção
// apontam para as implementações reais; fora do Windows, para no-ops/stubs.
// startRecoveredService: o SC_ACTION_RUN_COMMAND do SCM NÃO reinicia o serviço
// sozinho, então o rollback reinicia explicitamente. (Codex)
var (
	configureServiceRecovery = configureServiceRecoveryPlatform
	verifyServiceRecovery    = verifyServiceRecoveryPlatform
	startRecoveredService    = startServicePlatform
)

// doRollback é executado pela recovery-copy (sayersync-recovery.exe) quando o SCM
// detecta crash-loop de boot do binário novo. Roda num processo FRESCO e BOM
// (a recovery-copy nunca é atualizada), então NÃO esbarra na armadilha de
// "o código de restauração vive no binário que não boota". (Codex F2)
//
// Quando o run_command do SCM dispara, o serviço já está DOWN (acabou de crashar),
// então não há concorrência de imagem em uso. Ordem:
//  1. restaura o .prev por cima do targetExe (rename-based);
//  2. quarentena a versão ruim (lida de PendingUpdateVersion) e reseta o guard;
//  3. reinicia o serviço (o SCM não reinicia após run_command).
func doRollback(targetExe string) error {
	st, err := LoadState()
	if err != nil {
		return fmt.Errorf("rollback: carregar state: %w", err)
	}

	// A versão que estava sendo ativada é a candidata a quarentena (capturada
	// antes de limpar PendingUpdateVersion).
	bad := st.PendingUpdateVersion

	// 1. Restaura o binário anterior (last-known-good).
	if err := restorePrevTo(targetExe); err != nil {
		return fmt.Errorf("rollback: %w", err)
	}

	// 2. Quarentena a versão ruim para o auto-update NÃO reinstalá-la amanhã
	//    (brick diário). Reseta o crash-loop guard do updater — o rollback resolveu.
	if bad != "" {
		st.QuarantinedVersion = bad
		logger.Warnf("rollback: versão %q quarentenada após crash-loop de boot", bad)
	}
	st.PendingUpdateVersion = ""
	st.UpdateFailCount = 0
	st.LastUpdateFailure = ""
	if err := SaveState(st); err != nil {
		return fmt.Errorf("rollback: persistir state: %w", err)
	}

	// 3. Reinicia o serviço com o binário restaurado.
	if err := startRecoveredService(); err != nil {
		return fmt.Errorf("rollback: reiniciar serviço: %w", err)
	}

	logger.Infof("rollback: concluído — serviço reiniciado com o binário anterior")
	return nil
}
