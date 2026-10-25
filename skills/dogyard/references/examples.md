# Example flows

All of these pass `dogyard validate`. The package also ships runnable examples
(`hello`, `research`, `flaky`, `filter`) under
`"$(npm root -g)/dogyard/examples/flows"`. Copy them somewhere writable before
running, because runs write `.runs/` next to the flow.

## 1. Minimal: command → transform

```yaml
schema_version: 1
name: word-count
version: 0.1.0
trigger_schema: { type: object, required: [path], properties: { path: { type: string } } }
steps:
  count:
    type: command
    command: ["wc", "-w", "=trigger.path"]
    output_mode: text
  report:
    type: transform
    needs: [count]
    input: '{ "words": $number($split($trim(steps.count.output), " ")[0]) }'
```

```bash
dogyard run flows/word-count --input '{"path": "README.md"}'
```

## 2. Long-running batch: an LLM over every line of a file

`flows/classify/flow.yaml`. Each item is cached, so a rerun after a crash or an
edit only processes new or failed items. Failures are caught per item, so one bad
row doesn't kill a 2-hour run.

```yaml
schema_version: 1
name: classify
version: 0.1.0
description: Classify every ticket in a JSONL file with an LLM, then summarize.
config:
  default_timeout: 2m
  run_timeout: 6h
trigger_schema:
  type: object
  required: [file]
  properties: { file: { type: string } }
steps:
  load:
    type: command
    command: ["node", "-e", "process.stdout.write(JSON.stringify(require('fs').readFileSync(process.argv[1],'utf8').trim().split('\\n').map(JSON.parse)))", "=trigger.file"]
    output_mode: json
  classify_each:
    type: map
    needs: [load]
    over: "steps.load.output"
    max_concurrency: 8
    step:
      type: command
      command: ["claude", "-p", "--output-format", "json", "--system-prompt-file", "prompt.md"]
      cwd: steps/classify_each
      input: "item.text"
      input_mode: stdin
      output_mode: json
      cache: { files: [prompt.md] }
      retry: { max_attempts: 3, backoff: 10s, on: [timeout, nonzero_exit] }
      catch: [{ error_type: any, result: { label: "error" } }]
  summary:
    type: transform
    needs: [classify_each]
    input: '{ "total": $count(steps.classify_each.output), "errors": $count(steps.classify_each.output[label = "error"]) }'
```

Note: `trigger.file` is passed in as an argument and resolves from the step's cwd (the flow folder
here), so pass an absolute path or one relative to the flow.

Operating it:

```bash
dogyard validate flows/classify
dogyard run flows/classify --input "{\"file\": \"$PWD/tickets.jsonl\"}" --detach
dogyard runs flows/classify                  # progress: items done/total
dogyard runs logs flows/classify -f          # live stderr
dogyard runs stop flows/classify             # if needed
dogyard resume flows/classify <run_id> --detach
dogyard runs show flows/classify | jq '.output'   # final output (steps is an array of { name, status, output, ... })
```

## 3. Routing with `choice`

```yaml
schema_version: 1
name: triage
version: 0.1.0
steps:
  score:
    type: command
    command: ["node", "score.js"]
    input: "trigger"
  route:
    type: choice
    needs: [score]
    branches:
      - { when: "steps.score.output.score >= 0.7", next: accept }
    default: review
  accept:
    type: pass
    input: '{ "accepted": true }'
    terminal: success
  review:
    type: pass
    input: '{ "accepted": false, "score": steps.score.output.score }'
    terminal: success
```

Test for it (`tests/route.test.yaml`):

```yaml
tests:
  - name: high score is accepted
    mocks: { score: { output: { score: 0.9 } } }
    expect: { output: { accepted: true }, skipped: [review] }
  - name: scorer failure fails the run
    mocks: { score: { stdout: "", stderr: "boom", exit_code: 1 } }
    expect: { error_type: nonzero_exit }
```
