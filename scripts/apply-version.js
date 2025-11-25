#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const version = pkg.version.replace(/[^0-9.]/g, '');
const markupFiles = ['public/locate-me.html', 'public/locate.html'];

function updateFile(filePath) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    console.warn(`apply-version: ${filePath} not found, skipping.`);
    return;
  }
  let contents = fs.readFileSync(absolutePath, 'utf8');
  contents = contents.replace(/(Levante Locate Me · v)([0-9.]+)/g, `$1${version}`);
  contents = contents.replace(/\?v=[0-9.]+/g, `?v=${version}`);
  fs.writeFileSync(absolutePath, contents, 'utf8');
  console.log(`apply-version: Updated ${filePath} to version ${version}`);
}

for (const file of markupFiles) {
  updateFile(file);
}
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const version = pkg.version.replace(/[^0-9.]/g, '');
const markupFiles = ['public/locate-me.html', 'public/locate.html'];

function updateFile(filePath) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    console.warn(`apply-version: ${filePath} not found, skipping.`);
    return;
  }
  let contents = fs.readFileSync(absolutePath, 'utf8');
  contents = contents.replace(/(Levante Locate Me · v)([0-9.]+)/g, `$1${version}`);
  contents = contents.replace(/\?v=[0-9.]+/g, `?v=${version}`);
  fs.writeFileSync(absolutePath, contents, 'utf8');
  console.log(`apply-version: Updated ${filePath} to version ${version}`);
}

for (const file of markupFiles) {
  updateFile(file);
}

