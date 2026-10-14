import { Plus, Trash2 } from 'lucide-react';
import type { Keepout, Project } from '../types';
import { uid } from '../lib';
import { NumberField } from './ui';

export default function KeepoutsPanel({project,onChange}: {project:Project;onChange:(value:Keepout[])=>void}) {
  const items=project.keepouts || [];
  const patch=(id:string,value:Partial<Keepout>)=>onChange(items.map(k=>k.id===id?{...k,...value,verified:'verified' in value?Boolean(value.verified):false}:k));
  return <div className="card mt-5"><div className="card-header"><strong>插拔与线缆保留区</strong><button className="button button-small" disabled={items.length>=50} onClick={()=>onChange([...items,{id:uid(),name:'线缆留空',purpose:'cable',x:10,y:10,z:10,width:10,depth:10,height:5,verified:false}])}><Plus size={14} aria-hidden="true"/>添加保留区</button></div>
    <p className="px-4 pt-3 text-xs leading-5 text-slate-500">保留区用于检查插头、线缆弯曲和拆卸路径，不会挖空外壳。关联组件本体可进入该区，其余组件和固定结构须避让；组件拆卸按已拆上盖及所属压条的状态检查。</p>
    {!items.length && <p className="p-4 text-sm text-slate-500">点击“添加保留区”，为实测的接线与插拔空间留空。</p>}
    {items.map(k=><details key={k.id} className="m-4 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-medium">{k.name} · {k.verified?'已复核':'待实测'}</summary><div className="grid grid-cols-2 gap-3 mt-3">
      <label className="field"><span>保留区名称</span><input maxLength={120} value={k.name} onChange={event=>patch(k.id,{name:event.target.value})}/></label>
      <label className="field"><span>用途</span><select value={k.purpose} onChange={event=>patch(k.id,{purpose:event.target.value as Keepout['purpose']})}><option value="cable">线缆弯曲</option><option value="plug">插头插拔</option><option value="removal">组件拆卸</option></select></label>
      <label className="field col-span-2"><span>关联组件</span><select value={k.componentId || ''} onChange={event=>patch(k.id,{componentId:event.target.value || null})}><option value="">无 · 独立空间</option>{project.components.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      {(['x','y','z','width','depth','height'] as const).map(key=><NumberField key={key} label={{x:'起点 X',y:'起点 Y',z:'起点 Z',width:'宽度 X',depth:'长度 Y',height:'高度 Z'}[key]} value={k[key]} min={['x','y','z'].includes(key)?-100:.1} max={500} onChange={value=>patch(k.id,{[key]:value})}/>)}
    </div><div className="mt-3 flex items-center justify-between"><label className="review-checkbox"><input type="checkbox" checked={k.verified} onChange={event=>patch(k.id,{verified:event.target.checked})}/>已实测路径与弯曲空间</label><button className="icon-button" aria-label={`移除保留区${k.name}`} onClick={()=>onChange(items.filter(item=>item.id!==k.id))}><Trash2 size={15} aria-hidden="true"/></button></div></details>)}
  </div>;
}
