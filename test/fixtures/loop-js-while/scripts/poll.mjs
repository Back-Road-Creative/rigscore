import { execFileSync } from 'node:child_process';

while (true) {
  execFileSync('./scripts/agent.sh', { stdio: 'inherit' });
}
