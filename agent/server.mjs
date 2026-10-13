import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { annotationSchema, createDesignTools, normaliseAnnotations, stripPhotos } from './domain.mjs';
import { annotationPrompt, assertFinished, configFor, configureRuntime, createRuntime, createSession, designPrompt, selectModel } from './pi.mjs';
import { providerFailure } from './request-errors.mjs';

const failure = (message, status = 422) => Object.assign(new Error(message), { status });
async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw failure('请求体过大。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw failure('请求 JSON 无效。'); }
}
export function parseImage(value) {
  if (typeof value !== 'string' || value.length > 17 * 1024 * 1024) throw failure('图片过大或格式无效。');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw failure('请传入 PNG、JPEG 或 WebP 的 base64 图片。');
  const data = Buffer.from(match[2], 'base64');
  const valid = match[1] === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === 'image/jpeg' ? data[0] === 255 && data[1] === 216
    : data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP';
  if (!valid) throw failure('图片内容与格式不匹配。');
  return { type: 'image', data: match[2], mimeType: match[1] };
}

export function createHandler({ context, sessionFactory = createSession, geometry }) {
  const sessions = new Map();
  let activeRequests = 0, configuring = false;
  const cleanup = () => {
    for (const [id, entry] of sessions) if (!entry.busy && Date.now() - entry.used > 30 * 60 * 1000) { entry.session.dispose(); sessions.delete(id); }
  };
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const handler = async (req, res) => {
    let session, unsubscribe, timeout, entry, active = false;
    const controller = new AbortController();
    const abort = () => { controller.abort(); void session?.abort(); };
    res.on('close', abort);
    try {
      cleanup();
      if (req.method === 'GET' && req.url === '/api/ai/config') return json(res, 200, configFor(context));
      if (req.method !== 'POST' || !['/api/ai/annotate', '/api/ai/chat', '/api/ai/settings', '/api/ai/test'].includes(req.url)) return json(res, 404, { detail: 'AI 接口不存在。' });
      const settingsRequest = ['/api/ai/settings', '/api/ai/test'].includes(req.url);
      if (settingsRequest) {
        if (!req.headers['content-type']?.startsWith('application/json')) throw failure('请使用 JSON 请求。', 415);
        if (req.headers['sec-fetch-site'] === 'cross-site') throw failure('AI 设置只接受同源请求。', 403);
        if (req.headers.origin) {
          let origin; try { origin = new URL(req.headers.origin); } catch { throw failure('请求来源无效。', 403); }
          if (origin.host !== req.headers.host) throw failure('AI 设置只接受同源请求。', 403);
        }
      }
      const body = await readBody(req, settingsRequest ? 16384 : undefined);
      if (configuring) throw failure('AI 设置正在保存，请稍后重试。', 409);
      if (req.url === '/api/ai/settings') {
        if (activeRequests) throw failure('AI 正在处理请求，请停止或等待完成后再保存设置。', 409);
        configuring = true;
        try {
          const config = await configureRuntime(context, body);
          handler.dispose();
          return json(res, 200, config);
        } finally { configuring = false; }
      }
      activeRequests++; active = true;
      if (req.url === '/api/ai/test') {
        const model = selectModel(context, body);
        timeout = setTimeout(abort, 20000);
        let result, upstreamStatus;
        try {
          result = await context.runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }] }, {
            signal: controller.signal, maxTokens: 32, maxRetries: 0,
            onResponse: response => { upstreamStatus = response.status; },
          });
        } catch (error) {
          if (controller.signal.aborted) throw failure('连接测试超时，请检查接口地址或网络。', 408);
          throw providerFailure(model, { upstreamStatus, errorMessage: error.message });
        }
        if (controller.signal.aborted) throw failure('连接测试超时，请检查接口地址或网络。', 408);
        if (['error', 'aborted'].includes(result.stopReason) || !result.content?.length) throw providerFailure(model, { upstreamStatus, errorMessage: result.errorMessage });
        return json(res, 200, { ok: true, provider: model.provider, model: model.id, detail: '模型调用成功。此测试只验证文字连接；图片理解和工具调用请在实际任务中复核。' });
      }
      const annotating = req.url === '/api/ai/annotate';
      const model = selectModel(context, body, annotating);
      timeout = setTimeout(abort, 180000);
      if (annotating) {
        if (!['top', 'bottom', 'front', 'side'].includes(body.slot) || !Number.isFinite(body.width) || !Number.isFinite(body.depth) || body.width < 3 || body.width > 400 || body.depth < 3 || body.depth > 400) throw failure('组件长宽或照片视角无效。');
        const image = parseImage(body.image);
        const calibrated = body.calibrated === true && ['top', 'bottom'].includes(body.slot);
        let annotations;
        const tool = { name: 'submit_annotations', label: '提交图片标注', description: '提交候选框、板角、用途、置信度和待实测项。', parameters: annotationSchema,
          execute: async (_id, args) => { annotations = normaliseAnnotations(args, { ...body, calibrated }); return { content: [{ type: 'text', text: '标注候选已保存。请简短说明待复核项。' }], details: {} }; } };
        session = await sessionFactory(context, model, [tool], annotationPrompt);
        const hints = Array.isArray(body.hints) ? body.hints.slice(0, 40) : [];
        await session.prompt(`请预标注此图片。数据：${JSON.stringify({ kind: body.kind, mount: body.mount, slot: body.slot, width: body.width, depth: body.depth, height: body.height, dimensionsVerified: body.dimensionsVerified === true, calibrated, cvHoleCandidates: hints })}`, { images: [image], expandPromptTemplates: false });
        assertFinished(session);
        if (controller.signal.aborted) throw failure('AI 标注已停止或超时。', 408);
        if (!annotations) throw failure('模型未提交有效标注，请重试或更换模型。', 502);
        return json(res, 200, annotations);
      }
      if (!body.project || !Array.isArray(body.project.components) || !Array.isArray(body.project.ports) || !body.project.enclosure) throw failure('项目格式无效。');
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 6000) throw failure('请输入 1–6000 字的调整要求。');
      const project = stripPhotos(body.project);
      await geometry('/api/validate', project, controller.signal);
      if (body.sessionId) {
        entry = sessions.get(body.sessionId);
        if (!entry) throw failure('对话已过期，请开始新对话。', 410);
        if (entry.busy) throw failure('此对话仍在处理中。', 409);
        if (entry.model !== `${model.provider}/${model.id}`) throw failure('模型已更换，请开始新对话。', 409);
      } else {
        if (sessions.size >= 30) {
          const oldest = [...sessions].find(([, e]) => !e.busy);
          if (!oldest) throw failure('AI 服务繁忙，请稍后重试。', 429);
          oldest[1].session.dispose(); sessions.delete(oldest[0]);
        }
        const state = { project, changes: [] };
        session = await sessionFactory(context, model, createDesignTools(state, geometry), designPrompt);
        entry = { id: randomUUID(), session, state, model: `${model.provider}/${model.id}`, busy: false, used: Date.now() };
        sessions.set(entry.id, entry);
      }
      entry.busy = true; entry.used = Date.now(); session = entry.session;
      entry.state.project = project; entry.state.changes = [];
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      const send = value => { if (!res.destroyed) res.write(JSON.stringify(value) + '\n'); };
      send({ type: 'session', sessionId: entry.id });
      let toolCount = 0;
      unsubscribe = session.subscribe(event => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') send({ type: 'text', delta: event.assistantMessageEvent.delta });
        if (event.type === 'tool_execution_start') {
          if (++toolCount > 20) abort();
          send({ type: 'tool', name: event.toolName, status: 'running', id: event.toolCallId });
        }
        if (event.type === 'tool_execution_end') {
          let rejected = event.isError;
          try { const data = JSON.parse(event.result?.content?.find(c => c.type === 'text')?.text || '{}'); rejected ||= data.applied === false; } catch { /* plain tool error */ }
          send({ type: 'tool', name: event.toolName, status: rejected ? 'rejected' : 'done', id: event.toolCallId });
        }
      });
      await session.prompt(`当前权威设计数据（覆盖旧对话中的项目状态）：${JSON.stringify(project)}\n当前选择的组件ID：${JSON.stringify(body.selectedId || '')}\n用户要求：${body.message}`, { expandPromptTemplates: false });
      assertFinished(session);
      if (controller.signal.aborted) throw failure('本次对话已停止或超时，修改未应用。', 408);
      send({ type: 'done', text: session.getLastAssistantText() || '', changes: entry.state.changes,
        project: entry.state.changes.length ? entry.state.project : null });
      res.end();
    } catch (error) {
      const detail = error.status ? error.message : 'AI 请求未完成，请检查服务配置后重试。';
      if (!res.headersSent) json(res, error.status || 502, { detail, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) });
      else if (!res.destroyed) { res.write(JSON.stringify({ type: 'error', detail }) + '\n'); res.end(); }
    } finally {
      if (active) activeRequests--;
      clearTimeout(timeout); unsubscribe?.(); res.off('close', abort);
      if (entry) { entry.busy = false; entry.used = Date.now(); }
      else session?.dispose();
    }
  };
  handler.dispose = () => { for (const entry of sessions.values()) entry.session.dispose(); sessions.clear(); };
  return handler;
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const context = await createRuntime();
  const geometry = async (path, project, signal) => {
    const response = await fetch(`${process.env.GEOMETRY_URL || 'http://127.0.0.1:8011'}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project), signal,
    });
    const data = await response.json();
    if (!response.ok) throw failure(typeof data.detail === 'string' ? data.detail : '项目尺寸或字段无效。');
    return data;
  };
  const handler = createHandler({ context, geometry });
  const server = createServer(handler);
  server.listen(Number(process.env.PI_PORT || 8012), '127.0.0.1', () => console.log('Pi AI service: http://127.0.0.1:' + (process.env.PI_PORT || 8012) + ' · ' + (configFor(context).configured ? 'credentials configured' : 'awaiting credentials')));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { handler.dispose(); server.close(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
