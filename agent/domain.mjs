import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { Check } from 'typebox/value';

const object = properties => Type.Object(properties, { additionalProperties: false });
const number = Type.Number({ minimum: 0, maximum: 500 });
const text = Type.String({ minLength: 1, maxLength: 120 });
const optional = properties => Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, Type.Optional(v)]));
const edge = Type.Union(['front', 'back', 'left', 'right'].map(Type.Literal));
const kind = Type.Union(['board', 'screen', 'keyboard', 'button'].map(Type.Literal));
const hole = object({ x: number, y: number, diameter: Type.Number({ exclusiveMinimum: 0, maximum: 20 }) });
const partFields = { name: text, kind, width: number, depth: number, height: number, x: number, y: number, z: number,
  mount: Type.Union([Type.Literal('base'), Type.Literal('lid')]), mountOffset: number,
  openingWidth: number, openingDepth: number, openingX: number, openingY: number,
  holes: Type.Array(hole, { maxItems: 40 }) };
const portFields = { name: text, componentId: text, edge, offset: number, width: number, height: number, z: number };
const shellFields = Object.fromEntries(['width', 'depth', 'height', 'wall', 'floor', 'lid', 'clearance', 'standoffDiameter', 'screwDiameter', 'pilotDiameter', 'lipHeight'].map(k => [k, number]));
shellFields.cornerRadius = Type.Number({ minimum: 0, maximum: 225, description: '外壳沿高度方向的四角半径(mm)，0为直角，不超过min(width,depth)/2；内腔、定位边和角部螺丝柱自动跟随。' });
shellFields.ventilation = Type.Boolean();

export const editSchema = object({
  reason: text,
  enclosure: Type.Optional(object(optional(shellFields))),
  components: Type.Optional(Type.Array(object({ id: text, patch: object(optional(partFields)) }), { maxItems: 30 })),
  ports: Type.Optional(Type.Array(object({ id: text, patch: object(optional(portFields)) }), { maxItems: 50 })),
  addComponents: Type.Optional(Type.Array(object(partFieldsWithoutOpeningOffsets()), { maxItems: 10 })),
  addPorts: Type.Optional(Type.Array(object(portFields), { maxItems: 20 })),
  removeComponentIds: Type.Optional(Type.Array(text, { maxItems: 30 })),
  removePortIds: Type.Optional(Type.Array(text, { maxItems: 50 })),
});
function partFieldsWithoutOpeningOffsets() { return { ...partFields, openingX: Type.Optional(number), openingY: Type.Optional(number) }; }

export const annotationSchema = object({
  corners: Type.Optional(Type.Array(Type.Array(Type.Number({ minimum: 0, maximum: 1 }), { minItems: 2, maxItems: 2 }), { minItems: 4, maxItems: 4 })),
  features: Type.Array(object({
    kind: Type.Union(['hole', 'opening', 'connector', 'obstruction'].map(Type.Literal)),
    label: text,
    bbox: Type.Array(Type.Number({ minimum: 0, maximum: 1 }), { minItems: 4, maxItems: 4, description: '[left, top, width, height] normalized to supplied image' }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    note: Type.String({ maxLength: 500 }),
    edge: Type.Optional(edge),
  }), { maxItems: 60 }),
  warnings: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 15 }),
});

export function stripPhotos(project) {
  return { ...project, enclosure: { ...project.enclosure, cornerRadius: project.enclosure.cornerRadius ?? 0 }, components: project.components.map(({ photos: _photos, ...c }) => c) };
}

export function applyEdits(project, input) {
  if (!Check(editSchema, input)) throw new Error('工具参数不符合设计字段约束。');
  const next = structuredClone(project);
  const find = (items, id) => { const item = items.find(c => c.id === id); if (!item) throw new Error(`不存在的 ID：${id}`); return item; };
  if (input.enclosure) {
    const dz = (input.enclosure.height ?? next.enclosure.height) - next.enclosure.height;
    Object.assign(next.enclosure, input.enclosure);
    next.components.filter(c => c.mount === 'lid').forEach(c => { c.z = +(c.z + dz).toFixed(3); });
  }
  for (const { id, patch } of input.components ?? []) {
    const c = find(next.components, id);
    const measured = ['kind', 'width', 'depth', 'height', 'mount', 'mountOffset', 'openingWidth', 'openingDepth', 'openingX', 'openingY', 'holes'].some(k => k in patch);
    Object.assign(c, patch);
    if (patch.holes) c.holes = patch.holes.map(h => ({ ...h, id: randomUUID(), source: 'pi-agent', verified: false }));
    if (measured) c.verified = false;
  }
  for (const { id, patch } of input.ports ?? []) Object.assign(find(next.ports, id), patch, { verified: false });
  for (const c of input.addComponents ?? []) next.components.push({ ...c, id: randomUUID(), verified: false, holes: c.holes.map(h => ({ ...h, id: randomUUID(), source: 'pi-agent', verified: false })) });
  for (const p of input.addPorts ?? []) next.ports.push({ ...p, id: randomUUID(), verified: false });
  for (const id of input.removeComponentIds ?? []) {
    find(next.components, id);
    next.components = next.components.filter(c => c.id !== id);
    next.ports = next.ports.filter(p => p.componentId !== id);
  }
  for (const id of input.removePortIds ?? []) { find(next.ports, id); next.ports = next.ports.filter(p => p.id !== id); }
  return next;
}

export function autoLayout(project) {
  const next = structuredClone(project), e = next.enclosure;
  const base = next.components.filter(c => c.mount === 'base'), top = next.components.filter(c => c.mount === 'lid');
  const baseWidth = base.reduce((sum, c) => sum + c.width + 12, 12);
  e.width = Math.min(450, Math.max(e.width, baseWidth, ...top.map(c => c.width + 24)));
  e.depth = Math.min(450, Math.max(e.depth, top.reduce((sum, c) => sum + c.depth + 14, 12), ...base.map(c => c.depth + 28)));
  e.height = Math.min(180, Math.max(e.height, ...base.map(c => c.height + Math.max(0, ...top.map(c => c.height)) + 14)));
  let bx = (e.width - baseWidth + 24) / 2, ty = 12;
  base.forEach(c => { c.x = bx; c.y = e.depth - e.wall - e.clearance - c.depth; c.z = e.floor + 4.6; bx += c.width + 12; });
  top.forEach(c => { c.x = (e.width - c.width) / 2; c.y = ty; c.z = e.height + (['keyboard', 'button'].includes(c.kind) ? 1 : 0) - c.height; ty += c.depth + 14; });
  return next;
}

export function normaliseAnnotations(input, context) {
  if (!Check(annotationSchema, input)) throw new Error('AI 标注格式无效，请重新标注。');
  const round = n => +n.toFixed(2);
  return { ...input, calibrated: context.calibrated, width: context.width, depth: context.depth,
    slot: context.slot, provider: context.provider, model: context.model, createdAt: new Date().toISOString(),
    features: input.features.map(f => {
      const [x, y, w, h] = f.bbox;
      if (w <= 0 || h <= 0 || x + w > 1.001 || y + h > 1.001) throw new Error('AI 标注范围超出图片，请重新标注。');
      // Physical coordinates are derived only from a rectified, scaled plane image.
      const measurement = context.calibrated ? { x: round(x * context.width), y: round(y * context.depth),
        width: round(w * context.width), depth: round(h * context.depth),
        ...(f.kind === 'hole' ? { x: round((x + w / 2) * context.width), y: round((y + h / 2) * context.depth), diameter: round(Math.min(w * context.width, h * context.depth)) } : {}) } : undefined;
      return { ...f, id: randomUUID(), measurement };
    }),
  };
}

export function createDesignTools(state, geometry) {
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: {} });
  const stage = async (next, reason, signal) => {
    const checked = await geometry('/api/validate', next, signal);
    if (checked.issues.some(i => i.severity === 'error')) return result({ applied: false, issues: checked.issues, instruction: '本次修改被拒绝，当前设计未变。请把关联修改放在一次 edit_design 调用中，修正后重试。' });
    await geometry('/api/preview', next, signal);
    if (signal?.aborted) throw new Error('已停止修改。');
    state.project = next; state.changes.push(reason);
    return result({ applied: true, reason, issues: checked.issues, project: next });
  };
  return [
    { name: 'inspect_design', label: '检查当前设计', description: '读取权威的当前项目（mm）和几何检查问题。', parameters: object({}),
      execute: async (_id, _args, signal) => result({ project: state.project, ...await geometry('/api/validate', state.project, signal) }) },
    { name: 'edit_design', label: '修改外壳与组件', description: '原子修改外壳、组件、安装孔和接口，可添加或删除。省略字段保留。只接受通过几何检查的设计。外壳高度变化自动同步上盖组件 Z。不得设置 verified。', parameters: editSchema, executionMode: 'sequential',
      execute: async (_id, args, signal) => stage(applyEdits(state.project, args), args.reason, signal) },
    { name: 'auto_layout', label: '自动排布组件', description: '按底壳/上盖分层保守排布并扩大外壳，几何检查通过后应用。', parameters: object({}), executionMode: 'sequential',
      execute: async (_id, _args, signal) => stage(autoLayout(state.project), '自动排布组件并适配外壳', signal) },
  ];
}
