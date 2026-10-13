import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AIConfig, AIModel } from './types';
import { responseError } from './lib';
import { Badge, Note } from './components/ui';
import AISettings from './components/AISettings';

export interface AIState { config: AIConfig | null; model?: AIModel; selection: string; setSelection: (value: string) => void; error: string; refresh: () => Promise<void>; applyConfig: (config: AIConfig) => void; openSettings: () => void }
const AIContext = createContext<AIState | null>(null);
export function AIProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AIConfig | null>(null), [selection, setSelection] = useState(''), [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLElement | null>(null);
  const openSettings = () => { settingsTrigger.current = document.activeElement as HTMLElement; setSettingsOpen(true); };
  const applyConfig = (next: AIConfig) => { setConfig(next); setSelection(next.defaultModel); setError(''); };
  const refresh = async () => {
    setError('');
    try {
      const response = await fetch('/api/ai/config');
      if (!response.ok) throw new Error(await responseError(response));
      const next: AIConfig = await response.json(); setConfig(next);
      setSelection(current => next.models.some(m => `${m.provider}/${m.id}` === current) ? current : next.defaultModel);
    } catch (e) { setError(e instanceof Error ? e.message : '无法连接 Pi 服务。'); }
  };
  useEffect(() => { void refresh(); }, []);
  const model = config?.models.find(m => `${m.provider}/${m.id}` === selection);
  const state = { config, model, selection, setSelection, error, refresh, applyConfig, openSettings };
  return <AIContext.Provider value={state}>{children}{settingsOpen && <AISettings key={config ? 'ready' : 'waiting'} ai={state} onClose={() => setSettingsOpen(false)} returnFocusTo={settingsTrigger.current} />}</AIContext.Provider>;
}
export function useAI() { const value = useContext(AIContext); if (!value) throw new Error('Missing AIProvider'); return value; }

export function AIModelSelect({ disabled = false, vision = false }: { disabled?: boolean; vision?: boolean }) {
  const ai = useAI();
  const models = ai.config?.models.filter(m => !vision || m.vision) || [];
  return <div className="space-y-2"><div className="ai-model-select">
    <label>AI 模型<select value={models.some(m => `${m.provider}/${m.id}` === ai.selection) ? ai.selection : ''} onChange={e => ai.setSelection(e.target.value)} disabled={disabled || !models.length}>
      <option value="" disabled>选择{vision ? '视觉' : ''}模型</option>
      {[...new Set(models.map(m => m.provider))].map(provider => <optgroup label={provider} key={provider}>{models.filter(m => m.provider === provider).map(m => <option key={m.id} value={`${provider}/${m.id}`}>{m.name}{m.configured ? '' : ' · 待配置'}{m.vision && !vision ? ' · 视觉' : ''}</option>)}</optgroup>)}
    </select></label><Badge tone={ai.model?.configured ? 'success' : 'warning'}>{ai.model?.configured ? '凭据已配置' : '待配置凭据'}</Badge><button className="button button-small" disabled={disabled} onClick={ai.openSettings}>AI 设置</button>
  </div>{vision && ai.model && !ai.model.vision && <p className="text-xs text-amber-800">当前模型不支持图片，请选择视觉模型。</p>}</div>;
}
export function AISetup() {
  const ai = useAI();
  return <div className="ai-setup">
    {ai.error && <p className="inline-error" role="alert">{ai.error}</p>}
    <Note>配置模型和 API Key 后，即可使用 AI 预标注与对话调整。密钥仅保存在本机服务端。</Note>
    <button className="button button-small button-primary" onClick={ai.openSettings}>配置 AI 凭据</button>
  </div>;
}

export async function imageDataUrl(url: string) {
  if (url.startsWith('data:image/')) return url;
  const response = await fetch(url); if (!response.ok) throw new Error('无法读取图片。');
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
}

export async function readAIStream(response: Response, signal: AbortSignal, onEvent: (event: Record<string, unknown>) => void) {
  if (!response.ok) throw new Error(await responseError(response));
  const reader = response.body?.getReader(); if (!reader) throw new Error('浏览器不支持流式响应。');
  const decoder = new TextDecoder(); let buffer = '', completed = false;
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.detail);
    if (event.type === 'done') completed = true;
    if (!signal.aborted) onEvent(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { dispatch(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (done) break;
    }
    dispatch(buffer);
    if (!completed && !signal.aborted) throw new Error('AI 连接中断，本次修改未应用。');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
