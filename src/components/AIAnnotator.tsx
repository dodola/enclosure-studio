import { useEffect, useRef, useState } from 'react';
import { Sparkles, Square, Check, ScanLine } from 'lucide-react';
import type { AIAnnotation, AIFeature, Part, Photo, PhotoSlot, Port } from '../types';
import { AIModelSelect, AISetup, imageDataUrl, useAI } from '../ai';
import { responseError, uid } from '../lib';
import { Badge, Note, NumberField } from './ui';

const labels = { hole: '安装孔候选', opening: '面板开口', connector: '接口', obstruction: '突出 / 遮挡' };
export default function AIAnnotator({ part, photo, slot, autoRequest, onPhotoUpdate, onApply }: {
  part: Part; photo: Photo; slot: PhotoSlot; autoRequest: number;
  onPhotoUpdate: (photo: Photo) => void; onApply: (patch: Partial<Part>, ports: Port[]) => void;
}) {
  const ai = useAI();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [chosen, setChosen] = useState<string[]>([]);
  const [result, setResult] = useState<AIAnnotation | undefined>(photo.ai), [notice, setNotice] = useState('');
  const [portDetails, setPortDetails] = useState<Record<string, { edge?: Port['edge']; offset?: number; width?: number; height?: number; z?: number }>>({});
  const aborter = useRef<AbortController | null>(null), autoDone = useRef(0);
  const analysis = photo.analysis?.width === part.width && photo.analysis.depth === part.depth ? photo.analysis : undefined;
  const calibrated = Boolean(analysis && ['top', 'bottom'].includes(slot));
  const image = calibrated ? analysis!.rectifiedImage : photo.dataUrl;
  const sourceKey = JSON.stringify([image, part.width, part.depth, slot]);
  const latest = useRef(sourceKey); latest.current = sourceKey;
  const previous = useRef(sourceKey);
  const validResult = result && result.width === part.width && result.depth === part.depth && result.calibrated === calibrated ? result : undefined;
  useEffect(() => {
    if (previous.current !== sourceKey) { aborter.current?.abort(); setResult(photo.ai); setChosen([]); setPortDetails({}); setNotice(''); previous.current = sourceKey; }
  }, [sourceKey, photo.ai]);
  useEffect(() => () => aborter.current?.abort(), []);
  const run = async () => {
    if (busy || !ai.model?.configured || !ai.model.vision) return;
    const key = sourceKey, model = ai.model, controller = new AbortController(); aborter.current = controller;
    setBusy(true); setError(''); setNotice(''); setChosen([]); setPortDetails({});
    try {
      const response = await fetch('/api/ai/annotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ image: await imageDataUrl(image), width: part.width, depth: part.depth, height: part.height, dimensionsVerified: part.verified, kind: part.kind, slot, calibrated,
          hints: calibrated ? analysis?.holes.map(h => ({ x: h.x, y: h.y, diameter: h.diameter })) : [], provider: model.provider, model: model.id }) });
      if (!response.ok) throw new Error(await responseError(response));
      const next: AIAnnotation = await response.json();
      if (controller.signal.aborted || latest.current !== key) return;
      setResult(next); onPhotoUpdate({ ...photo, ai: next });
    } catch (e) { if (latest.current === key) setError(controller.signal.aborted ? '已停止标注。' : e instanceof Error ? e.message : 'AI 标注失败。'); }
    finally { setBusy(false); aborter.current = null; }
  };
  useEffect(() => {
    if (autoRequest && autoDone.current !== autoRequest && ai.model?.configured && ai.model.vision) { autoDone.current = autoRequest; void run(); }
  }, [autoRequest, ai.model?.configured, ai.model?.id]);
  const editFeature = (id: string, patch: Partial<AIFeature>) => setResult(current => current && ({ ...current, features: current.features.map(f => f.id === id ? { ...f, ...patch } : f) }));
  const editBounds = (f: AIFeature, index: number, value: number) => {
    const bbox = [...f.bbox]; bbox[index] = value / 100;
    bbox[2] = Math.min(bbox[2], 1 - bbox[0]); bbox[3] = Math.min(bbox[3], 1 - bbox[1]);
    const [x, y, w, h] = bbox, round = (n: number) => +n.toFixed(2);
    const measurement = calibrated ? { x: round(x * part.width), y: round(y * part.depth), width: round(w * part.width), depth: round(h * part.depth),
      ...(f.kind === 'hole' ? { x: round((x + w / 2) * part.width), y: round((y + h / 2) * part.depth), diameter: round(Math.min(w * part.width, h * part.depth)) } : {}) } : undefined;
    editFeature(f.id, { bbox, measurement });
  };
  const editMeasurement = (f: AIFeature, field: string, value: number) => {
    if (!f.measurement) return;
    const m = { ...f.measurement, [field]: value };
    const bbox = f.kind === 'hole'
      ? [(m.x - (m.diameter || 0) / 2) / part.width, (m.y - (m.diameter || 0) / 2) / part.depth, (m.diameter || 0) / part.width, (m.diameter || 0) / part.depth]
      : [m.x / part.width, m.y / part.depth, m.width / part.width, m.depth / part.depth];
    editFeature(f.id, { measurement: m, bbox });
  };
  const detailsFor = (f: AIFeature) => {
    const m = f.measurement;
    return { edge: f.edge, ...(m && f.edge ? { offset: f.edge === 'front' || f.edge === 'back' ? m.x + m.width / 2 : m.y + m.depth / 2,
      width: f.edge === 'front' || f.edge === 'back' ? m.width : m.depth } : {}), ...portDetails[f.id] };
  };
  const apply = () => {
    if (!validResult) return;
    setError(''); setNotice('');
    const features = validResult.features.filter(f => chosen.includes(f.id)), ports: Port[] = [], holes = [...part.holes];
    const patch: Partial<Part> = { verified: false };
    try {
      const openings = features.filter(f => f.kind === 'opening');
      if (openings.length > 1) throw new Error('每个组件目前支持一个面板开口，请只选择一个开口。');
      for (const f of features) {
        const m = f.measurement;
        if (!f.label.trim()) throw new Error('标注名称不能为空。');
        if (f.kind === 'hole') {
          if (!m?.diameter || m.diameter > 20 || m.x < 0 || m.x > part.width || m.y < 0 || m.y > part.depth) throw new Error('请校准图片并修正孔中心与孔径（0–20 mm）。');
          if (!holes.some(h => Math.hypot(h.x - m.x, h.y - m.y) < 1)) holes.push({ id: uid(), x: m.x, y: m.y, diameter: m.diameter, source: `pi:${validResult.provider}/${validResult.model}`, verified: false });
        }
        if (f.kind === 'opening') {
          if (!m || part.kind === 'board') throw new Error('开发板不能直接采用面板开口；屏幕和键盘需先校准照片。');
          if (part.kind === 'button') { const diameter = Math.min(m.width, m.depth); patch.openingWidth = diameter; patch.openingDepth = diameter; patch.openingX = m.x + (m.width - diameter) / 2; patch.openingY = m.y + (m.depth - diameter) / 2; }
          else { patch.openingWidth = m.width; patch.openingDepth = m.depth; patch.openingX = m.x; patch.openingY = m.y; }
          if (!patch.openingWidth || !patch.openingDepth || patch.openingX! < 0 || patch.openingY! < 0 || patch.openingX! + patch.openingWidth > part.width || patch.openingY! + patch.openingDepth > part.depth) throw new Error('开口范围必须位于组件内且尺寸大于零。');
        }
        if (f.kind === 'connector') {
          const p = detailsFor(f);
          if (!p.edge || p.offset === undefined || !p.width || !p.height || p.z === undefined) throw new Error(`「${f.label}」需要补充板边、中心位置、宽度、实测高度及离板高度。`);
          const extent = p.edge === 'front' || p.edge === 'back' ? part.width : part.depth;
          if (![p.offset, p.width, p.height, p.z].every(Number.isFinite) || p.width < 1 || p.width > 200 || p.height < 1 || p.height > 100 || p.z < 0 || p.z > 150 || p.offset - p.width / 2 < 0 || p.offset + p.width / 2 > extent) throw new Error(`「${f.label}」的尺寸无效或超出组件板边。`);
          ports.push({ id: uid(), componentId: part.id, name: f.label, edge: p.edge, offset: p.offset, width: p.width, height: p.height, z: p.z, verified: false });
        }
      }
      if (holes.length > 40) throw new Error('一个组件最多支持 40 个安装孔。');
      patch.holes = holes; patch.photos = { ...part.photos, [slot]: { ...photo, ai: validResult } };
      onApply(patch, ports); setChosen([]); setNotice('已采用候选，仍为待复核尺寸。可在属性栏修正，也可撤销。');
    } catch (e) { setError(e instanceof Error ? e.message : '采用失败。'); }
  };
  return <section className="card ai-annotation" aria-label="AI 图片预标注">
    <div className="card-header"><strong><Sparkles size={17} />AI 预标注</strong><Badge>Pi Agent</Badge></div>
    <div className="space-y-4 p-4"><AIModelSelect disabled={busy} vision />
      <p className="text-xs leading-6 text-slate-500">识别孔的用途、接口、显示区和按键区。会将当前视角的图片发送给所选 AI 供应商；已校准图片用于估算平面尺寸。</p>
      {!ai.model?.configured && <AISetup />}
      <div className="flex flex-wrap items-center gap-3"><button className="button button-primary button-small" disabled={busy || !ai.model?.configured || !ai.model.vision} onClick={() => void run()}><Sparkles size={14} />{busy ? 'AI 正在标注…' : validResult ? '重新预标注' : 'AI 预标注图片'}</button>{busy && <button className="button button-small" onClick={() => aborter.current?.abort()}><Square size={13} />停止</button>}<span className="text-xs text-slate-500" role="status">{calibrated ? '使用已校准俯视图' : '先标注目标和板角，校准后可测量'}</span></div>
      {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="text-xs text-teal-700" role="status">{notice}</p>}
      {validResult && <>
        <div className="ai-image-stage"><div className="ai-image-wrap"><img src={image} alt="AI 预标注结果，编号对应下方候选列表" /><svg className="photo-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{validResult.features.map((f, i) => <g key={f.id}><rect x={f.bbox[0] * 100} y={f.bbox[1] * 100} width={f.bbox[2] * 100} height={f.bbox[3] * 100} fill="#0f766e" fillOpacity={chosen.includes(f.id) ? .25 : .06} stroke="#0f766e" strokeWidth=".35" /><text x={f.bbox[0] * 100} y={Math.max(3, f.bbox[1] * 100)} fill="#0f766e" fontSize="3">{i + 1}</text></g>)}{validResult.corners && <polygon points={validResult.corners.map(p => `${p[0] * 100},${p[1] * 100}`).join(' ')} fill="none" stroke="#b45309" strokeWidth=".4" />}</svg></div></div>
        <div className="flex flex-wrap items-center gap-3"><span className="text-xs text-slate-500">{validResult.provider} / {validResult.model} · {validResult.features.length} 个候选</span>{!calibrated && validResult.corners && <button className="button button-small" onClick={() => { onPhotoUpdate({ ...photo, corners: validResult.corners, ai: validResult }); setNotice('已采用 AI 板角。请检查板角后点击“校准并识别”，再运行 AI 标注。'); }}><ScanLine size={14} />采用 AI 板角</button>}</div>
        {!calibrated && <Note>当前框选坐标尚未转换为毫米。安装孔及面板开口需先校准，再重新标注。侧面接口的高度和离板高度需手动补充。</Note>}
        {slot === 'bottom' && <Note warning>背面图片坐标可能与正面镜像。采用孔位前，需确保校准四角对应正面的 X/Y 方向。</Note>}
        <div className="ai-features">{validResult.features.map((f, index) => {
          const m = f.measurement, p = detailsFor(f), disabled = f.kind === 'obstruction' || (!calibrated && f.kind !== 'connector') || (f.kind === 'opening' && part.kind === 'board');
          return <details className="ai-feature" key={f.id}><summary><span className="ai-feature-index">{index + 1}</span><strong>{f.label}</strong><span>{Math.round(f.confidence * 100)}%</span><small>{labels[f.kind]}</small></summary>
            <div className="space-y-3 p-3"><label className="ai-feature-choice"><input type="checkbox" checked={chosen.includes(f.id)} disabled={disabled} onChange={e => setChosen(current => e.target.checked ? [...current, f.id] : current.filter(id => id !== f.id))} />{disabled ? '参考标注，当前不能采用' : '采用此候选'}</label>
              <label className="ai-text-field">标注名称<input value={f.label} maxLength={120} onChange={e => editFeature(f.id, { label: e.target.value })} /></label>
              <p className="text-xs leading-5 text-slate-500">{f.note || 'AI 推断结果，请复核用途和尺寸。'}</p>
              <div className="grid grid-cols-2 gap-3">{['框左 X', '框上 Y', '框宽', '框高'].map((label, i) => <NumberField key={label} label={label} value={+(f.bbox[i] * 100).toFixed(2)} unit="%" max={100} onChange={value => editBounds(f, i, value)} />)}</div>
              {m && (f.kind === 'hole' || f.kind === 'opening') && <div className="grid grid-cols-2 gap-3">{(f.kind === 'hole' ? ['x', 'y', 'diameter'] as const : ['x', 'y', 'width', 'depth'] as const).map(field => <NumberField key={field} label={{ x: f.kind === 'hole' ? '孔中心 X' : '开口左上 X', y: f.kind === 'hole' ? '孔中心 Y' : '开口左上 Y', diameter: '估算孔径', width: '开口宽度', depth: '开口长度' }[field]} value={m[field] || 0} min={field === 'diameter' ? .1 : 0} max={field === 'diameter' ? 20 : 400} onChange={value => editMeasurement(f, field, value)} />)}</div>}
              {f.kind === 'connector' && <div className="ai-port-fields"><label className="ai-text-field">对应板边<select value={p.edge || ''} onChange={e => setPortDetails(current => ({ ...current, [f.id]: { ...current[f.id], edge: e.target.value as Port['edge'] } }))}><option value="">请选择板边</option><option value="front">前边 / 下方</option><option value="back">后边 / 上方</option><option value="left">左边</option><option value="right">右边</option></select></label><div className="grid grid-cols-2 gap-3">{(['offset', 'width', 'height', 'z'] as const).map(field => <label key={field} className="ai-text-field">{{ offset: '中心沿板边 (mm)', width: '开口宽度 (mm)', height: '实测高度 (mm)', z: '相对组件底面 Z (mm)' }[field]}<input type="number" min={field === 'width' || field === 'height' ? 1 : 0} max={field === 'height' ? 100 : field === 'z' ? 150 : 400} step="0.1" value={p[field] ?? ''} placeholder="需补充" onChange={e => setPortDetails(current => ({ ...current, [f.id]: { ...current[f.id], [field]: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : undefined } }))} /></label>)}</div></div>}
            </div></details>;
        })}</div>
        {validResult.warnings.length > 0 && <Note warning>{validResult.warnings.join('；')}</Note>}
        {!validResult.features.length && <Note>未找到可用目标。请补充清晰视角或检查组件类型后重试。</Note>}
        <div className="flex flex-wrap gap-3"><button className="button button-primary button-small" disabled={!chosen.length || busy} onClick={apply}><Check size={14} />采用 {chosen.length} 个候选</button><button className="button button-small" disabled={busy} onClick={() => { onPhotoUpdate({ ...photo, ai: validResult }); setNotice('已保存标注，未改变模型尺寸。'); }}>保存标注</button></div>
      </>}
    </div>
  </section>;
}
