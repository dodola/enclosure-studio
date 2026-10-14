import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { applyEdits, createDesignTools, normaliseAnnotations, stripPhotos } from '../domain.mjs';
import { createHandler, parseImage } from '../server.mjs';
import { createSession } from '../pi.mjs';
import { autoLayoutProject, changeMount, createComponent, faceDimensions, imagePointToPanel, imageRectToPanel, normaliseProject, resizeEnclosure, templates } from '../../shared/design.mjs';

const project = JSON.parse(await readFile(new URL('../../server/example-project.json', import.meta.url), 'utf8'));
const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
const fakeGeometry = async (path, p, signal) => {
  if (signal?.aborted) throw new Error('aborted');
  if (!p.components || !p.enclosure) throw Object.assign(new Error('项目无效'), { status: 422 });
  if (path.endsWith('validate')) return { issues: p.enclosure.wall < 1.2 ? [{ severity: 'error', code: 'wall', message: '壁厚过小' }] : [] };
  return { base: { watertight: true }, lid: { watertight: true } };
};
const feature = { kind: 'hole', label: '左上安装孔', bbox: [.03, .04, .04, .05], confidence: .9, note: '需核对孔用途' };

test('edits are atomic, preserve known measurements and move lid parts with shell height', () => {
  const next = applyEdits(project, { reason: '外壳加高', enclosure: { height: project.enclosure.height + 5 } });
  assert.equal(project.enclosure.height + 5, next.enclosure.height);
  for (const c of project.components) assert.equal(next.components.find(x => x.id === c.id).z, c.z + (c.mount === 'lid' ? 5 : 0));
  assert.throws(() => applyEdits(project, { reason: '伪造复核', components: [{ id: project.components[0].id, patch: { verified: true } }] }));
  assert.throws(() => applyEdits(project, { reason: '未知组件', components: [{ id: 'missing', patch: { x: 3 } }] }));
  assert.throws(() => applyEdits(project, { reason: '非法数值', enclosure: { wall: NaN } }));
});

test('invalid geometry and failed solid generation cannot stage a change', async () => {
  const state = { project: structuredClone(project), changes: [] }, before = JSON.stringify(state.project);
  const tools = createDesignTools(state, fakeGeometry);
  const result = await tools[1].execute('id', { reason: '薄壁', enclosure: { wall: 0.5 } });
  assert.equal(JSON.parse(result.content[0].text).applied, false);
  assert.equal(JSON.stringify(state.project), before); assert.deepEqual(state.changes, []);
  const failureTools = createDesignTools(state, async path => { if (path.endsWith('preview')) throw new Error('solid generation failed'); return { issues: [] }; });
  await assert.rejects(failureTools[1].execute('id', { reason: '外壳加高', enclosure: { height: project.enclosure.height + 5 } }));
  assert.equal(JSON.stringify(state.project), before);
});

test('measurement edits reset verification; deleting components removes their ports', () => {
  const c = project.components[0], initial = structuredClone(project); initial.components[0].verified = true;
  const next = applyEdits(initial, { reason: '调整孔位', components: [{ id: c.id, patch: { holes: [{ x: 4, y: 4, diameter: 3.5 }] } }] });
  assert.equal(next.components[0].verified, false); assert.equal(next.components[0].holes[0].verified, false);
  assert.equal(next.components[0].holes[0].source, 'pi-agent');
  const removed = applyEdits(project, { reason: '删除组件', removeComponentIds: [c.id] });
  assert.ok(!removed.ports.some(p => p.componentId === c.id));
});

test('only calibrated plane annotations become mm; malformed bounds are rejected', () => {
  const args = { features: [feature], warnings: ['孔径需实测'] }, context = { width: 80, depth: 100, calibrated: true, slot: 'top', provider: 'fixture', model: 'fixture' };
  const result = normaliseAnnotations(args, context);
  assert.deepEqual(result.features[0].measurement, { x: 4, y: 6.5, width: 3.2, depth: 5, diameter: 3.2 });
  assert.equal(normaliseAnnotations(args, { ...context, calibrated: false }).features[0].measurement, undefined);
  assert.throws(() => normaliseAnnotations({ ...args, features: [{ ...feature, bbox: [.99, .1, .1, .1] }] }, context));
  assert.throws(() => parseImage('https://invalid.example/image.png'));
  assert.throws(() => parseImage('data:image/png;base64,aGVsbG8='));
});

// A controlled model endpoint drives the REAL Pi SDK, tool loop and streaming parser.
async function fixture(t, replies, geometry = fakeGeometry) {
  const requests = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const reply = replies.shift();
    if (!reply) { res.writeHead(500); res.end('{"error":{"message":"fixture exhausted"}}'); return; }
    if (reply.wait) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': pending\n\n'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (reply.tool) { chunk({ tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args || {}) } }] }); chunk({}, 'tool_calls'); }
    else { chunk({ content: reply.text }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  const providerUrl = await listen(provider);
  const runtime = await ModelRuntime.create({ authPath: '/tmp/enclosure-fixture-unused-auth.json', modelsPath: null });
  runtime.registerProvider('fixture', { baseUrl: providerUrl + '/v1', api: 'openai-completions', apiKey: 'test-only-key', models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  await runtime.setRuntimeApiKey('fixture', 'test-only-key');
  const context = { runtime, provider: 'fixture', preferred: 'fixture', agentDir: '/tmp/enclosure-fixture-agent' };
  const handler = createHandler({ context, geometry, sessionFactory: async (...args) => {
    const session = await createSession(...args);
    assert.deepEqual(session.getActiveToolNames().sort(), args[2].map(t => t.name).sort());
    return session;
  } });
  const server = createServer(handler), url = await listen(server);
  t.after(async () => { handler.dispose(); await close(server); await close(provider); });
  return { url, requests };
}
const post = (url, path, body, signal) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'fixture', model: 'fixture', ...body }), signal });
const events = async response => (await response.text()).trim().split('\n').map(line => JSON.parse(line));

const realGeometry = async (path, value, signal) => {
  const python = fileURLToPath(new URL('../../.venv/bin/python', import.meta.url));
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const run = promisify(execFile);
    const script = `import json, sys
from fastapi.testclient import TestClient
from server.app import app
r = TestClient(app).post(sys.argv[1], json=json.loads(sys.argv[2]))
if r.status_code != 200: raise RuntimeError(r.text)
data = r.json()
if sys.argv[1] == '/api/preview':
    data = {part: {'watertight': data[part]['watertight']} for part in ['base', 'lid']}
print(json.dumps(data))`;
    const { stdout } = await run(python, ['-c', script, path, JSON.stringify(value)], { cwd, signal,
      env: { ...process.env, ENCLOSURE_AUTH_FILE: '/dev/null/enclosure-test-no-auth', ENCLOSURE_AUTH_REQUIRED: '0' } });
    return JSON.parse(stdout);
};

test('real Pi SDK sets corner radius using real geometry and rejects excessive rounding atomically', async t => {
  const f = await fixture(t, [
    { tool: 'inspect_design' },
    { tool: 'edit_design', args: { reason: '尝试过大圆角', enclosure: { cornerRadius: 64 } } },
    { tool: 'edit_design', args: { reason: '四角改为R12', enclosure: { cornerRadius: 12 } } },
    { text: '已将四角设为 R12，几何检查通过。' },
  ], realGeometry);
  const stream = await events(await post(f.url, '/api/ai/chat', { project, message: '外壳四角改成R12，其他尺寸保留' }));
  const done = stream.find(e => e.type === 'done');
  assert.equal(done.project.enclosure.cornerRadius, 12);
  assert.deepEqual(done.project.components, stripPhotos(project).components);
  assert.deepEqual(done.project.ports, project.ports);
  assert.equal(done.changes.length, 1);
  assert.ok(stream.some(e => e.type === 'tool' && e.status === 'rejected'));
  assert.throws(() => applyEdits(project, { reason: '负数圆角', enclosure: { cornerRadius: -1 } }));
  assert.throws(() => applyEdits(project, { reason: '不支持的倒角', enclosure: { chamfer: 2 } }));
});

test('real Pi SDK adds side panels and edits apertures and screw recesses with real geometry', async t => {
  const f = await fixture(t, [
    { tool: 'inspect_design' }, { tool: 'list_component_templates' },
    { tool: 'add_component', args: { templateId: 'button', reason: '添加左侧示例按钮', mount: 'left', faceWidth: 16, faceHeight: 16, thickness: 12, y: 100, z: 12 } },
    { tool: 'add_component', args: { templateId: 'switch', reason: '添加右侧示例开关', mount: 'right', y: 90, z: 12 } },
    { tool: 'edit_design', args: { reason: '圆角过大且沉孔过深', enclosure: { screwHeadDepth: 2 }, components: [{ id: 'display', patch: { openingShape: 'roundedRect', openingRadius: 20 } }] } },
    { tool: 'edit_design', args: { reason: '设置屏幕圆角开口和上盖沉孔', enclosure: { screwHeadDepth: 1, screwHeadDiameter: 6.4 }, components: [{ id: 'display', patch: { openingShape: 'roundedRect', openingRadius: 3 } }] } },
    { text: '已添加左侧按钮和右侧开关示例，屏幕开孔 R3，开启 1 mm 平底沉孔；尺寸待实测。' },
  ], realGeometry);
  const stream = await events(await post(f.url, '/api/ai/chat', { project, message: '用示例尺寸添加左侧按钮、右侧开关，将屏幕开孔改为R3圆角矩形，并为上盖螺丝头添加沉孔' }));
  const done = stream.find(e => e.type === 'done');
  assert.ok(done, JSON.stringify(stream.at(-1)));
  assert.equal(done.project.components.length, project.components.length + 2);
  assert.equal(done.project.components.at(-2).mount, 'left');
  assert.equal(done.project.components.at(-1).openingShape, 'roundedRect');
  assert.equal(done.project.enclosure.screwHeadDepth, 1);
  assert.equal(done.project.components.find(c => c.id === 'display').openingShape, 'roundedRect');
  assert.equal(done.project.components.find(c => c.id === 'display').openingRadius, 3);
  assert.equal(done.changes.length, 3);
  assert.equal(stream.filter(e => e.type === 'tool' && e.status === 'rejected').length, 1);
  assert.ok(f.requests.some(body => body.messages.some(m => m.role === 'tool' && m.content.includes('沉孔') && m.content.includes('圆角'))));
  for (const c of done.project.components.slice(-2)) assert.equal(c.verified, false);
  assert.deepEqual(done.project.components.slice(0, project.components.length).filter(c => c.id !== 'display'), stripPhotos(project).components.filter(c => c.id !== 'display'));
  const { openingShape: _shape, openingRadius: _radius, verified: _verified, ...display } = done.project.components.find(c => c.id === 'display');
  const { openingShape: _oldShape, openingRadius: _oldRadius, verified: _oldVerified, ...originalDisplay } = stripPhotos(project).components.find(c => c.id === 'display');
  assert.deepEqual(display, originalDisplay);
  assert.ok(f.requests.some(body => body.messages.some(m => m.role === 'tool' && m.content.includes('"id":"battery"'))));
});

test('shared placement preserves face measurements, anchors side panels on resize, and converts image coordinates', () => {
  const initial = normaliseProject(project);
  assert.equal(initial.enclosure.screwHeadDepth, 0);
  assert.equal(initial.components[0].openingShape, 'none');
  assert.equal(templates.length, 9);
  const c = createComponent('button', initial, { id: 'side-button', mount: 'left' });
  c.holes = [{ id: 'known', x: 3, y: 13, diameter: 3.5, verified: true }];
  const moved = { ...c, ...changeMount(c, 'front', initial.enclosure) };
  assert.deepEqual(faceDimensions(moved), faceDimensions(c));
  assert.deepEqual(moved.holes, c.holes);
  const enlarged = resizeEnclosure({ ...initial, components: [moved] }, { width: 150, depth: 200, height: 45 });
  assert.equal(enlarged.components[0].y - moved.y, 200 - initial.enclosure.depth);
  assert.equal(enlarged.components[0].z, moved.z);
  assert.deepEqual(imagePointToPanel(c, 3, 3), { x: 3, y: 13 });
  assert.deepEqual(imageRectToPanel(c, 4, 2, 5, 4), { x: 4, y: 10, width: 5, height: 4 });
  assert.deepEqual(imagePointToPanel(initial.components[0], 3, 3), { x: 3, y: 3 });
});

test('real Pi SDK configures assembly fixtures and keepouts through the same geometry as export', async t => {
  const initial={...structuredClone(project),components:[],ports:[],keepouts:[],enclosure:{...project.enclosure,width:184,depth:180,height:55,standoffDiameter:8,ventilation:false}};
  const additions=[
    {templateId:'screen',reason:'添加内侧粘贴屏幕',mount:'lid',faceWidth:60,faceHeight:30,thickness:6,x:40,y:20,z:49,mountOffset:3,openingWidth:46,openingDepth:18,mountingMethod:'adhesive',supportWidth:3,supportHeight:1.2,adhesiveClearance:.3},
    {templateId:'battery',reason:'添加电池托架',mount:'base',faceWidth:30,faceHeight:20,thickness:8,x:40,y:90,z:5,mountingMethod:'cradle',strapSlots:true},
    {templateId:'button',reason:'添加侧轻触键帽',mount:'left',faceWidth:14,faceHeight:14,thickness:16,y:60,z:12,mountOffset:14,tactileEnabled:true,openingWidth:6,openingDepth:6},
    {templateId:'speaker',reason:'添加扬声器网筋',mount:'lid',faceWidth:30,faceHeight:30,thickness:6,x:120,y:20,z:46.1,mountOffset:3,openingWidth:24,openingDepth:24,speakerGrille:true},
  ];
  const f=await fixture(t,[...additions.map(args=>({tool:'add_component',args})),
    {tool:'edit_design',args:{reason:'预留接线空间',addKeepouts:[{name:'电池接线',purpose:'cable',x:55,y:114,z:8,width:5,depth:10,height:3}]}},
    {text:'已添加托架、内侧承托、键帽、防护网及接线保留区，均为待实测示例。'}],realGeometry);
  const stream=await events(await post(f.url,'/api/ai/chat',{project:initial,message:'按示例创建完整装配结构并预留接线空间'}));
  const done=stream.find(e=>e.type==='done');
  assert.ok(done,JSON.stringify(stream.at(-1)));
  assert.equal(done.project.components.length,4);
  assert.equal(done.changes.length,5);
  assert.equal(done.project.keepouts.length,1);
  assert.equal(done.project.keepouts[0].verified,false);
  assert.equal(stream.filter(e=>e.type==='tool' && e.status==='rejected').length,0);
  assert.equal(done.project.components[0].mountingMethod,'adhesive');
  assert.equal(done.project.components[1].mountingMethod,'cradle');
  assert.equal(done.project.components[2].tactileEnabled,true);
  assert.equal(done.project.components[3].speakerGrille,true);
});

test('owned keepouts follow edits and resize and are removed with their component', () => {
  const initial=normaliseProject(project),owner=initial.components.find(c=>c.mount==='lid');
  initial.keepouts=[{id:'cable',name:'排线',componentId:owner.id,purpose:'cable',x:40,y:30,z:30,width:5,depth:5,height:3,verified:true}];
  const moved=applyEdits(initial,{reason:'移动屏幕',components:[{id:owner.id,patch:{x:owner.x+4,z:owner.z-2}}]});
  assert.equal(moved.keepouts[0].x,44);assert.equal(moved.keepouts[0].z,28);
  const resized=resizeEnclosure(moved,{height:initial.enclosure.height+5});
  assert.equal(resized.keepouts[0].z,33);
  const removed=applyEdits(initial,{reason:'删除屏幕',removeComponentIds:[owner.id]});
  assert.equal(removed.keepouts.length,0);
  assert.throws(()=>applyEdits(initial,{reason:'伪造留空复核',keepouts:[{id:'cable',patch:{verified:true}}]}));
  const legacy=structuredClone(project);delete legacy.components[0].holes;
  assert.deepEqual(normaliseProject(legacy).components[0].holes,[]);
});

test('real Pi SDK streams tool calls, repairs a rejected edit, and keeps follow-up context current', async t => {
  const f = await fixture(t, [
    { tool: 'inspect_design' }, { tool: 'edit_design', args: { reason: '薄壁', enclosure: { wall: .5 } } },
    { tool: 'edit_design', args: { reason: '外壳加高5mm', enclosure: { height: project.enclosure.height + 5 } } },
    { text: '外壳已加高 5 mm，上盖组件同步移动。' },
    { tool: 'inspect_design' }, { text: '已读取最新项目，未修改。' },
  ]);
  const response = await post(f.url, '/api/ai/chat', { project, message: '外壳加高5mm' });
  assert.equal(response.status, 200); const stream = await events(response), done = stream.find(e => e.type === 'done');
  assert.equal(done.project.enclosure.height, project.enclosure.height + 5); assert.equal(done.changes.length, 1);
  assert.ok(stream.some(e => e.type === 'text')); assert.ok(stream.some(e => e.type === 'tool' && e.status === 'rejected'));
  const sessionId = stream[0].sessionId, latest = structuredClone(done.project); latest.enclosure.ventilation = false;
  const followup = await events(await post(f.url, '/api/ai/chat', { sessionId, project: latest, message: '读取最新项目' }));
  assert.equal(followup.at(-1).project, null);
  const body = f.requests.at(-1);
  const lastTool = body.messages.filter(m => m.role === 'tool').at(-1);
  assert.equal(JSON.parse(lastTool.content).project.enclosure.ventilation, false);
  assert.ok(!body.tools.some(t => ['bash', 'read', 'edit', 'write'].includes(t.function.name)));
});

test('real Pi SDK sees image and submits annotations; secrets never appear in configuration', async t => {
  const f = await fixture(t, [{ tool: 'submit_annotations', args: { features: [feature], corners: [[0,0],[1,0],[1,1],[0,1]], warnings: ['待复核'] } }, { text: '完成预标注。' }]);
  const data = (await readFile(new URL('../../public/samples/firefly-top.png', import.meta.url))).toString('base64');
  const response = await post(f.url, '/api/ai/annotate', { image: 'data:image/png;base64,' + data, kind: 'board', width: 80, depth: 100, calibrated: true, slot: 'top' });
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.features[0].measurement.diameter, 3.2);
  assert.ok(f.requests[0].messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url')));
  const config = await (await fetch(f.url + '/api/ai/config')).text(); assert.ok(!config.includes('test-only-key'));
  const unavailable = await post(f.url, '/api/ai/chat', { provider: 'anthropic', model: 'claude-sonnet-4-6', project, message: '检查设计' });
  assert.equal(unavailable.status, 503); assert.equal(f.requests.length, 2);
});

test('disconnect aborts the SDK request and never applies a partial draft', async t => {
  const f = await fixture(t, [{ tool: 'edit_design', args: { reason: '外壳加高', enclosure: { height: project.enclosure.height + 5 } } }, { wait: true }]);
  const controller = new AbortController(), response = await post(f.url, '/api/ai/chat', { project, message: '加高' }, controller.signal);
  const reader = response.body.getReader(); let received = '';
  while (!received.includes('"status":"done"')) { const chunk = await reader.read(); received += new TextDecoder().decode(chunk.value); }
  controller.abort(); await reader.cancel().catch(() => {});
  assert.ok(!received.includes('"type":"done"'));
});


test('a rejected busy request never unlocks an active Pi conversation', async t => {
  const f=await fixture(t,[{text:'准备好了'},{wait:true}]);
  const first=await events(await post(f.url,'/api/ai/chat',{project,message:'开始'}));
  const sessionId=first.find(e=>e.type==='session').sessionId;
  const controller=new AbortController();
  const running=await post(f.url,'/api/ai/chat',{project,message:'继续',sessionId},controller.signal);
  const reader=running.body.getReader();
  await reader.read();
  for(const message of ['重复请求B','重复请求C']) {
    const rejected=await post(f.url,'/api/ai/chat',{project,message,sessionId});
    assert.equal(rejected.status,409);
    assert.match((await rejected.json()).detail,/仍在处理/);
  }
  controller.abort(); await reader.cancel().catch(()=>{});
});

test('grille speakers retain a recessed front on layout and mount changes', () => {
  const initial=normaliseProject(project);
  initial.enclosure.height=44;
  const c=createComponent('speaker',initial,{id:'grille',mount:'lid',faceWidth:30,faceHeight:30,thickness:6,speakerGrille:true});
  assert.equal(c.z+c.height,initial.enclosure.height-initial.enclosure.lid-initial.enclosure.clearance);
  initial.components=[c];initial.ports=[];
  const arranged=autoLayoutProject(initial);
  assert.equal(arranged.components[0].z+c.height,arranged.enclosure.height-arranged.enclosure.lid-arranged.enclosure.clearance);
  for(const mount of ['left','back','right','front','lid']) {
    const changed={...c,...changeMount(c,mount,initial.enclosure)};
    const e=initial.enclosure;
    const gap=mount==='left'?changed.x-e.wall:mount==='back'?changed.y-e.wall:mount==='right'?e.width-e.wall-changed.x-changed.width:mount==='front'?e.depth-e.wall-changed.y-changed.depth:e.height-e.lid-changed.z-changed.height;
    assert.ok(Math.abs(gap-e.clearance)<.001);
  }
  assert.equal(changeMount(c,'base',initial.enclosure).speakerGrille,false);
});

const moduleArgs = { bodyZ: 0, bodyThickness: 1.6, features: [{ name: 'USB 接口', shape: 'box', operation: 'add', x: 10, y: 10, z: 1.6, width: 12, depth: 8, height: 4 }],
  annotations: [{slot:'top',features:[feature],warnings:['孔径待实测']},{slot:'side',features:[],warnings:['高度待实测']}], warnings:['简化模型，需实测'] };
const modulePhoto = async () => 'data:image/png;base64,' + (await readFile(new URL('../../public/samples/firefly-top.png', import.meta.url))).toString('base64');

test('unified module generation passes all images through real Pi and validates an actual connected solid', async t => {
  const image = await modulePhoto(), component = structuredClone(project.components[0]);
  const f = await fixture(t, [{tool:'submit_module_model',args:moduleArgs},{text:'建模完成，需复核高度。'}], realGeometry);
  const response = await post(f.url, '/api/ai/module', {component,photos:[{slot:'top',image,calibrated:true},{slot:'side',image,calibrated:true}]});
  assert.equal(response.status,200, await response.clone().text());
  const result = await response.json();
  assert.deepEqual(Object.keys(result.annotations), ['top','side']);
  assert.equal(result.annotations.top.calibrated,true);
  assert.equal(result.annotations.side.calibrated,false);
  assert.equal(result.moduleModel.features[0].name,'USB 接口');
  assert.ok(result.moduleModel.features[0].id);
  assert.equal(result.moduleModel.source,'ai');
  assert.equal(component.width,project.components[0].width);
  assert.equal(component.verified,project.components[0].verified);
  assert.equal(f.requests[0].messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='image_url').length,2);
  assert.deepEqual(f.requests[0].tools.map(t=>t.function.name),['submit_module_model']);
});

test('module generation requires matching views and valid bounds before returning a replacement', async t => {
  const image=await modulePhoto(), component=project.components[0];
  for (const args of [
    {...moduleArgs,annotations:[moduleArgs.annotations[0],moduleArgs.annotations[0]]},
    {...moduleArgs,annotations:[moduleArgs.annotations[0]]},
    {...moduleArgs,features:[{...moduleArgs.features[0],x:399}]},
    {...moduleArgs,features:[{...moduleArgs.features[0],z:5}]},
  ]) {
    const f=await fixture(t,[{tool:'submit_module_model',args},{text:'无法提交有效实体。'}],realGeometry);
    const response=await post(f.url,'/api/ai/module',{component,photos:[{slot:'top',image},{slot:'side',image}]});
    assert.equal(response.status,502,await response.clone().text());
    assert.equal((await response.json()).moduleModel,undefined);
  }
  const f=await fixture(t,[]);
  const response=await post(f.url,'/api/ai/module',{component,photos:[{slot:'top',image},{slot:'top',image}]});
  assert.equal(response.status,422); assert.equal(f.requests.length,0);
});

test('cancelling unified module generation aborts the provider and returns no saved model', async t => {
  const image=await modulePhoto(), f=await fixture(t,[{wait:true}]);
  const controller=new AbortController();
  const response=post(f.url,'/api/ai/module',{component:project.components[0],photos:[{slot:'top',image}]},controller.signal);
  const reject=assert.rejects(response,/abort/i);
  while (!f.requests.length) await new Promise(resolve=>setTimeout(resolve,10));
  controller.abort(); await reject;
});
