import { useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Camera, Upload, ScanLine, MousePointer2, Check, Plus, Ruler, Image as ImageIcon } from 'lucide-react';
import { cn, compressPhoto, photoNames, responseError, uid } from '../lib';
import type { Analysis, Part, Photo, PhotoSlot, Port } from '../types';
import { Badge, Note, NumberField } from './ui';
import AIAnnotator from './AIAnnotator';

export const photoGuide = [
  { slot: 'top' as PhotoSlot, title: '正面俯视', detail: '镜头垂直板面，四个板角完整可见。用于板轮廓、孔位及屏幕／键盘开口测量。', hint: '已知长宽 · 长边建议 ≥ 1000 px' },
  { slot: 'bottom' as PhotoSlot, title: '背面俯视', detail: '翻到背面，保留完整轮廓。确认底面元件、安装孔和排线接口。', hint: '与正面来自同一块实物、同一版本' },
  { slot: 'front' as PhotoSlot, title: '接口侧面', detail: '正对有接口的板边，拍清接口上下边缘和 PCB。多个接口边可在其他组件中分别记录。', hint: '带毫米尺 · 尺子与接口处于同一平面' },
  { slot: 'side' as PhotoSlot, title: '高度侧面', detail: '拍清 PCB 上下两侧的突出物。屏幕需拍玻璃与背板，按钮需拍安装螺纹和插入深度。', hint: '标明总高、PCB 厚度及安装基准面' },
];

export default function PhotosPanel({ part, onUpdate, onAIApply, onGuide }: { part: Part; onUpdate: (patch: Partial<Part>) => void; onAIApply: (patch: Partial<Part>, ports: Port[]) => void; onGuide: () => void }) {
  const [slot, setSlot] = useState<PhotoSlot>('top');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'view' | 'corners' | 'hole' | 'opening'>('view');
  const [points, setPoints] = useState<number[][]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [openingStart, setOpeningStart] = useState<number[] | null>(null);
  const [autoAI, setAutoAI] = useState(true), [aiRequest, setAIRequest] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const photo = part.photos[slot];
  const isPlane = slot === 'top' || slot === 'bottom';
  const analysis = photo?.analysis && photo.analysis.width === part.width && photo.analysis.depth === part.depth ? photo.analysis : undefined;
  const showRectified = Boolean(analysis && mode !== 'corners');
  const changeSlot = (value: PhotoSlot) => { setSlot(value); setError(''); setMode('view'); setChosen([]); setPoints([]); setOpeningStart(null); setAIRequest(0); };
  const savePhoto = (value: Photo) => onUpdate({ photos: { ...part.photos, [slot]: value } });
  const upload = async (file?: File) => {
    if (!file) return;
    setError(''); setBusy(true);
    try { const dataUrl = await compressPhoto(file); savePhoto({ name: file.name, dataUrl }); setMode('view'); setChosen([]); setPoints([]); if (autoAI) setAIRequest(current => current + 1); }
    catch (e) { setError(e instanceof Error ? e.message : '图片读取失败。'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const runAnalysis = async () => {
    if (!photo) return;
    setBusy(true); setError('');
    try {
      const data = new FormData();
      data.append('image', await (await fetch(photo.dataUrl)).blob(), 'component.jpg'); data.append('width', String(part.width)); data.append('depth', String(part.depth));
      const corners = mode === 'corners' ? points : photo.corners;
      if (corners?.length === 4) data.append('corners', JSON.stringify(corners));
      const response = await fetch('/api/analyze', { method: 'POST', body: data });
      if (!response.ok) throw new Error(await responseError(response));
      const result: Analysis = await response.json();
      savePhoto({ ...photo, corners: result.corners, analysis: result, ai: undefined }); setChosen([]); setMode('view'); if (autoAI) setAIRequest(current => current + 1);
    } catch (e) { setError(e instanceof Error ? e.message : '测量服务暂不可用。'); }
    finally { setBusy(false); }
  };
  const clickPhoto = (event: MouseEvent<HTMLButtonElement>) => {
    if (!img.current || mode === 'view') return;
    const rect = img.current.getBoundingClientRect();
    const point = [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
    if (mode === 'corners') setPoints(current => current.length < 4 ? [...current, point] : [point]);
    if (mode === 'hole') {
      onUpdate({ verified: false, holes: [...part.holes, { id: uid(), x: +(point[0] * part.width).toFixed(2), y: +(point[1] * part.depth).toFixed(2), diameter: 3.5, source: 'image', verified: false }] });
      setMode('view');
    }
    if (mode === 'opening') {
      if (!openingStart) setOpeningStart(point);
      else { onUpdate({ openingWidth: Math.max(1, +(Math.abs(point[0] - openingStart[0]) * part.width).toFixed(1)), openingDepth: Math.max(1, +(Math.abs(point[1] - openingStart[1]) * part.depth).toFixed(1)), openingX: +(Math.min(point[0], openingStart[0]) * part.width).toFixed(1), openingY: +(Math.min(point[1], openingStart[1]) * part.depth).toFixed(1), verified: false }); setOpeningStart(null); setMode('view'); }
    }
  };
  const applyHoles = () => {
    if (!analysis) return;
    onUpdate({ holes: analysis.holes.filter(h => chosen.includes(h.id)).map(h => ({ ...h, id: uid(), verified: false })), verified: false }); setChosen([]);
  };
  return <div className="photo-page">
    <div className="page-title-row"><div><span className="eyebrow">PHOTO & MEASURE</span><h1>让照片成为尺寸依据</h1><p>为「{part.name}」补充视角，再校准平面尺寸。</p></div><button className="button" onClick={onGuide}><Camera size={16} />拍照要求</button></div>
    <div className="photo-slots">
      {photoGuide.map(g => <button key={g.slot} className={cn('photo-slot', slot === g.slot && 'photo-slot-active')} onClick={() => changeSlot(g.slot)}>
        <span className="photo-slot-icon">{part.photos[g.slot] ? <Check size={17} /> : <Camera size={17} />}</span><span><strong>{g.title}</strong><small>{part.photos[g.slot] ? '已上传' : (g.slot === 'front' && part.kind !== 'board' ? '按需补充' : '建议上传')}</small></span>{part.photos[g.slot] && <span className="slot-dot" />}
      </button>)}
    </div>
    <label className="ai-auto-label"><input type="checkbox" checked={autoAI} onChange={e => setAutoAI(e.target.checked)} />上传或校准后自动 AI 预标注（配置视觉模型后发送当前图片）</label>
    <div className="photo-editor card">
      <div className="card-header"><div className="flex items-center gap-2"><ImageIcon size={16} /><strong>{photoNames[slot]}</strong>{analysis && <Badge tone="success">已校准</Badge>}</div><button className="button button-small" onClick={() => input.current?.click()} disabled={busy}><Upload size={14} />{photo ? '替换图片' : '上传图片'}</button></div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label="上传组件照片" onChange={e => void upload(e.target.files?.[0])} />
      <div className="photo-stage" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void upload(event.dataTransfer.files[0]); }}>
        {photo ? <div className="photo-image-wrap"><button className={cn('photo-image-button', mode !== 'view' && 'is-picking')} aria-label={mode === 'corners' ? '在照片上依次标记四个板角，也可使用下方坐标输入' : mode === 'hole' ? '点击安装孔中心' : mode === 'opening' ? '点击开口的两个对角' : '组件照片'} onClick={clickPhoto}>
          <img ref={img} src={showRectified ? analysis?.rectifiedImage : photo.dataUrl} alt={`${part.name}的${photoNames[slot]}照片`} />
          <svg className="photo-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {mode === 'corners' && <><polygon points={points.map(p => `${p[0] * 100},${p[1] * 100}`).join(' ')} fill="#0f766e" fillOpacity=".12" stroke="#0f766e" strokeWidth=".5" />{points.map((p, i) => <g key={i}><circle cx={p[0] * 100} cy={p[1] * 100} r="1.4" fill="#0f766e" stroke="white" strokeWidth=".3" /><text x={p[0] * 100 + 2} y={p[1] * 100 + 1} fontSize="3" fill="#0f766e">{i + 1}</text></g>)}</>}
            {showRectified && analysis?.holes.map((h, i) => <g key={h.id}><circle cx={h.x / part.width * 100} cy={h.y / part.depth * 100} r={h.diameter / part.width * 50} fill={chosen.includes(h.id) ? '#0f766e' : 'none'} fillOpacity=".3" stroke={chosen.includes(h.id) ? '#0f766e' : '#b7791f'} strokeWidth=".45" /><text x={h.x / part.width * 100 + 2.2} y={h.y / part.depth * 100 + 1} fill="#0f766e" fontSize="2.5">{i + 1}</text></g>)}
            {openingStart && <circle cx={openingStart[0] * 100} cy={openingStart[1] * 100} r="1.4" fill="#0f766e" />}
          </svg>
        </button></div> : <button className="photo-empty" onClick={() => input.current?.click()} disabled={busy}><span className="upload-symbol"><Upload size={24} /></span><strong>上传{photoNames[slot]}照片</strong><span>点击选择或将图片拖到这里</span><small>PNG / JPG / WebP · 最大 12 MB</small></button>}
      </div>
      <div className="photo-toolbar"><span className="truncate text-xs text-slate-500">{photo?.name || '浅色纯背景、均匀光线，完整保留板件轮廓'}</span>{isPlane && photo && <div className="flex flex-wrap items-center gap-2"><button className="button button-small" disabled={busy} onClick={() => { setMode(mode === 'corners' ? 'view' : 'corners'); setPoints(photo.corners || []); setOpeningStart(null); }}><MousePointer2 size={14} />标记板角</button><button className="button button-primary button-small" onClick={() => void runAnalysis()} disabled={busy || (mode === 'corners' && points.length !== 4)}><ScanLine size={14} />{busy ? '正在测量…' : '校准并识别'}</button></div>}</div>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {photo && <AIAnnotator key={`${part.id}:${slot}`} part={part} photo={photo} slot={slot} autoRequest={aiRequest} onPhotoUpdate={savePhoto} onApply={onAIApply} />}
    {mode === 'corners' && <div className="card p-4"><p className="mb-3 text-sm font-medium">按左上、右上、右下、左下标记 PCB 板角，避开突出连接器。</p><div className="calibration-fields">{Array.from({ length: 4 }, (_, i) => <div key={i}><span className="mb-2 block text-xs text-slate-500">板角 {i + 1}</span><div className="grid grid-cols-2 gap-2"><NumberField label="X" value={+(100 * (points[i]?.[0] || 0)).toFixed(1)} max={100} unit="%" onChange={n => setPoints(current => { const next = Array.from({ length: 4 }, (_, j) => current[j] || [.1 + (j === 1 || j === 2 ? .8 : 0), .1 + (j >= 2 ? .8 : 0)]); next[i] = [n / 100, next[i][1]]; return next; })} /><NumberField label="Y" value={+(100 * (points[i]?.[1] || 0)).toFixed(1)} max={100} unit="%" onChange={n => setPoints(current => { const next = Array.from({ length: 4 }, (_, j) => current[j] || [.1 + (j === 1 || j === 2 ? .8 : 0), .1 + (j >= 2 ? .8 : 0)]); next[i] = [next[i][0], n / 100]; return next; })} /></div></div>)}</div></div>}
    {!isPlane && <Note>此视角用于复核接口和上下突出高度。第一版不自动推断侧面高度，请把实测值填入组件或接口尺寸。</Note>}
    {analysis && mode !== 'corners' && <div className="card measurement-results"><div className="card-header"><div><strong>圆孔候选</strong><span className="ml-2 text-xs text-slate-500">{analysis.method} · {analysis.holes.length} 个</span></div><button className="button button-small" onClick={() => { setMode(mode === 'hole' ? 'view' : 'hole'); setOpeningStart(null); }}><Plus size={14} />手动标孔</button></div>
      <p className="px-4 pt-3 text-xs leading-5 text-slate-500">选择用于安装外壳的孔，排除散热器孔。采用后可在右侧修改坐标和孔径。</p>
      {analysis.holes.length ? <div className="hole-candidates">{analysis.holes.map((h, i) => <label key={h.id}><input type="checkbox" checked={chosen.includes(h.id)} onChange={e => setChosen(current => e.target.checked ? [...current, h.id] : current.filter(id => id !== h.id))} /><span><strong>孔 {i + 1}</strong><small>X {h.x} · Y {h.y} · ⌀ {h.diameter} mm</small></span></label>)}</div> : <p className="px-4 py-5 text-sm text-slate-500">没有找到可靠的圆孔候选。可以点击“手动标孔”，或在右侧输入孔位。</p>}
      {mode === 'hole' && <p className="px-4 pb-3 text-sm text-teal-700">请点击校准图片中的孔中心。默认孔径 3.5 mm，添加后需实测修正。</p>}
      <div className="card-footer"><span className="text-xs text-slate-500">坐标原点：组件左上角</span><button className="button button-primary button-small" disabled={!chosen.length} onClick={applyHoles}>采用 {chosen.length} 个孔位</button></div>
    </div>}
    {analysis && part.kind !== 'board' && part.kind !== 'button' && <button className="button w-full" onClick={() => { setMode(mode === 'opening' ? 'view' : 'opening'); setOpeningStart(null); }}><Ruler size={16} />{mode === 'opening' ? '点击显示区或键盘区的两个对角' : '在校准图片中框选上盖开口'}</button>}
    <div className="photo-tip"><Camera size={18} /><div><strong>{photoGuide.find(g => g.slot === slot)?.detail}</strong><p>{photoGuide.find(g => g.slot === slot)?.hint}</p></div></div>
  </div>;
}
