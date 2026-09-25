import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { acceptCell, ApiError, approveRelease, createCell, currentSession, getCell, getCells,
  prototypeFunding, rejectCell, requestRelease, switchRole } from './api';
import type { CellState, CellSummary, Role } from './api';

export function App() {
  const [role, setRole] = useState<Role | null>(currentSession()?.role ?? null);
  const [authError, setAuthError] = useState('');
  const chooseRole = async (next: Role) => {
    try { await switchRole(next); setRole(next); setAuthError(''); }
    catch (error) { setAuthError(errorMessage(error)); }
  };
  if (!role) return <main className="shell narrow"><p className="eyebrow">ZINESH · DEVELOPMENT</p><h1>Nasıl devam ediyorsun?</h1>
    <p>İki taraflı anlaşma akışını denemek için bir rol seç.</p><div className="role-switch">
      <button onClick={() => void chooseRole('payer')}>PAYER olarak devam et</button>
      <button className="secondary" onClick={() => void chooseRole('payee')}>PAYEE olarak devam et</button>
    </div>{authError && <ErrorMessage message={authError} />}</main>;
  return <div className="app-shell"><header className="topbar"><Link to="/agreements" className="brand">zinesh</Link>
    <div className="role-switch compact"><span>Development:</span><button className={role === 'payer' ? 'selected' : ''} onClick={() => void chooseRole('payer')}>Payer</button>
      <button className={role === 'payee' ? 'selected' : ''} onClick={() => void chooseRole('payee')}>Payee</button></div></header>
    <Routes><Route path="/agreements" element={<AgreementList />} /><Route path="/agreements/new" element={<NewAgreement />} />
      <Route path="/agreements/:cellId" element={<AgreementRoom role={role} />} /><Route path="*" element={<Navigate to="/agreements" replace />} /></Routes>
  </div>;
}

function AgreementList() {
  const [cells, setCells] = useState<CellSummary[]>([]); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { try { setCells(await getCells()); setError(''); } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const role = currentSession()?.role;
  return <main className="shell"><div className="page-heading"><div><p className="eyebrow">ANLAŞMALAR</p><h1>Anlaşmalar</h1></div>{role === 'payer' && <Link className="button" to="/agreements/new">Yeni anlaşma</Link>}</div>
    {error && <ErrorMessage message={error} />}{loading ? <p className="muted">Yükleniyor…</p> : cells.length === 0
      ? <section className="empty"><h2>Henüz anlaşma yok</h2><p>İlk anlaşmanı oluşturup diğer tarafı davet et.</p>{role === 'payer' && <Link className="button" to="/agreements/new">Anlaşma oluştur</Link>}</section>
      : <ul className="agreement-list">{cells.map((cell) => <li key={cell.cellId}><Link to={`/agreements/${encodeURIComponent(cell.cellId)}`}>
        <span className="agreement-main"><strong>{cell.description || 'Anlaşma'}</strong><small>Karşı taraf · {cell.counterpartyId}</small></span>
        <span className="agreement-side"><strong>{formatAmount(cell.amount)} {cell.currency}</strong><small>{statusLabel(cell.status, cell.acceptanceStatus)}</small></span>
      </Link></li>)}</ul>}
  </main>;
}

function NewAgreement() {
  const role = currentSession()?.role ?? 'payer';
  const navigate = useNavigate(); const [payee, setPayee] = useState('development-payee'); const [amount, setAmount] = useState('');
  const [description, setDescription] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await createCell({ payer: 'development-payer', payee, amount, description });
      if (result.outcome !== 'SUCCESS') throw new Error(result.error?.code ?? 'CREATE_FAILED');
      navigate(`/agreements/${encodeURIComponent(result.cellId)}`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  if (role !== 'payer') return <main className="shell narrow"><Link className="back-link" to="/agreements">← Anlaşmalar</Link><p className="eyebrow">YENİ ANLAŞMA</p>
    <h1>Yeni anlaşmayı PAYER oluşturur</h1><p>Development rolünü Payer olarak değiştirip yeniden dene.</p></main>;
  return <main className="shell narrow"><Link className="back-link" to="/agreements">← Anlaşmalar</Link><p className="eyebrow">YENİ ANLAŞMA</p><h1>Ne üzerinde anlaşıyorsunuz?</h1>
    <form className="form" onSubmit={(e) => void submit(e)}><label>Karşı taraf ID<input value={payee} onChange={(e) => setPayee(e.target.value)} required maxLength={128} /></label>
      <label>Tutar (TRY)<input inputMode="numeric" pattern="[1-9][0-9]{0,30}" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
      <label>Açıklama<textarea value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={256} rows={4} /></label>
      {error && <ErrorMessage message={error} />}<button disabled={busy}>{busy ? 'Gönderiliyor…' : 'Anlaşmayı gönder'}</button></form>
  </main>;
}

function AgreementRoom({ role }: { role: Role }) {
  const { cellId = '' } = useParams(); const [cell, setCell] = useState<CellState | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setCell(await getCell(cellId)); setError(''); } catch (e) { setError(errorMessage(e)); } }, [cellId]);
  useEffect(() => { void load(); }, [load]);
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await load(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  if (error && !cell) return <main className="shell narrow"><Link className="back-link" to="/agreements">← Anlaşmalar</Link><ErrorMessage message={error} /></main>;
  if (!cell) return <main className="shell"><p className="muted">Yükleniyor…</p></main>;
  const counterparty = role === 'payer' ? cell.payee : cell.payer;
  return <main className="shell narrow"><Link className="back-link" to="/agreements">← Anlaşmalar</Link><p className="eyebrow">ANLAŞMA ODASI</p>
    <h1>{cell.description || 'Anlaşma'}</h1><dl className="details"><div><dt>Karşı taraf</dt><dd>{counterparty}</dd></div><div><dt>Tutar</dt><dd>{formatAmount(cell.amount)} {cell.currency}</dd></div>
      <div><dt>Durum</dt><dd>{statusLabel(cell.status, cell.acceptanceStatus)}</dd></div></dl>
    {error && <ErrorMessage message={error} />}{cell.acceptanceStatus === 'PENDING' && <section className="next-step"><h2>Karşı tarafın yanıtı bekleniyor</h2>
      {role === 'payee' && <div className="actions"><button disabled={busy} onClick={() => void act(() => acceptCell(cell.cellId))}>Kabul et</button>
        <button className="secondary" disabled={busy} onClick={() => void act(() => rejectCell(cell.cellId))}>Reddet</button></div>}</section>}
    {cell.acceptanceStatus === 'ACCEPTED' && cell.status === 'CREATED' && role === 'payer' && <section className="next-step"><h2>Anlaşma kabul edildi</h2>
      <p className="demo-note">Demo funding — gerçek para kullanılmaz.</p><button disabled={busy} onClick={() => void act(() => prototypeFunding(cell.cellId))}>Demo funding</button></section>}
    {cell.status === 'FUNDED' && <section className="next-step"><h2>Anlaşma devam ediyor</h2><p>İş tamamlandığında taraflardan biri teslimi onay isteği olarak iletebilir.</p>
      <div className="actions">{cell.releaseRequestedBy === undefined && <button disabled={busy} onClick={() => void act(() => requestRelease(cell.cellId))}>Tamamlanma iste</button>}
      {cell.releaseRequestedBy !== undefined && cell.releaseRequestedBy !== (role === 'payer' ? 'development-payer' : 'development-payee')
        && <button className="secondary" disabled={busy} onClick={() => void act(() => approveRelease(cell.cellId))}>Tamamlanmayı onayla</button>}</div></section>}
    {cell.status === 'RELEASED' && <section className="next-step"><h2>Tamamlandı</h2></section>}
    {cell.acceptanceStatus === 'REJECTED' && <section className="next-step"><h2>Reddedildi</h2></section>}
  </main>;
}

function ErrorMessage({ message }: { message: string }) {
  return <p role="alert" className="error">{message === 'UNAUTHENTICATED' ? 'Oturum yenilenemedi. Geliştirme sunucusunu kontrol et.'
    : message === 'FORBIDDEN' || message === 'COMMAND_NOT_PERMITTED' ? 'Bu işlem için yetkin yok.'
    : message === 'NOT_FOUND' || message === 'CELL_NOT_FOUND' ? 'Anlaşma bulunamadı.'
    : message === 'IDEMPOTENCY_CONFLICT' ? 'Bu istek kimliği farklı bir işlem için kullanılmış.'
    : message === 'PROTOTYPE_FUNDING_ENABLED' ? 'Demo funding development ortamında kullanılamıyor.'
    : message === 'BACKEND_UNAVAILABLE' ? 'Development backend bağlantısı kurulamadı.'
    : message}</p>;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  return error instanceof Error ? error.message : 'İstek tamamlanamadı.';
}
function formatAmount(amount: string | number | bigint): string { return BigInt(amount).toLocaleString('tr-TR'); }
function statusLabel(status: string, acceptance: string): string {
  if (acceptance === 'REJECTED') return 'Reddedildi'; if (acceptance === 'PENDING') return 'Yanıt bekleniyor';
  return ({ CREATED: 'Kabul edildi', FUNDED: 'Devam ediyor', RELEASED: 'Tamamlandı', REFUNDED: 'İade edildi', DISPUTED: 'İncelemede', EXPIRED: 'Süresi doldu' } as Record<string, string>)[status] ?? status;
}
