import type { CommandModule } from './command.js';
import { makeStubCommand } from './command.js';
import { initCommand } from './commands/init.js';

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
  makeStubCommand({
    name: 'validate',
    describe: 'Validate an execution plan',
    phase: 'F2',
    args: [{ name: 'exec-plan' }],
  }),
  makeStubCommand({
    name: 'view',
    describe: 'Static plan viewer (TUI)',
    phase: 'F11',
    args: [{ name: 'exec-plan' }],
  }),
  makeStubCommand({
    name: 'run',
    describe: 'Execute a plan across worktrees',
    phase: 'F5',
    args: [{ name: 'exec-plan' }],
  }),
  makeStubCommand({
    name: 'status',
    describe: 'Inspect a run',
    phase: 'F11',
    args: [{ name: 'run-id', required: false }],
  }),
  makeStubCommand({
    name: 'merge',
    describe: 'Merge completed worktrees',
    phase: 'F6',
    args: [{ name: 'run-id', required: false }],
  }),
  makeStubCommand({
    name: 'clean',
    describe: 'Tear down worktrees and branches',
    phase: 'F6',
    args: [{ name: 'run-id', required: false }],
  }),
  makeStubCommand({
    name: 'agents',
    describe: 'List detected agent backends and availability',
    phase: 'F4',
  }),
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
