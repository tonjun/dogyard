#!/usr/bin/env node
// Fake LLM runner: `llm-run --prompt-file <file>` with {text} on stdin -> {summary}.
// Any real LLM CLI would slot in here; the engine does not special-case it.
const fs = require("node:fs");
const args = process.argv.slice(2);
const promptFile = args[args.indexOf("--prompt-file") + 1];
const prompt = promptFile && fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8").trim() : "(no prompt)";
let data = "";
process.stdin.on("data", (d) => (data += d));
process.stdin.on("end", () => {
  const { text = "" } = data ? JSON.parse(data) : {};
  if (/fail/i.test(text)) {
    process.stderr.write("model refused\n");
    process.exit(2);
  }
  const words = text.split(/\s+/).filter(Boolean);
  process.stdout.write(JSON.stringify({ summary: `${prompt.split("\n")[0]}: ${words.length} words`, words: words.length }));
});
