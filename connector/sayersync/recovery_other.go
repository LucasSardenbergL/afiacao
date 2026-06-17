//go:build !windows

// recovery_other.go — stubs de plataforma para builds de DEV (macOS/Linux).
// Não há Windows SCM aqui: as ações de recovery do serviço não existem. Estes
// stubs deixam o pacote compilar e os testes da lógica cross-platform rodarem;
// em produção (Windows) valem as implementações de recovery_windows.go.
package main

import "errors"

// configureServiceRecoveryPlatform configuraria SERVICE_FAILURE_ACTIONS no SCM.
// No-op fora do Windows.
func configureServiceRecoveryPlatform(exePath string) error { return nil }

// verifyServiceRecoveryPlatform confirmaria a config de recovery via
// QueryServiceConfig2. Fora do Windows não há serviço a gatear → reporta "ok" para
// não bloquear dev/teste.
func verifyServiceRecoveryPlatform(exePath string) (bool, error) { return true, nil }

// startServicePlatform reiniciaria o serviço via StartService. Indisponível fora
// do Windows.
func startServicePlatform() error {
	return errors.New("start de serviço suportado apenas no Windows")
}
