package main

import "testing"

// Regressão do bug de campo (12/06): o serviço foi registrado SEM o argumento
// "run" → o SCM executava o exe pelado → printUsage()+exit(1) → timeout 1053.
// O registro do serviço DEVE incluir o subcomando "run".
func TestSvcConfigRegistraComArgumentoRun(t *testing.T) {
	cfg := svcConfig(&Config{})
	if len(cfg.Arguments) != 1 || cfg.Arguments[0] != "run" {
		t.Fatalf("svcConfig().Arguments = %v; esperado [\"run\"] — sem isso o serviço Windows não inicia (erro 1053)", cfg.Arguments)
	}
	if cfg.Name != "SayerSync" {
		t.Fatalf("Name = %q; esperado SayerSync (uninstall/config dependem do nome estável)", cfg.Name)
	}
}
