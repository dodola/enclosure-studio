import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Kind, Part, Project, PhotoSlot } from './types';

export const cn = (...classes: ClassValue[]) => twMerge(clsx(classes));
export const uid = () => crypto.randomUUID();
export const kindNames: Record<Kind, string> = { board: '开发板', screen: '屏幕', keyboard: '键盘', button: '按钮' };
export const kindColors: Record<Kind, string> = { board: '#537d68', screen: '#394f61', keyboard: '#64748b', button: '#b88543' };
export const photoNames: Record<PhotoSlot, string> = { top: '正面俯视', bottom: '背面俯视', front: '接口侧面', side: '高度侧面' };

export function newPart(kind: Kind, project: Project): Part {
  const templates = {
    board: { width: 60, depth: 40, height: 12, openingWidth: 0, openingDepth: 0 },
    screen: { width: 80, depth: 52, height: 6, openingWidth: 64, openingDepth: 38 },
    keyboard: { width: 72, depth: 32, height: 6, openingWidth: 66, openingDepth: 26 },
    button: { width: 16, depth: 16, height: 12, openingWidth: 12, openingDepth: 12 },
  };
  const e = project.enclosure;
  const spec = templates[kind];
  const projection = kind === 'keyboard' || kind === 'button' ? 1 : 0;
  return { id: uid(), kind, name: `${kindNames[kind]} ${project.components.filter(c => c.kind === kind).length + 1}`,
    ...spec, x: Math.max(e.wall + e.clearance, (e.width - spec.width) / 2),
    y: kind === 'board' ? e.depth - e.wall - e.clearance - spec.depth : 18,
    z: kind === 'board' ? e.floor + 4.6 : e.height + projection - spec.height,
    mount: kind === 'board' ? 'base' : 'lid', mountOffset: kind === 'board' ? 0 : Math.min(spec.height - .5, e.lid + projection + 1), holes: [], verified: false, photos: {} };
}

export const sampleProject = (): Project => ({
  version: 1,
  name: '便携开发终端',
  enclosure: { width: 126, depth: 168, height: 38, wall: 2.4, floor: 2.4, lid: 2.4,
    clearance: 0.5, standoffDiameter: 6, screwDiameter: 3.4, pilotDiameter: 2.6, lipHeight: 2.4, ventilation: true },
  components: [
    { id: 'firefly', kind: 'board', name: 'Firefly 开发板', width: 81, depth: 88, height: 18,
      x: 22.5, y: 77.1, z: 7, mount: 'base', mountOffset: 1.5, openingWidth: 0, openingDepth: 0, verified: false,
      holes: [[4, 4], [77.5, 4], [4, 74], [77.5, 74]].map(([x, y], i) => ({ id: `board-hole-${i}`, x, y, diameter: 3.5, source: 'image', verified: false })),
      photos: { top: { name: '用户提供的尺寸图.png', dataUrl: '/samples/firefly-top.png', corners: [[158 / 1371, 121 / 1313], [1080 / 1371, 121 / 1313], [1080 / 1371, 1128 / 1313], [158 / 1371, 1128 / 1313]] },
        bottom: { name: '接口说明中的背面.png', dataUrl: '/samples/firefly-bottom.png' } } },
    { id: 'display', kind: 'screen', name: '4.3 英寸屏幕 · 示例', width: 80, depth: 52, height: 6,
      x: 23, y: 20, z: 32, mount: 'lid', mountOffset: 3.4, openingWidth: 64, openingDepth: 36, verified: false, photos: {},
      holes: [[4, 4], [76, 4], [4, 48], [76, 48]].map(([x, y], i) => ({ id: `screen-hole-${i}`, x, y, diameter: 3.2, source: 'template', verified: false })) },
    { id: 'keys', kind: 'keyboard', name: '12 键键盘 · 示例', width: 72, depth: 32, height: 6,
      x: 27, y: 114, z: 33, mount: 'lid', mountOffset: 4.4, openingWidth: 58, openingDepth: 18, verified: false, photos: {},
      holes: [[3, 3], [69, 3], [3, 29], [69, 29]].map(([x, y], i) => ({ id: `key-hole-${i}`, x, y, diameter: 3.2, source: 'template', verified: false })) },
  ],
  ports: [
    { id: 'power', componentId: 'firefly', name: 'DC 电源', edge: 'front', offset: 4.5, width: 8, height: 10.5, z: 1.5, verified: false },
    { id: 'ethernet', componentId: 'firefly', name: 'RJ45 网口', edge: 'front', offset: 19, width: 16, height: 13.5, z: 1.5, verified: false },
    { id: 'usb3', componentId: 'firefly', name: 'USB 3.0', edge: 'front', offset: 36.5, width: 13.5, height: 7.5, z: 3, verified: false },
    { id: 'usb2', componentId: 'firefly', name: 'USB 2.0', edge: 'front', offset: 53.5, width: 13.5, height: 7.5, z: 3, verified: false },
    { id: 'usbc', componentId: 'firefly', name: 'USB-C', edge: 'front', offset: 71, width: 9.5, height: 3.5, z: 2, verified: false },
  ],
});

export function autoLayout(project: Project): Project {
  const base = project.components.filter(c => c.mount === 'base');
  const top = project.components.filter(c => c.mount === 'lid');
  const baseWidth = base.reduce((sum, c) => sum + c.width + 12, 12);
  const topDepth = top.reduce((sum, c) => sum + c.depth + 14, 12);
  const width = Math.max(project.enclosure.width, baseWidth, ...top.map(c => c.width + 24));
  const depth = Math.max(project.enclosure.depth, topDepth, ...base.map(c => c.depth + 28));
  const height = Math.max(project.enclosure.height, ...base.map(c => c.height + Math.max(0, ...top.map(c => c.height)) + 14));
  const enclosure = { ...project.enclosure, width: Math.min(450, width), depth: Math.min(450, depth), height: Math.min(180, height) };
  let bx = (enclosure.width - baseWidth + 24) / 2;
  let ty = 12;
  const placements = new Map<string, Partial<Part>>();
  base.forEach(c => { placements.set(c.id, { x: bx, y: enclosure.depth - enclosure.wall - enclosure.clearance - c.depth, z: enclosure.floor + 4.6 }); bx += c.width + 12; });
  top.forEach(c => { placements.set(c.id, { x: (enclosure.width - c.width) / 2, y: ty, z: enclosure.height + (c.kind === 'keyboard' || c.kind === 'button' ? 1 : 0) - c.height }); ty += c.depth + 14; });
  return { ...project, enclosure, components: project.components.map(c => ({ ...c, ...placements.get(c.id) })) };
}

export function geometryPayload(project: Project) {
  return { ...project, components: project.components.map(({ photos: _photos, ...c }) => c) };
}

export async function responseError(response: Response) {
  const data = await response.json().catch(() => ({}));
  return typeof data.detail === 'string' ? data.detail : '请求未完成，请检查尺寸或服务状态。';
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function compressPhoto(file: File): Promise<string> {
  if (file.size > 12 * 1024 * 1024) throw new Error('图片不能超过 12 MB。');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d')!; context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.92);
}

export async function validateImport(value: unknown): Promise<Project> {
  const p = value as Project;
  if (!p || p.version !== 1 || !Array.isArray(p.components) || !p.enclosure || !Array.isArray(p.ports)) throw new Error('不是有效的壳研项目文件。');
  const response = await fetch('/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  if (!response.ok) throw new Error('项目尺寸或字段无效，请检查 JSON 文件。');
  return { version: 1, name: p.name, enclosure: p.enclosure, ports: p.ports, components: p.components.map(c => ({ ...c, mountOffset: c.mountOffset || 0, photos: c.photos || {} })) };
}
