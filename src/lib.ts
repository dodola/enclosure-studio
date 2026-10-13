import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Enclosure, Kind, Part, Project, PhotoSlot } from './types';
import { autoLayoutProject, createComponent, normaliseProject } from '../shared/design.mjs';
export { changeMount, faceDimensions, imagePointToPanel, imageRectToPanel, isSideMount, mountNames, normaliseProject, resizeEnclosure, templates } from '../shared/design.mjs';

export const cn = (...classes: ClassValue[]) => twMerge(clsx(classes));
export const uid = () => crypto.randomUUID();
export const kindNames: Record<Kind, string> = { board: '开发板', screen: '屏幕', keyboard: '键盘', button: '按钮', switch: '开关', encoder: '旋钮 / 编码器', battery: '电池', speaker: '扬声器', module: '扩展模块' };
export const kindColors: Record<Kind, string> = { board: '#537d68', screen: '#394f61', keyboard: '#64748b', button: '#b88543', switch: '#64748b', encoder: '#657e7a', battery: '#627869', speaker: '#5c7482', module: '#748078' };
export const photoNames: Record<PhotoSlot, string> = { top: '正面俯视', bottom: '背面俯视', front: '接口侧面', side: '高度侧面' };

export function fasteningPoints(e: Enclosure) {
  // Same contained 4 mm radius bosses as server/footprint.py.
  const inset = Math.max(6, e.cornerRadius - (e.cornerRadius - 4 - .1) / Math.SQRT2);
  return [[inset, inset], [e.width - inset, inset], [inset, e.depth - inset], [e.width - inset, e.depth - inset]];
}

export function newPart(kind: Kind, project: Project): Part {
  return createComponent(kind, project, { id: uid() });
}

export const sampleProject = (): Project => ({
  version: 1,
  name: '便携开发终端',
  enclosure: { width: 126, depth: 168, height: 38, wall: 2.4, floor: 2.4, lid: 2.4,
    clearance: 0.5, standoffDiameter: 6, screwDiameter: 3.4, pilotDiameter: 2.6, lipHeight: 2.4, cornerRadius: 0, screwHeadDiameter: 6.4, screwHeadDepth: 0, ventilation: true },
  components: [
    { id: 'firefly', kind: 'board', name: 'Firefly 开发板', width: 81, depth: 88, height: 18,
      x: 22.5, y: 77.1, z: 7, mount: 'base', mountOffset: 1.5, openingWidth: 0, openingDepth: 0, openingShape: 'none', openingRadius: 0, verified: false,
      holes: [[4, 4], [77.5, 4], [4, 74], [77.5, 74]].map(([x, y], i) => ({ id: `board-hole-${i}`, x, y, diameter: 3.5, source: 'image', verified: false })),
      photos: { top: { name: '用户提供的尺寸图.png', dataUrl: '/samples/firefly-top.png', corners: [[158 / 1371, 121 / 1313], [1080 / 1371, 121 / 1313], [1080 / 1371, 1128 / 1313], [158 / 1371, 1128 / 1313]] },
        bottom: { name: '接口说明中的背面.png', dataUrl: '/samples/firefly-bottom.png' } } },
    { id: 'display', kind: 'screen', name: '4.3 英寸屏幕 · 示例', width: 80, depth: 52, height: 6,
      x: 23, y: 20, z: 32, mount: 'lid', mountOffset: 3.4, openingWidth: 64, openingDepth: 36, openingShape: 'rect', openingRadius: 0, verified: false, photos: {},
      holes: [[4, 4], [76, 4], [4, 48], [76, 48]].map(([x, y], i) => ({ id: `screen-hole-${i}`, x, y, diameter: 3.2, source: 'template', verified: false })) },
    { id: 'keys', kind: 'keyboard', name: '12 键键盘 · 示例', width: 72, depth: 32, height: 6,
      x: 27, y: 114, z: 33, mount: 'lid', mountOffset: 4.4, openingWidth: 58, openingDepth: 18, openingShape: 'rect', openingRadius: 0, verified: false, photos: {},
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

export const autoLayout = autoLayoutProject;

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
  return normaliseProject(p);
}
