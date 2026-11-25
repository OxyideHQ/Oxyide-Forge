#!/usr/bin/env node
'use strict';

/**
 * M19.2-R1 — customer-package link and leakage verification.
 *
 * Checks the documentation that ships to customers, resolving every relative
 * link against an explicit package root (repository checkout OR extracted
 * ZIP directory) instead of the caller's working directory:
 *
 *   node scripts/package-link-check.cjs [--root <dir>]
 *
 * Findings (all fail-closed, all name the offending document and link):
 *   - relative links whose targets do not exist on disk;
 *   - same-file and cross-file `#anchor` links with no matching heading;
 *   - developer-machine locations (webview schemes, sandbox paths, absolute
 *     home/tmp paths, Windows user paths);
 *   - links into internal engineering records (milestones, audits, working
 *     notes) that must never ship to customers.
 *
 * Exit 0 = clean; exit 1 = findings (listed). External-link reachability is
 * deliberately NOT checked: the core suite must not depend on network
 * availability.
 *
 * Only `node:` built-ins are used — no new dependencies.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

function listCustomerDocs(rootDir, shippedFiles) {
  return shippedFiles.filter((rel) => /\.(md|txt)$/.test(rel));
}

function relativeLinks(markdown) {
  const links = [];
  for (const match of markdown.matchAll(/\[.*?\]\((.*?)\)/g)) {
    const link = match[1].trim();
    if (
      link === '' ||
      link.startsWith('http://') ||
      link.startsWith('https://') ||
      link.startsWith('mailto:') ||
      link.startsWith('#')
    ) {
      continue;
    }
    links.push(link);
  }
  return links;
}

/** GitHub heading-anchor algorithm (deterministic subset). */
function githubAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

function headingsOf(markdown) {
  const anchors = new Set();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    anchors.add(githubAnchor(match[1].replace(/\[(.*?)\]\(.*?\)/g, '$1')));
  }
  return anchors;
}

const LOCAL_PATTERNS = [
  'vscode-resource',
  'vscode-webview',
  'vscode-cdn',
  'sandbox:/mnt/data',
  'mnt/data',
  'C:\\Users',
  'C:/Users',
];

const INTERNAL_LINK = /(^|\/)(milestones|audits)\/|MEMORY\.md|customer-package\.md|price_analysis\.md|forge-v1-audit\.md/;

function readDoc(rootDir, rel) {
  return fs.readFileSync(path.join(rootDir, rel), 'utf8');
}

/**
 * Run every check against `rootDir` using `shippedFiles` as the customer set.
 * Pure apart from filesystem reads. Returns findings arrays (empty = clean).
 */
function checkPackageLinks(rootDir, shippedFiles) {
  const brokenLinks = [];
  const brokenAnchors = [];
  const localLeaks = [];
  const internalLinks = [];
  const docs = listCustomerDocs(rootDir, shippedFiles);

  for (const doc of docs) {
    let text;
    try {
      text = readDoc(rootDir, doc);
    } catch {
      brokenLinks.push(`${doc} -> (unreadable document)`);
      continue;
    }
    const anchors = headingsOf(text);
    for (const link of relativeLinks(text)) {
      const hash = link.indexOf('#');
      const target = hash === -1 ? link : link.slice(0, hash);
      const anchor = hash === -1 ? '' : link.slice(hash + 1);
      if (target !== '') {
        const abs = path.resolve(rootDir, path.dirname(doc), target);
        const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
        if (abs !== rootDir && !abs.startsWith(rootWithSep)) {
          brokenLinks.push(`${doc} -> ${link} (escapes the package root)`);
        } else if (!fs.existsSync(abs)) {
          brokenLinks.push(`${doc} -> ${link}`);
        } else if (anchor !== '') {
          let targetAnchors;
          try {
            targetAnchors = headingsOf(fs.readFileSync(abs, 'utf8'));
          } catch {
            targetAnchors = new Set();
          }
          if (!targetAnchors.has(anchor)) brokenAnchors.push(`${doc} -> ${link}`);
        }
      } else if (anchor !== '' && !anchors.has(anchor)) {
        brokenAnchors.push(`${doc} -> ${link}`);
      }
      if (INTERNAL_LINK.test(link)) internalLinks.push(`${doc}: ${link}`);
    }
    const localHits = LOCAL_PATTERNS.filter((pattern) => text.includes(pattern));
    if (localHits.length > 0) localLeaks.push(`${doc}: ${localHits.join(', ')}`);
    if (/\/home\/[a-z]/i.test(text) || /\/tmp\/[a-z]/i.test(text)) localLeaks.push(`${doc}: absolute developer path`);
  }

  return { documents: docs.length, brokenLinks, brokenAnchors, localLeaks, internalLinks };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let rootDir = DEFAULT_ROOT;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root' && i + 1 < args.length) {
      rootDir = path.resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write('Usage: node scripts/package-link-check.cjs [--root <dir>]\n');
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${args[i]}\n`);
      process.exit(2);
    }
  }
  // --root targets an extracted artifact: enumerate its on-disk Markdown set
  // with the same customer-doc filter instead of the source checkout's git set.
  let shipped;
  if (path.resolve(rootDir) === DEFAULT_ROOT) {
    shipped = require('./dist-file-set.cjs').shippedFiles();
  } else {
    shipped = [];
    const walk = (abs, relPrefix) => {
      let entries;
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(abs, entry.name), rel);
        else if (entry.isFile() && /\.(md|txt)$/.test(entry.name)) shipped.push(rel);
      }
    };
    walk(rootDir, '');
    shipped.sort();
  }
  const findings = checkPackageLinks(rootDir, shipped);
  const total =
    findings.brokenLinks.length +
    findings.brokenAnchors.length +
    findings.localLeaks.length +
    findings.internalLinks.length;
  process.stdout.write(`Package link check: ${findings.documents} customer document(s), ${total} finding(s).\n`);
  for (const link of findings.brokenLinks) process.stdout.write(`  BROKEN LINK  ${link}\n`);
  for (const anchor of findings.brokenAnchors) process.stdout.write(`  BROKEN ANCHOR  ${anchor}\n`);
  for (const leak of findings.localLeaks) process.stdout.write(`  LOCAL LEAK  ${leak}\n`);
  for (const link of findings.internalLinks) process.stdout.write(`  INTERNAL LINK  ${link}\n`);
  process.exit(total === 0 ? 0 : 1);
}

module.exports = {
  checkPackageLinks,
  relativeLinks,
  githubAnchor,
  headingsOf,
  LOCAL_PATTERNS,
  INTERNAL_LINK,
};
