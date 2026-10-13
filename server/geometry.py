"""Real boolean solids shared by preview and STL export; no placeholder meshes."""
import numpy as np
import trimesh
from manifold3d import CrossSection, Manifold

from .footprint import FASTENER_RADIUS, fastening_points
from .models import Project, validate_design
from .panels import SIDE_FACES, hole_center, opening_bounds, side_wall_span, support_span, ventilation_slots


def box(x, y, z, width, depth, height):
    return Manifold.cube((float(width), float(depth), float(height))).translate((float(x), float(y), float(z)))


def cylinder(x, y, z, height, diameter):
    return Manifold.cylinder(float(height), float(diameter) / 2, float(diameter) / 2, 48).translate((float(x), float(y), float(z)))


def rounded_box(x, y, z, width, depth, height, radius):
    """A convex rounded XY rectangle extruded along Z."""
    if not radius:
        return box(x, y, z, width, depth, height)
    centers = [(x + width - radius, y + depth - radius), (x + radius, y + depth - radius),
               (x + radius, y + radius), (x + width - radius, y + radius)]
    # 64 edges per quadrant: maximum sagitta < 0.017 mm at the largest R225.
    points = []
    for quadrant, (cx, cy) in enumerate(centers):
        angles = np.linspace(quadrant * np.pi / 2, (quadrant + 1) * np.pi / 2, 65)
        points.extend((cx + radius * np.cos(a), cy + radius * np.sin(a)) for a in angles)
    return CrossSection([np.asarray(points)]).extrude(float(height)).translate((0, 0, float(z)))


def enclosure_prism(e, inset, z, height):
    return rounded_box(inset, inset, z, e.width - 2 * inset, e.depth - 2 * inset, height, max(0, e.cornerRadius - inset))


def orient_face(solid, face, start, length):
    if face in ("front", "back"):
        return solid.rotate((90, 0, 0)).translate((0, start + length, 0))
    if face in ("left", "right"):
        return solid.rotate((90, 0, 90)).translate((start, 0, 0))
    return solid.translate((0, 0, start))


def face_cylinder(face, u, v, start, length, diameter):
    return orient_face(cylinder(u, v, 0, length, diameter), face, start, length)


def opening_cutter(c, e):
    u, v, w, h = opening_bounds(c)
    if c.mount == "lid":
        start, end = e.height - e.lid - e.lipHeight - 1, e.height + 1
    else:
        start, end = side_wall_span(c.mount, e)
    if c.openingShape == "circle":
        return face_cylinder(c.mount, u + w / 2, v + h / 2, start, end - start, w + 2 * e.clearance)
    radius = c.openingRadius + e.clearance if c.openingShape == "roundedRect" else 0
    solid = rounded_box(u - e.clearance, v - e.clearance, 0, w + 2 * e.clearance, h + 2 * e.clearance, end - start, radius)
    return orient_face(solid, c.mount, start, end - start)


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
    base = enclosure_prism(e, 0, 0, cap_z)
    base -= enclosure_prism(e, e.wall, e.floor, e.height)
    lid = enclosure_prism(e, 0, cap_z, e.lid)
    screw_points = fastening_points(e.width, e.depth, e.cornerRadius)
    for x, y in screw_points:
        base += cylinder(x, y, e.floor - 0.1, cap_z - e.floor + 0.1, 2 * FASTENER_RADIUS)
        base -= cylinder(x, y, e.floor + 1, cap_z - e.floor, e.pilotDiameter)
        lid -= cylinder(x, y, cap_z - 0.1, e.lid + 0.2, e.screwDiameter)
        if e.screwHeadDepth:
            lid -= cylinder(x, y, e.height - e.screwHeadDepth, e.screwHeadDepth + .1, e.screwHeadDiameter)
    if e.lipHeight:
        inset = e.wall + e.clearance
        lip = enclosure_prism(e, inset, cap_z - e.lipHeight, e.lipHeight + 0.1)
        lip -= enclosure_prism(e, inset + 1.2, cap_z - e.lipHeight - 0.1, e.lipHeight + 0.3)
        # The locating ring must clear the bosses when the lid is assembled.
        for x, y in screw_points:
            lip -= cylinder(x, y, cap_z - e.lipHeight - 0.1, e.lipHeight + 0.3, 2 * (FASTENER_RADIUS + e.clearance))
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
            elif c.mount in SIDE_FACES:
                hu, hv = hole_center(c, h)
                start, end = support_span(c, e)
                if end > start:
                    base += face_cylinder(c.mount, hu, hv, start - .1, end - start + .2, e.standoffDiameter)
                wall_start, wall_end = side_wall_span(c.mount, e)
                low, high = min(start, wall_start), max(end, wall_end)
                base -= face_cylinder(c.mount, hu, hv, low - .1, high - low + .2, e.screwDiameter)
        if c.mount != "base" and c.openingShape != "none":
            cutter = opening_cutter(c, e)
            if c.mount == "lid":
                lid -= cutter
            else:
                base -= cutter
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
        for x, z, height in ventilation_slots(project):
            base -= box(float(x) - 1.25, -0.5, z, 2.5, e.wall + 1, height)
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
