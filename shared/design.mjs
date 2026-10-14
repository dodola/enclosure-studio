import templates from './component-templates.json' with { type: 'json' };

export { templates };
export const mountNames = { base: '底壳', lid: '上盖', front: '前侧', back: '后侧', left: '左侧', right: '右侧' };
export const isSideMount = mount => ['front', 'back', 'left', 'right'].includes(mount);
export const assemblyDefaults = { cradleWall: 2, clampThickness: 2.4, strapSlots: false,
  fastenerType: 'pilot', insertDiameter: 4.2, insertDepth: 4, speakerGrille: false,
  grilleBarWidth: 1.2, grilleSpacing: 3, grilleThickness: 1.2, tactileEnabled: false,
  keyDiameter: 6, keyTravel: .6, keyClearance: .25, keyFlange: 1.5, keyProjection: 1.2, guideLength: 3 };
export function faceDimensions(c) {
  if (['front', 'back'].includes(c.mount)) return { u: c.width, v: c.height, thickness: c.depth };
  if (['left', 'right'].includes(c.mount)) return { u: c.depth, v: c.height, thickness: c.width };
  return { u: c.width, v: c.depth, thickness: c.height };
}
export function imagePointToPanel(c, x, y) {
  return { x, y: isSideMount(c.mount) ? +(faceDimensions(c).v - y).toFixed(3) : y };
}
export function imageRectToPanel(c, x, y, width, height) {
  return { x, y: isSideMount(c.mount) ? +(faceDimensions(c).v - y - height).toFixed(3) : y, width, height };
}
const worldDimensions = (u, v, thickness, mount) => ['front', 'back'].includes(mount)
  ? { width: u, depth: thickness, height: v }
  : ['left', 'right'].includes(mount) ? { width: thickness, depth: u, height: v }
  : { width: u, depth: v, height: thickness };

export function normaliseProject(project) {
  return { ...project, keepouts: project.keepouts || [], enclosure: { screwHeadDiameter: 6.4, screwHeadDepth: 0, ...project.enclosure, cornerRadius: project.enclosure.cornerRadius ?? 0 },
    components: project.components.map(c => ({ ...assemblyDefaults, ...c, holes: (c.holes || []).map(h => ({source:'manual',verified:false,...h})), mountOffset: c.mountOffset || 0, openingRadius: c.openingRadius ?? 0,
      openingShape: c.openingShape ?? (['button', 'encoder', 'speaker'].includes(c.kind) ? 'circle' : ['board', 'battery', 'module'].includes(c.kind) ? 'none' : 'rect'),
      mountingMethod: c.mountingMethod ?? (['screen', 'keyboard'].includes(c.kind) && c.mount === 'lid' && !c.holes?.length ? 'adhesive' : c.holes?.length ? 'holes' : 'none'),
      supportEnabled: c.supportEnabled ?? ((c.mountingMethod ?? (['screen', 'keyboard'].includes(c.kind) && c.mount === 'lid' && !c.holes?.length ? 'adhesive' : 'none')) === 'adhesive'),
      supportWidth: c.supportWidth ?? 3, supportHeight: c.supportHeight ?? 1.2, adhesiveClearance: c.adhesiveClearance ?? 0.3,
      photos: c.photos || {} })) };
}

export function changeMount(c, mount, e) {
  const { u, v, thickness } = faceDimensions(c), dims = worldDimensions(u, v, thickness, mount);
  const panel = c.openingShape !== 'none';
  const projection = c.speakerGrille ? -(e.wall+e.clearance) : panel ? 1 : 0;
  const x = Math.max(e.wall + e.clearance, (e.width - dims.width) / 2);
  const y = Math.max(e.wall + e.clearance, (e.depth - dims.depth) / 2);
  const z = Math.max(e.floor + e.clearance, (e.height - e.lid - dims.height) / 2);
  const mountOffset = mount === 'base' ? 0 : Math.max(0, Math.min(thickness - .5, (isSideMount(mount) ? e.wall : e.lid) + projection + 1));
  return { ...dims, mount, mountOffset, verified: false,
    ...(mount!=='lid' && c.mountingMethod==='adhesive' || mount!=='base' && c.mountingMethod==='cradle' ? {mountingMethod:'none',supportEnabled:false} : {}),
    ...(mount!=='base' ? {fastenerType:'pilot'} : {}),
    ...(!isSideMount(mount) ? {tactileEnabled:false} : {}),
    ...(mount==='base'?{speakerGrille:false}:{}),
    x: mount === 'left' ? -projection : mount === 'right' ? e.width + projection - dims.width : x,
    y: mount === 'back' ? -projection : mount === 'front' ? e.depth + projection - dims.depth : y,
    z: mount === 'base' ? e.floor + 4.6 : mount === 'lid' ? (c.speakerGrille?e.height-e.lid-e.clearance:panel ? e.height + projection : e.height - e.lid - 1) - dims.height : z };
}

export function createComponent(templateId, project, options = {}) {
  const t = templates.find(t => t.id === templateId);
  if (!t) throw new Error('不存在的组件模板。');
  const c = { ...assemblyDefaults, id: options.id, kind: t.id, name: `${t.name} ${project.components.filter(c => c.kind === t.id).length + 1} · 示例`,
    width: options.faceWidth ?? t.u, depth: options.faceHeight ?? t.v, height: options.thickness ?? t.thickness, mount: 'lid',
    openingShape: t.openingShape, openingWidth: t.openingWidth, openingDepth: t.openingDepth, openingRadius: t.openingRadius,
    mountingMethod: t.mountingMethod ?? (t.id === 'screen' || t.id === 'keyboard' ? 'adhesive' : 'none'),
    supportEnabled: t.supportEnabled ?? (t.id === 'screen' || t.id === 'keyboard'), supportWidth: t.supportWidth ?? 3,
    supportHeight: t.supportHeight ?? 1.2, adhesiveClearance: t.adhesiveClearance ?? 0.3,
    holes: [], photos: {}, verified: false };
  const { faceWidth: _u, faceHeight: _v, thickness: _t, ...patch } = options;
  return { ...c, ...changeMount({...c,speakerGrille:options.speakerGrille ?? false}, options.mount || t.mount, project.enclosure), ...patch, verified: false };
}

export function resizeEnclosure(project, patch) {
  const enclosure = { ...project.enclosure, ...patch };
  const dx = enclosure.width - project.enclosure.width, dy = enclosure.depth - project.enclosure.depth, dz = enclosure.height - project.enclosure.height;
  return { ...project, enclosure, keepouts: (project.keepouts || []).map(k => {
    const owner=project.components.find(c=>c.id===k.componentId);
    return {...k,x:k.x+(owner?.mount==='right'?dx:0),y:k.y+(owner?.mount==='front'?dy:0),z:k.z+(owner?.mount==='lid'?dz:0)};
  }), components: project.components.map(c => ({ ...c,
    x: c.mount === 'right' ? +(c.x + dx).toFixed(3) : c.x,
    y: c.mount === 'front' ? +(c.y + dy).toFixed(3) : c.y,
    z: c.mount === 'lid' ? +(c.z + dz).toFixed(3) : c.z })) };
}

export function patchComponent(project, id, patch) {
  const original=project.components.find(c=>c.id===id);
  if (!original) throw new Error(`不存在的组件：${id}`);
  const next={...original,...(patch.mount && patch.mount!==original.mount?changeMount(original,patch.mount,project.enclosure):{}),...patch};
  if (patch.holes?.length && original.mountingMethod==='none' && patch.mountingMethod===undefined && !next.tactileEnabled) next.mountingMethod='holes';
  return {...project,components:project.components.map(c=>c.id===id?next:c),keepouts:(project.keepouts || []).map(k=>k.componentId===id?{...k,x:k.x+next.x-original.x,y:k.y+next.y-original.y,z:k.z+next.z-original.z}:k)};
}

export function autoLayoutProject(project) {
  const base = project.components.filter(c => c.mount === 'base'), top = project.components.filter(c => c.mount === 'lid');
  const e = project.enclosure;
  const padding=c=>c.mountingMethod==='cradle'?e.clearance+(c.cradleWall || 2)+Math.max(8,(c.insertDiameter || 4.2)+2.4):0;
  const baseWidth = base.reduce((sum, c) => sum + c.width + 2*padding(c) + 12, 12);
  let next = resizeEnclosure(project, {
    width: Math.min(450, Math.max(e.width, baseWidth, ...top.map(c => c.width + 24))),
    depth: Math.min(450, Math.max(e.depth, top.reduce((sum, c) => sum + c.depth + 14, 12), ...base.map(c => c.depth + 28))),
    height: Math.min(180, Math.max(e.height, ...base.map(c => c.height + Math.max(0, ...top.map(c => c.height)) + 14))) });
  let bx = (next.enclosure.width - baseWidth + 24) / 2, ty = 12;
  for (const c of next.components) {
    if (c.mount === 'base') {
      const pad=padding(c);
      next=patchComponent(next,c.id,{x:bx+pad,y:next.enclosure.depth-e.wall-e.clearance-c.depth-(c.mountingMethod==='cradle'?e.clearance+(c.cradleWall || 2):0),z:e.floor+4.6});
      bx += c.width+2*pad+12;
    }
    if (c.mount === 'lid') {
      next=patchComponent(next,c.id,{x:(next.enclosure.width-c.width)/2,y:ty,z:(c.speakerGrille?next.enclosure.height-e.lid-e.clearance:c.openingShape!=='none'?next.enclosure.height+1:next.enclosure.height-e.lid-1)-c.height});
      ty+=c.depth+14;
    }
  }
  return next;
}
