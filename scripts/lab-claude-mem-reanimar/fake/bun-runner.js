const { spawnSync } = require('child_process');
const [, , script, ...args] = process.argv;
const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
