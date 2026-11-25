import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M11.3 — architecture boundary tests for authentication email wiring.
 *
 * These are SOURCE tests, not behaviour tests: they assert that the wiring
 * cannot drift into a shape the architecture forbids, no matter how the
 * services are refactored later. Each scan matches import SPECIFIERS only —
 * a substring scan would flag innocent identifiers (the M78-F04 class: the
 * detector, not the code, would be wrong).
 *
 * No DB, no SMTP, no network: this file is deliberately not an
 * `*.integration.test.ts` (ARCH-ENF-011 would correctly demand a DB gate it
 * does not need).
 */

const SRC_ROOT = fileURLToPath(new URL('../../../../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      found.push(path);
    }
  }
  return found;
}

const ALL_PRODUCTION_FILES = sourceFiles(SRC_ROOT).map((path) => ({
  path,
  rel: relative(SRC_ROOT, path),
  source: readFileSync(path, 'utf8'),
}));

/**
 * Removes block and line comments before a raw-source scan.
 *
 * A comment-sensitive scan measures prose instead of code: the M11.3
 * scheduling rule passed only because the file happened to say "no retries"
 * rather than "no retry". Stripping comments makes the rule measure the code
 * it claims to measure. Truncating a `'https://…'` string literal at `//` is
 * harmless here — a scan can only lose text, never gain a false positive.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Matches `import ... from 'x'`, `import('x')`, and `require('x')` for one specifier. */
function importSpecifier(specifier: string): RegExp {
  return new RegExp(
    `(?:import\\s[^'"]*from\\s*|require\\(\\s*|import\\(\\s*)['"]${specifier}['"]`,
  );
}

/** The literal source form of an import statement for one specifier. */
function importStatement(specifier: string): string {
  return `from '${specifier}'`;
}

describe('M11.3 boundary: authentication never depends on a transport', () => {
  it('no authentication service or route imports nodemailer or any transport library', () => {
    const TRANSPORTS = ['nodemailer', '@sendgrid/mail', 'resend', '@aws-sdk/client-ses', 'mailgun.js', 'postmark'];
    const offenders: string[] = [];

    for (const file of ALL_PRODUCTION_FILES) {
      if (!file.rel.startsWith(`modules${sep}auth${sep}`)) continue;
      for (const specifier of TRANSPORTS) {
        if (importSpecifier(specifier).test(file.source)) {
          offenders.push(`${file.rel} imports ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('only the composition module selects a transport', () => {
    const importers: string[] = [];
    const SELECTOR = /(?:createEmailProvider|createSmtpEmailProvider|noopEmailProvider)/;

    for (const file of ALL_PRODUCTION_FILES) {
      if (!file.rel.startsWith(`modules${sep}auth${sep}`)) continue;
      // Comments are stripped: a doc comment that merely names a factory is
      // documentation, not a dependency (the M114-F01 class, now closed here
      // too so no M11 scan measures prose).
      if (SELECTOR.test(stripComments(file.source))) {
        importers.push(file.rel);
      }
    }

    // The adapter must stay transport-agnostic and the composition module is
    // the single wiring point. A second importer would mean selection logic
    // spreading into business code.
    expect(importers).toEqual([`modules${sep}auth${sep}email${sep}auth-email-composition.ts`]);
  });

  it('authentication services never import the email provider factory', () => {
    const offenders = ALL_PRODUCTION_FILES.filter(
      (file) =>
        file.rel.startsWith(`modules${sep}auth${sep}services${sep}`) &&
        file.source.includes('platform/email'),
    ).map((file) => file.rel);

    expect(offenders).toEqual([]);
  });

  it('the three domain mailer ports remain the only auth-side email contract', () => {
    // Ports stay owned by their services, not relocated into shared/email:
    // they describe what authentication needs, not how mail is transported.
    for (const [port, owner] of [
      ['PasswordResetMailer', `modules${sep}auth${sep}services${sep}password-reset.service.ts`],
      ['EmailVerificationMailer', `modules${sep}auth${sep}services${sep}email-verification.service.ts`],
      ['SecurityNotificationMailer', `modules${sep}auth${sep}services${sep}security-notification.service.ts`],
    ] as const) {
      const ownerFile = ALL_PRODUCTION_FILES.find((file) => file.rel === owner);
      expect(ownerFile, `${port} owner missing`).toBeDefined();
      expect(ownerFile?.source, `${port} must stay in ${owner}`).toContain(`export type ${port}`);
    }

    const sharedOwners = ALL_PRODUCTION_FILES.filter(
      (file) =>
        file.rel.startsWith(`shared${sep}email${sep}`) &&
        /PasswordResetMailer|EmailVerificationMailer|SecurityNotificationMailer/.test(file.source),
    ).map((file) => file.rel);

    expect(sharedOwners).toEqual([]);
  });

  it('no source file outside platform/email imports the SMTP transport', () => {
    const offenders = ALL_PRODUCTION_FILES.filter(
      (file) =>
        importSpecifier('nodemailer').test(file.source) &&
        !file.rel.startsWith(`platform${sep}email${sep}`),
    ).map((file) => file.rel);

    expect(offenders).toEqual([]);
  });

  it('the routes pass all three composed mailers to the services', () => {
    const routes = ALL_PRODUCTION_FILES.find(
      (file) => file.rel === `modules${sep}auth${sep}routes${sep}auth.routes.ts`,
    );
    expect(routes).toBeDefined();

    // Presence, not shape: a route that stops passing a mailer would silently
    // fall back to the frozen NoOp default and email nothing in production.
    expect(routes?.source).toContain(
      importStatement('../email/auth-email-composition.js'),
    );
    for (const mailer of ['passwordReset', 'emailVerification', 'securityNotification']) {
      expect(
        routes?.source.includes(`authEmailMailers.${mailer}`),
        `routes never pass authEmailMailers.${mailer}`,
      ).toBe(true);
    }
    // The composed mailer must not shadow the request logger: request-scoped
    // correlation comes from the route, and the adapter takes no request.
    expect(routes?.source).toContain('securityNotificationLogger: request.log');
  });

  it('no email file reads process.env directly', () => {
    const offenders = ALL_PRODUCTION_FILES.filter(
      (file) =>
        (file.rel.startsWith(`shared${sep}email${sep}`) || file.rel.startsWith(`platform${sep}email${sep}`) ||
          file.rel.startsWith(`modules${sep}auth${sep}email${sep}`)) &&
        file.source.includes('process.env'),
    ).map((file) => file.rel);

    expect(offenders).toEqual([]);
  });

  it('no email file imports Prisma, persistence, or HTTP request objects', () => {
    // Import specifiers only. A raw source scan would flag this suite's own
    // prose ("no `request.log`") — the M78-F04 class again: the detector,
    // not the code, would be wrong.
    const FORBIDDEN = [
      '@prisma/client',
      'platform/database',
      'fastify',
      '../../../repositories/',
    ];
    const offenders: string[] = [];

    for (const file of ALL_PRODUCTION_FILES) {
      if (!file.rel.startsWith(`modules${sep}auth${sep}email${sep}`)) continue;
      for (const specifier of FORBIDDEN) {
        if (importSpecifier(specifier).test(file.source)) {
          offenders.push(`${file.rel} imports ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no email file imports a template engine or rendering dependency', () => {
    const TEMPLATING = ['handlebars', 'ejs', 'pug', 'nunjucks', 'mustache', 'react-email', 'mjml'];
    const offenders: string[] = [];

    for (const file of ALL_PRODUCTION_FILES) {
      if (!file.rel.startsWith(`modules${sep}auth${sep}email${sep}`)) continue;
      for (const specifier of TEMPLATING) {
        if (importSpecifier(specifier).test(file.source)) {
          offenders.push(`${file.rel} imports ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('M11.3 boundary: no retries, queues, or workers', () => {
  it('no email file schedules, delays, or loops a delivery', () => {
    const FORBIDDEN = [
      /\bsetTimeout\s*\(/,
      /\bsetInterval\s*\(/,
      /\bfor\s*\(/,
      /\bwhile\s*\(/,
      /\bretry\b/i,
      /\bbackoff\b/i,
    ];
    const offenders: string[] = [];

    for (const file of ALL_PRODUCTION_FILES) {
      if (!file.rel.startsWith(`modules${sep}auth${sep}email${sep}`)) continue;
      const code = stripComments(file.source);
      for (const pattern of FORBIDDEN) {
        if (pattern.test(code)) {
          offenders.push(`${file.rel} matches ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('package.json declares no email queue, worker, or outbox dependency', async () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const forbidden = ['bullmq', 'bull', 'agenda', 'amqplib', 'kafkajs', 'nodemailer-retry'];

    for (const name of forbidden) {
      expect(manifest.dependencies?.[name], `dependency ${name}`).toBeUndefined();
    }
  });
});