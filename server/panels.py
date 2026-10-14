"""Panel coordinates: U runs along a face, V runs down the lid or up a side."""
SIDE_FACES = ("front", "back", "left", "right")


def adhesive_mount(c):
    return c.mount == "lid" and c.kind in ("screen", "keyboard") and c.mountingMethod == "adhesive" and c.supportEnabled


def adhesive_frame(c, e):
    """Glue pad contacts the top mounting face through a vertical glue gap."""
    u, v, w, h = opening_bounds(c)
    gap = e.clearance
    inner = (u - gap, v - gap, w + 2 * gap, h + 2 * gap)
    outer = (inner[0] - c.supportWidth, inner[1] - c.supportWidth,
             inner[2] + 2 * c.supportWidth, inner[3] + 2 * c.supportWidth)
    bottom = mounting_plane(c) + c.adhesiveClearance
    return inner, outer, bottom, bottom + c.supportHeight


def frame_boxes(inner, outer, bottom, top):
    """Four non-overlapping AABBs of a rectangular ring for conservative checks."""
    ix, iy, iw, ih = inner
    ox, oy, ow, oh = outer
    return [(ox, oy, bottom, ow, iy - oy, top - bottom),
            (ox, iy + ih, bottom, ow, oy + oh - iy - ih, top - bottom),
            (ox, iy, bottom, ix - ox, ih, top - bottom),
            (ix + iw, iy, bottom, ox + ow - ix - iw, ih, top - bottom)]


def face_dimensions(c):
    if c.mount in ("front", "back"):
        return c.width, c.height, c.depth
    if c.mount in ("left", "right"):
        return c.depth, c.height, c.width
    return c.width, c.depth, c.height


def mounting_plane(c):
    if c.mount == "front":
        return c.y + c.depth - c.mountOffset
    if c.mount == "back":
        return c.y + c.mountOffset
    if c.mount == "right":
        return c.x + c.width - c.mountOffset
    if c.mount == "left":
        return c.x + c.mountOffset
    return c.z + c.height - c.mountOffset


def opening_bounds(c):
    u, v, _ = face_dimensions(c)
    du = c.openingX if c.openingX is not None else (u - c.openingWidth) / 2
    dv = c.openingY if c.openingY is not None else (v - c.openingDepth) / 2
    origin_u = c.y if c.mount in ("left", "right") else c.x
    origin_v = c.y if c.mount == "lid" else c.z
    return origin_u + du, origin_v + dv, c.openingWidth, c.openingDepth


def hole_center(c, h):
    return (c.y + h.x if c.mount in ("left", "right") else c.x + h.x,
            c.z + h.y if c.mount in SIDE_FACES else c.y + h.y)


def support_span(c, e):
    plane = mounting_plane(c)
    if c.mount == "base":
        return e.floor, c.z + c.mountOffset
    if c.mount == "lid":
        return plane, e.height - e.lid
    if c.mount == "front":
        return plane, e.depth - e.wall
    if c.mount == "back":
        return e.wall, plane
    if c.mount == "left":
        return e.wall, plane
    return plane, e.width - e.wall


def side_wall_span(face, e):
    if face == "front":
        return e.depth - e.wall - .1, e.depth + .1
    if face == "right":
        return e.width - e.wall - .1, e.width + .1
    return -.1, e.wall + .1


def face_box(face, u, v, width, height, start, end):
    """World AABB of an extruded face rectangle, used for conservative checks."""
    if face in ("front", "back"):
        return u, start, v, width, end - start, height
    if face in ("left", "right"):
        return start, u, v, end - start, width, height
    return u, v, start, width, height, end - start


def boxes_overlap(a, b, tolerance=.01):
    return all(min(a[i] + a[i + 3], b[i] + b[i + 3]) - max(a[i], b[i]) > tolerance for i in range(3))


def ventilation_slots(project):
    from .footprint import ventilation_positions
    e = project.enclosure
    cap_z = e.height - e.lid
    z, height = max(e.floor + 3, cap_z * .3), min(12, cap_z * .4)
    excluded = [opening_bounds(c) for c in project.components if c.mount == "back" and c.openingShape != "none"]
    parts = {c.id: c for c in project.components}
    excluded.extend((parts[p.componentId].x + p.offset - p.width / 2, parts[p.componentId].z + p.z, p.width, p.height)
                    for p in project.ports if p.edge == "back" and p.componentId in parts)
    margin = e.clearance + .8
    return [(x, z, height) for x in ventilation_positions(e.width, e.cornerRadius)
            if not any(x - 1.25 < u + w + margin and x + 1.25 > u - margin and z < v + h + margin and z + height > v - margin
                       for u, v, w, h in excluded)]
