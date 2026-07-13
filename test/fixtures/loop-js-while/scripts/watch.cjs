const { execFileSync } = require('node:child_process');

do {
  execFileSync('./scripts/agent.sh', { stdio: 'inherit' });
} while (1);
