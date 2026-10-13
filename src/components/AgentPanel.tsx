import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, Square, Plus, Check, AlertTriangle, Undo2 } from 'lucide-react';
import type { Project } from '../types';
import { AIModelSelect, AISetup, readAIStream, useAI } from '../ai';
import { cn, geometryPayload } from '../lib';
import { Badge, Note } from './ui';

interface Message { id: string; role: 'user' | 'assistant'; text: string; tools?: { id: string; name: string; status: string }[]; changes?: string[]; applied?: boolean; notice?: string }
const toolNames: Record<string, string> = { inspect_design: '检查当前设计', edit_design: '修改设计参数', auto_layout: '自动排布组件' };
export default function AgentPanel({ project, selectedId, onApply, onUndo, canUndo }: {
  project: Project; selectedId?: string; onApply: (next: Project, base: Project) => boolean; onUndo: () => void; canUndo: boolean;
}) {
  const ai = useAI();
  const [messages, setMessages] = useState<Message[]>([]), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const controller = useRef<AbortController | null>(null), bottom = useRef<HTMLDivElement>(null);
  const selectionKey = `${ai.selection}:${ai.config?.revision || 0}`;
  const modelKey = useRef(selectionKey);
  useEffect(() => { if (modelKey.current !== selectionKey) { setSessionId(undefined); setMessages([]); modelKey.current = selectionKey; } }, [selectionKey]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages]);
  const send = async (text = draft) => {
    if (!text.trim() || busy || !ai.model?.configured) return;
    const base = project, selectedModel = ai.model, id = crypto.randomUUID();
    const aborter = new AbortController(); controller.current = aborter;
    setBusy(true); setError(''); setDraft('');
    setMessages(current => [...current, { id: crypto.randomUUID(), role: 'user', text: text.trim() }, { id, role: 'assistant', text: '', tools: [] }]);
    const update = (patch: (m: Message) => Message) => setMessages(current => current.map(m => m.id === id ? patch(m) : m));
    try {
      const response = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: aborter.signal,
        body: JSON.stringify({ message: text.trim(), project: geometryPayload(base), selectedId, sessionId, provider: selectedModel.provider, model: selectedModel.id }) });
      if (response.status === 410) setSessionId(undefined);
      await readAIStream(response, aborter.signal, event => {
        if (event.type === 'session') setSessionId(String(event.sessionId));
        if (event.type === 'text') update(m => ({ ...m, text: m.text + String(event.delta) }));
        if (event.type === 'tool') update(m => ({ ...m, tools: [...(m.tools || []).filter(t => t.id !== event.id), { id: String(event.id), name: String(event.name), status: String(event.status) }] }));
        if (event.type === 'done') {
          let applied = false;
          if (event.project) applied = onApply(event.project as Project, base);
          update(m => ({ ...m, text: String(event.text) || m.text, changes: event.changes as string[], applied,
            notice: event.project && !applied ? '请求期间项目有新的修改，本次 AI 结果未覆盖当前设计。请基于最新项目重试。' : undefined }));
        }
      });
    } catch (e) {
      const detail = aborter.signal.aborted ? '已停止，本次修改未应用。' : e instanceof Error ? e.message : 'AI 请求失败。';
      setError(detail); update(m => ({ ...m, notice: detail }));
    } finally { setBusy(false); controller.current = null; }
  };
  return <div className="agent-panel card">
    <div className="card-header"><strong><MessageSquare size={17} />Pi 设计助手</strong><div className="flex gap-2"><button className="icon-button" disabled={!canUndo || busy} onClick={onUndo} aria-label="撤销最近一次设计修改" title="撤销最近修改"><Undo2 size={16} /></button><button className="button button-small" disabled={busy} onClick={() => { setMessages([]); setSessionId(undefined); setError(''); }}>新对话<Plus size={13} /></button></div></div>
    <div className="agent-controls"><AIModelSelect disabled={busy} />{!ai.model?.configured && <AISetup />}</div>
    <div className="chat-messages" aria-label="设计助手对话记录" aria-busy={busy}>
      {!messages.length && <div className="chat-empty"><MessageSquare size={25} /><h2>用一句话调整外壳</h2><p>我会读取当前设计、修改参数并检查实体。成功后预览自动更新，可撤销。</p><div className="chat-suggestions">{['把外壳高度增加 5 mm，保持上盖组件的安装位置', '关闭通风孔，其他尺寸保持不变', '检查当前设计，告诉我还缺少哪些实测尺寸'].map(text => <button key={text} disabled={busy || !ai.model?.configured} onClick={() => void send(text)}>{text}</button>)}</div></div>}
      {messages.map(m => <article key={m.id} className={cn('chat-message', m.role === 'user' && 'chat-message-user')}><span className="chat-role">{m.role === 'user' ? '你' : 'Pi 助手'}</span>
        {m.tools && m.tools.length > 0 && <ul className="chat-tools">{m.tools.map(t => <li key={t.id}>{t.status === 'done' ? <Check size={13} /> : t.status === 'rejected' ? <AlertTriangle size={13} /> : <span className="status-dot" />}{toolNames[t.name] || t.name}<small>{t.status === 'running' ? '处理中' : t.status === 'rejected' ? '修改未通过' : '完成'}</small></li>)}</ul>}
        <p>{m.text || (busy ? '正在读取设计…' : '请求结束。')}</p>
        {m.applied && <div className="chat-applied"><Badge tone="success">已应用 · 可撤销</Badge><ul>{m.changes?.map((change, i) => <li key={i}>{change}</li>)}</ul></div>}
        {m.notice && <p className="inline-error" role="status">{m.notice}</p>}
      </article>)}<div ref={bottom} />
    </div>
    <form className="chat-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
      <label htmlFor="agent-message" className="sr-only">告诉 Pi 你想如何调整模型</label><textarea id="agent-message" value={draft} onChange={e => setDraft(e.target.value)} placeholder="例如：壁厚改成 3 mm，屏幕往上移动 2 mm" maxLength={6000} rows={3} disabled={busy} aria-describedby="agent-help" />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="chat-compose-footer"><small id="agent-help">{ai.model?.configured ? '发送当前参数；修改通过几何检查后应用。' : '配置 AI 凭据后即可发送。'}</small>{busy ? <button type="button" className="button button-small" onClick={() => controller.current?.abort()}><Square size={13} />停止</button> : <button type="submit" className="button button-primary button-small" disabled={!draft.trim() || !ai.model?.configured}><Send size={14} />发送</button>}</div>
    </form>
    <div className="px-4 pb-4"><Note>图片预标注在“图片与测量”中进行。此对话发送项目参数，不发送原始照片；AI 无法确认的尺寸仍需实测。</Note></div>
  </div>;
}
