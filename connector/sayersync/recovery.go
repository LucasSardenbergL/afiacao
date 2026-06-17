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
		// Reverte com o MESMO retry (a mesma sharing violation transitória que travou
		// o passo acima pode travar este). Devolve o .bad ao target para não deixar o
		// serviço sem binário. (Codex P1)
		if rbErr := renameWithRetry(badPath, targetExe); rbErr != nil {
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

// recoveryCopyHealthy reporta se a recovery-copy (o ATOR do rollback) existe e é
// não-vazia. O gate F5 exige isto além das failure actions: um lpCommand correto
// apontando para um ator ausente (deletado/truncado por AV) faria o SCM rodar nada
// no crash-loop, e o rollback nunca aconteceria.
func recoveryCopyHealthy(exePath string) bool {
	info, err := os.Stat(recoveryExePath(exePath))
	return err == nil && info.Size() > 0
}

// refreshRecoveryCopy escreve a recovery-copy a partir do exe atual SEMPRE (force),
// de forma atômica (tmp + rename — REPLACE_EXISTING no Windows). É o caminho do
// `install` deliberado: um balcão com um ator velho/bugado precisa poder atualizá-lo
// re-rodando o install (o que o README promete). Um write parcial não destrói o ator
// porque o destino só é trocado pelo rename atômico. (Codex P1)
func refreshRecoveryCopy(exePath string) error {
	dst := recoveryExePath(exePath)
	data, err := os.ReadFile(exePath)
	if err != nil {
		return fmt.Errorf("recovery-copy: ler exe atual: %w", err)
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0755); err != nil { //nolint:gosec
		return fmt.Errorf("recovery-copy: gravar tmp: %w", err)
	}
	if err := renameFile(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("recovery-copy: rename atômico para %s: %w", dst, err)
	}
	return nil
}

// ensureRecoveryCopy garante que a recovery-copy existe, PRESERVANDO uma existente e
// não-vazia (o ator conhecido-bom): um repair automático (service start ou pre-update,
// já com um binário novo rodando) não pode trocá-la por algo não comprovado. Só
// (re)cria quando ausente ou vazia (ex.: removida/truncada por AV). O refresh
// deliberado é só no `install` (refreshRecoveryCopy). (Codex P1/P2)
func ensureRecoveryCopy(exePath string) error {
	if recoveryCopyHealthy(exePath) {
		return nil
	}
	return refreshRecoveryCopy(exePath)
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
	actionsOK, vErr := verifyServiceRecovery(exePath)
	// O ator do rollback (recovery-copy) precisa EXISTIR, não só o lpCommand apontá-lo:
	// um ator deletado/truncado por AV faria o SCM rodar nada no crash-loop. (Codex P1)
	if actionsOK && recoveryCopyHealthy(exePath) {
		return nil
	}
	if cErr := configureServiceRecovery(exePath); cErr != nil {
		return fmt.Errorf("rede de recuperação incompleta e reparo falhou (actions_ok=%v verify_err=%v): %w", actionsOK, vErr, cErr)
	}
	// Pós-reparo, o ator do rollback PRECISA existir — senão o update fica sem rede.
	if !recoveryCopyHealthy(exePath) {
		return fmt.Errorf("recovery-copy ausente mesmo após reparo (%s)", recoveryExePath(exePath))
	}
	logger.Infof("recovery: rede de recuperação (re)configurada antes do update")
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
	// 1. PRIMARY: restaura o binário anterior (last-known-good). NÃO depende do state
	//    — um state.json corrompido não pode impedir a recuperação do crash-loop. (Codex P1)
	if err := restorePrevTo(targetExe); err != nil {
		return fmt.Errorf("rollback: %w", err)
	}

	// 2. Best-effort: quarentena a versão ruim (para o updater não reinstalá-la amanhã,
	//    brick diário) e reseta o guard. Falha aqui NÃO bloqueia o restart — recuperar
	//    agora vale mais que evitar repetir amanhã. (Codex P1)
	if st, err := LoadState(); err != nil {
		// State ilegível: não há como saber qual versão quarentenar. Reseta o
		// state.json (atômico) para o conector se recuperar nos próximos ciclos — o
		// próximo doUpdate volta a gravar PendingUpdateVersion, então um eventual
		// re-loop se auto-quarentena. Os HWMs já estavam perdidos (state ilegível); o
		// full re-scan semanal é a rede de segurança. (Codex P2)
		logger.Errorf("rollback: state ilegível (%v) — resetando state.json", err)
		if sErr := SaveState(&State{HWM: map[string]string{}}); sErr != nil {
			logger.Errorf("rollback: falha ao resetar state.json: %v", sErr)
		}
	} else {
		if bad := st.PendingUpdateVersion; bad != "" {
			st.QuarantinedVersion = bad
			logger.Warnf("rollback: versão %q quarentenada após crash-loop de boot", bad)
		}
		st.PendingUpdateVersion = ""
		st.UpdateFailCount = 0
		st.LastUpdateFailure = ""
		if err := SaveState(st); err != nil {
			logger.Errorf("rollback: falha ao persistir quarentena (best-effort): %v", err)
		}
	}

	// 3. PRIMARY: reinicia o serviço com o binário restaurado (o run_command do SCM
	//    não reinicia sozinho).
	if err := startRecoveredService(); err != nil {
		return fmt.Errorf("rollback: reiniciar serviço: %w", err)
	}

	logger.Infof("rollback: concluído — serviço reiniciado com o binário anterior")
	return nil
}
