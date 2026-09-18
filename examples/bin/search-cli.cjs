#!/usr/bin/env node
// Fake search tool: reads {q, limit} JSON on stdin, prints {results:[{id,title,body}]}.
let data = "";
process.stdin.on("data", (d) => (data += d));
process.stdin.on("end", () => {
  const { q = "", limit = 3 } = data ? JSON.parse(data) : {};
  const results = Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
    id: `${q}-${i + 1}`,
    title: `Result ${i + 1} for "${q}"`,
    body: `${q} `.repeat(i + 2).trim(),
  }));
  process.stdout.write(JSON.stringify({ results }));
});
