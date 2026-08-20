'use strict';

const { rmSync } = require('node:fs');
const { resolve } = require('node:path');

const repositoryRoot = resolve(__dirname, '..');
const distributionRoot = resolve(repositoryRoot, 'dist');

if (distributionRoot !== resolve(repositoryRoot, 'dist')) {
  throw new Error('refusing to clean an unexpected artifact directory');
}

rmSync(distributionRoot, { recursive: true, force: true });
