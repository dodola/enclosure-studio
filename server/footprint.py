"""Shared XY footprint rules for solids, clearances and enclosure fasteners."""
from math import hypot, sqrt


FASTENER_RADIUS = 4.0


def fastening_points(width, depth, radius):
    # Keep each complete boss inside the outer arc, with tessellation allowance.
    inset = max(6.0, radius - (radius - FASTENER_RADIUS - 0.1) / sqrt(2))
    return [(inset, inset), (width - inset, inset),
            (inset, depth - inset), (width - inset, depth - inset)]


def footprint_distance(x, y, width, depth, radius, inset=0):
    """Signed distance to an inward-offset rounded rectangle (negative inside)."""
    r = max(0, radius - inset)
    qx = abs(x - width / 2) - (width / 2 - inset - r)
    qy = abs(y - depth / 2) - (depth / 2 - inset - r)
    return hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def rectangle_fits(x, y, w, d, width, depth, radius, inset):
    # A rounded rectangle is convex, so all four corners suffice for a box.
    return all(footprint_distance(px, py, width, depth, radius, inset) <= 0.001
               for px, py in [(x, y), (x + w, y), (x, y + d), (x + w, y + d)])


def ventilation_positions(width, radius):
    # Rectangular side openings belong on the flat section, away from the arcs.
    return [x for x in (width * (0.27 + i * 0.46 / 8) for i in range(9))
            if x - 1.25 >= radius and x + 1.25 <= width - radius]
