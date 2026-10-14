"""Shared assembly dimensions, used by validation and solid generation (mm)."""
from .panels import face_dimensions, opening_bounds


def cradle_layout(c, e):
    gap, wall = e.clearance, c.cradleWall
    x, y = c.x-gap-wall, c.y-gap-wall
    w, d = c.width+2*(gap+wall), c.depth+2*(gap+wall)
    boss_d = max(8, c.insertDiameter+2.4) if c.fastenerType == 'heatsetM3' else 8
    cy = c.y+c.depth/2
    points = [(x-boss_d/2+.1, cy), (x+w+boss_d/2-.1, cy)]
    top = c.z+c.height+gap
    bar = (points[0][0]-boss_d/2, cy-boss_d/2, top,
           points[1][0]-points[0][0]+boss_d, boss_d, c.clampThickness)
    rails = [(x,y,e.floor-.1,wall,d,c.z+2-e.floor+.1),
             (x+w-wall,y,e.floor-.1,wall,d,c.z+2-e.floor+.1),
             (x,y,e.floor-.1,w,wall,c.z+2-e.floor+.1),
             (x,y+d-wall,e.floor-.1,w,wall,c.z+2-e.floor+.1)]
    bed = (c.x, c.y, e.floor-.1, c.width, c.depth, c.z-e.floor+.1)
    bosses = [(px-boss_d/2, py-boss_d/2, e.floor-.1, boss_d, boss_d, top-e.floor+.1) for px,py in points]
    return dict(rails=rails, bed=bed, points=points, bossDiameter=boss_d, top=top, bar=bar, boxes=[bed,*rails,*bosses,bar])


def tactile_layout(c, e):
    u,v,w,h = opening_bounds(c)
    diameter = c.keyDiameter+2*c.keyClearance
    outer_d = diameter+2.4
    extent = e.depth if c.mount in ('front','back') else e.width
    positive = c.mount in ('front','right')
    # Local normal N always points from the external surface into the enclosure.
    def span(a,b):
        return (extent-b, extent-a) if positive else (a,b)
    plane = c.mountOffset-(c.y+c.depth-e.depth if c.mount=='front' else c.x+c.width-e.width if c.mount=='right' else -c.y if c.mount=='back' else -c.x)
    guide = span(e.wall-.1,e.wall+c.guideLength)
    shaft = span(-c.keyProjection, plane-c.keyTravel)
    flange = span(e.wall+c.guideLength+.2,e.wall+c.guideLength+.2+c.keyFlange)
    return dict(u=u+w/2,v=v+h/2,bore=diameter,outer=outer_d,guide=guide,shaft=shaft,
                flange=flange,flangeDiameter=c.keyDiameter+2*c.keyFlange,
                plane=plane, footprint=face_dimensions(c)[:2])
