import type { CommandModule } from './command.js';
import { makeStubCommand } from './command.js';
import { initCommand } from './commands/init.js';
import { validateCommand } from './commands/validate.js';
import { agentsCommand } from './commands/agents.js';
import { runCommand } from './commands/run.js';
import { mergeCommand } from './commands/merge.js';
import { cleanCommand } from './commands/clean.js';

export const COMMAND_MODULES: CommandModule[] = [
  initCommand,
  makeStubCommand({
    name: 'plan',
    describe: 'Generate an implementation plan',
    phase: 'F9',
    args: [{ name: 'description' }],
  }),
  makeStubCommand({
    name: 'convert',
    describe: 'Convert an implementation plan into an execution plan',
    phase: 'F10',
    args: [{ name: 'plan' }],
  }),
  validateCommand,
  makeStubCommand({
    name: 'view',
    describe: 'Static plan viewer (TUI)',
    phase: 'F11',
    args: [{ name: 'exec-plan' }],
  }),
  runCommand,
  makeStubCommand({
    name: 'status',
    describe: 'Inspect a run',
    phase: 'F11',
    args: [{ name: 'run-id', required: false }],
  }),
  mergeCommand,
  cleanCommand,
  agentsCommand,
  makeStubCommand({
    name: 'skills',
    describe: 'Skill management (install/sync)',
    phase: 'F8',
    args: [{ name: 'subcommand', required: false }],
  }),
  makeStubCommand({
    name: 'doctor',
    describe: 'Diagnose environment and config',
    phase: 'F13',
  }),
  makeStubCommand({
    name: 'serve',
    describe: 'Start the yaao MCP server',
    phase: 'F12',
  }),
];
