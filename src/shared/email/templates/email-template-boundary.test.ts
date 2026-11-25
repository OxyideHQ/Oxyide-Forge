import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M11.4 — template purity and boundary tests.
 *
 * A template is a pure function: `data → content`. That claim is only
 * enforceable if something checks it, because the cheapest way to "improve" a
 * template later is to reach for `config`, the clock, or the logger. These
 * source scans make such a change fail immediately.
 *
 * Scans match import SPECIFIERS and API call shapes, never bare substrings —
 * a substring scan would flag this suite's own prose (the M78-F04 defect
 * class, which has now bitten this repository three times).
 *
 * No database, no SMTP, no network: deliberately not an
 * `*.integration.test.ts` (ARCH-ENF-011 would demand a DB gate it does not
 * need).
 */

const TEMPLATE_DIR = fileURLToPath(new URL('.', import.meta.url));

function productionTemplateFiles(): { rel: string; source: string }[] {
  const files: { rel: string; source: string }[] = [];
  for (const entry of readdirSync(TEMPLATE_DIR)) {
    const path = join(TEMPLATE_DIR, entry);
    if (statSync(path).isDirectory()) continue;
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    files.push({ rel: relative(TEMPLATE_DIR, path), source: readFileSync(path, 'utf8') });
  }
  return files;
}

const FILES = productionTemplateFiles();

/**
 * Removes block and line comments before a raw-source scan, so a rule measures
 * code rather than prose (the M114-F01 defect class, closed across all M11
 * scans during the M11.5 freeze review).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** True when a module imports a specifier by any supported syntax. */
function imports(source: string, specifier: string): boolean {
  return new RegExp(
    `(?:import\\s[^'"]*from\\s*|import\\(\\s*|require\\(\\s*)['"][^'"]*${specifier.replace(
      /[/\\^$*+?.()|[\]{}]/g,
      '\\$&',
    )}['"]`,
  ).test(source);
}

describe('template layer exists and is non-empty', () => {
  it('contains the registry, the templates, the layout, and the escaper', () => {
    expect(FILES.map((file) => file.rel).sort()).toEqual([
      'email-layout.ts',
      'email-template-registry.ts',
      'email-templates.ts',
      'html-escape.ts',
    ]);
  });
});

describe('templates import nothing outside themselves', () => {
  it('no template file imports configuration, the environment, or the clock', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const code = stripComments(file.source);
      for (const specifier of ['config', 'process']) {
        if (imports(code, specifier)) offenders.push(`${file.rel} imports ${specifier}`);
      }
      if (/process\.env/.test(code)) offenders.push(`${file.rel} reads process.env`);
      if (/\bDate\.now\b|new Date\(/.test(code)) offenders.push(`${file.rel} reads the clock`);
      if (/Math\.random/.test(code)) offenders.push(`${file.rel} uses randomness`);
    }
    expect(offenders).toEqual([]);
  });

  it('no template file imports persistence, HTTP, or a transport', () => {
    const FORBIDDEN = [
      '@prisma/client',
      'platform/database',
      'fastify',
      'nodemailer',
      'platform/email',
      'email-provider',
      'email-message',
      'logger',
    ];
    const offenders: string[] = [];
    for (const file of FILES) {
      const code = stripComments(file.source);
      for (const specifier of FORBIDDEN) {
        if (imports(code, specifier)) offenders.push(`${file.rel} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no template file imports a business module', () => {
    const offenders = FILES.filter((file) => imports(file.source, 'modules')).map(
      (file) => file.rel,
    );
    expect(offenders).toEqual([]);
  });

  it('no template file logs anything', () => {
    const offenders = FILES.filter(
      (file) => /console\.|logger\.|\.info\(|\.warn\(|\.error\(/.test(stripComments(file.source)),
    ).map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('no template file uses a template-engine, i18n, or queue dependency', () => {
    const FORBIDDEN = [
      'handlebars',
      'ejs',
      'mustache',
      'nunjucks',
      'pug',
      'mjml',
      'react-email',
      'i18n',
      'bullmq',
      'amqplib',
    ];
    const offenders: string[] = [];
    for (const file of FILES) {
      const code = stripComments(file.source);
      for (const specifier of FORBIDDEN) {
        if (imports(code, specifier)) offenders.push(`${file.rel} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the template layer adds no dependency to the project', async () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    // M11.2 added nodemailer for transport; M11.4 adds nothing at all.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@fastify/cookie',
      '@fastify/cors',
      '@fastify/jwt',
      '@fastify/swagger',
      '@fastify/swagger-ui',
      '@prisma/client',
      'bcrypt',
      'fastify',
      'fastify-plugin',
      'ioredis',
      'nodemailer',
      'pino',
      'zod',
    ]);
  });
});

describe('template layering', () => {
  it('only the registry knows the key vocabulary', () => {
    const holders = FILES.filter((file) => file.source.includes('EMAIL_TEMPLATE_KEYS')).map(
      (file) => file.rel,
    );
    expect(holders).toEqual(['email-template-registry.ts']);
  });

  it('only the templates and the layout know the copy', () => {
    const holders = FILES.filter((file) =>
      file.source.includes('Your Oxyide password was successfully changed.'),
    ).map((file) => file.rel);
    expect(holders).toEqual(['email-templates.ts']);
  });

  it('only the layout renders markup, so escaping has exactly one implementation', () => {
    const markupHolders = FILES.filter((file) => file.source.includes('<table')).map(
      (file) => file.rel,
    );
    expect(markupHolders).toEqual(['email-layout.ts']);
  });
});