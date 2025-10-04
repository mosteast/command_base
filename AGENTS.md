# Rules

## Naming Conventions

- Use snake_case for directories (e.g., services/auth_service)
- Favor named exports
- Use `snake_case` for classic camelCase, example:
  - File names: `user_utils.ts`
  - Variables: `user_data`
- Use `Cap_snake_case` for classic PascalCase, example:
  - Services: `User_service`
  - Type definitions: `User_data`
  - Interfaces: `I_user_profile`
- Use singular form for directory names:
  - `service` instead of `services`
  - `repository` instead of `repositories`

## Code Quality

- Generate reliable, enterprise-level code, use best practices
- Write self-documenting code with clear variable/function names
- Implement proper error handling and logging
- Follow Node.js, Bash, Python performance best practices

## Testing

- Do not run full test if not necessary, use `npx vitest run path/to/test_file.test.ts ...` instead
- Maintain high test coverage
- Use Vitest to test single file with the following command format:
  `npx vitest run path/to/test_file.test.ts --testNamePattern="block name"`

## Code Reusability

- You can assemble existing commands to build new commands.
- Do not reinvent the wheel, use existing commands/libraries/packages if possible.

## Colorful Output

- Use colorful output to make the output more readable.

## Glob

- All commands should support glob patterns by default.
- Properly handle special characters in paths like spaces.

## Documentation

- All Command should have a proper help message, at lease include the following information:
  - Usage
  - Description
  - Options
    - List and explain all options if an option is enum-like.
    - All boolean should be false by default.
  - Examples
    - Should have some examples to show how to use the command.
    - Each example should have a comment to explain what the example does.
    - Format of Examples:

      ```
      # Description
      $0 a/b/*.txt c/*.md

      # Description
      $0 --option a/*.md

      ...
      ```

  - ...

## General CLI Options

Must Support

- `-h, --help`
- `-v, --version`: should only show version number and nothing else
- `--debug`: print verbose output and debug logs

Support following options if possible:

- `--quiet`: print only warnings and errors
- `-d, --dry-run`: print what will be done without actually doing it

## Global/System Variables

- Variables that's only used in tools should be set in source/zshrc_custom
