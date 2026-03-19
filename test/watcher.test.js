import { describe, it, expect } from 'vitest';
import { createDebouncer, shouldTrigger } from '../src/watcher.js';

describe('watcher', () => {
  describe('shouldTrigger', () => {
    it('triggers on CLAUDE.md', () => {
      expect(shouldTrigger('CLAUDE.md')).toBe(true);
    });

    it('triggers on .env files', () => {
      expect(shouldTrigger('.env')).toBe(true);
      expect(shouldTrigger('.env.local')).toBe(true);
    });

    it('triggers on docker-compose files', () => {
      expect(shouldTrigger('docker-compose.yml')).toBe(true);
      expect(shouldTrigger('compose.yaml')).toBe(true);
    });

    it('triggers on Dockerfile', () => {
      expect(shouldTrigger('Dockerfile')).toBe(true);
      expect(shouldTrigger('Dockerfile.dev')).toBe(true);
    });

    it('triggers on .mcp.json', () => {
      expect(shouldTrigger('.mcp.json')).toBe(true);
    });

    it('triggers on git hooks', () => {
      expect(shouldTrigger('.git/hooks/pre-commit')).toBe(true);
    });

    it('triggers on .rigscorerc.json', () => {
      expect(shouldTrigger('.rigscorerc.json')).toBe(true);
    });

    it('triggers on governance files', () => {
      expect(shouldTrigger('.cursorrules')).toBe(true);
      expect(shouldTrigger('.windsurfrules')).toBe(true);
      expect(shouldTrigger('AGENTS.md')).toBe(true);
    });

    it('does not trigger on random JS files', () => {
      expect(shouldTrigger('index.js')).toBe(false);
      expect(shouldTrigger('src/app.ts')).toBe(false);
    });

    it('does not trigger on random YAML files', () => {
      expect(shouldTrigger('config.yaml')).toBe(false);
    });

    it('triggers on null filename (platform compat)', () => {
      expect(shouldTrigger(null)).toBe(true);
      expect(shouldTrigger(undefined)).toBe(true);
    });
  });

  describe('createDebouncer', () => {
    it('debounces rapid calls', async () => {
      let callCount = 0;
      const debounced = createDebouncer(() => { callCount++; }, 50);

      debounced();
      debounced();
      debounced();

      // Should not have fired yet
      expect(callCount).toBe(0);

      // Wait for debounce
      await new Promise(r => setTimeout(r, 100));
      expect(callCount).toBe(1);
    });

    it('fires after delay with no subsequent calls', async () => {
      let callCount = 0;
      const debounced = createDebouncer(() => { callCount++; }, 50);

      debounced();
      await new Promise(r => setTimeout(r, 100));
      expect(callCount).toBe(1);
    });

    it('resets timer on each call', async () => {
      let callCount = 0;
      const debounced = createDebouncer(() => { callCount++; }, 100);

      debounced();
      await new Promise(r => setTimeout(r, 60));
      debounced(); // reset timer
      await new Promise(r => setTimeout(r, 60));
      expect(callCount).toBe(0); // still hasn't fired

      await new Promise(r => setTimeout(r, 60));
      expect(callCount).toBe(1);
    });
  });
});
