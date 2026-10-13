import csv
import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient
from manifold3d import Manifold, Mesh

from server.app import app
from server.geometry import box, build
from server.models import Component, Hole, Project, validate_design
from server.panels import face_box, hole_center, opening_bounds, side_wall_span, support_span, ventilation_slots


@pytest.fixture
def project():
    p = Project.model_validate_json((Path(__file__).parents[1] / 'example-project.json').read_text())
    p.enclosure.height = 44
    p.enclosure.cornerRadius = 12
    p.enclosure.ventilation = False
    board = p.components[0]
    board.width = board.depth = 20
    board.x, board.y, board.height, board.holes = 53, 74, 8, []
    p.components, p.ports = [board], []
    return p


def solid(value):
    return Manifold(Mesh(np.float32(value.vertices), np.uint32(value.faces)))


def side_part(face, shape='circle'):
    u, v, thickness = (20, 14, 12) if shape == 'roundedRect' else (16, 16, 12)
    if face in ('front', 'back'):
        dims = dict(width=u, depth=thickness, height=v, x=55, y=169 - thickness if face == 'front' else -1)
    else:
        dims = dict(width=thickness, depth=u, height=v, x=127 - thickness if face == 'right' else -1, y=76)
    return Component(id='side-panel', kind='switch' if shape == 'roundedRect' else 'button', name='侧边操作件', mount=face,
                     **dims, z=12, mountOffset=4.4, openingShape=shape, openingRadius=2 if shape == 'roundedRect' else 0,
                     openingWidth=16 if shape == 'roundedRect' else 12, openingDepth=10 if shape == 'roundedRect' else 12)


@pytest.mark.parametrize('face', ['front', 'back', 'left', 'right'])
@pytest.mark.parametrize('shape', ['circle', 'roundedRect'])
def test_all_four_faces_have_real_oriented_apertures_and_printable_solids(project, face, shape):
    closed, _, _ = build(project)
    c = side_part(face, shape)
    project.components.append(c)
    base, lid, issues = build(project)
    assert not any(i['severity'] == 'error' for i in issues)
    assert base.is_watertight and lid.is_watertight
    assert base.body_count == lid.body_count == 1
    u, v, w, h = opening_bounds(c)
    start, end = side_wall_span(face, project.enclosure)
    probe = box(*face_box(face, u + w / 2 - .5, v + h / 2 - .5, 1, 1, start + .1, end - .1))
    assert (solid(base) ^ probe).volume() < 1e-6
    clearance = project.enclosure.clearance
    area = np.pi * (w / 2 + clearance) ** 2 if shape == 'circle' else (w + 2 * clearance) * (h + 2 * clearance) - (4 - np.pi) * (c.openingRadius + clearance) ** 2
    assert closed.volume - base.volume == pytest.approx(area * project.enclosure.wall, rel=.004)
    assert abs((solid(base) ^ solid(lid)).volume()) < 1e-4


@pytest.mark.parametrize('face', ['front', 'back', 'left', 'right'])
def test_side_holes_produce_horizontal_supports_and_through_bores(project, face):
    c = side_part(face)
    if face in ('front', 'back'):
        c.width = 32
    else:
        c.depth = 32
    c.height = 24
    c.z = 8
    c.openingWidth = c.openingDepth = 6
    project.components.append(c)
    before, _, _ = build(project)
    c.holes = [Hole(id=f'h{i}', x=u, y=v, diameter=3.5) for i, (u, v) in enumerate([(4, 4), (28, 4), (4, 20), (28, 20)])]
    base, lid, _ = build(project)
    # Test the actual annulus inside the cavity; net volume can decrease because
    # the through bore also removes material from the existing side wall.
    hu, hv = hole_center(c, c.holes[0])
    start, end = support_span(c, project.enclosure)
    probe = box(*face_box(face, hu + 2.15, hv - .05, .1, .1, start + .2, end - .2))
    assert (solid(before) ^ probe).volume() < 1e-7
    assert (solid(base) ^ probe).volume() == pytest.approx(.01 * (end - start - .4), abs=1e-7)
    bore = box(*face_box(face, hu - .05, hv - .05, .1, .1, start, end))
    assert (solid(base) ^ bore).volume() < 1e-7
    assert base.body_count == 1 and base.is_watertight
    assert abs((solid(base) ^ solid(lid)).volume()) < 1e-4
    response = TestClient(app).post('/api/export', json=project.model_dump())
    assert response.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    rows = list(csv.DictReader(io.StringIO(archive.read('measurements.csv').decode('utf-8-sig'))))
    assert rows[0]['mount'] == face
    assert float(rows[0]['u_mm']) == 4 and float(rows[0]['v_mm']) == 4


def test_screw_head_recess_really_removes_material_and_rejects_thin_lid(project):
    _, plain, _ = build(project)
    project.enclosure.screwHeadDepth = 1
    _, recessed, _ = build(project)
    area = np.pi * ((6.4 / 2) ** 2 - (project.enclosure.screwDiameter / 2) ** 2)
    assert plain.volume - recessed.volume == pytest.approx(4 * area, rel=.004)
    assert recessed.is_watertight
    project.enclosure.screwHeadDepth = 2
    assert any(i['code'] == 'screw-head' for i in validate_design(project))
    assert TestClient(app).post('/api/export', json=project.model_dump()).status_code == 422
    project.enclosure.screwHeadDepth = 1
    project.enclosure.screwHeadDiameter = 3.4
    assert any(i['code'] == 'screw-head' for i in validate_design(project))


def test_side_corner_lip_mount_plane_and_body_collisions_are_blocked(project):
    c = side_part('left')
    project.components.append(c)
    for attribute, value, code in [('y', 2.9, 'opening-corner'), ('z', 25, 'side-height'), ('mountOffset', 0, 'side-plane')]:
        original = getattr(c, attribute)
        setattr(c, attribute, value)
        assert any(i['code'] == code for i in validate_design(project))
        assert TestClient(app).post('/api/export', json=project.model_dump()).status_code == 422
        setattr(c, attribute, original)
    project.components[0].x, project.components[0].y = 5, 76
    assert any(i['code'] == 'collision' for i in validate_design(project))


def test_round_rect_radius_port_overlap_and_rear_ventilation_avoidance(project):
    c = side_part('back', 'roundedRect')
    project.components.append(c)
    c.openingRadius = 6
    assert any(i['code'] == 'opening-radius' for i in validate_design(project))
    c.openingRadius = 2
    project.enclosure.ventilation = True
    assert len(ventilation_slots(project)) < 9
    base, lid, issues = build(project)
    assert base.is_watertight and lid.is_watertight
    assert any(i['code'] == 'ventilation-corners' and i['severity'] == 'warning' for i in issues)
    from server.models import Port
    board = project.components[0]
    board.x, board.y = 53, 2.9
    project.ports = [Port(id='back-port', componentId=board.id, name='后侧接口', edge='back', offset=10, width=8, height=8, z=8)]
    assert any(i['code'] == 'panel-port' for i in validate_design(project))


def test_standoff_collision_detects_a_component_below_the_board(project):
    board = Component(id='raised-board', kind='board', name='架高板件', mount='base', width=40, depth=40, height=8, x=43, y=64, z=15,
                      holes=[Hole(id='h', x=4, y=4, diameter=3.5)])
    project.components = [board, Component(id='block', kind='module', name='内部模块', width=10, depth=10, height=4, x=44, y=65, z=7)]
    assert any(i['code'] == 'support-collision' for i in validate_design(project))
    assert not any(i['code'] == 'collision' for i in validate_design(project))


def test_export_preserves_new_parameters_and_actual_meshes(project):
    project.components.append(side_part('right', 'roundedRect'))
    project.enclosure.screwHeadDepth = 1
    client = TestClient(app)
    preview = client.post('/api/preview', json=project.model_dump()).json()
    response = client.post('/api/export', json=project.model_dump())
    assert response.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    data = json.loads(archive.read('assembly.json'))
    assert data['enclosure']['screwHeadDepth'] == 1
    assert data['components'][-1]['mount'] == 'right'
    assert data['components'][-1]['openingShape'] == 'roundedRect'
    for part in ['base', 'lid']:
        value = trimesh.load(io.BytesIO(archive.read(part + '.stl')), file_type='stl')
        assert value.is_watertight
        assert value.volume == pytest.approx(preview[part]['volume'], abs=.1)
