#!/usr/bin/env node
// Sleeps <ms> (argv[2]) then echoes stdin JSON back with a `done` flag.
let data = "";
process.stdin.on("data", (d) => (data += d));
process.stdin.on("end", () => {
  setTimeout(() => {
    const v = data ? JSON.parse(data) : null;
    process.stdout.write(JSON.stringify({ done: true, item: v }));
  }, Number(process.argv[2] ?? 0));
});
