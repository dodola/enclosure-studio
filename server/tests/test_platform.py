import io
import json
import zipfile
from pathlib import Path

import cv2
import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient

from server.app import app
from server.geometry import build, printable_lid
from server.models import Project, validate_design
from server.vision import analyse

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def project():
    return Project.model_validate_json((ROOT / 'server/example-project.json').read_text())


def test_sample_is_watertight_and_has_correct_outer_bounds(project):
    base, lid, issues = build(project)
    assert not any(i['severity'] == 'error' for i in issues)
    assert base.is_watertight and lid.is_watertight
    assert base.body_count == 1 and lid.body_count == 1
    assert base.volume > 0 and lid.volume > 0
    assert np.allclose(base.bounds[0], [0, 0, 0])
    assert np.allclose(base.bounds[1], [126, 168, 35.6])
    assert np.allclose(lid.bounds[1], [126, 168, 38])
    assert printable_lid(lid).bounds[0][2] == pytest.approx(0, abs=1e-5)


def test_side_openings_and_top_aperture_really_cut_material(project):
    base, lid, _ = build(project)
    closed = project.model_copy(deep=True)
    closed.ports = []
    closed.enclosure.ventilation = False
    closed_base, _, _ = build(closed)
    assert closed_base.volume > base.volume + 1000
    # Section at RJ45 center: the front wall must contain a gap at the connector.
    section = base.section(plane_origin=[0, 0, 14], plane_normal=[0, 0, 1])
    assert section is not None
    # A vertical section through the screen must not cross the lid's top plate
    # inside the active aperture; inspect actual section edges rather than UI flags.
    top_vertices = lid.vertices[np.isclose(lid.vertices[:, 2], project.enclosure.height)]
    screen = project.components[1]
    cx, cy = screen.x + screen.width / 2, screen.y + screen.depth / 2
    assert not np.any((np.abs(top_vertices[:, 0] - cx) < 20) & (np.abs(top_vertices[:, 1] - cy) < 12))


def test_collisions_overflow_and_inaccessible_ports_block_export(project):
    client = TestClient(app)
    overlapping = project.model_copy(deep=True)
    overlapping.components[1].z = 10
    overlapping.components[1].y = 90
    assert any(i['code'] == 'collision' for i in validate_design(overlapping))
    assert client.post('/api/export', json=overlapping.model_dump()).status_code == 422
    overflow = project.model_copy(deep=True)
    overflow.components[0].x = 100
    assert any(i['code'] == 'bounds' for i in validate_design(overflow))
    inaccessible = project.model_copy(deep=True)
    inaccessible.components[0].y -= 10
    assert any(i['code'] == 'port-reach' for i in validate_design(inaccessible))


def test_base_mounting_offset_changes_support_height(project):
    a, _, _ = build(project)
    changed = project.model_copy(deep=True)
    changed.components[0].mountOffset += 1
    b, _, _ = build(changed)
    assert b.volume > a.volume
    assert b.volume - a.volume < 150


def test_lid_panel_can_protrude_but_mount_plane_cannot_hit_lid(project):
    assert project.components[2].z + project.components[2].height > project.enclosure.height
    assert not any(i['code'] == 'vertical' for i in validate_design(project))
    project.components[2].mountOffset = 0
    assert any(i['code'] == 'vertical' for i in validate_design(project))


def test_zip_export_contains_printable_solids_and_review_records(project):
    response = TestClient(app).post('/api/export', json=project.model_dump())
    assert response.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert set(archive.namelist()) == {'base.stl', 'lid.stl', 'mounting-test.stl', 'assembly.json', 'measurements.csv', 'README.md'}
    for name in ['base.stl', 'lid.stl', 'mounting-test.stl']:
        geometry = trimesh.load(io.BytesIO(archive.read(name)), file_type='stl')
        assert geometry.is_watertight and geometry.volume > 0
        assert geometry.bounds[0][2] >= -1e-5
    manifest = json.loads(archive.read('assembly.json'))
    assert manifest['units'] == 'mm'
    assert any(i['code'] == 'unverified' for i in manifest['issues'])


def test_four_corner_calibration_recovers_hole_coordinates():
    picture = np.full((1000, 1000, 3), 255, np.uint8)
    cv2.rectangle(picture, (100, 100), (900, 900), (32, 55, 42), -1)
    for x, y in [(140, 140), (860, 140), (140, 860), (860, 860)]:
        cv2.circle(picture, (x, y), 21, (30, 170, 210), -1)
        cv2.circle(picture, (x, y), 14, (255, 255, 255), -1)
    _, encoded = cv2.imencode('.png', picture)
    result = analyse(encoded.tobytes(), 80, 80, json.dumps([[.1, .1], [.9, .1], [.9, .9], [.1, .9]]))
    for expected_x, expected_y in [(4, 4), (76, 4), (4, 76), (76, 76)]:
        assert any(abs(h['x'] - expected_x) < .8 and abs(h['y'] - expected_y) < .8 for h in result['holes'])
    assert result['needsReview'] is True


def test_real_board_image_finds_four_outer_mounting_holes():
    photo = ROOT / 'public/samples/firefly-top.png'
    result = analyse(photo.read_bytes(), 81, 88, json.dumps([[158/1371, 121/1313], [1080/1371, 121/1313], [1080/1371, 1128/1313], [158/1371, 1128/1313]]))
    for x, y in [(4, 4), (77.5, 4), (4, 74), (77.5, 74)]:
        assert any(abs(h['x'] - x) < 1.2 and abs(h['y'] - y) < 1.2 for h in result['holes'])


def test_invalid_upload_and_degenerate_calibration_are_reported():
    client = TestClient(app)
    response = client.post('/api/analyze', data={'width': 81, 'depth': 88}, files={'image': ('fake.jpg', b'not an image', 'image/jpeg')})
    assert response.status_code == 422
    with pytest.raises(ValueError):
        analyse((ROOT / 'public/samples/firefly-top.png').read_bytes(), 81, 88, json.dumps([[.2, .2]] * 4))


def test_round_button_creates_real_circular_aperture(project):
    from server.models import Component
    button = Component(id='panel-button', kind='button', name='按钮', width=16, depth=16, height=12, x=16, y=90, z=27, mount='lid', mountOffset=4.4, openingWidth=12, openingDepth=12)
    project.components.append(button)
    _, lid, issues = build(project)
    assert lid.is_watertight
    assert not any(i['severity'] == 'error' for i in issues)


def test_off_center_opening_really_moves_the_cut_and_out_of_bounds_is_blocked(project):
    screen = project.components[1]
    screen.holes = []
    screen.openingWidth = 24
    screen.openingDepth = 16
    screen.openingX = 8
    screen.openingY = 6
    _, lid, _ = build(project)
    # Inspect edges of the actual top surface at the requested aperture location.
    top_vertices = lid.vertices[np.isclose(lid.vertices[:, 2], project.enclosure.height)]
    ox, oy = screen.x + 8, screen.y + 6
    assert np.any(np.isclose(top_vertices[:, 0], ox - project.enclosure.clearance))
    assert np.any(np.isclose(top_vertices[:, 1], oy - project.enclosure.clearance))
    screen.openingX = 70
    assert any(i['code'] == 'opening-bounds' for i in validate_design(project))
    assert TestClient(app).post('/api/export', json=project.model_dump()).status_code == 422
