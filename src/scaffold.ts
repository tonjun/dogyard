import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FLOW_NAME_RE } from "./schema/flow.js";

export interface ScaffoldOptions {
  name: string;
  /** Parent directory in which `<name>/` is created. */
  dir: string;
  force?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
}

/** Create a self-contained flow folder with a flow.yaml, a test, and an eval dataset/config. */
export function scaffoldFlow(opts: ScaffoldOptions): ScaffoldResult {
  if (!FLOW_NAME_RE.test(opts.name)) throw new Error(`Invalid flow name "${opts.name}" (use lowercase letters, digits, - and _)`);
  const dir = path.resolve(opts.dir, opts.name);
  if (existsSync(dir) && !opts.force) throw new Error(`Directory already exists: ${dir}`);
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  mkdirSync(path.join(dir, "mocks"), { recursive: true });

  const files: Record<string, string> = {
    "flow.yaml": flowYaml(opts.name),
    "tests/basic.test.yaml": testYaml(),
    "evals/eval.yaml": evalYaml(),
    "evals/dataset.yaml": datasetYaml(),
    "mocks/.gitkeep": "",
    ".gitignore": ".runs/\nevals/reports/\n",
  };
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    writeFileSync(f, content);
    written.push(f);
  }
  return { dir, files: written };
}

function flowYaml(name: string): string {
  return `# Flow definition. See README for the full schema.
schema_version: 1
name: ${name}
version: 0.1.0
description: Echo the query back, uppercased.

config:
  default_timeout: 30s
  default_retry:
    max_attempts: 1
    backoff: 1s
    on: [command_failure]

# The initial trigger is a JSON object; it is available in expressions as \`trigger\`.
trigger_schema:
  type: object
  required: [query]
  properties:
    query: { type: string }

steps:
  # A command step: JSON input is written to stdin (input_mode: stdin, the default).
  # Any argv entry starting with "=" is a JSONata expression.
  shout:
    type: command
    command: ["node", "-e", "process.stdout.write(JSON.stringify({ shouted: JSON.parse(require('fs').readFileSync(0,'utf8')).text.toUpperCase() }))"]
    input: '{ "text": trigger.query }'

  # A choice step routes to exactly one target; the others are skipped.
  route:
    type: choice
    needs: [shout]
    branches:
      - when: "$length(steps.shout.output.shouted) > 3"
        next: long
    default: short

  long:
    type: pass
    input: '{ "kind": "long", "value": steps.shout.output.shouted }'
    terminal: success

  short:
    type: pass
    input: '{ "kind": "short", "value": steps.shout.output.shouted }'
    terminal: success
`;
}

function testYaml(): string {
  return `tests:
  - name: long queries go to the long branch
    trigger: { query: "hello" }
    mocks:
      shout: { output: { shouted: "HELLO" } }
    expect:
      output: { kind: long, value: HELLO }
      path: [shout, route, long]
      skipped: [short]

  - name: short queries go to the short branch
    trigger: { query: "hi" }
    mocks:
      shout: { output: { shouted: "HI" } }
    expect:
      output: { kind: short, value: HI }
      path: [shout, route, short]
`;
}

function evalYaml(): string {
  return `# Evaluation config: dataset examples are run through the flow (real commands by default) and scored.
dataset: dataset.yaml
pass_threshold: 1
graders:
  - type: exact
    name: exact-output
  - type: jsonata
    name: value-is-uppercase
    expression: "output.value = $uppercase(trigger.query)"
`;
}

function datasetYaml(): string {
  return `examples:
  - id: hello
    trigger: { query: "hello" }
    expected: { kind: long, value: HELLO }
  - id: hi
    trigger: { query: "hi" }
    expected: { kind: short, value: HI }
`;
}
