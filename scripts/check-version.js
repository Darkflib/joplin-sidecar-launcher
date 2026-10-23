#!/usr/bin/env node
// Verifies that package.json and src/manifest.json agree on the version, and
// (optionally) that a release tag matches it. Joplin reads the version from
// manifest.json, so a drift here ships a .jpl that reports the wrong version.
//
// Usage: node scripts/check-version.js [tag]   e.g. v0.3.1 or refs/tags/v0.3.1
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function readVersion(rel) {
  const file = path.join(root, rel);
  try {
    const { version } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof version !== 'string' || !version) {
      throw new Error('missing "version" field');
    }
    return version;
  } catch (err) {
    console.error(`::error file=${rel}::Cannot read version from ${rel}: ${err.message}`);
    process.exit(1);
  }
}

const pkg = readVersion('package.json');
const manifest = readVersion('src/manifest.json');

if (pkg !== manifest) {
  console.error(`::error::Version mismatch: package.json=${pkg}, src/manifest.json=${manifest}`);
  process.exit(1);
}

const rawTag = process.argv[2];
if (rawTag) {
  const tag = rawTag.replace(/^refs\/tags\//, '');
  const tagVersion = tag.replace(/^v/, '');
  if (tagVersion !== pkg) {
    console.error(`::error::Tag ${tag} does not match package version ${pkg} (expected v${pkg})`);
    process.exit(1);
  }
}

console.log(`Version OK: ${pkg}`);
