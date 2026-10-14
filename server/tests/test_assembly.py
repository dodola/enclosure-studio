"""Assembly regressions exercise the same solids exported for printing."""
import json
import io
import zipfile
from pathlib import Path

import numpy as np
import pytest
from manifold3d import Manifold, Mesh

from server.geometry import adhesive_support, build, build_kit, printable_lid, box
from server.models import Component, Project, Keepout, validate_design
from server.panels import mounting_plane


@pytest.fixture
def project():
    p = Project.model_validate_json(Path('server/example-project.json').read_text())
    p.enclosure.height = 44
    p.enclosure.ventilation = False
    p.components = [Component(id='screen', kind='screen', name='无孔屏幕', width=80, depth=50,
        height=6, x=23, y=20, z=38, mount='lid', mountOffset=3,
        openingShape='rect', openingWidth=64, openingDepth=36)]
    p.ports = []
    return p


def test_adhesive_face_tracks_mounting_plane_and_glue_thickness(project):
    c, e = project.components[0], project.enclosure
    for z in [38, 35]:
        c.z = z
        support = adhesive_support(c, e)
        assert support.bounding_box()[2] == pytest.approx(mounting_plane(c) + c.adhesiveClearance)
        assert support.bounding_box()[5] <= e.height
        _, lid, _ = build(project)
        assert len(lid.split()) == 1
        printed = printable_lid(lid)
        assert printed.bounds[0, 2] == pytest.approx(0)
        assert printed.bounds[1, 2] <= e.height-min(e.height-e.lid-e.lipHeight,mounting_plane(c)+c.adhesiveClearance)+.001


def test_component_cannot_occupy_locating_lip(project):
    e = project.enclosure
    project.components = [Component(id='module', kind='module', name='内部模块', width=8,
        depth=10, height=3, x=e.wall + .6, y=25, z=e.height-e.lid-2, mount='base')]
    assert any(i['code'] == 'lip-collision' for i in validate_design(project))


def as_solid(value):
    return Manifold(Mesh(np.float32(value.vertices), np.uint32(value.faces)))


@pytest.mark.parametrize('kind',['battery','module'])
@pytest.mark.parametrize('fastener',['pilot','heatsetM3'])
def test_cradle_has_connected_base_and_removable_clamp_with_blind_bores(project,kind,fastener):
    c = Component(id='held',kind=kind,name=kind,width=30,depth=20,height=8,x=40,y=80,z=5,
                  mountingMethod='cradle',fastenerType=fastener,strapSlots=True)
    project.components=[c]
    base,lid,issues,extras=build_kit(project)
    assert not [i for i in issues if i['severity']=='error']
    assert len(base.split())==len(lid.split())==1
    assert len(extras)==1
    bar=next(iter(extras.values()))['mesh']
    assert bar.is_watertight and len(bar.split())==1
    from server.assembly import cradle_layout
    layout=cradle_layout(c,project.enclosure)
    x,y=layout['points'][0]
    assert (as_solid(base)^box(x-.3,y-.3,layout['top']-1,.6,.6,.5)).volume()<1e-6
    assert (as_solid(base)^box(x-.3,y-.3,project.enclosure.floor,.6,.6,.5)).volume()>.17
    assert (as_solid(base)^as_solid(bar)).volume()<1e-6
    c.width=120
    assert any(i['code']=='cradle-bounds' for i in validate_design(project))


@pytest.mark.parametrize('face',['front','back','left','right'])
def test_printed_key_is_separate_from_guide_and_has_real_retention_flange(project,face):
    e=project.enclosure
    dims=dict(width=14,depth=16,height=14,x=45,y=-1,z=12) if face in ('front','back') else dict(width=16,depth=14,height=14,x=-1,y=65,z=12)
    if face=='front': dims['y']=e.depth+1-dims['depth']
    if face=='right': dims['x']=e.width+1-dims['width']
    c=Component(id='key',kind='button',name='轻触按键',mount=face,mountOffset=14,
                openingShape='circle',openingWidth=6,openingDepth=6,tactileEnabled=True,**dims)
    project.components=[c]
    base,_,_,extras=build_kit(project)
    key=next(iter(extras.values()))['mesh']
    assert len(key.split())==1 and key.is_watertight
    assert (as_solid(base)^as_solid(key)).volume()<1e-6
    c.keyTravel=1.4
    c.keyProjection=.5
    assert any(i['code']=='key-travel' for i in validate_design(project))


def test_speaker_grille_is_joined_to_lid_and_leaves_air_openings(project):
    c=Component(id='speaker',kind='speaker',name='扬声器',width=30,depth=30,height=6,
                x=45,y=70,z=35,mount='lid',mountOffset=3,openingShape='circle',openingWidth=24,openingDepth=24,speakerGrille=True)
    project.components=[c]
    _,grille,_,_=build_kit(project)
    assert len(grille.split())==1
    c.speakerGrille=False
    _,plain,_=build(project)
    assert grille.volume>plain.volume
    assert grille.volume-plain.volume < np.pi*12.5**2*c.grilleThickness


def test_keepout_rejects_component_and_actual_shell_but_can_cross_open_port(project):
    project.keepouts=[Keepout(id='wire',name='排线',x=40,y=30,z=39,width=5,depth=5,height=2)]
    assert any(i['code']=='keepout-collision' for i in validate_design(project))
    project.keepouts[0].x=0
    project.keepouts[0].z=10
    with pytest.raises(ValueError,match='保留区与外壳'):
        build(project)


def test_no_mounting_method_means_no_real_supports(project):
    from server.models import Hole
    c=Component(id='board',kind='board',name='board',width=20,depth=20,height=3,x=30,y=90,z=10,
        holes=[Hole(id='h',x=4,y=4,diameter=3.5)],mountingMethod='none')
    project.components=[c]
    plain,_,_=build(project)
    c.mountingMethod='holes'
    held,_,_=build(project)
    assert held.volume>plain.volume


def test_normalize_and_export_roundtrip_retains_assembly_features(project):
    from fastapi.testclient import TestClient
    from server.app import app
    import trimesh
    client=TestClient(app)
    c=Component(id='held',kind='battery',name='battery',width=30,depth=20,height=8,x=40,y=80,z=5,mountingMethod='cradle')
    project.components=[c]
    project.keepouts=[Keepout(id='wire',name='接线',componentId=c.id,x=50,y=105,z=8,width=6,depth=10,height=3)]
    payload=project.model_dump()
    payload['components'][0].pop('holes')
    payload['components'][0]['width']='30'
    response=client.post('/api/normalize',json=payload)
    assert response.status_code==200
    accepted=response.json()
    assert accepted['components'][0]['width']==30
    assert accepted['components'][0]['holes']==[]
    preview=client.post('/api/preview',json=accepted)
    assert preview.status_code==200,preview.text
    response=client.post('/api/export',json=accepted)
    assert response.status_code==200,response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assembly=json.loads(archive.read('assembly.json'))
        assert assembly['keepouts']==accepted['keepouts']
        assert len(assembly['extraParts'])==1
        extra=assembly['extraParts'][0]['filename']
        for filename in ['base.stl','lid.stl',extra]:
            mesh=trimesh.load(io.BytesIO(archive.read(filename)),file_type='stl')
            assert mesh.is_watertight and len(mesh.split())==1
            expected=preview.json()['base' if filename=='base.stl' else 'lid']['volume'] if filename!=extra else preview.json()['extras'][0]['mesh']['volume']
            assert mesh.volume==pytest.approx(expected,abs=.1)
        assert '装配顺序' in archive.read('README.md').decode()
        assert client.post('/api/normalize',json=assembly).status_code==200


def test_adhesive_requires_real_contact_and_disabled_holes_do_not_block(project):
    from server.models import Hole
    c=project.components[0]
    c.openingWidth=c.width
    c.openingDepth=c.depth
    assert any(i['code']=='support-contact' for i in validate_design(project))
    c.mountingMethod='none'
    c.holes=[Hole(id='hidden',x=40,y=25,diameter=3.5)]
    assert not any(i['code']=='hole-opening' for i in validate_design(project))
    build(project)


def test_speaker_cannot_intersect_its_grille(project):
    c=Component(id='s',kind='speaker',name='speaker',width=30,depth=30,height=6,x=45,y=70,z=38,
                mount='lid',openingShape='circle',openingWidth=24,openingDepth=24,speakerGrille=True)
    project.components=[c]
    assert any(i['code']=='grille-clearance' for i in validate_design(project))
    c.z=project.enclosure.height-project.enclosure.lid-project.enclosure.clearance-c.height
    _,lid,_,_=build_kit(project)
    assert (as_solid(lid)^box(c.x,c.y,c.z,c.width,c.depth,c.height)).volume()<1e-6


def test_two_cradles_cannot_share_clamp_space(project):
    project.components=[Component(id=str(x),kind='battery',name=str(x),width=30,depth=20,height=8,
                        x=x,y=70,z=5,mountingMethod='cradle') for x in (30,75)]
    assert any(i['code']=='fixture-collision' for i in validate_design(project))
    with pytest.raises(ValueError,match='固定结构相交'):
        build_kit(project)


def test_removal_sweep_assumes_lid_and_owner_clamp_are_removed(project):
    c=Component(id='battery',kind='battery',name='battery',width=30,depth=20,height=8,
                x=40,y=80,z=5,mountingMethod='cradle')
    project.components=[c,Component(id='lid-screen',kind='screen',name='盖上屏幕',width=40,depth=30,height=6,x=35,y=75,z=38,mount='lid',mountOffset=3,openingShape='rect',openingWidth=24,openingDepth=14)]
    project.keepouts=[Keepout(id='lift',name='拔出',componentId=c.id,purpose='removal',x=c.x,y=c.y,z=c.z,width=c.width,depth=c.depth,height=50)]
    build_kit(project)
    project.keepouts[0].purpose='cable'
    assert any(i['code']=='keepout-collision' for i in validate_design(project))
    project.components=[c]
    with pytest.raises(ValueError,match='保留区与外壳'):
        build_kit(project)


def test_m3_clamp_hole_is_independent_of_shell_screw_size(project):
    from server.assembly import cradle_layout
    e=project.enclosure
    e.screwDiameter=2
    e.pilotDiameter=1.5
    c=Component(id='battery',kind='battery',name='battery',width=30,depth=20,height=8,
                x=40,y=80,z=5,mountingMethod='cradle',fastenerType='heatsetM3')
    project.components=[c]
    _,_,_,extras=build_kit(project)
    bar=as_solid(next(iter(extras.values()))['mesh'])
    layout=cradle_layout(c,e)
    x,y=layout['points'][0]
    assert (bar^box(x-1,y-1,layout['top'],2,2,c.clampThickness)).volume()<1e-6


def test_complete_assembly_example_roundtrips_via_real_api():
    from fastapi.testclient import TestClient
    from server.app import app
    import trimesh
    client=TestClient(app)
    payload=json.loads(Path('server/assembly-example.json').read_text())
    accepted=client.post('/api/normalize',json=payload)
    assert accepted.status_code==200
    preview=client.post('/api/preview',json=accepted.json())
    assert preview.status_code==200,preview.text
    assert len(preview.json()['extras'])==2
    exported=client.post('/api/export',json=accepted.json())
    assert exported.status_code==200,exported.text
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert {'base.stl','lid.stl','clamp-2.stl','key-3.stl','assembly.json','measurements.csv','README.md'}<=set(archive.namelist())
        for name in archive.namelist():
            if name.endswith('.stl'):
                solid=trimesh.load(io.BytesIO(archive.read(name)),file_type='stl')
                assert solid.is_watertight and solid.volume>0 and len(solid.split())==1
                assert solid.bounds[0,2]==pytest.approx(0,abs=.001)
        restored=client.post('/api/normalize',json=json.loads(archive.read('assembly.json')))
        assert restored.status_code==200
        assert restored.json()==accepted.json()
