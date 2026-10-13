import { useState } from 'react';
import { Check, KeyRound } from 'lucide-react';
import type { AIState } from '../ai';
import type { AIConfig, AIDiagnostics, AIProviderSettings } from '../types';
import { responseError } from '../lib';
import { Badge, Modal, Note } from './ui';

const providerNames: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google Gemini', custom: '自定义兼容接口' };
interface Draft { provider: string; mode: 'builtin' | 'custom'; model: string; baseUrl: string; api: string; vision: boolean }
export default function AISettings({ ai, onClose, returnFocusTo }: { ai: AIState; onClose: () => void; returnFocusTo: HTMLElement | null }) {
  const makeDraft = (provider: string): Draft => {
    const settings = ai.config?.settings.find(p => p.provider === provider);
    return { provider, mode: settings?.mode || (['anthropic', 'openai', 'google'].includes(provider) ? 'builtin' : 'custom'),
      model: ai.model?.provider === provider ? ai.model.id : settings?.model || ai.config?.models.find(m => m.provider === provider)?.id || '',
      baseUrl: settings?.baseUrl || '', api: settings?.api || 'openai-completions', vision: settings?.vision ?? true };
  };
  const [draft, setDraft] = useState<Draft>(() => makeDraft(ai.model?.provider || 'anthropic'));
  const [savedDraft, setSavedDraft] = useState(draft);
  const [key, setKey] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null), [tested, setTested] = useState(false);
  const [diagnostics, setDiagnostics] = useState<AIDiagnostics | null>(null);
  const saved: AIProviderSettings | undefined = ai.config?.settings.find(p => p.provider === draft.provider);
  const dirty = Boolean(key) || JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const providers = [...new Set(['anthropic', 'openai', 'google', 'custom', ...(ai.config?.settings.map(p => p.provider) || [])])];
  const models = ai.config?.models.filter(m => m.provider === draft.provider) || [];
  const patch = (value: Partial<Draft>) => { setDraft(current => ({ ...current, ...value })); setError(''); setNotice(''); setTested(false); setDiagnostics(null); };
  const changeProvider = (provider: string) => { const next = makeDraft(provider); setDraft(next); setSavedDraft(next); setKey(''); setError(''); setNotice(''); setTested(false); setDiagnostics(null); };
  const save = async () => {
    setBusy('save'); setError(''); setNotice(''); setTested(false); setDiagnostics(null);
    try {
      const response = await fetch('/api/ai/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, apiKey: key }) });
      if (!response.ok) throw new Error(await responseError(response));
      const next: AIConfig = await response.json(); ai.applyConfig(next);
      setKey(''); setSavedDraft(draft); setNotice('已保存并立即生效。现在可以测试连接。');
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试。'); }
    finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test'); setError(''); setNotice(''); setTested(false); setDiagnostics(null);
    try {
      const response = await fetch('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: draft.provider, model: draft.model }) });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        setDiagnostics(result?.diagnostics || null);
        throw new Error(typeof result?.detail === 'string' ? result.detail : '连接测试未完成，请检查 AI 服务。');
      }
      const result = await response.json(); setTested(true); setNotice(result.detail);
    } catch (e) { setError(e instanceof Error ? e.message : '测试失败，请重试。'); }
    finally { setBusy(null); }
  };
  return <Modal open onOpenChange={open => { if (!open) onClose(); }} returnFocusTo={returnFocusTo} title="AI 凭据设置" description="选择模型供应商，连接图片预标注和 Pi 设计助手。">
    <form className="ai-settings-form" onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={Boolean(busy)}>
      <div className="ai-settings-status"><span><KeyRound size={16} aria-hidden="true" />本机 AI 连接</span><Badge tone={diagnostics ? 'warning' : tested ? 'success' : saved?.configured ? 'neutral' : 'warning'}>{diagnostics ? '连接测试失败' : tested ? '连接测试成功' : saved?.configured ? '凭据已配置 · 尚未测试' : '待配置凭据'}</Badge></div>
      <fieldset disabled={Boolean(busy) || !ai.config} className="space-y-4" aria-describedby={error ? 'ai-settings-error' : undefined}>
        <label className="ai-text-field">供应商<select value={draft.provider} onChange={e => changeProvider(e.target.value)}>{providers.map(p => <option key={p} value={p}>{providerNames[p] || p}</option>)}</select></label>
        {draft.mode === 'builtin' ? <label className="ai-text-field">模型<select required value={draft.model} onChange={e => patch({ model: e.target.value })}>{models.map(m => <option value={m.id} key={m.id}>{m.name}{m.vision ? ' · 支持图片' : ' · 仅文字'}</option>)}</select></label> : <>
          <label className="ai-text-field">模型 ID<input required value={draft.model} maxLength={200} placeholder="例如：你的视觉模型名称" onChange={e => patch({ model: e.target.value })} /></label>
          <div className="ai-text-field"><label htmlFor="ai-settings-base-url">接口地址（Base URL）</label><input id="ai-settings-base-url" required type="url" value={draft.baseUrl} maxLength={2000} placeholder="https://api.example.com/v1" onChange={e => patch({ baseUrl: e.target.value })} aria-describedby="ai-base-url-help" /><small id="ai-base-url-help">填写服务根地址，不包含 /chat/completions。支持本地 HTTP 接口。</small></div>
          <label className="ai-text-field">接口协议<select value={draft.api} onChange={e => patch({ api: e.target.value })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={draft.vision} onChange={e => patch({ vision: e.target.checked })} />模型支持图片输入（用于预标注）</label>
          <p className="text-pretty text-xs text-slate-500">对话调整需要模型支持工具调用；请按供应商说明选择协议与能力。</p>
        </>}
        <div className="ai-text-field"><label htmlFor="ai-settings-key">API Key</label><input id="ai-settings-key" type="password" required={!saved?.configured} value={key} maxLength={4096} autoComplete="new-password" spellCheck={false} placeholder={saved?.configured ? '已配置，留空保留原密钥' : '粘贴供应商 API Key'} onChange={e => { setKey(e.target.value); setError(''); setNotice(''); setTested(false); setDiagnostics(null); }} aria-describedby="ai-key-help" /><small id="ai-key-help">密钥只保存在本机服务端，不回传到页面或项目备份。{saved?.configured ? '更换接口地址时需重新输入密钥。' : '本地免鉴权接口可填写 local。'}</small></div>
      </fieldset>
      {!ai.config && <p className="inline-error" role="alert">{ai.error || '正在读取 AI 服务配置…'}<button type="button" className="button button-small ml-2" onClick={() => void ai.refresh()}>重新连接</button></p>}
      {error && <p id="ai-settings-error" className="inline-error" role="alert">{error}</p>}
      {diagnostics && <dl className="ai-settings-diagnostics" aria-label="连接诊断"><div><dt>上游状态</dt><dd>{diagnostics.upstreamStatus ? `HTTP ${diagnostics.upstreamStatus}` : '未收到有效响应'}</dd></div><div><dt>模型</dt><dd>{diagnostics.model}</dd></div><div><dt>协议</dt><dd>{diagnostics.api}</dd></div>{diagnostics.code && <div><dt>错误码</dt><dd>{diagnostics.code}</dd></div>}</dl>}
      {notice && <p className="ai-settings-notice" role="status">{tested && <Check size={16} aria-hidden="true" />}{notice}</p>}
      <Note>保存后立即生效，无需重启。测试连接会发起一次短文字请求，可能产生少量 API 费用。</Note>
      <div className="ai-settings-actions"><div><button type="button" className="button" disabled={Boolean(busy) || !saved?.configured || dirty} onClick={() => void test()} aria-describedby="ai-test-help">{busy === 'test' ? '正在测试…' : '测试连接'}</button><small id="ai-test-help">{dirty || !saved?.configured ? '先保存当前配置' : '测试已保存的配置'}</small></div><button type="submit" className="button button-primary" disabled={Boolean(busy) || !ai.config}>{busy === 'save' ? '正在保存…' : '保存并启用'}</button></div>
    </form>
  </Modal>;
}
