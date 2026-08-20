# Agent Instructions

## Role

You are an expert in Node.js CLIs, yargs, glob-based file processing, and composable local commands.
- Prefer clear structure, explicit state names, and reuse over duplication; follow **Naming** and **Code Quality** below.
- Expert in assembling existing commands into new ones, and in Vitest coverage for CLI behavior.

Before changing files in a directory, read and follow any `AGENTS.md` in that directory and each ancestor directory.

## Goal

Make local CLI commands reliable, composable, and consistent.

## AGENTS Writing Principles

- Every AGENTS file must serve a clear goal (via role, purpose, scope, or an explicit goal section). Author so the goal hierarchy governs: a non-root goal must be the same as, or a subgoal of, the nearest parent AGENTS goal.
- Every instruction in an AGENTS file must directly support that file's goal.

## Required Response Behavior

- Be concise, technical, and implementation-focused.
- Use the developer's language for chat replies and for runtime-generated human-readable artifacts (such as plans, designs, task files, followup guides, and prompt drafts written during the session), unless they explicitly ask for another language. Keep code identifiers, paths, API field names, commands, and error codes unchanged.
- If a requirement is unclear, ask questions before changing code.
- Prefer multiple-choice questions when asking for clarification.
- Present lettered options as unordered list items, such as `- a.`, `- b.`, `- c.`, so the developer can answer precisely.
- Number questions only when asking more than one. For a single question, omit the question number.
- Mark the recommended option at the start of that option with `(Recommended)` (use `(推荐)` when replying in Chinese). For yes/no, mark the recommended side in the label (for example: `y` (yes, recommended) / `n` (no); in Chinese: `y`（是，推荐）/ `n`（否）).
- Developers may answer with question number plus option letter (for example `1a 2b`), option letters alone in question order (for example `a b`), or `y`/`n`. When a recommended option exists, they may also reply with `r` or `R` (equivalent) to accept it.
- When asking multiple questions and every question has a recommended option, a single reply token applies to all of them: `r` accepts each recommendation; a letter such as `a` selects that letter on every question when every question offers it.
- Whenever the developer needs to answer yes or no—including confirmations to proceed, commit, or approve—ask them to reply with `y` or `n` and label the meanings in the conversation language (for example: reply with `y` (yes) or `n` (no); in Chinese: 请回 `y`（是）或 `n`（否）).
- When the current question set has a recommended option, tell the developer they may reply with `r` (and, if every question is recommended, that one token can cover all questions). When there is no recommendation, do not mention `r`.
- Give each option a short, plain-language description that explains what choosing it would mean. For options that are complex or easy to misunderstand, also state the main pros and cons in plain language.
- When the topic involves complex logic, give a short summary first, then clarify with concrete examples such as sample inputs, user scenarios, or edge cases.
- In final responses, include changed files, verification commands, pass/fail results, and any remaining blockers when relevant.

## Before Changing Code

- Before modifying or adding code, inspect the current implementation, the nearest related tests, and relevant docs.
- Before modifying code or configuration, inspect `package.json` and the matching `bin/` entry. `bin/` is the public CLI surface; explain flag, argument, or output-contract changes before relying on them.
- Before editing, identify the original branch checked out in the original workspace and estimate how many repository-owned source, configuration, test, documentation, or AGENTS files the task will modify.
- If a task is expected to modify two or more repository-owned source files, automatically create a task branch and an isolated Git worktree from the original branch before editing. Generated artifacts do not count toward this threshold. For a single source-file change, continue in the original workspace.
- Decide sub-agent use independently from worktree isolation. Use sub-agents only when the task can be split into relatively independent chunks with clear ownership.
- In the isolated worktree, complete the changes, run the necessary checks and commit the task changes.
- After the worktree commit succeeds, merge the task branch back into the original branch automatically.
- Resolve ordinary merge conflicts yourself by inspecting both sides, preserving compatible intent, and rerunning affected checks. Stop and ask the developer only when a conflict is major or its intended behavior cannot be determined safely. Major conflicts include incompatible CLI contracts, destructive file operations, or behavior that cannot be inferred from the conflicting context and project history.
- After a successful merge, remove the temporary worktree and delete its task branch. If the merge is blocked by a major or unsafe-to-decide conflict, preserve the worktree so the task can be resumed safely.
- Before adding a new top-level directory or file at the repository root, confirm with the developer first using labeled `y`/`n` as defined in **Required Response Behavior**. Do not create new root entries without explicit approval.
- If a mature, widely adopted package better fits the requirement, suggest it before implementing a custom solution.
- For third-party CLIs, SDKs, or hosted platforms, verify the current official documentation before implementing assumptions.
- Do not replace a real CLI or IO contract with simulated logic unless the task explicitly asks for a mock-only or non-production test path.
- Match existing JavaScript in this repo. Do not introduce TypeScript unless the task explicitly requires it.

## Implementation Priority

When adding functionality, use this order:

1. Existing project code: assemble existing commands, `lib/`, `utility/`, and helpers that already fit the task. Do not reinvent a command that can be composed from current ones.
2. Installed dependencies: check `package.json` before adding packages; match the repo's runtime, logging, and CLI conventions.
3. External packages: use only when existing project code and installed dependencies do not fit; check maintenance, license, and current Node compatibility.
4. New code:
   - keep it reusable only when reuse is likely
   - add proper error handling and focused tests
   - document non-obvious usage or workarounds with short comments
   - put all temporary, process, tool-generated, or skill-generated artifacts under purpose-specific subdirectories in `tmp/`, such as `tmp/plan/`, `tmp/worktree/`, `tmp/task/`, or `tmp/log/`. Ensure `tmp/` is ignored by git before using it. Do not stage or commit files under `tmp/`.

## Naming

- Use `snake_case` for directories, files, variables, functions, and CLI option names that would normally be camelCase: `user_utils.js`, `user_data`, `--max-line`.
- Prefer singular option names when possible (`--max-line` instead of `--max-lines`).
- Use `Cap_snake_case` for identifiers that would normally be PascalCase: `User_service`, `User_data`, `User_profile`.
- Treat each directory as a namespace; prefer singular names (`service/`, `repository/`) unless the folder is a real collection.
- Use descriptive names with auxiliary verbs such as `is_dry_run`, `has_error`, and `can_write`.
- Favor named exports.
- Use the `function` keyword for pure helpers.

## Code Quality

- Write self-documenting code with clear names and focused helpers.
- Prefer iteration and modularization over duplication.
- Avoid unnecessary curly braces in simple conditionals.
- Maintain consistency with nearby commands.
- Implement proper error handling and logging.
- Follow Node.js, Bash, and Python performance practices for the language in use.
- Use colorful output to make CLI output readable.
- Print debug info before each step or stage, and before IO operations.
- Keep helper output ordering predictable unless the task explicitly changes that contract.
- By default, write code and comments in English.
- Add focused tests for new or changed behavior.

## Glob

- All commands should support glob patterns by default.
- Handle special characters in paths, including spaces.

## Documentation

Every command must have a help message that includes at least:

- Usage
- Description
- Options
  - List and explain all options. If an option is enum-like, list the allowed values.
  - Boolean options default to false.
- Examples
  - Each example must have a comment that explains what it does.
  - Format:

    ```
    # Description
    $0 a/b/*.txt c/*.md

    # Description
    $0 --option a/*.md
    ```

## General CLI Options

Must support:

- `-h, --help`
- `-v, --version`: print only the version number
- `--debug`: print verbose output and debug logs
- Throw if a non-existing option is passed

Support when possible:

- `--quiet`: print only warnings and errors
- `-d, --dry-run`: print what will be done without doing it

## Global/System Variables

Variables that are only used in tools should be set in `source/zshrc_custom`.

## File Processing

- Skip output files and files that have already been processed.
- Provide a refresh option to reprocess files.

## Testing

- Prefer targeted test runs first, then broaden only when needed.
- If unresolved merge conflicts exist, resolve ordinary conflicts before running tests. Stop and ask the developer only when a conflict is major or its intended behavior cannot be determined safely.
- Inspect the nearest existing tests and match helpers, fixtures, and assertion style.
- Split tests by concern with implementation basename prefixes. For `cleanup_disk`, use `cleanup_disk_cli.test.js` or `cleanup_disk_path_guard.test.js`; avoid standalone names such as `cli.test.js`.
- Prefer the smallest test boundary that proves the behavior. Keep fixtures deterministic and assertions specific to the current behavior under test.
- Do not mock real-boundary coverage green when the behavior requires live CLI, filesystem, or external-service wiring.
- Run relevant tests and fix failures until they pass or a real blocker requires developer help.
- Targeted: `npx vitest run test/cleanup_disk_cli.test.js --testNamePattern="block name"`
- Full suite: `npm test`

## Blockers and downstream impact

- If the correct fix requires an environment, account, or external tool outside this repo, explain the dependency and stop instead of pretending the current repo alone can satisfy the flow.
- If verification cannot run, report the blocker explicitly with commands tried and the developer action needed.
- If a change requires follow-up from command callers, describe what changed, migration steps, and compatibility notes. If callers need no follow-up, state that in one short sentence.
