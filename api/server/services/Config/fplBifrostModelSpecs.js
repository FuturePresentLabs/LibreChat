const { extractEnvVariable, normalizeEndpointName } = require('librechat-data-provider');
const { resolveConfigSecret, resolveHeaders } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const loadConfigModels = require('./loadConfigModels');

const LOCAL_ENDPOINT = 'bifrost-local';
const PAID_ENDPOINT = 'bifrost-openrouter';
const BIFROST_ENDPOINTS = new Set([LOCAL_ENDPOINT, PAID_ENDPOINT]);
const LOCAL_MODEL_OWNER_PATTERNS = [/^vllm$/i, /^yggdrasil\//i];
const ALIAS_MODEL_PATTERNS = [/^fpl\//i];
const NON_CHAT_MODEL_PATTERNS = [
  /^or-(img|tts|ocr|video)\//i,
  /(^|\/)(tts|stt|ocr|image|video|music|transcribe)(-|\/|$)/i,
  /(^|\/)whisper/i,
  /macos-say/i,
];

function modelName(model) {
  if (typeof model === 'string') {
    return model;
  }
  if (typeof model?.id === 'string') {
    return model.id;
  }
  return typeof model?.name === 'string' ? model.name : '';
}

function endpointName(endpoint) {
  return normalizeEndpointName(endpoint?.name ?? '');
}

function bifrostEndpointNames(appConfig) {
  const endpoints = appConfig?.endpoints?.custom;
  if (!Array.isArray(endpoints)) {
    return new Set();
  }
  return new Set(endpoints.map(endpointName).filter((name) => BIFROST_ENDPOINTS.has(name)));
}

function hasFplBifrostEndpoints(appConfig) {
  return bifrostEndpointNames(appConfig).size > 0;
}

function isPaidBifrostModel(model) {
  return model.toLowerCase().startsWith('or/');
}

function isLocalBifrostModelRow(item) {
  const owner = item?.owned_by;
  return (
    typeof owner === 'string' && LOCAL_MODEL_OWNER_PATTERNS.some((pattern) => pattern.test(owner))
  );
}

function isChatModel(model) {
  return !NON_CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function isAliasModel(model) {
  return ALIAS_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function canonicalModelKey(model) {
  const withoutRouterPrefix = model.toLowerCase().replace(/^or\//, '');
  const withoutFreeSuffix = withoutRouterPrefix.replace(/:free$/, '');
  const segments = withoutFreeSuffix.split('/').filter(Boolean);
  return segments.at(-1) ?? withoutFreeSuffix;
}

function targetEndpointForModel(model) {
  return isPaidBifrostModel(model) ? PAID_ENDPOINT : LOCAL_ENDPOINT;
}

function targetEndpointForModelRow(item) {
  const model = modelName(item);
  if (!model || item?.routable === false || isAliasModel(model) || !isChatModel(model)) {
    return undefined;
  }
  if (isPaidBifrostModel(model)) {
    return PAID_ENDPOINT;
  }
  if (typeof item === 'string' || isLocalBifrostModelRow(item)) {
    return LOCAL_ENDPOINT;
  }
  return undefined;
}

function defaultDescription(endpoint) {
  return endpoint === PAID_ENDPOINT
    ? 'Paid OpenRouter model with memory enabled.'
    : 'Local/free model with memory enabled.';
}

function slugModelName(model) {
  return model
    .toLowerCase()
    .replace(/^or\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function displayModelName(model) {
  const withoutRouterPrefix = model.replace(/^or\//i, '');
  const lastSegment = withoutRouterPrefix.split('/').filter(Boolean).pop() ?? withoutRouterPrefix;
  return lastSegment
    .replace(/[_-]+/g, ' ')
    .replace(/\bglm\b/gi, 'GLM')
    .replace(/\bqwen/g, 'Qwen')
    .replace(/\bdeepseek\b/gi, 'DeepSeek')
    .replace(/\blaguna\b/gi, 'Laguna')
    .replace(/\bmuse\b/gi, 'Muse')
    .replace(/\bspark\b/gi, 'Spark')
    .replace(/\bglimmer\b/gi, 'Glimmer')
    .replace(/\bmlx\b/gi, 'MLX')
    .replace(/\bai\b/gi, 'AI')
    .replace(/\b([0-9]+)b\b/gi, '$1B')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function uniqueSpecName(base, seen) {
  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

function collectDiscoveredModelRows(appConfig, modelRows) {
  const endpointNames = bifrostEndpointNames(appConfig);
  const discovered = new Map();
  const candidates = [];
  const localModelKeys = new Set();

  for (const item of modelRows ?? []) {
    const model = modelName(item);
    const endpoint = targetEndpointForModelRow(item);
    if (!endpoint || !endpointNames.has(endpoint)) {
      continue;
    }
    candidates.push({ endpoint, model });
    if (endpoint === LOCAL_ENDPOINT) {
      localModelKeys.add(canonicalModelKey(model));
    }
  }

  for (const { endpoint, model } of candidates) {
    if (endpoint === PAID_ENDPOINT && localModelKeys.has(canonicalModelKey(model))) {
      continue;
    }
    discovered.set(`${endpoint}\u0000${model}`, { endpoint, model });
  }

  return discovered;
}

function collectDiscoveredModels(appConfig, modelsConfig, rawModelRows) {
  const endpointNames = bifrostEndpointNames(appConfig);
  const discovered = collectDiscoveredModelRows(appConfig, rawModelRows);
  if (discovered.size > 0) {
    return discovered;
  }

  const candidates = [];
  const localModelKeys = new Set();
  for (const [name, models] of Object.entries(modelsConfig ?? {})) {
    const normalizedName = normalizeEndpointName(name);
    if (!endpointNames.has(normalizedName) || !Array.isArray(models)) {
      continue;
    }
    for (const item of models) {
      const model = modelName(item);
      if (!model) {
        continue;
      }
      const endpoint = targetEndpointForModel(model);
      if (!endpointNames.has(endpoint)) {
        continue;
      }
      candidates.push({ endpoint, model });
      if (endpoint === LOCAL_ENDPOINT) {
        localModelKeys.add(canonicalModelKey(model));
      }
    }
  }

  for (const { endpoint, model } of candidates) {
    if (endpoint === PAID_ENDPOINT && localModelKeys.has(canonicalModelKey(model))) {
      continue;
    }
    discovered.set(`${endpoint}\u0000${model}`, { endpoint, model });
  }

  return discovered;
}

function existingBifrostSpecKey(spec) {
  const model = modelName(spec?.preset?.model);
  if (!model) {
    return undefined;
  }
  const endpoint = normalizeEndpointName(spec?.preset?.endpoint ?? spec?.group ?? '');
  if (!BIFROST_ENDPOINTS.has(endpoint)) {
    return undefined;
  }
  return `${endpoint}\u0000${model}`;
}

function buildGeneratedSpec({ existingSpec, endpoint, model, seenSpecNames }) {
  const name = existingSpec?.name ?? uniqueSpecName(`fpl-${slugModelName(model)}`, seenSpecNames);
  if (existingSpec?.name) {
    seenSpecNames.add(existingSpec.name);
  }

  return {
    ...(existingSpec ?? {}),
    name,
    label: existingSpec?.label ?? displayModelName(model),
    description: existingSpec?.description ?? defaultDescription(endpoint),
    group: existingSpec?.group ?? endpoint,
    memory: existingSpec?.memory ?? true,
    preset: {
      ...(existingSpec?.preset ?? {}),
      endpoint,
      model,
    },
  };
}

function buildFplBifrostModelSpecs(appConfig, modelsConfig, rawModelRows) {
  const baseModelSpecs = appConfig?.modelSpecs;
  if (!hasFplBifrostEndpoints(appConfig)) {
    return baseModelSpecs;
  }

  const discovered = collectDiscoveredModels(appConfig, modelsConfig, rawModelRows);
  if (discovered.size === 0) {
    return baseModelSpecs;
  }

  const existingList = Array.isArray(baseModelSpecs?.list) ? baseModelSpecs.list : [];
  const existingByKey = new Map();
  const orderedKeys = [];
  const passthroughSpecs = [];

  for (const spec of existingList) {
    const key = existingBifrostSpecKey(spec);
    if (!key) {
      passthroughSpecs.push(spec);
      continue;
    }
    existingByKey.set(key, spec);
    if (discovered.has(key)) {
      orderedKeys.push(key);
    }
  }

  for (const [key] of discovered) {
    if (!orderedKeys.includes(key)) {
      orderedKeys.push(key);
    }
  }

  const seenSpecNames = new Set(passthroughSpecs.map((spec) => spec?.name).filter(Boolean));
  const generatedSpecs = orderedKeys.map((key) =>
    buildGeneratedSpec({
      existingSpec: existingByKey.get(key),
      ...discovered.get(key),
      seenSpecNames,
    }),
  );

  return {
    ...(baseModelSpecs ?? {}),
    prioritize: baseModelSpecs?.prioritize ?? true,
    list: [...passthroughSpecs, ...generatedSpecs],
  };
}

function bifrostModelEndpoint(appConfig) {
  const endpoints = appConfig?.endpoints?.custom;
  if (!Array.isArray(endpoints)) {
    return undefined;
  }
  return endpoints.find((endpoint) => BIFROST_ENDPOINTS.has(endpointName(endpoint)));
}

async function fetchRawBifrostModels({ req, appConfig }) {
  const endpoint = bifrostModelEndpoint(appConfig);
  if (!endpoint?.baseURL || !endpoint?.apiKey) {
    return [];
  }

  const baseURL = extractEnvVariable(endpoint.baseURL);
  const apiKey = resolveConfigSecret(endpoint.apiKey);
  if (!baseURL || !apiKey) {
    return [];
  }

  const headers = resolveHeaders({
    headers: endpoint.headers ?? undefined,
    user: req.user,
    stripUnresolved: true,
  });
  const hasAuthHeader = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
  if (!hasAuthHeader) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, { headers });
  if (!response.ok) {
    throw new Error(`Bifrost model metadata returned ${response.status}`);
  }
  const body = await response.json();
  return Array.isArray(body?.data) ? body.data : [];
}

async function resolveFplBifrostModelSpecs({
  req,
  appConfig,
  loadModels = loadConfigModels,
  loadRawModels = fetchRawBifrostModels,
}) {
  if (!hasFplBifrostEndpoints(appConfig)) {
    return appConfig?.modelSpecs;
  }

  let rawModelRows = [];
  try {
    rawModelRows = await loadRawModels({ req, appConfig });
  } catch (error) {
    logger.warn(`[config] Failed to fetch FPL Bifrost model metadata: ${error.message}`);
  }

  if (rawModelRows.length > 0) {
    return buildFplBifrostModelSpecs(appConfig, undefined, rawModelRows);
  }

  try {
    const modelsConfig = await loadModels({ user: req.user, config: appConfig });
    return buildFplBifrostModelSpecs(appConfig, modelsConfig);
  } catch (error) {
    logger.warn(`[config] Failed to auto-generate FPL Bifrost model specs: ${error.message}`);
  }

  return appConfig?.modelSpecs;
}

module.exports = {
  buildFplBifrostModelSpecs,
  fetchRawBifrostModels,
  resolveFplBifrostModelSpecs,
};
