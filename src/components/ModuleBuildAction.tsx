import { useEffect, useRef, useState } from 'react';
import { Box, Square } from 'lucide-react';
import type { ModuleBuildResult, Part, PhotoSlot } from '../types';
import { AIModelSelect, AISetup, imageDataUrl, useAI } from '../ai';
import { faceDimensions, photoNames, responseError } from '../lib';

const slots: PhotoSlot[] = ['top', 'bottom', 'front', 'side'];

export default function ModuleBuildAction({ part, onApply, disabled }: {
  part: Part; onApply: (result: ModuleBuildResult, source: Part) => boolean; disabled: boolean;
}) {
  const ai = useAI();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const aborter = useRef<AbortController | null>(null);
  const sourceKey = JSON.stringify(part), latest = useRef(sourceKey); latest.current = sourceKey;
  useEffect(() => { aborter.current?.abort(); setBusy(false); }, [sourceKey]);
  useEffect(() => () => aborter.current?.abort(), []);
  const uploaded = slots.filter(slot => part.photos[slot]);
  const run = async () => {
    if (busy || disabled || !uploaded.length || !ai.model?.configured || !ai.model.vision) return;
    const controller = new AbortController(), key = sourceKey, source = part, model = ai.model;
    aborter.current = controller; setBusy(true); setError('');
    try {
      const { u, v } = faceDimensions(source);
      const photos = await Promise.all(uploaded.map(async slot => {
        const photo = source.photos[slot]!;
        const calibrated = ['top', 'bottom'].includes(slot) && photo.analysis?.width === u && photo.analysis.depth === v;
        return { slot, calibrated, image: await imageDataUrl(calibrated ? photo.analysis!.rectifiedImage : photo.dataUrl) };
      }));
      if (controller.signal.aborted) return;
      const { photos: _photos, ...component } = source;
      const response = await fetch('/api/ai/module', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ component, photos, provider: model.provider, model: model.id }) });
      if (!response.ok) throw new Error(await responseError(response));
      const result: ModuleBuildResult = await response.json();
      if (controller.signal.aborted || latest.current !== key) return;
      if (!onApply(result, source)) throw new Error('照片或模组数据已变化，请重新生成。');
    } catch (e) {
      if (!controller.signal.aborted && latest.current === key) setError(e instanceof Error ? e.message : '统一建模失败，请重试。');
    } finally { if (aborter.current === controller) { setBusy(false); aborter.current = null; } }
  };
  return <section className="card" aria-label="统一标注与建模">
    <div className="card-header"><strong>上传完成后，统一标注与建模</strong><span className="text-xs text-slate-500">已上传 {uploaded.length} / 4 个视角</span></div>
    <div className="space-y-4 p-4">
      <p className="text-sm leading-6 text-slate-500">照片上传后保存在项目中。点击按钮，将「{part.name}」的全部已上传视角发送给所选模型，一次生成标注和可编辑的 3D 模型。</p>
      <p className="text-xs text-slate-500">{uploaded.length ? uploaded.map(slot => photoNames[slot]).join(' · ') : '先上传至少一张照片；建议补齐正面、背面和侧面。'}</p>
      <AIModelSelect disabled={busy} vision />
      {!ai.model?.configured && <AISetup />}
      <div className="flex flex-wrap gap-3"><button className="button button-primary" disabled={busy || disabled || !uploaded.length || !ai.model?.configured || !ai.model.vision} onClick={() => void run()}><Box size={16} />{busy ? '正在统一标注并生成模型…' : '统一标注并生成 3D 模型'}</button>
        {busy && <button className="button" onClick={() => { aborter.current?.abort(); setBusy(false); }}><Square size={14} />停止</button>}</div>
      <p className="text-xs leading-5 text-slate-500" role="status">{busy ? '正在分析全部视角并校验实体，完成后进入模组管理。修改照片或尺寸会停止本次生成。' : '基于已知尺寸生成主体、孔位和突出部件；生成后可在模组管理中浏览、修改。推断尺寸需实测复核。'}</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  </section>;
}
