"""Real boolean solids shared by preview and STL export; no placeholder meshes."""
import numpy as np
import trimesh
from manifold3d import CrossSection, Manifold, Mesh

from .footprint import FASTENER_RADIUS, fastening_points
from .assembly import cradle_layout, tactile_layout
from .models import Project, validate_design
from .panels import SIDE_FACES, adhesive_frame, adhesive_mount, hole_center, opening_bounds, side_wall_span, support_span, ventilation_slots


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


def opening_cutter(c, e, bottom=None):
    u, v, w, h = opening_bounds(c)
    if c.mount == "lid":
        start, end = min(e.height - e.lid - e.lipHeight - 1, bottom if bottom is not None else e.height), e.height + 1
    else:
        start, end = side_wall_span(c.mount, e)
    if c.openingShape == "circle":
        return face_cylinder(c.mount, u + w / 2, v + h / 2, start, end - start, w + 2 * e.clearance)
    radius = c.openingRadius + e.clearance if c.openingShape == "roundedRect" else 0
    solid = rounded_box(u - e.clearance, v - e.clearance, 0, w + 2 * e.clearance, h + 2 * e.clearance, end - start, radius)
    return orient_face(solid, c.mount, start, end - start)


def adhesive_support(c, e):
    """Create the raised rectangular/circular glue ledge around a lid opening."""
    inner, outer, bottom, top = adhesive_frame(c, e)
    def ring(z, height, width):
        ox, oy, ow, oh = outer
        if c.openingShape == "circle":
            x, y = ox + ow/2, oy + oh/2
            return cylinder(x, y, z, height, ow) - cylinder(x, y, z-.1, height+.2, ow-2*width)
        radius = c.openingRadius + e.clearance + c.supportWidth if c.openingShape == "roundedRect" else 0
        return rounded_box(ox, oy, z, ow, oh, height, radius) - rounded_box(ox+width, oy+width, z-.1, ow-2*width, oh-2*width, height+.2, max(0, radius-width))
    result = ring(bottom, c.supportHeight, c.supportWidth)
    cap_z = e.height-e.lid
    if top < cap_z + .1:
        result += ring(top-.05, cap_z-top+.15, min(1.2, c.supportWidth))
    return result


def mesh(solid: Manifold) -> trimesh.Trimesh:
    data = solid.to_mesh()
    result = trimesh.Trimesh(vertices=np.asarray(data.vert_properties[:, :3]), faces=np.asarray(data.tri_verts), process=True)
    if result.is_empty or not result.is_watertight or result.volume <= 0:
        raise ValueError("生成的模型不是封闭实体，请检查尺寸。")
    if len(result.split()) != 1:
        raise ValueError('生成的零件包含不相连实体，请调整固定结构与面板的连接。')
    return result


def build(project: Project, extra_parts=None):
    issues = validate_design(project)
    errors = [i for i in issues if i["severity"] == "error"]
    if errors:
        raise ValueError("；".join(i["message"] for i in errors))
    e = project.enclosure
    extra_parts = extra_parts if extra_parts is not None else {}
    attachments = []
    cap_z = e.height - e.lid
    base = enclosure_prism(e, 0, 0, cap_z)
    base -= enclosure_prism(e, e.wall, e.floor, e.height)
    lid = enclosure_prism(e, 0, cap_z, e.lid)
    lid_support_bottoms = {}
    # Add adhesive ledges before the corner screw bores so the bores remain open.
    for c in project.components:
        if adhesive_mount(c) and c.openingShape != "none":
            support = adhesive_support(c, e)
            attachments.append((c,support))
            lid += support
            lid_support_bottoms[c.id] = adhesive_frame(c, e)[2] - .1
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
    for index, c in enumerate(project.components, 1):
        before_base, before_lid = base, lid
        if c.mountingMethod == 'cradle':
            layout = cradle_layout(c,e)
            for b in [layout['bed'], *layout['rails']]:
                base += box(*b)
            bar = box(*layout['bar'])
            for x,y in layout['points']:
                base += cylinder(x,y,e.floor-.1,layout['top']-e.floor+.1,layout['bossDiameter'])
                bore = c.insertDiameter if c.fastenerType=='heatsetM3' else e.pilotDiameter
                bore_bottom = layout['top']-c.insertDepth if c.fastenerType=='heatsetM3' else e.floor+.8
                base -= cylinder(x,y,bore_bottom,layout['top']-bore_bottom+.1,bore)
                bar -= cylinder(x,y,layout['top']-.1,c.clampThickness+.2,3.2 if c.fastenerType=='heatsetM3' else e.screwDiameter)
            if c.strapSlots:
                for x in (c.x-e.clearance-c.cradleWall/2, c.x+c.width+e.clearance+c.cradleWall/2):
                    base -= box(x-.6,c.y+c.depth/2-4,-.1,1.2,8,c.z+2.2)
            extra_parts[f'clamp-{index}.stl'] = dict(mesh=mesh(bar),componentId=c.id,name=f'{c.name} 可拆压条',mount='base')
        for h in c.holes if c.mountingMethod == "holes" else []:
            x, y = c.x + h.x, c.y + h.y
            if c.mount == "base" and c.z + c.mountOffset > e.floor:
                support_top = c.z + c.mountOffset
                base += cylinder(x, y, e.floor - 0.1, support_top - e.floor + 0.1, e.standoffDiameter)
                if c.fastenerType == 'heatsetM3':
                    base -= cylinder(x,y,support_top-c.insertDepth,c.insertDepth+.1,c.insertDiameter)
                else:
                    base -= cylinder(x, y, e.floor + 0.4, support_top - e.floor, e.pilotDiameter)
            elif c.mount == "lid" and c.mountingMethod == "holes":
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
            if c.tactileEnabled:
                key = tactile_layout(c,e)
                start,end = side_wall_span(c.mount,e)
                cutter = face_cylinder(c.mount,key['u'],key['v'],start,end-start,key['bore'])
            else:
                cutter = opening_cutter(c, e, lid_support_bottoms.get(c.id))
            if c.mount == "lid":
                lid -= cutter
            else:
                base -= cutter
        if c.tactileEnabled:
            key = tactile_layout(c,e)
            u,v = key['u'],key['v']
            start,end = key['guide']
            guide = face_cylinder(c.mount,u,v,start,end-start,key['outer'])
            guide -= face_cylinder(c.mount,u,v,start-.1,end-start+.2,key['bore'])
            base += guide
            start,end = key['shaft']
            plunger = face_cylinder(c.mount,u,v,start,end-start,c.keyDiameter)
            start,end = key['flange']
            plunger += face_cylinder(c.mount,u,v,start,end-start,key['flangeDiameter'])
            extra_parts[f'key-{index}.stl'] = dict(mesh=mesh(plunger),componentId=c.id,name=f'{c.name} 防脱键帽',mount=c.mount)
        if c.speakerGrille:
            u,v,w,h = opening_bounds(c)
            start,end = (e.height-c.grilleThickness,e.height) if c.mount=='lid' else side_wall_span(c.mount,e)
            if c.mount in ('front','right'):
                end = e.depth if c.mount=='front' else e.width
                start = end-c.grilleThickness
            elif c.mount in ('back','left'):
                start,end = 0,c.grilleThickness
            radius = (w+2*e.clearance)/2
            disc = cylinder(u+w/2,v+h/2,0,end-start,w+2*e.clearance+.6)
            grille = Manifold()
            for offset in np.arange(0,radius,c.grilleBarWidth+c.grilleSpacing):
                for direction in ([1] if offset==0 else [-1,1]):
                    grille += box(u+w/2+direction*offset-c.grilleBarWidth/2,v-e.clearance-.4,0,c.grilleBarWidth,h+2*e.clearance+.8,end-start) ^ disc
            grille = orient_face(grille,c.mount,start,end-start)
            if c.mount=='lid':
                lid += grille
            else:
                base += grille
        added_base,added_lid = base-before_base,lid-before_lid
        if added_base.volume()>.01:
            attachments.append((c,added_base))
        if added_lid.volume()>.01:
            attachments.append((c,added_lid))
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
    if (base ^ lid).volume() > .01:
        raise ValueError('上盖固定结构与底壳实体相交，请调整承托位置、定位边或支撑柱。')
    for owner,solid in attachments:
        for c in project.components:
            if c.id != owner.id and (solid ^ box(c.x,c.y,c.z,c.width,c.depth,c.height)).volume() > .01:
                raise ValueError(f'{owner.name} 的固定结构与 {c.name} 实体相交。')
    extra_solids = []
    for item in extra_parts.values():
        value=item['mesh']
        solid=Manifold(Mesh(np.float32(value.vertices),np.uint32(value.faces)))
        for other, other_solid in extra_solids:
            if (solid ^ other_solid).volume() > .01:
                raise ValueError(f'{item["name"]} 与 {other["name"]} 相交，请增加间距。')
        extra_solids.append((item,solid))
        if (solid ^ base).volume()>.01 or (solid ^ lid).volume()>.01:
            raise ValueError(f'{item["name"]} 与壳体相交，请调整固定高度或配合间隙。')
        for c in project.components:
            if c.id!=item['componentId'] and (solid ^ box(c.x,c.y,c.z,c.width,c.depth,c.height)).volume()>.01:
                raise ValueError(f'{item["name"]} 与 {c.name} 相交。')
    # Check reserved volumes against final solids, including actual openings.
    for k in project.keepouts:
        region = box(k.x,k.y,k.z,k.width,k.depth,k.height)
        if (base ^ region).volume() > .01 or (k.purpose!='removal' and (lid ^ region).volume() > .01):
            raise ValueError(f'{k.name} 保留区与外壳/固定结构相交，请调整位置或开口。')
        for part in extra_parts.values():
            if k.purpose=='removal' and (k.componentId==part['componentId'] or part['mount']=='lid'):
                continue  # Remove this component's clamp before lifting it out.
            data = part['mesh']
            solid = Manifold(Mesh(np.float32(data.vertices),np.uint32(data.faces)))
            if (solid ^ region).volume() > .01:
                raise ValueError(f'{k.name} 保留区与 {part["name"]} 相交。')
    return mesh(base), mesh(lid), issues


def build_kit(project):
    extras = {}
    base,lid,issues = build(project,extras)
    return base,lid,issues,extras


def printable_extra(part):
    result = part['mesh'].copy()
    if part['mount'] in ('front','back'):
        result.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2,[1,0,0]))
    elif part['mount'] in ('left','right'):
        result.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2,[0,1,0]))
    result.apply_translation(-result.bounds[0])
    return result


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
