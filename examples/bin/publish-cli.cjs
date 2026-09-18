#!/usr/bin/env node
// Fake publisher: echoes how many items it "published".
let data = "";
process.stdin.on("data", (d) => (data += d));
process.stdin.on("end", () => {
  const items = data ? JSON.parse(data) : [];
  process.stdout.write(JSON.stringify({ published: Array.isArray(items) ? items.length : 1 }));
});
