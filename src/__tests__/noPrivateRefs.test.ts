import {describe, it, expect} from 'vitest';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, relative} from 'node:path';

/**
 * This repository is public. Issues, pull requests, commits and code comments
 * are all world-readable, and the comments here are written while working from
 * a private tracker whose numbering means nothing to anyone outside.
 *
 * Four comments had already picked up a private card number, in the form
 * "Regression for <tracker>#<n>". Harmless-looking, and useless to a reader
 * who cannot open it, but it advertises that the tracker exists and lets an
 * outsider correlate internal numbering with dated public commits.
 *
 * The patterns below are deliberately shaped rather than named. A detector
 * that lists the private repository by name has to write that name into a
 * public file to do its job, which is the leak it was built to stop. So it
 * matches the FORM instead — an owner/repo path under this org that is not a
 * known public one, and a `name#123` cross-repo reference that is not — and
 * the allowlist carries only names that are already public.
 *
 * The other half is worse and is what this gate mainly exists for: a session
 * trailer. The tooling offers to append a `Claude-Session:` line pointing at a
 * transcript URL, and a transcript is not something to hand to a park's legal
 * team.
 *
 * The same applies to how our own pipeline runs. A comment describes what this
 * library emits and what happens to a row it leaves out; it does not name the
 * downstream sync agent, say how often or from where it polls, or point at a
 * directory on someone's machine. Those say how the data is collected in
 * production, which is not for a competitor or a park's legal team to read.
 * The rules for them below are shaped too: a word that is never right in this
 * tree, an absolute path under a home directory, and any host under the
 * project's own domain other than the public API.
 *
 * Kept narrow deliberately, so it stays switched on: it reads `src/`, the
 * README, the TODO list and the skill docs, which is where prose that ships
 * publicly actually lives. It cannot see commit messages or PR bodies, which
 * are the other half of the exposure and have to stay a matter of discipline.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = resolve(ROOT, 'src/__tests__/noPrivateRefs.test.ts');

/** Repositories in this org that are already public, so naming them is fine. */
const PUBLIC_REPOS = [
  'parksapi',
  'typelib',
  'ThemeParks_JavaScript',
  'ThemeParks_Python',
];

export const FORBIDDEN: Array<{name: string; pattern: RegExp}> = [
  // A cross-repo card reference, written `name#123` with no space. The space
  // matters: "PR #567" and "see #12" are same-repo and fine, while `name#123`
  // names another tracker. PUBLIC_REPOS is the allowlist.
  {
    name: 'cross-repo card reference to a non-public tracker',
    pattern: new RegExp(String.raw`\b(?!(?:${PUBLIC_REPOS.join('|')})#)[A-Za-z][A-Za-z0-9_-]{3,}#\d+`),
  },
  // An owner/repo path under this org that is not one of the public repos.
  {
    name: 'repository path under this org that is not a public repo',
    pattern: new RegExp(String.raw`\bThemeParks/(?!(?:${PUBLIC_REPOS.join('|')})\b)[A-Za-z][A-Za-z0-9_-]*`),
  },
  // GitHub Projects node ids: project, item, single-select field.
  {name: 'project/field id', pattern: /\bPVT(?:I|SSF)?_[A-Za-z0-9]/},
  // Session transcript links, in either the trailer or bare URL form.
  {name: 'session transcript link', pattern: /claude\.ai\/code\/session_/i},
  {name: 'session trailer', pattern: /^\s*Claude-Session\s*:/im},
  // The downstream sync agent. Describe the contract from this library's side
  // ("a consumer that only upserts") instead. A garbage collector is fine.
  {name: 'mention of the downstream sync agent', pattern: /(?<!garbage\s)\bcollector\b/i},
  // A path on someone's machine, such as a usage example that writes under a
  // home directory. Use a relative path.
  {name: 'absolute path under a user home directory', pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+\//},
  // The wiki's review queue is part of how the pipeline runs.
  {name: 'reference to the wiki moderation queue', pattern: /\bmoderation\s+(?:queue|backlog)\b/i},
  // A note from the maintainers' private working memory, cited by file name
  // ("per feedback_x.md") or by kind ("the memory note"). The reader cannot open
  // it, so the comment has to carry the reason itself.
  {
    name: 'reference to a private memory note',
    pattern: /\b(?:feedback|project|reference|user)_[a-z0-9]+(?:_[a-z0-9]+)*\.md\b|\b[Mm]emory[ -][Nn]otes?\b/,
  },
  // Any host under the project's domain except the public API.
  {
    name: 'host under the project domain that is not the public API',
    pattern: /\b(?!(?:api|www)\.)[a-z0-9-]+\.themeparks\.wiki\b/i,
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'fixtures') continue;
      walk(full, out);
    } else if (/\.(ts|js|json|md)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Prose that ships publicly. CLAUDE.md is left out: it states the rules, so it names what they forbid. */
const SKILL_DOCS = resolve(ROOT, '.claude/skills');

describe('no private references leak into the public repository', () => {
  const files = [
    ...walk(resolve(ROOT, 'src')),
    resolve(ROOT, 'README.md'),
    resolve(ROOT, 'TODO.MD'),
    ...(existsSync(SKILL_DOCS) ? walk(SKILL_DOCS) : []),
  ].filter((f) => f !== SELF);

  it('has files to check (the walk itself must not silently find nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const {name, pattern} of FORBIDDEN) {
    it(`contains no ${name}`, () => {
      const hits: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        if (!pattern.test(text)) continue;
        for (const [i, line] of text.split('\n').entries()) {
          // Test each line separately so the message names the exact site.
          if (new RegExp(pattern.source, pattern.flags.replace('m', '')).test(line)) {
            hits.push(`${relative(ROOT, file)}:${i + 1}`);
          }
        }
      }
      expect(hits, `remove the ${name} at:\n  ${hits.join('\n  ')}`).toEqual([]);
    });
  }
});

describe('the patterns fire on what they were written for', () => {
  const find = (name: string) => {
    const hit = FORBIDDEN.find((f) => f.name === name);
    if (!hit) throw new Error(`no rule named ${name}`);
    return hit.pattern;
  };

  const cases: Array<{rule: string; flagged: string[]; allowed: string[]}> = [
    {
      rule: 'mention of the downstream sync agent',
      flagged: [
        'the collector is upsert-only',
        '// Collector clock skew, not a retirement.',
        'per collector host',
        'multi-collector deployments',
      ],
      allowed: ['a consumer that only upserts', 'the garbage collector ran', 'a collection of rides', 'a Collect button'],
    },
    {
      rule: 'absolute path under a user home directory',
      flagged: ['--out=/home/someone/data/capture.jsonl', 'cd /Users/someone/work/'],
      allowed: ['--out=./capture.jsonl', '/usr/src/app/dist', 'a /home page route', 'home/someone/relative'],
    },
    {
      rule: 'reference to the wiki moderation queue',
      flagged: ['land without coordinates and need the moderation queue', 'never reach the entity list / Moderation  Queue'],
      allowed: ['the entity list', 'moderation is manual', 'a queue of requests'],
    },
    {
      rule: 'host under the project domain that is not the public API',
      flagged: ['ssh box.themeparks.wiki', 'https://admin.themeparks.wiki/v1', 'x-1.themeparks.wiki'],
      allowed: ['https://api.themeparks.wiki/v1/entity', 'https://themeparks.wiki/', 'www.themeparks.wiki', 'themeparks.wiki.example.com'],
    },
    {
      rule: 'reference to a private memory note',
      flagged: [
        'Per `feedback_cache_only_true.md`: only ever writes the larger value',
        '// feedback_cache_only_true.md memory).',
        'see project_fantawild_sticky_show.md',
        'as the memory note says',
      ],
      allowed: ['README.md', 'TAG_DEVELOPMENT_GUIDE.md', 'a project_root directory', 'already in memory', 'feedback.md', 'user_agent.mdx'],
    },
    {
      rule: 'session transcript link',
      flagged: ['https://claude.ai/code/session_abc123'],
      allowed: ['https://claude.ai/docs'],
    },
  ];

  for (const {rule, flagged, allowed} of cases) {
    it(`${rule}: flags ${flagged.length} samples, allows ${allowed.length}`, () => {
      const pattern = find(rule);
      for (const s of flagged) {
        expect(new RegExp(pattern.source, pattern.flags.replace('m', '')).test(s), `should flag: ${s}`).toBe(true);
      }
      for (const s of allowed) {
        expect(new RegExp(pattern.source, pattern.flags.replace('m', '')).test(s), `should allow: ${s}`).toBe(false);
      }
    });
  }

  it('has a sample case for every rule, so a new rule cannot ship untested', () => {
    const covered = new Set(cases.map((c) => c.rule));
    const missing = FORBIDDEN.map((f) => f.name).filter((n) => !covered.has(n));
    // The two tracker rules and the project/field id and trailer rules predate this table.
    const predates = new Set([
      'cross-repo card reference to a non-public tracker',
      'repository path under this org that is not a public repo',
      'project/field id',
      'session trailer',
    ]);
    expect(missing.filter((n) => !predates.has(n))).toEqual([]);
  });
});
