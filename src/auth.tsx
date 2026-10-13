import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode, FormEvent } from 'react';
import { Box, LockKeyhole, LogOut } from 'lucide-react';
import { responseError } from './lib';

interface LoginStatus { enabled: boolean; authenticated: boolean; username: string | null }
const AuthContext = createContext<{ status: LoginStatus; logout: (beforeLogout?: () => Promise<void>) => Promise<void> } | null>(null);

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const refresh = async () => {
    setError('');
    try {
      const response = await fetch('/api/auth/status');
      if (!response.ok) throw new Error(await responseError(response));
      setStatus(await response.json());
    } catch (e) { setError(e instanceof Error ? e.message : '无法连接登录服务。'); }
  };
  useEffect(() => {
    void refresh();
    const expired = () => { setStatus({ enabled: true, authenticated: false, username: null }); setPassword(''); setError('登录已过期，请重新登录。'); };
    window.addEventListener('enclosure:unauthorized', expired);
    return () => window.removeEventListener('enclosure:unauthorized', expired);
  }, []);
  const login = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (!response.ok) throw new Error(await responseError(response));
      setStatus(await response.json()); setPassword('');
    } catch (e) { setError(e instanceof Error ? e.message : '登录失败，请重试。'); }
    finally { setBusy(false); }
  };
  const logout = async (beforeLogout?: () => Promise<void>) => {
    setBusy(true); setError('');
    try {
      await beforeLogout?.();
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error(await responseError(response));
      setStatus({ enabled: true, authenticated: false, username: null }); setPassword('');
    } catch (e) { setError(e instanceof Error ? e.message : '退出失败，请重试。'); }
    finally { setBusy(false); }
  };
  if (status?.authenticated) return <AuthContext.Provider value={{ status, logout }}>{children}{error && <div className="auth-notice" role="alert">{error}</div>}</AuthContext.Provider>;
  return <main className="login-page">
    <section className="login-card card" aria-labelledby="login-title" aria-busy={busy}>
      <div className="login-brand"><span className="brand-mark"><Box size={24} aria-hidden="true" /></span><strong>壳研 <span>ENCLOSURE STUDIO</span></strong></div>
      <div className="login-heading"><LockKeyhole size={24} aria-hidden="true" /><h1 id="login-title" className="text-balance">登录设计工作区</h1><p className="text-pretty">登录后使用组件建模、图片测量和 Pi 设计助手。</p></div>
      {!status ? <><p role="status">{error || '正在连接登录服务…'}</p>{error && <button className="button w-full" onClick={() => void refresh()}>重新连接</button>}</> : <form onSubmit={event => void login(event)}>
        <label className="field"><span>用户名</span><input name="username" autoComplete="username" required maxLength={80} value={username} onChange={e => setUsername(e.target.value)} disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? 'login-error' : undefined} /></label>
        <label className="field mt-4"><span>密码</span><input name="password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? 'login-error' : undefined} /></label>
        {error && <p id="login-error" className="inline-error mt-4" role="alert">{error}</p>}
        <button type="submit" className="button button-primary w-full mt-6" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
      </form>}
      <p className="login-hint text-pretty">账户由此服务的管理员配置。项目保存在当前浏览器，AI 配置保存在服务器。</p>
    </section>
  </main>;
}

export function LogoutButton({ beforeLogout, disabled = false }: { beforeLogout?: () => Promise<void>; disabled?: boolean }) {
  const auth = useContext(AuthContext);
  const [busy, setBusy] = useState(false);
  if (!auth?.status.enabled) return null;
  return <button className="button button-small" disabled={busy || disabled} title={`已登录：${auth.status.username}`} onClick={async () => { setBusy(true); try { await auth.logout(beforeLogout); } finally { setBusy(false); } }}><LogOut size={14} aria-hidden="true" />{busy ? '正在退出…' : '退出登录'}</button>;
}
