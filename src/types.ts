export type Kind = 'board' | 'screen' | 'keyboard' | 'button';
export type Step = 'components' | 'photos' | 'layout' | 'shell' | 'export' | 'agent';
export type PhotoSlot = 'top' | 'bottom' | 'front' | 'side';
export interface Hole { id: string; x: number; y: number; diameter: number; source: string; verified: boolean }
export interface Analysis {
  corners: number[][]; holes: Hole[]; rectifiedImage: string; method: string;
  needsReview: boolean; note: string; width: number; depth: number;
}
export interface Photo { name: string; dataUrl: string; corners?: number[][]; analysis?: Analysis; ai?: AIAnnotation }
export interface Part {
  id: string; kind: Kind; name: string; width: number; depth: number; height: number;
  x: number; y: number; z: number; mount: 'base' | 'lid';
  mountOffset: number;
  openingWidth: number; openingDepth: number; openingX?: number | null; openingY?: number | null; holes: Hole[]; verified: boolean;
  photos: Partial<Record<PhotoSlot, Photo>>;
}
export interface Port {
  id: string; componentId: string; name: string; edge: 'front' | 'back' | 'left' | 'right';
  offset: number; width: number; height: number; z: number; verified: boolean;
}
export interface Enclosure {
  width: number; depth: number; height: number; wall: number; floor: number; lid: number;
  clearance: number; standoffDiameter: number; screwDiameter: number;
  pilotDiameter: number; lipHeight: number; cornerRadius: number; ventilation: boolean;
}
export interface Project { version: 1; name: string; components: Part[]; ports: Port[]; enclosure: Enclosure }
export interface Issue { code: string; message: string; severity: 'error' | 'warning'; componentId?: string }
export interface MeshData { vertices: number[]; indices: number[]; volume: number; triangles: number; watertight: boolean }
export interface Preview { base: MeshData; lid: MeshData; issues: Issue[] }
export interface AIModel { provider: string; id: string; name: string; vision: boolean; configured: boolean }
export interface AIProviderSettings { provider: string; mode: 'builtin' | 'custom'; model: string; baseUrl: string; api: string; vision: boolean; configured: boolean; saved: boolean }
export interface AIConfig { engine: string; version: string; models: AIModel[]; defaultModel: string; configured: boolean; revision: number; settings: AIProviderSettings[] }
export interface AIDiagnostics { provider: string; model: string; api: string; upstreamStatus?: number; code?: string }
export interface AIFeature { id: string; kind: 'hole' | 'opening' | 'connector' | 'obstruction'; label: string; bbox: number[]; confidence: number; note: string; edge?: Port['edge']; measurement?: { x: number; y: number; width: number; depth: number; diameter?: number } }
export interface AIAnnotation { corners?: number[][]; features: AIFeature[]; warnings: string[]; calibrated: boolean; width: number; depth: number; slot: PhotoSlot; provider: string; model: string; createdAt: string }
