import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    sys.exit("prctl falhou")
pid = os.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
rc = 1
while True:
    try:
        p, st = os.waitpid(-1, 0)
    except ChildProcessError:
        break
    if p == pid:
        rc = os.waitstatus_to_exitcode(st)
        break
sys.exit(rc if rc >= 0 else 1)
