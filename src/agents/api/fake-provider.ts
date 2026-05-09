import type {
  ApiProvider,
  ApiProviderConfig,
  ApiRunRequest,
  AssistantStep,
} from './provider.js';

export interface FakeProviderScript {
  /** Each entry is one assistant step. The provider replays them in order. */
  steps: AssistantStep[];
}

/** Deterministic provider used to test the tool-use loop without network calls. */
export class FakeApiProvider implements ApiProvider {
  readonly name = 'anthropic' as const;
  private idx = 0;

  constructor(private readonly script: FakeProviderScript) {}

  isAvailable(_config: ApiProviderConfig): { available: boolean; reason?: string } {
    return { available: true };
  }

  async step(_req: ApiRunRequest): Promise<AssistantStep> {
    const next = this.script.steps[this.idx];
    this.idx += 1;
    if (!next) {
      return { text: '', toolCalls: [], stop: true };
    }
    return next;
  }
}
