import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { MeshData } from '../types';

export default function ModuleScene3D({ mesh, cameraKey }: { mesh: MeshData; cameraKey: number }) {
  const host = useRef<HTMLDivElement>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!host.current) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
    catch { setError('此浏览器无法使用 3D 加速，仍可编辑参数并下载 STL。'); return; }
    const container = host.current, scene = new THREE.Scene(); scene.background = new THREE.Color('#f6f8f9');
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); container.appendChild(renderer.domElement);
    const geometry = new THREE.BufferGeometry(), vertices = new Float32Array(mesh.vertices.length);
    for (let i = 0; i < vertices.length; i += 3) { vertices[i] = mesh.vertices[i]; vertices[i+1] = mesh.vertices[i+2]; vertices[i+2] = mesh.vertices[i+1]; }
    const indices = [...mesh.indices]; for (let i = 0; i < indices.length; i += 3) [indices[i+1], indices[i+2]] = [indices[i+2], indices[i+1]];
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3)); geometry.setIndex(indices);
    geometry.computeVertexNormals(); geometry.computeBoundingBox();
    const bounds = geometry.boundingBox!, center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
    const scale = Math.max(size.x, size.y, size.z, 1);
    const material = new THREE.MeshStandardMaterial({ color: '#537d68', roughness: .65, metalness: .08 });
    scene.add(new THREE.Mesh(geometry, material));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 28), new THREE.LineBasicMaterial({ color: '#304e42' })); scene.add(edges);
    scene.add(new THREE.AmbientLight(0xffffff, 2));
    const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(-scale, scale*3, scale*2); scene.add(light);
    const grid = new THREE.GridHelper(scale*2, 20, '#cbd5d1', '#e2e8e5'); grid.position.set(center.x, -.05, center.z); scene.add(grid);
    const camera = new THREE.PerspectiveCamera(38, 1, .01, scale*20); camera.position.copy(center).add(new THREE.Vector3(scale*.95, scale*1.2, scale*1.4));
    const controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(center); controls.minDistance = scale*.2; controls.maxDistance = scale*6;
    const render = () => renderer.render(scene, camera); controls.addEventListener('change', render);
    const resize = () => { const rect = container.getBoundingClientRect(); renderer.setSize(rect.width, rect.height); camera.aspect = rect.width/Math.max(rect.height, 1); camera.updateProjectionMatrix(); render(); };
    const observer = new ResizeObserver(resize); observer.observe(container); controls.update(); resize();
    return () => { observer.disconnect(); controls.dispose(); geometry.dispose(); material.dispose(); edges.geometry.dispose(); edges.material.dispose(); grid.geometry.dispose(); if (Array.isArray(grid.material)) grid.material.forEach(m=>m.dispose()); else grid.material.dispose(); renderer.dispose(); renderer.domElement.remove(); };
  }, [mesh, cameraKey]);
  return <div ref={host} className="module-scene" role="img" aria-label="模组三维实体，可拖动旋转、滚轮缩放和右键平移">{error && <p className="scene-error" role="status">{error}</p>}</div>;
}
