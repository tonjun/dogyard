#!/usr/bin/env node
// Fake scorer: {sourceCount, summaries:[{summary}]} -> {score}
let data = "";
process.stdin.on("data", (d) => (data += d));
process.stdin.on("end", () => {
  const { sourceCount = 0, summaries = [] } = data ? JSON.parse(data) : {};
  const good = summaries.filter((s) => s && s.summary).length;
  const score = sourceCount ? Number((good / sourceCount).toFixed(2)) : 0;
  process.stdout.write(JSON.stringify({ score, good, sourceCount }));
});
