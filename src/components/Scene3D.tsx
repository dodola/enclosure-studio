import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { MeshData, Preview, Project } from '../types';
import { faceDimensions, isSideMount, kindColors } from '../lib';

export default function Scene3D({ project, preview, exploded, showParts, selected, cameraKey }: { project: Project; preview: Preview; exploded: boolean; showParts: boolean; selected: string; cameraKey: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!host.current) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
    catch { setError('此浏览器无法使用 3D 加速，请切换至 2D 布局。'); return; }
    const container = host.current;
    const e = project.enclosure;
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#f6f8f9');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(34, 1, .1, 3000);
    const size = Math.max(e.width, e.depth);
    camera.position.set(size * 1.2, size * 1.15, size * 1.5);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, e.height * .65 + (exploded ? 14 : 0), 0); controls.enableDamping = false;
    controls.minDistance = size * .65; controls.maxDistance = size * 4; controls.maxPolarAngle = Math.PI * .49;
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 3.2); key.position.set(-100, 300, 160); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -size; key.shadow.camera.right = size; key.shadow.camera.top = size; key.shadow.camera.bottom = -size; key.shadow.camera.far = 700; key.shadow.bias = -.0005; scene.add(key);
    const fill = new THREE.DirectionalLight(0xdce9ee, 1.8); fill.position.set(180, 90, -120); scene.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(size * 5, size * 5), new THREE.ShadowMaterial({ opacity: .12 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -.1; floor.receiveShadow = true; scene.add(floor);
    const grid = new THREE.GridHelper(size * 3, 48, '#d9e2e5', '#e8edf0'); grid.position.y = -.15; scene.add(grid);
    const textureLoader = new THREE.TextureLoader();
    const materials: THREE.Material[] = [];
    const textures: THREE.Texture[] = [];
    const makeMaterial = (color: string, roughness = .6) => { const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: .04 }); materials.push(m); return m; };
    const shellMaterial = makeMaterial('#e3e8e6');
    const addShell = (data: MeshData, lift = 0) => {
      const vertices = new Float32Array(data.vertices.length);
      for (let i = 0; i < data.vertices.length; i += 3) { vertices[i] = data.vertices[i] - e.width / 2; vertices[i + 1] = data.vertices[i + 2] + lift; vertices[i + 2] = data.vertices[i + 1] - e.depth / 2; }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      // Swapping Y and Z reverses winding.
      const indices = [...data.indices]; for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      geometry.setIndex(indices);
      const flatGeometry = geometry.toNonIndexed(); flatGeometry.computeVertexNormals(); geometry.dispose();
      const object = new THREE.Mesh(flatGeometry, shellMaterial); object.castShadow = true; object.receiveShadow = true; scene.add(object);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(flatGeometry, 28), new THREE.LineBasicMaterial({ color: '#aebbb6', transparent: true, opacity: .35 })); scene.add(edges);
    };
    const lift = exploded ? Math.max(42, e.height * 1.25) : 0;
    addShell(preview.base); addShell(preview.lid, lift);
    const addBox = (x: number, y: number, z: number, w: number, d: number, h: number, material: THREE.Material) => {
      const object = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      object.position.set(x + w / 2 - e.width / 2, z + h / 2, y + d / 2 - e.depth / 2);
      object.castShadow = true; object.receiveShadow = true; scene.add(object); return object;
    };
    if (showParts) for (const c of project.components) {
      const z = c.z + (c.mount === 'lid' ? lift : 0);
      const boardMaterial = makeMaterial(kindColors[c.kind]);
      if (c.kind === 'board' && !isSideMount(c.mount)) {
        const pcbZ = z + c.mountOffset;
        const pcbThickness = Math.min(1.6, Math.max(.2, c.height - c.mountOffset));
        addBox(c.x, c.y, pcbZ, c.width, c.depth, pcbThickness, boardMaterial);
        if (c.id === 'firefly') {
          const texture = textureLoader.load('/samples/firefly-texture.jpg', render); texture.colorSpace = THREE.SRGBColorSpace; textures.push(texture);
          const photoMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: .8 }); materials.push(photoMaterial);
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(c.width, c.depth), photoMaterial); plane.rotation.x = -Math.PI / 2; plane.position.set(c.x + c.width / 2 - e.width / 2, pcbZ + pcbThickness + .02, c.y + c.depth / 2 - e.depth / 2); scene.add(plane);
        }
        if (c.height - c.mountOffset - pcbThickness > .1) addBox(c.x + c.width * .35, c.y + c.depth * .24, pcbZ + pcbThickness, c.width * .42, c.depth * .4, Math.min(2.5, c.height - c.mountOffset - pcbThickness), makeMaterial('#27342c'));
        for (const p of project.ports.filter(p => p.componentId === c.id)) {
          const metallic = makeMaterial('#a9b3b6', .35);
          if (p.edge === 'front') addBox(c.x + p.offset - p.width / 2, c.y + c.depth - 12, z + p.z, p.width, 12, p.height, metallic);
          if (p.edge === 'back') addBox(c.x + p.offset - p.width / 2, c.y, z + p.z, p.width, 10, p.height, metallic);
          if (p.edge === 'left') addBox(c.x, c.y + p.offset - p.width / 2, z + p.z, 10, p.width, p.height, metallic);
          if (p.edge === 'right') addBox(c.x + c.width - 10, c.y + p.offset - p.width / 2, z + p.z, 10, p.width, p.height, metallic);
        }
      } else if (c.kind === 'screen' && !isSideMount(c.mount)) {
        const bodyHeight = Math.max(.5, c.height - c.mountOffset);
        addBox(c.x, c.y, z, c.width, c.depth, bodyHeight, boardMaterial);
        addBox(c.x + (c.openingX ?? (c.width - c.openingWidth) / 2), c.y + (c.openingY ?? (c.depth - c.openingDepth) / 2), z + bodyHeight, c.openingWidth, c.openingDepth, Math.max(.5, c.mountOffset), makeMaterial('#14232d', .22));
      } else if (c.kind === 'keyboard' && !isSideMount(c.mount)) {
        const bodyHeight = Math.max(.5, c.height - c.mountOffset);
        addBox(c.x, c.y, z, c.width, c.depth, bodyHeight, boardMaterial);
        const keyMaterial = makeMaterial('#d6dedf');
        for (let i = 0; i < 12; i++) addBox(c.x + (c.openingX ?? (c.width - c.openingWidth) / 2) + i % 4 * c.openingWidth / 4 + .8, c.y + (c.openingY ?? (c.depth - c.openingDepth) / 2) + Math.floor(i / 4) * c.openingDepth / 3 + .8, z + bodyHeight, c.openingWidth / 4 - 1.6, c.openingDepth / 3 - 1.6, Math.max(.5, c.mountOffset), keyMaterial);
      } else if (['button', 'encoder', 'speaker'].includes(c.kind)) {
        const face = faceDimensions(c);
        const object = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(face.u, face.v) / 2, Math.min(face.u, face.v) / 2, face.thickness, 32), boardMaterial);
        if (['front', 'back'].includes(c.mount)) object.rotation.x = Math.PI / 2;
        if (['left', 'right'].includes(c.mount)) object.rotation.z = Math.PI / 2;
        object.position.set(c.x + c.width / 2 - e.width / 2, z + c.height / 2, c.y + c.depth / 2 - e.depth / 2);
        object.castShadow = true; scene.add(object);
      } else {
        addBox(c.x, c.y, z, c.width, c.depth, c.height, boardMaterial);
      }

      if (c.id === selected && exploded) {
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(c.width + 1, c.height + 1, c.depth + 1)), new THREE.LineBasicMaterial({ color: '#0f766e', transparent: true, opacity: .6 }));
        outline.position.set(c.x + c.width / 2 - e.width / 2, z + c.height / 2, c.y + c.depth / 2 - e.depth / 2); scene.add(outline);
      }
    }
    const resize = () => { const rect = container.getBoundingClientRect(); renderer.setSize(rect.width, rect.height); camera.aspect = rect.width / Math.max(rect.height, 1); camera.updateProjectionMatrix(); render(); };
    const observer = new ResizeObserver(resize); observer.observe(container); controls.update(); resize();
    return () => {
      observer.disconnect(); controls.dispose();
      scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) { object.geometry.dispose(); const mat = object.material; if (Array.isArray(mat)) mat.forEach(m => m.dispose()); else mat.dispose(); } });
      textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose()); renderer.dispose(); renderer.domElement.remove();
    };
  }, [project, preview, exploded, showParts, selected, cameraKey]);
  return <div ref={host} className="scene-3d" role="img" aria-label="外壳三维预览，拖动旋转，滚轮缩放。组件为尺寸占位模型。">{error && <p className="scene-error" role="status">{error}</p>}</div>;
}
