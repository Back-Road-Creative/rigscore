/**
 * Home-scope gating — the single decision point for whether a check may read
 * the scanner's $HOME during a scan.
 *
 * Home configs, skills, agents, memory, and governance belong to the OPERATOR's
 * profile, not the project under scan. Reading them unconditionally makes the
 * same project score differently on two machines (a laptop with a rich ~/.claude
 * vs a bare CI runner, or two operators with different homes) — governance-docs
 * flips 100→0, and credential-storage / agent-output-schemas / skill-coherence
 * flip in and out of applicability purely on who ran the scan. That breaks
 * laptop-vs-CI reproducibility and contradicts the CLI's own promise that
 * "home findings do not affect project scores unless --include-home-skills is set".
 *
 * So every check reads $HOME through this gate: the project (`cwd`) is always in
 * scope; the home directory is in scope ONLY when the operator opts in with
 * --include-home-skills. `homedir === cwd` is never home scope — scanning your
 * own home directory as a project must not double-count it as both surfaces.
 */

/** True when this scan may read $HOME (operator opted in and home ≠ cwd). */
export function homeScopeEnabled(context) {
  const { includeHomeSkills, homedir, cwd } = context || {};
  return Boolean(includeHomeSkills && homedir && homedir !== cwd);
}

/**
 * The scan roots a home-reading check should traverse: always the project
 * (`cwd`), plus `homedir` when home scope is enabled. Each entry is
 * `{ root, home }` so a caller can label home-sourced findings.
 */
export function homeAwareRoots(context) {
  const roots = [{ root: context.cwd, home: false }];
  if (homeScopeEnabled(context)) roots.push({ root: context.homedir, home: true });
  return roots;
}
