import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { get, set } from 'idb-keyval';
import * as Tabs from '@radix-ui/react-tabs';
import { Box, ChevronRight, Plus, Camera, LayoutGrid, Layers, Download, FolderOpen, HelpCircle, ArrowUpRight, Check, Undo2, Redo2, RotateCcw, Maximize2, Eye, EyeOff, SlidersHorizontal, FileJson, Upload, PackageCheck, AlertTriangle, CircleCheck, Pencil, HardDrive, MousePointer2, MessageSquare } from 'lucide-react';
import type { Kind, Part, Preview, Project, Step, Issue } from './types';
import { autoLayout, cn, download, geometryPayload, kindNames, newPart, responseError, sampleProject, validateImport } from './lib';
import { Badge, CheckItem, Confirm, Modal, Note } from './components/ui';
import { Inspector, Issues, partIcons } from './components/Inspector';
import LayoutCanvas from './components/LayoutCanvas';
import PhotosPanel, { photoGuide } from './components/PhotosPanel';
import ShellSettings from './components/ShellSettings';
import AgentPanel from './components/AgentPanel';
import { useAI } from './ai';

const Scene3D = lazy(() => import('./components/Scene3D'));

const steps: { id: Step; label: string; icon: typeof Box; description: string }[] = [
  { id: 'components', label: '组件管理', icon: Box, description: '添加板件与面板组件' },
  { id: 'photos', label: '图片与测量', icon: Camera, description: '校准轮廓与孔位' },
  { id: 'layout', label: '布局设计', icon: LayoutGrid, description: '安排每一个组件' },
  { id: 'shell', label: '外壳参数', icon: SlidersHorizontal, description: '设置壁厚与固定方式' },
  { id: 'export', label: '检查与导出', icon: Download, description: '准备试打印文件' },
  { id: 'agent', label: 'AI 设计助手', icon: MessageSquare, description: '对话调整模型 · Pi Agent' },
];

export default function App() {
  const ai = useAI();
  const [project, setProject] = useState<Project>(sampleProject);
  const [loaded, setLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState('正在打开工作区');
  const [step, setStep] = useState<Step>('layout');
  const [selected, setSelected] = useState('firefly');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [generating, setGenerating] = useState(true);
  const [apiError, setApiError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [view, setView] = useState('3d');
  const [layer, setLayer] = useState('all');
  const [exploded, setExploded] = useState(true);
  const [showParts, setShowParts] = useState(true);
  const [cameraKey, setCameraKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.name);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [resetMode, setResetMode] = useState<'blank' | 'sample' | null>(null);
  const [importError, setImportError] = useState('');
  const [history, setHistory] = useState<Project[]>([]);
  const [future, setFuture] = useState<Project[]>([]);
  const projectRef = useRef(project);
  projectRef.current = project;
  const fileInput = useRef<HTMLInputElement>(null);
  const part = project.components.find(c => c.id === selected) || project.components[0];
  const geometryJson = useMemo(() => JSON.stringify(geometryPayload(project)), [project]);
  const currentStep = steps.find(s => s.id === step)!;

  useEffect(() => {
    let cancelled = false;
    get<Project>('enclosure-project-v1').then(saved => {
      if (!cancelled && saved?.version === 1 && Array.isArray(saved.components) && saved.enclosure && saved.ports) {
        setProject({ ...saved, enclosure: { ...saved.enclosure, cornerRadius: saved.enclosure.cornerRadius ?? 0 }, components: saved.components.map(c => ({ ...c, mountOffset: c.mountOffset || 0, photos: c.photos || {} })) });
        setSelected(saved.components[0]?.id || '');
      }
    }).catch(() => { if (!cancelled) setSaveStatus('无法读取本地工作区'); }).finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    setSaveStatus('正在保存…');
    const timer = setTimeout(() => { set('enclosure-project-v1', project).then(() => setSaveStatus('已保存至本机')).catch(() => setSaveStatus('保存失败，请导出项目备份')); }, 500);
    return () => clearTimeout(timer);
  }, [project, loaded]);

  useEffect(() => {
    const controller = new AbortController();
    setGenerating(true); setPreview(null); setApiError(''); setDownloaded(false); setDownloadError('');
    const timer = setTimeout(async () => {
      try {
        const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: geometryJson, signal: controller.signal };
        const validation = await fetch('/api/validate', options);
        if (!validation.ok) throw new Error(await responseError(validation));
        const result = await validation.json();
        if (controller.signal.aborted) return;
        setIssues(result.issues);
        if (result.issues.some((i: Issue) => i.severity === 'error')) { setGenerating(false); return; }
        const response = await fetch('/api/preview', options);
        if (!response.ok) throw new Error(await responseError(response));
        const next: Preview = await response.json();
        if (!controller.signal.aborted) { setPreview(next); setIssues(next.issues); }
      } catch (e) {
        if (!controller.signal.aborted) setApiError(e instanceof Error ? e.message : '模型服务未连接，请运行 npm run dev。');
      } finally { if (!controller.signal.aborted) setGenerating(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [geometryJson]);

  const commit = (update: (value: Project) => Project) => {
    const current = projectRef.current;
    const next = update(current);
    projectRef.current = next;
    setHistory(past => [...past.slice(-19), current]); setFuture([]); setProject(next);
  };
  const patchPart = (id: string, patch: Partial<Part>) => commit(p => ({ ...p, components: p.components.map(c => c.id === id ? { ...c, ...patch } : c) }));
  const updatePart = (patch: Partial<Part>) => { if (part) patchPart(part.id, patch); };
  const applyAgentProject = (next: Project, base: Project) => {
    if (JSON.stringify(geometryPayload(projectRef.current)) !== JSON.stringify(geometryPayload(base))) return false;
    commit(current => ({ ...next, components: next.components.map(c => ({ ...c, photos: current.components.find(original => original.id === c.id)?.photos || {} })) }));
    return true;
  };
  const undo = () => { const previous = history.at(-1); if (!previous) return; setFuture(current => [projectRef.current, ...current]); projectRef.current = previous; setProject(previous); setHistory(current => current.slice(0, -1)); };
  const redo = () => { const next = future[0]; if (!next) return; setHistory(current => [...current, projectRef.current]); projectRef.current = next; setProject(next); setFuture(current => current.slice(1)); };
  const addPart = (kind: Kind) => { const component = newPart(kind, project); commit(p => ({ ...p, components: [...p.components, component] })); setSelected(component.id); setAddOpen(false); setStep('components'); };
  const reset = () => {
    const next = sampleProject();
    if (resetMode === 'blank') { next.name = '我的设备外壳'; next.components = []; next.ports = []; }
    commit(() => next); setSelected(next.components[0]?.id || ''); setResetMode(null); setProjectOpen(false); setStep('components');
  };
  const exportModel = async (coupon = false) => {
    setDownloading(true); setDownloadError('');
    try {
      const response = await fetch(coupon ? '/api/coupon' : '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: geometryJson });
      if (!response.ok) throw new Error(await responseError(response));
      download(await response.blob(), coupon ? 'mounting-test.stl' : `${project.name}-打印包.zip`); setDownloaded(true);
    } catch (e) { setDownloadError(e instanceof Error ? e.message : '下载失败，请重试。'); }
    finally { setDownloading(false); }
  };
  const importProject = async (file?: File) => {
    if (!file) return;
    setImportError('');
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('项目文件不能超过 32 MB。');
      const p = await validateImport(JSON.parse(await file.text()));
      commit(() => p); setSelected(p.components[0]?.id || ''); setProjectOpen(false);
    } catch (e) { setImportError(e instanceof Error ? e.message : '项目导入失败。'); }
    finally { if (fileInput.current) fileInput.current.value = ''; }
  };
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  const allReviewed = project.components.length > 0 && project.components.every(c => c.verified && c.holes.every(h => h.verified)) && project.ports.every(p => p.verified);
  const fullScreen = () => { const element = document.getElementById('model-view'); if (document.fullscreenElement) void document.exitFullscreen(); else void element?.requestFullscreen().catch(() => {}); };

  const canvas = <div className={cn('model-card card', step === 'shell' && 'model-card-compact')}>
    <div className="model-header"><Tabs.Root value={view} onValueChange={setView}><Tabs.List className="segmented" aria-label="预览方式"><Tabs.Trigger value="3d">3D 预览</Tabs.Trigger><Tabs.Trigger value="2d">2D 布局</Tabs.Trigger></Tabs.List></Tabs.Root>
      <div className="flex items-center gap-2"><button className="icon-button" aria-label={showParts ? '隐藏组件' : '显示组件'} title={showParts ? '隐藏组件' : '显示组件'} onClick={() => setShowParts(current => !current)}>{showParts ? <Eye size={16} /> : <EyeOff size={16} />}</button><button className="icon-button" aria-label="重置视角" title="重置视角" onClick={() => setCameraKey(current => current + 1)}><RotateCcw size={16} /></button><button className="icon-button" aria-label="全屏预览" title="全屏预览" onClick={fullScreen}><Maximize2 size={16} /></button></div>
    </div>
    <div id="model-view" className="model-view">
      <div className="view-topline"><span className="view-caption"><span className="status-dot" />{view === '3d' ? '实体模型 · 毫米' : '俯视布局 · 毫米'}</span>{view === '3d' ? <label className="explode-control"><input type="checkbox" checked={exploded} onChange={event => setExploded(event.target.checked)} /><Layers size={14} />分解视图</label> : <label className="layer-control"><span className="sr-only">显示安装层</span><select value={layer} onChange={event => setLayer(event.target.value)}><option value="all">全部组件</option><option value="base">底壳层</option><option value="lid">上盖层</option></select></label>}</div>
      {view === '2d' ? <LayoutCanvas project={showParts ? project : { ...project, components: [], ports: [] }} selected={part?.id || ''} onSelect={setSelected} onMove={patchPart} layer={layer} /> : preview ? <Suspense fallback={<div className="model-empty" role="status">正在加载三维预览…</div>}><Scene3D project={project} preview={preview} selected={part?.id || ''} exploded={exploded} showParts={showParts} cameraKey={cameraKey} /></Suspense> : <div className="model-empty" aria-live="polite">{generating ? <><Box size={38} /><strong>正在生成外壳实体</strong><p>应用尺寸、支撑柱和接口开孔…</p></> : <><AlertTriangle size={32} /><strong>{apiError ? '模型服务暂不可用' : '先调整布局，再预览模型'}</strong><p>{apiError || (errorCount ? `${errorCount} 项几何问题需要处理，可切换到 2D 调整。` : '添加组件并设置外壳尺寸。')}</p><button className="button" onClick={() => setView('2d')}>查看 2D 布局</button></>}</div>}
      <div className="view-bottomline"><span>{view === '3d' ? '拖动旋转 · 滚轮缩放 · 右键平移' : '拖动组件 · 右侧输入精确坐标'}</span><span className="axis-label"><b>X</b> <b>Y</b> <b>Z</b></span></div>
    </div>
    <div className="model-footer"><span><Box size={14} />{project.enclosure.width} × {project.enclosure.depth} × {project.enclosure.height} mm</span><span>{generating ? '更新模型中…' : preview ? <><Check size={13} />封闭实体</> : '待生成'}</span></div>
  </div>;

  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/" aria-label="壳研首页"><span className="brand-mark"><Box size={23} /></span><div><strong>壳研</strong><small>ENCLOSURE STUDIO</small></div></a>
      <div className="sidebar-section-label">工作空间</div><button className="project-selector" onClick={() => { setNameDraft(project.name); setProjectOpen(true); }}><FolderOpen size={17} /><span className="truncate">{project.name}</span><ChevronRight size={14} /></button>
      <div className="sidebar-section-label mt-7">设计流程</div><nav aria-label="设计流程">{steps.map((s, i) => { const Icon = s.icon; return <button key={s.id} className={cn('nav-item', step === s.id && 'nav-item-active')} onClick={() => setStep(s.id)} aria-current={step === s.id ? 'step' : undefined}><Icon size={18} /><span>{s.label}</span><small>{String(i + 1).padStart(2, '0')}</small></button>; })}</nav>
      <div className="sidebar-guide"><span className="guide-camera"><Camera size={22} /></span><strong>拍得准确，装得合适。</strong><p>准备好板件的多个视角，少走一次试打印弯路。</p><button onClick={() => setGuideOpen(true)}>查看拍照指南 <ArrowUpRight size={14} /></button></div>
      <div className="sidebar-bottom"><HardDrive size={14} /><span>本地工作区</span><Badge>v0.1</Badge></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><span>我的项目</span><ChevronRight size={13} /><button onClick={() => { setNameDraft(project.name); setProjectOpen(true); }}>{project.name}<Pencil size={12} /></button></div><div className="topbar-actions"><span className="save-status"><span className={cn('status-dot', saveStatus.includes('失败') && 'status-error')} />{saveStatus}</span><button className="button button-small" onClick={ai.openSettings}>AI 设置</button><button className="icon-button" aria-label="打开使用与拍照指南" onClick={() => setGuideOpen(true)}><HelpCircle size={19} /></button><button className="button button-primary" onClick={() => setStep('export')}><Download size={15} />导出模型</button></div></header>
      <nav className="mobile-nav" aria-label="设计步骤">{steps.map(s => <button key={s.id} className={cn(step === s.id && 'is-active')} onClick={() => setStep(s.id)}>{s.label}</button>)}</nav>
      <div className="workspace"><main className="workspace-main">
        {step === 'agent' && <><div className="page-title-row"><div><span className="eyebrow">AI DESIGN WORKSPACE</span><h1>通过对话，调整你的模型。</h1><p>Pi 读取当前项目，调用设计工具，检查通过后更新预览。</p></div></div><div className="agent-workspace">{canvas}<AgentPanel project={project} selectedId={part?.id} onApply={applyAgentProject} onUndo={undo} canUndo={Boolean(history.length)} /></div></>}
        {(step === 'layout' || step === 'shell') && <>
          <div className="page-title-row"><div><span className="eyebrow">{step === 'layout' ? 'DESIGN WORKSPACE' : 'ENCLOSURE SETTINGS'}</span><h1>{step === 'layout' ? '把想法，装进外壳。' : '为打印做好每一处配合。'}</h1><p>{step === 'layout' ? '组合开发板、屏幕与按键，让每个组件找到合适的位置。' : '调整内腔、壁厚和固定结构，预览会随参数更新。'}</p></div><div className="flex shrink-0 items-center gap-1"><button className="icon-button" aria-label="撤销上一步" title="撤销" disabled={!history.length} onClick={undo}><Undo2 size={17} /></button><button className="icon-button" aria-label="重做上一步" title="重做" disabled={!future.length} onClick={redo}><Redo2 size={17} /></button></div></div>
          {canvas}
          {step === 'layout' ? <>
            <div className="section-title"><h2>设备组件 <span>{project.components.length}</span></h2><div className="flex gap-3"><button className="text-button" onClick={() => commit(autoLayout)} disabled={!project.components.length}><LayoutGrid size={14} />自动排布</button><button className="text-button" onClick={() => setAddOpen(true)}><Plus size={15} />添加组件</button></div></div>
            <div className="part-strips">{project.components.map(c => { const Icon = partIcons[c.kind]; return <button key={c.id} className={cn('part-strip', part?.id === c.id && 'part-strip-selected')} onClick={() => setSelected(c.id)}><span className="part-icon"><Icon size={18} /></span><span className="min-w-0"><strong>{c.name}</strong><small>{c.width} × {c.depth} × {c.height} mm</small></span><span className="strip-layer">{c.mount === 'base' ? '底壳' : '上盖'}</span></button>; })}{!project.components.length && <button className="empty-inline" onClick={() => setAddOpen(true)}><Plus size={18} />添加第一个组件</button>}</div>
            <div className="workflow-bottom"><div><span className={cn('check-circle', errorCount > 0 && 'check-circle-warning')}>{errorCount ? <AlertTriangle size={17} /> : <Check size={17} />}</span><div><strong>{generating ? '正在检查组件布局' : apiError ? '模型服务需要连接' : errorCount ? `${errorCount} 项布局问题需要调整` : '组件布局几何检查通过'}</strong><p>{generating ? '正在检查最新设计…' : `${warningCount} 项尺寸或固定方式待复核，示例高度和屏幕／键盘尺寸请替换为实测值。`}</p></div></div><button className="button" onClick={() => setStep('shell')}>设置外壳<ChevronRight size={15} /></button></div>
          </> : <ShellSettings value={project.enclosure} onChange={patch => commit(p => { const enclosure = { ...p.enclosure, ...patch }; const dz = enclosure.height - p.enclosure.height; return { ...p, enclosure, components: p.components.map(c => c.mount === 'lid' ? { ...c, z: Math.max(0, +(c.z + dz).toFixed(2)) } : c) }; })} />}
        </>}
        {step === 'components' && <>
          <div className="page-title-row"><div><span className="eyebrow">DEVICE COMPONENTS</span><h1>从你的设备组件开始。</h1><p>矩形开发板、屏幕、键盘，以及独立面板按钮。</p></div><button className="button button-primary" onClick={() => setAddOpen(true)}><Plus size={16} />添加组件</button></div>
          <div className="component-grid">{project.components.map(c => { const Icon = partIcons[c.kind]; return <article key={c.id} className={cn('component-card card', part?.id === c.id && 'component-card-selected')}><button className="component-card-main" onClick={() => setSelected(c.id)}><div className="component-illustration">{c.id === 'firefly' ? <img src="/samples/firefly-texture.jpg" alt="Firefly 开发板示例" /> : <Icon size={70} strokeWidth={1} />}<Badge>{c.mount === 'base' ? '底壳安装' : '上盖安装'}</Badge></div><div className="component-card-body"><span className="text-xs text-slate-500">{kindNames[c.kind]}</span><h2>{c.name}</h2><span className="component-dimensions">{c.width} × {c.depth} × {c.height} <small>mm</small></span><div className="flex items-center justify-between"><span className="text-xs text-slate-500">{c.holes.length} 个安装孔 · {Object.keys(c.photos).length} 张图片</span><Badge tone={c.verified ? 'success' : 'warning'}>{c.verified ? '已复核' : '待复核'}</Badge></div></div></button><button className="component-photo-link" onClick={() => { setSelected(c.id); setStep('photos'); }}><Camera size={15} />补充照片与测量<ArrowUpRight size={14} /></button></article>; })}<button className="component-add" onClick={() => setAddOpen(true)}><span><Plus size={24} /></span><strong>添加一个组件</strong><small>开发板 / 屏幕 / 键盘 / 按钮</small></button></div>
          <Note>内置开发板长宽来自你提供的尺寸图，孔位来自图片估算。开发板高度、接口尺寸及屏幕／键盘数据均为待替换的示例值。</Note>
          <div className="workflow-bottom"><div><Box size={21} /><p>每个组件独立记录照片、尺寸与安装位置。</p></div><button className="button" onClick={() => setStep('photos')} disabled={!project.components.length}>下一步：图片测量<ChevronRight size={15} /></button></div>
        </>}
        {step === 'photos' && (part ? <PhotosPanel key={part.id} part={part} onUpdate={updatePart} onAIApply={(patch, ports) => { if (projectRef.current.ports.length + ports.length > 50) throw new Error('项目最多支持 50 个接口。'); commit(p => ({ ...p, components: p.components.map(c => c.id === part.id ? { ...c, ...patch } : c), ports: [...p.ports, ...ports] })); }} onGuide={() => setGuideOpen(true)} /> : <div className="empty-page"><Camera size={40} /><h1>先添加要测量的组件</h1><p>为开发板、屏幕或按键建立独立尺寸记录。</p><button className="button button-primary" onClick={() => setAddOpen(true)}><Plus size={16} />添加组件</button></div>)}
        {step === 'photos' && project.components.length > 1 && <div className="photo-component-switch"><span>切换组件</span>{project.components.map(c => <button key={c.id} className={cn('button button-small', part?.id === c.id && 'button-primary')} onClick={() => setSelected(c.id)}>{c.name}</button>)}</div>}
        {step === 'export' && <>
          <div className="page-title-row"><div><span className="eyebrow">READY TO PRINT</span><h1>让设计变成实物。</h1><p>检查配合尺寸，先试打印，再完成装配。</p></div><Badge tone={errorCount ? 'warning' : 'success'}>{errorCount ? `${errorCount} 项几何错误` : '几何检查通过'}</Badge></div>
          <div className="export-hero card"><div className="export-icon"><PackageCheck size={38} strokeWidth={1.4} /></div><h2>{project.name}</h2><p>{project.enclosure.width} × {project.enclosure.depth} × {project.enclosure.height} mm · 上下两片式</p><div className="export-tags"><Badge>STL · 毫米</Badge><Badge>4 角螺丝固定</Badge><Badge>{project.components.length} 个组件</Badge></div>
            <button className="button button-primary button-large" disabled={!preview || generating || downloading} onClick={() => void exportModel()}><Download size={18} />{downloading ? '正在准备文件…' : warningCount || !allReviewed ? '下载试打印包' : '下载打印包'}</button>
            <small>{generating ? '正在更新最新参数…' : errorCount ? '修正几何错误后可下载。' : apiError ? '模型服务不可用，暂时无法下载。' : '包含底壳、上盖、孔位小样及尺寸记录。'}</small>
            {downloaded && <p className="download-success" role="status"><CircleCheck size={15} />打印文件已准备并触发下载。</p>}{downloadError && <p className="inline-error" role="alert">{downloadError}</p>}
          </div>
          <div className="export-grid"><div className="card"><div className="card-header"><strong>打印前检查</strong><Badge tone={allReviewed ? 'success' : 'warning'}>{allReviewed ? '已复核' : '需实测'}</Badge></div><div className="space-y-3 p-5"><CheckItem checked={Boolean(preview && !errorCount)}>组件无空间碰撞，未超出内腔</CheckItem><CheckItem checked={Boolean(preview?.base.watertight && preview?.lid.watertight)}>底壳和上盖均为封闭实体</CheckItem><CheckItem checked={project.components.length > 0 && project.components.every(c => c.verified)}>组件外形、总高与安装基准已复核</CheckItem><CheckItem checked={project.components.every(c => c.holes.every(h => h.verified))}>安装孔位置与孔径已复核</CheckItem><CheckItem checked={project.ports.every(p => p.verified)}>接口开孔高度与插头空间已复核</CheckItem></div></div>
            <div className="card"><div className="card-header"><strong>先做一次小样</strong><Layers size={16} /></div><div className="p-5"><p className="text-sm leading-6 text-slate-500">用 1.4 mm 薄板快速验证开发板安装孔位置，减少整壳试打印的耗时。</p><button className="button mt-5 w-full" disabled={!preview || downloading || !project.components.some(c => c.mount === 'base' && c.holes.length)} onClick={() => void exportModel(true)}><Download size={15} />下载孔位小样 STL</button></div></div></div>
          {warningCount > 0 && <Note warning>当前有 {warningCount} 项待复核记录，下载文件用于试装。屏幕、键盘及未实测尺寸请在右侧属性中核对；确认标记不会代替实际测量。</Note>}
          {errorCount > 0 && <div className="card p-5"><h2 className="mb-3 text-base font-semibold">需要调整</h2><Issues issues={issues.filter(i => i.severity === 'error')} /><button className="button mt-4" onClick={() => { setView('2d'); setStep('layout'); }}>返回布局调整<ChevronRight size={15} /></button></div>}
          <div className="card file-manifest"><div className="card-header"><strong>打印包内容</strong><span className="text-xs text-slate-400">ZIP</span></div>{[['base.stl', '底壳 · 支撑柱、侧面开孔及通风孔'], ['lid.stl', '上盖 · 面板开口、定位边及螺丝孔'], ...(project.components.some(c => c.mount === 'base' && c.holes.length) ? [['mounting-test.stl', '孔位验证薄板']] : []), ['assembly.json', '模型尺寸、坐标与复核记录'], ['measurements.csv', '安装孔测量数据'], ['README.md', '打印朝向与待复核事项']].map(([name, label]) => <div key={name}><FileJson size={16} /><strong>{name}</strong><span>{label}</span></div>)}</div>
          <button className="button w-full" onClick={() => download(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), `${project.name}-项目.json`)}><FileJson size={16} />保存可重新编辑的项目 JSON（含照片）</button>
        </>}
        {apiError && step !== 'layout' && <p className="inline-error" role="alert">{apiError}</p>}
      </main>
      {step !== 'agent' && <Inspector project={project} part={part} step={step} issues={issues} onUpdate={updatePart} onPortUpdate={(id, patch) => commit(p => ({ ...p, ports: p.ports.map(port => port.id === id ? { ...port, ...patch } : port) }))}
        onPortAdd={port => commit(p => ({ ...p, ports: [...p.ports, port] }))} onPortDelete={id => commit(p => ({ ...p, ports: p.ports.filter(port => port.id !== id) }))}
        onDelete={() => part && setDeleteTarget(part.id)} onPhoto={() => setStep('photos')} />}
      </div><footer className="app-footer"><span>壳研 · 矩形设备外壳设计平台</span><span>{currentStep.description} <span className="mx-2">/</span> 所有尺寸单位：mm</span></footer>
    </div>

    <Modal open={addOpen} onOpenChange={setAddOpen} title="添加设备组件" description="选择组件类型，录入实际尺寸后再安排安装位置。">
      <div className="add-type-grid">{(['board', 'screen', 'keyboard', 'button'] as Kind[]).map(kind => { const Icon = partIcons[kind]; return <button key={kind} onClick={() => addPart(kind)}><span className="part-icon"><Icon size={25} /></span><strong>{kindNames[kind]}</strong><p>{{ board: '矩形 PCB · 底壳支撑柱', screen: '矩形屏幕 · 可视区开口', keyboard: '矩形键盘 · 按键区开口', button: '面板按钮 · 圆形开孔' }[kind]}</p><Plus size={17} /></button>; })}</div>
      <Note>新组件使用初始占位尺寸，添加后请用自己的实物尺寸替换。第一版组件沿 X / Y 方向安装，不支持任意旋转。</Note>
    </Modal>
    <Modal open={guideOpen} onOpenChange={setGuideOpen} title="为准确测量准备照片" description="每个组件单独拍摄。原厂尺寸图可用于平面校准，实物侧视图用于确认高度。">
      <div className="guide-grid">{photoGuide.map((g, i) => <div key={g.slot} className="guide-item"><span>{String(i + 1).padStart(2, '0')}</span><div><h3>{g.title}</h3><p>{g.detail}</p><small>{g.hint}</small></div></div>)}</div>
      <div className="guide-extra"><h3><MousePointer2 size={15} />拍摄要点</h3><ul><li>使用纯色背景与均匀光线，避免反光、阴影和广角畸变。</li><li>正反面镜头垂直板面；四个板角和连接器完整入镜。</li><li>毫米尺与被测物处于同一平面；屏幕要区分外形与可视区。</li><li>长宽标注对应 PCB 还是含接口外形，需要与校准轮廓一致。</li><li>同一组件的照片须来自同一实物与硬件版本。</li></ul></div>
      <Note warning>照片校准只能估算平面尺寸。接口高度、PCB 安装面、线缆和散热器空间需要实测补充；圆孔候选不一定都是外壳安装孔。</Note>
    </Modal>
    <Modal open={projectOpen} onOpenChange={setProjectOpen} title="本地项目" description="当前项目自动保存在本浏览器。导出项目 JSON 可备份或转移到其他电脑。">
      <label className="field mt-6"><span>项目名称</span><input value={nameDraft} maxLength={120} onChange={event => setNameDraft(event.target.value)} /></label><button className="button button-primary mt-3 w-full" onClick={() => { commit(p => ({ ...p, name: nameDraft.trim() || '未命名项目' })); setProjectOpen(false); }}>保存名称</button>
      <div className="project-actions"><button className="button" onClick={() => download(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), `${project.name}-项目.json`)}><Download size={16} />备份项目 JSON</button><button className="button" onClick={() => fileInput.current?.click()}><Upload size={16} />导入项目 JSON</button><button className="button" onClick={() => setResetMode('blank')}><Plus size={16} />新建空白项目</button><button className="button" onClick={() => setResetMode('sample')}><RotateCcw size={16} />载入示例项目</button></div>
      <input ref={fileInput} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-label="导入项目 JSON" onChange={event => void importProject(event.target.files?.[0])} />{importError && <p className="inline-error" role="alert">{importError}</p>}
    </Modal>
    <Confirm open={Boolean(deleteTarget)} onOpenChange={open => { if (!open) setDeleteTarget(null); }} title="移除这个组件？" description="组件对应的照片、孔位与接口开孔会一起移除。你可以使用撤销恢复。" action="移除组件" onConfirm={() => { commit(p => ({ ...p, components: p.components.filter(c => c.id !== deleteTarget), ports: p.ports.filter(port => port.componentId !== deleteTarget) })); setDeleteTarget(null); }} />
    <Confirm open={Boolean(resetMode)} onOpenChange={open => { if (!open) setResetMode(null); }} title={resetMode === 'sample' ? '载入示例项目？' : '新建空白项目？'} description="当前工作区将被替换。建议先备份项目 JSON；替换后也可使用撤销恢复。" action="替换工作区" onConfirm={reset} />
  </div>;
}
