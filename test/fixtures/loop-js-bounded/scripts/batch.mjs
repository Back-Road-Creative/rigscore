import { spawnSync } from 'node:child_process';

const tasks = ['lint', 'types', 'tests'];
for (const task of tasks) {
  spawnSync('claude', ['-p', `fix the ${task}`], { stdio: 'inherit' });
}
