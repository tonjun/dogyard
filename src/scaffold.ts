import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LoadedFlow } from "./loader.js";
import { FLOW_NAME_RE, type CommandStep, type MapStep } from "./schema/flow.js";

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
  mkdirSync(path.join(dir, "steps/shout/tests"), { recursive: true });
  mkdirSync(path.join(dir, "steps/shout/evals"), { recursive: true });

  const files: Record<string, string> = {
    "flow.yaml": flowYaml(opts.name),
    "tests/basic.test.yaml": testYaml(),
    "evals/eval.yaml": evalYaml(),
    "evals/dataset.yaml": datasetYaml(),
    "steps/shout/tests/basic.test.yaml": shoutStepTestYaml(),
    "steps/shout/evals/eval.yaml": shoutStepEvalYaml(),
    "steps/shout/evals/dataset.yaml": shoutStepDatasetYaml(),
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

# The initial trigger is an optional JSON object (default {}); it is available in expressions as \`trigger\`.
# \`required\` is how a flow demands input.
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

function shoutStepTestYaml(): string {
  return `# Step-level tests run only the \`shout\` step against a supplied context.
# Each case needs exactly one of: mock, mocks_file, real: true.
tests:
  - name: input is built from the trigger
    context:
      trigger: { query: "hello" }
    mock: { output: { shouted: "HELLO" } }
    expect:
      input: { text: "hello" }
      output: { shouted: "HELLO" }

  - name: the real command uppercases the text
    context:
      trigger: { query: "hello" }
    real: true
    expect:
      output: { shouted: "HELLO" }
`;
}

function shoutStepEvalYaml(): string {
  return `# Step eval: dataset examples supply a context for the \`shout\` step (real command by default).
dataset: dataset.yaml
pass_threshold: 1
graders:
  - type: exact
    name: exact-output
  - type: jsonata
    name: shouted-is-uppercase
    expression: "output.shouted = $uppercase(trigger.query)"
`;
}

function shoutStepDatasetYaml(): string {
  return `examples:
  - id: hello
    context: { trigger: { query: "hello" } }
    expected: { shouted: HELLO }
  - id: mixed-case
    context: { trigger: { query: "DogYard" } }
    expected: { shouted: DOGYARD }
`;
}

export interface ScaffoldStepOptions {
  loaded: LoadedFlow;
  step: string;
  force?: boolean;
}

/** Create `steps/<step>/` with a starter test and eval for an existing command (or map-of-command) step. */
export function scaffoldStep(opts: ScaffoldStepOptions): ScaffoldResult {
  const { loaded, step } = opts;
  const def = loaded.flow.steps[step];
  if (!def) throw new Error(`Unknown step "${step}" in ${loaded.file}`);
  const isMap = def.type === "map";
  const target = isMap ? (def as MapStep).step : def;
  if (target.type !== "command") throw new Error(`Step "${step}" is a ${isMap ? "map of " : ""}${target.type} step; step folders are for command steps`);
  const dir = path.join(loaded.dir, "steps", step);
  if (existsSync(dir) && !opts.force) throw new Error(`Directory already exists: ${dir}`);
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  mkdirSync(path.join(dir, "evals"), { recursive: true });

  const files: Record<string, string> = {
    "tests/basic.test.yaml": stepTestTemplate(step, def as CommandStep | MapStep, target as CommandStep, isMap),
    "evals/eval.yaml": stepEvalTemplate(step),
    "evals/dataset.yaml": stepDatasetTemplate(def as CommandStep | MapStep, isMap),
  };
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    writeFileSync(f, content);
    written.push(f);
  }
  return { dir, files: written };
}

function contextTemplate(def: CommandStep | MapStep, isMap: boolean, indent: string): string {
  const lines = [`${indent}trigger: {}`];
  if (def.needs.length) {
    lines.push(`${indent}steps:`);
    for (const dep of def.needs) lines.push(`${indent}  ${dep}: null   # output of upstream step "${dep}"`);
  }
  if (isMap) lines.push(`${indent}item: null   # one element of \`${(def as MapStep).over}\``, `${indent}index: 0`);
  return lines.join("\n");
}

function stepTestTemplate(step: string, def: CommandStep | MapStep, target: CommandStep, isMap: boolean): string {
  return `# Step-level tests for "${step}": each case runs only this step against the given context.
# Each case needs exactly one of: mock, mocks_file, real: true.
tests:
  - name: resolves its input and argv
    context:
${contextTemplate(def, isMap, "      ")}
    mock: { output: null }
    expect:
      argv: ${JSON.stringify(target.command)}
      # input: ...

  - name: the real command runs
    context:
${contextTemplate(def, isMap, "      ")}
    real: true
    expect:
      status: succeeded
      # output_jsonata: "..."   # evaluated over { output, input, argv, context, step }
`;
}

function stepEvalTemplate(step: string): string {
  return `# Step eval for "${step}": dataset examples supply a context and an expected value (real command by default).
dataset: dataset.yaml
pass_threshold: 1
graders:
  - type: jsonata
    name: matches-expected
    expression: "output = expected"
`;
}

function stepDatasetTemplate(def: CommandStep | MapStep, isMap: boolean): string {
  return `examples:
  - id: example-1
    context:
${contextTemplate(def, isMap, "      ")}
    expected: null
`;
}
