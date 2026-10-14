"""The editable module uses actual boolean meshes and survives project workflows."""
import io
import json
import zipfile
from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient

from server.app import app
from server.models import Component
from server.module_geometry import build_module, module_to_world

client = TestClient(app)


def component():
    return dict(id='local', kind='module', name='多视角模组', width=40, depth=30, height=10,
                x=20, y=20, z=7, mount='base', holes=[],
                moduleModel=dict(bodyZ=0, bodyThickness=2, source='ai', provider='fixture', model='fixture',
                                 warnings=['高度待实测'], features=[dict(id='usb', name='接口', shape='box', operation='add',
                                 x=10, y=10, z=2, width=12, depth=10, height=5)]))


def test_real_solid_boolean_holes_and_stl():
    c = component()
    c['holes'] = [dict(id='hole', x=4, y=4, diameter=3)]
    c['moduleModel']['features'].append(dict(id='recess', name='凹槽', shape='box', operation='cut', x=12, y=12, z=4, width=4, depth=4, height=3))
    m = build_module(Component.model_validate(c))
    assert m.is_watertight and len(m.split()) == 1
    assert m.volume == pytest.approx(40*30*2+12*10*5-4*4*3-np.pi*1.5**2*2, abs=.1)
    # A through-hole adds the inner cylindrical wall across the full body thickness.
    wall = m.triangles[np.abs(m.face_normals[:, 2]) < .01]
    inner = wall[np.all(np.linalg.norm(wall[:, :, :2]-[4,4], axis=2) < 1.501, axis=1)]
    assert len(inner) == 96
    assert inner[:,:,2].min() == pytest.approx(0) and inner[:,:,2].max() == pytest.approx(2)
    r = client.post('/api/module/preview', json=c)
    assert r.status_code == 200 and r.json()['mesh']['watertight']
    exported = client.post('/api/module/export', json=c)
    assert exported.status_code == 200
    stl = trimesh.load(io.BytesIO(exported.content), file_type='stl')
    assert stl.is_watertight and stl.volume == pytest.approx(m.volume, abs=.01)


@pytest.mark.parametrize('case', ['outside', 'thickness', 'cylinder', 'disconnected', 'empty', 'split', 'miss', 'duplicate'])
def test_invalid_module_cannot_preview_or_export(case):
    c = component(); m = c['moduleModel']; f = m['features'][0]
    if case == 'outside': f['x'] = 39
    if case == 'thickness': m['bodyThickness'] = 11
    if case == 'cylinder': f['shape'] = 'cylinder'
    if case == 'disconnected': f['z'] = 3
    if case == 'empty': m['features'] = [{**f,'operation':'cut','x':0,'y':0,'z':0,'width':40,'depth':30,'height':10}]
    if case == 'split': m['features'] = [{**f,'operation':'cut','x':19,'y':0,'z':0,'width':2,'depth':30,'height':10}]
    if case == 'miss': m['features'] = [{**f,'operation':'cut','z':5}]
    if case == 'duplicate': m['features'].append(deepcopy(f))
    for path in ('/api/module/preview', '/api/module/export'):
        r = client.post(path, json=c)
        assert r.status_code == 422, r.text


@pytest.mark.parametrize('mount', ['base','lid','front','back','left','right'])
def test_six_mount_faces_keep_the_local_model_and_positive_winding(mount):
    c = component(); c['mount'] = mount
    if mount in ('front','back'): c.update(depth=10, height=30)
    if mount in ('left','right'): c.update(width=10, depth=40, height=30)
    parsed = Component.model_validate(c)
    local = build_module(parsed); world = module_to_world(local, parsed)
    assert world.is_watertight and world.volume == pytest.approx(local.volume)
    assert np.allclose(world.bounds[0], [c['x'],c['y'],c['z']])
    expected = [40,30,7] if mount in ('base','lid') else [40,7,30] if mount in ('front','back') else [7,40,30]
    assert np.allclose(world.extents, expected)


def test_model_roundtrip_preview_and_export_manifest():
    p = json.loads((Path(__file__).parents[1]/'example-project.json').read_text())
    p['components'][0]['moduleModel'] = component()['moduleModel']
    normalised = client.post('/api/normalize', json=p)
    assert normalised.status_code == 200
    saved = normalised.json(); model = saved['components'][0]['moduleModel']
    assert model['features'][0]['id'] == 'usb' and model['source'] == 'ai'
    preview = client.post('/api/preview', json=saved)
    assert preview.status_code == 200, preview.text
    assert preview.json()['modules'][0]['componentId'] == p['components'][0]['id']
    output = client.post('/api/export', json=saved)
    assert output.status_code == 200, output.text
    with zipfile.ZipFile(io.BytesIO(output.content)) as archive:
        assert json.loads(archive.read('assembly.json'))['components'][0]['moduleModel'] == model


def test_size_edits_remain_recoverable_and_report_fixable_bounds():
    p = json.loads((Path(__file__).parents[1]/'example-project.json').read_text())
    p['components'][0]['moduleModel'] = component()['moduleModel']
    p['components'][0]['height'] = 3
    # Like layout errors, bounds errors can be recovered and corrected after reload.
    assert client.post('/api/normalize', json=p).status_code == 200
    issues = client.post('/api/validate', json=p).json()['issues']
    assert any(i['code']=='module-model' for i in issues)
    assert client.post('/api/preview', json=p).status_code == 422
    assert client.post('/api/export', json=p).status_code == 422
