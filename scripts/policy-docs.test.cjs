/**
 * M18.3 — customer policy documentation consistency suite.
 *
 * These tests exist because a policy document that invents a channel, a
 * response time, or a tested platform is worse than no policy at all. Every
 * assertion below pins a *negative* (something must NOT be claimed) or a
 * cross-document agreement, rather than exact prose.
 *
 * Deterministic and dependency-free: plain Node assertions, no framework.
 */
const { readFileSync } = require('node:fs');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Required policy documents exist
// ---------------------------------------------------------------------------
const REQUIRED = ['docs/support.md', 'docs/versioning.md', 'docs/compatibility.md', 'docs/security.md'];
for (const rel of REQUIRED) {
  check(`policy document exists: ${rel}`, existsSync(resolve(ROOT, rel)));
}

// ---------------------------------------------------------------------------
// 2. README links to the intended documents, and every relative link resolves
// ---------------------------------------------------------------------------
const readme = read('README.md');
for (const rel of REQUIRED) {
  check(`README links ${rel}`, readme.includes(`](${rel})`));
}

function resolveLinks(docRel) {
  const base = resolve(ROOT, docRel);
  const dir = base.slice(0, base.lastIndexOf('/'));
  const text = read(docRel);
  const broken = [];
  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)#][^)]*)\)/g)) {
    let link = match[2];
    if (link.startsWith('http://') || link.startsWith('https://') || link.startsWith('mailto:')) continue;
    link = link.split('#')[0]; // anchors point at a heading in an existing file
    if (link === '') continue;
    if (!existsSync(resolve(dir, link))) broken.push(link);
  }
  return broken;
}

for (const rel of ['README.md', ...REQUIRED, 'docs/deployment.md', 'docs/troubleshooting.md']) {
  const broken = resolveLinks(rel);
  check(`all relative links resolve in ${rel}`, broken.length === 0, broken.join(', '));
}

// ---------------------------------------------------------------------------
// 3. No invented support or security channel
// ---------------------------------------------------------------------------
const support = read('docs/support.md');
const security = read('docs/security.md');

// The canonical destinations must appear, and must be presented as designated
// rather than as verified operational services.
check(
  'support policy names the canonical portal URL',
  support.includes('https://www.oxyide.com/support'),
);
check('support policy names the support email', support.includes('support@oxyide.com'));
check(
  'support policy distinguishes designated from verified',
  /[Dd]esignated/.test(support) && /[Nn]ot independently verified/.test(support),
);
check(
  'security policy names the support email as its reporting route',
  security.includes('support@oxyide.com'),
);
check(
  'security policy does not claim a confidential disclosure process',
  /not confidential security reporting/i.test(security),
);

const deployment = read('docs/deployment.md');
check(
  'deployment.md flags the old support URL as unverified',
  deployment.includes('Not yet confirmed') && /not\*\* a working support channel/.test(deployment),
);
check(
  'deployment.md no longer presents the URL as a live channel',
  !/- \*\*Issues\*\*: https:\/\/www\.oxyide\.com\/support/.test(deployment),
);

// Canonical destination hygiene: the wrong path and the dev host must never
// appear as customer-facing support instructions.
const CUSTOMER_DOCS = [
  'README.md',
  'docs/support.md',
  'docs/security.md',
  'docs/deployment.md',
  'docs/troubleshooting.md',
  'docs/versioning.md',
  'docs/compatibility.md',
  'docs/refunds.md',
  'docs/updates.md',
];
// A prohibition is not an instruction. Strip lines that tell the reader NOT to
// use a destination before asserting the destination is absent, so a document
// that says "do not use /dashboard/support" is not flagged for mentioning it.
function instructionalLines(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\*/g, '')) // normalise **not** -> not
    .filter(
      (line) =>
        // Prohibitions and verification narrative are not instructions.
        !/do not|don't|never use|not the support route|instead|must not/i.test(line) &&
        !/probe|probed|verified|verification|evidence|automated/i.test(line),
    )
    .join('\n');
}

for (const rel of CUSTOMER_DOCS) {
  const instructional = instructionalLines(read(rel));
  check(`${rel} never instructs /dashboard/support`, !instructional.includes('/dashboard/support'));
  check(`${rel} never exposes dev.oxyide.com`, !/dev\.oxyide\.com/.test(instructional));
}

// ---------------------------------------------------------------------------
// 4. No invented SLA, response time, or remediation guarantee
// ---------------------------------------------------------------------------
for (const [name, text] of [
  ['support', support],
  ['security', security],
  ['versioning', read('docs/versioning.md')],
]) {
  check(
    `${name} policy states there is no guaranteed response time`,
    /no (guaranteed|particular) (response|remediation)/i.test(text) || /no response time is guaranteed/i.test(text),
  );
  check(
    `${name} policy does not promise a numeric SLA`,
    !/\b\d+\s*(business\s+)?(hour|day)s?\b[^.]{0,40}(respond|response|resolve|resolution)/i.test(text),
  );
}
check('support policy explicitly disclaims an SLA', /Do not treat this document as an SLA/i.test(support));
check('security policy promises no remediation window', /no (fixed )?remediation window/i.test(security));

// ---------------------------------------------------------------------------
// 5. Compatibility claims are evidence-classified, not overstated
// ---------------------------------------------------------------------------
const compat = read('docs/compatibility.md');
for (const label of ['DECLARED', 'VERIFIED LOCALLY', 'PLATFORM-VERIFIED', 'UNVERIFIED']) {
  check(`compatibility policy defines the ${label} label`, compat.includes(label));
}
check('compatibility policy states only one environment was tested', /exactly one environment/i.test(compat));
check(
  'compatibility policy does not claim Render/Fly were deployed',
  /No deployment to Render or Fly\.io has ever been performed/i.test(compat),
);
check('compatibility policy marks Render as unverified', /\*\*Render\*\* \| .*UNVERIFIED/s.test(compat));
check('compatibility policy marks Fly as unverified', /\*\*Fly\.io\*\* \| .*UNVERIFIED/s.test(compat));
check(
  'compatibility policy states nothing is platform-verified',
  /Nothing in the `Platform-verified` column has been tested/i.test(compat),
);

// ---------------------------------------------------------------------------
// 6. Versioning policy distinguishes convention from implemented automation
// ---------------------------------------------------------------------------
const versioning = read('docs/versioning.md');
check('versioning policy separates package version from API version', /Two separate version numbers/i.test(versioning));
check(
  'versioning policy distinguishes declared vs implemented',
  /Distinguish what exists from what is intended/i.test(versioning),
);
check(
  'versioning policy does not claim signed releases',
  /Signed releases \/ provenance attestations \| \*\*Not implemented\*\*/i.test(versioning),
);
check('versioning policy does not claim reproducible builds', /Reproducible builds \| \*\*Not implemented/i.test(versioning));
check(
  'versioning policy flags support duration as undefined',
  /support duration.*not.*defined/i.test(versioning) || /No support duration/i.test(versioning),
);

// ---------------------------------------------------------------------------
// 7. M18.2's BLOCKED verdict is preserved, not overwritten
// ---------------------------------------------------------------------------
const m182 = read('docs/milestones/M18.2/FINAL_REPORT.md');
check('M18.2 report still says BLOCKED', /Verdict: \*\*BLOCKED\*\*/.test(m182));
check('M18.2 report still records the live leg as not run', /Live leg: NOT CLOSED/.test(m182));
check(
  'M18.2 report still says the M18 parent gate is unsatisfied',
  /M18 parent gate remains unsatisfied/i.test(m182),
);

// ---------------------------------------------------------------------------
// 8. Cross-document consistency with package metadata
// ---------------------------------------------------------------------------
const pkg = JSON.parse(read('package.json'));
check('compatibility policy states the declared Node engine', compat.includes(pkg.engines.node));
check('compatibility policy states the declared Prisma version', compat.includes(pkg.devDependencies.prisma));
check('compatibility policy states the declared Fastify range', compat.includes(pkg.dependencies.fastify));
check('versioning policy states the current package version', versioning.includes(pkg.version));
check('support policy states the current package version', support.includes(pkg.version));

// ---------------------------------------------------------------------------
// 9. No unsupported "production-ready" claim survives in customer docs
// ---------------------------------------------------------------------------
for (const rel of ['README.md', 'CHANGELOG.md', 'docs/deployment.md', 'docs/troubleshooting.md', 'docs/refunds.md', 'docs/updates.md']) {
  check(`${rel} does not claim "production-ready"`, !/production-ready/i.test(read(rel)));
}

// ---------------------------------------------------------------------------
// 10. Cookie SameSite agrees with the implementation
// ---------------------------------------------------------------------------
const config = read('src/config/index.ts');
const sameSite = /sameSite:\s*'([^']+)'/.exec(config)?.[1];
check('implementation declares a SameSite value', sameSite !== undefined, sameSite);
for (const rel of ['README.md', 'CHANGELOG.md', 'docs/support.md', 'docs/security.md']) {
  const text = read(rel);
  if (/SameSite/i.test(text)) {
    check(`${rel} SameSite matches implementation (${sameSite})`, text.includes(sameSite));
  }
}

// ---------------------------------------------------------------------------
// 11. All five M18.3 reports exist
// ---------------------------------------------------------------------------
const REPORTS = [
  'docs/milestones/M18.3/ARCHITECTURE_AUDIT.md',
  'docs/milestones/M18.3/IMPLEMENTATION_SPEC.md',
  'docs/milestones/M18.3/TEST_PLAN.md',
  'docs/milestones/M18.3/VALIDATION.md',
  'docs/milestones/M18.3/FINAL_REPORT.md',
];
for (const rel of REPORTS) {
  check(`milestone report exists: ${rel}`, existsSync(resolve(ROOT, rel)));
}

// ---------------------------------------------------------------------------
// 12. M20 commercial policies: proposed, bounded, and shippable
// ---------------------------------------------------------------------------
const refunds = read('docs/refunds.md');
const updates = read('docs/updates.md');

// The refund policy is a draft awaiting approval — never an active promise.
check('refund policy exists', existsSync(resolve(ROOT, 'docs/refunds.md')));
check(
  'refund policy is marked as awaiting approval, not active',
  /awaiting owner approval/i.test(refunds) && /not active/i.test(refunds),
);
check(
  'refund policy states it is not binding',
  /is not binding|not.*binding/i.test(refunds),
);
check(
  'refund policy does not present itself as settled terms',
  !/this policy is effective|in effect as of|guaranteed refund/i.test(refunds),
);

// The updates policy separates settled facts from undecided models.
check('updates policy exists', existsSync(resolve(ROOT, 'docs/updates.md')));
check(
  'updates policy marks undecided models as requiring approval',
  /requires owner approval|undecided/i.test(updates),
);
check(
  'updates policy promises no lifetime updates',
  !/lifetime updates (are included|included|guaranteed)/i.test(updates),
);
check(
  'updates policy states the 12-month figure is unevaluated input, not an offer',
  /not an offer|evaluation input/i.test(updates),
);

// Cross-links: policies must point at each other, not strand the reader.
check('support policy links the updates policy', support.includes('](updates.md)'));
check('support policy links the refund proposal', support.includes('](refunds.md)'));
check('versioning policy links the updates policy', versioning.includes('](updates.md)'));
check(
  'compatibility lifecycle section links the updates policy',
  compat.includes('](updates.md)'),
);
check('README no longer claims no support channel is confirmed', !/No support channel is confirmed/i.test(readme));
check('README points at the updates policy', read('README.md').includes('](docs/updates.md)'));
check('README points at the refund proposal as awaiting approval', read('README.md').includes('](docs/refunds.md)'));

// Operating reality without an SLA: timezone/business-days language must not
// become a numeric response promise (complements the §4 SLA guards).
check('support policy names the working timezone descriptively', /UTC\+5:30/.test(support));
check(
  'refund proposal names no binding response window',
  !/\brespond within \d+|reply within \d+|resolution within \d+/i.test(refunds),
);

// Package parity: proposed customer policies must ship in the ZIP.
const distFileSet = read('scripts/dist-file-set.cjs');
check('dist allowlist ships the refund proposal', distFileSet.includes("'docs/refunds.md'"));
check('dist allowlist ships the updates policy', distFileSet.includes("'docs/updates.md'"));

// Licence grant consistency: commercial client-project use stays explicit.
const license = read('LICENSE.txt');
check(
  'licence still permits commercial client projects',
  /client projects/i.test(license) && /Commercial use of Oxyide Forge is permitted/i.test(license),
);
check(
  'licence still reserves redistribution of the starter itself',
  /redistribute the original Oxyide Forge package/i.test(license),
);

// ---------------------------------------------------------------------------
// 13. All five M20 reports exist
// ---------------------------------------------------------------------------
const M20_REPORTS = [
  'docs/milestones/M20/ARCHITECTURE_AUDIT.md',
  'docs/milestones/M20/IMPLEMENTATION_SPEC.md',
  'docs/milestones/M20/TEST_PLAN.md',
  'docs/milestones/M20/VALIDATION.md',
  'docs/milestones/M20/FINAL_REPORT.md',
];
for (const rel of M20_REPORTS) {
  check(`milestone report exists: ${rel}`, existsSync(resolve(ROOT, rel)));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\nPolicy documentation checks: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL  ${failure}`);
if (failures.length > 0) process.exitCode = 1;
