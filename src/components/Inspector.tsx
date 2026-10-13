import { Plus, Trash2, Crosshair, CircuitBoard, Monitor, Keyboard, CircleDot, Move, ChevronDown } from 'lucide-react';
import { kindNames, uid } from '../lib';
import type { Part, Port, Project, Issue, Step } from '../types';
import { Badge, NumberField, Note } from './ui';

export const partIcons = { board: CircuitBoard, screen: Monitor, keyboard: Keyboard, button: CircleDot };
export function Inspector({ project, part, step, issues, onUpdate, onPortUpdate, onPortAdd, onPortDelete, onDelete, onPhoto }: {
  project: Project; part?: Part; step: Step; issues: Issue[]; onUpdate: (patch: Partial<Part>) => void;
  onPortUpdate: (id: string, patch: Partial<Port>) => void; onPortAdd: (port: Port) => void;
  onPortDelete: (id: string) => void; onDelete: () => void; onPhoto: () => void;
}) {
  const e = project.enclosure;
  if (step === 'shell' || step === 'export') return <aside className="inspector"><div className="inspector-heading"><span>设计检查</span><Badge tone={issues.some(i => i.severity === 'error') ? 'warning' : 'success'}>{issues.some(i => i.severity === 'error') ? '需调整' : '几何通过'}</Badge></div>
    <div className="inspector-section"><h3>外壳规格</h3><dl className="spec-list"><div><dt>外部尺寸</dt><dd>{e.width} × {e.depth} × {e.height}</dd></div><div><dt>侧壁厚度</dt><dd>{e.wall} mm</dd></div><div><dt>装配间隙</dt><dd>{e.clearance} mm / 侧</dd></div><div><dt>固定方式</dt><dd>四角螺丝 · 两片式</dd></div><div><dt>组件数量</dt><dd>{project.components.length} 个</dd></div><div><dt>接口开孔</dt><dd>{project.ports.length} 个</dd></div></dl></div>
    <div className="inspector-section"><h3>复核事项 <span className="text-slate-400">{issues.length}</span></h3><Issues issues={issues} /></div>
    <div className="inspector-section"><h3>建议先试打印</h3><p className="text-xs leading-6 text-slate-500">孔位小样可验证安装孔距离。正式打印前，还需核对插头空间、线缆弯曲半径和散热器高度。</p></div>
  </aside>;
  if (!part) return <aside className="inspector"><div className="inspector-heading">组件属性</div><div className="p-6 text-sm text-slate-500">选择一个组件，查看并编辑尺寸。</div></aside>;
  const Icon = partIcons[part.kind];
  const updateDimension = (patch: Partial<Part>) => onUpdate({ ...patch, verified: false });
  const ports = project.ports.filter(p => p.componentId === part.id);
  return <aside className="inspector">
    <div className="inspector-heading"><span>组件属性</span><button className="icon-button" aria-label={`删除${part.name}`} onClick={onDelete}><Trash2 size={15} /></button></div>
    <div className="inspector-section"><div className="flex items-center gap-3"><span className="part-icon"><Icon size={20} /></span><div><strong className="text-sm">{kindNames[part.kind]}</strong><div className="mt-1"><Badge tone={part.verified ? 'success' : 'warning'}>{part.verified ? '已实测复核' : '尺寸待复核'}</Badge></div></div></div>
      <label className="field mt-4"><span>组件名称</span><input value={part.name} maxLength={120} onChange={event => onUpdate({ name: event.target.value })} /></label>
    </div>
    <div className="inspector-section"><h3>外形尺寸 <span>mm</span></h3><div className="grid grid-cols-3 gap-2"><NumberField label="宽 X" value={part.width} min={3} max={400} unit="" onChange={width => updateDimension({ width, holes: part.holes.map(h => ({ ...h, verified: false })) })} /><NumberField label="长 Y" value={part.depth} min={3} max={400} unit="" onChange={depth => updateDimension({ depth, holes: part.holes.map(h => ({ ...h, verified: false })) })} /><NumberField label="总高 Z" value={part.height} min={.5} max={150} unit="" onChange={height => updateDimension({ height })} /></div>
      <p className="field-hint mt-3">包含上下突出元件。板件长宽需与校准轮廓对应。</p>
      <label className="review-checkbox"><input type="checkbox" checked={part.verified} onChange={event => onUpdate({ verified: event.target.checked, holes: part.holes.map(h => ({ ...h, verified: event.target.checked })) })} />我已实测外形、高度和孔位</label>
    </div>
    <div className="inspector-section"><h3><Move size={14} />安装位置</h3><label className="field mb-3"><span>安装在</span><div className="select-wrap"><select value={part.mount} onChange={event => { const mount = event.target.value as 'base' | 'lid'; const projection = part.kind === 'keyboard' || part.kind === 'button' ? 1 : 0; onUpdate({ mount, z: mount === 'base' ? e.floor + 4.6 : e.height + projection - part.height, mountOffset: mount === 'base' ? 0 : Math.min(part.height - .5, e.lid + projection + 1) }); }}><option value="base">底壳 · 开发板层</option><option value="lid">上盖 · 面板层</option></select><ChevronDown size={14} /></div></label>
      <div className="grid grid-cols-3 gap-2"><NumberField label="位置 X" value={part.x} max={500} unit="" onChange={x => onUpdate({ x })} /><NumberField label="位置 Y" value={part.y} max={500} unit="" onChange={y => onUpdate({ y })} /><NumberField label="底面 Z" value={part.z} max={200} unit="" onChange={z => onUpdate({ z })} /></div>
      <p className="field-hint mt-2">X / Y 从壳体左上角计；Z 从壳体外底面计。</p>
      <div className="mt-3"><NumberField label="安装基准偏移" value={part.mountOffset} max={part.height} onChange={mountOffset => updateDimension({ mountOffset })} description={part.mount === 'base' ? '组件最低点到 PCB 支撑面的高度，决定支撑柱顶面。' : '组件最高点向下到安装基准的距离，决定上盖支撑柱。'} /></div>
      {ports.length > 0 && <button className="button button-small mt-3 w-full" onClick={() => { const edge = ports[0].edge; onUpdate(edge === 'front' ? { y: e.depth - e.wall - e.clearance - part.depth } : edge === 'back' ? { y: e.wall + e.clearance } : edge === 'left' ? { x: e.wall + e.clearance } : { x: e.width - e.wall - e.clearance - part.width }); }}><Crosshair size={14} />贴近接口所在侧壁</button>}
    </div>
    {part.mount === 'lid' && part.kind !== 'board' && <div className="inspector-section"><h3>上盖开口</h3><div className="grid grid-cols-2 gap-3"><NumberField label={part.kind === 'button' ? '开孔直径' : '开口宽度'} value={part.openingWidth} min={1} max={part.width} onChange={openingWidth => updateDimension({ openingWidth, ...(part.kind === 'button' ? { openingDepth: openingWidth } : {}) })} />{part.kind !== 'button' && <NumberField label="开口长度" value={part.openingDepth} min={1} max={part.depth} onChange={openingDepth => updateDimension({ openingDepth })} />}</div><div className="grid grid-cols-2 gap-3 mt-3"><NumberField label="开口左上 X" value={part.openingX ?? (part.width - part.openingWidth) / 2} max={part.width} onChange={openingX => updateDimension({ openingX })} /><NumberField label="开口左上 Y" value={part.openingY ?? (part.depth - part.openingDepth) / 2} max={part.depth} onChange={openingY => updateDimension({ openingY })} /></div><p className="field-hint mt-2">屏幕填写可视区域；键盘填写露出的按键区域。开口自动增加装配间隙。</p></div>}
    <div className="inspector-section"><h3>安装孔位 <button className="icon-button" aria-label="添加安装孔" onClick={() => onUpdate({ holes: [...part.holes, { id: uid(), x: 4, y: 4, diameter: 3.5, source: 'manual', verified: false }], verified: false })}><Plus size={15} /></button></h3>
      {part.holes.length === 0 && <p className="field-hint">上传照片识别孔位，或点击 + 手动添加。</p>}
      <div className="hole-editor">{part.holes.map((hole, i) => <div key={hole.id} className="hole-row"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium">孔 {i + 1} <span className="font-normal text-slate-400">{hole.source.startsWith('pi') ? 'AI 估算' : hole.source === 'image' ? '图片估算' : hole.source === 'template' ? '示例值' : '手动录入'}</span></span><button className="icon-button" aria-label={`删除孔 ${i + 1}`} onClick={() => onUpdate({ holes: part.holes.filter(h => h.id !== hole.id), verified: false })}><XIcon /></button></div><div className="grid grid-cols-3 gap-2">{(['x', 'y', 'diameter'] as const).map(field => <NumberField key={field} label={field === 'diameter' ? '直径' : field.toUpperCase()} value={hole[field]} min={field === 'diameter' ? 1 : 0} max={field === 'x' ? part.width : field === 'y' ? part.depth : 20} unit="" onChange={n => onUpdate({ holes: part.holes.map(h => h.id === hole.id ? { ...h, [field]: n, source: 'manual', verified: false } : h), verified: false })} />)}</div></div>)}</div>
    </div>
    {part.kind === 'board' && <div className="inspector-section"><h3>接口开孔 <button className="icon-button" aria-label="添加接口开孔" onClick={() => onPortAdd({ id: uid(), componentId: part.id, name: '新接口', edge: 'front', offset: part.width / 2, width: 10, height: 6, z: 2, verified: false })}><Plus size={15} /></button></h3>
      {!ports.length && <p className="field-hint">按需添加需要露出的接口。只会在所选侧壁生成开孔。</p>}
      {ports.map(port => <details key={port.id} className="port-editor"><summary><span>{port.name}</span><Badge tone={port.verified ? 'success' : 'warning'}>{port.verified ? '已复核' : '待复核'}</Badge></summary><div className="space-y-3 pt-3"><label className="field"><span>接口名称</span><input value={port.name} onChange={event => onPortUpdate(port.id, { name: event.target.value })} /></label><label className="field"><span>外壳侧壁</span><select value={port.edge} onChange={event => onPortUpdate(port.id, { edge: event.target.value as Port['edge'], verified: false })}><option value="front">前侧 Y 最大</option><option value="back">后侧 Y = 0</option><option value="left">左侧 X = 0</option><option value="right">右侧 X 最大</option></select></label><div className="grid grid-cols-2 gap-2"><NumberField label="中心沿边位置" value={port.offset} max={400} onChange={offset => onPortUpdate(port.id, { offset, verified: false })} /><NumberField label="离组件底面" value={port.z} max={150} onChange={z => onPortUpdate(port.id, { z, verified: false })} /><NumberField label="开孔宽" value={port.width} min={1} max={200} onChange={width => onPortUpdate(port.id, { width, verified: false })} /><NumberField label="开孔高" value={port.height} min={1} max={100} onChange={height => onPortUpdate(port.id, { height, verified: false })} /></div><label className="review-checkbox"><input type="checkbox" checked={port.verified} onChange={event => onPortUpdate(port.id, { verified: event.target.checked })} />已核对接口高度及插头空间</label><button className="button button-small w-full" onClick={() => onPortDelete(port.id)}><Trash2 size={13} />移除此开孔</button></div></details>)}
    </div>}
    <div className="inspector-section"><h3>当前组件检查</h3><Issues issues={issues.filter(i => i.componentId === part.id)} /><button className="button button-small mt-3 w-full" onClick={onPhoto}>补充照片与测量</button></div>
  </aside>;
}

function XIcon() { return <Trash2 size={12} />; }
export function Issues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return <Note>当前没有待处理的几何或尺寸复核事项。</Note>;
  return <ul className="issue-list">{issues.map((i, n) => <li key={`${i.code}-${n}`} className={i.severity === 'error' ? 'issue-error' : ''}><span className="issue-dot" /><p>{i.message}</p></li>)}</ul>;
}
