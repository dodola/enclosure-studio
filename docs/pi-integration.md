# Pi agent 接入依据

核查日期：2026-10-13。官方仓库 `main` 核查提交：`7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6`。npm 最新版本核查为 `1.2.0`。

## 选用方式

Pi 官网提供 Node.js / Bun SDK 与跨语言 RPC 两条嵌入路径。当前正式包名是 `@earendil-works/pi-coding-agent`，Node.js 最低版本为 `22.19.0`。本平台已有 FastAPI 几何服务，适合增加 Node SDK 服务，让 FastAPI 转发 AI 请求；几何计算仍由现有确定性程序负责。[官网](https://pi.dev/) · [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) · [package.json](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json)

Pi 是 agent 框架；图片理解与对话实际调用所选择的模型供应商。没有供应商 API key 或可用的本地模型端点，不能完成真实 AI 推理。Pi 支持内置供应商，以及兼容 OpenAI / Anthropic / Google 协议的自定义端点。[模型配置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md) · [供应商与环境变量](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)

## 确切 SDK 接口

```ts
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const runtime = await ModelRuntime.create({
  authPath: '/application-private/pi/auth.json',
  modelsPath: '/application-private/pi/models.json',
});
await runtime.setRuntimeApiKey(provider, apiKey);
const model = runtime.getModel(provider, modelId);
if (!model) throw new Error('模型不存在');

const tool = {
  name: 'set_enclosure',
  label: '修改外壳尺寸',
  description: '修改毫米单位的外壳参数，并返回几何校验结果。',
  parameters: Type.Object({ wall: Type.Number({ minimum: 0.8 }) }),
  executionMode: 'sequential' as const,
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const result = await applyAndValidate(params, signal);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      details: result,
    };
  },
};

// 应用提供全部资源，避免读取工作目录和用户目录中的指令/扩展。
const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => applicationSystemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const { session } = await createAgentSession({
  model,
  modelRuntime: runtime,
  resourceLoader,
  tools: [tool.name],
  customTools: [tool],
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  }),
});
```

`tools` 在 `1.2.0` 中是**工具名称白名单**，不是工具对象数组。`customTools` 才接收 `ToolDefinition[]`。显式名称白名单会关闭 `read / bash / edit / write`；也可用 `noTools: 'builtin'` 仅关闭默认编程工具。模型状态更新工具应设为 `executionMode: 'sequential'`。[工厂源码](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/sdk.ts) · [工具定义源码](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) · [完整控制示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/12-full-control.ts)

`setRuntimeApiKey()` 提供进程内 key 覆盖；`getAvailable()` 返回已具有可用认证的模型，`hasConfiguredAuth(provider)` 可用于连接状态。内置供应商可直接使用各自环境变量；例如 `ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`OPENROUTER_API_KEY`、`OPENAI_API_KEY`。自定义兼容端点可通过 `ModelRuntime.registerProvider()` 或 `models.json` 配置。[认证示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts) · [ModelRuntime 源码](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/model-runtime.ts) · [供应商文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)

## 图片输入和流式输出

```ts
const unsubscribe = session.subscribe(event => {
  if (event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta') {
    sendToBrowser({ type: 'delta', text: event.assistantMessageEvent.delta });
  }
  // tool_execution_start: toolCallId、toolName、args
  // tool_execution_end: toolCallId、toolName、result、isError
});

await session.prompt(userPrompt, {
  expandPromptTemplates: false,
  images: [{ type: 'image', data: base64WithoutDataUrlPrefix, mimeType: 'image/png' }],
});

unsubscribe();
session.dispose();
```

图片块的 `data` 为纯 base64，不能包含 `data:image/...;base64,` 前缀。预标注须选择 `model.input` 包含 `image` 的聊天模型；Pi 会按模型输入限制处理图片大小。SDK 自动预处理默认限制为 2000×2000、4.5 MiB base64、JPEG 质量 80，模型可覆盖这些限制。[图片 prompt 接口源码](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts) · [输入限制](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#describe-model-input-and-caching)

`prompt()` 在整次调用（含自动重试）结束时 resolve；`agent_end` 只表示一次底层运行结束，自动恢复或队列仍可能继续。宿主若依靠事件判断完成，应使用 `agent_settled`。`message_end` 是完成消息的权威数据。`abort()` 停止当前操作并等待空闲；`dispose()` 释放会话和监听器。正在运行时再次 `prompt()` 必须明确 `streamingBehavior: 'steer' | 'followUp'`，否则会拒绝。[SDK 生命周期文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

会话默认持久化。`SessionManager.inMemory()` 可将产品聊天留在应用控制范围；恢复历史应通过 SessionManager 条目恢复，直接赋值 `session.agent.state.messages` 不会取代持久化上下文。[SDK 会话说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#session-storage)

## 本平台的接入建议

以下是根据平台需求作出的设计判断：

- 预标注模型接收正视/背视/侧视照片、用户提供的长宽高、CV 透视校准与孔位候选。以结构化工具提交孔、屏幕/键盘开窗、接口与图片区域，记录推断来源和置信度。
- AI 只能推断照片中可见的几何信息。单张俯视图不能可靠恢复孔深、隐藏结构或器件高度，缺失值应明确要求侧视图或人工测量。
- 对话 agent 使用读取项目、修改外壳/部件/接口、自动布局与几何校验等领域工具。真实三维模型由相同的确定性几何服务生成，工具修改后触发预览；不把语言模型生成的文字当作可打印网格。
- 浏览器只获取模型名称与连接状态。key 留在服务端；缺失认证时明确显示未连接，不能以 CV 结果伪装 AI 调用。
- 图片中的印字、附件文字和历史内容视为待分析数据，不作为 agent 指令；产品系统提示、工具白名单与服务端校验限制 agent 的实际作用范围。
- 对话结果应保持可撤销，并防止较早请求覆盖用户期间的新修改。
