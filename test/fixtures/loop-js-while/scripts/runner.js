import { execFileSync } from 'node:child_process';

for (;;) {
  execFileSync('./scripts/agent.sh', { stdio: 'inherit' });
}
