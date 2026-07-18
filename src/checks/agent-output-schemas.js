import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe } from '../utils.js';
import { homeScopeEnabled } from '../lib/home-scope.js';

// Heuristic phrases that mark an agent as a JSON-emitting fan-out target.
// Either phrase puts the agent under the schema-declaration contract; non-matching
// agents (e.g. narrative reviewers) are exempt and skipped.
const JSON_CLAIM_PATTERNS = [
  /return\s+only\s+a\s+json/i,
  /^##\s+output\s+format\b/im,
];

const FENCE_RE = /```json\s*\n([\s\S]*?)\n\s*```/g;

function discoverAgentDirs(cwd, includeHome, homedir) {
  const dirs = [path.join(cwd, '.claude', 'agents')];
  // The HOME agents dir is the operator's, not the project's — gated behind
  // --include-home-skills so an operator's global subagents don't change a
  // project's schema findings (same gate skill-files uses for home skill dirs).
  if (includeHome) dirs.push(path.join(homedir, '.claude', 'agents'));
  return dirs;
}

async function discoverAgentFiles(cwd, includeHome, homedir) {
  const dirs = discoverAgentDirs(cwd, includeHome, homedir);
  const agents = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const agentPath = path.join(dir, entry.name);
      const content = await readFileSafe(agentPath);
      if (content) {
        agents.push({ name: entry.name.replace(/\.md$/, ''), path: agentPath, content });
      }
    }
  }
  return agents;
}

function stripFrontmatter(content) {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : content;
}

function claimsJsonOutput(body) {
  return JSON_CLAIM_PATTERNS.some((re) => re.test(body));
}

function extractJsonFences(body) {
  const fences = [];
  FENCE_RE.lastIndex = 0;
  let match;
  while ((match = FENCE_RE.exec(body)) !== null) {
    fences.push(match[1]);
  }
  return fences;
}

export default {
  id: 'agent-output-schemas',
  enforcementGrade: 'mechanical',
  name: 'Agent output schemas',
  category: 'governance',

  async run(context) {
    const { cwd, homedir } = context;
    const findings = [];
    const agents = await discoverAgentFiles(cwd, homeScopeEnabled(context), homedir);

    if (agents.length === 0) {
      return { score: NOT_APPLICABLE_SCORE, findings: [], data: {} };
    }

    let agentsScanned = 0;
    let agentsClaimingJson = 0;
    let agentsMissingFence = 0;
    let agentsWithMalformedFence = 0;

    for (const agent of agents) {
      agentsScanned++;
      const body = stripFrontmatter(agent.content);
      if (!claimsJsonOutput(body)) continue;
      agentsClaimingJson++;

      const fences = extractJsonFences(body);

      if (fences.length === 0) {
        agentsMissingFence++;
        findings.push({
          findingId: 'agent-output-schemas/missing-schema-block',
          severity: 'warning',
          title: `Agent \`${agent.name}\` claims JSON output but declares no schema`,
          detail: `\`${agent.path}\` says it emits JSON (matched "Return ONLY a JSON" or an "## Output Format" section) but contains no \`\`\`json fenced block — orchestrators can't validate the contract.`,
          remediation: `Add an \`\`\`json fenced example block under \`## Output Format\` showing the exact shape the agent emits. See \`_active/lib-skill-utils/AGENT_OUTPUT_SCHEMAS.md\` for the convention.`,
          context: { agent: agent.name, path: agent.path },
        });
        continue;
      }

      for (let i = 0; i < fences.length; i++) {
        try {
          JSON.parse(fences[i]);
        } catch (err) {
          agentsWithMalformedFence++;
          findings.push({
            findingId: 'agent-output-schemas/malformed-schema-block',
            severity: 'warning',
            title: `Agent \`${agent.name}\` has an unparseable \`\`\`json block`,
            detail: `\`${agent.path}\` declares JSON output but the \`\`\`json fenced block (#${i + 1}) does not parse: ${err.message}.`,
            remediation: `Fix the JSON syntax in the \`\`\`json example block. Use a JSON validator on the literal text — placeholder values like \`<string>\` must be quoted; trailing commas and comments are not valid JSON.`,
            context: { agent: agent.name, path: agent.path, fenceIndex: i + 1 },
          });
          break;
        }
      }
    }

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: `Agent output schemas check passed (${agentsClaimingJson}/${agentsScanned} JSON-claiming agents declare a parseable schema)`,
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
      data: {
        agentsScanned,
        agentsClaimingJson,
        agentsMissingFence,
        agentsWithMalformedFence,
      },
    };
  },
};
