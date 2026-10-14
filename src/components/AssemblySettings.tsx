import type { Enclosure, Part } from '../types';
import { assemblyDefaults } from '../../shared/design.mjs';
import { faceDimensions, isSideMount } from '../lib';
import { NumberField } from './ui';

export default function AssemblySettings({part,enclosure:e,onUpdate}: {part:Part;enclosure:Enclosure;onUpdate:(patch:Partial<Part>)=>void}) {
  const a={...assemblyDefaults,...part};
  const update=(patch:Partial<Part>)=>onUpdate({...patch,verified:false});
  const number=(key:keyof Part,label:string,min:number,max:number)=> <NumberField key={key} label={label} value={Number(a[key])} min={min} max={max} onChange={value=>update({[key]:value})}/>;
  const adhesive=part.mount==='lid' && ['screen','keyboard'].includes(part.kind);
  const cradle=part.mount==='base' && ['battery','module','board'].includes(part.kind);
  const tactile=isSideMount(part.mount) && ['button','switch'].includes(part.kind);
  return <>
    <div className="inspector-section"><h3>固定与装配</h3>
      <label className="field"><span>固定方式</span><select value={part.mountingMethod} onChange={event=>update({mountingMethod:event.target.value as Part['mountingMethod'],supportEnabled:event.target.value==='adhesive',tactileEnabled:false})}>
        <option value="none">不生成固定结构</option><option value="holes">安装孔支撑柱</option>
        {adhesive && <option value="adhesive">上盖内侧粘贴承托台</option>}
        {cradle && <option value="cradle">底壳托架与可拆压条</option>}
      </select></label>
      {part.mountingMethod==='adhesive' && <>
        <label className="review-checkbox"><input type="checkbox" checked={part.supportEnabled} onChange={event=>update({supportEnabled:event.target.checked})}/>生成粘贴承托台</label>
        <div className="grid grid-cols-2 gap-3 mt-3">{number('supportWidth','承托环宽度',1.2,20)}{number('supportHeight','承托厚度',.8,10)}{number('adhesiveClearance','胶层厚度',0,5)}</div>
        <p className="field-hint mt-2">胶粘面位于组件安装基准上方，预留胶层；外圈连接上盖内侧。请实测边框宽度、接触面及胶层。</p>
      </>}
      {part.mountingMethod==='cradle' && <>
        <div className="grid grid-cols-2 gap-3 mt-3">{number('cradleWall','托架壁厚',1.2,5)}{number('clampThickness','压条厚度',1.2,5)}</div>
        <label className="review-checkbox"><input type="checkbox" checked={a.strapSlots} onChange={event=>update({strapSlots:event.target.checked})}/>增加 1.2 × 8 mm 绑带槽</label>
        <p className="field-hint mt-2">托架随实物长宽与 Z 调整；独立压条随打印包导出。先留出螺丝操作及接线空间，电芯须另加绝缘与软垫。</p>
      </>}
      {part.mount==='base' && ['holes','cradle'].includes(part.mountingMethod) && <>
        <label className="field mt-3"><span>支撑柱紧固</span><select value={a.fastenerType} onChange={event=>update({fastenerType:event.target.value as Part['fastenerType']})}><option value="pilot">自攻螺丝导孔</option><option value="heatsetM3">M3 热熔铜螺母盲孔</option></select></label>
        {a.fastenerType==='heatsetM3' && <><div className="grid grid-cols-2 gap-3 mt-3">{number('insertDiameter','安装孔径',3.5,6)}{number('insertDepth','盲孔深度',2,8)}</div><p className="field-hint mt-2">默认孔径 4.2、深度 4 mm 为试打值。请按供应商实物调整，柱壁至少 1.2 mm、盲孔底至少 0.8 mm。</p></>}
      </>}
    </div>
    {tactile && <div className="inspector-section"><h3>轻触按键传动</h3>
      <label className="review-checkbox"><input type="checkbox" checked={a.tactileEnabled} onChange={event=>update({tactileEnabled:event.target.checked,...(event.target.checked?{mountingMethod:'none',openingShape:'circle',openingWidth:a.keyDiameter,openingDepth:a.keyDiameter,mountOffset:faceDimensions(part).thickness-.5}:{})})}/>生成导向筒与独立防脱键帽</label>
      {a.tactileEnabled && <><div className="grid grid-cols-2 gap-3 mt-3">
        <NumberField label="键杆直径" value={a.keyDiameter} min={3} max={12} onChange={value=>update({keyDiameter:value,openingWidth:value,openingDepth:value})}/>
        {number('keyTravel','按压行程',.2,1.5)}{number('keyClearance','每侧配合',.15,.6)}{number('guideLength','导向长度',1.2,6)}{number('keyFlange','防脱肩厚/宽',1,3)}{number('keyProjection','外露长度',.5,3)}
      </div><p className="field-hint mt-2">组件包围尺寸包含开关和运动空间；安装基准是实物开关触点。键帽从壳内装入，由实物开关回弹，须试打并复核行程、按压力及切片支撑。</p></>}
    </div>}
    {part.kind==='speaker' && part.mount!=='base' && <div className="inspector-section"><h3>扬声器防护网</h3><label className="review-checkbox"><input type="checkbox" checked={a.speakerGrille} onChange={event=>{
      const position:Partial<Part>=part.mount==='lid'?{z:e.height-e.lid-e.clearance-part.height}:part.mount==='front'?{y:e.depth-e.wall-e.clearance-part.depth}:part.mount==='back'?{y:e.wall+e.clearance}:part.mount==='left'?{x:e.wall+e.clearance}:{x:e.width-e.wall-e.clearance-part.width};
      update({speakerGrille:event.target.checked,...(event.target.checked?position:{})});
    }}/>在圆形声孔内生成防护网筋</label><p className="field-hint mt-2">启用时将本体前端移至面板内侧并预留间隙；请另行核对扬声器固定方式。</p>
      {a.speakerGrille && <div className="grid grid-cols-2 gap-3 mt-3">{number('grilleBarWidth','网筋宽度',.8,3)}{number('grilleSpacing','净空间距',1,8)}{number('grilleThickness','网筋厚度',.8,3)}</div>}
    </div>}
  </>;
}
