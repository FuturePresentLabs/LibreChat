const {
  buildFplBifrostModelSpecs,
  resolveFplBifrostModelSpecs,
} = require('./fplBifrostModelSpecs');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: jest.fn() },
}));

const appConfig = {
  endpoints: {
    custom: [{ name: 'bifrost-local' }, { name: 'bifrost-openrouter' }],
  },
  modelSpecs: {
    prioritize: true,
    list: [
      {
        name: 'regular-spec',
        label: 'Regular Spec',
        preset: { endpoint: 'openAI', model: 'gpt-4o' },
      },
      {
        name: 'fpl-granite-4.1-8b',
        label: 'Granite 4.1 8B',
        description: 'Curated local description.',
        group: 'bifrost-local',
        default: true,
        memory: true,
        preset: { endpoint: 'bifrost-local', model: 'granite-4.1-8b' },
      },
      {
        name: 'fpl-glm-5.3',
        label: 'GLM 5.3',
        description: 'Curated paid description.',
        group: 'bifrost-openrouter',
        memory: true,
        preset: { endpoint: 'bifrost-openrouter', model: 'or/z-ai/glm-5.3' },
      },
    ],
  },
};

describe('FPL Bifrost model specs', () => {
  it('generates grouped specs from fetched Bifrost models while preserving curated specs', () => {
    const modelSpecs = buildFplBifrostModelSpecs(appConfig, {
      'bifrost-local': ['granite-4.1-8b', 'glm-4.6', 'or/z-ai/glm-5.3', 'or/z-ai/glm-4.6'],
      'bifrost-openrouter': ['granite-4.1-8b', 'glm-4.6', 'or/z-ai/glm-5.3', 'or/z-ai/glm-4.6'],
    });

    expect(modelSpecs.list.map((spec) => spec.name)).toEqual([
      'regular-spec',
      'fpl-granite-4.1-8b',
      'fpl-glm-5.3',
      'fpl-glm-4-6',
    ]);
    expect(modelSpecs.list[1]).toMatchObject({
      label: 'Granite 4.1 8B',
      description: 'Curated local description.',
      default: true,
      preset: { endpoint: 'bifrost-local', model: 'granite-4.1-8b' },
    });
    expect(modelSpecs.list[3]).toMatchObject({
      label: 'GLM 4.6',
      description: 'Local/free model with memory enabled.',
      group: 'bifrost-local',
      memory: true,
      preset: { endpoint: 'bifrost-local', model: 'glm-4.6' },
    });
    expect(modelSpecs.list.some((spec) => spec.preset.model === 'or/z-ai/glm-4.6')).toBe(false);
  });

  it('uses Bifrost model metadata to keep local/free specs node-backed and chat-only', () => {
    const modelSpecs = buildFplBifrostModelSpecs(appConfig, undefined, [
      { id: 'granite-4.1-8b', owned_by: 'vllm', routable: true },
      { id: 'fpl/llm', owned_by: 'vllm', routable: true },
      { id: 'mac/local/qwen3.8-27b-mlx-4bit', owned_by: 'yggdrasil/averys-mac-studio' },
      { id: 'fpl/laguna-s', owned_by: 'yggdrasil/dustkernel', routable: true },
      { id: 'poolside/laguna-s-2.1', owned_by: 'yggdrasil/dustkernel', routable: true },
      { id: 'mac/fpl/transcribe', owned_by: 'yggdrasil/averys-mac-studio', routable: true },
      { id: 'mac/fpl/tts-fast', owned_by: 'yggdrasil/averys-mac-studio', routable: true },
      { id: 'kimi/kimi-k3', owned_by: 'moonshot', routable: true },
      { id: 'gpt-oss-20b', owned_by: 'freetoken', routable: true },
      { id: 'cold-local', owned_by: 'yggdrasil/cold-node', routable: false },
      { id: 'or/z-ai/glm-5.3', owned_by: 'openrouter', routable: true },
      { id: 'or/poolside/laguna-s-2.1', owned_by: 'openrouter', routable: true },
      { id: 'or-img/black-forest-labs/flux.2-pro', owned_by: 'openrouter-images' },
    ]);

    expect(
      modelSpecs.list.map((spec) => [spec.group ?? spec.preset.endpoint, spec.preset.model]),
    ).toEqual([
      ['openAI', 'gpt-4o'],
      ['bifrost-local', 'granite-4.1-8b'],
      ['bifrost-openrouter', 'or/z-ai/glm-5.3'],
      ['bifrost-local', 'mac/local/qwen3.8-27b-mlx-4bit'],
      ['bifrost-local', 'poolside/laguna-s-2.1'],
    ]);
  });

  it('leaves model specs unchanged when Bifrost endpoints are not configured', () => {
    const baseSpecs = { list: [{ name: 'keep-me', preset: { endpoint: 'openAI' } }] };
    const modelSpecs = buildFplBifrostModelSpecs(
      { endpoints: { custom: [{ name: 'other' }] }, modelSpecs: baseSpecs },
      { other: ['glm-4.6'] },
    );

    expect(modelSpecs).toBe(baseSpecs);
  });

  it('falls back to configured specs when resolving fetched models fails', async () => {
    const { logger } = require('@librechat/data-schemas');
    const resolved = await resolveFplBifrostModelSpecs({
      req: { user: { id: 'user-1' } },
      appConfig,
      loadModels: jest.fn().mockRejectedValue(new Error('models unavailable')),
    });

    expect(resolved).toBe(appConfig.modelSpecs);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to auto-generate FPL Bifrost model specs'),
    );
  });

  it('uses raw Bifrost metadata before falling back to string-only model fetches', async () => {
    const resolved = await resolveFplBifrostModelSpecs({
      req: { user: { id: 'user-1' } },
      appConfig,
      loadRawModels: jest.fn().mockResolvedValue([
        { id: 'granite-4.1-8b', owned_by: 'vllm', routable: true },
        { id: 'kimi/kimi-k3', owned_by: 'moonshot', routable: true },
      ]),
      loadModels: jest.fn().mockResolvedValue({
        'bifrost-local': ['kimi/kimi-k3'],
      }),
    });

    expect(resolved.list.map((spec) => spec.preset?.model)).toEqual(['gpt-4o', 'granite-4.1-8b']);
  });
});
