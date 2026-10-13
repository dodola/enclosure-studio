// Return classified diagnostics, never provider error bodies or request headers.
const knownCodes = new Set(['invalid_api_key', 'authentication_error', 'permission_denied', 'permission_error',
  'model_not_found', 'insufficient_quota', 'rate_limit_exceeded', 'rate_limit_error', 'invalid_request_error',
  'unsupported_parameter', 'unsupported_value', 'bad_response_status_code', 'server_error', 'overloaded_error']);

export function providerFailure(model, { upstreamStatus, errorMessage = '' } = {}) {
  const raw = String(errorMessage);
  const parsedStatus = raw.match(/(?:^|API error\s*\(|status(?:\s+code)?[:\s]+)([45]\d\d)(?=[:)\s]|$)/i)?.[1];
  const status = Number(upstreamStatus || parsedStatus);
  const codes = ['code', 'type'].flatMap(field => [...raw.matchAll(new RegExp(`"${field}"\\s*:\\s*"([a-z_]{1,60})"`, 'g'))].map(match => match[1]));
  const code = codes.find(value => knownCodes.has(value));
  const http = status >= 400 && status <= 599 ? `（HTTP ${status}）` : '';
  let detail;
  if (status === 401 || ['invalid_api_key', 'authentication_error'].includes(code)) detail = `供应商拒绝认证${http}。请检查 API Key 凭据是否有效、是否属于当前接口。`;
  else if (status === 403) detail = '供应商拒绝了生成请求（HTTP 403）。请核对该 Key 对当前模型的调用权限，以及网关的上游授权。';
  else if (status === 404 || code === 'model_not_found') detail = `供应商找不到接口或模型${http}。请核对 Base URL、接口协议与模型 ID。`;
  else if (code === 'insufficient_quota') detail = '供应商额度不足。请检查 API 余额与模型额度。';
  else if (status === 429) detail = '供应商限制请求频率或额度（HTTP 429）。请检查限额，稍后重试。';
  else if (status === 400 || status === 422) detail = `供应商不接受请求参数（HTTP ${status}）。请核对接口协议和模型支持的参数。`;
  else if (status >= 500 && status <= 599) detail = `供应商或网关服务异常（HTTP ${status}），请稍后重试。`;
  else if (/timeout|timed out|aborted/i.test(raw)) detail = '模型连接超时，请检查接口地址和网络后重试。';
  else if (/connection error|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|certificate/i.test(raw)) detail = '无法连接模型接口，请检查地址、网络和服务证书。';
  else detail = '模型未返回有效结果，请核对接口协议与模型能力。';
  return Object.assign(new Error(detail), { status: 502, diagnostics: {
    provider: model.provider, model: model.id, api: model.api,
    ...(status >= 400 && status <= 599 ? { upstreamStatus: status } : {}), ...(code ? { code } : {}),
  } });
}
