"""Real boolean solids shared by preview and STL export; no placeholder meshes."""
import numpy as np
import trimesh
from manifold3d import Manifold

from .models import Project, validate_design


def box(x, y, z, width, depth, height):
    return Manifold.cube((float(width), float(depth), float(height))).translate((float(x), float(y), float(z)))


def cylinder(x, y, z, height, diameter):
    return Manifold.cylinder(float(height), float(diameter) / 2, float(diameter) / 2, 48).translate((float(x), float(y), float(z)))


def mesh(solid: Manifold) -> trimesh.Trimesh:
    data = solid.to_mesh()
    result = trimesh.Trimesh(vertices=np.asarray(data.vert_properties[:, :3]), faces=np.asarray(data.tri_verts), process=True)
    if result.is_empty or not result.is_watertight or result.volume <= 0:
        raise ValueError("生成的模型不是封闭实体，请检查尺寸。")
    return result


def build(project: Project):
    issues = validate_design(project)
    errors = [i for i in issues if i["severity"] == "error"]
    if errors:
        raise ValueError("；".join(i["message"] for i in errors))
    e = project.enclosure
    cap_z = e.height - e.lid
    base = box(0, 0, 0, e.width, e.depth, cap_z)
    base -= box(e.wall, e.wall, e.floor, e.width - 2 * e.wall, e.depth - 2 * e.wall, e.height)
    lid = box(0, 0, cap_z, e.width, e.depth, e.lid)
    screw_points = [(6, 6), (e.width - 6, 6), (6, e.depth - 6), (e.width - 6, e.depth - 6)]
    for x, y in screw_points:
        base += cylinder(x, y, e.floor - 0.1, cap_z - e.floor + 0.1, 8)
        base -= cylinder(x, y, e.floor + 1, cap_z - e.floor, e.pilotDiameter)
        lid -= cylinder(x, y, cap_z - 0.1, e.lid + 0.2, e.screwDiameter)
    if e.lipHeight:
        inset = e.wall + e.clearance
        lip = box(inset, inset, cap_z - e.lipHeight, e.width - 2 * inset, e.depth - 2 * inset, e.lipHeight + 0.1)
        lip -= box(inset + 1.2, inset + 1.2, cap_z - e.lipHeight - 0.1, e.width - 2 * (inset + 1.2), e.depth - 2 * (inset + 1.2), e.lipHeight + 0.3)
        lid += lip
    for c in project.components:
        for h in c.holes:
            x, y = c.x + h.x, c.y + h.y
            if c.mount == "base" and c.z + c.mountOffset > e.floor:
                support_top = c.z + c.mountOffset
                base += cylinder(x, y, e.floor - 0.1, support_top - e.floor + 0.1, e.standoffDiameter)
                base -= cylinder(x, y, e.floor + 0.4, support_top - e.floor, e.pilotDiameter)
            elif c.mount == "lid":
                top = c.z + c.height - c.mountOffset
                if cap_z > top:
                    lid += cylinder(x, y, top, cap_z - top + 0.1, e.standoffDiameter)
                lid -= cylinder(x, y, min(top, cap_z) - 0.1, e.height - min(top, cap_z) + 0.2, e.screwDiameter)
        if c.mount == "lid" and c.kind != "board":
            ox = c.x + (c.openingX if c.openingX is not None else (c.width - c.openingWidth) / 2)
            oy = c.y + (c.openingY if c.openingY is not None else (c.depth - c.openingDepth) / 2)
            cx, cy = ox + c.openingWidth / 2, oy + c.openingDepth / 2
            if c.kind == "button":
                lid -= cylinder(cx, cy, cap_z - e.lipHeight - 1, e.lid + e.lipHeight + 2, c.openingWidth + 2 * e.clearance)
            else:
                lid -= box(ox - e.clearance, oy - e.clearance,
                           cap_z - e.lipHeight - 1, c.openingWidth + 2 * e.clearance,
                           c.openingDepth + 2 * e.clearance, e.lid + e.lipHeight + 2)
    parts = {c.id: c for c in project.components}
    for p in project.ports:
        c = parts[p.componentId]
        w, h = p.width + 2 * e.clearance, p.height + 2 * e.clearance
        z = c.z + p.z - e.clearance
        if p.edge in ("front", "back"):
            y = e.depth - e.wall - 0.5 if p.edge == "front" else -0.5
            cutter = box(c.x + p.offset - w / 2, y, z, w, e.wall + 1, h)
        else:
            x = e.width - e.wall - 0.5 if p.edge == "right" else -0.5
            cutter = box(x, c.y + p.offset - w / 2, z, e.wall + 1, w, h)
        base -= cutter
    if e.ventilation:
        for x in np.linspace(e.width * 0.27, e.width * 0.73, 9):
            base -= box(float(x) - 1.25, -0.5, max(e.floor + 3, cap_z * 0.3), 2.5, e.wall + 1, min(12, cap_z * 0.4))
    return mesh(base), mesh(lid), issues


def serialise(mesh_value):
    return dict(vertices=np.round(mesh_value.vertices, 5).reshape(-1).tolist(), indices=mesh_value.faces.reshape(-1).tolist(),
                volume=round(float(mesh_value.volume), 1), watertight=bool(mesh_value.is_watertight), triangles=len(mesh_value.faces))


def printable_lid(lid):
    result = lid.copy()
    # Flat outer face on the print bed, locating lip facing up.
    result.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))
    result.apply_translation(-result.bounds[0])
    return result


def mounting_coupon(project):
    c = next((c for c in project.components if c.mount == "base" and c.holes), None)
    if c is None:
        raise ValueError("没有可测试的底壳安装孔，请先添加孔位。")
    solid = box(0, 0, 0, c.width + 6, c.depth + 6, 1.4)
    for h in c.holes:
        solid -= cylinder(h.x + 3, h.y + 3, -0.1, 1.6, h.diameter)
    return mesh(solid)
