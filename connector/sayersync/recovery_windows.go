//go:build windows

// recovery_windows.go — syscalls do Windows SCM para o recovery de crash-loop de
// boot (Codex F2). Estende a recovery do serviço com uma 3ª ação SC_ACTION_RUN_COMMAND
// que o SCM executa, num processo FRESCO, após N crashes consecutivos — apontando
// para a recovery-copy estável `<dir>\sayersync-recovery.exe rollback --target <exe>`.
//
// O kardianos/service só configura "restart" simples; aqui vamos direto no SCM via
// ChangeServiceConfig2/QueryServiceConfig2. Verificação ponta-a-ponta exige um
// balcão Windows real (a semântica de contagem/reset do SCM não se reproduz fora dele).
package main

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	// Delays das ações de recovery (ms). Curtos: queremos recuperar rápido.
	recoveryRestartDelayMs1 = 10_000
	recoveryRestartDelayMs2 = 30_000
	recoveryRunCmdDelayMs   = 5_000

	// dwResetPeriod (s): zera o contador de falhas do SCM após este tempo SEM
	// falha. 1h fica BEM abaixo da cadência diária de update (senão o os.Exit(90)
	// de updates saudáveis acumularia até a 3ª ação) e bem acima da duração de um
	// loop de crash de boot (segundos), que assim alcança a ação run_command. (Codex)
	recoveryResetPeriodSec = 3600
)

// configureServiceRecoveryPlatform grava a recovery-copy e configura
// [restart, restart, run_command] no SCM. Idempotente (install + reparo).
func configureServiceRecoveryPlatform(exePath string) error {
	// A recovery-copy precisa existir ANTES — o lpCommand a referencia.
	if err := ensureRecoveryCopy(exePath); err != nil {
		return err
	}

	svc, closeFn, err := openServiceForAccess(windows.SERVICE_CHANGE_CONFIG | windows.SERVICE_START)
	if err != nil {
		return err
	}
	defer closeFn()

	cmdPtr, err := windows.UTF16PtrFromString(buildRollbackCommand(recoveryExePath(exePath), exePath))
	if err != nil {
		return fmt.Errorf("recovery: codificar lpCommand: %w", err)
	}

	actions := []windows.SC_ACTION{
		{Type: windows.SC_ACTION_RESTART, Delay: recoveryRestartDelayMs1},
		{Type: windows.SC_ACTION_RESTART, Delay: recoveryRestartDelayMs2},
		{Type: windows.SC_ACTION_RUN_COMMAND, Delay: recoveryRunCmdDelayMs},
	}
	fa := windows.SERVICE_FAILURE_ACTIONS{
		ResetPeriod:  recoveryResetPeriodSec,
		Command:      cmdPtr,
		ActionsCount: uint32(len(actions)),
		Actions:      &actions[0],
	}
	if err := windows.ChangeServiceConfig2(svc, windows.SERVICE_CONFIG_FAILURE_ACTIONS, (*byte)(unsafe.Pointer(&fa))); err != nil {
		return fmt.Errorf("recovery: ChangeServiceConfig2(FAILURE_ACTIONS): %w", err)
	}
	return nil
}

// verifyServiceRecoveryPlatform confirma que a recovery do serviço está EXATAMENTE
// como configureServiceRecovery deixaria (3 ações, a 3ª = run_command apontando para
// a recovery-copy correta). Retorna (false, nil) quando a config diverge — o chamador
// decide reparar ou pular o update.
func verifyServiceRecoveryPlatform(exePath string) (bool, error) {
	svc, closeFn, err := openServiceForAccess(windows.SERVICE_QUERY_CONFIG)
	if err != nil {
		return false, err
	}
	defer closeFn()

	// 1ª chamada: descobre o tamanho do buffer.
	var needed uint32
	err = windows.QueryServiceConfig2(svc, windows.SERVICE_CONFIG_FAILURE_ACTIONS, nil, 0, &needed)
	if err != nil && err != windows.ERROR_INSUFFICIENT_BUFFER {
		return false, fmt.Errorf("recovery: QueryServiceConfig2(tamanho): %w", err)
	}
	if needed == 0 {
		return false, nil
	}
	buf := make([]byte, needed)
	if err := windows.QueryServiceConfig2(svc, windows.SERVICE_CONFIG_FAILURE_ACTIONS, &buf[0], needed, &needed); err != nil {
		return false, fmt.Errorf("recovery: QueryServiceConfig2: %w", err)
	}

	fa := (*windows.SERVICE_FAILURE_ACTIONS)(unsafe.Pointer(&buf[0]))
	if fa.ActionsCount < 3 || fa.Actions == nil {
		return false, nil
	}
	acts := unsafe.Slice(fa.Actions, fa.ActionsCount)
	if acts[2].Type != windows.SC_ACTION_RUN_COMMAND {
		return false, nil
	}
	gotCmd := ""
	if fa.Command != nil {
		gotCmd = windows.UTF16PtrToString(fa.Command)
	}
	return gotCmd == buildRollbackCommand(recoveryExePath(exePath), exePath), nil
}

// startServicePlatform reinicia o serviço (chamado pelo rollback: o SCM NÃO
// reinicia após SC_ACTION_RUN_COMMAND). "Já rodando" não é erro.
func startServicePlatform() error {
	svc, closeFn, err := openServiceForAccess(windows.SERVICE_START)
	if err != nil {
		return err
	}
	defer closeFn()

	if err := windows.StartService(svc, 0, nil); err != nil {
		if err == windows.ERROR_SERVICE_ALREADY_RUNNING {
			return nil
		}
		return fmt.Errorf("start: StartService: %w", err)
	}
	return nil
}

// openServiceForAccess abre o SCM e o serviço SayerSync com o acesso pedido,
// devolvendo o handle do serviço e um closer que fecha ambos.
func openServiceForAccess(access uint32) (windows.Handle, func(), error) {
	mgr, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return 0, nil, fmt.Errorf("recovery: OpenSCManager: %w", err)
	}
	namePtr, err := windows.UTF16PtrFromString(serviceName)
	if err != nil {
		windows.CloseServiceHandle(mgr)
		return 0, nil, err
	}
	svc, err := windows.OpenService(mgr, namePtr, access)
	if err != nil {
		windows.CloseServiceHandle(mgr)
		return 0, nil, fmt.Errorf("recovery: OpenService(%s): %w", serviceName, err)
	}
	return svc, func() {
		windows.CloseServiceHandle(svc)
		windows.CloseServiceHandle(mgr)
	}, nil
}
