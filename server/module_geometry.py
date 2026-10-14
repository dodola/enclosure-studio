"""Editable module solids in local U/V/normal coordinates, independent of enclosure layout."""
from .geometry import box, cylinder, mesh
from .panels import face_dimensions


def build_module(component):
    component.module_bounds()
    u, v, thickness = face_dimensions(component)
    m = component.moduleModel
    solid = box(0, 0, m.bodyZ if m else 0, u, v, m.bodyThickness if m else thickness)
    features = m.features if m else []
    for f in features:
        if f.operation == 'add':
            solid += feature_solid(f)
    for f in features:
        if f.operation == 'cut':
            cutter = feature_solid(f)
            if (solid ^ cutter).volume() < 1e-7:
                raise ValueError(f'「{f.name}」切除范围未接触实体。')
            solid -= cutter
    for hole in component.holes:
        radius = hole.diameter / 2
        if not radius <= hole.x <= u-radius or not radius <= hole.y <= v-radius:
            raise ValueError('安装孔须完整位于模组外形内。')
        solid -= cylinder(hole.x, hole.y, -.1, thickness+.2, hole.diameter)
    try:
        return mesh(solid)
    except ValueError as exc:
        raise ValueError('模组须为一个封闭实体；请将附加实体连接到主体，并避免切空或切断主体。') from exc


def feature_solid(f):
    if f.shape == 'cylinder':
        return cylinder(f.x+f.width/2, f.y+f.depth/2, f.z, f.height, f.width)
    return box(f.x, f.y, f.z, f.width, f.depth, f.height)


def module_to_world(data, c):
    """Map U/V/normal to the same mounting axes as face_dimensions, preserving winding."""
    result = data.copy()
    if c.mount in ('front', 'back'):
        result.vertices = data.vertices[:, [0, 2, 1]]
        result.faces = data.faces[:, [0, 2, 1]]
    elif c.mount in ('left', 'right'):
        result.vertices = data.vertices[:, [2, 0, 1]]
    result.apply_translation((c.x, c.y, c.z))
    return result
