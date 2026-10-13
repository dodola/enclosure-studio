"""Millimetres throughout. Positions refer to the enclosure's outer lower-left corner."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .footprint import FASTENER_RADIUS, fastening_points, footprint_distance, rectangle_fits, ventilation_positions


class Hole(BaseModel):
    id: str = Field(max_length=100)
    x: float = Field(ge=0, le=500)
    y: float = Field(ge=0, le=500)
    diameter: float = Field(gt=0, le=20)
    source: str = "manual"
    verified: bool = False


class Component(BaseModel):
    id: str = Field(max_length=100)
    kind: Literal["board", "screen", "keyboard", "button"]
    name: str = Field(max_length=120)
    width: float = Field(ge=3, le=400)
    depth: float = Field(ge=3, le=400)
    height: float = Field(ge=0.5, le=150)
    x: float = Field(ge=0, le=500)
    y: float = Field(ge=0, le=500)
    z: float = Field(ge=0, le=200)
    mount: Literal["base", "lid"] = "base"
    mountOffset: float = Field(ge=0, le=100, default=0)
    openingWidth: float = Field(ge=0, le=400, default=0)
    openingDepth: float = Field(ge=0, le=400, default=0)
    openingX: float | None = Field(ge=0, le=400, default=None)
    openingY: float | None = Field(ge=0, le=400, default=None)
    holes: list[Hole] = Field(default_factory=list, max_length=40)
    verified: bool = False


class Port(BaseModel):
    id: str = Field(max_length=100)
    componentId: str = Field(max_length=100)
    name: str = Field(max_length=120)
    edge: Literal["front", "back", "left", "right"]
    offset: float = Field(ge=0, le=400)
    width: float = Field(ge=1, le=200)
    height: float = Field(ge=1, le=100)
    z: float = Field(ge=0, le=150)
    verified: bool = False


class Enclosure(BaseModel):
    width: float = Field(ge=30, le=450)
    depth: float = Field(ge=30, le=450)
    height: float = Field(ge=10, le=180)
    wall: float = Field(ge=1.2, le=6)
    floor: float = Field(ge=1.2, le=6)
    lid: float = Field(ge=1.2, le=6)
    clearance: float = Field(ge=0.1, le=2)
    standoffDiameter: float = Field(ge=4, le=12)
    screwDiameter: float = Field(ge=2, le=5)
    pilotDiameter: float = Field(ge=1.5, le=4)
    lipHeight: float = Field(ge=0, le=5)
    cornerRadius: float = Field(ge=0, le=225, default=0)
    ventilation: bool = True


class Project(BaseModel):
    model_config = ConfigDict(extra="ignore")
    version: Literal[1] = 1
    name: str = Field(default="未命名项目", max_length=120)
    components: list[Component] = Field(max_length=30)
    ports: list[Port] = Field(default_factory=list, max_length=50)
    enclosure: Enclosure


def validate_design(project: Project) -> list[dict]:
    """Blocking geometry errors and non-blocking measurement review notices."""
    e = project.enclosure
    issues = []

    def add(code, message, severity="error", component_id=None):
        issues.append(dict(code=code, message=message, severity=severity, componentId=component_id))

    if not project.components:
        add("empty", "请至少添加一个组件。")
    ids = [c.id for c in project.components]
    if len(ids) != len(set(ids)):
        add("duplicate", "组件 ID 重复，请重新导入有效项目。")
    if e.floor + e.lid + e.lipHeight >= e.height:
        add("height", "底板、上盖与定位边占用了全部内部高度。")
    if e.pilotDiameter >= e.screwDiameter:
        add("pilot", "螺丝导孔应小于上盖螺丝通孔。")
    if e.standoffDiameter <= e.screwDiameter + 1.2:
        add("boss", "支撑柱外径太小，请为螺孔保留至少 0.6 mm 壁厚。")
    if e.cornerRadius > min(e.width, e.depth) / 2:
        add("corner-radius", "外壳四角半径不能超过宽度与长度中较小值的一半。")
    if e.ventilation and len(ventilation_positions(e.width, e.cornerRadius)) < 9:
        add("ventilation-corners", "圆角占用了部分后侧直壁；仅在剩余直壁生成通风孔。", "warning")
    screw_points = fastening_points(e.width, e.depth, e.cornerRadius)
    openings = []
    for c in project.components:
        if not rectangle_fits(c.x, c.y, c.width, c.depth, e.width, e.depth, e.cornerRadius, e.wall + e.clearance):
            add("bounds", f"{c.name} 超出内腔或装配间隙（含四角圆弧），请调整位置、减小圆角或扩大外壳。", component_id=c.id)
        mount_plane = c.z + c.height - c.mountOffset
        panel = c.mount == "lid" and c.kind != "board"
        if c.z < e.floor - 0.001 or (not panel and c.z + c.height > e.height - e.lid + 0.001) or (panel and (mount_plane > e.height - e.lid + 0.001 or c.z + c.height > e.height + 20)):
            add("vertical", f"{c.name} 的高度与底板或上盖相交。", component_id=c.id)
        if panel and c.z + c.height < e.height - 0.001:
            add("panel-recess", f"{c.name} 的操作表面低于上盖外表面，请核对底面 Z 与安装基准。", "warning", c.id)
        if c.mountOffset > c.height:
            add("mount-offset", f"{c.name} 的安装基准偏移不能超过组件总高。", component_id=c.id)
        for sx, sy in screw_points:
            nearest_x = min(max(sx, c.x), c.x + c.width)
            nearest_y = min(max(sy, c.y), c.y + c.depth)
            if (nearest_x - sx) ** 2 + (nearest_y - sy) ** 2 < FASTENER_RADIUS ** 2:
                add("fastener-collision", f"{c.name} 与外壳角部螺丝柱相交。", component_id=c.id)
                break
        for hole in c.holes:
            r = e.standoffDiameter / 2
            if hole.x > c.width or hole.y > c.depth:
                add("hole", f"{c.name} 的安装孔不在组件范围内。", component_id=c.id)
            if hole.diameter <= e.pilotDiameter:
                add("hole-screw", f"{c.name} 的安装孔小于支撑柱导孔，请核对孔径。", component_id=c.id)
            if footprint_distance(c.x + hole.x, c.y + hole.y, e.width, e.depth, e.cornerRadius, e.wall) + r > 0.001:
                add("hole-wall", f"{c.name} 的支撑柱与侧壁或内腔圆角相交，请增加边距。", component_id=c.id)
        if c.mount == "lid" and c.kind != "board":
            if c.kind == "button" and abs(c.openingDepth - c.openingWidth) > 0.001:
                add("button-opening", f"{c.name} 的圆孔宽度和长度必须等于孔径。", component_id=c.id)
            if not c.openingWidth or not c.openingDepth or c.openingWidth > c.width or c.openingDepth > c.depth:
                add("opening", f"{c.name} 的上盖开口尺寸须大于零且不超过组件外形。", component_id=c.id)
            dx = c.openingX if c.openingX is not None else (c.width - c.openingWidth) / 2
            dy = c.openingY if c.openingY is not None else (c.depth - c.openingDepth) / 2
            if dx + c.openingWidth > c.width or dy + c.openingDepth > c.depth:
                add("opening-bounds", f"{c.name} 的开口位置超出组件外形。", component_id=c.id)
            ox, oy = c.x + dx, c.y + dy
            openings.append((c, ox, oy, c.openingWidth, c.openingDepth))
            for hole in c.holes:
                hx, hy = c.x + hole.x, c.y + hole.y
                radius = e.standoffDiameter / 2 + e.clearance
                if ox - radius < hx < ox + c.openingWidth + radius and oy - radius < hy < oy + c.openingDepth + radius:
                    add("hole-opening", f"{c.name} 的支撑柱太靠近上盖开口。", component_id=c.id)
        if not c.verified or any(not h.verified for h in c.holes):
            add("unverified", f"{c.name}：外形、高度或孔位仍待实测复核。", "warning", c.id)
        if not c.holes and c.kind != "button":
            add("mounting", f"{c.name} 没有安装孔；模型未为它生成支撑柱，请补充固定方式。", "warning", c.id)
        if c.kind == "button":
            add("button-mount", f"{c.name} 生成圆形面板开孔；请使用带螺母的面板按钮或自行补充固定结构。", "warning", c.id)
    for i, a in enumerate(project.components):
        for b in project.components[i + 1:]:
            if (min(a.x + a.width, b.x + b.width) - max(a.x, b.x) > 0.01 and
                min(a.y + a.depth, b.y + b.depth) - max(a.y, b.y) > 0.01 and
                min(a.z + a.height, b.z + b.height) - max(a.z, b.z) > 0.01):
                add("collision", f"{a.name} 与 {b.name} 发生空间碰撞。", component_id=a.id)
    for i, (a, ax, ay, aw, ad) in enumerate(openings):
        for b, bx, by, bw, bd in openings[i + 1:]:
            margin = 2 * e.clearance + e.wall
            if ax < bx + bw + margin and ax + aw + margin > bx and ay < by + bd + margin and ay + ad + margin > by:
                add("opening-overlap", f"{a.name} 与 {b.name} 的面板开口太近，请保留至少一个壁厚。", component_id=a.id)
    components = {c.id: c for c in project.components}
    port_rects = []
    for p in project.ports:
        c = components.get(p.componentId)
        if c is None:
            add("port-component", f"{p.name} 引用了不存在的组件。")
            continue
        extent = c.width if p.edge in ("front", "back") else c.depth
        if p.offset - p.width / 2 < -0.001 or p.offset + p.width / 2 > extent + 0.001:
            add("port-bounds", f"{p.name} 的位置或宽度超出组件边缘。", component_id=c.id)
        lower_z = c.z + p.z - e.clearance
        upper_z = c.z + p.z + p.height + e.clearance
        if lower_z <= e.floor or upper_z >= e.height - e.lid:
            add("port-height", f"{p.name} 的开孔与底板或上盖相交。", component_id=c.id)
        gap = {"front": e.depth - e.wall - c.y - c.depth, "back": c.y - e.wall,
               "left": c.x - e.wall, "right": e.width - e.wall - c.x - c.width}[p.edge]
        if gap > 3:
            add("port-reach", f"{p.name} 距侧壁 {gap:.1f} mm，需移动组件到该侧壁附近（不超过 3 mm）。", component_id=c.id)
        along = (c.x if p.edge in ("front", "back") else c.y) + p.offset
        side_length = e.width if p.edge in ("front", "back") else e.depth
        if e.cornerRadius and (along - p.width / 2 - e.clearance < e.cornerRadius - 0.001 or along + p.width / 2 + e.clearance > side_length - e.cornerRadius + 0.001):
            add("port-corner", f"{p.name} 的开孔进入外壳圆角，请移到直壁或减小圆角。", component_id=c.id)
        port_rects.append((p, along - p.width / 2 - e.clearance, along + p.width / 2 + e.clearance, lower_z, upper_z))
        if not p.verified:
            add("port-review", f"{p.name}：开孔宽高、离板高度及插头空间待复核。", "warning", c.id)
    for i, (a, al, ar, az, at) in enumerate(port_rects):
        for b, bl, br, bz, bt in port_rects[i + 1:]:
            if a.edge == b.edge and min(ar, br) - max(al, bl) > 0 and min(at, bt) - max(az, bz) > 0:
                add("port-overlap", f"{a.name} 与 {b.name} 的开孔重叠，请调整位置、尺寸或间隙。")
    return issues
