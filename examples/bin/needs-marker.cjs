#!/usr/bin/env node
// Fails until the marker file given as argv[2] exists. Used to demonstrate resume.
const fs = require("node:fs");
const marker = process.argv[2];
if (!marker || !fs.existsSync(marker)) {
  process.stderr.write(`marker ${marker} not present\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, marker }));
