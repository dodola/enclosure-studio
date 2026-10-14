"""Millimetres throughout. Positions refer to the enclosure's outer lower-left corner."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .footprint import FASTENER_RADIUS, fastening_points, footprint_distance, rectangle_fits
from .assembly import cradle_layout, tactile_layout
from .panels import SIDE_FACES, adhesive_frame, adhesive_mount, frame_boxes, boxes_overlap, face_box, face_dimensions, hole_center, mounting_plane, opening_bounds, side_wall_span, support_span, ventilation_slots


class Hole(BaseModel):
    id: str = Field(max_length=100)
    x: float = Field(ge=0, le=500)
    y: float = Field(ge=0, le=500)
    diameter: float = Field(gt=0, le=20)
    source: str = "manual"
    verified: bool = False


class ModuleFeature(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=120)
    shape: Literal['box', 'cylinder'] = 'box'
    operation: Literal['add', 'cut'] = 'add'
    x: float = Field(ge=0, le=400)
    y: float = Field(ge=0, le=400)
    z: float = Field(ge=0, le=400)
    width: float = Field(ge=.1, le=400)
    depth: float = Field(ge=.1, le=400)
    height: float = Field(ge=.1, le=400)


class ModuleModel(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    bodyZ: float = Field(ge=0, le=400)
    bodyThickness: float = Field(ge=.1, le=400)
    features: list[ModuleFeature] = Field(default_factory=list, max_length=40)
    source: Literal['manual', 'ai'] = 'manual'
    provider: str | None = Field(default=None, max_length=200)
    model: str | None = Field(default=None, max_length=200)
    createdAt: str | None = Field(default=None, max_length=100)
    warnings: list[str] = Field(default_factory=list, max_length=15)


class Component(BaseModel):
    id: str = Field(max_length=100)
    kind: Literal["board", "screen", "keyboard", "button", "switch", "encoder", "battery", "speaker", "module"]
    name: str = Field(max_length=120)
    width: float = Field(ge=3, le=400)
    depth: float = Field(ge=3, le=400)
    height: float = Field(ge=0.5, le=150)
    x: float = Field(ge=-20, le=500)
    y: float = Field(ge=-20, le=500)
    z: float = Field(ge=0, le=200)
    mount: Literal["base", "lid", "front", "back", "left", "right"] = "base"
    mountOffset: float = Field(ge=0, le=100, default=0)
    openingWidth: float = Field(ge=0, le=400, default=0)
    openingDepth: float = Field(ge=0, le=400, default=0)
    openingX: float | None = Field(ge=0, le=400, default=None)
    openingY: float | None = Field(ge=0, le=400, default=None)
    openingShape: Literal["none", "rect", "circle", "roundedRect"] = "none"
    openingRadius: float = Field(ge=0, le=200, default=0)
    mountingMethod: Literal["holes", "adhesive", "cradle", "none"] = "none"
    supportEnabled: bool = False
    supportWidth: float = Field(ge=1.2, le=20, default=3)
    supportHeight: float = Field(ge=.8, le=10, default=1.2)
    adhesiveClearance: float = Field(ge=0, le=5, default=0.3)
    cradleWall: float = Field(ge=1.2, le=5, default=2)
    clampThickness: float = Field(ge=1.2, le=5, default=2.4)
    strapSlots: bool = False
    fastenerType: Literal['pilot', 'heatsetM3'] = 'pilot'
    insertDiameter: float = Field(ge=3.5, le=6, default=4.2)
    insertDepth: float = Field(ge=2, le=8, default=4)
    speakerGrille: bool = False
    grilleBarWidth: float = Field(ge=.8, le=3, default=1.2)
    grilleSpacing: float = Field(ge=1, le=8, default=3)
    grilleThickness: float = Field(ge=.8, le=3, default=1.2)
    tactileEnabled: bool = False
    keyDiameter: float = Field(ge=3, le=12, default=6)
    keyTravel: float = Field(ge=.2, le=1.5, default=.6)
    keyClearance: float = Field(ge=.15, le=.6, default=.25)
    keyFlange: float = Field(ge=1, le=3, default=1.5)
    keyProjection: float = Field(ge=.5, le=3, default=1.2)
    guideLength: float = Field(ge=1.2, le=6, default=3)
    holes: list[Hole] = Field(default_factory=list, max_length=40)
    verified: bool = False
    moduleModel: ModuleModel | None = None

    def module_bounds(self):
        m = self.moduleModel
        if m is None:
            return self
        u, v, thickness = face_dimensions(self)
        if m.bodyZ + m.bodyThickness > thickness + .001:
            raise ValueError('主体厚度超出模组总厚度。')
        ids = [f.id for f in m.features]
        if len(ids) != len(set(ids)):
            raise ValueError('模组实体 ID 重复。')
        for f in m.features:
            if f.x+f.width > u+.001 or f.y+f.depth > v+.001 or f.z+f.height > thickness+.001:
                raise ValueError(f'{f.name} 超出模组外形，请先调整实体尺寸或模组总尺寸。')
            if f.shape == 'cylinder' and abs(f.width-f.depth) > .001:
                raise ValueError('圆柱的宽度与长度须相同。')
        return self

    @model_validator(mode="before")
    @classmethod
    def legacy_opening(cls, value):
        if isinstance(value, dict) and "openingShape" not in value:
            value = dict(value)
            kind = value.get("kind")
            shape = "circle" if kind in ("button", "encoder", "speaker") else "none" if kind in ("board", "battery", "module") else "rect"
            value["openingShape"] = shape
        if isinstance(value, dict):
            value = dict(value)
            if "mountingMethod" not in value:
                kind, mount, holes = value.get("kind"), value.get("mount", "base"), value.get("holes") or []
                value["mountingMethod"] = "adhesive" if kind in ("screen", "keyboard") and mount == "lid" and not holes else "holes" if holes else "none"
            if "supportEnabled" not in value:
                value["supportEnabled"] = value["mountingMethod"] == "adhesive"
        return value


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
    screwHeadDiameter: float = Field(ge=2, le=7.2, default=6.4)
    screwHeadDepth: float = Field(ge=0, le=5.4, default=0)
    ventilation: bool = True


class Keepout(BaseModel):
    id: str = Field(max_length=100)
    name: str = Field(max_length=120)
    componentId: str | None = None
    purpose: Literal['cable', 'plug', 'removal'] = 'cable'
    x: float = Field(ge=-100, le=800)
    y: float = Field(ge=-100, le=800)
    z: float = Field(ge=-100, le=500)
    width: float = Field(gt=0, le=500)
    depth: float = Field(gt=0, le=500)
    height: float = Field(gt=0, le=500)
    verified: bool = False


class Project(BaseModel):
    model_config = ConfigDict(extra="ignore")
    version: Literal[1] = 1
    name: str = Field(default="未命名项目", max_length=120)
    components: list[Component] = Field(max_length=30)
    ports: list[Port] = Field(default_factory=list, max_length=50)
    enclosure: Enclosure
    keepouts: list[Keepout] = Field(default_factory=list, max_length=50)


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
    if e.screwHeadDepth and (e.screwHeadDiameter < e.screwDiameter + .4 or e.screwHeadDepth > e.lid - .6):
        add("screw-head", "螺丝头沉孔须比通孔至少宽 0.4 mm，且上盖剩余厚度至少为 0.6 mm。")
    if e.cornerRadius > min(e.width, e.depth) / 2:
        add("corner-radius", "外壳四角半径不能超过宽度与长度中较小值的一半。")
    if e.ventilation and len(ventilation_slots(project)) < 9:
        add("ventilation-corners", f"避开圆角和后侧开孔后生成 {len(ventilation_slots(project))} / 9 个通风孔。", "warning")
    screw_points = fastening_points(e.width, e.depth, e.cornerRadius)
    openings = []
    supports = []
    adhesive_supports = []
    assembly_boxes = []
    for c in project.components:
        if c.moduleModel:
            try:
                c.module_bounds()
            except ValueError as exc:
                add('module-model', str(exc), component_id=c.id)
        side = c.mount in SIDE_FACES
        # The actuator may cross its own wall; only its inner portion occupies the cavity.
        ix, iy, iw, id = c.x, c.y, c.width, c.depth
        if c.mount == "front":
            id = min(c.y + c.depth, e.depth - e.wall - e.clearance) - c.y
        elif c.mount == "back":
            iy = max(c.y, e.wall + e.clearance)
            id = c.y + c.depth - iy
        elif c.mount == "right":
            iw = min(c.x + c.width, e.width - e.wall - e.clearance) - c.x
        elif c.mount == "left":
            ix = max(c.x, e.wall + e.clearance)
            iw = c.x + c.width - ix
        if iw <= 0 or id <= 0 or not rectangle_fits(ix, iy, iw, id, e.width, e.depth, e.cornerRadius, e.wall + e.clearance):
            add("bounds", f"{c.name} 超出内腔或装配间隙（含四角圆弧），请调整位置、减小圆角或扩大外壳。", component_id=c.id)
        mount_plane = mounting_plane(c)
        if (e.lipHeight and c.z < e.height-e.lid and c.z+c.height > e.height-e.lid-e.lipHeight
            and not rectangle_fits(ix, iy, iw, id, e.width, e.depth, e.cornerRadius, e.wall+e.clearance+1.2)):
            add("lip-collision", f"{c.name} 与上盖定位边相交，请增加边距或降低组件。", component_id=c.id)
        panel = c.mount == "lid" and c.openingShape != "none"
        if c.z < e.floor - 0.001 or (not panel and c.z + c.height > e.height - e.lid + 0.001) or (panel and (mount_plane > e.height - e.lid + 0.001 or c.z + c.height > e.height + 20)):
            add("vertical", f"{c.name} 的高度与底板或上盖相交。", component_id=c.id)
        if panel and not c.speakerGrille and c.z + c.height < e.height - 0.001:
            add("panel-recess", f"{c.name} 的操作表面低于上盖外表面，请核对底面 Z 与安装基准。", "warning", c.id)
        fu, fv, thickness = face_dimensions(c)
        if c.mountingMethod == 'adhesive' and (c.mount != 'lid' or c.kind not in ('screen','keyboard')):
            add('support-kind', f'{c.name} 的粘贴承托台仅支持上盖屏幕和键盘。', component_id=c.id)
        if c.mountingMethod == 'cradle':
            if c.mount != 'base' or c.kind not in ('battery','module','board'):
                add('cradle-mount', f'{c.name} 的托架仅支持底壳电池、模块和开发板。', component_id=c.id)
            layout = cradle_layout(c,e)
            if c.z < e.floor+.8 or layout['top']+c.clampThickness > e.height-e.lid-e.lipHeight-e.clearance:
                add('cradle-height', f'{c.name} 托架须保留至少 0.8 mm 承托底板，并避开上盖与定位边。', component_id=c.id)
            for b in layout['boxes']:
                bx,by,bz,bw,bd,bh = b
                if not rectangle_fits(bx,by,bw,bd,e.width,e.depth,e.cornerRadius,e.wall+e.clearance):
                    add('cradle-bounds', f'{c.name} 的托架或压条超出内腔，请增加边距。', component_id=c.id)
                    break
                if any(boxes_overlap(b,(px-FASTENER_RADIUS,py-FASTENER_RADIUS,e.floor,2*FASTENER_RADIUS,2*FASTENER_RADIUS,e.height-e.lid-e.floor)) for px,py in screw_points):
                    add('cradle-fastener', f'{c.name} 的托架与外壳螺丝柱相交。', component_id=c.id)
                    break
            assembly_boxes.extend((c,b) for b in layout['boxes'])
        if c.fastenerType == 'heatsetM3':
            if c.mount != 'base' or c.mountingMethod not in ('holes','cradle'):
                add('insert-mount', f'{c.name} 的 M3 热熔铜螺母目前用于底壳支撑柱或托架。', component_id=c.id)
            depth = c.z+c.mountOffset-e.floor if c.mountingMethod=='holes' else c.z+c.height+e.clearance-e.floor
            diameter = e.standoffDiameter if c.mountingMethod=='holes' else cradle_layout(c,e)['bossDiameter']
            if depth < c.insertDepth+.8 or diameter < c.insertDiameter+2.4:
                add('insert-size', f'{c.name} 的铜螺母孔须保留 0.8 mm 盲孔底和每侧 1.2 mm 柱壁。', component_id=c.id)
            if c.mountingMethod == 'holes' and any(h.diameter < 3.2 for h in c.holes):
                add('insert-clearance', f'{c.name} 的 M3 螺丝需要至少 3.2 mm 的组件通孔。', component_id=c.id)
            add('insert-review', f'{c.name} 使用 M3 铜螺母：孔径 {c.insertDiameter:g}、深度 {c.insertDepth:g} mm；请按实物规格试打并热熔安装。', 'warning', c.id)
        if c.tactileEnabled:
            if c.kind not in ('button','switch') or not side or c.openingShape!='circle' or c.mountingMethod!='none':
                add('key-mount', f'{c.name} 的打印轻触键帽仅支持侧壁圆孔、按钮/开关及不生成安装柱模式。', component_id=c.id)
            key = tactile_layout(c,e)
            if abs(c.openingWidth-c.keyDiameter)>.001 or abs(c.openingDepth-c.keyDiameter)>.001:
                add('key-opening', f'{c.name} 的开口直径须等于键杆直径。', component_id=c.id)
            if (key['plane'] < e.wall+c.guideLength+.2+c.keyFlange+c.keyTravel+.2 or
                c.keyProjection < c.keyTravel+.2 or c.keyFlange < c.keyClearance+.6 or
                min(fu,fv) < key['flangeDiameter']+2*e.clearance):
                add('key-travel', f'{c.name} 须为导向筒、防脱肩、行程和回弹留空；请增加组件厚度/安装偏移或减小导向长度。', component_id=c.id)
            u,v = key['u'],key['v']
            assembly_boxes.append((c,face_box(c.mount,u-key['outer']/2,v-key['outer']/2,key['outer'],key['outer'],*key['guide'])))
            add('key-return', f'{c.name} 键帽依赖实物轻触开关回弹；行程 {c.keyTravel:g} mm、每侧配合 {c.keyClearance:g} mm，须试打导向并核对实物按压力。', 'warning', c.id)
        if c.speakerGrille:
            if c.kind!='speaker' or c.mount=='base' or c.openingShape!='circle':
                add('grille-shape',f'{c.name} 防护网仅支持面板扬声器圆孔。',component_id=c.id)
            if c.grilleThickness > (e.lid if c.mount=='lid' else e.wall) or c.grilleBarWidth+c.grilleSpacing > c.openingWidth:
                add('grille-size',f'{c.name} 网筋厚度不能超过面板厚度，且开孔至少容纳一组网筋与间距。',component_id=c.id)
            front_gap = {'lid': e.height-e.lid-c.z-c.height, 'front': e.depth-e.wall-c.y-c.depth,
                         'back': c.y-e.wall, 'left': c.x-e.wall, 'right': e.width-e.wall-c.x-c.width}.get(c.mount, -1)
            if front_gap < e.clearance-.001:
                add('grille-clearance', f'{c.name} 本体须位于面板内侧，前端与内壁至少留出装配间隙，避免碰撞网筋。', component_id=c.id)
        if c.mountOffset > thickness:
            add("mount-offset", f"{c.name} 的安装基准偏移不能超过组件总高。", component_id=c.id)
        if side:
            start, end = support_span(c, e)
            outer_projection = {"front": c.y + c.depth - e.depth, "back": -c.y, "left": -c.x, "right": c.x + c.width - e.width}[c.mount]
            if start > end + .001 or outer_projection > 20 or (outer_projection < -.001 and not c.speakerGrille):
                add("side-plane", f"{c.name} 的操作面须到达所选外壁，安装基准须位于内壁以内，外露不超过 20 mm。", component_id=c.id)
            if c.z < e.floor + e.clearance or c.z + c.height > e.height - e.lid - e.lipHeight - e.clearance:
                add("side-height", f"{c.name} 须避开底板与上盖定位边，请调整 Z 或加高外壳。", component_id=c.id)
            if c.openingShape == "none":
                add("side-opening", f"{c.name} 安装在侧壁时必须设置面板开口。", component_id=c.id)
        for sx, sy in screw_points:
            nearest_x = min(max(sx, c.x), c.x + c.width)
            nearest_y = min(max(sy, c.y), c.y + c.depth)
            if (nearest_x - sx) ** 2 + (nearest_y - sy) ** 2 < FASTENER_RADIUS ** 2:
                add("fastener-collision", f"{c.name} 与外壳角部螺丝柱相交。", component_id=c.id)
                break
        for hole in c.holes:
            if c.mountingMethod != 'holes':
                continue
            r = e.standoffDiameter / 2
            if hole.x > fu or hole.y > fv:
                add("hole", f"{c.name} 的安装孔不在组件范围内。", component_id=c.id)
            if hole.diameter <= e.pilotDiameter:
                add("hole-screw", f"{c.name} 的安装孔小于支撑柱导孔，请核对孔径。", component_id=c.id)
            hu, hv = hole_center(c, hole)
            if not side and any((hu-px)**2+(hv-py)**2 < (r+FASTENER_RADIUS+e.clearance)**2 for px,py in screw_points):
                add('support-fastener', f'{c.name} 的支撑柱与外壳角部螺丝柱相交。', component_id=c.id)
            if side:
                extent = e.depth if c.mount in ("left", "right") else e.width
                if hu - r < max(e.wall, e.cornerRadius) or hu + r > extent - max(e.wall, e.cornerRadius) or hv - r < e.floor or hv + r > e.height - e.lid - e.lipHeight:
                    add("hole-wall", f"{c.name} 的侧壁支撑柱进入圆角、底板或定位边。", component_id=c.id)
            elif footprint_distance(hu, hv, e.width, e.depth, e.cornerRadius, e.wall) + r > 0.001:
                add("hole-wall", f"{c.name} 的支撑柱与侧壁或内腔圆角相交，请增加边距。", component_id=c.id)
            start, end = support_span(c, e)
            if c.mountingMethod == "holes" and end > start:
                supports.append((c, face_box(c.mount, hu - r, hv - r, 2 * r, 2 * r, start, end)))
        adhesive = adhesive_mount(c)
        if adhesive:
            if c.openingShape == "none":
                add("support-opening", f"{c.name} 的粘贴支撑台需要上盖开口。", component_id=c.id)
            elif c.kind not in ("screen", "keyboard"):
                add("support-kind", f"{c.name} 的粘贴支撑台目前仅支持屏幕和键盘，请改用安装孔或关闭支撑台。", "warning", c.id)
            inner, outer, bottom, top = adhesive_frame(c, e)
            ix, iy, iw, ih = inner
            if min(ix-c.x, iy-c.y, c.x+fu-ix-iw, c.y+fv-iy-ih) < 1.2-.001:
                add('support-contact', f'{c.name} 开口周围须在组件实测边框内保留至少 1.2 mm 连续胶粘接触宽度（含开孔间隙）。', component_id=c.id)
            outer_x, outer_y, outer_w, outer_d = outer
            if bottom >= e.height-e.lid or top > e.height+.001:
                add("support-height", f"{c.name} 的承托面须在上盖内侧且厚度不得突出外表面，请调整 Z、胶层厚度或承托厚度。", component_id=c.id)
            if (outer_x < e.clearance - .001 or outer_y < e.clearance - .001 or
                outer_x + outer_w > e.width - e.clearance + .001 or outer_y + outer_d > e.depth - e.clearance + .001 or
                not rectangle_fits(outer_x, outer_y, outer_w, outer_d, e.width, e.depth, e.cornerRadius, e.clearance)):
                add("support-bounds", f"{c.name} 的粘贴支撑台超出上盖可用区域，请减小支撑宽度、开口或圆角。", component_id=c.id)
            if outer_x < c.x - .001 or outer_y < c.y - .001 or outer_x + outer_w > c.x + fu + .001 or outer_y + outer_d > c.y + fv + .001:
                add("support-overhang", f"{c.name} 的粘贴支撑台超出组件外形，胶粘接触面积可能不足。", "warning", c.id)
            for sxp, syp in screw_points:
                nx, ny = min(max(sxp, outer_x), outer_x + outer_w), min(max(syp, outer_y), outer_y + outer_d)
                if (nx - sxp) ** 2 + (ny - syp) ** 2 < (FASTENER_RADIUS + e.clearance) ** 2:
                    add("support-fastener", f"{c.name} 的粘贴支撑台靠近外壳角部螺丝孔。", component_id=c.id)
                    break
            adhesive_supports.extend((c, b) for b in frame_boxes(inner, outer, bottom, max(top, e.height-e.lid)))
        if c.mount != "base" and c.openingShape != "none":
            if c.openingShape == "circle" and abs(c.openingDepth - c.openingWidth) > 0.001:
                add("button-opening", f"{c.name} 的圆孔宽度和长度必须等于孔径。", component_id=c.id)
            if not c.openingWidth or not c.openingDepth or c.openingWidth > fu or c.openingDepth > fv:
                add("opening", f"{c.name} 的开口尺寸须大于零且不超过安装面外形。", component_id=c.id)
            if c.openingShape == "roundedRect" and c.openingRadius > min(c.openingWidth, c.openingDepth) / 2:
                add("opening-radius", f"{c.name} 的开口圆角不能超过开口较短边的一半。", component_id=c.id)
            dx = c.openingX if c.openingX is not None else (fu - c.openingWidth) / 2
            dy = c.openingY if c.openingY is not None else (fv - c.openingDepth) / 2
            if dx + c.openingWidth > fu or dy + c.openingDepth > fv:
                add("opening-bounds", f"{c.name} 的开口位置超出组件外形。", component_id=c.id)
            ox, oy, ow, od = opening_bounds(c)
            openings.append((c, c.mount, ox, oy, ow, od))
            if side:
                extent = e.depth if c.mount in ("left", "right") else e.width
                if ox - e.clearance < max(e.wall, e.cornerRadius) or ox + ow + e.clearance > extent - max(e.wall, e.cornerRadius):
                    add("opening-corner", f"{c.name} 的侧面开孔进入圆角或相邻侧壁。", component_id=c.id)
            for hole in c.holes if c.mountingMethod == 'holes' else []:
                hx, hy = hole_center(c, hole)
                radius = e.standoffDiameter / 2 + e.clearance
                if ox - radius < hx < ox + c.openingWidth + radius and oy - radius < hy < oy + c.openingDepth + radius:
                    add("hole-opening", f"{c.name} 的支撑柱太靠近上盖开口。", component_id=c.id)
        if not c.verified or any(not h.verified for h in c.holes):
            add("unverified", f"{c.name}：外形、高度或孔位仍待实测复核。", "warning", c.id)
        if not c.holes and c.mountingMethod != 'cradle' and c.kind not in ("button", "switch", "encoder") and not (c.mount == "lid" and c.mountingMethod == "adhesive" and c.supportEnabled):
            add("mounting", f"{c.name} 没有安装孔；模型未为它生成支撑柱，请补充固定方式。", "warning", c.id)
        if c.mountingMethod == "adhesive" and not c.supportEnabled:
            add("support-disabled", f"{c.name} 选择了粘贴固定但未启用上盖支撑台。", "warning", c.id)
        if c.kind in ("button", "switch", "encoder"):
            add("button-mount", f"{c.name} 生成面板开孔；螺母、开关自带卡扣或其他实际固定结构需实物复核。", "warning", c.id)
        if c.mountingMethod == 'none' and c.holes:
            add('mounting-disabled',f'{c.name} 保留了孔位但未生成固定结构；可选择安装孔支撑柱。','warning',c.id)
        if c.kind == "battery" and c.mountingMethod != 'cradle':
            add("battery-holder", f"{c.name} 当前是内部占位，尚未生成电池托架、绝缘保护或接线空间。", "warning", c.id)
        if c.kind == "speaker" and not c.speakerGrille:
            add("speaker-grille", f"{c.name} 当前生成声孔，尚未生成防护网孔；真实安装孔与网罩需补充。", "warning", c.id)
    for i, a in enumerate(project.components):
        for b in project.components[i + 1:]:
            if (min(a.x + a.width, b.x + b.width) - max(a.x, b.x) > 0.01 and
                min(a.y + a.depth, b.y + b.depth) - max(a.y, b.y) > 0.01 and
                min(a.z + a.height, b.z + b.height) - max(a.z, b.z) > 0.01):
                add("collision", f"{a.name} 与 {b.name} 发生空间碰撞。", component_id=a.id)
    for owner, support in supports:
        for other in project.components:
            if owner.id != other.id and boxes_overlap(support, (other.x, other.y, other.z, other.width, other.depth, other.height)):
                add("support-collision", f"{owner.name} 的支撑柱与 {other.name} 相交。", component_id=owner.id)
    for owner, support in [*adhesive_supports, *assembly_boxes]:
        for other in project.components:
            if owner.id != other.id and boxes_overlap(support, (other.x, other.y, other.z, other.width, other.depth, other.height)):
                add("support-collision", f"{owner.name} 的粘贴支撑台与 {other.name} 相交。", component_id=owner.id)
    fixtures = [*supports, *adhesive_supports, *assembly_boxes]
    for i, (owner, first) in enumerate(fixtures):
        for other, second in fixtures[i+1:]:
            if owner.id != other.id and boxes_overlap(first, second):
                add('fixture-collision', f'{owner.name} 与 {other.name} 的固定结构相交，请增加组件间距。', component_id=owner.id)
                break
    keepout_ids = [k.id for k in project.keepouts]
    if len(keepout_ids)!=len(set(keepout_ids)):
        add('keepout-duplicate','保留区 ID 重复。')
    for k in project.keepouts:
        if k.componentId and k.componentId not in ids:
            add('keepout-owner',f'{k.name} 关联的组件不存在。')
        region = (k.x,k.y,k.z,k.width,k.depth,k.height)
        for c in project.components:
            if k.purpose == 'removal' and c.mount == 'lid':
                continue  # The lid and the components mounted on it have been removed.
            if c.id != k.componentId and boxes_overlap(region,(c.x,c.y,c.z,c.width,c.depth,c.height)):
                add('keepout-collision', f'{k.name} 保留区被 {c.name} 占用。', component_id=c.id)
        if not k.verified:
            add('keepout-review',f'{k.name} 的插拔/线缆/拆盖空间仍需实测。','warning',k.componentId)
    for i, (a, face, ax, ay, aw, ad) in enumerate(openings):
        for b, other_face, bx, by, bw, bd in openings[i + 1:]:
            margin = 2 * e.clearance + e.wall
            if face == other_face and ax < bx + bw + margin and ax + aw + margin > bx and ay < by + bd + margin and ay + ad + margin > by:
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
    side_cuts = [(c.name, c.id, face, u - e.clearance, v - e.clearance, w + 2 * e.clearance, h + 2 * e.clearance)
                 for c, face, u, v, w, h in openings if face in SIDE_FACES]
    for p, left, right, bottom, top in port_rects:
        for c, face, u, v, w, h in openings:
            margin = e.clearance + .8
            if face == p.edge and left < u + w + margin and right > u - margin and bottom < v + h + margin and top > v - margin:
                add("panel-port", f"{c.name} 与 {p.name} 的侧面开孔太近，须保留至少 0.8 mm 实体。", component_id=c.id)
        side_cuts.append((p.name, p.componentId, p.edge, left, bottom, right - left, top - bottom))
    for name, component_id, face, u, v, w, h in side_cuts:
        start, end = side_wall_span(face, e)
        x, y, _, width, depth, _ = face_box(face, u, v, w, h, start, end)
        for sx, sy in screw_points:
            nx, ny = min(max(sx, x), x + width), min(max(sy, y), y + depth)
            if (nx - sx) ** 2 + (ny - sy) ** 2 < FASTENER_RADIUS ** 2:
                add("opening-fastener", f"{name} 的侧面开孔切到外壳螺丝柱。", component_id=component_id)
                break
    return issues
