import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const builtinProviders = ['anthropic', 'openai', 'google'];
const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
const failure = message => Object.assign(new Error(message), { status: 422 });
export const settingsPath = agentDir => resolve(agentDir, 'ai-settings.json');
export const emptySettings = () => ({ version: 1, providers: {}, defaultProvider: '', defaultModel: '' });

export async function readSettings(agentDir) {
  try {
    const settings = JSON.parse(await readFile(settingsPath(agentDir), 'utf8'));
    if (settings.version !== 1 || !settings.providers || typeof settings.providers !== 'object') throw new Error();
    return settings;
  } catch (error) {
    if (error.code === 'ENOENT') return emptySettings();
    throw new Error('无法读取 AI 设置，请检查本机 AI 设置文件。');
  }
}

export async function persistSettings(agentDir, settings) {
  const path = settingsPath(agentDir), temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

export function customProviderConfig(value) {
  return { baseUrl: value.baseUrl, api: value.api,
    models: [{ id: value.model, name: value.model, input: value.vision ? ['text', 'image'] : ['text'],
      reasoning: false, contextWindow: 128000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
}

export async function applySettings(runtime, settings) {
  for (const [provider, value] of Object.entries(settings.providers)) {
    if (value.mode === 'custom') runtime.registerProvider(provider, customProviderConfig(value));
    if (value.apiKey) await runtime.setRuntimeApiKey(provider, value.apiKey);
  }
}

export function publicSettings(context) {
  const ids = new Set([...builtinProviders, context.provider, ...context.runtime.getRegisteredProviderIds(), ...Object.keys(context.settings?.providers || {})]);
  return [...ids].map(provider => {
    const value = context.settings?.providers[provider], registered = context.runtime.getRegisteredProviderConfig(provider);
    const model = value?.model || (provider === context.provider ? context.preferred : '') || context.runtime.getModels(provider)[0]?.id || '';
    // Credentials (including registered-provider apiKey) are deliberately never returned.
    const rawUrl = value?.baseUrl || registered?.baseUrl;
    let baseUrl = '';
    if (rawUrl) { try { const url = new URL(rawUrl); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; baseUrl = url.toString().replace(/\/$/, ''); } catch { /* invalid server config */ } }
    return { provider, mode: value?.mode || (baseUrl ? 'custom' : 'builtin'), model, baseUrl,
      api: value?.api || registered?.api || 'openai-completions',
      vision: value?.vision ?? context.runtime.getModel(provider, model)?.input.includes('image') ?? true,
      configured: context.runtime.hasConfiguredAuth(provider), saved: Boolean(value) };
  });
}

export function updateSettings(context, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('AI 设置格式无效。');
  const { provider, mode, model } = body;
  if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,49}$/.test(provider)) throw failure('供应商标识无效。');
  if (!['builtin', 'custom'].includes(mode)) throw failure('接口类型无效。');
  if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw failure('请填写有效模型 ID。');
  if (mode === 'builtin' && (!builtinProviders.includes(provider) || !context.runtime.getModel(provider, model))) throw failure('请选择供应商的已注册模型。');
  const previous = context.settings?.providers[provider];
  const value = { mode, model: model.trim(), vision: body.vision === true };
  if (mode === 'custom') {
    let url;
    try { url = new URL(body.baseUrl); } catch { throw failure('接口地址必须是完整的 HTTP 或 HTTPS URL。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw failure('接口地址不能包含用户名、密码、查询参数或片段。');
    if (!protocols.includes(body.api)) throw failure('不支持此接口协议。');
    value.baseUrl = url.toString().replace(/\/$/, ''); value.api = body.api;
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') throw failure('API Key 格式无效。');
  const key = body.apiKey?.trim();
  if (key && (key.length > 4096 || /[\x00-\x20\x7f]/.test(key) || key.startsWith('!') || key.startsWith('$'))) throw failure('API Key 必须是密钥文本，不能是命令或环境变量引用。');
  const current = publicSettings(context).find(p => p.provider === provider);
  if (!key && current?.baseUrl !== (value.baseUrl || '') && current?.configured) throw failure('更换接口地址时请重新输入 API Key。');
  if (key) value.apiKey = key;
  else if (previous?.apiKey) value.apiKey = previous.apiKey;
  else if (!context.runtime.hasConfiguredAuth(provider)) throw failure('请输入此供应商的 API Key。');
  return { ...(context.settings || emptySettings()), providers: { ...context.settings?.providers, [provider]: value }, defaultProvider: provider, defaultModel: value.model };
}
