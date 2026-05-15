import type { CommandModule } from './command.js';
import { makeStubCommand } from './command.js';
import { initCommand } from './commands/init.js';
import { validateCommand } from './commands/validate.js';
import { agentsCommand } from './commands/agents.js';
import { runCommand } from './commands/run.js';
import { mergeCommand } from './commands/merge.js';
import { cleanCommand } from './commands/clean.js';
import { skillsCommand } from './commands/skills.js';
import { planCommand } from './commands/plan.js';
import { convertCommand } from './commands/convert.js';

export const COMMAND_MODULES: CommandModule[] = [
  initCommand,
  planCommand,
  convertCommand,
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
  skillsCommand,
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
