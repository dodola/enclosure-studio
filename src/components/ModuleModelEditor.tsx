import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Download, Plus, RotateCcw } from 'lucide-react';
import type { MeshData, ModuleFeature, ModuleModel, Part } from '../types';
import { download, faceDimensions, responseError, uid } from '../lib';
import { Badge, Note, NumberField } from './ui';

const ModuleScene3D = lazy(() => import('./ModuleScene3D'));
const initial = (part: Part): ModuleModel => part.moduleModel || { bodyZ: 0, bodyThickness: Math.min(1.6, faceDimensions(part).thickness), features: [], source: 'manual', warnings: [] };

export default function ModuleModelEditor({ part, onSave, onPhotos }: { part: Part; onSave: (model: ModuleModel) => void; onPhotos: () => void }) {
  const [draft, setDraft] = useState<ModuleModel>(() => initial(part)), [cameraKey, setCameraKey] = useState(0);
  const [mesh, setMesh] = useState<MeshData | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(true), [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const { photos: _photos, ...component } = part;
  const sourceKey = JSON.stringify(component), previous = useRef(sourceKey);
  const { u, v, thickness } = faceDimensions(part);
  const payload = JSON.stringify({ ...component, moduleModel: draft });
  const [validPayload, setValidPayload] = useState('');
  useEffect(() => {
    if (previous.current !== sourceKey) { setDraft(initial(part)); setNotice(''); previous.current = sourceKey; }
  }, [sourceKey, part]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError(''); setMesh(null); setValidPayload('');
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/module/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: controller.signal });
        if (!response.ok) throw new Error(await responseError(response));
        const result = await response.json();
        if (!controller.signal.aborted) { setMesh(result.mesh); setValidPayload(payload); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '模组预览失败。'); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [payload]);
  const edit = (patch: Partial<ModuleModel>) => { setDraft(m => ({ ...m, ...patch, source: 'manual' })); setNotice(''); };
  const feature = (id: string, patch: Partial<ModuleFeature>) => edit({ features: draft.features.map(f => f.id === id ? { ...f, ...patch } : f) });
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial(part));
  const valid = !busy && validPayload === payload && Boolean(mesh);
  const exportSTL = async () => {
    setExporting(true); setError('');
    try {
      const response = await fetch('/api/module/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      if (!response.ok) throw new Error(await responseError(response));
      download(await response.blob(), `${part.name}-模组.stl`);
    } catch (e) { setError(e instanceof Error ? e.message : '下载失败。'); }
    finally { setExporting(false); }
  };
  return <section className="card" aria-label="模组模型编辑器">
    <div className="card-header"><strong>{part.name} · 3D 模型</strong><Badge tone={part.moduleModel ? 'success' : 'neutral'}>{part.moduleModel ? part.moduleModel.source === 'ai' ? 'AI 生成 · 待复核' : '手动模型' : '基础模型草稿'}</Badge></div>
    <div className="module-editor">
      <div><div className="module-preview">{mesh ? <Suspense fallback={<p role="status">正在加载 3D 视图…</p>}><ModuleScene3D mesh={mesh} cameraKey={cameraKey} /></Suspense> : <div className="module-preview-empty" role="status">{busy ? '正在校验模组实体…' : '请修正参数后预览模型'}</div>}</div>
        <div className="flex flex-wrap items-center gap-3 p-3"><button className="button button-small" onClick={()=>setCameraKey(k=>k+1)} disabled={!mesh}><RotateCcw size={14}/>重置视角</button><button className="button button-small" disabled={!valid || exporting} onClick={()=>void exportSTL()}><Download size={14}/>{exporting ? '正在下载…' : '下载模组 STL'}</button></div>
        <p className="px-3 pb-3 text-xs leading-5 text-slate-500">拖动旋转 · 滚轮缩放 · 右键平移。局部 X=U、Y=V、Z=法向厚度，原点位于模组最低角。已知安装孔自动贯穿模型。</p>
      </div>
      <div className="space-y-4 p-4"><p className="text-sm">外形范围 {u} × {v} × {thickness} mm。修改总尺寸和安装孔请使用右侧属性。</p>
        <div className="grid grid-cols-2 gap-3"><NumberField label="主体底面 Z" value={draft.bodyZ} max={Math.max(0,thickness-draft.bodyThickness)} onChange={bodyZ=>edit({bodyZ})}/><NumberField label="主体厚度" value={draft.bodyThickness} min={.1} max={thickness-draft.bodyZ} onChange={bodyThickness=>edit({bodyThickness})}/></div>
        <div className="section-title"><h2>局部实体 <span>{draft.features.length}</span></h2><button className="button button-small" disabled={draft.features.length>=40} onClick={()=>edit({features:[...draft.features,{id:uid(),name:'新部件',shape:'box',operation:'add',x:u*.25,y:v*.25,z:draft.bodyZ,width:Math.min(10,u/2),depth:Math.min(10,v/2),height:Math.min(thickness-draft.bodyZ,draft.bodyThickness+2)}]})}><Plus size={14}/>添加实体</button></div>
        <div className="module-features">{draft.features.map(f=><details className="ai-feature" key={f.id}><summary><strong>{f.name || '未命名部件'}</strong><small>{f.operation==='add'?'添加':'切除'} · {f.shape==='box'?'长方体':'圆柱'}</small></summary><div className="space-y-3 p-3">
          <label className="ai-text-field">部件名称<input value={f.name} maxLength={120} onChange={e=>feature(f.id,{name:e.target.value})}/></label>
          <div className="grid grid-cols-2 gap-3"><label className="ai-text-field">形状<select value={f.shape} onChange={e=>feature(f.id,{shape:e.target.value as ModuleFeature['shape'],...(e.target.value==='cylinder'?{depth:f.width}:{})})}><option value="box">长方体</option><option value="cylinder">圆柱</option></select></label><label className="ai-text-field">运算<select value={f.operation} onChange={e=>feature(f.id,{operation:e.target.value as ModuleFeature['operation']})}><option value="add">添加实体</option><option value="cut">切除凹槽 / 孔</option></select></label></div>
          <div className="grid grid-cols-2 gap-3">{(['x','y','z','width','depth','height'] as const).map(field=><NumberField key={field} label={{x:'局部 X',y:'局部 Y',z:'局部 Z',width:f.shape==='cylinder'?'直径':'宽度',depth:'长度',height:'高度'}[field]} value={f[field]} min={['x','y','z'].includes(field)?0:.1} max={field==='x'||field==='width'?u:field==='y'||field==='depth'?v:thickness} disabled={f.shape==='cylinder'&&field==='depth'} onChange={n=>feature(f.id,{[field]:n,...(f.shape==='cylinder'&&field==='width'?{depth:n}:{})})}/>)}</div>
          <button className="button button-small" onClick={()=>edit({features:draft.features.filter(item=>item.id!==f.id)})}>移除此实体</button>
        </div></details>)}</div>
        {draft.warnings.length>0&&<Note warning>{draft.warnings.join('；')}</Note>}
        {error&&<p className="inline-error" role="alert">{error}</p>}
        <div className="flex flex-wrap gap-3"><button className="button button-primary" disabled={!valid || (!dirty && Boolean(part.moduleModel))} onClick={()=>{onSave(draft);setNotice('模型已保存，可撤销或重做。');}}>保存模型修改</button><button className="button" disabled={!dirty} onClick={()=>{setDraft(initial(part));setNotice('已放弃未保存修改。');}}>放弃修改</button><button className="button" onClick={onPhotos}>上传照片 / 统一生成</button></div>
        <p className="text-xs text-slate-500" role="status">{busy?'正在检查最新参数…':dirty?'有未保存的模型修改。':notice || (part.moduleModel?'已保存模型，可继续编辑。':'可保存基础模型，或上传照片统一生成。')}</p>
      </div>
    </div>
  </section>;
}
