import { useRef } from 'react';
import { kindColors, cn } from '../lib';
import type { Part, Project } from '../types';

function PartDrawing({ part }: { part: Part }) {
  const w = part.width, d = part.depth;
  return <svg viewBox={`0 0 ${w} ${d}`} aria-hidden="true" className="size-full">
    <rect x="0.5" y="0.5" width={w - 1} height={d - 1} rx={part.kind === 'button' ? Math.min(w, d) / 2 : 2} fill={kindColors[part.kind]} stroke="#ffffff" strokeOpacity=".6" strokeWidth=".6" />
    {part.kind === 'board' && <>
      {part.id === 'firefly' ? <image href="/samples/firefly-texture.jpg" x="1" y="1" width={w - 2} height={d - 2} preserveAspectRatio="none" /> : <><rect x={w * .28} y={d * .25} width={w * .42} height={d * .38} rx="1" fill="#263d32" /><path d={`M 5 ${d * .3} H ${w * .25} V ${d * .7} H ${w * .7}`} fill="none" stroke="#adc1b3" strokeWidth=".7" /></>}
    </>}
    {part.kind === 'screen' && <><rect x={(w - part.openingWidth) / 2} y={(d - part.openingDepth) / 2} width={part.openingWidth} height={part.openingDepth} rx="1" fill="#111f2b" /><path d={`M ${w * .28} ${d * .65} L ${w * .38} ${d * .4} L ${w * .5} ${d * .55} L ${w * .65} ${d * .3} L ${w * .74} ${d * .45}`} fill="none" stroke="#91aaa8" strokeWidth="1" /></>}
    {part.kind === 'keyboard' && Array.from({ length: 12 }, (_, i) => <rect key={i} x={(w - part.openingWidth) / 2 + i % 4 * part.openingWidth / 4 + 1} y={(d - part.openingDepth) / 2 + Math.floor(i / 4) * part.openingDepth / 3 + .8} width={part.openingWidth / 4 - 2} height={part.openingDepth / 3 - 1.6} rx="1" fill="#e2e8f0" />)}
    {part.kind === 'button' && <circle cx={w / 2} cy={d / 2} r={part.openingWidth / 2} fill="#d8b77f" stroke="#4d4437" />}
    {part.holes.map(h => <circle key={h.id} cx={h.x} cy={h.y} r={h.diameter / 2} fill="#f8fafc" stroke="#d6b367" strokeWidth="1" />)}
  </svg>;
}

export default function LayoutCanvas({ project, selected, onSelect, onMove, layer }: { project: Project; selected: string; onSelect: (id: string) => void; onMove: (id: string, patch: Partial<Part>) => void; layer: string }) {
  const boardRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const e = project.enclosure;
  return <div className="layout-2d" aria-label="俯视布局，组件可拖动，也可以在右侧输入坐标">
    <div className="plan-frame" style={{ aspectRatio: `${e.width} / ${e.depth}` }}>
      <div className="dimension-x"><span>{e.width.toFixed(1)} mm</span></div><div className="dimension-y"><span>{e.depth.toFixed(1)} mm</span></div>
      <div ref={boardRef} className="plan-body">
        <svg viewBox={`0 0 ${e.width} ${e.depth}`} className="absolute inset-0 size-full" aria-hidden="true">
          <defs><pattern id="plan-grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M 10 0 H 0 V 10" fill="none" stroke="#d6e1e1" strokeWidth=".2" /></pattern></defs>
          <rect x="0" y="0" width={e.width} height={e.depth} rx="3" fill="#ecf1f0" stroke="#869a97" strokeWidth=".8" />
          <rect x={e.wall} y={e.wall} width={e.width - 2 * e.wall} height={e.depth - 2 * e.wall} rx="1" fill="url(#plan-grid)" stroke="#a7b5b3" strokeWidth=".5" />
          {[[6, 6], [e.width - 6, 6], [6, e.depth - 6], [e.width - 6, e.depth - 6]].map(([x, y], i) => <g key={i}><circle cx={x} cy={y} r="4" fill="#d3ddda" stroke="#a5b4b0" strokeWidth=".4" /><circle cx={x} cy={y} r={e.screwDiameter / 2} fill="#f8fafc" /></g>)}
        </svg>
        {project.components.filter(c => layer === 'all' || c.mount === layer).map(c => <button key={c.id} type="button" aria-label={`选择 ${c.name}，位置 X ${c.x.toFixed(1)} Y ${c.y.toFixed(1)} 毫米`} title={`${c.name} · ${c.width} × ${c.depth} mm`}
          className={cn('plan-part', selected === c.id && 'plan-part-selected')}
          style={{ left: `${c.x / e.width * 100}%`, top: `${c.y / e.depth * 100}%`, width: `${c.width / e.width * 100}%`, height: `${c.depth / e.depth * 100}%` }}
          onClick={() => onSelect(c.id)}
          onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: c.id, clientX: event.clientX, clientY: event.clientY, x: c.x, y: c.y }; onSelect(c.id); }}
          onPointerMove={event => { if (!drag.current || drag.current.id !== c.id || !boardRef.current) return; const rect = boardRef.current.getBoundingClientRect(); const origin = drag.current; onMove(c.id, { x: Math.round(Math.max(0, Math.min(e.width - c.width, origin.x + (event.clientX - origin.clientX) / rect.width * e.width)) * 10) / 10, y: Math.round(Math.max(0, Math.min(e.depth - c.depth, origin.y + (event.clientY - origin.clientY) / rect.height * e.depth)) * 10) / 10 }); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          <PartDrawing part={c} /><span className="plan-part-label">{c.kind === 'board' ? '开发板' : c.kind === 'screen' ? '屏幕' : c.kind === 'keyboard' ? '键盘' : '按钮'}</span>
        </button>)}
        {project.ports.map(p => { const c = project.components.find(c => c.id === p.componentId); if (!c) return null; const isHorizontal = p.edge === 'front' || p.edge === 'back'; return <div key={p.id} className="plan-port" title={p.name} style={isHorizontal ? { left: `${(c.x + p.offset - p.width / 2) / e.width * 100}%`, top: p.edge === 'front' ? '98%' : '0%', width: `${p.width / e.width * 100}%`, height: '2%' } : { top: `${(c.y + p.offset - p.width / 2) / e.depth * 100}%`, left: p.edge === 'right' ? '98%' : '0%', height: `${p.width / e.depth * 100}%`, width: '2%' }} />; })}
      </div>
      <span className="origin-label">原点 (0, 0)</span><span className="front-label">接口前侧 ↓</span>
    </div>
  </div>;
}
